// Copyright (c) 2026 Davide Leopardi
// SPDX-License-Identifier: GPL-3.0-only

import en from './en.json' with { type: 'json' };
import it from './it.json' with { type: 'json' };
import fr from './fr.json' with { type: 'json' };
import de from './de.json' with { type: 'json' };
import es from './es.json' with { type: 'json' };

export const supportedLanguages = Object.freeze(['en', 'it', 'fr', 'de', 'es']);
export const catalogs = Object.freeze({ en, it, fr, de, es });
export function normalizeLanguage(value) {
  const language = String(value || '').toLowerCase().split(/[-_]/)[0];
  return supportedLanguages.includes(language) ? language : 'en';
}
export function resolveLanguage(saved, preferred = []) {
  if (supportedLanguages.includes(saved)) return saved;
  for (const value of preferred) {
    const candidate = String(value || '').toLowerCase().split(/[-_]/)[0];
    if (supportedLanguages.includes(candidate)) return candidate;
  }
  return 'en';
}
const placeholders = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g;
export function interpolate(message, params = {}) {
  return message.replace(placeholders, (token, name) =>
    Object.hasOwn(params, name) ? String(params[name]) : token);
}
// Older clients and vendor-independent error strings may arrive already interpolated.
// Match only a catalogued template; never transform SQL, identifiers, or data values.
const templates = Object.keys(it).filter(key => /\{[a-zA-Z]/.test(key)).map(key => {
  const names = [];
  let previous = 0, pattern = '^';
  for (const match of key.matchAll(placeholders)) {
    pattern += key.slice(previous, match.index).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    names.push(match[1]);
    pattern += ['count', 'latency'].includes(match[1]) ? '([0-9][0-9\\s\\u00a0\\u202f.,+-]*)' : '(.+?)';
    previous = match.index + match[0].length;
  }
  pattern += key.slice(previous).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$';
  return { key, names, pattern: new RegExp(pattern, 's') };
}).sort((left, right) => right.key.replace(placeholders, '').length - left.key.replace(placeholders, '').length);
export function translateForLanguage(language, key, params = {}) {
  const catalog = catalogs[normalizeLanguage(language)];
  const message = (messageKey, values) => {
    const count = Number(values.count);
    const variant = Object.hasOwn(values, 'count') && Number.isFinite(count) &&
      new Intl.PluralRules(normalizeLanguage(language)).select(count) === 'one' &&
      Object.hasOwn(catalog, messageKey + '.one') ? messageKey + '.one' : messageKey;
    return interpolate(catalog[variant] ?? en[variant], values);
  };
  if (Object.hasOwn(en, key)) return message(key, params);
  for (const template of templates) {
    const match = template.pattern.exec(key);
    if (match) return message(template.key,
      Object.fromEntries(template.names.map((name, index) => [name, match[index + 1]])));
  }
  return key;
}
