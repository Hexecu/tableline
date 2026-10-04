// Copyright (c) 2026 Davide Leopardi
// SPDX-License-Identifier: GPL-3.0-only

"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { DatabaseService } = require("../electron/database.cjs");
const { AssistantService } = require("../electron/assistant.cjs");
const { AIService } = require("../electron/ai.cjs");
const { MemoryVault } = require("../electron/ai-vault.cjs");

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "tableline-ai-real-demo-"),
  );
  const vault = new MemoryVault();
  const database = new DatabaseService({ directory, vault });
  const ai = new AIService({
    file: path.join(directory, "ai-profiles.json"),
    vault,
    fetch: options.fetch || (() => assert.fail("Local demo must not contact any provider")),
  });
  const assistant = new AssistantService({ ai, database });
  await database.demo();
  t.after(async () => {
    await database.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, database, ai, assistant };
}
const ask = (assistant, prompt, mode = "read") =>
  assistant.ask({ connectionId: "demo", profileId: "demo", prompt, mode });
const query = (database, sql, params) =>
  database.query({ connectionId: "demo", sql, params });

test("guided assistant counts actual SQLite tables, no fixture answer injection", async (t) => {
  const { assistant } = await fixture(t);
  const cases = [
    ["Quanti ordini?", 1000],
    ["Quanti clienti?", 120],
    ["Quanti prodotti?", 36],
  ];
  for (const [question, expected] of cases) {
    const response = await ask(assistant, question);
    assert.equal(response.result.rows[0].count, expected);
    assert.equal(response.grounded, true);
    assert.equal(response.isMock, true);
    assert.match(response.answer, /Ci sono/);
  }
});

