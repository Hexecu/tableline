"use strict";
const crypto = require("node:crypto");

function command(sql) {
  let value;
  try {
    value = typeof sql === "string" ? JSON.parse(sql) : sql;
  } catch {
    throw new Error("Use a JSON command for MongoDB or Redis.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a JSON command object.");
  if (JSON.stringify(value).length > 100000)
    throw new Error("Command is too large.");
  inspect(value);
  return value;
}
function inspect(value, depth = 0) {
  if (depth > 20) throw new Error("Command nesting is too deep.");
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (
      [
        "__proto__",
        "prototype",
        "constructor",
        "$where",
        "$function",
        "$accumulator",
        "$out",
        "$merge",
        "$eval",
      ].includes(key)
    )
      throw new Error(`Unsafe command field: ${key}.`);
    inspect(child, depth + 1);
  }
}
function collectionName(name) {
  if (
    typeof name !== "string" ||
    !name ||
    name.includes("\0") ||
    name.length > 256 ||
    name.startsWith("system.")
  )
    throw new Error("Choose a user collection.");
  return name;
}
function result(rows) {
  return {
    columns: [...new Set(rows.flatMap((r) => Object.keys(r)))].map((name) => ({
      name,
    })),
    rows,
  };
}
function mongoType(value) {
  return value === null
    ? "null"
    : Array.isArray(value)
      ? "array"
      : value?.constructor?.name === "ObjectId"
        ? "ObjectId"
        : typeof value;
}

