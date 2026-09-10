import { t, translator, DEFAULT_LOCALE } from '../i18n.js';
import type {
  Client,
  Message,
  PartialMessage,
  ReadonlyCollection,
  Snowflake,
  VoiceState,
} from 'discord.js';
import { config } from '../config.js';
import { getState, saveState, guildLocale } from './state.js';
import type { TranslationLinkState, VoiceSessionState } from '../types.js';
import { hasMeaningfulText, detectTextLang, type AiService, type Lang, type TranslateResult } from './ai.js';
import {
  containsEmojiName,
  loadCldrEmojiNames,
  removeDiscordCustomEmojis,
  replaceDiscordCustomEmojis,
  replaceEmoji,
} from './emoji.js';
import type { TtsService } from './tts.js';
import { type SpeakSegment, VoiceService } from './voiceService.js';

// 朗读文本上限。超长消息会被截断，翻译仍使用完整原文。
const MAX_SPEAK_CHARS = 2048;

// 一条消息的媒体信息，包括图片、视频、语音、文件和贴纸，用于播报发送者发送的内容。
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

// 朗读前进行清理，只保留文字、数字、常用标点和 emoji。
// emoji 会替换成对应语言的名称，颜文字和装饰符号会被移除。
// 语种判定只使用假名，避免颜文字中的片假名标点被误判为日文。
const SPEECH_KEEP =
  /[一-鿿ぁ-ゖァ-ヺーA-Za-z0-9、。「」『』《》，！？：；‘’“”…·･.,;:!?'"()\-\s\u200D\uFE0F\u20E3#*\p{Emoji_Presentation}\p{Extended_Pictographic}]/u;

// 把一段文本清理成适合朗读的形式，保留文字、标点、emoji 和换行，去掉符号类字符。
// 只折叠空格和制表符，保留换行，避免多行内容被合并后影响按句切分。
function cleanForSpeech(text: string): string {
  return Array.from(replaceDiscordCustomEmojis(text))
    .filter((ch) => SPEECH_KEEP.test(ch))
    .join('')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

// Discord 的用户艾特在 message.content 中是 <@用户ID> 或 <@!用户ID>。
// 朗读前必须先还原为服务器内显示名，否则 cleanForSpeech 会留下 ID 数字并被 TTS 读出来。
function resolveUserMentions(msg: Message, text: string): string {
  return text.replace(/<@!?(\d+)>/g, (mention, userId: string) => {
    const member = msg.mentions.members?.get(userId);
    const user = msg.mentions.users.get(userId);
    return member?.displayName ?? user?.displayName ?? mention;
  });
}

// 单独发送的数字默认使用日语逐位朗读，保留前导零。
const JAPANESE_DIGIT_NAMES = ['ゼロ', 'いち', 'に', 'さん', 'よん', 'ご', 'ろく', 'なな', 'はち', 'きゅう'];

function isStandaloneDigits(text: string): boolean {
  return /^[0-9]+$/.test(text.trim());
}

function formatDigitsForJapaneseSpeech(text: string): string {
  return Array.from(text.trim(), (digit) => JAPANESE_DIGIT_NAMES[Number(digit)]).join('、');
}

// 拉丁字母写法无法从字符本身严格区分英文和日语罗马音。
// 这些常见日文名作为无 AI 时的本地兜底，AI 返回的 name_lang 会优先于此判断。
const JAPANESE_ROMAJI_HINTS = new Set([
  'kanade', 'sakura', 'haruka', 'yukina', 'sayo', 'moca', 'saaya', 'arisa',
  'kasumi', 'taki', 'anon', 'soyo', 'tomori', 'sakiko', 'mutsumi', 'shiori',
  'tsubaki', 'ayame', 'kaede', 'nanami', 'kanon', 'koharu', 'mizuki', 'akari',
  'hotaru', 'nagisa', 'nozomi', 'meiko', 'sumire',
]);

function isJapaneseRomajiHint(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return /^[a-z]+$/.test(normalized) && JAPANESE_ROMAJI_HINTS.has(normalized);
}

function detectNameLang(text: string): Lang {
  return isJapaneseRomajiHint(text) ? 'ja' : detectTextLang(text);
}

// speech_text 只会插入空白，因此可以把新增空格按原有 AI 片段归属，保留中/日音色边界。
function applySpeechSpacingToSegments(
  speechText: string,
  segments: { text: string; language: Lang }[],
): { text: string; language: Lang }[] {
  const chars = Array.from(speechText);
  let cursor = 0;
  const normalized: { text: string; language: Lang }[] = [];

  for (const segment of segments) {
    const expected = Array.from(segment.text).filter((ch) => !/\s/u.test(ch));
    if (expected.length === 0) {
      normalized.push(segment);
      continue;
    }

    let matched = 0;
    let text = '';
    while (cursor < chars.length && matched < expected.length) {
      const ch = chars[cursor++];
      text += ch;
      if (/\s/u.test(ch)) continue;
      if (ch !== expected[matched]) return segments;
      matched++;
    }
    if (matched !== expected.length) return segments;

    // 将片段边界处新增的空格归入前一个片段，避免丢掉 TTS 的停顿。
    while (cursor < chars.length && /\s/u.test(chars[cursor])) {
      text += chars[cursor++];
    }
    normalized.push({ text: text.trim(), language: segment.language });
  }

  return normalized;
}

// 翻译结果只要与原文在空白和首尾空格上等价，就视为原文回显。
function sameReplyText(left: string, right: string): boolean {
  return left.trim().replace(/\s+/gu, ' ') === right.trim().replace(/\s+/gu, ' ');
}

// 本地按句切分可以提高未等待 AI 时的处理精度。
// 以强标点断句，句内含日文假名时归为日文，否则含汉字时归为中文。
// 纯符号和英文句归入上一句的语言，可以正确切分中日混合句。
// 含有假名的日文句会整体归为日文。
function segmentText(text: string): { text: string; language: Lang }[] {
  const segments: { text: string; language: Lang }[] = [];
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

// 编排核心按服务器隔离。每个 guild 使用独立的 VoiceService、连接和播放队列。
// 消息按 guildId 路由，最多同时并行服务 config.maxVoiceGuilds 个服务器。
export class AssistService {
  // guildId 对应该服务器的语音播放器，按需创建。
  private voices = new Map<string, VoiceService>();
  private pendingBinds = new Map<string, symbol>();
  // AI 处理期间源消息可能先被删除。记录处理中消息，删除事件到达时让后续译文发送直接终止。
  private pendingTranslations = new Set<string>();
  private deletedPendingSources = new Set<string>();
  private started = false;
  private descriptionTask: Promise<void> | null = null;
  private descriptionDirty = false;
  private readonly onMessage = (msg: Message): void => {
    void this.handleMessage(msg).catch((err) => console.error('[assist] 消息处理失败:', err));
    void this.handleTranslateMessage(msg).catch((err) => console.error('[assist] 互译处理失败:', err));
  };
  private readonly onVoiceState = (oldState: VoiceState, newState: VoiceState): void => {
    void this.handleVoiceStateChange(oldState, newState).catch((err) => console.error('[assist] 进出播报失败:', err));
  };
  private readonly onMessageDelete = (msg: Message | PartialMessage): void => {
    void this.handleMessageDelete(msg).catch((err) => console.error('[assist] 同步删除翻译失败:', err));
  };
  private readonly onMessageDeleteBulk = (
    messages: ReadonlyCollection<Snowflake, Message<true> | PartialMessage<true>>,
  ): void => {
    void this.handleMessageDeleteBulk(messages).catch((err) => console.error('[assist] 批量同步删除翻译失败:', err));
  };
  // bot 描述中的实时连接数刷新定时器。
  private statusTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly client: Client,
    private readonly ai: AiService,
    private readonly tts: TtsService,
  ) {}

  // 启动：注册消息监听 + 语音进出监听。不再自动重连语音——
  // 重启后清掉上次残留的会话，需要时用 /lb join 手动重新绑定。
  // 独立 AI 互译会话单独监听，不建立语音连接，跨重启保持启用。
  start(): void {
    if (this.started) return;
    this.started = true;
    this.client.on('messageCreate', this.onMessage);
    this.client.on('voiceStateUpdate', this.onVoiceState);
    this.client.on('messageDelete', this.onMessageDelete);
    this.client.on('messageDeleteBulk', this.onMessageDeleteBulk);
    // CLDR 失败时 emoji.ts 会自动使用本地扩展名称，不阻塞机器人启动。
    void loadCldrEmojiNames();
    void this.clearAllSessions()
      .catch((err) =>
        console.error(`[assist] 启动时清理旧语音会话失败: ${err instanceof Error ? err.message : String(err)}`),
      )
      .finally(() => void this.refreshDescription());
    // bot 描述中的实时连接数每 30 分钟刷新一次。
    this.statusTimer = setInterval(() => void this.refreshDescription(), 30 * 60 * 1000);
  }

  // 停止描述定时刷新，供优雅退出时调用。
  dispose(): void {
    this.started = false;
    this.client.off('messageCreate', this.onMessage);
    this.client.off('voiceStateUpdate', this.onVoiceState);
    this.client.off('messageDelete', this.onMessageDelete);
    this.client.off('messageDeleteBulk', this.onMessageDeleteBulk);
    this.pendingTranslations.clear();
    this.deletedPendingSources.clear();
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
  }

  // 获取某服务器的会话。未绑定时返回 null。
  private sessionOf(guildId: string): VoiceSessionState | null {
    return getState().voiceSessions[guildId] ?? null;
  }

  // 获取某服务器的播放器。按需创建，并配置断线自动清理。
  private voiceOf(guildId: string): VoiceService {
    let voice = this.voices.get(guildId);
    if (!voice) {
      voice = new VoiceService(this.tts);
      voice.onDisconnected = () => {
        void this.clearSession(guildId).catch((err) => console.error('[assist] 清理断线会话失败:', err));
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
    // 最大并行服务器数限制。已绑定的服务器重复 join 或更换频道不计为新增。
    if (this.pendingBinds.has(guildId)) throw new Error(t("本服务器正在加入语音，请稍后再试"));
    const occupied = new Set([...Object.keys(getState().voiceSessions), ...this.pendingBinds.keys()]);
    if (!occupied.has(guildId) && occupied.size >= config.maxVoiceGuilds) {
      throw new Error(t("最多同时 {0} 个服务器并行，已达到上限，无法加入", [config.maxVoiceGuilds]));
    }
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) throw new Error(t("找不到服务器"));
    const voice = this.voiceOf(guildId);
    const binding = Symbol();
    this.pendingBinds.set(guildId, binding);
    try {
      await voice.join(guild, voiceChannelId);
      if (this.pendingBinds.get(guildId) !== binding || this.voices.get(guildId) !== voice) {
        throw new Error(t("语音绑定已取消"));
      }

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
      void this.refreshDescription();
    } catch (err) {
      if (this.voices.get(guildId) === voice) await this.clearSession(guildId);
      throw err;
    } finally {
      if (this.pendingBinds.get(guildId) === binding) this.pendingBinds.delete(guildId);
    }
  }

  // 解除某服务器的会话：退语音 + 清绑定 + 落库
  async clearSession(guildId: string): Promise<void> {
    this.pendingBinds.delete(guildId);
    const voice = this.voices.get(guildId);
    if (voice) {
      voice.leave();
      this.voices.delete(guildId);
    }
    delete getState().voiceSessions[guildId];
    await saveState();
    console.log(`[assist] 已解除服务器 ${guildId} 的会话`);
    void this.refreshDescription();
  }

  // 离开所有语音频道并清空持久化会话。
  async clearAllSessions(): Promise<void> {
    for (const voice of this.voices.values()) voice.leave();
    this.voices.clear();
    this.pendingBinds.clear();
    getState().voiceSessions = {};
    await saveState();
    void this.refreshDescription();
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
      if (!on) this.voices.get(guildId)?.cancelSpeech();
      await saveState();
    }
  }

  // 系统功能直接排队固定语音，不经过 messageCreate，也不会触发翻译回复。
  // 未绑定语音、朗读关闭或连接不可用时返回 false，调用方仍可保留文字提醒。
  speakFireReminder(guildId: string, runnerName: string, isMedley = false): boolean {
    const session = this.sessionOf(guildId);
    if (!session?.speakEnabled) return false;
    const voice = this.voices.get(guildId);
    if (!voice?.isConnected()) return false;
    const cleanName = cleanForSpeech(runnerName) || runnerName;
    const nameLang = detectNameLang(cleanName);
    const locale = guildLocale(guildId);
    const reminder = translator(locale)(isMedley
      ? '还剩一轮组曲，请在结束后补火。'
      : '还剩一把，请在结束后补火。');
    voice.enqueue({
      segments: [
        { text: replaceEmoji(cleanName, nameLang) || cleanName, language: nameLang },
        { text: reminder, language: locale === 'ja' ? 'ja' : 'zh' },
      ],
      compactBoundaries: true,
    });
    return true;
  }

  // 当前已绑定独立 AI 互译的文本频道数
  translateChannelCount(): number {
    return Object.keys(getState().translateSessions).length;
  }

  // 绑定一个文本频道进行独立 AI 互译，不依赖语音，所有成员均可使用。
  async bindTranslate(guildId: string, textChannelId: string): Promise<void> {
    const sessions = getState().translateSessions;
    if (!sessions[textChannelId] && Object.keys(sessions).length >= config.maxTranslateChannels) {
      throw new Error(t("最多同时 {0} 个文本频道独立互译，已达到上限", [config.maxTranslateChannels]));
    }
    // 防止与语音会话绑定的监听频道重叠，否则一条消息会触发两次翻译回复
    const voice = this.sessionOf(guildId);
    if (voice && voice.textChannelId === textChannelId) {
      throw new Error(t("该频道已是语音会话的监听频道（已含互译），无需重复绑定"));
    }
    sessions[textChannelId] = { guildId, textChannelId };
    await saveState();
    console.log(`[assist] 已在频道 ${textChannelId} 启用独立 AI 互译（服务器 ${guildId}）`);
    void this.refreshDescription();
  }

  // 解除独立 AI 互译绑定
  async unbindTranslate(textChannelId: string): Promise<void> {
    if (getState().translateSessions[textChannelId]) {
      delete getState().translateSessions[textChannelId];
      await saveState();
      console.log(`[assist] 已关闭频道 ${textChannelId} 的独立 AI 互译`);
      void this.refreshDescription();
    }
  }

  // ================= 内部 =================

  // bot 描述中的动态行使用固定格式。更新时先移除旧动态行，保留用户填写的内容。
  private buildStatusLine(voice: number, translate: number): string {
    return `⚡ ${translator(DEFAULT_LOCALE)('语音 {0} ｜ 翻译 {1}', [voice, translate])}`;
  }

  // 从描述里剥离上一次写入的动态行，保留用户自己填写的固定内容。
  private stripStatusLine(desc: string): string {
    return desc
      .replace(/(?:^|\n\n)⚡ (?:Voice|ボイス|语音) \d+ ｜ (?:Trans|翻訳|翻译) \d+$/, '')
      .replace(/^⚡ (?:Voice|ボイス|语音) \d+ ｜ (?:Trans|翻訳|翻译) \d+\n\n/, '')
      .trim();
  }

  // 更新 bot 描述里的实时连接数。每次先读后台当前描述，剥离旧动态行后再追加，
  // 避免覆盖用户在 Discord 后台手动填写的自我介绍内容。动态行放在最前面，保证可见。
  private refreshDescription(): Promise<void> {
    if (!this.started) return Promise.resolve();
    this.descriptionDirty = true;
    if (!this.descriptionTask) {
      this.descriptionTask = (async () => {
        while (this.descriptionDirty && this.started) {
          this.descriptionDirty = false;
          await this.updateDescription();
        }
      })().catch((err) => console.error('[assist] 描述刷新失败:', err))
        .finally(() => { this.descriptionTask = null; });
    }
    return this.descriptionTask;
  }

  private async updateDescription(): Promise<void> {
    const app = this.client.application;
    if (!app) {
      console.warn('[assist] client.application 为 null，跳过 bot 描述刷新');
      return;
    }
    const fetched = await app.fetch().catch((err) => {
      console.warn(`[assist] 读取当前 bot 描述失败: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });
    if (!fetched || !this.started) return;
    const current = fetched?.description ?? app.description ?? '';
    const base = this.stripStatusLine(current);
    const dyn = this.buildStatusLine(this.activeCount(), this.translateChannelCount());
    // 动态行优先占位，剩余长度给用户内容；总长不超过 400
    const maxBase = Math.max(0, 400 - dyn.length - (base ? 2 : 0));
    const full = [dyn, base.slice(0, maxBase)].filter(Boolean).join('\n\n');
    if (full === current) return;
    try {
      await app.edit({ description: full });
      console.log(`[assist] 已更新 bot 描述: ${JSON.stringify(full)}`);
    } catch (err) {
      console.error(`[assist] 更新 bot 描述失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 语音频道进出播报：绑定会话开启朗读时，成员进入/退出绑定的语音频道用 TTS 播报。
  // 名字交给 AI 判断中/日，回退本地判定。跳过机器人自己与其他 bot，静音/禁用/移频等不改频道的事件不触发。
  private async handleVoiceStateChange(oldState: VoiceState, newState: VoiceState): Promise<void> {
    const guild = newState.guild ?? oldState.guild;
    const session = this.sessionOf(guild.id);
    if (!session?.speakEnabled) return;

    const channelId = session.voiceChannelId;
    const joined = newState.channelId === channelId && oldState.channelId !== channelId;
    const left = oldState.channelId === channelId && newState.channelId !== channelId;
    if (!joined && !left) return;

    const member = newState.member ?? oldState.member;
    if (!member) return;
    if (member.id === this.client.user?.id) return; // 不播报机器人自己
    if (member.user.bot) return; // 不播报其他 bot

    // 名字交给 AI 判断语种，失败时使用本地判定。
    // 名字与进出语拆成两段并使用对应音色，进出语固定使用日文，不受服务器语言设置影响。
    const name = member.displayName;
    const r = await this.ai.analyzeAndTranslate(name, name);
    if (this.sessionOf(guild.id) !== session || !session.speakEnabled) return;
    const spokenName = r.aiOk && r.speechName ? r.speechName : name;
    const cleanName = cleanForSpeech(spokenName) || spokenName;
    const nameLang = r.nameLang ?? detectNameLang(cleanName);
    const nameForSpeech = replaceEmoji(cleanName, nameLang) || cleanName;
    const suffix = joined ? 'さんが入室しました' : 'さんが退室しました';
    this.voices.get(guild.id)?.enqueue({
      segments: [
        { text: nameForSpeech, language: nameLang },
        { text: suffix, language: 'ja' },
      ],
      compactBoundaries: true,
    });
  }

  private async handleMessage(msg: Message): Promise<void> {
    // 按服务器路由到对应会话，只跳过机器人自己的消息，其他 bot 的消息也可以朗读和翻译。
    if (msg.author.id === this.client.user?.id) return;
    if (!msg.inGuild()) return;
    const guildId = msg.guildId;
    const session = this.sessionOf(guildId);
    if (!session || (!session.speakEnabled && !session.translateEnabled)) return;
    if (msg.channel.id !== session.textChannelId) return;

    const voice = this.voiceOf(guildId);
    // 先把用户艾特还原成显示名，再交给 AI 和 TTS，避免朗读出用户 ID。
    // 在 AI 分段/补空格之前删除自定义表情，避免标记被拆开后无法过滤。
    const content = removeDiscordCustomEmojis(resolveUserMentions(msg, msg.content)).trim();
    const meaningful = hasMeaningfulText(content);
    const hasEmoji = containsEmojiName(content);
    const media = getMediaInfo(msg);
    const name = msg.member?.displayName ?? msg.author.displayName;

    // 空内容且没发媒体：跳过
    if (!content && !media) return;

    // 纯媒体或纯符号消息只播报发送者发送的内容，有媒体时才发出语音。
    if (!meaningful && !hasEmoji) {
      if (media && session.speakEnabled) {
        const speakSegments = this.buildMediaSegments(name, media);
        if (speakSegments.length > 0) {
          voice.enqueue({ segments: speakSegments });
        }
      }
      return;
    }

    // 纯 emoji 消息只朗读 emoji 名称，使用名称对应的语种，不翻译，也不调用 AI。
    if (!meaningful) {
      if (session.speakEnabled) {
        const nameLang = detectNameLang(cleanForSpeech(name) || name);
        const speakSegments = this.buildSpeakSegments(name, nameLang, nameLang, false, null, content);
        if (media) speakSegments.push(...this.buildMediaNote(nameLang, media));
        if (speakSegments.length > 0) {
          voice.enqueue({ segments: speakSegments });
        }
      }
      return;
    }

    // 交给 AI 判断语种、分段、朗读和翻译，以准确性为优先。
    // AI 失败时由内部回退到本地按句分段朗读。
    await this.processWithAi(voice, guildId, msg, content, name);
  }

  // 用 AI 精确分段朗读和翻译。AI 调用失败时向上抛出，翻译回复失败时只记录日志，不影响朗读。
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
    if (session.translateEnabled) this.pendingTranslations.add(msg.id);
    try {
      const r = await this.ai.analyzeAndTranslate(content, name);
      if (this.sessionOf(guildId) !== session) return;
      // AI 可选地为 TTS 补充明确的英文词间空格；缺失或 AI 失败时使用原文。
      const speechContent = r.aiOk && r.speechText ? r.speechText : content;
      const speechName = r.aiOk && r.speechName ? r.speechName : name;
      const speechAiSegments = r.segments
        ? applySpeechSpacingToSegments(speechContent, r.segments)
        : null;
      if (session.speakEnabled) {
        // AI 成功时用精确分段朗读；AI 失败/未配置时回退本地按句分段，混杂消息也能分语种读
        let speakSegments: SpeakSegment[];
        if (isStandaloneDigits(content)) {
          // 数字串不按中文数字整体读，使用日语音色逐位读出（例如 00999）。
          speakSegments = this.buildSpeakSegments(
            speechName,
            r.nameLang,
            'ja',
            false,
            null,
            formatDigitsForJapaneseSpeech(content),
          );
          if (media) speakSegments.push(...this.buildMediaNote('ja', media));
        } else if (isJapaneseRomajiHint(content)) {
          // 常见日语罗马音（例如 kanade）使用日语音色，不按英文单词朗读。
          speakSegments = this.buildJapaneseRomajiSpeakSegments(speechName, speechContent, r.nameLang);
          if (media) speakSegments.push(...this.buildMediaNote('ja', media));
        } else if (r.aiOk) {
          speakSegments = this.buildSpeakSegments(
            speechName,
            r.nameLang,
            r.language,
            r.mixed,
            speechAiSegments,
            speechContent,
          );
          if (media) speakSegments.push(...this.buildMediaNote(r.language, media));
        } else {
          speakSegments = this.buildSpeakSegmentsLocal(name, content);
          if (media) speakSegments.push(...this.buildMediaNote(detectTextLang(content), media));
        }
        if (speakSegments.length > 0) {
          voice.enqueue({ segments: speakSegments });
        }
      }
      // 只有 AI 真正翻译成功才回复，避免把原文原样回显造成刷屏
      if (session.translateEnabled && r.aiOk) {
        await this.sendTranslationReply(msg, r, content);
      }
    } finally {
      this.pendingTranslations.delete(msg.id);
      this.deletedPendingSources.delete(msg.id);
    }
  }

  // AI 互译回复由语音会话和独立互译会话共用，将翻译结果格式化为回复文本并发送。
  private async sendTranslationReply(msg: Message, r: TranslateResult, sourceText: string): Promise<void> {
    if (this.isSourceDeleted(msg)) return;
    const t = translator(guildLocale(msg.guildId));
    let replyText: string;
    if (r.mixed) {
      const zhIsSource = sameReplyText(r.zh, sourceText);
      const jaIsSource = sameReplyText(r.ja, sourceText);
      if (zhIsSource && jaIsSource) return;
      // 模型可能因用户名上下文误把单语消息标成 mixed。原文版不再重复发送，只保留另一语种。
      if (zhIsSource) {
        replyText = r.ja;
      } else if (jaIsSource) {
        replyText = r.zh;
      } else {
        replyText = t("**中文**：{0}\n**日本語**：{1}", [r.zh, r.ja]);
      }
    } else {
      // 名字只是辅助上下文，模型偶尔会因此把正文的 language 判反，导致选择原文版本。
      // 如果首选结果等于原文，改用另一个版本；两个版本都等于原文时不发送无效回显。
      const preferred = r.language === 'ja' ? r.zh : r.ja;
      const alternative = r.language === 'ja' ? r.ja : r.zh;
      replyText = sameReplyText(preferred, sourceText) ? alternative : preferred;
      if (sameReplyText(replyText, sourceText)) return;
    }
    const sentMessages: Message[] = [];
    try {
      // Discord 每条消息最多 2000 个 UTF-16 单元，长翻译分条回复，避免整条丢失。
      for (let start = 0; start < replyText.length;) {
        if (this.isSourceDeleted(msg)) break;
        let end = Math.min(start + 2000, replyText.length);
        if (end < replyText.length && /[\uD800-\uDBFF]/.test(replyText[end - 1])) end--;
        const reply = await msg.reply({ content: replyText.slice(start, end), allowedMentions: { parse: [], repliedUser: false } });
        sentMessages.push(reply);
        start = end;
      }

      if (sentMessages.length === 0) return;
      // 先同步写入关联，再等待持久化。删除事件可能在 saveState() 等待期间到达。
      if (this.isSourceDeleted(msg)) {
        await this.deleteMessages(sentMessages);
        return;
      }
      await this.rememberTranslationMessages(msg, sentMessages);
      // 源消息可能恰好在上面的持久化期间被撤回；此时删除刚发送的译文。
      if (this.isSourceDeleted(msg)) {
        await this.deleteMessages(sentMessages);
      }
    } catch (err) {
      if (sentMessages.length > 0 && !this.isSourceDeleted(msg)) {
        try {
          await this.rememberTranslationMessages(msg, sentMessages);
        } catch (linkErr) {
          console.error(`[assist] 保存翻译关联失败: ${linkErr instanceof Error ? linkErr.message : String(linkErr)}`);
        }
      }
      if (sentMessages.length > 0 && this.isSourceDeleted(msg)) {
        await this.deleteMessages(sentMessages);
      }
      console.error(`[assist] 发送翻译回复失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async rememberTranslationMessages(msg: Message, messages: Message[]): Promise<void> {
    const previous = getState().translationLinks[msg.id];
    const link: TranslationLinkState = {
      channelId: msg.channel.id,
      translationMessageIds: [
        ...new Set([...(previous?.translationMessageIds ?? []), ...messages.map((message) => message.id)]),
      ],
      createdAt: previous?.createdAt ?? Date.now(),
    };
    // 先修改内存状态，再等待写盘，让并发到达的删除事件可以立即拿到关联。
    getState().translationLinks[msg.id] = link;
    await saveState();
  }

  // 独立 AI 互译会话的消息处理：按文本频道路由，不依赖语音、不做 TTS
  private async handleTranslateMessage(msg: Message): Promise<void> {
    if (msg.author.id === this.client.user?.id) return;
    if (!msg.inGuild()) return;
    const tSession = getState().translateSessions[msg.channel.id];
    if (!tSession) return;
    // 该频道同时是语音会话的监听频道时，互译已由 handleMessage 处理，避免重复回复
    const voice = this.sessionOf(tSession.guildId);
    if (voice && voice.textChannelId === msg.channel.id) return;
    const content = removeDiscordCustomEmojis(msg.content).trim();
    if (!hasMeaningfulText(content)) return; // 纯 emoji / 纯媒体消息不翻译
    const name = msg.member?.displayName ?? msg.author.displayName;
    this.pendingTranslations.add(msg.id);
    try {
      const r = await this.ai.analyzeAndTranslate(content, name);
      if (getState().translateSessions[msg.channel.id] !== tSession) return;
      const currentVoice = this.sessionOf(tSession.guildId);
      if (currentVoice?.textChannelId === msg.channel.id) return;
      if (r.aiOk) await this.sendTranslationReply(msg, r, content); // AI 未配置/失败不回显原文
    } finally {
      this.pendingTranslations.delete(msg.id);
      this.deletedPendingSources.delete(msg.id);
    }
  }

  // 源消息删除后，Discord 会发送 messageDelete。移除关联并删除机器人发出的全部译文。
  private async handleMessageDelete(msg: Message | PartialMessage): Promise<void> {
    const sourceId = msg.id;
    if (this.pendingTranslations.has(sourceId)) this.deletedPendingSources.add(sourceId);

    const sourceLink = getState().translationLinks[sourceId];
    if (sourceLink) {
      delete getState().translationLinks[sourceId];
      await saveState();
      await this.deleteMessagesByLink(sourceLink);
      return;
    }

    // 如果用户手动删除了译文，清理反向关联，避免 state.json 长期保留无效 ID。
    let changed = false;
    for (const [sourceMessageId, link] of Object.entries(getState().translationLinks)) {
      if (!link.translationMessageIds.includes(sourceId)) continue;
      const remaining = link.translationMessageIds.filter((id) => id !== sourceId);
      if (remaining.length === 0) delete getState().translationLinks[sourceMessageId];
      else link.translationMessageIds = remaining;
      changed = true;
    }
    if (changed) await saveState();
  }

  private async handleMessageDeleteBulk(
    messages: ReadonlyCollection<Snowflake, Message<true> | PartialMessage<true>>,
  ): Promise<void> {
    for (const message of messages.values()) await this.handleMessageDelete(message);
  }

  private isSourceDeleted(msg: Message | PartialMessage): boolean {
    return this.deletedPendingSources.has(msg.id);
  }

  private async deleteMessagesByLink(link: TranslationLinkState): Promise<void> {
    const channel = await this.client.channels.fetch(link.channelId).catch(() => null);
    if (!channel || !channel.isTextBased() || !('messages' in channel)) return;
    await Promise.all(link.translationMessageIds.map(async (messageId) => {
      try {
        const translation = await channel.messages.fetch(messageId);
        await translation.delete();
      } catch (err) {
        // 译文可能已被用户或 Discord 清理，继续处理同一源消息的其他译文。
        console.warn(`[assist] 删除翻译消息 ${messageId} 失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    }));
  }

  private async deleteMessages(messages: Message[]): Promise<void> {
    await Promise.all(messages.map(async (message) => {
      try {
        await message.delete();
      } catch (err) {
        console.warn(`[assist] 删除翻译消息 ${message.id} 失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    }));
  }

  // 本地快速朗读分段：用户名按自身语种读，内容按句切分、句内按假名/汉字判语种
  private buildSpeakSegmentsLocal(name: string, content: string): SpeakSegment[] {
    const cleanName = cleanForSpeech(name) || name;
    const nameLang = detectNameLang(cleanName);
    const nameForSpeech = replaceEmoji(cleanName, nameLang) || cleanName;

    const cleanContent = cleanForSpeech(content).slice(0, MAX_SPEAK_CHARS);
    if (!cleanContent) return [];

    const contentSegments = segmentText(cleanContent)
      .map((s) => ({ text: replaceEmoji(s.text, s.language), language: s.language }))
      .filter((s) => s.text.length > 0);
    if (contentSegments.length === 0) return [];

    // 不播报“说/says”等连接词，只用标点制造发送者和正文之间的短停顿。
    const firstLang = contentSegments[0].language;
    const lead = firstLang === 'ja' ? '、' : '，';
    const attr: SpeakSegment[] = nameLang === firstLang
      ? [{ text: `${nameForSpeech}${lead}`, language: nameLang }]
      : [
          { text: nameForSpeech, language: nameLang },
          { text: lead, language: firstLang },
        ];
    return [...attr, ...contentSegments];
  }

  // 组装朗读分段。用户名使用自身语种，语气词和内容使用消息语种。
  // 内容分段优先使用 AI 的精确分段，其次使用单语整段朗读，最后使用本地按字符粗切。
  private buildSpeakSegments(
    name: string,
    nameLang: Lang | null,
    messageLang: Lang,
    mixed: boolean,
    aiSegments: { text: string; language: Lang }[] | null,
    content: string,
  ): SpeakSegment[] {
    const cleanName = cleanForSpeech(name) || name;
    const nameLangFinal = nameLang ?? detectNameLang(cleanName);
    const nameForSpeech = replaceEmoji(cleanName, nameLangFinal) || cleanName;
    const lead = messageLang === 'ja' ? '、' : '，';
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
      let remaining = MAX_SPEAK_CHARS;
      contentSegments = aiSegments
        .map((s) => {
          const text = replaceEmoji(cleanForSpeech(s.text), s.language).slice(0, remaining);
          remaining -= text.length;
          return { text, language: s.language };
        })
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

  // 单独的日语罗马音消息：保留原始罗马字，但交给日语音色处理。
  private buildJapaneseRomajiSpeakSegments(
    name: string,
    content: string,
    nameLangHint: Lang | null,
  ): SpeakSegment[] {
    const cleanName = cleanForSpeech(name) || name;
    const nameLang = nameLangHint ?? detectNameLang(cleanName);
    const nameForSpeech = replaceEmoji(cleanName, nameLang) || cleanName;
    const cleanContent = cleanForSpeech(content).slice(0, MAX_SPEAK_CHARS);
    if (!cleanContent) return [];

    const attr: SpeakSegment[] = nameLang === 'ja'
      ? [{ text: `${nameForSpeech}、`, language: 'ja' }]
      : [
          { text: nameForSpeech, language: nameLang },
          { text: '、', language: 'ja' },
        ];
    return [...attr, { text: cleanContent, language: 'ja' }];
  }

  // 纯媒体消息的播报：谁发送了什么
  private buildMediaSegments(name: string, media: { zh: string; ja: string }): SpeakSegment[] {
    const cleanName = cleanForSpeech(name) || name;
    const nameLang = detectNameLang(cleanName);
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
