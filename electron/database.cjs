// Copyright (c) 2026 Davide Leopardi
// SPDX-License-Identifier: GPL-3.0-only

"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { guardSql, quoteIdentifier } = require("./sql-guard.cjs");
const { SQLiteDriver } = require("./drivers/sqlite.cjs");
const {
  PostgresDriver,
  MySQLDriver,
  SQLServerDriver,
  DatabricksDriver,
  ClickHouseDriver,
} = require("./drivers/sql.cjs");
const { MongoDriver, RedisDriver } = require("./drivers/document.cjs");
const { createDemo } = require("./drivers/demo-fixture.cjs");

function descriptor(id, name, family, defaultPort, fields, extra = {}) {
  const transactional = ["sqlite", "postgres", "mysql", "sqlserver"].includes(
    family,
  );
  const write = transactional || ["mongodb", "redis"].includes(family);
  return {
    id,
    name,
    family,
    defaultPort,
    fields,
    capabilities: {
      read: true,
      sql: !["mongodb", "redis"].includes(family),
      schema: true,
      browse: true,
      write,
      guardedWrites: write,
      transactions: transactional,
      transactional,
      cancel: family === "sqlite",
      writePreview:
        family === "sqlite" ? "rollback" : write ? "estimate" : "unsupported",
      parameters:
        family === "postgres"
          ? "$1"
          : family === "sqlserver"
            ? "@p1"
            : family === "clickhouse"
              ? "{name:Type}"
              : "?",
      ...extra,
    },
  };
}
const NETWORK_FIELDS = [
  "host",
  "port",
  "database",
  "username",
  "password",
  "ssl",
];
const CATALOG = [
  descriptor("sqlite", "SQLite", "sqlite", null, ["filePath"]),
  descriptor("postgres", "PostgreSQL", "postgres", 5432, NETWORK_FIELDS),
  descriptor(
    "aurora-postgresql",
    "Amazon Aurora · PostgreSQL",
    "postgres",
    5432,
    NETWORK_FIELDS,
  ),
  descriptor("redshift", "Amazon Redshift", "postgres", 5439, NETWORK_FIELDS, {
    write: false,
    guardedWrites: false,
    transactions: false,
    transactional: false,
    writePreview: "unsupported",
    note: "Read access only. Redshift transactional preview is not verified.",
  }),
  descriptor("cockroachdb", "CockroachDB", "postgres", 26257, NETWORK_FIELDS),
  descriptor("mysql", "MySQL", "mysql", 3306, NETWORK_FIELDS),
  descriptor("mariadb", "MariaDB", "mysql", 3306, NETWORK_FIELDS),
  descriptor(
    "aurora-mysql",
    "Amazon Aurora · MySQL",
    "mysql",
    3306,
    NETWORK_FIELDS,
  ),
  descriptor(
    "databricks",
    "Databricks SQL",
    "databricks",
    443,
    ["host", "httpPath", "catalog", "schema", "token"],
    {
      note: "SQL warehouse required. Write review disabled: rollback preview is unavailable.",
    },
  ),
  descriptor(
    "sqlserver",
    "Microsoft SQL Server",
    "sqlserver",
    1433,
    NETWORK_FIELDS,
    {
      readOnlyEnforced: false,
      note: "Use a read-only database principal for server-enforced read isolation.",
    },
  ),
  descriptor("clickhouse", "ClickHouse", "clickhouse", 8443, NETWORK_FIELDS, {
    note: "Server readonly=1; asynchronous mutations are disabled.",
  }),
  descriptor(
    "mongodb",
    "MongoDB",
    "mongodb",
    27017,
    [
      "host",
      "port",
      "database",
      "username",
      "password",
      "connectionString",
      "ssl",
    ],
    {
      parameters: "JSON",
      note: "Collections use JSON commands. Preview estimates matches; multi-document writes can partially succeed and cannot be rolled back.",
    },
  ),
  descriptor(
    "redis",
    "Redis",
    "redis",
    6379,
    [
      "host",
      "port",
      "database",
      "username",
      "password",
      "connectionString",
      "ssl",
    ],
    {
      parameters: "JSON",
      note: "Keys use bounded JSON commands. Write preview shows current key metadata and cannot be rolled back.",
    },
  ),
];
const DRIVER_TYPES = {
  sqlite: SQLiteDriver,
  postgres: PostgresDriver,
  mysql: MySQLDriver,
  sqlserver: SQLServerDriver,
  databricks: DatabricksDriver,
  clickhouse: ClickHouseDriver,
  mongodb: MongoDriver,
  redis: RedisDriver,
};
const PROFILE_KEYS = new Set(
  "id name driver host port database username filePath httpPath catalog schema ssl tls sslCA color readOnly".split(
    " ",
  ),
);
const SECRET_KEYS = new Set(["password", "token", "connectionString"]);
function normalize(value, seen = new Set()) {
  if (typeof value === "bigint")
    return value <= BigInt(Number.MAX_SAFE_INTEGER) &&
      value >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array)
    return `0x${Buffer.from(value).toString("hex")}`;
  if (value?.toHexString) return value.toHexString();
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  const out = Array.isArray(value)
    ? value.map((v) => normalize(v, seen))
    : Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, normalize(v, seen)]),
      );
  seen.delete(value);
  return out;
}
function limitValue(value, fallback = 500, max = 10000) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max)
    throw new Error(`Limit must be between 1 and ${max}.`);
  return n;
}
function validateParams(params) {
  if (params === undefined) return [];
  if (!params || typeof params !== "object")
    throw new Error("Parameters must be an array or named object.");
  if (JSON.stringify(params).length > 100000)
    throw new Error("Parameters are too large.");
  if (
    Object.values(params).some(
      (v) => v !== null && !["string", "number", "boolean"].includes(typeof v),
    )
  )
    throw new Error("Parameters must be scalar values.");
  return structuredClone(params);
}

