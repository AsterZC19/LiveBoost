import { config } from '../config.js';

export type Lang = 'zh' | 'ja';

export interface TranslateResult {
  language: Lang; // 输入的主要语言（用于选 TTS 音色）
  translated: string; // 翻译成另一种语言后的文本
}

const SYSTEM_PROMPT =
  '你是一个中日双语聊天助手的翻译模块。用户会发来一条聊天消息，可能包含简体中文、日文或混合内容。你的任务：\n' +
  '1. 判断这条消息的主要语言是简体中文还是日文。\n' +
  '2. 把它翻译成另一种语言（中文→日文，日文→中文），保持自然、口语化，专有名词与网络用语酌情处理。\n' +
  '3. 如果消息没有实质内容（只有表情、符号、链接、纯感叹词等），translated 原样返回输入。\n' +
  '只输出一个 JSON 对象，不要输出其他任何文字：\n' +
  '{"language":"zh 或 ja（输入的主要语言）","translated":"翻译后的文本"}';

// 消息是否含实质文本（有中文/日文/字母/数字等可读内容）
export function hasMeaningfulText(text: string): boolean {
  return /[぀-ヿ一-鿿A-Za-z0-9]/.test(text);
}

// 无 AI 时的兜底判定：出现假名即视为日文，否则含汉字视为中文
function detectLanguageFallback(text: string): Lang {
  return /[぀-ヿ]/.test(text) ? 'ja' : 'zh';
}

// 从模型输出里提取 JSON（容忍 ```json ... ``` 代码块包裹）
function parseAiJson(content: string, fallback: string): TranslateResult {
  const trimmed = content.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    const obj = JSON.parse(trimmed) as { language?: string; translated?: string };
    const language: Lang = obj.language === 'ja' || obj.language === 'zh' ? obj.language : detectLanguageFallback(fallback);
    const translated = typeof obj.translated === 'string' ? obj.translated.trim() : fallback;
    return { language, translated };
  } catch {
    console.error('[ai] 模型输出不是合法 JSON，使用兜底结果');
    return { language: detectLanguageFallback(fallback), translated: fallback };
  }
}

export class AiService {
  // 识别主要语言并翻译成另一种语言（中文↔日文）。任何失败都不抛错，回退为本地判定 + 原文。
  async analyzeAndTranslate(text: string): Promise<TranslateResult> {
    const trimmed = text.trim();
    if (!trimmed) {
      return { language: 'zh', translated: text };
    }

    if (!config.aiApiKey) {
      console.warn('[ai] 未配置 AI_API_KEY，跳过 AI 翻译，仅本地判定语言');
      return { language: detectLanguageFallback(trimmed), translated: trimmed };
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
      return { language: detectLanguageFallback(trimmed), translated: trimmed };
    }
  }
}
