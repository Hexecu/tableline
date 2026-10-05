// Copyright (c) 2026 Davide Leopardi
// SPDX-License-Identifier: GPL-3.0-only

export function rendererPlatform(value?: string): 'darwin' | 'win32' | 'linux';
export function shortcutLabel(text: string, platform?: string): string;