test("LiteLLM assistant counts camera products through real SQLite and grounds its answer in returned evidence", async (t) => {
  const calls = [];
  const { assistant, ai, database } = await fixture(t, {
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      const { request, untrusted_database_context: context } = JSON.parse(body.messages[1].content);
      calls.push({ url, body, request, context });
      assert.equal(body.model, "gemini-3.5-flash");
      assert.deepEqual(body.response_format, { type: "json_object" });
      assert.equal(body.max_completion_tokens, 8192);
      assert.equal(request, "quanti prodotti di tipo camera ho");
      assert.equal(context.dialect, "sqlite");
      const decision = context.toolResults.length === 0
        ? {
            action: "query_read",
            sql: "SELECT COUNT(*) AS count FROM products WHERE LOWER(name) LIKE ?",
            params: ["%camera%"],
            answer: "",
          }
        : {
            action: "final",
            sql: "",
            params: [],
            answer: `Ci sono ${context.toolResults[0].result.rows[0].count} prodotti di tipo camera.`,
          };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(decision) }, finish_reason: "stop" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  await ai.save({
    id: "litellm-camera",
    name: "Synthetic LiteLLM transport",
    provider: "litellm",
    baseUrl: "https://gateway.example",
    model: "gemini-3.5-flash",
  }, { apiKey: "synthetic-provider-key" });
  const response = await assistant.ask({
    connectionId: "demo",
    profileId: "litellm-camera",
    prompt: "quanti prodotti di tipo camera ho",
  });
  const independent = await query(database, "SELECT COUNT(*) AS count FROM products WHERE LOWER(name) LIKE ?", ["%camera%"]);
  assert.equal(independent.rows[0].count, 3);
  assert.deepEqual(response.result.rows, independent.rows);
  assert.equal(response.answer, "Ci sono 3 prodotti di tipo camera.");
  assert.equal(response.grounded, true);
  assert.equal(response.isMock, false);
  assert.equal(calls.length, 2);
  assert(calls.every((call) => call.url === "https://gateway.example/v1/chat/completions"));
  assert.equal(calls[0].context.toolResults.length, 0);
  assert.equal(calls[1].context.toolResults[0].sql, response.sql);
  assert.equal(calls[1].context.toolResults[0].result.rows[0].count, 3);
});

test("LiteLLM-generated SQLite LIKE ESCAPE backslash returns the actual camera count and stock aggregate", async (t) => {
  const sql = String.raw`SELECT COUNT(*) AS count_products, SUM(stock) AS total_stock FROM products WHERE name LIKE ? ESCAPE '\'`;
  const { assistant, ai, database } = await fixture(t, {
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      const { untrusted_database_context: context } = JSON.parse(body.messages[1].content);
      const decision = context.toolResults.length === 0
        ? { action: "query_read", sql, params: ["%camera%"] }
        : { action: "final", answer: `Ci sono ${context.toolResults[0].result.rows[0].count_products} prodotti di tipo camera.` };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(decision) }, finish_reason: "stop" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  await ai.save({
    id: "litellm-sqlite-escape",
    name: "Synthetic SQLite escape transport",
    provider: "litellm",
    baseUrl: "https://gateway.example",
    model: "gemini-3.5-flash",
  }, { apiKey: "synthetic-provider-key" });
  const response = await assistant.ask({
    connectionId: "demo",
    profileId: "litellm-sqlite-escape",
    prompt: "quanti prodotti di tipo camera ho",
  });
  const independent = await query(database, sql, ["%camera%"]);
  assert.equal(independent.rows[0].count_products, 3);
  assert.deepEqual(response.result.rows, independent.rows);
  assert.equal(response.answer, "Ci sono 3 prodotti di tipo camera.");
  assert.equal(response.grounded, true);
  assert.equal(response.sql, sql);
  const literal = await query(database, String.raw`SELECT 'it''s\safe' AS note`);
  assert.equal(literal.rows[0].note, "it's\\safe");
});

test("a token-limited LiteLLM response never reaches SQLite even if its text contains a complete read decision", async (t) => {
  const { assistant, ai, database } = await fixture(t, {
    fetch: async () => new Response(JSON.stringify({
      choices: [{
        message: { content: JSON.stringify({
          action: "query_read",
          sql: "SELECT COUNT(*) AS count FROM products",
          params: [],
        }) },
        finish_reason: "length",
      }],
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  await ai.save({
    id: "litellm-limited",
    name: "Synthetic limited transport",
    provider: "litellm",
    baseUrl: "https://gateway.example",
    model: "gemini-3.5-flash",
  }, { apiKey: "synthetic-provider-key" });
  let queryCalls = 0;
  const originalQuery = database.query.bind(database);
  database.query = (...args) => {
    queryCalls++;
    return originalQuery(...args);
  };
  await assert.rejects(assistant.ask({
    connectionId: "demo",
    profileId: "litellm-limited",
    prompt: "quanti prodotti di tipo camera ho",
  }), /limite di generazione.*decisione JSON/);
  assert.equal(queryCalls, 0);
});

test("production LiteLLM repair keeps instructions separate from invalid output and executes the filtered SQLite read once", async (t) => {
  const calls = [];
  let queryCalls = 0;
  const decision = {
    action: "query_read",
    sql: "SELECT COUNT(*) AS count FROM products WHERE LOWER(name) LIKE ?",
    params: ["%camera%"],
  };
  const invalidPreamble = "I need to check the product names. Untrusted-output-marker.\n\n";
  const { assistant, ai, database } = await fixture(t, {
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ url, body });
      const { untrusted_database_context: context } = JSON.parse(body.messages[1].content);
      assert.equal(body.model, "claude-opus-4.6");
      assert.deepEqual(body.response_format, { type: "json_object" });
      assert.equal(body.max_completion_tokens, 8192);
      let output;
      if (calls.length === 1) {
        output = invalidPreamble + JSON.stringify(decision);
        assert.equal(queryCalls, 0);
      } else if (calls.length === 2) {
        assert.equal(queryCalls, 0);
        assert.match(body.messages[0].content, /previous response did not follow the decision protocol/);
        assert.equal(body.messages[1].content, calls[0].body.messages[1].content);
        assert.equal(JSON.stringify(body).includes("Untrusted-output-marker"), false);
        assert.equal(context.toolResults.length, 0);
        output = JSON.stringify(decision);
      } else {
        assert.equal(queryCalls, 1);
        assert.equal(body.messages[0].content, calls[1].body.messages[0].content);
        output = JSON.stringify({
          action: "final",
          answer: `Ci sono ${context.toolResults[0].result.rows[0].count} prodotti di tipo camera.`,
        });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: output }, finish_reason: "stop" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  await ai.save({
    id: "litellm-opus-repair",
    name: "Synthetic Opus transport",
    provider: "litellm",
    baseUrl: "https://gateway.example",
    model: "claude-opus-4.6",
  }, { apiKey: "synthetic-provider-key" });
  const originalQuery = database.query.bind(database);
  database.query = (...args) => {
    queryCalls++;
    return originalQuery(...args);
  };
  const response = await assistant.ask({
    connectionId: "demo",
    profileId: "litellm-opus-repair",
    prompt: "quanti prodotti di tipo camera ho",
  });
  assert.equal(calls.length, 3);
  assert.equal(queryCalls, 1);
  assert.equal(response.result.rows[0].count, 3);
  assert.equal(response.answer, "Ci sono 3 prodotti di tipo camera.");
  assert.equal(response.grounded, true);
  assert.equal(response.isMock, false);
});

test("nullable COUNT and COUNT DISTINCT can be zero over nonempty SQLite rows without activating the empty-match guard", async (t) => {
  const expectedAnswer = "Il conteggio dei valori non nulli è 0; questo non misura il numero di righe.";
  const { assistant, ai, database } = await fixture(t, {
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      const { request, untrusted_database_context: context } = JSON.parse(body.messages[1].content);
      const decision = context.toolResults.length === 0
        ? {
            action: "query_read",
            sql: request.includes("distinti")
              ? "SELECT COUNT(DISTINCT NULLIF(name, name)) AS count FROM products"
              : "SELECT COUNT(NULLIF(name, name)) AS count FROM products",
            params: [],
          }
        : { action: "final", answer: expectedAnswer };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(decision) }, finish_reason: "stop" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  await ai.save({
    id: "litellm-nullable",
    name: "Synthetic nullable-count transport",
    provider: "litellm",
    baseUrl: "https://gateway.example",
    model: "synthetic-exact-model",
  }, { apiKey: "synthetic-provider-key" });
  assert.equal((await query(database, "SELECT COUNT(*) AS count FROM products")).rows[0].count, 36);
  let reads = 0;
  const originalQuery = database.query.bind(database);
  database.query = (...args) => {
    reads++;
    return originalQuery(...args);
  };
  for (const prompt of ["Conta nomi non nulli", "Conta nomi distinti non nulli"]) {
    const response = await assistant.ask({ connectionId: "demo", profileId: "litellm-nullable", prompt });
    assert.equal(response.result.rows[0].count, 0);
    assert.equal(response.result.rows.length, 1);
    assert.equal(response.answer, expectedAnswer);
    assert.equal(response.grounded, true);
  }
  assert.equal(reads, 2);
});

test('quoted COUNT("1") and COUNT("*") columns containing only NULL do not imply an empty SQLite table', async (t) => {
  const expectedAnswer = "Il conteggio dei valori non nulli è 0; la tabella può contenere righe.";
  const { directory, assistant, ai, database } = await fixture(t, {
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      const { request, untrusted_database_context: context } = JSON.parse(body.messages[1].content);
      const argument = request.includes("asterisco") ? '"*"' : '"1"';
      const decision = context.toolResults.length === 0
        ? { action: "query_read", sql: `SELECT COUNT(${argument}) AS count FROM quoted_counts`, params: [] }
        : { action: "final", answer: expectedAnswer };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(decision) }, finish_reason: "stop" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const filename = path.join(directory, "quoted-counts.sqlite");
  const fixtureDatabase = new DatabaseSync(filename);
  try {
    fixtureDatabase.exec('CREATE TABLE quoted_counts ("1" INTEGER, "*" INTEGER); INSERT INTO quoted_counts VALUES (NULL, NULL), (NULL, NULL)');
  } finally {
    fixtureDatabase.close();
  }
  await database.saveConnection({ id: "quoted-counts", name: "Quoted nullable fixture", driver: "sqlite", filePath: filename, readOnly: true });
  await database.connect("quoted-counts");
  await ai.save({
    id: "litellm-quoted-count",
    name: "Synthetic quoted-count transport",
    provider: "litellm",
    baseUrl: "https://gateway.example",
    model: "synthetic-exact-model",
  }, { apiKey: "synthetic-provider-key" });
  assert.equal((await database.query({ connectionId: "quoted-counts", sql: "SELECT COUNT(*) AS count FROM quoted_counts" })).rows[0].count, 2);
  for (const prompt of ["Conta la colonna uno", "Conta la colonna asterisco"]) {
    const response = await assistant.ask({ connectionId: "quoted-counts", profileId: "litellm-quoted-count", prompt });
    assert.equal(response.result.rows[0].count, 0);
    assert.equal(response.result.rows.length, 1);
    assert.equal(response.answer, expectedAnswer);
    assert.equal(response.grounded, true);
  }
});

test("real demo revenue uses SQL results and keeps currencies distinct per country/customer", async (t) => {
  const { assistant, database } = await fixture(t);
  for (const question of [
    "Fatturato per paese",
    "Primi clienti per ricavi",
    "Fatturato totale",
  ]) {
    const response = await ask(assistant, question);
    const independent = await query(database, response.sql);
    assert.deepEqual(response.result.rows, independent.rows);
    assert(response.result.rows.length > 0);
    for (const row of response.result.rows) {
      assert(["EUR", "USD", "GBP"].includes(row.currency));
      assert(row.revenue > 0);
    }
    assert.match(response.sql, /status IN \('paid', 'shipped'\)/);
    assert.match(response.sql, /GROUP BY/);
  }
});

test("pending/status demo results are bounded and derived from live SQLite rows", async (t) => {
  const { assistant, database } = await fixture(t);
  const pending = await ask(assistant, "Mostra ordini pending");
  assert.equal(pending.result.rows.length, 50);
  assert(pending.result.rows.every((row) => row.status === "pending"));
  assert.match(pending.answer, /Mostro 8 di 50/);
  const counts = await ask(assistant, "Distribuzione per stato");
  assert.equal(
    counts.result.rows.reduce((sum, row) => sum + row.count, 0),
    1000,
  );
  const totalPending = await query(
    database,
    "SELECT COUNT(*) AS count FROM orders WHERE status = 'pending'",
  );
  assert.equal(
    counts.result.rows.find((row) => row.status === "pending").count,
    totalPending.rows[0].count,
  );
});

test("assistant write proposal rolls back real SQL; only separate human confirmation commits once", async (t) => {
  const { assistant, database } = await fixture(t);
  const before = await query(
    database,
    "SELECT status FROM orders WHERE id = 3",
  );
  assert.equal(before.rows[0].status, "pending");
  await assert.rejects(
    ask(assistant, "Aggiorna ordine 3 a shipped"),
    /lettura/,
  );
  const proposal = await ask(assistant, "Aggiorna ordine 3 a shipped", "write");
  assert.equal(proposal.proposal.affectedRows, 1);
  assert.deepEqual(proposal.proposal.params, ["shipped", 3]);
  const unchanged = await query(
    database,
    "SELECT status FROM orders WHERE id = 3",
  );
  assert.equal(unchanged.rows[0].status, "pending");
  const committed = await database.commitWrite({ id: proposal.proposal.id });
  assert.equal(committed.committed, true);
  assert.equal(committed.affectedRows, 1);
  const after = await query(database, "SELECT status FROM orders WHERE id = 3");
  assert.equal(after.rows[0].status, "shipped");
  await assert.rejects(
    database.commitWrite({ id: proposal.proposal.id }),
    /no longer exists/,
  );
});

test("real database read-only connection policy is respected by mock assistant write", async (t) => {
  const { assistant, database } = await fixture(t);
  const [profile] = await database.connections();
  await database.saveConnection({ ...profile, readOnly: true });
  await assert.rejects(
    ask(assistant, "Aggiorna ordine 3 a shipped", "write"),
    /read-only/,
  );
  assert.equal(
    (await query(database, "SELECT status FROM orders WHERE id = 3")).rows[0]
      .status,
    "pending",
  );
});
