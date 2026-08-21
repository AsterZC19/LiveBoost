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

// 一段固定语言的语音文本。混排消息按语言切成多段，并使用对应音色合成。
export interface SpeakSegment {
  text: string;
  language: Lang;
}

// 一段语音可能包含多个 SpeakSegment，合成后拼成一段连续音频。
export interface SpeakJob {
  segments: SpeakSegment[];
  // 需要把相邻语音段之间的 TTS 首尾静音压缩掉时使用（例如进出频道播报）。
  compactBoundaries?: boolean;
}

// ffmpeg-static 下载失败时为 null，回退到系统 PATH 中的 ffmpeg。
const FFMPEG_BIN = (ffmpegStatic as unknown as string | null) ?? 'ffmpeg';

// 单次合成的目标字符数为软上限。优先在句子边界断句，块长围绕该值浮动。
const CHUNK_MAX_CHARS = 90;
// 切块硬上限。超过该长度仍找不到断句点时，才在句子中间硬切。
const CHUNK_HARD_MAX = 150;
// 合成按顺序逐个进行。多个 guild 的 VoiceService 共用全局串行队列，避免 Edge 并发限流。
const SYNTH_CONCURRENCY = 1;

// Edge TTS 每段音频通常会带一小段首尾静音。进出频道播报的名字和固定句
// 使用不同音色，必须拆成两段合成；这里保留很短的自然停顿，去掉多余空白。
const PCM_FRAME_BYTES = 4; // s16le、双声道
const PCM_SAMPLE_RATE = 48_000;
const COMPACT_EDGE_KEEP_FRAMES = Math.floor(PCM_SAMPLE_RATE * 0.03);
const PCM_SILENCE_THRESHOLD = 256;

// 全局串行化 Edge TTS 请求：所有服务器共用一个队列，每次只发一个合成请求
let ttsChain: Promise<unknown> = Promise.resolve();
function runSerialized<T>(task: () => Promise<T>): Promise<T> {
  const result = ttsChain.then(task);
  // 即使某个任务失败也不打断链条
  ttsChain = result.catch(() => undefined);
  return result;
}

// 把 PCM Buffer 切成固定大小的块再包装成流。
// Buffer 直接可迭代会逐字节拆分，不能直接使用 Readable.from。
function chunkedReadable(buf: Buffer): Readable {
  const CHUNK = 64 * 1024;
  const chunks: Buffer[] = [];
  for (let i = 0; i < buf.length; i += CHUNK) chunks.push(buf.subarray(i, i + CHUNK));
  return Readable.from(chunks);
}

// 简单校验 mp3 是否有效。Edge TTS 偶尔返回空音频或损坏音频，先拦截以避免 ffmpeg 报错。
function isValidMp3(buf: Buffer): boolean {
  return buf.length > 100 && (buf[0] === 0xff || buf.subarray(0, 3).toString('latin1') === 'ID3');
}

// 断句标点：涵盖中/英/日文常用符号。
// 强断句点位于句末，优先保证句子完整。弱断句点位于句中或空白处，优先级较低。
// 引号不算断句点。表示长音延续的符号也不作为断句点。
const STRONG_BREAK = /[。！？…‥⋯.!?]/;
const WEAK_BREAK = /[，、；：,;:・\s]/;

