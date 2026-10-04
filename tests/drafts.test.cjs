// Copyright (c) 2026 Davide Leopardi
// SPDX-License-Identifier: GPL-3.0-only

"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const compiled = ts.transpileModule(
  fs.readFileSync(
    require("node:path").join(__dirname, "../src/drafts.ts"),
    "utf8",
  ),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;
const exportsObject = {};
vm.runInNewContext(compiled, { exports: exportsObject, TextEncoder });
const { loadDraft, saveDraft, DRAFT_KEY } = exportsObject;
const fixture = () => {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
  };
};
const draft = (connectionId, sql = "SELECT '東京 Müller' AS value;") => ({
  connectionId,
  tabs: [{ id: "tab1", name: "Query", sql }],
  activeTab: "tab1",
});
test("draft archives preserve exact SQL and isolate connections without query results", () => {
  const storage = fixture();
  assert.equal(
    saveDraft(storage, { ...draft("first"), results: [{ secret: "ignored" }] }),
    true,
  );
  assert.equal(saveDraft(storage, draft("second", "SELECT 2;")), true);
  assert.equal(
    loadDraft(storage, "first").tabs[0].sql,
    "SELECT '東京 Müller' AS value;",
  );
  assert.equal(loadDraft(storage, "second").tabs[0].sql, "SELECT 2;");
  assert.equal(loadDraft(storage, "missing"), null);
  assert.equal(storage.getItem(DRAFT_KEY).includes("ignored"), false);
});
test("malformed archive and invalid oversized draft recover without replacing prior content", () => {
  const storage = fixture();
  storage.setItem(DRAFT_KEY, "{broken");
  assert.equal(loadDraft(storage, "first"), null);
  assert.equal(saveDraft(storage, draft("first")), true);
  const before = storage.getItem(DRAFT_KEY);
  assert.equal(saveDraft(storage, draft("first", "a".repeat(256001))), false);
  assert.equal(storage.getItem(DRAFT_KEY), before);
  assert.equal(
    saveDraft(storage, {
      ...draft("first"),
      tabs: Array.from({ length: 17 }, (_, i) => ({
        id: `tab${i}`,
        name: "Query",
        sql: "SELECT 1;",
      })),
    }),
    false,
  );
  assert.equal(storage.getItem(DRAFT_KEY), before);
});
test("storage quota failures preserve the previous archive and report failure", () => {
  const storage = fixture();
  saveDraft(storage, draft("first"));
  const before = storage.getItem(DRAFT_KEY);
  storage.setItem = () => {
    throw Error("Quota exceeded");
  };
  assert.equal(saveDraft(storage, draft("second")), false);
  assert.equal(storage.getItem(DRAFT_KEY), before);
});
test("connection and UTF-8 capacity eviction reports the retained archive boundary", () => {
  const storage = fixture();
  let warnings = 0;
  for (let i = 0; i < 17; i++)
    assert.equal(
      saveDraft(storage, draft(`db${i}`), () => warnings++),
      true,
    );
  assert.equal(warnings, 1);
  assert.equal(loadDraft(storage, "db0"), null);
  assert.equal(
    loadDraft(storage, "db16").tabs[0].sql,
    "SELECT '東京 Müller' AS value;",
  );
  const wide = fixture();
  for (let i = 0; i < 4; i++)
    saveDraft(wide, draft(`wide${i}`, "東".repeat(256000)), () => warnings++);
  assert(Buffer.byteLength(wide.getItem(DRAFT_KEY), "utf8") <= 2 * 1024 * 1024);
  assert.equal(loadDraft(wide, "wide0"), null);
  assert.equal(loadDraft(wide, "wide3").tabs[0].sql.length, 256000);
  assert(warnings > 1);
});
