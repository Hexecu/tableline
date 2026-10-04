// Copyright (c) 2026 Davide Leopardi
// SPDX-License-Identifier: GPL-3.0-only

"use strict";
const { quoteIdentifier, tokenize } = require("../sql-guard.cjs");
const { preview, verifyRows, verifyAffected } = require("./write-preview.cjs");
const PG_TYPES = {
  16: "boolean",
  17: "bytea",
  20: "bigint",
  21: "smallint",
  23: "integer",
  25: "text",
  114: "json",
  700: "real",
  701: "double precision",
  1042: "char",
  1043: "varchar",
  1082: "date",
  1083: "time",
  1114: "timestamp",
  1184: "timestamptz",
  1700: "numeric",
  2950: "uuid",
  3802: "jsonb",
  1007: "integer[]",
  1009: "text[]",
};
const MYSQL_TYPES = {
  0: "decimal",
  1: "tinyint",
  2: "smallint",
  3: "integer",
  4: "float",
  5: "double",
  7: "timestamp",
  8: "bigint",
  9: "mediumint",
  10: "date",
  11: "time",
  12: "datetime",
  13: "year",
  16: "bit",
  245: "json",
  246: "decimal",
  249: "tinyblob",
  250: "mediumblob",
  251: "longblob",
  252: "text/blob",
  253: "varchar",
  254: "char",
  255: "geometry",
};

function boundedSql(sql, dialect, limit) {
  if (/^EXPLAIN\b/i.test(sql)) return sql;
  if (dialect === "sqlserver") {
    const tokens = tokenize(sql);
    let depth = 0,
      start = 0;
    for (const t of tokens) {
      if (t.value === "(") depth++;
      if (t.value === ")") depth--;
      if (depth === 0 && t.value === "SELECT") {
        start = t.start;
        break;
      }
    }
    const prefix = sql.slice(0, start),
      main = sql.slice(start);
    let order = false,
      offset = false,
      top = false;
    depth = 0;
    for (const t of tokens.filter((t) => t.start >= start)) {
      if (t.value === "(") depth++;
      if (t.value === ")") depth--;
      if (depth === 0 && t.value === "ORDER") order = true;
      if (depth === 0 && ["OFFSET", "FETCH"].includes(t.value)) offset = true;
      if (depth === 0 && t.value === "TOP") top = true;
    }
    return `${prefix}SELECT TOP (${limit + 1}) * FROM (${main}${order && !offset && !top ? " OFFSET 0 ROWS" : ""}) AS tableline_result`;
  }
  return `SELECT * FROM (${sql}) AS tableline_result LIMIT ${limit + 1}`;
}
function sslOptions(profile) {
  return profile.ssl === false
    ? false
    : {
        rejectUnauthorized: true,
        ...(profile.sslCA ? { ca: profile.sslCA } : {}),
      };
}
function mergeColumns(tables, columns, primary = []) {
  const lower = (row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key.toLowerCase(), value]),
    );
  tables = tables.map(lower);
  columns = columns.map(lower);
  primary = primary.map(lower);
  return tables.map((t) => ({
    name: t.table_name,
    schema: t.table_schema,
    kind: String(t.table_type).toLowerCase().includes("view")
      ? "view"
      : "table",
    columns: columns
      .filter(
        (c) =>
          c.table_name === t.table_name && c.table_schema === t.table_schema,
      )
      .map((c) => ({
        name: c.column_name,
        type: c.data_type || c.column_type,
        nullable: String(c.is_nullable).toUpperCase() === "YES",
        primaryKey: primary.some(
          (p) =>
            p.table_name === c.table_name &&
            p.table_schema === c.table_schema &&
            p.column_name === c.column_name,
        ),
      })),
  }));
}
const PRIMARY_SQL = `SELECT k.table_schema,k.table_name,k.column_name FROM information_schema.table_constraints t JOIN information_schema.key_column_usage k ON t.constraint_name=k.constraint_name AND t.table_schema=k.table_schema AND t.table_name=k.table_name WHERE t.constraint_type='PRIMARY KEY'`;

