// Copyright (c) 2026 Davide Leopardi
// SPDX-License-Identifier: GPL-3.0-only
"use strict";

// Execute the actual packaged app on the native target. User data and exports
// are disposable; every OS credential operation is forbidden in this suite.
const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const { verifyDesktopPackage } = require("./verify-package.cjs");
const target = `${process.platform}-${process.arch}`;
const reportPath = path.join(root, "artifacts", "platforms", `${target}.json`);
const checks = [], errors = [];
let app, directory, verification, rendererSecurity;
const check = async (name, work) => {
  const started = performance.now();
  await work();
  checks.push({ name, status: "passed", durationMs: Math.round(performance.now() - started) });
  console.log("PASS", name);
};

(async () => {
  const bundle = process.env.TABLELINE_PLATFORM_BUNDLE;
  if (!bundle) throw new Error("Set TABLELINE_PLATFORM_BUNDLE to a completed native package.");
  verification = verifyDesktopPackage(bundle);
  const executablePath = process.platform === "darwin" ? path.join(bundle, "Contents", "MacOS", "Tableline")
    : path.join(bundle, process.platform === "win32" ? "Tableline.exe" : "tableline");
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "tableline-platform-東京-"));
  app = await electron.launch({
    executablePath,
    chromiumSandbox: true,
    args: ["--tableline-qa", `--tableline-data=${directory}`, `--tableline-export=${path.join(directory, "exports")}`],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "", TABLELINE_DEV_URL: "" },
    timeout: 45000,
  });
  await app.evaluate(({ safeStorage }) => {
    globalThis.platformNativeCalls = 0;
    for (const method of ["isAsyncEncryptionAvailable", "encryptStringAsync", "decryptStringAsync"]) safeStorage[method] = () => {
      globalThis.platformNativeCalls++;
      throw new Error("OS credentials are forbidden in platform QA.");
    };
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on("pageerror", error => errors.push(error.message));
  await page.getByTestId("language-selector").selectOption("en");
  const call = (method, ...args) => page.evaluate(({ method, args }) => window.tableline.call(method, ...args), { method, args });
  await check("Packaged renderer starts with Chromium sandbox and context isolation enabled", async () => {
    const security = await app.evaluate(({ BrowserWindow, app }) => {
      const windows = BrowserWindow.getAllWindows();
      const rendererPid = windows[0].webContents.getOSProcessId();
      const metric = app.getAppMetrics().find(metric => metric.pid === rendererPid);
      let linux;
      if (process.platform === "linux") {
        const fs = process.getBuiltinModule("fs");
        const status = fs.readFileSync(`/proc/${rendererPid}/status`, "utf8");
        const selfStatus = fs.readFileSync("/proc/self/status", "utf8");
        const namespaceDepth = value => value.match(/^NSpid:\s*([^\n]+)/m)?.[1].trim().split(/\s+/).length || 0;
        linux = { seccomp: Number(status.match(/^Seccomp:\s*(\d+)/m)?.[1]),
          noNewPrivileges: Number(status.match(/^NoNewPrivs:\s*(\d+)/m)?.[1]),
          mainNamespaceDepth: namespaceDepth(selfStatus), rendererNamespaceDepth: namespaceDepth(status),
          separatePidNamespace: namespaceDepth(status) > namespaceDepth(selfStatus) };
      }
      return { sandboxDisabled: process.argv.includes("--no-sandbox"), osSandboxed: metric?.sandboxed,
        linux, preferences: windows.map(window => window.webContents.getLastWebPreferences()) };
    });
    assert.equal(security.sandboxDisabled, false);
    assert.equal(security.preferences.length, 1);
    assert.equal(security.preferences[0].sandbox, true);
    assert.equal(security.preferences[0].contextIsolation, true);
    assert.equal(security.preferences[0].nodeIntegration, false);
    assert.equal(await page.evaluate(() => typeof window.require), "undefined");
    assert.equal(await page.evaluate(() => typeof window.process), "undefined");
    if (process.platform === "linux") {
      assert.equal(security.linux.seccomp, 2);
      assert.equal(security.linux.noNewPrivileges, 1);
      assert.equal(security.linux.separatePidNamespace, true);
    } else assert.equal(security.osSandboxed, true);
    rendererSecurity = { chromiumSandbox: true, sandboxDisabled: security.sandboxDisabled,
      osSandboxed: security.osSandboxed, linux: security.linux };
  });
  await check("Packaged runtime matches native OS, architecture, and source version", async () => {
    const info = await call("runtime.info");
    assert.equal(info.platform, process.platform);
    assert.equal(info.version, require(path.join(root, "package.json")).version);
    const runtime = await app.evaluate(() => ({ arch: process.arch, electron: process.versions.electron }));
    assert.equal(runtime.arch, process.arch);
    assert.equal(runtime.electron, require(path.join(root, "package.json")).devDependencies.electron);
    assert.equal(await page.locator("html").getAttribute("data-platform"), process.platform);
    assert.match(await page.locator(".command-trigger kbd").innerText(), process.platform === "darwin" ? /⌘\s*K/i : /Ctrl\s*K/i);
  });
  await check("Packaged production database and provider dependencies load in Electron", async () => {
    const imported = await app.evaluate(({ app }) => {
      const { createRequire } = process.getBuiltinModule("module");
      const appRequire = createRequire(process.getBuiltinModule("path").join(app.getAppPath(), "package.json"));
      const dependencies = ["pg", "mysql2", "mssql", "mongodb", "redis", "@clickhouse/client", "@databricks/sql",
        "@aws-sdk/client-bedrock", "@aws-sdk/client-bedrock-runtime", "@aws-sdk/credential-providers", "google-auth-library"];
      return dependencies.map(name => { appRequire(name); return name; });
    });
    assert.equal(imported.length, 11);
  });
  await check("Native LZ4 binding roundtrips UTF-8 using the packaged Electron ABI", async () => {
    const result = await app.evaluate(({ app }) => {
      const { createRequire } = process.getBuiltinModule("module");
      const appRequire = createRequire(process.getBuiltinModule("path").join(app.getAppPath(), "package.json"));
      const lz4 = appRequire("lz4-napi");
      const bytes = Buffer.from("Müller 東京 Tableline ".repeat(100));
      return lz4.decompressFrameSync(lz4.compressFrameSync(bytes)).equals(bytes);
    });
    assert.equal(result, true);
  });
  await check("Databricks SDK selects the supported Thrift backend without its native kernel", async () => {
    const selected = await app.evaluate(async ({ app }) => {
      const { createRequire } = process.getBuiltinModule("module");
      const appRequire = createRequire(process.getBuiltinModule("path").join(app.getAppPath(), "package.json"));
      const { DBSQLClient } = appRequire("@databricks/sql");
      const client = new DBSQLClient({ logger: { log() {} } });
      try {
        // SDK connect creates transport but sends no database request until
        // openSession. Loopback is synthetic; no cloud credentials are used.
        await client.connect({ host: "127.0.0.1", path: "/sql/1.0/warehouses/platform-qa", token: "fixture-only",
          telemetryEnabled: false, checkServerCertificate: true });
        return { backend: client.backend.constructor.name,
          loadedNativeKernel: Object.keys(appRequire.cache).some(file => /databricks-sql-kernel.*\.node$/.test(file)) };
      } finally { await client.close(); }
    });
    assert.equal(selected.backend, "ThriftBackend");
    assert.equal(selected.loadedNativeKernel, false);
    assert.equal(verification.databricksKernelBundled, false);
  });
  await page.getByRole("button", { name: "Open local demo", exact: true }).click();
  await page.locator(".data-grid tbody tr").first().waitFor();
  await check("Real SQLite child process executes parameterized Unicode queries", async () => {
    const count = await call("db.query", { connectionId: "demo", sql: "SELECT COUNT(*) AS count FROM customers" });
    assert.equal(count.rows[0].count, 120);
    const unicode = await call("db.query", { connectionId: "demo", sql: "SELECT ? AS sample", params: ["Müller 東京"] });
    assert.equal(unicode.rows[0].sample, "Müller 東京");
  });
  await check("Write preparation retains review and does not mutate SQLite", async () => {
    const before = await call("db.query", { connectionId: "demo", sql: "SELECT stock FROM products WHERE id=9" });
    const proposal = await call("db.prepareWrite", { connectionId: "demo", sql: "UPDATE products SET stock=? WHERE id=?", params: [5, 9] });
    assert.ok(proposal.id);
    const after = await call("db.query", { connectionId: "demo", sql: "SELECT stock FROM products WHERE id=9" });
    assert.deepEqual(after.rows, before.rows);
  });
  await check("Native export writes UTF-8 data inside the isolated target directory", async () => {
    const rows = [{ sample: "Müller 東京" }];
    const exported = await call("native.export", { format: "json", filename: "東京.json", rows });
    assert.equal(exported.canceled, false);
    assert.deepEqual(JSON.parse(await fs.readFile(exported.path, "utf8")), rows);
    assert.equal(path.dirname(exported.path), path.join(directory, "exports"));
  });
  await check("Renderer remains healthy and has no native credential calls", async () => {
    assert.deepEqual(errors, []);
    assert.equal(await app.evaluate(() => globalThis.platformNativeCalls), 0);
  });
})().catch(error => {
  checks.push({ name: "Platform acceptance", status: "failed", error: error.message });
  console.error(error.stack);
  process.exitCode = 1;
}).finally(async () => {
  if (app) await app.close().catch(() => app.process().kill("SIGTERM"));
  if (directory) await fs.rm(directory, { recursive: true, force: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify({ target, date: new Date().toISOString(), verification, checks,
    rendererSecurity,
    rendererSandboxAcceptance: checks.some(check => check.name === "Packaged renderer starts with Chromium sandbox and context isolation enabled" && check.status === "passed"),
    limitations: ["OS credential storage is not exercised", "Cloud database accounts are not exercised", "Reyden/SEA Databricks warehouses require the omitted native kernel", "Linux target uses glibc"] }, null, 2) + "\n");
});
