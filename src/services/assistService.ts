import type { Client, Message, VoiceState } from 'discord.js';
import { config } from '../config.js';
import { getState, saveState } from './state.js';
import type { VoiceSessionState } from '../types.js';
import { hasMeaningfulText, detectTextLang, type AiService, type Lang, type TranslateResult } from './ai.js';
import { containsEmojiName, replaceEmoji } from './emoji.js';
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
  /[一-鿿ぁ-ゖァ-ヺーA-Za-z0-9、。「」『』《》，！？：；‘’“”…·･.,;:!?'"()\-\s\p{Emoji_Presentation}\p{Extended_Pictographic}]/u;

// 把一段文本清理成适合朗读的形式，保留文字、标点、emoji 和换行，去掉符号类字符。
// 只折叠空格和制表符，保留换行，避免多行内容被合并后影响按句切分。
function cleanForSpeech(text: string): string {
  return Array.from(text)
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
    this.client.on('messageCreate', (msg) => void this.handleMessage(msg));
    this.client.on('messageCreate', (msg) => void this.handleTranslateMessage(msg));
    this.client.on('voiceStateUpdate', (oldState, newState) => void this.handleVoiceStateChange(oldState, newState));
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
    // 最大并行服务器数限制。已绑定的服务器重复 join 或更换频道不计为新增。
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
    void this.refreshDescription();
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
    void this.refreshDescription();
  }

  // 离开所有语音频道并清空持久化会话。
  async clearAllSessions(): Promise<void> {
    for (const guildId of Object.keys(getState().voiceSessions)) {
      await this.clearSession(guildId);
    }
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

  // 当前已绑定独立 AI 互译的文本频道数
  translateChannelCount(): number {
    return Object.keys(getState().translateSessions).length;
  }

  // 绑定一个文本频道进行独立 AI 互译，不依赖语音，所有成员均可使用。
  async bindTranslate(guildId: string, textChannelId: string): Promise<void> {
    const sessions = getState().translateSessions;
    if (!sessions[textChannelId] && Object.keys(sessions).length >= config.maxTranslateChannels) {
      throw new Error(`最多同时 ${config.maxTranslateChannels} 个文本频道独立互译，已达到上限`);
    }
    // 防止与语音会话绑定的监听频道重叠，否则一条消息会触发两次翻译回复
    const voice = this.sessionOf(guildId);
    if (voice && voice.textChannelId === textChannelId) {
      throw new Error('该频道已是语音会话的监听频道（已含互译），无需重复绑定');
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
    return `⚡ Voice ${voice} ｜ Trans ${translate}`;
  }

  // 从描述里剥离上一次写入的动态行，保留用户自己填写的固定内容。
  private stripStatusLine(desc: string): string {
    return desc
      .replace(/\n\n⚡ Voice \d+ ｜ Trans \d+$/, '')
      .replace(/^⚡ Voice \d+ ｜ Trans \d+\n\n/, '')
      .trim();
  }

  // 更新 bot 描述里的实时连接数。每次先读后台当前描述，剥离旧动态行后再追加，
  // 避免覆盖用户在 Discord 后台手动填写的自我介绍内容。动态行放在最前面，保证可见。
  private async refreshDescription(): Promise<void> {
    const app = this.client.application;
    if (!app) {
      console.warn('[assist] client.application 为 null，跳过 bot 描述刷新');
      return;
    }
    const fetched = await app.fetch().catch((err) => {
      console.warn(`[assist] 读取当前 bot 描述失败: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });
    const current = fetched?.description ?? app.description ?? '';
    const base = this.stripStatusLine(current);
    const dyn = this.buildStatusLine(this.activeCount(), this.translateChannelCount());
    // 动态行优先占位，剩余长度给用户内容；总长不超过 400
    const maxBase = Math.max(0, 400 - dyn.length - (base ? 2 : 0));
    const full = [dyn, base.slice(0, maxBase)].filter(Boolean).join('\n\n');
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
    // 名字与进出语拆成两段并使用对应音色，进出语固定使用日文。
    const name = member.displayName;
    const r = await this.ai.analyzeAndTranslate(name, name);
    const cleanName = cleanForSpeech(name) || name;
    const nameLang = r.nameLang ?? detectNameLang(cleanName);
    const nameForSpeech = replaceEmoji(cleanName, nameLang) || cleanName;
    const suffix = joined ? 'さんが入室しました' : 'さんが退室しました';
    this.voiceOf(guild.id).enqueue({
      segments: [
        { text: nameForSpeech, language: nameLang },
        { text: suffix, language: 'ja' },
      ],
    });
  }

  private async handleMessage(msg: Message): Promise<void> {
    // 按服务器路由到对应会话，只跳过机器人自己的消息，其他 bot 的消息也可以朗读和翻译。
    if (msg.author.id === this.client.user?.id) return;
    if (!msg.inGuild()) return;
    const guildId = msg.guildId;
    const session = this.sessionOf(guildId);
    if (!session) return;
    if (msg.channel.id !== session.textChannelId) return;

    const voice = this.voiceOf(guildId);
    // 先把用户艾特还原成显示名，再交给 AI 和 TTS，避免朗读出用户 ID。
    const content = resolveUserMentions(msg, msg.content).trim();
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
    const r = await this.ai.analyzeAndTranslate(content, name);
    // AI 可选地为 TTS 补充明确的英文词间空格；缺失或 AI 失败时使用原文。
    const speechContent = r.aiOk && r.speechText ? r.speechText : content;
    const speechAiSegments = r.segments
      ? applySpeechSpacingToSegments(speechContent, r.segments)
      : null;
    if (session.speakEnabled) {
      // AI 成功时用精确分段朗读；AI 失败/未配置时回退本地按句分段，混杂消息也能分语种读
      let speakSegments: SpeakSegment[];
      if (isStandaloneDigits(content)) {
        // 数字串不按中文数字整体读，使用日语音色逐位读出（例如 00999）。
        speakSegments = this.buildSpeakSegments(
          name,
          r.nameLang,
          'ja',
          false,
          null,
          formatDigitsForJapaneseSpeech(content),
        );
        if (media) speakSegments.push(...this.buildMediaNote('ja', media));
      } else if (isJapaneseRomajiHint(content)) {
        // 常见日语罗马音（例如 kanade）使用日语音色，不按英文单词朗读。
        speakSegments = this.buildJapaneseRomajiSpeakSegments(name, speechContent, r.nameLang);
        if (media) speakSegments.push(...this.buildMediaNote('ja', media));
      } else if (r.aiOk) {
        speakSegments = this.buildSpeakSegments(
          name,
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
      await this.sendTranslationReply(msg, r);
    }
  }

  // AI 互译回复由语音会话和独立互译会话共用，将翻译结果格式化为回复文本并发送。
  private async sendTranslationReply(msg: Message, r: TranslateResult): Promise<void> {
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

  // 独立 AI 互译会话的消息处理：按文本频道路由，不依赖语音、不做 TTS
  private async handleTranslateMessage(msg: Message): Promise<void> {
    if (msg.author.id === this.client.user?.id) return;
    if (!msg.inGuild()) return;
    const tSession = getState().translateSessions[msg.channel.id];
    if (!tSession) return;
    // 该频道同时是语音会话的监听频道时，互译已由 handleMessage 处理，避免重复回复
    const voice = this.sessionOf(tSession.guildId);
    if (voice && voice.textChannelId === msg.channel.id) return;
    const content = msg.content.trim();
    if (!hasMeaningfulText(content)) return; // 纯 emoji / 纯媒体消息不翻译
    const name = msg.member?.displayName ?? msg.author.displayName;
    const r = await this.ai.analyzeAndTranslate(content, name);
    if (r.aiOk) await this.sendTranslationReply(msg, r); // AI 未配置/失败不回显原文
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
