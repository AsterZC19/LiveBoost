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

// 单次合成的最大字符数：长文本切成小块，避免一次合成太久才出声
const CHUNK_MAX_CHARS = 90;
// 并行合成并发数（Edge TTS 并发太高可能被限流）
const SYNTH_CONCURRENCY = 3;

// 把 PCM Buffer 切成固定大小的块再包装成流（Buffer 直接可迭代会逐字节拆，不能直接用 Readable.from）
function chunkedReadable(buf: Buffer): Readable {
  const CHUNK = 64 * 1024;
  const chunks: Buffer[] = [];
  for (let i = 0; i < buf.length; i += CHUNK) chunks.push(buf.subarray(i, i + CHUNK));
  return Readable.from(chunks);
}

// 按句子边界把文本切成小块（找不到断句就按长度硬切）
function splitForTts(text: string, max = CHUNK_MAX_CHARS): string[] {
  const out: string[] = [];
  let cur = '';
  let len = 0;
  const flush = (): void => {
    if (cur) {
      out.push(cur);
      cur = '';
      len = 0;
    }
  };
  for (const ch of Array.from(text)) {
    cur += ch;
    len += 1;
    if (len >= max && /[，。！？、；：,.!?;:\s]/.test(ch)) flush();
  }
  flush();
  // 仍超长的片段（整段没有断句标点）按长度硬切
  const final: string[] = [];
  for (const part of out) {
    if (Array.from(part).length <= max) {
      final.push(part);
      continue;
    }
    let cur = '';
    let n = 0;
    for (const ch of Array.from(part)) {
      cur += ch;
      n += 1;
      if (n >= max) {
        final.push(cur);
        cur = '';
        n = 0;
      }
    }
    if (cur) final.push(cur);
  }
  return final;
}

// 语音频道连接 + TTS 顺序播放队列
// 设计要点：合成与播放解耦——播放当前音频的同时预合成下一条，长文本按句切块并并行合成，
// 尽量减少"发消息 -> 出声"和"下一条 -> 出声"的等待。
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
        // 播放中：预合成下一条，等当前播完（Idle）后立即播放
        const job = this.queue.shift()!;
        this.nextPcm = await this.synthesizeToPcm(job);
      }
    } catch (err) {
      console.error(`[voice] 合成失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.prefetching = false;
      // 刚开播（或合成期间又有新消息入队且还没预合成）：再泵一次预合成下一条
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
    const parts: Buffer[] = new Array(chunks.length);
    let idx = 0;
    const worker = async (): Promise<void> => {
      while (idx < chunks.length) {
        const i = idx++;
        const c = chunks[i];
        const mp3 = await this.tts.synthesizeBuffer(c.text, c.language);
        parts[i] = await this.mp3ToPcm(mp3);
      }
    };
    const concurrency = Math.min(SYNTH_CONCURRENCY, chunks.length);
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return Buffer.concat(parts);
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
