import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 项目根目录
export const ROOT_DIR = path.resolve(__dirname, '..');

// Noto Sans SC 字体文件，三个字重
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

export const config = {
  // Discord 机器人令牌（必填）
  token: required('DISCORD_TOKEN'),
  // 命令注册目标服务器；留空则全局注册
  guildId: process.env.GUILD_ID || '',
  // 无活动时的检测间隔（分钟）
  checkIntervalMinutes: optionalInt('CHECK_INTERVAL_MINUTES', 2),
  // 是否启用时速推送
  hourlyPushEnabled: (process.env.HOURLY_PUSH_ENABLED ?? 'true').toLowerCase() !== 'false',
  // Bestdori 服务器标识
  server: process.env.BESTDORI_SERVER || 'jp',
  // 时间显示时区
  timezone: process.env.TIMEZONE || 'Asia/Tokyo',
  // /push 命令是否仅管理员可用
  requireAdmin: (process.env.REQUIRE_ADMIN ?? 'true').toLowerCase() !== 'false',
};
