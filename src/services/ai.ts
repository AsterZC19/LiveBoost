import { config } from '../config.js';

export type Lang = 'zh' | 'ja';

// AI 识别+翻译结果：同时给出中文版与日文版
export interface TranslateResult {
  language: Lang; // 主要语言（用于 TTS 音色与语气词）
  mixed: boolean; // 是否中日混杂（两种语言都有可观内容）
  zh: string; // 整条消息的完整简体中文版
  ja: string; // 整条消息的完整日文版
  // 混排时对"原始输入"的语言分段（供 TTS 按段切换音色，能正确处理日文里的汉字）；
  // 单语消息或 AI 未给出时为 null
  segments: { text: string; language: Lang }[] | null;
  // 发消息者名字更可能是哪种语言（AI 判断，用于 TTS 播报名字时的音色）；AI 未给出时为 null
  nameLang: Lang | null;
  // AI 是否真正参与了判断（未配置 key / 调用失败 / 输出非法时为 false）。
  // 调用方据此回退本地按句切分朗读，并跳过翻译回复（否则会把原文原样回显）。
  aiOk: boolean;
}

const SYSTEM_PROMPT =
  '你是一个中日双语聊天助手的翻译模块。用户会发来一条聊天消息，可能是简体中文、日文或中日混杂。你的任务：\n' +
  '1. 判断主要语言（language）：统计汉字与日文假名（平假名/片假名）的数量，多者为主要语言；两者都没有时默认中文。\n' +
  '2. 判断是否混杂（mixed）：消息同时含有可观的汉字和假名（两种都不是零星一两个）时为 true，否则 false。\n' +
  '3. 输出两个完整版本，各自都是"整条消息"的完整表达，让只懂其中一种语言的人也能看懂全部内容：\n' +
  '   - translation_zh：把整条消息完整改写为简体中文（原文已是中文的部分保持不变，日文部分译成中文）。\n' +
  '   - translation_ja：把整条消息完整改写为日文（原文已是日文的部分保持不变，中文部分译成日文）。\n' +
  '   保持自然、口语化；专有名词、数字、表情、网络用语保留原样；不要写错字。\n' +
  '4. 如果消息没有实质内容（只有表情、符号、链接、纯感叹词等），translation_zh 和 translation_ja 都原样返回输入，mixed 为 false。\n' +
  '5. 仅当 mixed 为 true 时，额外返回 segments：把"原始输入"切分成语言片段，每项 {"text":"原文片段","language":"zh 或 ja"}。\n' +
  '   日文句子里的汉字（如「元気」「今日」）归入日文片段，中文汉字归入中文片段；纯标点/表情忽略或并入相邻片段；片段按原文顺序排列。\n' +
  '   mixed 为 false 时 segments 省略或返回空数组。\n' +
  '6. 如果系统提示要求判断发消息者名字的语言，请在输出中额外给出 "name_lang":"zh 或 ja"，否则省略该字段。\n' +
  '只输出一个 JSON 对象，不要输出其他任何文字：\n' +
  '{"language":"zh 或 ja","mixed":true 或 false,"translation_zh":"完整中文版","translation_ja":"完整日文版","segments":[{"text":"原文片段","language":"zh"}],"name_lang":"zh 或 ja"}';

// 消息是否含实质文本（有中文汉字 / 日文假名字母 / 英文数字等可读内容）
// 注意：只用"假名字母"（ぁ-ゖ ァ-ヺ），排除 ・ーヽヾ 等标点类，避免颜文字里的「・」误判为日文
export function hasMeaningfulText(text: string): boolean {
  return /[一-鿿ぁ-ゖァ-ヺA-Za-z0-9]/.test(text);
}

// 文本自身的语种：含日文假名字母视为日文，否则视为中文（用于用户名等独立片段）
export function detectTextLang(text: string): Lang {
  return /[ぁ-ゖァ-ヺ]/.test(text) ? 'ja' : 'zh';
}

// 无 AI 时的兜底结果：不翻译（zh/ja 均为原文）、不标混杂、无分段、名字语言交给调用方本地判定
function fallbackResult(text: string): TranslateResult {
  return {
    language: detectTextLang(text),
    mixed: false,
    zh: text,
    ja: text,
    segments: null,
    nameLang: null,
    aiOk: false,
  };
}

