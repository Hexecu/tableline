// Copyright (c) 2026 Davide Leopardi
// SPDX-License-Identifier: GPL-3.0-only

"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  PostgresDriver,
  MySQLDriver,
  SQLServerDriver,
  DatabricksDriver,
  ClickHouseDriver,
  boundedSql,
} = require("../electron/drivers/sql.cjs");
const {
  MongoDriver,
  RedisDriver,
} = require("../electron/drivers/document.cjs");
const {
  previewSelect,
  fingerprint,
  verifyAffected,
  verifyRows,
} = require("../electron/drivers/write-preview.cjs");
const { DatabaseService } = require("../electron/database.cjs");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

test("PostgreSQL transport enforces read-only transactions and rollback on error", async () => {
  const d = new PostgresDriver({}, {}),
    calls = [];
  d.client = {
    query: async (sql, params) => {
      calls.push([sql, params]);
      if (sql.includes("tableline_result"))
        return { fields: [{ name: "n", dataTypeID: 23 }], rows: [{ n: 1 }] };
      return {};
    },
  };
  assert.equal((await d.read("SELECT $1 n", [1], 20)).rows[0].n, 1);
  assert.equal(calls[0][0], "BEGIN READ ONLY");
  assert.match(calls[1][0], /LIMIT 21$/);
  assert.equal(calls.at(-1)[0], "ROLLBACK");
  d.client.query = async (sql) => {
    calls.push([sql]);
    if (sql.includes("tableline_result")) throw new Error("syntax");
    return {};
  };
  await assert.rejects(d.read("SELECT broken"));
  assert.equal(calls.at(-1)[0], "ROLLBACK");
});
test("MySQL transport uses parameterized execution and read-only transaction", async () => {
  const calls = [],
    d = new MySQLDriver({ database: "test" }, {});
  d.client = {
    query: async (q) => calls.push(q),
    execute: async (q, p) => {
      calls.push([q, p]);
      return [[{ id: 1 }], [{ name: "id", columnType: 3 }]];
    },
    rollback: async () => calls.push("ROLLBACK"),
  };
  const result = await d.read("SELECT ? AS id", [1], 10);
  assert.equal(result.rows[0].id, 1);
  assert.equal(calls[0], "START TRANSACTION READ ONLY");
  assert.match(calls[1][0].sql, /LIMIT 11$/);
  assert.deepEqual(calls[1][1], [1]);
  assert.equal(calls.at(-1), "ROLLBACK");
});
test("remote write previews never execute DML or advance sequences", async () => {
  for (const Driver of [PostgresDriver, MySQLDriver, SQLServerDriver]) {
    const d = new Driver({ database: "test" }, {}),
      calls = [];
    d.read = async (sql, params) => {
      calls.push([sql, params]);
      return { rows: [{ id: 2, name: "Old" }], columns: [{ name: "id" }] };
    };
    const sql =
      d.dialect === "postgres"
        ? "UPDATE users SET name=$1 WHERE id=$2"
        : d.dialect === "sqlserver"
          ? "UPDATE users SET name=@p1 WHERE id=@p2"
          : "UPDATE users SET name=? WHERE id=?";
    const p = await d.preview(sql, ["New", 2]);
    assert.equal(p.affectedRows, 1);
    assert.match(calls[0][0], /^SELECT \* FROM users WHERE/);
    assert.match(p.warning, /does not execute/);
    assert.ok(p.validation.fingerprint);
    calls.length = 0;
    const insert = await d.preview(
      "INSERT INTO users(name) VALUES ('new')",
      [],
    );
    assert.equal(insert.affectedRows, undefined);
    assert.equal(calls.length, 0);
  }
});
test("write estimates remap native WHERE parameters and reject ambiguous write grammar", () => {
  assert.deepEqual(
    previewSelect(
      "UPDATE public.users SET name=$1 WHERE id=$2 AND country=$3 RETURNING id",
      ["New", 2, "IT"],
      "postgres",
    ),
    {
      sql: "SELECT * FROM public.users WHERE id=$1 AND country=$2 ",
      params: [2, "IT"],
    },
  );
  assert.deepEqual(
    previewSelect(
      "UPDATE `users` SET name=? WHERE id=? AND note='?'",
      ["New", 2],
      "mysql",
    ),
    { sql: "SELECT * FROM `users` WHERE id=? AND note='?'", params: [2] },
  );
  assert.deepEqual(
    previewSelect(
      "UPDATE users SET name='literal' WHERE id=? AND country='IT'",
      [4],
      "mysql",
    ),
    { sql: "SELECT * FROM users WHERE id=? AND country='IT'", params: [4] },
  );
  assert.deepEqual(
    previewSelect(
      "DELETE FROM [users] WHERE id=@target",
      { target: 4 },
      "sqlserver",
    ),
    { sql: "SELECT * FROM [users] WHERE id=@target", params: { target: 4 } },
  );
  for (const sql of [
    "UPDATE users SET name=1",
    "DELETE FROM users",
    "UPDATE users u SET name=1 WHERE id=2",
    "UPDATE users SET name=1 FROM other WHERE users.id=other.id",
    "DELETE FROM users WHERE id=1 LIMIT 1",
  ])
    assert.throws(() => previewSelect(sql, [], "postgres"));
});
test("fingerprints detect changed values independent of row/key order", () => {
  const a = [
      { id: 1, name: "A" },
      { id: 2, name: "B" },
    ],
    b = [
      { name: "B", id: 2 },
      { name: "A", id: 1 },
    ];
  assert.equal(fingerprint(a), fingerprint(b));
  verifyRows(b, { fingerprint: fingerprint(a) });
  assert.throws(
    () =>
      verifyRows([{ id: 1, name: "Changed" }], { fingerprint: fingerprint(a) }),
    /values changed/,
  );
  assert.throws(() => verifyAffected(5001, undefined), /commit limit/);
  assert.throws(() => verifyAffected(4, 3), /rows changed/);
});
test("PostgreSQL commit locks and fingerprints before mutation and rolls back on mismatch", async () => {
  const d = new PostgresDriver({}, {}),
    calls = [];
  const validation = {
    sql: "SELECT * FROM users WHERE id=$1",
    params: [1],
    fingerprint: fingerprint([{ id: 1, name: "Original" }]),
  };
  d.client = {
    query: async (sql) => {
      calls.push(sql);
      if (sql.endsWith("FOR UPDATE"))
        return { rows: [{ id: 1, name: "Concurrent" }] };
      return {};
    },
  };
  await assert.rejects(
    d.write("UPDATE users SET name='New' WHERE id=1", [], {
      expectedAffectedRows: 1,
      validation,
    }),
    /values changed/,
  );
  assert.match(calls[0], /SERIALIZABLE/);
  assert.ok(!calls.some((s) => s.startsWith("UPDATE")));
  assert.equal(calls.at(-1), "ROLLBACK");
});
test("MySQL refuses nontransactional table engines before writing", async () => {
  const d = new MySQLDriver({ database: "test" }, {});
  let began = false;
  d.client = {
    execute: async () => [[{ table_name: "audit", engine: "MyISAM" }]],
    beginTransaction: async () => {
      began = true;
    },
  };
  await assert.rejects(d.write("UPDATE users SET name=1 WHERE id=1"), /InnoDB/);
  assert.equal(began, false);
});
test("SQL Server bounded SELECT keeps ORDER BY and CTEs legal in derived tables", () => {
  assert.equal(
    boundedSql("SELECT id FROM users ORDER BY id", "sqlserver", 10),
    "SELECT TOP (11) * FROM (SELECT id FROM users ORDER BY id OFFSET 0 ROWS) AS tableline_result",
  );
  const cte = boundedSql(
    "WITH x AS (SELECT id FROM users) SELECT * FROM x ORDER BY id",
    "sqlserver",
    5,
  );
  assert.match(cte, /^WITH x AS \(SELECT id FROM users\) SELECT TOP \(6\)/);
  assert.match(cte, /OFFSET 0 ROWS/);
  assert.ok(
    !boundedSql(
      "SELECT TOP 20 id FROM users ORDER BY id",
      "sqlserver",
      10,
    ).includes("OFFSET"),
  );
  assert.equal(
    (
      boundedSql(
        "SELECT * FROM users ORDER BY id OFFSET 2 ROWS FETCH NEXT 2 ROWS ONLY",
        "sqlserver",
        10,
      ).match(/OFFSET/g) || []
    ).length,
    1,
  );
});
test("SQL Server transport exposes columns and named native parameters", async () => {
  const d = new SQLServerDriver({}, {});
  let got;
  d.request = (tx, p) => ({
    query: async (sql) => {
      got = { tx, p, sql };
      const recordset = [{ id: 1 }];
      recordset.columns = { id: { name: "id", type: { declaration: "int" } } };
      return { recordset };
    },
  });
  const r = await d.read("SELECT @p1 id", [1], 3);
  assert.deepEqual(got.p, [1]);
  assert.equal(r.columns[0].type, "int");
  assert.match(got.sql, /TOP \(4\)/);
});
test("Databricks v2 transport binds parameters, bounds rows, and always closes operation", async () => {
  assert.equal(typeof require("@databricks/sql").DBSQLClient, "function");
  const d = new DatabricksDriver({}, {});
  let call,
    closed = 0;
  d.session = {
    executeStatement: async (sql, opts) => {
      call = { sql, opts };
      return {
        fetchAll: async () => [{ value: 1 }],
        close: async () => closed++,
      };
    },
  };
  const r = await d.read("SELECT ? value", [1], 5);
  assert.equal(r.rows[0].value, 1);
  assert.deepEqual(call.opts.ordinalParameters, [1]);
  assert.match(call.sql, /LIMIT 6$/);
  assert.equal(closed, 1);
  d.session.executeStatement = async () => ({
    fetchAll: async () => {
      throw new Error("fetch failed");
    },
    close: async () => closed++,
  });
  await assert.rejects(d.read("SELECT 1"), /fetch failed/);
  assert.equal(closed, 2);
});
test("ClickHouse sends server-enforced readonly settings and typed parameters", async () => {
  const d = new ClickHouseDriver({}, {});
  let call;
  d.client = {
    query: async (c) => {
      call = c;
      return {
        json: async () => ({
          meta: [{ name: "name", type: "String" }],
          data: [{ name: "A" }],
        }),
      };
    },
  };
  const r = await d.read("SELECT {name:String} AS name", { name: "A" }, 5);
  assert.equal(call.clickhouse_settings.readonly, 1);
  assert.equal(call.query_params.name, "A");
  assert.equal(r.columns[0].type, "String");
  await assert.rejects(d.read("SELECT ?", [1]), /named typed/);
});
test("MongoDB aggregate whitelist allows grouping and rejects nested output JavaScript", async () => {
  const d = new MongoDriver({}, {});
  let pipeline;
  d.db = {
    collection: () => ({
      aggregate: (p) => {
        pipeline = p;
        return { toArray: async () => [{ count: 2 }] };
      },
    }),
  };
  const r = await d.read(
    JSON.stringify({
      collection: "orders",
      operation: "aggregate",
      pipeline: [
        { $match: { status: "paid" } },
        { $group: { _id: "$currency", count: { $sum: 1 } } },
      ],
    }),
    [],
    5,
  );
  assert.equal(r.rows[0].count, 2);
  assert.deepEqual(pipeline.at(-1), { $limit: 6 });
  for (const stage of [
    { $out: "x" },
    { $merge: "x" },
    { $group: { n: { $accumulator: {} } } },
    { $facet: { x: [{ $out: "y" }] } },
  ])
    await assert.rejects(
      d.read(
        JSON.stringify({
          collection: "orders",
          operation: "aggregate",
          pipeline: [stage],
        }),
      ),
    );
});
test("Redis sends only known commands, normalizes hash output, and returns scan cursor", async () => {
  const d = new RedisDriver({}, {});
  d.client = {
    sendCommand: async (c) =>
      c[0] === "HGETALL" ? ["field", "value"] : ["17", ["key"]],
    scan: async (cursor) => ({
      cursor: cursor === "0" ? "23" : "0",
      keys: ["key"],
    }),
    type: async () => "string",
    ttl: async () => 60,
  };
  assert.deepEqual(
    (await d.read('{"command":"HGETALL","args":["key"]}')).rows,
    [{ field: "field", value: "value" }],
  );
  const a = await d.browse({ limit: 1 });
  assert.match(a.cursor, /^r_/);
  const b = await d.browse({ cursor: a.cursor, offset: 1, limit: 1 });
  assert.equal(b.cursor, "0");
  await assert.rejects(d.read('{"command":"FLUSHDB","args":[]}'));
});
test("Redis browse retains advisory SCAN overflow and supports stable cursor replay", async () => {
  const d = new RedisDriver({}, {});
  let scans = 0;
  d.client = {
    scan: async () => {
      scans++;
      return { cursor: "0", keys: ["one", "two", "three"] };
    },
    type: async () => "string",
    ttl: async () => 30,
  };
  const a = await d.browse({ limit: 1 });
  const b = await d.browse({ limit: 1, cursor: a.cursor });
  const repeat = await d.browse({ limit: 1, cursor: a.cursor });
  const c = await d.browse({ limit: 1, cursor: b.cursor });
  assert.deepEqual(
    [a, b, c].flatMap((p) => p.rows.map((r) => r.key)),
    ["one", "two", "three"],
  );
  assert.equal(scans, 1);
  assert.equal(c.cursor, "0");
  assert.deepEqual(b.rows, repeat.rows);
  await assert.rejects(
    d.browse({ limit: 1, cursor: a.cursor, search: "changed" }),
    /search changed/,
  );
});
test("Redis browse enforces its cumulative key cap while draining later batches", async () => {
  const d = new RedisDriver({}, {});
  d.client = {
    scan: async (cursor) => ({
      cursor: cursor === "0" ? "17" : "0",
      keys:
        cursor === "0"
          ? Array.from({ length: 10000 }, (_, i) => `key${i}`)
          : ["overflow"],
    }),
    type: async () => "string",
    ttl: async () => 30,
  };
  const first = await d.browse({ limit: 10000 });
  assert.equal(first.rows.length, 10000);
  await assert.rejects(
    d.browse({ cursor: first.cursor, limit: 1 }),
    /exceeds 10000/,
  );
});
test("Redis large collection preflight and scan count keep reads bounded", async () => {
  const d = new RedisDriver({}, {});
  let executed = false;
  d.client = {
    sendCommand: async (args) => {
      if (args[0] === "HLEN") return 10001;
      executed = true;
      return [];
    },
  };
  await assert.rejects(
    d.read('{"command":"HGETALL","args":["huge"]}'),
    /Use HSCAN/,
  );
  assert.equal(executed, false);
});
test("testConnection closes an isolated adapter and does not save metadata, secrets, or proposals", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tableline-probe-test-"));
  let vaultWrites = 0,
    closed = 0;
  const instances = [];
  const s = new DatabaseService({
    directory: dir,
    vault: { set: () => vaultWrites++ },
    drivers: {
      mock: {
        create: () => {
          const a = {
            connect: async () => {},
            read: async () => ({
              rows: [{ connected: 1 }],
              columns: [{ name: "connected" }],
            }),
            close: async () => closed++,
          };
          instances.push(a);
          return a;
        },
      },
    },
  });
  try {
    const result = await s.testConnection(
      { id: "unsaved", name: "Probe", driver: "mock" },
      { password: "local-test" },
    );
    assert.equal(result.status, "connected");
    assert.equal(closed, 1);
    assert.equal(vaultWrites, 0);
    assert.equal(s.adapters.size, 0);
    assert.equal(s.proposals.size, 0);
    assert.deepEqual(await s.connections(), []);
    await assert.rejects(fs.access(path.join(dir, "connections.json")));
  } finally {
    await s.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test("result and remote preview caps count UTF-8 bytes for Unicode data", async () => {
  const rows = [{ value: "東".repeat(4 * 1024 * 1024) }];
  const service = new DatabaseService({
    directory: path.join(os.tmpdir(), "tableline-size-test"),
  });
  assert.throws(
    () => service.output({ rows, columns: [{ name: "value" }] }, 1, 0),
    /exceeds 10 MB/,
  );
  const driver = new PostgresDriver({}, {});
  driver.read = async () => ({ rows, columns: [{ name: "value" }] });
  await assert.rejects(
    driver.preview("UPDATE users SET name='New' WHERE id=1", []),
    /preview exceeds 10 MB/,
  );
});
test("Redis shutdown rejects a blocked read and destroys its client promptly", async () => {
  let destroyed = 0;
  const driver = new RedisDriver({}, {});
  driver.client = {
    sendCommand: () => new Promise(() => {}),
    destroy: () => destroyed++,
  };
  const service = new DatabaseService({
    directory: "/unused-shutdown-fixture",
  });
  service.initialized = Promise.resolve();
  service.profiles = [
    { id: "redis", driver: "redis", name: "Redis", readOnly: true },
  ];
  service.adapters.set("redis", driver);
  const query = service.query({
    connectionId: "redis",
    sql: '{"command":"GET","args":["key"]}',
  });
  const rejected = assert.rejects(query, /closing/);
  await new Promise((resolve) => setImmediate(resolve));
  const start = performance.now();
  await service.close();
  await rejected;
  assert(performance.now() - start < 500);
  assert(destroyed >= 1);
  assert(driver.connectionError);
  assert.equal(driver.pending.size, 0);
});
test("Redis timeout marks the client disconnected and the next explicit query reconnects", async () => {
  let generation = 0,
    destroyed = 0;
  const create = () => {
    const driver = new RedisDriver({}, {}),
      current = ++generation;
    driver.commandTimeoutMs = 20;
    driver.connect = async () => {
      driver.client = {
        sendCommand: async (args) =>
          current === 1
            ? new Promise(() => {})
            : args[0] === "STRLEN"
              ? 2
              : "OK",
        destroy: () => destroyed++,
      };
    };
    return driver;
  };
  const service = new DatabaseService({
    directory: "/unused-redis-reconnect-fixture",
    drivers: { redis: { create } },
  });
  service.initialized = Promise.resolve();
  service.profiles = [
    { id: "redis", driver: "redis", name: "Redis", readOnly: true },
  ];
  try {
    await assert.rejects(
      service.query({
        connectionId: "redis",
        sql: '{"command":"GET","args":["key"]}',
      }),
      /timed out/,
    );
    assert.equal((await service.connections())[0].status, "disconnected");
    const result = await service.query({
      connectionId: "redis",
      sql: '{"command":"GET","args":["key"]}',
    });
    assert.equal(result.rows[0].value, "OK");
    assert.equal(generation, 2);
    assert(destroyed >= 1);
  } finally {
    await service.close();
  }
});
test("Redis shutdown does not abort an active write and waits for its acknowledgement", async () => {
  let acknowledge,
    destroyed = 0,
    closed = false;
  const driver = new RedisDriver({}, {});
  driver.client = {
    sendCommand: () =>
      new Promise((resolve) => {
        acknowledge = resolve;
      }),
    destroy: () => destroyed++,
  };
  const write = driver.write('{"command":"SET","args":["key","value"]}');
  await new Promise((resolve) => setImmediate(resolve));
  await driver.abortReads();
  const closure = driver.close().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(closed, false);
  assert.equal(destroyed, 0);
  acknowledge("OK");
  assert.equal((await write).rows[0].result, "OK");
  await closure;
  assert.equal(closed, true);
  assert.equal(destroyed, 1);
});
test("Redis write timeout reports uncertain outcome without retrying the command", async () => {
  let commands = 0,
    destroyed = 0;
  const driver = new RedisDriver({}, {});
  driver.commandTimeoutMs = 20;
  driver.client = {
    sendCommand: () => {
      commands++;
      return new Promise(() => {});
    },
    destroy: () => destroyed++,
  };
  await assert.rejects(
    driver.write('{"command":"SET","args":["key","value"]}'),
    /outcome is uncertain/,
  );
  assert.equal(commands, 1);
  assert.equal(destroyed, 1);
  assert(driver.connectionError);
});
