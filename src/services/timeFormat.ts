import { config } from '../config.js';
import { currentLocale } from '../i18n.js';

// Reuse Intl formatters across replies, notifications and image footers.
// The timezone is deployment configuration; retaining it in the key also handles config changes.
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeOnly: boolean): Intl.DateTimeFormat {
  const locale = timeOnly || currentLocale() === 'zh-cn' ? 'zh-CN' : 'ja-JP';
  const key = `${config.timezone}:${locale}:${timeOnly}`;
  let result = formatters.get(key);
  if (!result) {
    result = new Intl.DateTimeFormat(locale, {
      timeZone: config.timezone,
      ...(timeOnly ? {} : { year: 'numeric', month: '2-digit', day: '2-digit', second: '2-digit' }),
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    formatters.set(key, result);
  }
  return result;
}

export function formatTime(ms: number | null | undefined): string {
  if (!ms) return '--';
  return formatter(false).format(ms).replace(/\//g, '-');
}

export function formatTimePoint(ms: number): string {
  return formatter(true).format(ms);
}