class PostgresDriver {
  constructor(profile, credentials) {
    this.profile = profile;
    this.credentials = credentials;
    this.dialect = "postgres";
    this.transactional = true;
  }
  async connect() {
    const { Client } = require("pg");
    const network = this.credentials.connectionString
      ? require("pg-connection-string").parse(this.credentials.connectionString)
      : {
          host: this.profile.host,
          port: this.profile.port || 5432,
          database: this.profile.database,
          user: this.profile.username,
          password: this.credentials.password,
        };
    this.client = new Client({
      ...network,
      ssl: sslOptions(this.profile),
      connectionTimeoutMillis: 10000,
      query_timeout: 30000,
      statement_timeout: 30000,
      application_name: "Tableline",
    });
    this.client.on("error", (e) => {
      this.connectionError = e;
    });
    this.client.on("end", () => {
      this.connectionError = new Error("PostgreSQL connection closed.");
    });
    await this.client.connect();
  }
  async read(sql, params = [], limit = 500) {
    if (!Array.isArray(params))
      throw new Error("PostgreSQL parameters must be an array ($1, $2).");
    await this.client.query("BEGIN READ ONLY");
    try {
      const result = await this.client.query(
        boundedSql(sql, this.dialect, limit),
        params,
      );
      return {
        columns: result.fields.map((f) => ({
          name: f.name,
          type: PG_TYPES[f.dataTypeID] || `type ${f.dataTypeID}`,
        })),
        rows: result.rows,
      };
    } finally {
      await this.client.query("ROLLBACK");
    }
  }
  async schema() {
    const tables = (
      await this.read(
        "SELECT table_schema,table_name,table_type FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY table_schema,table_name",
        [],
        10000,
      )
    ).rows;
    const columns = (
      await this.read(
        "SELECT table_schema,table_name,column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY ordinal_position",
        [],
        50000,
      )
    ).rows;
    const primary = (await this.read(PRIMARY_SQL, [], 50000)).rows;
    return mergeColumns(tables, columns, primary);
  }
  async preview(sql, params = []) {
    return preview(this, sql, params);
  }
  async write(
    sql,
    params = [],
    { rollback = false, expectedAffectedRows, validation } = {},
  ) {
    await this.client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    let begun = true;
    try {
      if (validation)
        verifyRows(
          (
            await this.client.query(
              `${validation.sql} FOR UPDATE`,
              validation.params,
            )
          ).rows,
          validation,
        );
      const result = await this.client.query(sql, params),
        affectedRows = result.rowCount;
      verifyAffected(affectedRows, expectedAffectedRows);
      await this.client.query(rollback ? "ROLLBACK" : "COMMIT");
      begun = false;
      return {
        columns: result.fields.map((f) => ({
          name: f.name,
          type: PG_TYPES[f.dataTypeID] || `type ${f.dataTypeID}`,
        })),
        rows: result.rows.slice(0, 100),
        affectedRows,
        rowCount: affectedRows,
      };
    } finally {
      if (begun) await this.client.query("ROLLBACK");
    }
  }
  async close() {
    await this.client?.end();
  }
}

