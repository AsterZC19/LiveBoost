import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import type { Readable } from 'node:stream';
import { config } from '../config.js';
import type { SpeechLang } from './ai.js';

// Edge TTS 语音合成无需 API key。
export class TtsService {
  // 生成一段语音的 mp3 流。日文使用日文音色，中文和英文沿用中文音色。
  // signal 用于中止。中止时关闭底层 Edge WebSocket，避免废弃的合成请求继续占用连接。
  async synthesize(text: string, language: SpeechLang, signal?: AbortSignal): Promise<Readable> {
    const voice = language === 'ja' ? config.ttsVoiceJa : config.ttsVoiceZh;
    // 每次调用使用独立实例，避免复用 WebSocket 连接状态。
    const tts = new MsEdgeTTS();
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    if (signal?.aborted) {
      tts.close();
      throw new Error('Edge TTS 合成已中止');
    }
    signal?.addEventListener(
      'abort',
      () => {
        try {
          tts.close();
        } catch {
          /* 连接可能未建立，忽略 */
        }
      },
      { once: true },
    );
    // 按语言分别调节语速。默认加快 25%。
    const rate = language === 'ja' ? config.ttsRateJa : config.ttsRateZh;
    const { audioStream } = tts.toStream(text, { rate });
    return audioStream;
  }

  // 合成并收集为完整的 mp3 Buffer，供分段拼接成一段连续语音。
  async synthesizeBuffer(text: string, language: SpeechLang, signal?: AbortSignal): Promise<Buffer> {
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
