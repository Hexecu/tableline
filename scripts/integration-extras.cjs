// Copyright (c) 2026 Davide Leopardi
// SPDX-License-Identifier: GPL-3.0-only

"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { DatabaseService } = require("../electron/database.cjs");
const { MemoryVault } = require("../electron/ai-vault.cjs");
const { createClient: redisClient } = require("redis");
const { MongoClient } = require("mongodb");
const { createClient: clickhouseClient } = require("@clickhouse/client");
const { execFileSync } = require("node:child_process");
const results = [];
// This script seeds disposable databases. Refuse to touch any service unless
// Docker identifies our named, labelled fixture and exact loopback port mapping.
function assertFixture(engine, hostPort, containerPort) {
  for (const name of [
    `tableline-fixture-${engine}`,
    `tableline-root-${engine}`,
  ]) {
    let data;
    try {
      data = JSON.parse(
        execFileSync("docker", ["inspect", name], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 5000,
        }),
      )[0];
    } catch {
      continue;
    }
    const ports = data.NetworkSettings?.Ports?.[`${containerPort}/tcp`] || [];
    if (
      data.Config?.Labels?.["tableline.qa"] === "isolated" &&
      data.State?.Running === true &&
      ports.some(
        (p) => p.HostIp === "127.0.0.1" && p.HostPort === String(hostPort),
      )
    )
      return;
  }
  throw new Error(
    `Disposable ${engine} fixture unavailable. Start fixtures/compose.yaml; no database data was changed.`,
  );
}
async function check(name, fn) {
  const started = performance.now();
  try {
    await fn();
    results.push({
      name,
      status: "passed",
      durationMs: Math.round(performance.now() - started),
    });
    console.log("PASS", name);
  } catch (e) {
    results.push({
      name,
      status: "failed",
      error: e.message,
      durationMs: Math.round(performance.now() - started),
    });
    console.error("FAIL", name, e.message);
  }
}
async function retry(fn) {
  let last;
  for (let i = 0; i < 40; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw last;
}
(async () => {
  assertFixture("redis", 56388, 6379);
  assertFixture("mongo", 57028, 27017);
  assertFixture("clickhouse", 58138, 8123);
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "tableline-document-qa-"),
  );
  const database = new DatabaseService({ directory, vault: new MemoryVault() });
  let redis, mongo, ch;
  try {
    await check(
      "Redis7 real server: browse, bounded reads, guarded SET preview/discard/commit",
      async () => {
        redis = redisClient({
          socket: { host: "127.0.0.1", port: 56388, reconnectStrategy: false },
        });
        redis.on("error", () => {});
        await retry(() => redis.connect());
        await redis.set("fixture:status", "pending");
        await redis.set("fixture:unicode", "東京 · Müller · 👋");
        await redis.hSet("fixture:customer", {
          name: "Atelier Bleu",
          country: "FR",
        });
        const pages = redis.multi();
        for (let i = 1; i <= 127; i++)
          pages.set(
            `fixture:page:${String(i).padStart(3, "0")}`,
            `Customer ${i}`,
          );
        await pages.exec();
        const p = await database.saveConnection({
          id: "redis-qa",
          name: "Redis QA",
          driver: "redis",
          host: "127.0.0.1",
          port: 56388,
          database: "0",
          ssl: false,
          readOnly: false,
        });
        await database.connect(p.id);
        const schema = await database.schema(p.id);
        assert.equal(schema[0].name, "keys");
        const b = await database.browse({
          connectionId: p.id,
          table: "keys",
          limit: 100,
        });
        assert.equal(b.rows.length, 100);
        const matched = await database.browse({
          connectionId: p.id,
          table: "keys",
          search: "fixture:status",
          limit: 100,
        });
        assert(matched.rows.some((r) => r.key === "fixture:status"));
        const q = await database.query({
          connectionId: p.id,
          sql: JSON.stringify({ command: "GET", args: ["fixture:unicode"] }),
        });
        assert.match(q.rows[0].value, /東京/);
        for (const command of ["FLUSHALL", "CONFIG", "EVAL", "DEBUG", "SET"])
          await assert.rejects(
            database.query({
              connectionId: p.id,
              sql: JSON.stringify({
                command,
                args: ["fixture:status", "changed"],
              }),
            }),
            /not supported/,
          );
        const proposal = await database.prepareWrite({
          connectionId: p.id,
          sql: JSON.stringify({
            command: "SET",
            args: ["fixture:status", "reviewed"],
          }),
        });
        assert.equal(await redis.get("fixture:status"), "pending");
        await database.discardWrite({ id: proposal.id });
        await assert.rejects(database.commitWrite({ id: proposal.id }));
        const approved = await database.prepareWrite({
          connectionId: p.id,
          sql: JSON.stringify({
            command: "SET",
            args: ["fixture:status", "reviewed"],
          }),
        });
        await database.commitWrite({ id: approved.id });
        assert.equal(await redis.get("fixture:status"), "reviewed");
        await assert.rejects(database.commitWrite({ id: approved.id }));
      },
    );
    await check(
      "MongoDB8 real server: schema, Unicode filter, pagination, aggregate, staged update and read policy",
      async () => {
        mongo = new MongoClient("mongodb://127.0.0.1:57028", {
          serverSelectionTimeoutMS: 1000,
        });
        await retry(() => mongo.connect());
        const collection = mongo
          .db("tableline_fixture")
          .collection("customers");
        await collection.deleteMany({});
        await collection.insertMany(
          Array.from({ length: 127 }, (_, i) => ({
            _id: i + 1,
            name: i === 0 ? "東京デザイン" : `Customer ${i + 1}`,
            country: i % 2 ? "FR" : "IT",
            status: "pending",
            notes: i % 7 ? null : "Müller",
          })),
        );
        const p = await database.saveConnection({
          id: "mongo-qa",
          name: "Mongo QA",
          driver: "mongodb",
          host: "127.0.0.1",
          port: 57028,
          database: "tableline_fixture",
          ssl: false,
          readOnly: false,
        });
        await database.connect(p.id);
        assert(
          (await database.schema(p.id))[0].columns.some(
            (c) => c.name === "country",
          ),
        );
        const page = await database.browse({
          connectionId: p.id,
          table: "customers",
          limit: 50,
          offset: 50,
        });
        assert.equal(page.total, 127);
        assert.equal(page.rows[0]._id, 51);
        const filtered = await database.browse({
          connectionId: p.id,
          table: "customers",
          search: "東京",
          limit: 50,
        });
        assert.equal(filtered.rows.length, 1);
        const count = await database.query({
          connectionId: p.id,
          sql: JSON.stringify({
            collection: "customers",
            operation: "aggregate",
            pipeline: [
              { $group: { _id: "$country", count: { $sum: 1 } } },
              { $sort: { _id: 1 } },
            ],
          }),
        });
        assert.equal(
          count.rows.reduce((s, r) => s + r.count, 0),
          127,
        );
        for (const unsafe of [
          { $out: "stolen" },
          { $match: { $where: "evil()" } },
        ])
          await assert.rejects(
            database.query({
              connectionId: p.id,
              sql: JSON.stringify({
                collection: "customers",
                operation: "aggregate",
                pipeline: [unsafe],
              }),
            }),
          );
        const proposal = await database.prepareWrite({
          connectionId: p.id,
          sql: JSON.stringify({
            collection: "customers",
            operation: "updateMany",
            filter: { _id: 1 },
            update: { $set: { status: "reviewed" } },
          }),
        });
        assert.equal(proposal.affectedRows, 1);
        assert.equal((await collection.findOne({ _id: 1 })).status, "pending");
        await database.commitWrite({ id: proposal.id });
        assert.equal((await collection.findOne({ _id: 1 })).status, "reviewed");
        await database.saveConnection({ ...p, readOnly: true });
        await assert.rejects(
          database.prepareWrite({
            connectionId: p.id,
            sql: JSON.stringify({
              collection: "customers",
              operation: "deleteMany",
              filter: { _id: 1 },
            }),
          }),
          /read-only/,
        );
      },
    );
    await check(
      "ClickHouse25.8 real server: schema, bounded query, sorted/filter browsing and write rejection",
      async () => {
        ch = clickhouseClient({
          url: "http://127.0.0.1:58138",
          username: "tableline_qa",
          password: "",
        });
        await retry(async () => {
          const p = await ch.ping();
          if (!p.success) throw Error("ClickHouse not ready");
        });
        await ch.command({
          query:
            "CREATE TABLE IF NOT EXISTS default.customers (id UInt32,name String,country String) ENGINE=MergeTree ORDER BY id",
        });
        await ch.command({ query: "TRUNCATE TABLE default.customers" });
        await ch.insert({
          table: "customers",
          values: Array.from({ length: 127 }, (_, i) => ({
            id: i + 1,
            name: i === 0 ? "東京デザイン" : `Customer ${i + 1}`,
            country: i % 2 ? "FR" : "IT",
          })),
          format: "JSONEachRow",
        });
        const p = await database.saveConnection(
          {
            id: "clickhouse-qa",
            name: "ClickHouse QA",
            driver: "clickhouse",
            host: "127.0.0.1",
            port: 58138,
            database: "default",
            username: "tableline_qa",
            ssl: false,
            readOnly: false,
          },
          { password: "" },
        );
        await database.connect(p.id);
        const s = await database.schema(p.id);
        assert(s.some((t) => t.name === "customers"));
        const page = await database.browse({
          connectionId: p.id,
          table: "customers",
          schema: "default",
          limit: 50,
          offset: 50,
          sortColumn: "id",
          sortDirection: "desc",
        });
        assert.equal(page.total, 127);
        assert.equal(page.rows[0].id, 77);
        const filter = await database.browse({
          connectionId: p.id,
          table: "customers",
          schema: "default",
          search: "東京",
          limit: 50,
        });
        assert.equal(filter.rows.length, 1);
        const q = await database.query({
          connectionId: p.id,
          sql: "SELECT count(*) AS count FROM customers",
        });
        assert.equal(Number(q.rows[0].count), 127);
        await assert.rejects(
          database.prepareWrite({
            connectionId: p.id,
            sql: "DELETE FROM customers WHERE id=1",
          }),
          /unavailable/,
        );
      },
    );
  } finally {
    await database.close();
    if (redis?.isOpen) await redis.quit();
    await mongo?.close();
    await ch?.close();
  }
  const report = {
    date: new Date().toISOString(),
    runtime: "actual isolated Docker servers",
    status: results.every((r) => r.status === "passed") ? "passed" : "failed",
    checks: results,
  };
  await fs.mkdir(path.join(__dirname, "../artifacts/integration"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(__dirname, "../artifacts/integration/document-servers.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.status === "passed" ? 0 : 1;
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
