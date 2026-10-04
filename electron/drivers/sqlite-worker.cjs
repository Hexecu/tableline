// Copyright (c) 2026 Davide Leopardi
// SPDX-License-Identifier: GPL-3.0-only

"use strict";
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");
const { quoteIdentifier } = require("../sql-guard.cjs");

class SQLiteDriver {
  constructor(profile) {
    this.profile = profile;
    this.dialect = "sqlite";
    this.transactional = true;
  }
  async connect() {
    const filename = this.profile.filePath || this.profile.database;
    if (!filename || filename === ":memory:")
      throw new Error("Choose an existing SQLite database file.");
    if (!path.isAbsolute(filename))
      throw new Error("SQLite needs an absolute file path.");
    if (!fs.existsSync(filename) || !fs.statSync(filename).isFile())
      throw new Error("SQLite database file does not exist.");
    this.db = new DatabaseSync(filename, {
      readOnly: this.profile.readOnly !== false,
      enableForeignKeyConstraints: true,
      allowExtension: false,
    });
    this.db.exec(
      "PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;",
    );
  }
  async read(sql, params = [], limit = 500) {
    this.db.exec("PRAGMA query_only=ON");
    const statement = this.db.prepare(sql);
    statement.setReadBigInts?.(true);
    const rows = [];
    for (const row of Array.isArray(params)
      ? statement.iterate(...params)
      : statement.iterate(params)) {
      rows.push(row);
      if (rows.length > limit) break;
    }
    const columns =
      statement
        .columns?.()
        .map((c) => ({ name: c.name, type: c.type || undefined })) ||
      Object.keys(rows[0] || {}).map((name) => ({ name }));
    return { columns, rows };
  }
  async schema() {
    const tables = await this.read(
      "SELECT name,type FROM sqlite_schema WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
      [],
      10000,
    );
    return tables.rows.map((table) => {
      const columns = this.db
        .prepare(`PRAGMA table_info(${quoteIdentifier(table.name)})`)
        .all()
        .map((c) => ({
          name: c.name,
          type: c.type || "ANY",
          nullable: !c.notnull && !c.pk,
          primaryKey: !!c.pk,
        }));
      let rowCount;
      if (table.type === "table")
        rowCount = this.db
          .prepare(`SELECT count(*) AS n FROM ${quoteIdentifier(table.name)}`)
          .get().n;
      return {
        name: table.name,
        schema: "main",
        kind: table.type,
        columns,
        rowCount,
      };
    });
  }
  async write(
    sql,
    params = [],
    { rollback = false, expectedAffectedRows } = {},
  ) {
    this.db.exec("PRAGMA query_only=OFF");
    let begun = false;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      begun = true;
      const statement = this.db.prepare(sql);
      statement.setReadBigInts?.(true);
      // SQLite returns rows only for RETURNING, but iterating also executes DML.
      const rows = Array.isArray(params)
        ? statement.all(...params)
        : statement.all(params);
      const affectedRows = Number(
        this.db.prepare("SELECT changes() AS n").get().n,
      );
      if (
        expectedAffectedRows !== undefined &&
        affectedRows !== expectedAffectedRows
      )
        throw new Error(
          "Affected rows changed since preview. Review the write again.",
        );
      this.db.exec(rollback ? "ROLLBACK" : "COMMIT");
      begun = false;
      return {
        columns: Object.keys(rows[0] || {}).map((name) => ({ name })),
        rows: rows.slice(0, 100),
        affectedRows,
        rowCount: affectedRows,
      };
    } finally {
      if (begun) {
        try {
          this.db.exec("ROLLBACK");
        } catch {}
      }
      this.db.exec("PRAGMA query_only=ON");
    }
  }
  async close() {
    this.db?.close();
  }
}
if (process.send) {
  // A separate thread can observe parent death even while the main child thread
  // is blocked inside a native SQLite aggregate, preventing orphan CPU work.
  const { Worker } = require("node:worker_threads");
  const watchdog = new Worker(
    `const {workerData}=require('node:worker_threads');setInterval(()=>{try{process.kill(workerData.parent,0);}catch(e){if(e.code==='ESRCH')process.kill(workerData.child,'SIGKILL');}},1000);`,
    { eval: true, workerData: { parent: process.ppid, child: process.pid } },
  );
  watchdog.unref();
  process.on("disconnect", () => process.exit(0));
  let driver;
  process.on("message", async ({ id, action, args }) => {
    try {
      if (action === "connect") {
        driver = new SQLiteDriver(args[0]);
        args = [];
      }
      const value = await driver[action](...args);
      process.send({ id, value });
    } catch (e) {
      process.send({ id, error: e.message });
    }
  });
}
module.exports = { SQLiteDriver };
