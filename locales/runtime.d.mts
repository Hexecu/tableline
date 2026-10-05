// Copyright (c) 2026 Davide Leopardi
// SPDX-License-Identifier: GPL-3.0-only

export type Language = 'en' | 'it' | 'fr' | 'de' | 'es';
export const supportedLanguages: readonly Language[];
export const catalogs: Readonly<Record<Language, Record<string, string>>>;
export function normalizeLanguage(value: unknown): Language;
export function interpolate(message: string, params?: Record<string, string | number>): string;
export function translateForLanguage(language: unknown, key: string, params?: Record<string, string | number>, formatMessage?: (value: string) => string): string;
export function resolveLanguage(saved: unknown, preferred?: readonly string[]): Language;
