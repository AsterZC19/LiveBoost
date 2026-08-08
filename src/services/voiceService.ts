import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
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

export interface SpeakJob {
  text: string;
  language: Lang;
}

// 语音频道连接 + TTS 顺序播放队列
export class VoiceService {
  private player: AudioPlayer = createAudioPlayer();
  private connection: VoiceConnection | null = null;
  private queue: SpeakJob[] = [];
  private current: SpeakJob | null = null;
  private active = false; // join 后 true，leave/断开后 false，防止 stop 触发的 idle 继续播队列

  // 语音连接真正断开时回调（AssistService 用它清理并解除持久化会话）
  onDisconnected: (() => void) | null = null;

  constructor(private readonly tts: TtsService) {
    this.player.on(AudioPlayerStatus.Idle, () => {
      this.current = null;
      void this.processQueue();
    });
    this.player.on('error', (err) => {
      console.error(`[voice] 播放出错: ${err.message}`);
      this.current = null;
      void this.processQueue();
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
    void this.processQueue();
  }

  // 主动退出语音并清空一切（不触发 onDisconnected，由调用方自行清理会话）
  leave(): void {
    this.cleanup();
  }

  queueLength(): number {
    return this.queue.length;
  }

  // ================= 内部 =================

  private async processQueue(): Promise<void> {
    if (!this.active || !this.isConnected() || this.current) return;
    const job = this.queue.shift();
    if (!job) return;
    this.current = job;
    void this.playAsync(job).catch((err: Error) => {
      // 合成/转码启动失败：这段没进播放，直接推进队列
      console.error(`[voice] 合成或启动播放失败: ${err.message}`);
      if (this.current === job) {
        this.current = null;
        void this.processQueue();
      }
    });
  }

  // 合成 + 转码 + 交给 player 播放；播放完成由 player 的 Idle 事件推进队列
  private async playAsync(job: SpeakJob): Promise<void> {
    const mp3 = await this.tts.synthesize(job.text, job.language);
    // 合成期间可能已被 leave / 断线清理，放弃本次播放
    if (!this.active || !this.isConnected() || this.current !== job) {
      mp3.resume(); // 排空音频流，释放 WebSocket
      return;
    }
    const ff = this.transcodeToPcm(mp3);
    const resource = createAudioResource(ff.stdout!, { inputType: StreamType.Raw });
    this.player.play(resource);
  }

  // msedge-tts 出的 mp3 -> ffmpeg 转成 Discord 需要的裸 PCM（s16le 48kHz 双声道）
  private transcodeToPcm(mp3: Readable): ChildProcess {
    // ffmpeg-static 下载失败时为 null，回退系统 PATH 里的 ffmpeg
    const ffmpegBin = (ffmpegStatic as unknown as string | null) ?? 'ffmpeg';
    const ff = spawn(
      ffmpegBin,
      ['-i', 'pipe:0', '-f', 's16le', '-ar', '48000', '-ac', '2', '-loglevel', 'error', 'pipe:1'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    mp3.pipe(ff.stdin);
    ff.stderr.on('data', (c: Buffer) => {
      const msg = c.toString().trim();
      if (msg) console.error(`[voice][ffmpeg] ${msg}`);
    });
    return ff;
  }

  private cleanup(): void {
    this.active = false;
    this.queue = [];
    this.current = null;
    if (this.player.state.status !== AudioPlayerStatus.Idle) {
      this.player.stop();
    }
    if (this.connection && this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      this.connection.destroy();
    }
    this.connection = null;
  }
}