class MySQLDriver {
  constructor(profile, credentials) {
    this.profile = profile;
    this.credentials = credentials;
    this.dialect = "mysql";
    this.transactional = true;
  }
  async connect() {
    const mysql = require("mysql2/promise");
    this.client = await mysql.createConnection({
      host: this.profile.host,
      port: this.profile.port || 3306,
      database: this.profile.database,
      user: this.profile.username,
      password: this.credentials.password,
      ssl: sslOptions(this.profile),
      connectTimeout: 10000,
      multipleStatements: false,
      enableKeepAlive: true,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
    this.client.on("error", (e) => {
      this.connectionError = e;
    });
    this.client.on("end", () => {
      this.connectionError = new Error("MySQL connection closed.");
    });
  }
  async read(sql, params = [], limit = 500) {
    if (!Array.isArray(params))
      throw new Error("MySQL parameters must be an array (?, ?).");
    await this.client.query("START TRANSACTION READ ONLY");
    try {
      const [rows, fields] = await this.client.execute(
        { sql: boundedSql(sql, this.dialect, limit), timeout: 30000 },
        params,
      );
      return {
        columns: fields.map((f) => ({
          name: f.name,
          type: MYSQL_TYPES[f.columnType] || `type ${f.columnType}`,
        })),
        rows,
      };
    } finally {
      await this.client.rollback();
    }
  }
  async schema() {
    const tables = (
      await this.read(
        "SELECT table_schema,table_name,table_type FROM information_schema.tables WHERE table_schema=? ORDER BY table_name",
        [this.profile.database],
        10000,
      )
    ).rows;
    const columns = (
      await this.read(
        "SELECT table_schema,table_name,column_name,data_type,is_nullable,column_key FROM information_schema.columns WHERE table_schema=? ORDER BY ordinal_position",
        [this.profile.database],
        50000,
      )
    ).rows;
    return mergeColumns(
      tables,
      columns,
      columns.filter((c) => (c.column_key ?? c.COLUMN_KEY) === "PRI"),
    );
  }
  async preview(sql, params = []) {
    return preview(this, sql, params);
  }
  async write(
    sql,
    params = [],
    { rollback = false, expectedAffectedRows, validation } = {},
  ) {
    // MyISAM and similar engines ignore rollback: refuse rather than offer a fake
    // preview. Triggers may target other engines, so check every user table.
    const [engines] = await this.client.execute(
      "SELECT table_name,engine FROM information_schema.tables WHERE table_schema=? AND table_type='BASE TABLE'",
      [this.profile.database],
    );
    if (engines.some((t) => !["InnoDB"].includes(t.engine ?? t.ENGINE)))
      throw new Error(
        "Write review requires all tables in this database to use InnoDB.",
      );
    await this.client.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
    await this.client.beginTransaction();
    let begun = true;
    try {
      if (validation) {
        const [rows] = await this.client.execute(
          `${validation.sql} FOR UPDATE`,
          validation.params,
        );
        verifyRows(rows, validation);
      }
      const [result, fields] = await this.client.execute(
          { sql, timeout: 30000 },
          params,
        ),
        affectedRows = Number(result.affectedRows ?? result.length);
      verifyAffected(affectedRows, expectedAffectedRows);
      await (rollback ? this.client.rollback() : this.client.commit());
      begun = false;
      return {
        columns: (fields || []).map((f) => ({
          name: f.name,
          type: MYSQL_TYPES[f.columnType] || `type ${f.columnType}`,
        })),
        rows: Array.isArray(result) ? result.slice(0, 100) : [],
        affectedRows,
        rowCount: affectedRows,
      };
    } finally {
      if (begun) await this.client.rollback();
    }
  }
  async close() {
    await this.client?.end();
  }
}

class SQLServerDriver {
  constructor(profile, credentials) {
    this.profile = profile;
    this.credentials = credentials;
    this.dialect = "sqlserver";
    this.transactional = true;
  }
  async connect() {
    this.mssql = require("mssql");
    this.pool = new this.mssql.ConnectionPool({
      server: this.profile.host,
      port: this.profile.port || 1433,
      database: this.profile.database,
      user: this.profile.username,
      password: this.credentials.password,
      options: {
        encrypt: this.profile.ssl !== false,
        trustServerCertificate: false,
      },
      connectionTimeout: 10000,
      requestTimeout: 30000,
      pool: { min: 0, max: 3, idleTimeoutMillis: 30000 },
    });
    this.pool.on("error", (e) => {
      this.connectionError = e;
    });
    await this.pool.connect();
  }
  request(transaction, params = []) {
    const r = transaction
      ? new this.mssql.Request(transaction)
      : this.pool.request();
    if (Array.isArray(params))
      params.forEach((value, i) => r.input(`p${i + 1}`, value));
    else
      for (const [name, value] of Object.entries(params)) {
        if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(name))
          throw new Error("Invalid SQL parameter name.");
        r.input(name, value);
      }
    return r;
  }
  async read(sql, params = [], limit = 500) {
    // SQL Server has no per-transaction READ ONLY option. Use the same strict
    // function/statement surface and require least-privilege server credentials.
    const result = await this.request(null, params).query(
      boundedSql(sql, this.dialect, limit),
    );
    return {
      columns: Object.values(result.recordset.columns).map((c) => ({
        name: c.name,
        type: c.type?.declaration,
      })),
      rows: result.recordset,
    };
  }
  async schema() {
    const tables = (
      await this.read(
        "SELECT table_schema,table_name,table_type FROM information_schema.tables WHERE table_schema NOT IN ('sys','INFORMATION_SCHEMA') ORDER BY table_schema,table_name",
        [],
        10000,
      )
    ).rows;
    const columns = (
      await this.read(
        "SELECT table_schema,table_name,column_name,data_type,is_nullable FROM information_schema.columns ORDER BY ordinal_position",
        [],
        50000,
      )
    ).rows;
    const primary = (await this.read(PRIMARY_SQL, [], 50000)).rows;
    return mergeColumns(tables, columns, primary);
  }
  async preview(sql, params = []) {
    return preview(this, sql, params);
  }
  async write(
    sql,
    params = [],
    { rollback = false, expectedAffectedRows, validation } = {},
  ) {
    const tx = new this.mssql.Transaction(this.pool);
    await tx.begin(this.mssql.ISOLATION_LEVEL.SERIALIZABLE);
    let begun = true;
    try {
      if (validation)
        verifyRows(
          (await this.request(tx, validation.params).query(validation.sql))
            .recordset,
          validation,
        );
      const result = await this.request(tx, params).query(sql),
        affectedRows = result.rowsAffected.reduce((a, b) => a + b, 0);
      verifyAffected(affectedRows, expectedAffectedRows);
      await (rollback ? tx.rollback() : tx.commit());
      begun = false;
      return {
        columns: Object.keys(result.recordset?.columns || {}).map((name) => ({
          name,
        })),
        rows: (result.recordset || []).slice(0, 100),
        affectedRows,
        rowCount: affectedRows,
      };
    } finally {
      if (begun) await tx.rollback();
    }
  }
  async close() {
    await this.pool?.close();
  }
}

class DatabricksDriver {
  constructor(profile, credentials) {
    this.profile = profile;
    this.credentials = credentials;
    this.dialect = "databricks";
    this.transactional = false;
  }
  async connect() {
    const { DBSQLClient } = require("@databricks/sql");
    this.client = new DBSQLClient({ logger: { log() {} } });
    this.client.on("error", (e) => {
      this.connectionError = e;
    });
    await this.client.connect({
      host: this.profile.host,
      path: this.profile.httpPath,
      token: this.credentials.token,
      telemetryEnabled: false,
      checkServerCertificate: true,
    });
    this.session = await this.client.openSession({
      initialCatalog: this.profile.catalog,
      initialSchema: this.profile.schema,
    });
  }
  async read(sql, params = [], limit = 500) {
    const operation = await this.session.executeStatement(
      boundedSql(sql, this.dialect, limit),
      {
        runAsync: true,
        maxRows: limit + 1,
        queryTimeout: 30,
        ...(Array.isArray(params)
          ? { ordinalParameters: params }
          : { namedParameters: params }),
      },
    );
    try {
      const rows = await operation.fetchAll();
      return {
        columns: Object.keys(rows[0] || {}).map((name) => ({ name })),
        rows,
      };
    } finally {
      await operation.close();
    }
  }
  async schema() {
    const catalog = this.profile.catalog
      ? quoteIdentifier(this.profile.catalog, "databricks") + "."
      : "";
    const tables = (
      await this.read(
        `SELECT table_schema,table_name,table_type FROM ${catalog}information_schema.tables WHERE table_schema NOT IN ('information_schema') ORDER BY table_schema,table_name`,
        [],
        10000,
      )
    ).rows;
    const columns = (
      await this.read(
        `SELECT table_schema,table_name,column_name,data_type,is_nullable FROM ${catalog}information_schema.columns ORDER BY ordinal_position`,
        [],
        50000,
      )
    ).rows;
    return mergeColumns(tables, columns);
  }
  async close() {
    await this.session?.close();
    await this.client?.close();
  }
}

class ClickHouseDriver {
  constructor(profile, credentials) {
    this.profile = profile;
    this.credentials = credentials;
    this.dialect = "clickhouse";
    this.transactional = false;
  }
  async connect() {
    const { createClient } = require("@clickhouse/client");
    const hostname = this.profile.host || "localhost";
    this.client = createClient({
      url: `${this.profile.ssl === false ? "http" : "https"}://${hostname}:${this.profile.port || 8443}`,
      database: this.profile.database || "default",
      username: this.profile.username || "default",
      password: this.credentials.password || "",
      request_timeout: 30000,
      log: { level: "OFF" },
      clickhouse_settings: {
        readonly: 1,
        max_execution_time: 30,
        max_result_rows: 10001,
        result_overflow_mode: "break",
      },
    });
    const ping = await this.client.ping();
    if (!ping.success) throw new Error("ClickHouse is unreachable.");
  }
  async read(sql, params = {}, limit = 500) {
    if (Array.isArray(params) && params.length)
      throw new Error("ClickHouse uses named typed parameters: {name:String}.");
    const result = await this.client.query({
      query: boundedSql(sql, this.dialect, limit),
      query_params: Array.isArray(params) ? {} : params,
      format: "JSON",
      clickhouse_settings: { readonly: 1, max_result_rows: limit + 1 },
    });
    const data = await result.json();
    return {
      columns: data.meta.map((c) => ({ name: c.name, type: c.type })),
      rows: data.data,
    };
  }
  async schema() {
    const tables = (
      await this.read(
        "SELECT database AS table_schema,name AS table_name,engine AS table_type FROM system.tables WHERE database={db:String} ORDER BY name",
        { db: this.profile.database || "default" },
        10000,
      )
    ).rows;
    const columns = (
      await this.read(
        "SELECT database AS table_schema,table AS table_name,name AS column_name,type AS data_type,if(startsWith(type,'Nullable'), 'YES', 'NO') AS is_nullable,is_in_primary_key FROM system.columns WHERE database={db:String} ORDER BY position",
        { db: this.profile.database || "default" },
        50000,
      )
    ).rows;
    return mergeColumns(
      tables,
      columns,
      columns.filter((c) => c.is_in_primary_key),
    );
  }
  async close() {
    await this.client?.close();
  }
}
module.exports = {
  PostgresDriver,
  MySQLDriver,
  SQLServerDriver,
  DatabricksDriver,
  ClickHouseDriver,
  boundedSql,
};
