// Copyright (c) 2026 Davide Leopardi
// SPDX-License-Identifier: GPL-3.0-only

"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { DatabaseService, normalize } = require("../electron/database.cjs");
const { guardSql, quoteIdentifier } = require("../electron/sql-guard.cjs");
const { command, redisCommand } = require("../electron/drivers/document.cjs");

test("SQLite LIKE escapes retain standard quote boundaries in both SQL guards", () => {
  const valid = String.raw`SELECT COUNT(*) FROM products WHERE name LIKE ? ESCAPE '\'`;
  assert.equal(guardSql(valid, "read", "sqlite").sql, valid);
  assert.equal(guardSql(String.raw`SELECT 'it''s\safe' AS value`, "read", "sqlite").kind, "select");
  for (const dialect of ["unknown", "postgres", "mysql", "sqlserver", "databricks", "clickhouse"])
    assert.throws(() => guardSql(valid, "read", dialect), /backslash/);
  for (const sql of [
    String.raw`SELECT '\'; DELETE FROM products`,
    String.raw`SELECT '\' || readfile('/tmp/data')`,
    String.raw`SELECT 1 \ `,
    String.raw`SELECT "name\" FROM products`,
    String.raw`SELECT 1 -- \ comment`,
    String.raw`SELECT 1 /* \ comment */`,
  ]) assert.throws(() => guardSql(sql, "read", "sqlite"));
  assert.throws(() => guardSql(String.raw`UPDATE products SET name='WHERE\'`, "read", "sqlite"));
});

let directory, db;
test.before(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "tableline-db-test-"));
  db = new DatabaseService({ directory });
  await db.demo();
});
test.after(async () => {
  await db?.close();
  await fs.rm(directory, { recursive: true, force: true });
});

test("demo uses a real isolated database and is idempotent", async () => {
  const c = await db.demo();
  assert.equal(c.length, 1);
  assert.equal(c[0].id, "demo");
  assert.equal(c[0].driver, "sqlite");
  assert.equal(c[0].hasCredential, false);
  const schema = await db.schema("demo");
  assert.deepEqual(
    schema.map((t) => [t.name, t.rowCount]),
    [
      ["customers", 120],
      ["order_items", 1000],
      ["orders", 1000],
      ["products", 36],
    ],
  );
  assert.equal(schema[0].columns.find((c) => c.name === "id").primaryKey, true);
  const values = await db.query({
    connectionId: "demo",
    sql: "SELECT DISTINCT status FROM orders ORDER BY status",
  });
  assert.equal(values.rows.length, 5);
  const unicode = await db.query({
    connectionId: "demo",
    sql: "SELECT name FROM customers WHERE id=?",
    params: [5],
  });
  assert.equal(unicode.rows[0].name, "東京デザイン");
  const nulls = await db.query({
    connectionId: "demo",
    sql: "SELECT count(*) n FROM customers WHERE email IS NULL",
  });
  assert.ok(nulls.rows[0].n > 0);
});

