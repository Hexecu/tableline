// Copyright (c) 2026 Davide Leopardi
// SPDX-License-Identifier: GPL-3.0-only

"use strict";
const fs = require("node:fs/promises"),
  os = require("node:os"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { DatabaseService } = require("../electron/database.cjs");
(async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "tableline-benchmark-"),
  );
  const file = path.join(directory, "large.sqlite");
  const seed = new DatabaseSync(file);
  seed.exec(
    "CREATE TABLE records(id INTEGER PRIMARY KEY,customer_id INTEGER,status TEXT,total REAL,notes TEXT);CREATE INDEX by_customer ON records(customer_id);BEGIN;",
  );
  const insert = seed.prepare("INSERT INTO records VALUES(?,?,?,?,?)");
  for (let i = 1; i <= 100000; i++)
    insert.run(
      i,
      (i % 2000) + 1,
      i % 3 ? "paid" : "pending",
      i % 1000,
      i % 11 ? null : "東京 · Müller · fixture",
    );
  seed.exec("COMMIT");
  seed.close();
  const service = new DatabaseService({ directory });
  const profile = await service.saveConnection({
    id: "load",
    name: "Load fixture",
    driver: "sqlite",
    filePath: file,
    readOnly: true,
  });
  const samples = [];
  try {
    await service.connect(profile.id);
    for (let i = 0; i < 10; i++) {
      const p = await service.browse({
        connectionId: profile.id,
        table: "records",
        limit: 100,
        offset: i * 10000,
        sortColumn: "id",
        sortDirection: "asc",
      });
      assert.equal(p.total, 100000);
      assert.equal(p.rows.length, 100);
      assert.equal(p.rows[0].id, i * 10000 + 1);
      samples.push(p.durationMs);
    }
    const filter = await service.browse({
      connectionId: profile.id,
      table: "records",
      search: "東京",
      limit: 100,
    });
    assert.equal(filter.total, 9090);
    const aggregate = await service.query({
      connectionId: profile.id,
      sql: "SELECT status,COUNT(*) AS count,SUM(total) AS total FROM records GROUP BY status",
    });
    assert.equal(
      aggregate.rows.reduce((s, r) => s + r.count, 0),
      100000,
    );
    const report = {
      date: new Date().toISOString(),
      runtime: `Node ${process.version} · actual SQLite child process`,
      fixtureRows: 100000,
      samples: 10,
      browse100RowsMs: {
        min: Math.min(...samples),
        median: [...samples].sort((a, b) => a - b)[5],
        max: Math.max(...samples),
      },
      fullTextFilterMs: filter.durationMs,
      aggregateMs: aggregate.durationMs,
      assertions:
        "total, ordered page ids, Unicode filter cardinality and aggregation count verified",
      limits:
        "Local synthetic measurements only; no production latency or SLA claim.",
    };
    await fs.mkdir(path.join(__dirname, "../artifacts/benchmark"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(__dirname, "../artifacts/benchmark/report.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await service.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