class MongoDriver {
  constructor(profile, credentials) {
    this.profile = profile;
    this.credentials = credentials;
    this.dialect = "mongodb";
    this.transactional = false;
  }
  async connect() {
    const { MongoClient } = require("mongodb");
    const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(
      this.profile.host || "localhost",
    );
    this.client = new MongoClient(
      this.credentials.connectionString ||
        `mongodb://${this.profile.host || "localhost"}:${this.profile.port || 27017}`,
      {
        auth: this.credentials.password
          ? {
              username: this.profile.username,
              password: this.credentials.password,
            }
          : undefined,
        serverSelectionTimeoutMS: 10000,
        connectTimeoutMS: 10000,
        socketTimeoutMS: 30000,
        tls:
          this.profile.ssl === undefined ? !local : this.profile.ssl !== false,
        tlsAllowInvalidCertificates: false,
      },
    );
    await this.client.connect();
    this.db = this.client.db(this.profile.database);
    await this.db.command({ ping: 1 });
  }
  async read(sql, params = [], limit = 500) {
    const c = command(sql),
      collection = this.db.collection(collectionName(c.collection));
    if (!["find", "aggregate", "count"].includes(c.operation))
      throw new Error("MongoDB read commands: find, aggregate, count.");
    if (c.operation === "count")
      return result([
        {
          count: await collection.countDocuments(c.filter || {}, {
            maxTimeMS: 30000,
          }),
        },
      ]);
    if (c.operation === "aggregate") {
      if (
        !Array.isArray(c.pipeline) ||
        c.pipeline.some(
          (stage) =>
            Object.keys(stage).length !== 1 ||
            ![
              "$match",
              "$group",
              "$sort",
              "$limit",
              "$skip",
              "$project",
              "$count",
              "$unwind",
              "$addFields",
              "$set",
              "$unset",
              "$replaceRoot",
            ].includes(Object.keys(stage)[0]),
        )
      )
        throw new Error(
          "Unsupported aggregation stage. Output and server-side JavaScript are disabled.",
        );
      return result(
        await collection
          .aggregate([...c.pipeline, { $limit: limit + 1 }], {
            maxTimeMS: 30000,
            allowDiskUse: false,
          })
          .toArray(),
      );
    }
    const skip = Math.max(0, Math.min(1000000, Number(c.skip) || 0));
    return result(
      await collection
        .find(c.filter || {}, { projection: c.projection, maxTimeMS: 30000 })
        .sort(c.sort || {})
        .skip(skip)
        .limit(Math.min(limit + 1, Math.max(1, Number(c.limit) || limit + 1)))
        .toArray(),
    );
  }
  async schema() {
    const collections = await this.db
      .listCollections({}, { nameOnly: true })
      .toArray();
    const tables = [];
    for (const c of collections.filter((c) => !c.name.startsWith("system."))) {
      const docs = await this.db
        .collection(c.name)
        .find({}, { maxTimeMS: 10000 })
        .limit(20)
        .toArray();
      const names = [...new Set(docs.flatMap((d) => Object.keys(d)))];
      tables.push({
        name: c.name,
        schema: this.profile.database,
        kind: "collection",
        columns: names.map((name) => ({
          name,
          type: [
            ...new Set(
              docs.filter((d) => name in d).map((d) => mongoType(d[name])),
            ),
          ].join(" | "),
          nullable: docs.some((d) => !(name in d) || d[name] === null),
          primaryKey: name === "_id",
        })),
      });
    }
    return tables;
  }
  async preview(sql) {
    const c = command(sql);
    collectionName(c.collection);
    if (!["insertOne", "updateMany", "deleteMany"].includes(c.operation))
      throw new Error(
        "MongoDB write commands: insertOne, updateMany, deleteMany.",
      );
    const collection = this.db.collection(c.collection);
    if (c.operation === "insertOne") {
      if (
        !c.document ||
        typeof c.document !== "object" ||
        Array.isArray(c.document)
      )
        throw new Error("insertOne requires a document.");
      return { affectedRows: 1, rows: [c.document] };
    }
    if (
      !c.filter ||
      typeof c.filter !== "object" ||
      !Object.keys(c.filter).length
    )
      throw new Error("MongoDB update/delete needs a nonempty filter.");
    if (
      c.operation === "updateMany" &&
      (!c.update ||
        Object.keys(c.update).some(
          (k) =>
            ![
              "$set",
              "$unset",
              "$inc",
              "$min",
              "$max",
              "$rename",
              "$push",
              "$pull",
              "$addToSet",
            ].includes(k),
        ))
    )
      throw new Error("Unsupported MongoDB update.");
    return {
      affectedRows: await collection.countDocuments(c.filter, {
        maxTimeMS: 30000,
      }),
      rows: await collection
        .find(c.filter, { maxTimeMS: 30000 })
        .limit(20)
        .toArray(),
    };
  }
  async write(sql, params = [], { expectedAffectedRows } = {}) {
    const c = command(sql),
      collection = this.db.collection(c.collection);
    // Revalidate preview immediately before execution, even on nontransactional
    // engines. UI must state that this is an estimate and no rollback is offered.
    const preview = await this.preview(sql);
    if (
      expectedAffectedRows !== undefined &&
      preview.affectedRows !== expectedAffectedRows
    )
      throw new Error("Matching documents changed. Review the write again.");
    let affectedRows;
    if (c.operation === "insertOne") {
      await collection.insertOne(c.document);
      affectedRows = 1;
    } else if (c.operation === "updateMany") {
      const r = await collection.updateMany(c.filter, c.update, {
        maxTimeMS: 30000,
      });
      affectedRows = r.modifiedCount;
    } else {
      const r = await collection.deleteMany(c.filter, { maxTimeMS: 30000 });
      affectedRows = r.deletedCount;
    }
    return { columns: [], rows: [], affectedRows, rowCount: affectedRows };
  }
  async browse({
    table,
    search,
    sortColumn,
    sortDirection,
    offset = 0,
    limit = 100,
  }) {
    const filter = search
      ? {
          $or:
            (await this.schema())
              .find((t) => t.name === table)
              ?.columns.filter((c) => c.type.includes("string"))
              .map((c) => ({
                [c.name]: {
                  $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
                  $options: "i",
                },
              })) || [],
        }
      : {};
    if (search && !filter.$or.length) return { ...result([]), total: 0 };
    const c = {
      collection: table,
      operation: "find",
      filter,
      skip: offset,
      sort: sortColumn
        ? { [sortColumn]: sortDirection === "desc" ? -1 : 1 }
        : { _id: 1 },
    };
    return {
      ...(await this.read(JSON.stringify(c), [], limit)),
      total: await this.db
        .collection(table)
        .countDocuments(filter, { maxTimeMS: 30000 }),
    };
  }
  async close() {
    await this.client?.close();
  }
}

