import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import ffmpegStatic from 'ffmpeg-static';
import type { Guild } from 'discord.js';
import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  joinVoiceChannel,
  StreamType,
  VoiceConnectionStatus,
  type AudioPlayer,
  type VoiceConnection,
} from '@discordjs/voice';
import type { Lang } from './ai.js';
import type { TtsService } from './tts.js';

// 一段固定语言的语音文本（混排消息按语言切成多段，各用对应音色合成）
export interface SpeakSegment {
  text: string;
  language: Lang;
}

// 一段语音：可能包含多个 SpeakSegment，合成后拼成一段连续音频
export interface SpeakJob {
  segments: SpeakSegment[];
}

// ffmpeg-static 下载失败时为 null，回退系统 PATH 里的 ffmpeg
const FFMPEG_BIN = (ffmpegStatic as unknown as string | null) ?? 'ffmpeg';

// 单次合成的目标字符数（软上限）：优先在句子边界断句，块长围绕该值浮动
const CHUNK_MAX_CHARS = 90;
// 切块硬上限：超过该长度仍找不到断句点，才在句子中间硬切
const CHUNK_HARD_MAX = 150;
// 合成按顺序逐个进行（多个 guild 的 VoiceService 共用全局串行队列，避免 Edge 并发限流）
const SYNTH_CONCURRENCY = 1;

// 全局串行化 Edge TTS 请求：所有服务器共用一个队列，每次只发一个合成请求
let ttsChain: Promise<unknown> = Promise.resolve();
function runSerialized<T>(task: () => Promise<T>): Promise<T> {
  const result = ttsChain.then(task);
  // 即使某个任务失败也不打断链条
  ttsChain = result.catch(() => undefined);
  return result;
}

// 把 PCM Buffer 切成固定大小的块再包装成流（Buffer 直接可迭代会逐字节拆，不能直接用 Readable.from）
function chunkedReadable(buf: Buffer): Readable {
  const CHUNK = 64 * 1024;
  const chunks: Buffer[] = [];
  for (let i = 0; i < buf.length; i += CHUNK) chunks.push(buf.subarray(i, i + CHUNK));
  return Readable.from(chunks);
}

// 简单校验 mp3 是否有效（Edge TTS 偶发返回空/损坏音频，先拦截避免 ffmpeg 报"Invalid data"）
function isValidMp3(buf: Buffer): boolean {
  return buf.length > 100 && (buf[0] === 0xff || buf.subarray(0, 3).toString('latin1') === 'ID3');
}

// 断句标点：涵盖中/英/日文常用符号。
// 强断句（句末）优先保证句子完整，弱断句（句中/空白）次之；
// 引号（「」『』""'' 等）不算断句；「〜」「～」表示长音延续，也不断。
const STRONG_BREAK = /[。！？…‥⋯.!?]/;
const WEAK_BREAK = /[，、；：,;:・\s]/;

// 动态切块：块长不固定。达到目标长度后继续向后找最近的断句点（强标点优先），
// 让每块尽量以完整句子收尾；只有超过硬上限仍无断句点，才在句子中间硬切。
function splitForTts(text: string, target = CHUNK_MAX_CHARS, hardMax = CHUNK_HARD_MAX): string[] {
  const chars = Array.from(text);
  const out: string[] = [];
  let start = 0;
  let lastStrong = -1; // 当前块内最近的强断句点（下标相对整个 text）
  let lastWeak = -1;   // 当前块内最近的弱断句点

  const cutAt = (i: number): void => {
    out.push(chars.slice(start, i + 1).join(''));
    start = i + 1;
    lastStrong = -1;
    lastWeak = -1;
  };

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (STRONG_BREAK.test(ch)) lastStrong = i;
    else if (WEAK_BREAK.test(ch)) lastWeak = i;

    if (i - start + 1 < target) continue;

    // 目标长度之后最近的断句点（强优先，其次弱）
    const at =
      lastStrong >= start + target - 1 ? lastStrong : lastWeak >= start + target - 1 ? lastWeak : -1;
    if (at !== -1) {
      cutAt(at);
      continue;
    }
    // 之后没有断句点：到硬上限时退回用目标前最近的断句点，否则继续向后找
    if (i - start + 1 >= hardMax) {
      const p = Math.max(lastStrong, lastWeak);
      cutAt(p >= start ? p : i);
    }
  }
  const tail = chars.slice(start).join('');
  if (tail) out.push(tail);
  return out;
}

