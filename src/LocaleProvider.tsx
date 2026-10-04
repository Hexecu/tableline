// Copyright (c) 2026 Davide Leopardi
// SPDX-License-Identifier: GPL-3.0-only

import { createContext, useContext, useEffect, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { getLanguage, setLanguage, subscribeLanguage, translate } from './i18n';
import type { Language } from './i18n';
type LocaleContext = { language: Language; setLanguage: typeof setLanguage; t: typeof translate };
const I18nContext = createContext<LocaleContext | null>(null);
export function I18nProvider({ children }: { children: ReactNode }) {
  const language = useSyncExternalStore(subscribeLanguage, getLanguage, () => 'en' as Language);
  useEffect(() => {
    document.documentElement.lang = language;
    window.tableline?.call("runtime.setLanguage", language).catch(() => {});
  }, [language]);
  return <I18nContext.Provider value={{ language, setLanguage, t: translate }}>{children}</I18nContext.Provider>;
}
export function useI18n(): LocaleContext {
  const context = useContext(I18nContext);
  if (!context) throw new Error('I18nProvider is required.');
  return context;
}