// 从模型输出里提取 JSON（容忍 ```json ... ``` 代码块包裹），任何字段缺失都回退
function parseAiJson(content: string, fallback: string): TranslateResult {
  const trimmed = content.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    const obj = JSON.parse(trimmed) as {
      language?: string;
      mixed?: boolean;
      translation_zh?: string;
      translation_ja?: string;
      segments?: { text?: unknown; language?: unknown }[];
      name_lang?: string;
    };
    const language: Lang = obj.language === 'ja' || obj.language === 'zh'
      ? obj.language
      : detectTextLang(fallback);
    const zh = typeof obj.translation_zh === 'string' && obj.translation_zh.trim()
      ? obj.translation_zh.trim()
      : fallback;
    const ja = typeof obj.translation_ja === 'string' && obj.translation_ja.trim()
      ? obj.translation_ja.trim()
      : fallback;

    // 混排分段的原文片段（仅采纳合法项；缺失则回退为 null，由调用方本地切分兜底）
    let segments: TranslateResult['segments'] = null;
    if (Array.isArray(obj.segments) && obj.segments.length > 0) {
      const segs = obj.segments
        .map((s) => ({
          text: typeof s?.text === 'string' ? s.text.trim() : '',
          language: s?.language === 'ja' ? 'ja' : s?.language === 'zh' ? 'zh' : null,
        }))
        .filter((s): s is { text: string; language: Lang } => s.text.length > 0 && s.language !== null);
      if (segs.length > 0) segments = segs;
    }

    const nameLang: Lang | null = obj.name_lang === 'ja' ? 'ja' : obj.name_lang === 'zh' ? 'zh' : null;

    return { language, mixed: obj.mixed === true, zh, ja, segments, nameLang, aiOk: true };
  } catch {
    console.error('[ai] 模型输出不是合法 JSON，使用兜底结果');
    return fallbackResult(fallback);
  }
}

export class AiService {
  // 识别主要语言 + 是否混杂 + 生成中/日两个完整版本 + 判断发消息者名字的语言。
  // 任何失败都不抛错，回退本地判定 + 原文。
  async analyzeAndTranslate(text: string, speakerName?: string): Promise<TranslateResult> {
    const trimmed = text.trim();
    if (!trimmed) {
      return { language: 'zh', mixed: false, zh: text, ja: text, segments: null, nameLang: null, aiOk: false };
    }

    if (!config.aiApiKey) {
      console.warn('[ai] 未配置 AI_API_KEY，跳过 AI 翻译，仅本地判定语言');
      return fallbackResult(trimmed);
    }

    // 提供名字时，让 AI 顺带判断它更像中文名还是日文名（纯汉字名无法靠字符判断）
    const nameInstruction = speakerName
      ? `\n\n另外：本次发消息者的名字是「${speakerName}」。请判断它更可能是中文名还是日文名：` +
        '含假名的名字按日文；纯汉字名根据常见性判断（如「山田」「佐藤」→ja，「小明」「张伟」→zh）。' +
        '在输出中额外给出 "name_lang":"zh 或 ja"。名字只用于判断 name_lang，不要影响上面的翻译。'
      : '';

    try {
      const body: Record<string, unknown> = {
        model: config.aiModel,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT + nameInstruction },
          { role: 'user', content: trimmed },
        ],
      };
      // 关闭思考模式（默认 none 最快）；留空则不传该参数
      if (config.aiReasoningEffort) {
        body.reasoning_effort = config.aiReasoningEffort;
      }
      const res = await fetch(`${config.aiBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.aiApiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.error(`[ai] HTTP ${res.status}: ${body.slice(0, 200)}`);
        throw new Error(`AI API HTTP ${res.status}`);
      }

      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const content = data.choices?.[0]?.message?.content ?? '';
      return parseAiJson(content, trimmed);
    } catch (err) {
      console.error(`[ai] 调用失败，回退本地判定: ${err instanceof Error ? err.message : String(err)}`);
      return fallbackResult(trimmed);
    }
  }
}
