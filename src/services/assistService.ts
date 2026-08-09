import type { Client, Message } from 'discord.js';
import { config } from '../config.js';
import { getState, saveState } from './state.js';
import type { VoiceSessionState } from '../types.js';
import { hasMeaningfulText, detectTextLang, type AiService, type Lang } from './ai.js';
import { containsEmojiName, replaceEmoji } from './emoji.js';
import type { TtsService } from './tts.js';
import { type SpeakSegment, VoiceService } from './voiceService.js';

// 朗读文本上限：避免超长消息让 Edge TTS 报错或朗读过久（翻译仍用完整原文）
const MAX_SPEAK_CHARS = 600;

// 一条消息的媒体信息（图片/视频/语音/文件/贴纸），用于播报"谁发送了什么"
function getMediaInfo(msg: Message): { zh: string; ja: string } | null {
  const sticker = msg.stickers.first();
  if (sticker) return { zh: '表情贴纸', ja: 'スタンプ' };
  const att = msg.attachments.first();
  if (!att) return null;
  const ct = att.contentType ?? '';
  if (ct.startsWith('image/')) return { zh: '图片', ja: '画像' };
  if (ct.startsWith('video/')) return { zh: '视频', ja: '動画' };
  if (ct.startsWith('audio/')) return { zh: '语音', ja: '音声' };
  return { zh: '文件', ja: 'ファイル' };
}

