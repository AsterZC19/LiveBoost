import { AsyncLocalStorage } from 'node:async_hooks';
import { ja } from './locales/ja.js';

export type Locale = 'ja' | 'zh-cn';
export type MessageKey = keyof typeof ja;
export const DEFAULT_LOCALE: Locale = 'zh-cn';
const context = new AsyncLocalStorage<Locale>();

export function isLocale(value: unknown): value is Locale {
  return value === 'ja' || value === 'zh-cn';
}

export function currentLocale(): Locale {
  return context.getStore() ?? DEFAULT_LOCALE;
}

// Async context is scoped to one interaction; parallel guilds cannot change each other's language.
export function withLocale<T>(locale: Locale, work: () => T): T {
  return context.run(locale, work);
}

export function translate(key: MessageKey, values: readonly unknown[] = [], locale = currentLocale()): string {
  const template = locale === 'ja' ? ja[key] : key;
  if (values.length === 0) return template;
  // Substitute once: player names and other user data are never translated or re-interpolated.
  return template.replace(/\{(\d+)\}/g, (match, index: string) =>
    Number(index) < values.length ? String(values[Number(index)]) : match,
  );
}
export const t = translate;
type Translator = (key: MessageKey, values?: readonly unknown[]) => string;
const translators: Record<Locale, Translator> = {
  ja: (key, values) => translate(key, values, 'ja'),
  'zh-cn': (key, values) => translate(key, values, 'zh-cn'),
};

export function translator(locale: Locale): Translator {
  return translators[locale];
}
