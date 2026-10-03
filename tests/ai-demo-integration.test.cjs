"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { DatabaseService } = require("../electron/database.cjs");
const { AssistantService } = require("../electron/assistant.cjs");
const { AIService } = require("../electron/ai.cjs");
const { MemoryVault } = require("../electron/ai-vault.cjs");

async function fixture(t) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "tableline-ai-real-demo-"),
  );
  const vault = new MemoryVault();
  const database = new DatabaseService({ directory, vault });
  const ai = new AIService({
    file: path.join(directory, "ai-profiles.json"),
    vault,
    fetch: () => assert.fail("Local demo must not contact any provider"),
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
