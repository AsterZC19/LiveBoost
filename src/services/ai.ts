import { config } from '../config.js';

export type Lang = 'zh' | 'ja';

// AI 识别+翻译结果：同时给出中文版与日文版，供混排消息的"双语一条回复"使用
export interface TranslateResult {
  language: Lang; // 主要语言（用于 TTS 音色与语气词）
  mixed: boolean; // 是否中日混杂（两种语言都有可观内容）
  zh: string; // 整条消息的完整简体中文版
  ja: string; // 整条消息的完整日文版
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
  '只输出一个 JSON 对象，不要输出其他任何文字：\n' +
  '{"language":"zh 或 ja","mixed":true 或 false,"translation_zh":"完整中文版","translation_ja":"完整日文版"}';

// 消息是否含实质文本（有中文/日文/字母/数字等可读内容）
export function hasMeaningfulText(text: string): boolean {
  return /[぀-ヿ一-鿿A-Za-z0-9]/.test(text);
}

// 无 AI 时的兜底判定：出现假名即视为日文，否则含汉字视为中文
function detectLanguageFallback(text: string): Lang {
  return /[぀-ヿ]/.test(text) ? 'ja' : 'zh';
}

// 本地粗判是否中日混杂（假名与汉字都至少有 2 个）
function isMixedFallback(text: string): boolean {
  const kana = (text.match(/[぀-ヿ]/g) ?? []).length;
  const han = (text.match(/[一-鿿]/g) ?? []).length;
  return kana >= 2 && han >= 2;
}

function fallbackResult(text: string): TranslateResult {
  return { language: detectLanguageFallback(text), mixed: isMixedFallback(text), zh: text, ja: text };
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
    };
    const language: Lang = obj.language === 'ja' || obj.language === 'zh'
      ? obj.language
      : detectLanguageFallback(fallback);
    const zh = typeof obj.translation_zh === 'string' && obj.translation_zh.trim()
      ? obj.translation_zh.trim()
      : fallback;
    const ja = typeof obj.translation_ja === 'string' && obj.translation_ja.trim()
      ? obj.translation_ja.trim()
      : fallback;
    return {
      language,
      mixed: obj.mixed === true || isMixedFallback(`${zh}${ja}`),
      zh,
      ja,
    };
  } catch {
    console.error('[ai] 模型输出不是合法 JSON，使用兜底结果');
    return fallbackResult(fallback);
  }
}

export class AiService {
  // 识别主要语言 + 是否混杂 + 生成中/日两个完整版本。任何失败都不抛错，回退本地判定 + 原文。
  async analyzeAndTranslate(text: string): Promise<TranslateResult> {
    const trimmed = text.trim();
    if (!trimmed) {
      return { language: 'zh', mixed: false, zh: text, ja: text };
    }

    if (!config.aiApiKey) {
      console.warn('[ai] 未配置 AI_API_KEY，跳过 AI 翻译，仅本地判定语言');
      return fallbackResult(trimmed);
    }

    try {
      const res = await fetch(`${config.aiBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.aiApiKey}`,
        },
        body: JSON.stringify({
          model: config.aiModel,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: trimmed },
          ],
        }),
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
