// Copyright (c) 2026 Davide Leopardi
// SPDX-License-Identifier: GPL-3.0-only

"use strict";
const { fork } = require("node:child_process");
const path = require("node:path");

// SQLite's synchronous native call cannot be interrupted by Worker.terminate().
// A dedicated child process keeps the UI responsive and supports a real hard
// timeout even while SQLite is evaluating an unbounded recursive aggregate.
class SQLiteDriver {
  constructor(profile) {
    this.profile = profile;
    this.dialect = "sqlite";
    this.transactional = true;
    this.pending = new Map();
    this.nextId = 0;
    this.worker = null;
    this.connecting = null;
    this.timeoutMs = 30000;
  }
  async connect() {
    if (this.worker) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      this.worker = fork(path.join(__dirname, "sqlite-worker.cjs"), [], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        serialization: "advanced",
      });
      const worker = this.worker;
      worker.on("message", (message) => {
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(new Error(message.error));
        else request.resolve(message.value);
      });
      worker.on("error", (error) => {
        if (this.worker === worker) this.reset(error.message);
      });
      worker.on("exit", (code) => {
        if (this.worker === worker)
          this.reset(`SQLite worker stopped (${code}).`);
      });
      try {
        await this.call("connect", [this.profile]);
      } catch (e) {
        await this.reset(e.message);
        throw e;
      }
    })();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }
  call(action, args, requestId) {
    if (!this.worker) throw new Error("SQLite worker is disconnected.");
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.reset(
          "SQLite query timed out after 30 seconds. The connection was reset.",
        );
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, requestId, action });
      this.worker.send({ id, action, args });
    });
  }
  async reset(message = "SQLite operation cancelled.") {
    const worker = this.worker;
    this.worker = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(message));
    }
    this.pending.clear();
    if (worker && worker.exitCode === null) {
      await new Promise((resolve) => {
        worker.once("exit", resolve);
        worker.kill("SIGKILL");
      });
    }
  }
  async read(sql, params = [], limit = 500, { requestId } = {}) {
    await this.connect();
    return this.call("read", [sql, params, limit], requestId);
  }
  async schema() {
    await this.connect();
    return this.call("schema", []);
  }
  async write(sql, params = [], options = {}) {
    await this.connect();
    return this.call("write", [sql, params, options]);
  }
  async cancel(requestId) {
    if (
      [...this.pending.values()].some(
        (p) => p.action === "read" && p.requestId === requestId,
      )
    ) {
      await this.reset();
      return true;
    }
    return false;
  }
  async abortReads() {
    if ([...this.pending.values()].some((p) => p.action === "read"))
      await this.reset(
        "SQLite read stopped because the connection is closing.",
      );
  }
  async close() {
    if (this.worker) {
      try {
        await this.call("close", []);
      } finally {
        await this.reset("SQLite connection closed.");
      }
    }
  }
}
module.exports = { SQLiteDriver };
