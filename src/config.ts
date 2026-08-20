import 'dotenv/config';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 项目根目录
export const ROOT_DIR = path.resolve(__dirname, '..');

// 项目版本号从 package.json 读取，供请求头等处使用，并随版本升级自动更新。
let VERSION = '0.0.0';
try {
  VERSION = JSON.parse(readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8')).version as string;
} catch {
  console.warn('[config] 读取 package.json 版本号失败，回退 0.0.0');
}
export { VERSION };

// Noto Sans SC 字体文件
export const FONT_FAMILY = 'Noto Sans SC';
export const FONT_REGULAR = path.join(ROOT_DIR, 'assets', 'fonts', 'NotoSansSC-Regular.otf');
export const FONT_MEDIUM = path.join(ROOT_DIR, 'assets', 'fonts', 'NotoSansSC-Medium.otf');
export const FONT_BOLD = path.join(ROOT_DIR, 'assets', 'fonts', 'NotoSansSC-Bold.otf');

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[config] 缺少必填环境变量 ${name}，请检查 .env 文件`);
    process.exit(1);
  }
  return value;
}

function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// 本功能使用可选字符串配置。缺失时返回空串并提示，不退出进程，也不影响原有推送。
function optionalString(name: string): string {
  const value = process.env[name] ?? '';
  if (!value) {
    console.warn(`[config] 未配置 ${name}，语音 TTS / AI 翻译功能将不可用`);
  }
  return value;
}

export const config = {
  // Discord 机器人令牌。此项为必填配置。
  token: required('DISCORD_TOKEN'),
  // 命令注册目标服务器。留空则全局注册。
  guildId: process.env.GUILD_ID || '',
  // 无活动时的检测间隔，单位为分钟。
  checkIntervalMinutes: optionalInt('CHECK_INTERVAL_MINUTES', 2),
  // 是否启用时速推送
  hourlyPushEnabled: (process.env.HOURLY_PUSH_ENABLED ?? 'true').toLowerCase() !== 'false',
  // Bestdori 服务器标识
  server: process.env.BESTDORI_SERVER || 'jp',
  // 时间显示时区
  timezone: process.env.TIMEZONE || 'Asia/Tokyo',
  // /push 命令是否仅管理员可用
  requireAdmin: (process.env.REQUIRE_ADMIN ?? 'true').toLowerCase() !== 'false',
  // state.json 路径。默认写入项目根目录，Docker 部署时可外置到卷挂载目录。
  stateFile: process.env.STATE_FILE || path.join(ROOT_DIR, 'state.json'),

  // ===== Health HTTP 端口 =====
  // 健康检查端口。未配置时不启动。
  healthPort: optionalInt('HEALTH_PORT', 0),
  // 默认只监听本机，避免暴露到公网。
  healthBind: process.env.HEALTH_BIND || '127.0.0.1',
  // 访问 /health 所需的 Bearer Token。为空时不鉴权。
  healthToken: process.env.HEALTH_TOKEN || '',
  // TLS 证书和私钥路径。两项都配置后，health 端口使用 HTTPS。
  healthTlsCert: process.env.HEALTH_TLS_CERT || '',
  healthTlsKey: process.env.HEALTH_TLS_KEY || '',

  // ===== 语音 TTS + AI 互译 =====
  // bot 作者的 Discord 用户 ID。只有该用户可以操作 /lb 开关。
  botOwnerId: optionalString('BOT_OWNER_ID'),
  // OpenAI 兼容接口。默认使用 DeepSeek，也支持第三方中转站。
  // 接口地址可以带末尾斜杠，也可以直接填写完整的 chat/completions 地址。
  aiBaseUrl: (process.env.AI_BASE_URL || 'https://api.deepseek.com/v1')
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/, ''),
  aiApiKey: optionalString('AI_API_KEY'),
  aiModel: process.env.AI_MODEL || 'deepseek-chat',
  // AI 推理力度：none 关闭思考；low/medium/high 逐级。默认留空则不传该参数，
  // 避免 OpenAI/Moonshot 等不认 reasoning_effort 的兼容服务收到未知参数被 400 拒绝
  aiReasoningEffort: process.env.AI_REASONING_EFFORT ?? '',
  // 中日 TTS 音色
  ttsVoiceZh: process.env.TTS_VOICE_ZH || 'zh-CN-XiaoxiaoNeural',
  ttsVoiceJa: process.env.TTS_VOICE_JA || 'ja-JP-NanamiNeural',
  // TTS 语速使用 SSML rate 格式。+25% 表示加快 25%。
  // 中文和日文可以分别设置。未设置时回退到旧的 TTS_RATE。
  ttsRateZh: process.env.TTS_RATE_ZH || process.env.TTS_RATE || '+25%',
  ttsRateJa: process.env.TTS_RATE_JA || process.env.TTS_RATE || '+25%',
  // 最多同时并行服务的服务器数。超过限制后拒绝新的服务器加入。
  maxVoiceGuilds: optionalInt('MAX_VOICE_GUILDS', 3),
  // 最多同时并行服务的独立 AI 互译文本频道数。超过限制后拒绝新的绑定。
  maxTranslateChannels: optionalInt('MAX_TRANSLATE_CHANNELS', 10),
};