test("real SQLite escaped LIKE reads and write previews remain bounded and rollback", async () => {
  const sql = String.raw`SELECT COUNT(*) AS count, SUM(stock) AS stock FROM products WHERE name LIKE ? ESCAPE '\'`;
  const result = await db.query({ connectionId: "demo", sql, params: ["%camera%"] });
  assert.deepEqual(result.rows, [{ count: 3, stock: 182 }]);
  const proposal = await db.prepareWrite({
    connectionId: "demo",
    sql: String.raw`UPDATE products SET stock = ? WHERE name LIKE ? ESCAPE '\'`,
    params: [5, "%camera%"],
  });
  assert.equal(proposal.affectedRows, 3);
  assert.deepEqual((await db.query({ connectionId: "demo", sql, params: ["%camera%"] })).rows, result.rows);
  await assert.rejects(db.query({ connectionId: "demo", sql: String.raw`SELECT '\'; DELETE FROM products` }));
  assert.deepEqual((await db.query({ connectionId: "demo", sql, params: ["%camera%"] })).rows, result.rows);
});
test("browse applies pagination, stable sorting, and column metadata", async () => {
  const a = await db.browse({
    connectionId: "demo",
    table: "orders",
    schema: "main",
    offset: 0,
    limit: 100,
    sortColumn: "id",
  });
  const b = await db.browse({
    connectionId: "demo",
    table: "orders",
    offset: 100,
    limit: 100,
    sortColumn: "id",
  });
  assert.equal(a.total, 1000);
  assert.equal(a.rows[0].id, 1);
  assert.equal(a.rows.at(-1).id, 100);
  assert.equal(b.rows[0].id, 101);
  assert.equal(a.truncated, true);
  assert.ok(a.durationMs >= 0);
  const last = await db.browse({
    connectionId: "demo",
    table: "orders",
    offset: 999,
    limit: 100,
    sortColumn: "id",
  });
  assert.equal(last.rows.length, 1);
  assert.equal(last.truncated, false);
  const empty = await db.browse({
    connectionId: "demo",
    table: "orders",
    offset: 1000,
    limit: 100,
  });
  assert.equal(empty.rows.length, 0);
  assert.equal(empty.columns.length, 7);
});
test("browse search treats wildcard, quote, and Unicode input as values", async () => {
  const paid = await db.browse({
    connectionId: "demo",
    table: "orders",
    search: "paid",
    limit: 1000,
  });
  assert.ok(paid.rows.length > 0);
  assert.ok(paid.rows.every((r) => r.status === "paid"));
  const unicode = await db.browse({
    connectionId: "demo",
    table: "customers",
    search: "東京",
  });
  assert.ok(unicode.rows.every((r) => r.name.includes("東京")));
  for (const search of ["' OR 1=1 --", "%", "_"]) {
    const r = await db.browse({
      connectionId: "demo",
      table: "customers",
      search,
    });
    assert.equal(r.rows.length, 0);
  }
});
test("browse rejects nonexistent names and invalid sort/offset/limit", async () => {
  for (const input of [
    { table: "orders; DROP TABLE customers" },
    { table: "orders", sortColumn: "id; DELETE" },
    { table: "orders", offset: -1 },
    { table: "orders", limit: 1001 },
    { table: "orders", sortDirection: "sideways" },
  ])
    await assert.rejects(db.browse({ connectionId: "demo", ...input }));
  assert.equal(
    (
      await db.query({
        connectionId: "demo",
        sql: "SELECT count(*) n FROM customers",
      })
    ).rows[0].n,
    120,
  );
});
test("read results are bounded and SQL parameters stay values", async () => {
  const result = await db.query({
    connectionId: "demo",
    sql: "SELECT * FROM orders",
    limit: 25,
  });
  assert.equal(result.rows.length, 25);
  assert.equal(result.truncated, true);
  const r = await db.query({
    connectionId: "demo",
    sql: "SELECT name FROM customers WHERE email=?",
    params: ["' OR 1=1 --"],
  });
  assert.equal(r.rows.length, 0);
  await assert.rejects(
    db.query({ connectionId: "demo", sql: "SELECT 1", limit: 10001 }),
  );
  await assert.rejects(
    db.query({ connectionId: "demo", sql: "SELECT ?", params: [{}] }),
  );
});
test("big integers and blobs preserve information when crossing IPC", async () => {
  const r = await db.query({
    connectionId: "demo",
    sql: "SELECT 9223372036854775807 AS big, X'0100ff' AS bytes",
  });
  assert.equal(r.rows[0].big, "9223372036854775807");
  assert.equal(r.rows[0].bytes, "0x0100ff");
  assert.deepEqual(normalize({ i: 20n, d: new Date("2026-01-01T00:00:00Z") }), {
    i: 20,
    d: "2026-01-01T00:00:00.000Z",
  });
});
test("write preview rolls back, commit binds the original SQL and is one-use", async () => {
  const before = (
    await db.query({
      connectionId: "demo",
      sql: "SELECT name FROM customers WHERE id=1",
    })
  ).rows[0].name;
  const params = ["Reviewed customer", 1];
  const p = await db.prepareWrite({
    connectionId: "demo",
    sql: "UPDATE customers SET name=? WHERE id=? RETURNING id,name",
    params,
  });
  params[0] = "MUTATED CLIENT PARAM";
  p.sql = "DELETE FROM customers";
  p.params[0] = "MUTATED RETURN";
  assert.equal(p.affectedRows, 1);
  assert.equal(p.previewRows[0].name, "Reviewed customer");
  assert.equal(
    (
      await db.query({
        connectionId: "demo",
        sql: "SELECT name FROM customers WHERE id=1",
      })
    ).rows[0].name,
    before,
  );
  const result = await db.commitWrite({
    id: p.id,
    sql: "DELETE FROM customers",
  });
  assert.equal(result.committed, true);
  assert.equal(result.affectedRows, 1);
  assert.equal(
    (
      await db.query({
        connectionId: "demo",
        sql: "SELECT name FROM customers WHERE id=1",
      })
    ).rows[0].name,
    "Reviewed customer",
  );
  await assert.rejects(db.commitWrite({ id: p.id }), /no longer exists/);
});
test("query cannot write even on a write-enabled profile", async () => {
  await assert.rejects(
    db.query({
      connectionId: "demo",
      sql: "UPDATE customers SET name='oops' WHERE id=1",
    }),
    /Read mode/,
  );
  const c = await db.query({
    connectionId: "demo",
    sql: "SELECT name FROM customers WHERE id=1",
  });
  assert.equal(c.rows[0].name, "Reviewed customer");
});
test("discarded and expired proposals cannot commit", async () => {
  const a = await db.prepareWrite({
    connectionId: "demo",
    sql: "UPDATE customers SET name='no' WHERE id=2",
  });
  assert.deepEqual(await db.discardWrite({ id: a.id }), { discarded: true });
  await assert.rejects(db.commitWrite({ id: a.id }));
  const b = await db.prepareWrite({
    connectionId: "demo",
    sql: "UPDATE customers SET name='no' WHERE id=2",
  });
  db.proposals.get(b.id).expiresAt = Date.now() - 1;
  await assert.rejects(db.commitWrite({ id: b.id }), /expired/);
  await assert.rejects(db.commitWrite({ id: b.id }), /no longer/);
});
test("preview rejects changed affected counts at commit and rolls back that attempt", async () => {
  const staged = await db.prepareWrite({
    connectionId: "demo",
    sql: "UPDATE customers SET name='should not apply' WHERE segment='Unseen'",
  });
  assert.equal(staged.affectedRows, 0);
  const fresh = await db.prepareWrite({
    connectionId: "demo",
    sql: "UPDATE customers SET segment='Unseen' WHERE id=4",
  });
  await db.commitWrite({ id: fresh.id });
  await assert.rejects(
    db.commitWrite({ id: staged.id }),
    /Affected rows changed/,
  );
  assert.equal(
    (
      await db.query({
        connectionId: "demo",
        sql: "SELECT name FROM customers WHERE id=4",
      })
    ).rows[0].name,
    "Müller GmbH",
  );
});
test("preview errors rollback and leave the connection usable", async () => {
  await assert.rejects(
    db.prepareWrite({
      connectionId: "demo",
      sql: "UPDATE products SET price=-1 WHERE id=1",
    }),
    /CHECK constraint/,
  );
  assert.ok(
    (
      await db.query({
        connectionId: "demo",
        sql: "SELECT price FROM products WHERE id=1",
      })
    ).rows[0].price > 0,
  );
});
test("default connections are read-only and edits invalidate existing proposals", async () => {
  const profile = (await db.connections())[0];
  const read = await db.saveConnection({
    id: "readonly-test",
    name: "Read mirror",
    driver: "sqlite",
    filePath: profile.filePath,
  });
  assert.equal(read.readOnly, true);
  await db.connect(read.id);
  await assert.rejects(
    db.prepareWrite({
      connectionId: read.id,
      sql: "UPDATE customers SET name='no' WHERE id=1",
    }),
    /read-only/,
  );
  const p = await db.prepareWrite({
    connectionId: "demo",
    sql: "UPDATE customers SET name='no' WHERE id=2",
  });
  await db.saveConnection({ ...profile, name: "Updated demo" });
  await assert.rejects(db.commitWrite({ id: p.id }), /no longer/);
  await db.removeConnection(read.id);
});
test("metadata is atomic, private, and contains no credential payload", async () => {
  const store = new Map(),
    vault = {
      get: (id) => store.get(id),
      set: (id, value) => store.set(id, value),
      has: (id) => store.has(id),
      delete: (id) => store.delete(id),
    };
  const local = await fs.mkdtemp(
    path.join(os.tmpdir(), "tableline-vault-test-"),
  );
  const s = new DatabaseService({ directory: local, vault });
  try {
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        s.saveConnection(
          {
            id: `pg${i}`,
            driver: "postgres",
            name: `Connection ${i}`,
            host: "localhost",
            database: "data",
            tls: false,
            password: "MUST-NOT-PERSIST",
          },
          { password: `secret-${i}` },
        ),
      ),
    );
    const text = await fs.readFile(
      path.join(local, "connections.json"),
      "utf8",
    );
    assert.ok(!text.includes("secret-"));
    assert.ok(!text.includes("MUST-NOT-PERSIST"));
    assert.equal(JSON.parse(text).length, 8);
    assert.equal(
      (await fs.stat(path.join(local, "connections.json"))).mode & 0o777,
      0o600,
    );
    const reloaded = new DatabaseService({ directory: local, vault });
    assert.equal((await reloaded.connections()).length, 8);
    assert.equal((await reloaded.connections())[0].hasCredential, true);
    assert.equal((await reloaded.connections())[0].ssl, false);
    await reloaded.saveConnection(
      {
        id: "pg1",
        driver: "postgres",
        name: "Secret merge",
        host: "localhost",
      },
      { token: "preserved-token" },
    );
    await reloaded.saveConnection(
      {
        id: "pg1",
        driver: "postgres",
        name: "Password change",
        host: "localhost",
      },
      { password: "new-password" },
    );
    assert.equal(store.get("db-pg1").token, "preserved-token");
    assert.equal(store.get("db-pg1").password, "new-password");
    await reloaded.removeConnection("pg0");
    assert.equal(store.has("db-pg0"), false);
    assert.equal((await reloaded.connections()).length, 7);
    await reloaded.close();
  } finally {
    await s.close();
    await fs.rm(local, { recursive: true, force: true });
  }
});
test("secrets require a vault and malformed persisted metadata is not overwritten", async () => {
  await assert.rejects(
    db.saveConnection(
      { name: "No vault", driver: "postgres" },
      { password: "hidden" },
    ),
    /vault is unavailable/,
  );
  const local = await fs.mkdtemp(
    path.join(os.tmpdir(), "tableline-corrupt-test-"),
  );
  const filename = path.join(local, "connections.json");
  await fs.writeFile(filename, "{broken");
  const s = new DatabaseService({ directory: local });
  await assert.rejects(s.connections(), /Could not read/);
  assert.equal(await fs.readFile(filename, "utf8"), "{broken");
  await fs.rm(local, { recursive: true });
});
test("catalog reports unverified rollback engines honestly", async () => {
  const catalog = await db.catalog();
  assert.equal(catalog.length, 13);
  for (const id of ["databricks", "clickhouse", "redshift"])
    assert.equal(catalog.find((c) => c.id === id).capabilities.write, false);
  for (const id of ["mongodb", "redis"])
    assert.equal(
      catalog.find((c) => c.id === id).capabilities.writePreview,
      "estimate",
    );
});
test("SQLite query timeout preserves responsiveness and reconnects", async () => {
  await db.connect("demo");
  const adapter = db.adapters.get("demo");
  adapter.timeoutMs = 80;
  let responsive = false;
  const tick = setTimeout(() => {
    responsive = true;
  }, 15);
  await assert.rejects(
    db.query({
      connectionId: "demo",
      sql: "WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers) SELECT sum(n) FROM numbers",
    }),
    /timed out/,
  );
  clearTimeout(tick);
  assert.equal(responsive, true);
  adapter.timeoutMs = 30000;
  assert.equal(
    (await db.query({ connectionId: "demo", sql: "SELECT 42 n" })).rows[0].n,
    42,
  );
});
test("SQLite cancellation stops only the matching active request", async () => {
  const query = db.query({
    connectionId: "demo",
    requestId: "cancel-1",
    sql: "WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers) SELECT sum(n) FROM numbers",
  });
  const rejection = assert.rejects(query, /cancelled/);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await db.cancel("wrong-id")).cancelled, false);
  assert.equal((await db.cancel("cancel-1")).cancelled, true);
  await rejection;
  assert.equal(
    (await db.query({ connectionId: "demo", sql: "SELECT 7 n" })).rows[0].n,
    7,
  );
});
test("closing a connection interrupts a long read promptly", async () => {
  const query = db.query({
      connectionId: "demo",
      sql: "WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers) SELECT sum(n) FROM numbers",
    }),
    rejection = assert.rejects(query, /closing/);
  await new Promise((resolve) => setTimeout(resolve, 40));
  const start = Date.now();
  await db.close("demo");
  assert.ok(Date.now() - start < 500);
  await rejection;
  assert.equal(
    (await db.query({ connectionId: "demo", sql: "SELECT 9 n" })).rows[0].n,
    9,
  );
});