// 动态切块。块长不固定，达到目标长度后继续向后寻找最近的断句点，优先使用强标点。
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

    // 目标长度之后最近的断句点，优先选择强断句点。
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

  // 语音连接真正断开时回调。AssistService 使用它清理并解除持久化会话。
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

  // 加入语音频道。已在同一频道时直接返回，重复 join 会先销毁旧连接。
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
      // 稍等观察是否为临时断线。自动重连失败后清理会话。
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
      // 超时未就绪：销毁连接并复位，避免留下悬空连接。否则再次 /lb join 同一频道会命中
      // early-return 拿到一个未就绪的连接，会话持久化后永远无法出声
      if (this.connection === connection) this.connection = null;
      this.active = false;
      connection.destroy();
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

  // 主动退出语音并清空所有状态。不触发 onDisconnected，由调用方自行清理会话。
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
      // 预合成期间若播放已结束，Idle 事件可能已被 prefetching 跳过一次 pump，
      // 要补一次 pump 把已就绪的 nextPcm 播出去，否则它会一直停在队列里直到下一条消息
      if (startedPlaying || (!this.playing && this.nextPcm) || (this.queue.length > 0 && !this.nextPcm)) {
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
    return Buffer.concat(job.compactBoundaries ? compactPcmBoundaries(ok) : ok);
  }

  // 合成单个块：失败重试几次，仍失败则返回 null 跳过该块
  private async synthesizeChunkWithRetry(seg: SpeakSegment, attempts = 3): Promise<Buffer | null> {
    for (let a = 0; a < attempts; a++) {
      // 超时即中止底层 Edge TTS 请求，避免被弃的请求仍在跑、与重试并发触发限流
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12_000);
      try {
        // 通过全局串行队列发 Edge TTS 请求
        const mp3 = await runSerialized(() =>
          this.tts.synthesizeBuffer(seg.text, seg.language, controller.signal),
        );
        if (!isValidMp3(mp3)) throw new Error('Edge TTS 返回了无效音频');
        return await this.mp3ToPcm(mp3);
      } catch (err) {
        if (controller.signal.aborted) {
          console.warn(`[voice] Edge TTS 合成超时，已中止该请求（第 ${a + 1}/${attempts} 次尝试）`);
        }
        if (a === attempts - 1) {
          console.error(
            `[voice] 合成块失败（重试 ${attempts} 次后跳过）: ${err instanceof Error ? err.message : String(err)}`,
          );
          return null;
        }
        await new Promise((r) => setTimeout(r, 300 * (a + 1)));
      } finally {
        clearTimeout(timer);
      }
    }
    return null;
  }

  private playPcm(pcm: Buffer): void {
    const resource = createAudioResource(chunkedReadable(pcm), { inputType: StreamType.Raw });
    this.player.play(resource);
  }

  // 将单个 mp3 Buffer 转为裸 PCM，格式为 s16le、48kHz、双声道。
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

// 只压缩指定播报的段间静音，不改变普通消息中用于断句的停顿。
function compactPcmBoundaries(parts: Buffer[]): Buffer[] {
  if (parts.length < 2) return parts;
  return parts.map((part, index) => {
    let start = 0;
    let end = part.length;
    if (index > 0) start = findLeadingAudio(part);
    if (index < parts.length - 1) end = findTrailingAudio(part);
    return part.subarray(start, end);
  });
}

function isSilentFrame(buf: Buffer, offset: number): boolean {
  return (
    Math.abs(buf.readInt16LE(offset)) <= PCM_SILENCE_THRESHOLD &&
    Math.abs(buf.readInt16LE(offset + 2)) <= PCM_SILENCE_THRESHOLD
  );
}

function findLeadingAudio(buf: Buffer): number {
  const frameCount = Math.floor(buf.length / PCM_FRAME_BYTES);
  for (let frame = 0; frame < frameCount; frame++) {
    if (!isSilentFrame(buf, frame * PCM_FRAME_BYTES)) {
      return Math.max(0, frame - COMPACT_EDGE_KEEP_FRAMES) * PCM_FRAME_BYTES;
    }
  }
  return 0;
}

function findTrailingAudio(buf: Buffer): number {
  const frameCount = Math.floor(buf.length / PCM_FRAME_BYTES);
  for (let frame = frameCount - 1; frame >= 0; frame--) {
    if (!isSilentFrame(buf, frame * PCM_FRAME_BYTES)) {
      const endFrame = Math.min(frameCount, frame + 1 + COMPACT_EDGE_KEEP_FRAMES);
      return endFrame * PCM_FRAME_BYTES;
    }
  }
  return buf.length;
}
