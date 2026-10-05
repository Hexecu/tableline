// Copyright (c) 2026 Davide Leopardi
// SPDX-License-Identifier: GPL-3.0-only

export function rendererPlatform(value = typeof navigator === 'undefined' ? '' : navigator.platform) {
  if (/Mac/i.test(value)) return 'darwin';
  if (/Win/i.test(value)) return 'win32';
  return 'linux';
}

export function shortcutLabel(text, platform = rendererPlatform()) {
  return String(text).replaceAll('⌘', platform === 'darwin' ? '⌘' : 'Ctrl');
}
