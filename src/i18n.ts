// Copyright (c) 2026 Davide Leopardi
// SPDX-License-Identifier: GPL-3.0-only

import { normalizeLanguage, resolveLanguage, supportedLanguages, translateForLanguage } from '../locales/runtime.mjs';
import type { Language } from '../locales/runtime.mjs';
export type { Language };
export { supportedLanguages };
export const LANGUAGE_STORAGE_KEY = 'tableline.language';
export const languageNames: Record<Language, string> = {
  en: 'English', it: 'Italiano', fr: 'Français', de: 'Deutsch', es: 'Español',
};
function initialLanguage(): Language {
  let saved: string | null = null;
  try { saved = localStorage.getItem(LANGUAGE_STORAGE_KEY); } catch { /* Session-only preference. */ }
  return resolveLanguage(saved, typeof navigator === 'undefined' ? [] : navigator.languages || [navigator.language]);
}
let language = initialLanguage();
const listeners = new Set<() => void>();
export function getLanguage(): Language { return language; }
export function setLanguage(value: Language): void {
  const next = normalizeLanguage(value);
  try { localStorage.setItem(LANGUAGE_STORAGE_KEY, next); } catch { /* Session-only preference. */ }
  if (next === language) return;
  language = next;
  if (typeof document !== 'undefined') document.documentElement.lang = next;
  for (const listener of listeners) listener();
}
export function subscribeLanguage(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function translate(key: string, params?: Record<string, string | number>): string {
  return translateForLanguage(language, key, params);
}
export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(language, options).format(value);
}
export function formatDate(value: number | Date, options?: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(language, options).format(value);
}