// 语音频道连接 + TTS 顺序播放队列
// 合成与播放解耦——播放当前音频的同时预合成下一条，长文本按句切块并并行合成，
export class VoiceService {
  private player: AudioPlayer = createAudioPlayer();
  private connection: VoiceConnection | null = null;
  private queue: SpeakJob[] = [];
  private playing = false; // 是否正在播放音频
  private prefetching = false; // 是否正在预合成
  private nextPcm: Buffer | null = null; // 已预合成好的下一条 PCM
  private active = false; // join 后 true，leave/断开后 false

  // 语音连接真正断开时回调（AssistService 用它清理并解除持久化会话）
  onDisconnected: (() => void) | null = null;

  constructor(private readonly tts: TtsService) {
    this.player.on(AudioPlayerStatus.Idle, () => {
      this.playing = false;
      void this.pump();
    });
    this.player.on('error', (err) => {
      console.error(`[voice] 播放出错: ${err.message}`);
      this.playing = false;
      void this.pump();
    });
  }

  isConnected(): boolean {
    return (
      this.connection !== null &&
      this.connection.state.status === VoiceConnectionStatus.Ready
    );
  }

  // 加入语音频道；已在同一频道则直接返回。重复 join 会先销毁旧连接。
  async join(guild: Guild, voiceChannelId: string): Promise<void> {
    const existing = this.connection;
    if (existing && existing.state.status !== VoiceConnectionStatus.Destroyed) {
      if (existing.joinConfig.channelId === voiceChannelId) return;
      existing.destroy();
    }

    this.active = true;
    const connection = joinVoiceChannel({
      channelId: voiceChannelId,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });
    this.connection = connection;
    connection.subscribe(this.player);

    connection.on(VoiceConnectionStatus.Disconnected, () => {
      if (this.connection !== connection) return;
      // 稍等观察是否为临时断线（自动重连）；最终断开则清理会话
      setTimeout(() => {
        if (connection.state.status === VoiceConnectionStatus.Disconnected) {
          console.log('[voice] 语音连接已断开，清理会话');
          this.cleanup();
          this.onDisconnected?.();
        }
      }, 5_000);
    });

    await Promise.race([
      new Promise<void>((resolve) => connection.once(VoiceConnectionStatus.Ready, () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
    ]);
    if (connection.state.status !== VoiceConnectionStatus.Ready) {
      throw new Error('加入语音频道失败（连接超时）');
    }
    console.log(`[voice] 已加入语音频道 ${voiceChannelId}`);
  }

  // 排队朗读一段文本
  enqueue(job: SpeakJob): void {
    if (!this.isConnected()) return;
    this.queue.push(job);
    void this.pump();
  }

  // 主动退出语音并清空一切（不触发 onDisconnected，由调用方自行清理会话）
  leave(): void {
    this.cleanup();
  }

  queueLength(): number {
    return this.queue.length;
  }

  // ================= 内部 =================

  // 队列泵：空闲时取下一条播放；播放中则预合成队列里的下一条
  private async pump(): Promise<void> {
    if (!this.active || !this.isConnected() || this.prefetching) return;
    this.prefetching = true;
    let startedPlaying = false;
    try {
      if (!this.playing) {
        const pcm = this.nextPcm;
        this.nextPcm = null;
        const job = pcm ? null : this.queue.shift();
        if (!pcm && !job) return;
        const ready = pcm ?? (await this.synthesizeToPcm(job!));
        if (!this.active || !this.isConnected()) return;
        this.playing = true;
        this.playPcm(ready);
        startedPlaying = true;
      } else if (this.queue.length > 0 && !this.nextPcm) {
        const job = this.queue.shift()!;
        this.nextPcm = await this.synthesizeToPcm(job);
      }
    } catch (err) {
      console.error(`[voice] 合成失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.prefetching = false;
      if (startedPlaying || (this.queue.length > 0 && !this.nextPcm)) {
        setImmediate(() => void this.pump());
      }
    }
  }

  // 把一段语音的所有段按句切块后并行合成，返回拼接好的 PCM
  private async synthesizeToPcm(job: SpeakJob): Promise<Buffer> {
    const chunks: SpeakSegment[] = [];
    for (const seg of job.segments) {
      for (const text of splitForTts(seg.text)) {
        chunks.push({ text, language: seg.language });
      }
    }
    const parts: (Buffer | null)[] = new Array(chunks.length);
    let idx = 0;
    const worker = async (): Promise<void> => {
      while (idx < chunks.length) {
        const i = idx++;
        parts[i] = await this.synthesizeChunkWithRetry(chunks[i]);
      }
    };
    const concurrency = Math.min(SYNTH_CONCURRENCY, chunks.length);
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    const ok = parts.filter((p): p is Buffer => p !== null);
    if (ok.length === 0) {
      console.error('[voice] 整条语音所有块都合成失败，本条未出声');
    }
    return Buffer.concat(ok);
  }

  // 合成单个块：失败重试几次，仍失败则返回 null 跳过该块
  private async synthesizeChunkWithRetry(seg: SpeakSegment, attempts = 3): Promise<Buffer | null> {
    for (let a = 0; a < attempts; a++) {
      try {
        // 通过全局串行队列发 Edge TTS 请求
        const mp3 = await runSerialized(() =>
          this.withTimeout(this.tts.synthesizeBuffer(seg.text, seg.language), 12_000, 'Edge TTS 合成超时'),
        );
        if (!isValidMp3(mp3)) throw new Error('Edge TTS 返回了无效音频');
        return await this.mp3ToPcm(mp3);
      } catch (err) {
        if (a === attempts - 1) {
          console.error(
            `[voice] 合成块失败（重试 ${attempts} 次后跳过）: ${err instanceof Error ? err.message : String(err)}`,
          );
          return null;
        }
        await new Promise((r) => setTimeout(r, 300 * (a + 1)));
      }
    }
    return null;
  }

  // 给一个 Promise 加超时
  private withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
    ]);
  }

  private playPcm(pcm: Buffer): void {
    const resource = createAudioResource(chunkedReadable(pcm), { inputType: StreamType.Raw });
    this.player.play(resource);
  }

  // 单个 mp3 Buffer -> 裸 PCM（s16le 48kHz 双声道）
  private mp3ToPcm(mp3: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const ff = spawn(
        FFMPEG_BIN,
        ['-i', 'pipe:0', '-f', 's16le', '-ar', '48000', '-ac', '2', '-loglevel', 'error', 'pipe:1'],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      const chunks: Buffer[] = [];
      ff.stdout.on('data', (c: Buffer) => chunks.push(c));
      let errLog = '';
      ff.stderr.on('data', (c: Buffer) => {
        const msg = c.toString().trim();
        if (msg) errLog += `${msg}\n`;
      });
      ff.on('error', reject);
      ff.on('close', (code) => {
        if (code === 0) resolve(Buffer.concat(chunks));
        else reject(new Error(`ffmpeg 退出码 ${code}: ${errLog.trim()}`));
      });
      ff.stdin.end(mp3);
    });
  }

  private cleanup(): void {
    this.active = false;
    this.playing = false;
    this.queue = [];
    this.nextPcm = null;
    if (this.player.state.status !== AudioPlayerStatus.Idle) {
      this.player.stop();
    }
    if (this.connection && this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      this.connection.destroy();
    }
    this.connection = null;
  }
}