class DatabaseService {
  constructor({ directory, vault, drivers = {} } = {}) {
    if (!directory)
      throw new Error("DatabaseService requires a storage directory.");
    this.directory = directory;
    this.file = path.join(directory, "connections.json");
    this.vault = vault;
    this.customDrivers = drivers;
    this.profiles = [];
    this.adapters = new Map();
    this.secrets = new Map();
    this.proposals = new Map();
    this.tails = new Map();
    this.initialized = null;
    this.revisions = new Map();
    this.closeTimeoutMs = 5000;
  }
  async init() {
    if (!this.initialized)
      this.initialized = (async () => {
        await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
        try {
          const parsed = JSON.parse(await fs.readFile(this.file, "utf8"));
          if (
            !Array.isArray(parsed) ||
            parsed.some(
              (p) => !p || typeof p !== "object" || !p.id || !p.driver,
            )
          )
            throw new Error("Invalid connections metadata.");
          if (
            parsed.some((p) => Object.keys(p).some((k) => SECRET_KEYS.has(k)))
          )
            throw new Error("Unsafe credentials found in connection metadata.");
          this.profiles = parsed;
          await fs.chmod(this.file, 0o600);
        } catch (e) {
          if (e.code !== "ENOENT")
            throw new Error(`Could not read saved connections: ${e.message}`);
        }
      })();
    return this.initialized;
  }
  async serial(key, fn) {
    const previous = this.tails.get(key) || Promise.resolve();
    const task = previous.catch(() => {}).then(fn);
    this.tails.set(key, task);
    try {
      return await task;
    } finally {
      if (this.tails.get(key) === task) this.tails.delete(key);
    }
  }
  async persist() {
    const temp = `${this.file}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, JSON.stringify(this.profiles, null, 2) + "\n", {
        mode: 0o600,
        flag: "wx",
      });
      await fs.rename(temp, this.file);
      await fs.chmod(this.file, 0o600);
    } finally {
      await fs.unlink(temp).catch(() => {});
    }
  }
  async catalog() {
    return structuredClone(CATALOG).concat(
      Object.keys(this.customDrivers)
        .filter((id) => !CATALOG.some((c) => c.id === id))
        .map(
          (id) =>
            this.customDrivers[id].descriptor ||
            descriptor(id, id, "custom", null, [], {
              write: true,
              transactions: true,
              transactional: true,
              writePreview: "rollback",
            }),
        ),
    );
  }
  describe(profile) {
    return (
      CATALOG.find((c) => c.id === profile.driver) ||
      this.customDrivers[profile.driver]?.descriptor ||
      descriptor(profile.driver, profile.driver, "custom", null, [], {
        write: true,
        transactions: true,
        transactional: true,
        writePreview: "rollback",
      })
    );
  }
  profile(id) {
    const p = this.profiles.find((p) => p.id === id);
    if (!p) throw new Error("Connection not found.");
    return p;
  }
  async connections() {
    await this.init();
    return Promise.all(
      this.profiles.map(async (p) => {
        const hasCredential =
          Object.keys(this.secrets.get(p.id) || {}).length > 0 ||
          (this.vault?.has ? await this.vault.has(`db-${p.id}`) : false);
        const adapter = this.adapters.get(p.id);
        return {
          ...p,
          tls: p.ssl !== false,
          status:
            adapter && !adapter.connectionError ? "connected" : "disconnected",
          credentialConfigured: hasCredential,
          hasCredential,
          capabilities: this.describe(p).capabilities,
        };
      }),
    );
  }
  async saveConnection(profile, credentials = {}) {
    await this.init();
    return this.serial("metadata", async () => {
      if (!profile || typeof profile !== "object")
        throw new Error("Expected a connection profile.");
      const id = profile.id || crypto.randomUUID();
      if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(id))
        throw new Error("Invalid connection ID.");
      const driver = profile.driver || profile.type;
      const catalog = await this.catalog(),
        d = catalog.find((c) => c.id === driver);
      if (!d) throw new Error("Choose a supported database driver.");
      const name = String(profile.name || "").trim();
      if (!name || name.length > 100)
        throw new Error("Enter a connection name (up to 100 characters).");
      const current = this.profiles.find((p) => p.id === id);
      const clean = Object.fromEntries(
        Object.entries({ ...current, ...profile, id, name, driver }).filter(
          ([k]) => PROFILE_KEYS.has(k),
        ),
      );
      if (profile.tls !== undefined) clean.ssl = profile.tls !== false;
      if (clean.ssl !== undefined) clean.tls = clean.ssl !== false;
      clean.readOnly =
        profile.readOnly === undefined
          ? (current?.readOnly ?? true)
          : profile.readOnly !== false;
      if (
        clean.port !== undefined &&
        clean.port !== "" &&
        clean.port !== null
      ) {
        clean.port = Number(clean.port);
        if (
          !Number.isInteger(clean.port) ||
          clean.port < 1 ||
          clean.port > 65535
        )
          throw new Error("Port must be between 1 and 65535.");
      }
      for (const [key, value] of Object.entries(clean)) {
        if (
          typeof value === "string" &&
          (value.length > 10000 || value.includes("\0"))
        )
          throw new Error(`Invalid ${key}.`);
      }
      if (
        clean.host &&
        (/[\s/@?#\\]/.test(clean.host) || clean.host.includes("://"))
      )
        throw new Error("Enter a hostname, without URL, credentials, or path.");
      if (clean.database && /:\/\//.test(clean.database))
        throw new Error(
          "Put connection URLs in the encrypted connection string field.",
        );
      const secret = {};
      for (const [key, value] of Object.entries(credentials)) {
        if (!SECRET_KEYS.has(key))
          throw new Error(`Unsupported credential field: ${key}.`);
        if (typeof value !== "string")
          throw new Error("Credentials must be strings.");
        if (value) secret[key] = value;
      }
      return this.serial(id, async () => {
        if (Object.keys(secret).length) {
          if (!this.vault?.set)
            throw new Error(
              "Credential vault is unavailable. Credentials cannot be stored securely.",
            );
          const merged = {
            ...(this.secrets.get(id) ||
              (await this.vault.get?.(`db-${id}`)) ||
              {}),
            ...secret,
          };
          await this.vault.set(`db-${id}`, merged);
          this.secrets.set(id, merged);
        }
        await this.dispose(id);
        this.invalidate(id);
        const index = this.profiles.findIndex((p) => p.id === id);
        if (index < 0) this.profiles.push(clean);
        else this.profiles[index] = clean;
        await this.persist();
        return {
          ...clean,
          status: "disconnected",
          capabilities: d.capabilities,
        };
      });
    });
  }
  invalidate(id) {
    this.revisions.set(id, (this.revisions.get(id) || 0) + 1);
    for (const [pid, p] of this.proposals)
      if (p.connectionId === id) this.proposals.delete(pid);
  }
  async removeConnection(id) {
    await this.init();
    return this.serial("metadata", () =>
      this.serial(id, async () => {
        this.profile(id);
        await this.dispose(id);
        await this.vault?.delete?.(`db-${id}`);
        this.secrets.delete(id);
        this.invalidate(id);
        this.profiles = this.profiles.filter((p) => p.id !== id);
        await this.persist();
        return { removed: true };
      }),
    );
  }
  async ensureAdapter(id) {
    const profile = this.profile(id);
    if (this.adapters.has(id)) {
      const existing = this.adapters.get(id);
      if (!existing.connectionError) return existing;
      try {
        await this.dispose(id);
      } catch {}
    }
    const credentials =
      this.secrets.get(id) || (await this.vault?.get?.(`db-${id}`)) || {};
    this.secrets.set(id, credentials);
    const adapter = await this.createAdapter(profile, credentials);
    try {
      await adapter.connect?.();
      this.adapters.set(id, adapter);
      return adapter;
    } catch (e) {
      try {
        await adapter.close?.();
      } catch {}
      throw this.safeError(e, id);
    }
  }
  async createAdapter(profile, credentials) {
    const d = this.describe(profile),
      custom = this.customDrivers[profile.driver];
    let adapter;
    if (custom) {
      if (typeof custom.create === "function")
        adapter = await custom.create(profile, credentials);
      else if (typeof custom === "function") {
        try {
          adapter = new custom(profile, credentials);
        } catch (e) {
          if (!/not a constructor/.test(e.message)) throw e;
          adapter = await custom(profile, credentials);
        }
      } else adapter = custom;
    } else adapter = new DRIVER_TYPES[d.family](profile, credentials);
    return adapter;
  }
  async testConnection(profile, credentials = {}) {
    if (!profile || typeof profile !== "object")
      throw new Error("Expected a connection profile.");
    const driver = profile.driver || profile.type,
      d = (await this.catalog()).find((c) => c.id === driver);
    if (!d) throw new Error("Choose a supported database driver.");
    const clean = Object.fromEntries(
      Object.entries({
        ...profile,
        id: `probe-${crypto.randomUUID()}`,
        driver,
        readOnly: true,
      }).filter(([key]) => PROFILE_KEYS.has(key)),
    );
    if (profile.tls !== undefined) clean.ssl = profile.tls !== false;
    if (
      clean.host &&
      (/[\s/@?#\\]/.test(clean.host) || clean.host.includes("://"))
    )
      throw new Error("Enter a hostname, without URL, credentials, or path.");
    if (clean.port !== undefined && clean.port !== "" && clean.port !== null) {
      clean.port = Number(clean.port);
      if (!Number.isInteger(clean.port) || clean.port < 1 || clean.port > 65535)
        throw new Error("Invalid port.");
    }
    const secret = {};
    for (const [key, value] of Object.entries(credentials)) {
      if (!SECRET_KEYS.has(key) || typeof value !== "string")
        throw new Error("Unsupported credentials.");
      if (value) secret[key] = value;
    }
    if (!Object.keys(secret).length && profile.id) {
      Object.assign(
        secret,
        this.secrets.get(profile.id) ||
          (await this.vault?.get?.(`db-${profile.id}`)) ||
          {},
      );
    }
    const start = performance.now();
    let adapter;
    try {
      adapter = await this.createAdapter(clean, secret);
      await adapter.connect?.();
      if (d.capabilities.sql)
        await adapter.read("SELECT 1 AS connected", [], 1);
      return {
        status: "connected",
        driver,
        name: profile.name || d.name,
        durationMs: Math.round((performance.now() - start) * 100) / 100,
        capabilities: d.capabilities,
      };
    } catch (e) {
      let message = e.message;
      for (const v of Object.values(secret))
        if (v) message = message.replaceAll(v, "[redacted]");
      throw new Error(
        message
          .replace(
            /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|rediss?):\/\/[^\s]+/gi,
            "[redacted connection URL]",
          )
          .slice(0, 2000),
      );
    } finally {
      try {
        await adapter?.close?.();
      } catch {}
    }
  }
  safeError(error, id) {
    let message = error?.message || String(error);
    for (const value of Object.values(this.secrets.get(id) || {}))
      if (value) message = message.replaceAll(value, "[redacted]");
    message = message.replace(
      /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|rediss?):\/\/[^\s]+/gi,
      "[redacted connection URL]",
    );
    return new Error(message.slice(0, 2000));
  }
  async connect(id) {
    await this.init();
    return this.serial(id, async () => {
      await this.ensureAdapter(id);
      const p = this.profile(id);
      return {
        id: p.id,
        name: p.name,
        driver: p.driver,
        status: "connected",
        readOnly: p.readOnly,
        capabilities: this.describe(p).capabilities,
      };
    });
  }
  async schema(id) {
    await this.init();
    return this.serial(id, async () => {
      try {
        return normalize(await (await this.ensureAdapter(id)).schema());
      } catch (e) {
        throw this.safeError(e, id);
      }
    });
  }
  output(raw, limit, start) {
    const rows = normalize((raw.rows || []).slice(0, limit));
    const out = {
      columns:
        raw.columns || Object.keys(rows[0] || {}).map((name) => ({ name })),
      rows,
      rowCount: rows.length,
      durationMs: Math.round((performance.now() - start) * 100) / 100,
      truncated: (raw.rows || []).length > limit,
    };
    if (Buffer.byteLength(JSON.stringify(out), "utf8") > 10 * 1024 * 1024)
      throw new Error("Result exceeds 10 MB. Select fewer columns or rows.");
    return out;
  }
  async query({ connectionId, sql, params, limit, requestId } = {}) {
    await this.init();
    const pageLimit = limitValue(limit),
      bound = validateParams(params);
    return this.serial(connectionId, async () => {
      const start = performance.now();
      try {
        const profile = this.profile(connectionId),
          adapter = await this.ensureAdapter(connectionId);
        const statement = this.describe(profile).capabilities.sql
          ? guardSql(sql, "read").sql
          : sql;
        return this.output(
          await adapter.read(statement, bound, pageLimit, { requestId }),
          pageLimit,
          start,
        );
      } catch (e) {
        throw this.safeError(e, connectionId);
      }
    });
  }
  async browse({
    connectionId,
    table,
    schema,
    search = "",
    sortColumn,
    sortDirection = "asc",
    offset = 0,
    limit = 100,
    cursor,
  } = {}) {
    await this.init();
    const pageLimit = limitValue(limit, 100, 1000);
    offset = Number(offset);
    if (!Number.isInteger(offset) || offset < 0 || offset > 1000000)
      throw new Error("Offset must be between 0 and 1000000.");
    if (typeof search !== "string" || search.length > 500)
      throw new Error("Search must be text of up to 500 characters.");
    if (!["asc", "desc"].includes(sortDirection))
      throw new Error("Choose ascending or descending sorting.");
    if (
      cursor !== undefined &&
      (typeof cursor !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(cursor))
    )
      throw new Error("Invalid key scan cursor.");
    return this.serial(connectionId, async () => {
      const start = performance.now();
      try {
        const profile = this.profile(connectionId),
          adapter = await this.ensureAdapter(connectionId);
        if (adapter.browse) {
          const raw = await adapter.browse({
            table,
            schema,
            search,
            sortColumn,
            sortDirection,
            offset,
            limit: pageLimit,
            cursor,
          });
          return {
            ...this.output(raw, pageLimit, start),
            total: raw.total,
            cursor: raw.cursor,
          };
        }
        const tables = await adapter.schema(),
          selected = tables.find(
            (t) => t.name === table && (!schema || t.schema === schema),
          );
        if (!selected) throw new Error("Table not found. Refresh the schema.");
        if (sortColumn && !selected.columns.some((c) => c.name === sortColumn))
          throw new Error("Sort column not found.");
        const dialect = adapter.dialect || this.describe(profile).family,
          q = (value) => quoteIdentifier(value, dialect);
        const full =
          (selected.schema && dialect !== "sqlite"
            ? q(selected.schema) + "."
            : "") + q(table);
        const params = [];
        const marker = (value) => {
          params.push(value);
          return dialect === "postgres"
            ? `$${params.length}`
            : dialect === "sqlserver"
              ? `@p${params.length}`
              : dialect === "clickhouse"
                ? `{p${params.length}:String}`
                : "?";
        };
        const stringType =
          dialect === "mysql"
            ? "CHAR"
            : dialect === "sqlserver"
              ? "NVARCHAR(MAX)"
              : dialect === "databricks"
                ? "STRING"
                : dialect === "clickhouse"
                  ? "String"
                  : "TEXT";
        const escaped = search.replace(/[\\%_]/g, "\\$&");
        const searchColumns = selected.columns.filter(
          (c) => !/(blob|binary|bytea|object|array|map|struct)/i.test(c.type),
        );
        const where =
          search && searchColumns.length
            ? " WHERE " +
              searchColumns
                .map(
                  (c) =>
                    `LOWER(CAST(${q(c.name)} AS ${stringType})) LIKE ${marker("%" + escaped.toLowerCase() + "%")}${dialect === "mysql" ? " ESCAPE '\\\\'" : dialect === "clickhouse" ? "" : " ESCAPE '\\'"}`,
                )
                .join(" OR ")
            : "";
        const actualParams =
          dialect === "clickhouse"
            ? Object.fromEntries(params.map((p, i) => [`p${i + 1}`, p]))
            : params;
        const count = await adapter.read(
          `SELECT count(*) AS total FROM ${full}${where}`,
          actualParams,
          1,
        );
        const order =
          sortColumn ||
          selected.columns.find((c) => c.primaryKey)?.name ||
          selected.columns[0]?.name;
        const ordering = order
          ? " ORDER BY " + q(order) + " " + sortDirection.toUpperCase()
          : "";
        const paging =
          dialect === "sqlserver"
            ? `${ordering || " ORDER BY (SELECT NULL)"} OFFSET ${offset} ROWS FETCH NEXT ${pageLimit + 1} ROWS ONLY`
            : `${ordering} LIMIT ${pageLimit + 1} OFFSET ${offset}`;
        const raw = await adapter.read(
          `SELECT * FROM ${full}${where}${paging}`,
          actualParams,
          pageLimit,
        );
        raw.columns = raw.columns.length
          ? raw.columns.map((c) => ({
              ...c,
              type:
                selected.columns.find((s) => s.name === c.name)?.type || c.type,
            }))
          : selected.columns.map((c) => ({ name: c.name, type: c.type }));
        return {
          ...this.output(raw, pageLimit, start),
          total: Number(count.rows[0]?.total || 0),
        };
      } catch (e) {
        throw this.safeError(e, connectionId);
      }
    });
  }
  async prepareWrite({ connectionId, sql, params } = {}) {
    await this.init();
    const bound = validateParams(params);
    return this.serial(connectionId, async () => {
      try {
        const profile = this.profile(connectionId),
          cap = this.describe(profile).capabilities;
        if (profile.readOnly !== false)
          throw new Error(
            "This connection is read-only. Enable write review in its connection settings.",
          );
        if (!cap.write)
          throw new Error(
            "Writes are unavailable for this driver: transaction preview is not supported.",
          );
        const statement = cap.sql ? guardSql(sql, "write").sql : sql;
        const adapter = await this.ensureAdapter(connectionId);
        const preview = adapter.preview
          ? await adapter.preview(statement, bound)
          : await adapter.write(statement, bound, { rollback: true });
        const expiresAt = Date.now() + 5 * 60 * 1000,
          id = crypto.randomUUID();
        const warning =
          preview.warning ||
          (adapter.transactional
            ? "Preview was rolled back. Affected row count is checked again at commit; live row values may change."
            : "No rollback preview: these are estimated matches or current key metadata. Changes can race with commit; partial writes cannot be undone.");
        const proposal = {
          id,
          connectionId,
          sql: statement,
          params: bound,
          affectedRows: preview.affectedRows,
          previewRows: normalize(preview.rows || []),
          validation: preview.validation,
          expiresAt,
          warning,
          revision: this.revisions.get(connectionId) || 0,
        };
        // Bound proposal memory and evict expired proposals without background timers.
        for (const [pid, p] of this.proposals)
          if (p.expiresAt < Date.now()) this.proposals.delete(pid);
        if (this.proposals.size >= 100)
          this.proposals.delete(this.proposals.keys().next().value);
        this.proposals.set(id, proposal);
        return {
          id,
          sql: statement,
          params: structuredClone(bound),
          affectedRows: proposal.affectedRows,
          previewRows: structuredClone(proposal.previewRows),
          expiresAt,
          warning,
        };
      } catch (e) {
        throw this.safeError(e, connectionId);
      }
    });
  }
  async commitWrite({ id } = {}) {
    await this.init();
    const proposal = this.proposals.get(id);
    if (!proposal)
      throw new Error("Write review no longer exists. Prepare it again.");
    this.proposals.delete(id); // At most one attempt, including network failures.
    return this.serial(proposal.connectionId, async () => {
      const start = performance.now();
      try {
        const profile = this.profile(proposal.connectionId);
        if (proposal.expiresAt < Date.now())
          throw new Error("Write review expired. Prepare it again.");
        if (
          profile.readOnly !== false ||
          (this.revisions.get(profile.id) || 0) !== proposal.revision
        )
          throw new Error("Connection changed. Review the write again.");
        const adapter = await this.ensureAdapter(profile.id),
          raw = await adapter.write(proposal.sql, proposal.params, {
            rollback: false,
            expectedAffectedRows: proposal.affectedRows,
            validation: proposal.validation,
          });
        return {
          ...this.output(raw, 100, start),
          rowCount: raw.rowCount ?? raw.affectedRows,
          affectedRows: raw.affectedRows,
          committed: true,
        };
      } catch (e) {
        throw this.safeError(e, proposal.connectionId);
      }
    });
  }
  async discardWrite({ id } = {}) {
    return { discarded: this.proposals.delete(id) };
  }
  async demo() {
    await this.init();
    const filename = path.join(this.directory, "demo-commerce.sqlite");
    createDemo(filename);
    if (!this.profiles.some((p) => p.id === "demo"))
      await this.saveConnection({
        id: "demo",
        name: "Commerce · SQLite",
        driver: "sqlite",
        filePath: filename,
        readOnly: false,
        color: "#71c4ba",
      });
    await this.connect("demo");
    return this.connections();
  }
  async dispose(id) {
    const a = this.adapters.get(id);
    this.adapters.delete(id);
    if (a) {
      let timer;
      try {
        await Promise.race([
          Promise.resolve().then(() => a.close?.()),
          new Promise((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    "Database disconnection timed out after 5 seconds.",
                  ),
                ),
              this.closeTimeoutMs,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
  }
  async cancel(requestId) {
    let cancelled = false;
    for (const a of this.adapters.values())
      if (a.cancel) {
        cancelled = (await a.cancel(requestId)) || cancelled;
      }
    return {
      cancelled,
      note: cancelled ? undefined : "No matching cancellable query was found.",
    };
  }
  async close(id) {
    if (id) {
      await this.adapters.get(id)?.abortReads?.();
      return this.serial(id, () => this.dispose(id));
    }
    await Promise.allSettled(
      [...this.adapters.values()].map((a) => a.abortReads?.()),
    );
    await Promise.allSettled(
      [...this.adapters.keys()].map((key) =>
        this.serial(key, () => this.dispose(key)),
      ),
    );
    this.proposals.clear();
  }
}
module.exports = { DatabaseService, CATALOG, normalize };