const REDIS_READ = new Set(
  "GET MGET HGET HGETALL HMGET HSCAN HLEN LRANGE LLEN SCARD SISMEMBER SMEMBERS SSCAN ZRANGE ZCARD ZSCORE TYPE TTL PTTL EXISTS STRLEN SCAN".split(
    " ",
  ),
);
const REDIS_WRITE = new Set(
  "SET DEL HSET HDEL LPUSH RPUSH SADD SREM ZADD ZREM EXPIRE PERSIST".split(" "),
);
function redisCommand(sql, write = false) {
  const c = command(sql),
    cmd = String(c.command || "").toUpperCase();
  if (!(write ? REDIS_WRITE : REDIS_READ).has(cmd))
    throw new Error(
      `Redis ${write ? "write" : "read"} command ${cmd || "(missing)"} is not supported.`,
    );
  if (
    !Array.isArray(c.args) ||
    c.args.some((a) => !["string", "number"].includes(typeof a))
  )
    throw new Error("Redis args must be strings or numbers.");
  if (c.args.length > 1000) throw new Error("Too many Redis arguments.");
  // Bound commands that can stream large collections. Redis GET payload size is
  // a server concern; response size is also capped before returning to the UI.
  if (["LRANGE", "ZRANGE"].includes(cmd)) {
    const end = Number(c.args[2]),
      start = Number(c.args[1]);
    if (
      !Number.isInteger(end) ||
      !Number.isInteger(start) ||
      start < 0 ||
      end < start ||
      end - start > 10000
    )
      throw new Error(
        "Range reads need a finite range of at most 10001 entries.",
      );
  }
  if (["SCAN", "HSCAN", "SSCAN"].includes(cmd)) {
    const cursorIndex = cmd === "SCAN" ? 0 : 1;
    if (!/^\d{1,30}$/.test(String(c.args[cursorIndex] ?? "")))
      throw new Error("SCAN requires a numeric cursor.");
    let count = false;
    for (let i = cursorIndex + 1; i < c.args.length; i += 2) {
      const flag = String(c.args[i]).toUpperCase(),
        value = c.args[i + 1];
      if (!["COUNT", "MATCH", "TYPE"].includes(flag) || value === undefined)
        throw new Error("Use bounded SCAN options: MATCH, COUNT, TYPE.");
      if (flag === "COUNT") {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1 || n > 1000)
          throw new Error("SCAN COUNT must be between 1 and 1000.");
        count = true;
      }
    }
    if (!count) c.args.push("COUNT", "200");
  }
  return { cmd, args: c.args.map(String) };
}
class RedisDriver {
  constructor(profile, credentials) {
    this.profile = profile;
    this.credentials = credentials;
    this.dialect = "redis";
    this.transactional = false;
    this.cursors = new Map();
    this.pending = new Set();
    this.commandTimeoutMs = 30000;
  }
  async operation(kind, work) {
    const op = { kind, aborted: false };
    const interrupted = new Promise((_, reject) => {
      op.reject = reject;
    });
    this.pending.add(op);
    const timer = setTimeout(() => {
      const message =
        kind === "write"
          ? "Redis write timed out after 30 seconds. Its outcome is uncertain; verify the data before retrying."
          : "Redis operation timed out after 30 seconds. The connection was reset.";
      this.interrupt(op, message);
    }, this.commandTimeoutMs);
    op.done = Promise.race([
      Promise.resolve().then(() => work(op)),
      interrupted,
    ]);
    try {
      return await op.done;
    } finally {
      clearTimeout(timer);
      this.pending.delete(op);
    }
  }
  interrupt(op, message) {
    if (op.aborted) return;
    op.aborted = true;
    const error = new Error(message);
    op.reject(error);
    this.connectionError = error;
    // DatabaseService serializes these operations. This extra check also keeps
    // a direct read cancellation from destroying an overlapping write client.
    if (
      ![...this.pending].some(
        (p) => p !== op && p.kind === "write" && !p.aborted,
      )
    )
      this.destroyClient();
  }
  destroyClient() {
    try {
      this.client?.destroy?.();
    } catch {}
  }
  request(op, work) {
    if (op.aborted)
      throw this.connectionError || new Error("Redis operation stopped.");
    return work();
  }
  async abortReads() {
    if ([...this.pending].some((op) => op.kind === "write" && !op.aborted))
      return;
    for (const op of this.pending)
      if (op.kind !== "write")
        this.interrupt(
          op,
          "Redis read stopped because the connection is closing.",
        );
  }
  async connect() {
    const { createClient } = require("redis");
    this.client = createClient({
      url: this.credentials.connectionString,
      socket: {
        connectTimeout: 10000,
        reconnectStrategy: false,
        ...(this.credentials.connectionString
          ? {}
          : {
              host: this.profile.host || "localhost",
              port: this.profile.port || 6379,
              tls: this.profile.ssl !== false,
            }),
      },
      disableOfflineQueue: true,
      commandsQueueMaxLength: 1000,
      username: this.profile.username || undefined,
      password: this.credentials.password,
      database: Number(this.profile.database) || 0,
    });
    this.client.on("error", (e) => {
      this.connectionError = e;
    });
    this.connectionError = null;
    await this.operation("read", async (op) => {
      await this.request(op, () => this.client.connect());
      await this.request(op, () => this.client.ping());
    });
  }
  async read(sql, params = [], limit = 500) {
    const c = redisCommand(sql);
    return this.operation("read", async (op) => {
      if (["HGETALL", "SMEMBERS"].includes(c.cmd)) {
        const size = Number(
          await this.request(op, () =>
            this.client.sendCommand([
              c.cmd === "HGETALL" ? "HLEN" : "SCARD",
              c.args[0],
            ]),
          ),
        );
        if (size > 10000)
          throw new Error(
            "Collection exceeds 10000 entries. Use HSCAN or SSCAN.",
          );
      }
      if (["GET", "MGET"].includes(c.cmd)) {
        const sizes = await Promise.all(
          c.args.map((key) =>
            this.request(op, () => this.client.sendCommand(["STRLEN", key])),
          ),
        );
        if (sizes.reduce((a, b) => a + Number(b), 0) > 10 * 1024 * 1024)
          throw new Error("String payload exceeds 10 MB. Choose smaller keys.");
      }
      const value = await this.request(op, () =>
        this.client.sendCommand([c.cmd, ...c.args]),
      );
      if (["SCAN", "HSCAN", "SSCAN"].includes(c.cmd))
        return result([{ cursor: value[0], values: value[1] }]);
      if (c.cmd === "HGETALL") {
        const rows = [];
        for (let i = 0; i < value.length; i += 2)
          rows.push({ field: value[i], value: value[i + 1] });
        return result(rows.slice(0, limit + 1));
      }
      return result(
        Array.isArray(value)
          ? value.slice(0, limit + 1).map((v, i) => ({ index: i, value: v }))
          : [{ key: c.args[0], value }],
      );
    });
  }
  async schema() {
    return [
      {
        name: "keys",
        schema: String(this.profile.database || 0),
        kind: "keyspace",
        columns: [
          { name: "key", type: "string", nullable: false, primaryKey: true },
          { name: "type", type: "string", nullable: false, primaryKey: false },
          { name: "ttl", type: "integer", nullable: false, primaryKey: false },
        ],
      },
    ];
  }
  async preview(sql) {
    const c = redisCommand(sql, true),
      keys = c.cmd === "DEL" ? c.args : [c.args[0]];
    if (!keys.length || keys.some((k) => !k)) throw new Error("Specify a key.");
    return this.operation("read", async (op) => {
      const rows = [];
      for (const key of keys.slice(0, 20))
        rows.push({
          key,
          type: await this.request(op, () => this.client.type(key)),
          ttl: await this.request(op, () => this.client.ttl(key)),
        });
      return { affectedRows: undefined, rows };
    });
  }
  async write(sql) {
    const c = redisCommand(sql, true);
    return this.operation("write", async (op) => {
      const value = await this.request(op, () =>
        this.client.sendCommand([c.cmd, ...c.args]),
      );
      return {
        ...result([{ result: value }]),
        rowCount: typeof value === "number" ? value : 1,
        affectedRows: typeof value === "number" ? value : undefined,
      };
    });
  }
  async browse({ search, offset = 0, limit = 100, cursor }) {
    return this.operation("read", async (op) => {
      if (offset && !cursor)
        throw new Error(
          "Use SCAN and its returned cursor to browse more Redis keys.",
        );
      for (const [id, s] of this.cursors)
        if (s.expiresAt < Date.now()) this.cursors.delete(id);
      let state = {
        redisCursor: "0",
        pending: [],
        seen: [],
        started: false,
        search: search || "",
      };
      if (cursor && cursor !== "0") {
        const stored = this.cursors.get(cursor);
        if (!stored || stored.search !== (search || ""))
          throw new Error(
            "Key scan expired or search changed. Start from the first page.",
          );
        state = structuredClone(stored);
      }
      const options = {
        MATCH: search ? `*${search.replace(/[?*\[\]\\]/g, "\\$&")}*` : "*",
        COUNT: Math.min(limit, 500),
      };
      const keys = [],
        seen = new Set(state.seen);
      let scans = 0;
      while (keys.length < limit) {
        if (state.pending.length) {
          const key = state.pending.shift();
          if (!seen.has(key)) {
            if (seen.size >= 10000)
              throw new Error(
                "Key scan exceeds 10000 keys. Narrow the search.",
              );
            keys.push(key);
            seen.add(key);
          }
          continue;
        }
        if (state.started && state.redisCursor === "0") break;
        if (++scans > 100) break; // Return a partial page + continuation on sparse scans.
        const scan = await this.request(op, () =>
          this.client.scan(state.redisCursor, options),
        );
        state.started = true;
        state.redisCursor = String(scan.cursor);
        state.pending = [...scan.keys];
        if (state.pending.length > 10000 || seen.size > 10000)
          throw new Error("Key scan exceeds 10000 keys. Narrow the search.");
      }
      const rows = [];
      for (const key of keys)
        rows.push({
          key,
          type: await this.request(op, () => this.client.type(key)),
          ttl: await this.request(op, () => this.client.ttl(key)),
        });
      let next = "0";
      if (state.pending.length || state.redisCursor !== "0") {
        next = `r_${crypto.randomUUID()}`;
        state.seen = [...seen];
        state.expiresAt = Date.now() + 5 * 60 * 1000;
        if (this.cursors.size >= 100)
          this.cursors.delete(this.cursors.keys().next().value);
        this.cursors.set(next, state);
      }
      return { ...result(rows), total: undefined, cursor: next };
    });
  }
  async close() {
    this.cursors.clear();
    await this.abortReads();
    await Promise.allSettled(
      [...this.pending]
        .filter((op) => op.kind === "write")
        .map((op) => op.done),
    );
    this.destroyClient();
  }
}
module.exports = { MongoDriver, RedisDriver, command, redisCommand };