const rejectedReads = [
  "SELECT 1; DELETE FROM customers",
  "WITH d AS (DELETE FROM customers RETURNING *) SELECT * FROM d",
  "SELECT * INTO new_table FROM customers",
  "SELECT load_extension('bad')",
  "SELECT pg_sleep(1)",
  "SELECT dblink_exec('remote','DELETE FROM users')",
  'SELECT "pg_advisory_lock"(1)',
  "SELECT set_config('search_path','public',false)",
  "EXPLAIN ANALYZE SELECT 1",
  "SELECT * FROM orders FOR UPDATE",
  "SELECT 1 INTO OUTFILE '/tmp/out'",
  "/*! DELETE FROM customers */ SELECT 1",
  "SELECT nextval('sequence')",
  "CALL system()",
  "PRAGMA writable_schema=1",
  "SELECT 1; SELECT 2;",
  "SELECT 1 /* unclosed",
  "SELECT 'bad\\'value'",
  "SELECT sys_exec('ls')",
  "WITH q AS (SELECT 1) SELECT 1,pg_sleep(10)",
  "WITH q AS (SELECT 1) SELECT 1,evil_function()",
  "SELECT dbo.count()",
  "WITH a(x) AS (SELECT 1),b(y) AS (SELECT evil_function()) SELECT * FROM b",
];
for (const sql of rejectedReads)
  test(`SQL guard rejects ${sql.slice(0, 70)}`, () =>
    assert.throws(() => guardSql(sql, "read")));
