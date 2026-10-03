"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { DatabaseService } = require("../electron/database.cjs");
const run = promisify(execFile),
  enabled = process.env.TABLELINE_DB_INTEGRATION === "1";
const names = [],
  services = [],
  fixtures = [];
let directory;
async function docker(args) {
  try {
    return (
      await run("docker", args, { maxBuffer: 1024 * 1024 })
    ).stdout.trim();
  } catch {
    throw new Error("Isolated database container operation failed.");
  }
}
async function fixture(engine) {
  const name = `tableline-${engine}-test-${crypto.randomUUID().slice(0, 8)}`,
    password = crypto.randomBytes(24).toString("hex");
  names.push(name);
  const port = engine === "postgres" ? 5432 : 3306;
  const vars =
    engine === "postgres"
      ? ["-e", `POSTGRES_PASSWORD=${password}`, "-e", "POSTGRES_DB=tableline"]
      : [
          "-e",
          `MYSQL_ROOT_PASSWORD=${password}`,
          "-e",
          "MYSQL_DATABASE=tableline",
        ];
  await docker([
    "run",
    "--rm",
    "-d",
    "--name",
    name,
    "-p",
    `127.0.0.1::${port}`,
    ...vars,
    engine === "postgres" ? "postgres:16-alpine" : "mysql:8.4",
  ]);
  const address = await docker(["port", name, `${port}/tcp`]),
    hostPort = Number(address.split(":").at(-1));
  let client;
  for (let i = 0; i < 90; i++) {
    try {
      if (engine === "postgres") {
        client = new (require("pg").Client)({
          host: "127.0.0.1",
          port: hostPort,
          user: "postgres",
          password,
          database: "tableline",
          connectionTimeoutMillis: 1000,
        });
        await client.connect();
      } else
        client = await require("mysql2/promise").createConnection({
          host: "127.0.0.1",
          port: hostPort,
          user: "root",
          password,
          database: "tableline",
          connectTimeout: 1000,
        });
      break;
    } catch {
      await client?.end().catch(() => {});
      client = null;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  if (!client) throw new Error(`${engine} did not become ready.`);
  const q = async (sql, params = []) =>
    engine === "postgres"
      ? (await client.query(sql, params)).rows
      : (await client.execute(sql, params))[0];
  await q(
    `CREATE TABLE customers(id ${engine === "postgres" ? "SERIAL PRIMARY KEY" : "INTEGER PRIMARY KEY AUTO_INCREMENT"},name VARCHAR(100) NOT NULL,email VARCHAR(200),country VARCHAR(10) NOT NULL)`,
  );
  for (let i = 1; i <= 127; i++)
    await q(
      `INSERT INTO customers(name,email,country) VALUES(${engine === "postgres" ? "$1,$2,$3" : "?,?,?"})`,
      [
        i === 3 ? "Léa · 東京" : `Customer ${i}`,
        i % 7 === 0 ? null : `hello${i}@example.com`,
        i % 2 ? "IT" : "FR",
      ],
    );
  const secrets = new Map(),
    vault = {
      get: (k) => secrets.get(k),
      set: (k, v) => secrets.set(k, v),
      has: (k) => secrets.has(k),
      delete: (k) => secrets.delete(k),
    };
  const service = new DatabaseService({
    directory: path.join(directory, engine),
    vault,
  });
  services.push(service);
  await service.saveConnection(
    {
      id: engine,
      name: `Isolated ${engine}`,
      driver: engine,
      host: "127.0.0.1",
      port: hostPort,
      database: "tableline",
      username: engine === "postgres" ? "postgres" : "root",
      tls: false,
      readOnly: false,
    },
    { password },
  );
  await service.connect(engine);
  const value = { engine, service, client, q, name };
  fixtures.push(value);
  return value;
}
if (enabled) {
  test.before(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "tableline-real-db-"));
  });
  test.after(async () => {
    for (const s of services) await s.close();
    for (const f of fixtures) await f.client.end().catch(() => {});
    for (const name of names) await docker(["rm", "-f", name]).catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  });
}
for (const engine of ["postgres", "mysql"])
  test(
    `real isolated ${engine}: schema, paging, injection, nonexecuting preview, race detection, commit`,
    { skip: !enabled, timeout: 180000 },
    async () => {
      const { service: s, q } = await fixture(engine),
        schema = await s.schema(engine);
      const customers = schema.find((t) => t.name === "customers");
      assert.ok(customers);
      assert.equal(
        customers.columns.find((c) => c.name === "id").primaryKey,
        true,
      );
      const p1 = await s.browse({
          connectionId: engine,
          table: "customers",
          limit: 50,
          sortColumn: "id",
        }),
        p2 = await s.browse({
          connectionId: engine,
          table: "customers",
          limit: 50,
          offset: 50,
          sortColumn: "id",
        });
      assert.equal(p1.total, 127);
      assert.equal(p1.rows[0].id, 1);
      assert.equal(p2.rows[0].id, 51);
      const unicode = await s.browse({
        connectionId: engine,
        table: "customers",
        search: "東京",
      });
      assert.equal(unicode.rows.length, 1);
      assert.equal(unicode.rows[0].id, 3);
      const injection = await s.browse({
        connectionId: engine,
        table: "customers",
        search: "' OR 1=1 --",
      });
      assert.equal(injection.rows.length, 0);
      await assert.rejects(
        s.query({
          connectionId: engine,
          sql: "SELECT 1; DELETE FROM customers",
        }),
      );
      const update =
        engine === "postgres"
          ? "UPDATE customers SET name=$1 WHERE id=$2"
          : "UPDATE customers SET name=? WHERE id=?";
      const proposal = await s.prepareWrite({
        connectionId: engine,
        sql: update,
        params: ["Reviewed", 1],
      });
      assert.equal(proposal.affectedRows, 1);
      assert.equal(proposal.previewRows[0].name, "Customer 1");
      assert.match(proposal.warning, /does not execute/);
      assert.equal(
        (await q("SELECT name FROM customers WHERE id=1"))[0].name,
        "Customer 1",
      );
      await s.commitWrite({ id: proposal.id });
      assert.equal(
        (await q("SELECT name FROM customers WHERE id=1"))[0].name,
        "Reviewed",
      );
      await assert.rejects(s.commitWrite({ id: proposal.id }));
      const race = await s.prepareWrite({
        connectionId: engine,
        sql: update,
        params: ["Must not apply", 2],
      });
      await q("UPDATE customers SET email='concurrent@example.com' WHERE id=2");
      await assert.rejects(s.commitWrite({ id: race.id }), /values changed/);
      assert.equal(
        (await q("SELECT name FROM customers WHERE id=2"))[0].name,
        "Customer 2",
      );
      const insert = await s.prepareWrite({
        connectionId: engine,
        sql: "INSERT INTO customers(name,email,country) VALUES ('Inserted',NULL,'IT')",
      });
      assert.equal(
        (await q("SELECT count(*) AS n FROM customers"))[0].n == 127,
        true,
      );
      if (engine === "postgres")
        assert.equal(
          Number(
            (await q("SELECT last_value FROM customers_id_seq"))[0].last_value,
          ),
          127,
        );
      else
        assert.equal(
          Number(
            (
              await q(
                "SELECT AUTO_INCREMENT n FROM information_schema.tables WHERE table_schema='tableline' AND table_name='customers'",
              )
            )[0].n,
          ),
          128,
        );
      await s.discardWrite({ id: insert.id });
      assert.equal(
        (await q("SELECT count(*) AS n FROM customers"))[0].n == 127,
        true,
      );
      const committedInsert = await s.prepareWrite({
        connectionId: engine,
        sql: "INSERT INTO customers(name,email,country) VALUES ('Inserted',NULL,'IT')",
      });
      assert.equal(
        (await s.commitWrite({ id: committedInsert.id })).affectedRows,
        1,
      );
      assert.equal(
        Number((await q("SELECT max(id) id FROM customers"))[0].id),
        128,
      );
      const del = await s.prepareWrite({
        connectionId: engine,
        sql: "DELETE FROM customers WHERE id=128",
      });
      assert.equal(del.affectedRows, 1);
      await s.commitWrite({ id: del.id });
      assert.equal(
        Number((await q("SELECT count(*) n FROM customers"))[0].n),
        127,
      );
      await assert.rejects(
        s.prepareWrite({ connectionId: engine, sql: "DELETE FROM customers" }),
        /WHERE clause/,
      );
      const metadata = await fs.readFile(
        path.join(directory, engine, "connections.json"),
        "utf8",
      );
      assert.ok(!metadata.includes("password"));
      assert.ok(!metadata.includes("MYSQL_ROOT_PASSWORD"));
    },
  );
