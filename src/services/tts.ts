import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import type { Readable } from 'node:stream';
import { config } from '../config.js';
import type { Lang } from './ai.js';

// Edge TTS 语音合成（免费，无需 API key）
export class TtsService {
  // 生成一段语音的 mp3 流。按语言选音色：日文 -> ja 音色，中文/其他 -> zh 音色。
  async synthesize(text: string, language: Lang): Promise<Readable> {
    const voice = language === 'ja' ? config.ttsVoiceJa : config.ttsVoiceZh;
    // 每次调用使用独立实例，避免 WebSocket 连接状态复用问题
    const tts = new MsEdgeTTS();
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    // 语速按配置调节（默认加快 25%）
    const { audioStream } = tts.toStream(text, { rate: config.ttsRate });
    return audioStream;
  }

  // 合成并收集为完整的 mp3 Buffer（供分段拼接成一段连续语音用）
  async synthesizeBuffer(text: string, language: Lang): Promise<Buffer> {
    const stream = await this.synthesize(text, language);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }
}

