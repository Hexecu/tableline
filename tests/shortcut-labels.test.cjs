// Copyright (c) 2026 Davide Leopardi
// SPDX-License-Identifier: GPL-3.0-only

const test = require('node:test');
const assert = require('node:assert/strict');

test('Keyboard hints use the native modifier on both Mac CPUs and Windows/Linux', async () => {
  const { rendererPlatform, shortcutLabel } = await import('../locales/platform.mjs');
  for (const platform of ['MacIntel', 'MacARM']) {
    assert.equal(shortcutLabel('⌘ K', rendererPlatform(platform)), '⌘ K');
  }
  for (const platform of ['Win32', 'Win64', 'Linux x86_64', 'Linux aarch64']) {
    assert.equal(shortcutLabel('⌘ K', rendererPlatform(platform)), 'Ctrl K');
  }
});

test('Platform hints change translated instructions while preserving data and SQL', async () => {
  const { translateForLanguage, supportedLanguages } = await import('../locales/runtime.mjs');
  const { shortcutLabel } = await import('../locales/platform.mjs');
  const windowsHint = value => shortcutLabel(value, 'win32');
  for (const language of supportedLanguages) {
    assert.match(translateForLanguage(language, 'Scrivi SQL e premi ⌘ Invio.', {}, windowsHint), /Ctrl/);
    const value = 'SELECT "⌘ K" FROM "⌘ T"';
    assert.equal(translateForLanguage(language, value, {}, windowsHint), value);
    assert.ok(translateForLanguage(language, 'Copia {name}', { name: value }, windowsHint).includes(value));
  }
});
