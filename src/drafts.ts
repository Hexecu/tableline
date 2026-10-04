// Copyright (c) 2026 Davide Leopardi
// SPDX-License-Identifier: GPL-3.0-only

export type DraftTab = { id: string; name: string; sql: string };
export type Draft = {
  connectionId: string;
  tabs: DraftTab[];
  activeTab: string;
};

export const DRAFT_KEY = "tableline.drafts.v1";
export const MAX_DRAFT_TABS = 16;
const MAX_CONNECTIONS = 16;
const MAX_SQL = 256_000;
const MAX_BYTES = 2 * 1024 * 1024;
const identifier = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const byteLength = (value: string) => new TextEncoder().encode(value).length;

function validated(value: unknown): Draft | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    !identifier(raw.connectionId) ||
    !Array.isArray(raw.tabs) ||
    !raw.tabs.length ||
    raw.tabs.length > MAX_DRAFT_TABS
  )
    return null;
  const tabs: DraftTab[] = [];
  const seen = new Set<string>();
  for (const item of raw.tabs) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const tab = item as Record<string, unknown>;
    if (
      !identifier(tab.id) ||
      seen.has(tab.id) ||
      typeof tab.name !== "string" ||
      tab.name.length > 160 ||
      /[\u0000-\u001f]/.test(tab.name) ||
      typeof tab.sql !== "string" ||
      tab.sql.length > MAX_SQL ||
      tab.sql.includes("\0")
    )
      return null;
    seen.add(tab.id);
    tabs.push({ id: tab.id, name: tab.name, sql: tab.sql });
  }
  return {
    connectionId: raw.connectionId,
    tabs,
    activeTab:
      typeof raw.activeTab === "string" && seen.has(raw.activeTab)
        ? raw.activeTab
        : tabs[0].id,
  };
}

function archive(storage: Storage): Draft[] {
  try {
    const text = storage.getItem(DRAFT_KEY);
    if (!text || text.length > MAX_BYTES || byteLength(text) > MAX_BYTES)
      return [];
    const value = JSON.parse(text);
    if (value?.version !== 1 || !Array.isArray(value.connections)) return [];
    const drafts: Draft[] = [];
    const seen = new Set<string>();
    for (const item of value.connections.slice(0, MAX_CONNECTIONS)) {
      const draft = validated(item);
      if (draft && !seen.has(draft.connectionId)) {
        drafts.push(draft);
        seen.add(draft.connectionId);
      }
    }
    return drafts;
  } catch {
    return [];
  }
}

export function loadDraft(
  storage: Storage,
  connectionId: string,
): Draft | null {
  return (
    archive(storage).find((draft) => draft.connectionId === connectionId) ||
    null
  );
}

export function saveDraft(
  storage: Storage,
  input: Draft,
  onEviction?: () => void,
): boolean {
  const draft = validated(input);
  if (!draft) return false;
  try {
    const candidates = [
      draft,
      ...archive(storage).filter(
        (item) => item.connectionId !== draft.connectionId,
      ),
    ];
    const drafts = candidates.slice(0, MAX_CONNECTIONS);
    let text = JSON.stringify({ version: 1, connections: drafts });
    while (byteLength(text) > MAX_BYTES && drafts.length > 1) {
      drafts.pop();
      text = JSON.stringify({ version: 1, connections: drafts });
    }
    if (byteLength(text) > MAX_BYTES) return false;
    if (drafts.length < candidates.length) onEviction?.();
    if (storage.getItem(DRAFT_KEY) !== text) storage.setItem(DRAFT_KEY, text);
    return true;
  } catch {
    return false;
  }
}