for (const sql of [
  "SELECT 'DELETE; UPDATE' AS message; -- harmless",
  "SELECT sum(total),count(*) FROM orders",
  "WITH totals AS (SELECT currency,sum(total) revenue FROM orders GROUP BY currency) SELECT * FROM totals",
  "SELECT $$DELETE; DROP TABLE orders$$ AS literal",
  "SELECT cast(total AS DECIMAL(12,2)) FROM orders",
  "SELECT json_extract('{\"foo\":1}','$.foo') AS value",
])
  test(`SQL guard allows pure query ${sql.slice(0, 60)}`, () =>
    assert.ok(guardSql(sql, "read").sql));
for (const sql of [
  "DROP TABLE customers",
  "BEGIN; UPDATE customers SET name=1",
  "WITH x AS (SELECT 1) UPDATE customers SET name=1",
  "UPDATE customers SET name=(SELECT pg_sleep(1))",
  "UPDATE customers SET name=1;DELETE FROM orders",
])
  test(`SQL guard rejects unsafe write ${sql.slice(0, 60)}`, () =>
    assert.throws(() => guardSql(sql, "write")));
test("identifier quoting preserves arbitrary valid names and blocks controls", () => {
  assert.equal(quoteIdentifier('a"b'), '"a""b"');
  assert.equal(quoteIdentifier("a`b", "mysql"), "`a``b`");
  assert.equal(quoteIdentifier("a]b", "sqlserver"), "[a]]b]");
  assert.throws(() => quoteIdentifier("bad\0name"));
});
test("document commands reject server JavaScript, output stages, and prototype keys", () => {
  for (const sql of [
    '{"collection":"x","filter":{"$where":"true"}}',
    '{"pipeline":[{"$out":"x"}]}',
    '{"filter":{"__proto__":{"admin":true}}}',
    '{"pipeline":[{"$group":{"n":{"$accumulator":{}}}}]}',
  ])
    assert.throws(() => command(sql));
  assert.ok(
    command(
      '{"collection":"orders","operation":"find","filter":{"status":"paid"}}',
    ),
  );
});
test("Redis command permissions exclude scripts, global deletes, and unbounded ranges", () => {
  for (const c of [
    { command: "EVAL", args: ["return 1", "0"] },
    { command: "FLUSHALL", args: [] },
    { command: "SET", args: ["x", "y"] },
    { command: "LRANGE", args: ["x", "0", "-1"] },
    { command: "SCAN", args: ["0", "COUNT", "1000000000"] },
  ])
    assert.throws(() => redisCommand(JSON.stringify(c)));
  assert.equal(redisCommand('{"command":"GET","args":["test"]}').cmd, "GET");
  assert.equal(
    redisCommand('{"command":"SET","args":["test","value"]}', true).cmd,
    "SET",
  );
});

test("transport errors redact stored secrets and connection URLs", async () => {
  const vault = {
    set: () => {},
    get: () => ({
      password: "super-secret",
      connectionString: "postgres://user:pass@private/db",
    }),
    has: () => true,
  };
  const s = new DatabaseService({
    directory: path.join(directory, "error-test"),
    vault,
    drivers: {
      mock: {
        connect: async () => {
          throw new Error(
            "super-secret failure postgres://user:pass@private/db",
          );
        },
        close: async () => {},
      },
    },
  });
  await s.saveConnection(
    { name: "Error", id: "bad", driver: "mock" },
    {
      password: "super-secret",
      connectionString: "postgres://user:pass@private/db",
    },
  );
  await assert.rejects(s.connect("bad"), (e) => {
    assert.ok(!e.message.includes("super-secret"));
    assert.ok(!e.message.includes("user:pass"));
    return true;
  });
  await s.close();
});
