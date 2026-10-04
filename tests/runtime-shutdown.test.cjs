// Copyright (c) 2026 Davide Leopardi
// SPDX-License-Identifier: GPL-3.0-only

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("shutdown closes databases before bounding a pending native Keychain operation", async () => {
  let closeDatabase;
  const closed = new Promise((resolve) => {
    closeDatabase = resolve;
  });
  const nativeEncryption = new Promise(() => {});
  const order = [],
    timers = [],
    ipc = new Map();
  const app = new EventEmitter();
  Object.assign(app, {
    isPackaged: true,
    setName() {},
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    getPath: () => "/isolated/tableline-shutdown-fixture",
    getVersion: () => "0.1.0",
    quit() {
      order.push("graceful-quit");
      // Simulates native BLOCK_SHUTDOWN work that keeps the process alive.
      return nativeEncryption;
    },
    exit(code) {
      order.push(`exit-${code}`);
    },
  });
  class Window extends EventEmitter {
    constructor() {
      super();
      this.webContents = new EventEmitter();
    }
    removeMenu() {}
    loadFile() {}
  }
  Window.prototype.webContents = null;
  const originalWindow = Window;
  class BrowserWindow extends originalWindow {
    constructor() {
      super();
      this.webContents.setWindowOpenHandler = () => {};
    }
  }
  class DatabaseService {
    close() {
      order.push("close-databases");
      return closed;
    }
  }
  class Vault {
    available() {
      assert.fail("Runtime metadata must not initialize the Keychain");
    }
    status() {
      return "unknown";
    }
  }
  const session = {
    defaultSession: {
      webRequest: { onHeadersReceived() {} },
      setPermissionRequestHandler() {},
      setPermissionCheckHandler() {},
    },
  };
  const electron = {
    app,
    BrowserWindow,
    session,
    safeStorage: {},
    dialog: {},
    ipcMain: { handle: (name, callback) => ipc.set(name, callback) },
  };
  const security = {
    ...require("../electron/runtime-security.cjs"),
    assertSender() {},
  };
  const modules = {
    electron,
    "node:path": path,
    "node:fs/promises": { mkdir: async () => {} },
    "./database.cjs": { DatabaseService },
    "./ai.cjs": { AIService: class {} },
    "./assistant.cjs": { AssistantService: class {} },
    "./ai-vault.cjs": { AIVault: Vault },
    "./menu.cjs": require("../electron/menu.cjs"),
    "./shutdown-guard.cjs": {
      armShutdownGuard: async () => {
        order.push("arm-owned-exit-guard");
      },
    },
    "./runtime-security.cjs": security,
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8"),
    {
      require: (name) => modules[name],
      __dirname: path.join(__dirname, "../electron"),
      process: { argv: [], env: {}, platform: "darwin" },
      console,
      setTimeout(callback, duration) {
        timers.push({ callback, duration });
        return { unref() {} };
      },
      clearTimeout() {},
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ipc.size, 1);
  const metadata = await ipc.get(security.CHANNEL)({}, "runtime.info", []);
  assert.equal(metadata.value.credentialStatus, "unknown");
  assert.equal(metadata.value.encryptedCredentials, false);
  const language = await ipc.get(security.CHANNEL)({}, "runtime.setLanguage", ["fr"]);
  assert.equal(language.value.language, "fr");
  const invalidLanguage = await ipc.get(security.CHANNEL)({}, "runtime.setLanguage", [["en"]]);
  assert.equal(invalidLanguage.ok, false);
  const quitEvent = () => ({
    preventDefault() {
      order.push("defer-quit");
    },
  });
  app.emit("before-quit", quitEvent());
  app.emit("before-quit", quitEvent());
  assert.deepEqual(order, ["defer-quit", "defer-quit"]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["defer-quit", "defer-quit", "close-databases"]);
  assert.equal(timers.length, 0);
  closeDatabase();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers.length, 0);
  assert.deepEqual(order, [
    "defer-quit",
    "defer-quit",
    "close-databases",
    "arm-owned-exit-guard",
    "exit-0",
  ]);
});
