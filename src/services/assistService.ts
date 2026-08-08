import type { Client, Message } from 'discord.js';
import { getState, saveState } from './state.js';
import type { VoiceSessionState } from '../types.js';
import { hasMeaningfulText, detectTextLang, type AiService, type Lang } from './ai.js';
import type { SpeakSegment, VoiceService } from './voiceService.js';

// 朗读文本上限：避免超长消息让 Edge TTS 报错或朗读过久（翻译仍用完整原文）
const MAX_SPEAK_CHARS = 600;

// 朗读前清理：只保留文字、数字与常用标点，去掉 emoji / 颜文字 / 装饰符号。
// （判定只用假名字母 ぁ-ゖァ-ヺ，避免「・」这类颜文字里的片假名标点混进来）
const SPEECH_KEEP =
  /[一-鿿ぁ-ゖァ-ヺA-Za-z0-9、。「」『』《》，！？：；‘’“”…·･.,;:!?'"()\-\s]/u;

// 把一段文本清理成适合朗读的形式（保留文字与标点，去掉符号类）
function cleanForSpeech(text: string): string {
  return Array.from(text)
    .filter((ch) => SPEECH_KEEP.test(ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

// 把一段文本按语言切成连续的段：日文假名字母 -> ja，中文汉字 -> zh，
// 标点/空格/数字/英文/表情等中性字符并入相邻段。
function segmentText(text: string): SpeakSegment[] {
  const segments: SpeakSegment[] = [];
  let current = '';
  let currentLang: Lang | null = null;

  const flush = (): void => {
    if (current) {
      segments.push({ text: current, language: currentLang ?? 'zh' });
      current = '';
      currentLang = null;
    }
  };

  for (const ch of text) {
    let lang: Lang | null = null;
    if (/[ぁ-ゖァ-ヺ]/.test(ch)) lang = 'ja';
    else if (/[一-鿿]/.test(ch)) lang = 'zh';

    if (lang === null) {
      current += ch; // 中性字符并入当前段（开头则等首个语言字符出现）
      continue;
    }
    if (currentLang === null || currentLang === lang) {
      currentLang = lang;
      current += ch;
      continue;
    }
    flush(); // 语言切换：收尾上一段，开启新段
    currentLang = lang;
    current = ch;
  }
  flush();
  return segments;
}

// 编排核心：绑定文本频道 -> AI 识别中日 + 互译 -> TTS 朗读原文 + 翻译回复
export class AssistService {
  constructor(
    private readonly client: Client,
    private readonly ai: AiService,
    private readonly voice: VoiceService,
  ) {
    // 语音连接真正断开时自动解除会话
    this.voice.onDisconnected = () => {
      void this.clearSession();
    };
  }

  // 启动：注册消息监听 + 尝试恢复上次的会话（重启不丢配置）
  start(): void {
    this.client.on('messageCreate', (msg) => void this.handleMessage(msg));
    const session = getState().voiceSession;
    if (session) {
      void this.resumeSession(session);
    }
  }

  // 绑定：加入语音频道 + 指定监听/翻译的文本频道，并落库
  async bind(guildId: string, voiceChannelId: string, textChannelId: string): Promise<void> {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) throw new Error('找不到服务器');
    await this.voice.join(guild, voiceChannelId);

    const session: VoiceSessionState = {
      guildId,
      voiceChannelId,
      textChannelId,
      translateEnabled: true,
      speakEnabled: true,
    };
    getState().voiceSession = session;
    await saveState();
    console.log(`[assist] 已绑定：语音 ${voiceChannelId} / 文本 ${textChannelId}`);
  }

  // 解除会话：退语音 + 清绑定 + 落库
  async clearSession(): Promise<void> {
    this.voice.leave();
    getState().voiceSession = null;
    await saveState();
    console.log('[assist] 已解除会话');
  }

  async setTranslate(on: boolean): Promise<void> {
    const session = getState().voiceSession;
    if (session) {
      session.translateEnabled = on;
      await saveState();
    }
  }

  async setSpeak(on: boolean): Promise<void> {
    const session = getState().voiceSession;
    if (session) {
      session.speakEnabled = on;
      await saveState();
    }
  }

  // ================= 内部 =================

  private async resumeSession(session: VoiceSessionState): Promise<void> {
    const guild = this.client.guilds.cache.get(session.guildId);
    if (!guild) {
      console.warn('[assist] 恢复会话失败：找不到服务器，已清除');
      await this.clearSession();
      return;
    }
    try {
      await this.voice.join(guild, session.voiceChannelId);
      console.log(`[assist] 已恢复会话：朗读频道 <#${session.textChannelId}>`);
    } catch (err) {
      console.error(`[assist] 恢复会话失败: ${err instanceof Error ? err.message : String(err)}`);
      await this.clearSession();
    }
  }

  private async handleMessage(msg: Message): Promise<void> {
    const session = getState().voiceSession;
    if (!session) return;
    // 跳过机器人消息（包括自己的翻译回复，避免循环）
    if (msg.author.bot) return;
    if (msg.channel.id !== session.textChannelId) return;

    const content = msg.content.trim();
    if (!content || !hasMeaningfulText(content)) return;

    try {
      // 1. AI 识别主要语言 / 是否混杂，并生成中、日两个完整版本 + 混排时的原文分段
      const { language, mixed, zh, ja, segments } = await this.ai.analyzeAndTranslate(content);

      // 2. TTS 朗读原文：带用户名开头（用户名按自身语种读）；混排用 AI 分段切换音色
      if (session.speakEnabled) {
        const name = msg.member?.displayName ?? msg.author.displayName;
        const speakSegments = this.buildSpeakSegments(name, language, mixed, segments, content);
        if (speakSegments.length > 0) {
          this.voice.enqueue({ segments: speakSegments });
        }
      }

      // 3. 翻译以回复形式发回频道：混排一条回复同时给中/日两版，单语只给另一种语言
      if (session.translateEnabled) {
        const replyText = mixed
          ? `**中文**：${zh}\n**日本語**：${ja}`
          : language === 'ja'
            ? zh
            : ja;
        await msg.reply({
          content: replyText,
          allowedMentions: { parse: [], repliedUser: false },
        });
      }
    } catch (err) {
      console.error(`[assist] 处理消息失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 组装朗读分段：用户名按自身语种读（不被消息语言影响），语气词（说/さん）与内容随消息语种。
  // 内容分段优先级：AI 给的精确分段 > 单语整段用该语种读 > 本地按字符粗切（兜底）。
  private buildSpeakSegments(
    name: string,
    messageLang: Lang,
    mixed: boolean,
    aiSegments: { text: string; language: Lang }[] | null,
    content: string,
  ): SpeakSegment[] {
    const cleanName = cleanForSpeech(name) || name;
    const nameLang = detectTextLang(cleanName);
    const lead = messageLang === 'ja' ? 'さん、' : '说，';
    // 用户名与语气词语种一致时合成一段，避免分开朗读造成割裂
    const attr: SpeakSegment[] = nameLang === messageLang
      ? [{ text: `${cleanName}${lead}`, language: nameLang }]
      : [
          { text: cleanName, language: nameLang },
          { text: lead, language: messageLang },
        ];

    const cleanContent = cleanForSpeech(content).slice(0, MAX_SPEAK_CHARS);
    if (!cleanContent) return []; // 清理后没有可读内容（全是符号/emoji），整段跳过

    let contentSegments: SpeakSegment[];
    if (aiSegments && aiSegments.length > 0) {
      // AI 的精确分段（能正确处理日文汉字如「元気」归入日文）
      contentSegments = aiSegments
        .map((s) => ({ text: cleanForSpeech(s.text), language: s.language }))
        .filter((s) => s.text.length > 0);
      if (contentSegments.length === 0) return [];
    } else if (!mixed) {
      // 单语消息整段用该语种读，避免把日文汉字误切到中文音色
      contentSegments = [{ text: cleanContent, language: messageLang }];
    } else {
      // 混杂但没拿到 AI 分段：本地按字符粗切兜底
      contentSegments = segmentText(cleanContent);
    }
    return [...attr, ...contentSegments];
  }
}