// 朗读前清理：只保留文字、数字、常用标点与 emoji（emoji 之后会替换成对应语言的名字），
// 去掉颜文字/装饰符号。（判定只用假名字母 ぁ-ゖァ-ヺ，避免「・」这类颜文字里的片假名标点混进来）
const SPEECH_KEEP =
  /[一-鿿ぁ-ゖァ-ヺーA-Za-z0-9、。「」『』《》，！？：；‘’“”…·･.,;:!?'"()\-\s\p{Emoji_Presentation}\p{Extended_Pictographic}]/u;

// 把一段文本清理成适合朗读的形式（保留文字、标点、emoji 与换行，去掉符号类）
// 注意只折叠空格/制表符、保留换行，否则多行内容会被并成一句、按句切分失效
function cleanForSpeech(text: string): string {
  return Array.from(text)
    .filter((ch) => SPEECH_KEEP.test(ch))
    .join('')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

// 本地按句切分（不等待 AI 时的精确度提升）：以强标点断句，句内含日文假名 -> 日文，
// 否则含汉字 -> 中文；纯符号/英文句归入上一句的语言。能正确把"你好，こんにちは"切成两段，
// 也能把"元気ですか"整句归为日文（假名在句内）。
function segmentText(text: string): SpeakSegment[] {
  const segments: SpeakSegment[] = [];
  const BREAK = /[，。！？、；：,.!?;:\n]/;
  let cur = '';
  let lastLang: Lang | null = null;

  const flush = (): void => {
    if (!cur) return;
    const kana = /[ぁ-ゖァ-ヺ]/.test(cur);
    const han = /[一-鿿]/.test(cur);
    const lang: Lang = kana ? 'ja' : han ? 'zh' : (lastLang ?? 'zh');
    segments.push({ text: cur, language: lang });
    lastLang = lang;
    cur = '';
  };

  for (const ch of Array.from(text)) {
    cur += ch;
    if (BREAK.test(ch)) flush();
  }
  flush();
  return segments;
}

// 编排核心：按服务器隔离。每个 guild 一个 VoiceService（独立连接+独立播放队列），
// 消息按 guildId 路由；最多同时并行 config.maxVoiceGuilds 个服务器。
export class AssistService {
  // guildId -> 该服务器的语音播放器（惰性创建）
  private voices = new Map<string, VoiceService>();

  constructor(
    private readonly client: Client,
    private readonly ai: AiService,
    private readonly tts: TtsService,
  ) {}

  // 启动：注册消息监听 + 尝试恢复所有已绑定的会话（重启不丢配置）
  start(): void {
    this.client.on('messageCreate', (msg) => void this.handleMessage(msg));
    const sessions = getState().voiceSessions;
    for (const session of Object.values(sessions)) {
      void this.resumeSession(session);
    }
  }

  // 某服务器的会话（未绑定返回 null）
  private sessionOf(guildId: string): VoiceSessionState | null {
    return getState().voiceSessions[guildId] ?? null;
  }

  // 某服务器的播放器（惰性创建，并接好断线自动清理）
  private voiceOf(guildId: string): VoiceService {
    let voice = this.voices.get(guildId);
    if (!voice) {
      voice = new VoiceService(this.tts);
      voice.onDisconnected = () => {
        void this.clearSession(guildId);
      };
      this.voices.set(guildId, voice);
    }
    return voice;
  }

  // 当前已并行服务的服务器数
  activeCount(): number {
    return Object.keys(getState().voiceSessions).length;
  }

  // 绑定：加入语音频道 + 指定监听/翻译的文本频道，并落库
  async bind(guildId: string, voiceChannelId: string, textChannelId: string): Promise<void> {
    // 最大并行服务器数限制（已绑定的服务器重复 join 换频道不算新增）
    const alreadyBound = !!this.sessionOf(guildId);
    if (!alreadyBound && this.activeCount() >= config.maxVoiceGuilds) {
      throw new Error(`最多同时 ${config.maxVoiceGuilds} 个服务器并行，已达到上限，无法加入`);
    }
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) throw new Error('找不到服务器');
    const voice = this.voiceOf(guildId);
    await voice.join(guild, voiceChannelId);

    const session: VoiceSessionState = {
      guildId,
      voiceChannelId,
      textChannelId,
      translateEnabled: true,
      speakEnabled: true,
    };
    getState().voiceSessions[guildId] = session;
    await saveState();
    console.log(`[assist] 已绑定服务器 ${guildId}：语音 ${voiceChannelId} / 文本 ${textChannelId}`);
  }

  // 解除某服务器的会话：退语音 + 清绑定 + 落库
  async clearSession(guildId: string): Promise<void> {
    const voice = this.voices.get(guildId);
    if (voice) {
      voice.leave();
      this.voices.delete(guildId);
    }
    delete getState().voiceSessions[guildId];
    await saveState();
    console.log(`[assist] 已解除服务器 ${guildId} 的会话`);
  }

  async setTranslate(guildId: string, on: boolean): Promise<void> {
    const session = this.sessionOf(guildId);
    if (session) {
      session.translateEnabled = on;
      await saveState();
    }
  }

  async setSpeak(guildId: string, on: boolean): Promise<void> {
    const session = this.sessionOf(guildId);
    if (session) {
      session.speakEnabled = on;
      await saveState();
    }
  }

  // ================= 内部 =================

  private async resumeSession(session: VoiceSessionState): Promise<void> {
    const guild = this.client.guilds.cache.get(session.guildId);
    if (!guild) {
      console.warn(`[assist] 恢复会话失败：找不到服务器 ${session.guildId}，已清除`);
      await this.clearSession(session.guildId);
      return;
    }
    try {
      const voice = this.voiceOf(session.guildId);
      await voice.join(guild, session.voiceChannelId);
      console.log(`[assist] 已恢复服务器 ${session.guildId} 的会话：朗读频道 <#${session.textChannelId}>`);
    } catch (err) {
      console.error(`[assist] 恢复会话失败: ${err instanceof Error ? err.message : String(err)}`);
      await this.clearSession(session.guildId);
    }
  }

  private async handleMessage(msg: Message): Promise<void> {
    // 按服务器路由到对应会话；只跳过机器人自己的消息（其他 bot 的也能读/翻）
    if (msg.author.id === this.client.user?.id) return;
    if (!msg.inGuild()) return;
    const guildId = msg.guildId;
    const session = this.sessionOf(guildId);
    if (!session) return;
    if (msg.channel.id !== session.textChannelId) return;

    const voice = this.voiceOf(guildId);
    const content = msg.content.trim();
    const meaningful = hasMeaningfulText(content);
    const hasEmoji = containsEmojiName(content);
    const media = getMediaInfo(msg);
    const name = msg.member?.displayName ?? msg.author.displayName;

    // 空内容且没发媒体：跳过
    if (!content && !media) return;

    // 纯媒体 / 纯符号消息：只播报"谁发送了什么"（有媒体才出声）
    if (!meaningful && !hasEmoji) {
      if (media && session.speakEnabled) {
        const speakSegments = this.buildMediaSegments(name, media);
        if (speakSegments.length > 0) {
          voice.enqueue({ segments: speakSegments });
        }
      }
      return;
    }

    // 纯 emoji 消息：只朗读 emoji 名字（按名字的语种），不翻译、不调 AI
    if (!meaningful) {
      if (session.speakEnabled) {
        const nameLang = detectTextLang(cleanForSpeech(name) || name);
        const speakSegments = this.buildSpeakSegments(name, nameLang, nameLang, false, null, content);
        if (media) speakSegments.push(...this.buildMediaNote(nameLang, media));
        if (speakSegments.length > 0) {
          voice.enqueue({ segments: speakSegments });
        }
      }
      return;
    }

    // 交给 AI 判断语种/分段并朗读、翻译（准确性优先）；AI 失败时回退本地朗读，保证不静音
    try {
      await this.processWithAi(voice, guildId, msg, content, name);
    } catch (err) {
      console.error(`[assist] AI 调用失败，回退本地朗读: ${err instanceof Error ? err.message : String(err)}`);
      this.fallbackLocalSpeak(voice, guildId, msg, content, name);
    }
  }

  // 用 AI 精确分段朗读 + 翻译。AI 调用失败会向上抛（handleMessage）；翻译回复失败只记日志不影响朗读
  private async processWithAi(
    voice: VoiceService,
    guildId: string,
    msg: Message,
    content: string,
    name: string,
  ): Promise<void> {
    const session = this.sessionOf(guildId);
    if (!session) return;
    const media = getMediaInfo(msg);
    const r = await this.ai.analyzeAndTranslate(content, name);
    if (session.speakEnabled) {
      const speakSegments = this.buildSpeakSegments(name, r.nameLang, r.language, r.mixed, r.segments, content);
      if (media) speakSegments.push(...this.buildMediaNote(r.language, media));
      if (speakSegments.length > 0) {
        voice.enqueue({ segments: speakSegments });
      }
    }
    if (session.translateEnabled) {
      const replyText = r.mixed
        ? `**中文**：${r.zh}\n**日本語**：${r.ja}`
        : r.language === 'ja'
          ? r.zh
          : r.ja;
      try {
        await msg.reply({ content: replyText, allowedMentions: { parse: [], repliedUser: false } });
      } catch (err) {
        console.error(`[assist] 发送翻译回复失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // AI 失败时的兜底：用本地判定朗读
  private fallbackLocalSpeak(
    voice: VoiceService,
    guildId: string,
    msg: Message,
    content: string,
    name: string,
  ): void {
    const session = this.sessionOf(guildId);
    if (!session?.speakEnabled) return;
    const media = getMediaInfo(msg);
    const speakSegments = this.buildSpeakSegmentsLocal(name, content);
    if (media) speakSegments.push(...this.buildMediaNote(detectTextLang(content), media));
    if (speakSegments.length > 0) {
      voice.enqueue({ segments: speakSegments });
    }
  }

  // 本地快速朗读分段：用户名按自身语种读，内容按句切分、句内按假名/汉字判语种
  private buildSpeakSegmentsLocal(name: string, content: string): SpeakSegment[] {
    const cleanName = cleanForSpeech(name) || name;
    const nameLang = detectTextLang(cleanName);
    const nameForSpeech = replaceEmoji(cleanName, nameLang) || cleanName;

    const cleanContent = cleanForSpeech(content).slice(0, MAX_SPEAK_CHARS);
    if (!cleanContent) return [];

    const contentSegments = segmentText(cleanContent)
      .map((s) => ({ text: replaceEmoji(s.text, s.language), language: s.language }))
      .filter((s) => s.text.length > 0);
    if (contentSegments.length === 0) return [];

    // 语气词跟随第一段内容的语种（"说，"/"さん、"）
    const firstLang = contentSegments[0].language;
    const lead = firstLang === 'ja' ? 'さん、' : '说，';
    const attr: SpeakSegment[] = nameLang === firstLang
      ? [{ text: `${nameForSpeech}${lead}`, language: nameLang }]
      : [
          { text: nameForSpeech, language: nameLang },
          { text: lead, language: firstLang },
        ];
    return [...attr, ...contentSegments];
  }

  // 组装朗读分段：用户名按自身语种读，语气词与内容随消息语种。
  // 内容分段优先级：AI 给的精确分段 > 单语整段用该语种读 > 本地按字符粗切。
  private buildSpeakSegments(
    name: string,
    nameLang: Lang | null,
    messageLang: Lang,
    mixed: boolean,
    aiSegments: { text: string; language: Lang }[] | null,
    content: string,
  ): SpeakSegment[] {
    const cleanName = cleanForSpeech(name) || name;
    const nameLangFinal = nameLang ?? detectTextLang(cleanName);
    const nameForSpeech = replaceEmoji(cleanName, nameLangFinal) || cleanName;
    const lead = messageLang === 'ja' ? 'さん、' : '说，';
    // 用户名与语气词语种一致时合成一段，避免分开朗读造成割裂
    const attr: SpeakSegment[] = nameLangFinal === messageLang
      ? [{ text: `${nameForSpeech}${lead}`, language: nameLangFinal }]
      : [
          { text: nameForSpeech, language: nameLangFinal },
          { text: lead, language: messageLang },
        ];

    // 内容清理后把 emoji 换成名字，再截断
    const cleanContent = replaceEmoji(cleanForSpeech(content), messageLang).slice(0, MAX_SPEAK_CHARS);
    if (!cleanContent) return []; // 清理后没有可读内容（全是符号/emoji），整段跳过

    let contentSegments: SpeakSegment[];
    if (aiSegments && aiSegments.length > 0) {
      // AI 的精确分段
      contentSegments = aiSegments
        .map((s) => ({ text: replaceEmoji(cleanForSpeech(s.text), s.language), language: s.language }))
        .filter((s) => s.text.length > 0);
      if (contentSegments.length === 0) return [];
    } else if (!mixed) {
      // 单语消息整段用该语种读，避免把日文汉字误切到中文音色
      contentSegments = [{ text: cleanContent, language: messageLang }];
    } else {
      // 混杂但没拿到 AI 分段
      contentSegments = segmentText(cleanContent);
    }
    return [...attr, ...contentSegments];
  }

  // 纯媒体消息的播报：谁发送了什么
  private buildMediaSegments(name: string, media: { zh: string; ja: string }): SpeakSegment[] {
    const cleanName = cleanForSpeech(name) || name;
    const nameLang = detectTextLang(cleanName);
    if (nameLang === 'ja') {
      return [{ text: `${cleanName}さんが${media.ja}を送りました`, language: 'ja' }];
    }
    return [{ text: `${cleanName}发送了${media.zh}`, language: 'zh' }];
  }

  // 文字消息附带媒体时的补充播报
  private buildMediaNote(messageLang: Lang, media: { zh: string; ja: string }): SpeakSegment[] {
    if (messageLang === 'ja') {
      return [{ text: `、あと${media.ja}も送りました`, language: 'ja' }];
    }
    return [{ text: `，还发送了${media.zh}`, language: 'zh' }];
  }
}
