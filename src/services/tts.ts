import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import type { Readable } from 'node:stream';
import { config } from '../config.js';
import type { Lang } from './ai.js';

// Edge TTS 语音合成无需 API key。
export class TtsService {
  // 生成一段语音的 mp3 流。日文使用日文音色，中文和其他内容使用中文音色。
  // signal 用于中止。中止时关闭底层 Edge WebSocket，避免废弃的合成请求继续占用连接。
  async synthesize(text: string, language: Lang, signal?: AbortSignal): Promise<Readable> {
    const voice = language === 'ja' ? config.ttsVoiceJa : config.ttsVoiceZh;
    // 每次调用使用独立实例，避免复用 WebSocket 连接状态。
    if (signal?.aborted) throw new Error('Edge TTS 合成已中止');
    const tts = new MsEdgeTTS();
    let stream: Readable | undefined;
    let rejectAbort: (err: Error) => void = () => {};
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const closeSocket = (): void => {
      try { tts.close(); } catch { /* 连接可能尚未建立或已经关闭 */ }
    };
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      signal?.removeEventListener('abort', onAbort);
      closeSocket();
    };
    const onAbort = (): void => {
      const err = new Error('Edge TTS 合成已中止');
      rejectAbort(err);
      stream?.destroy(err);
      close();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const setup = tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      // 库的初始化可能在 close 后才完成创建连接，完成后再次检查并关闭。
      void setup.then(() => { if (signal?.aborted) closeSocket(); }, () => {});
      await Promise.race([setup, aborted]);
      if (signal?.aborted) throw new Error('Edge TTS 合成已中止');
      const rate = language === 'ja' ? config.ttsRateJa : config.ttsRateZh;
      const { audioStream } = tts.toStream(text, { rate });
      stream = audioStream;
      audioStream.once('end', close);
      audioStream.once('close', close);
      audioStream.once('error', close);
      return audioStream;
    } catch (err) {
      close();
      throw err;
    }
  }

  // 合成并收集为完整的 mp3 Buffer，供分段拼接成一段连续语音。
  async synthesizeBuffer(text: string, language: Lang, signal?: AbortSignal): Promise<Buffer> {
    const stream = await this.synthesize(text, language, signal);
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of stream) {
        chunks.push(chunk as Buffer);
      }
      if (signal?.aborted) throw new Error('Edge TTS 合成已中止');
      return Buffer.concat(chunks);
    } catch (err) {
      if (signal?.aborted) throw new Error('Edge TTS 合成已中止');
      throw err;
    }
  }
}
