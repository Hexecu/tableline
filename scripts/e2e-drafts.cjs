// Copyright (c) 2026 Davide Leopardi
// SPDX-License-Identifier: GPL-3.0-only

"use strict";
const { _electron: electron } = require("playwright");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const packaged = Boolean(process.env.TABLELINE_E2E_EXECUTABLE);
const artifacts = path.join(
  root,
  "artifacts/e2e/drafts",
  packaged ? "packaged" : "source",
);
let app, page, directory;
const checks = [],
  errors = [];
const bounded = async (promise, label, ms = 15000) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error(`${label} timed out`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
async function launch() {
  app = await electron.launch({
    executablePath: process.env.TABLELINE_E2E_EXECUTABLE || require("electron"),
    args: [
      ...(packaged ? [] : [path.join(root, "electron/main.cjs")]),
      "--tableline-qa",
      `--tableline-data=${directory}`,
    ],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "", TABLELINE_DEV_URL: "" },
    timeout: 15000,
  });
  page = await app.firstWindow();
  await app.evaluate(({ safeStorage }) => {
    globalThis.tablelineQANativeCredentialCalls = 0;
    for (const method of ["isAsyncEncryptionAvailable", "encryptStringAsync", "decryptStringAsync"])
      safeStorage[method] = () => {
        globalThis.tablelineQANativeCredentialCalls++;
        throw new Error("Draft desktop QA must not invoke native credential APIs.");
      };
  });
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => errors.push(error.message));
  const resetFixtureLanguage = await page.evaluate(() => {
    if (localStorage.getItem("tableline.language") === "it") return false;
    localStorage.setItem("tableline.language", "it");
    return true;
  });
  if (resetFixtureLanguage) await page.reload();
  await page.waitForFunction(
    () => window.tableline && document.querySelector("#root")?.children.length,
  );
}
async function call(method, ...args) {
  return bounded(
    page.evaluate(
      ({ method, args }) => window.tableline.call(method, ...args),
      { method, args },
    ),
    method,
  );
}
async function editor() {
  await page.getByRole("button", { name: "SQL", exact: true }).click();
  return page.getByLabel("Editor SQL", { exact: true });
}
async function select(id) {
  await page.getByLabel("Connessione attiva", { exact: true }).selectOption(id);
  await page.waitForFunction(
    (id) =>
      document.querySelector('[aria-label="Connessione attiva"]')?.value ===
        id &&
      document.querySelectorAll(".data-grid tbody tr").length > 0 &&
      !document.querySelector(".grid-progress"),
    id,
  );
}
async function close() {
  if (!app) return;
  assert.equal(await app.evaluate(() => globalThis.tablelineQANativeCredentialCalls), 0);
  const instance = app;
  const exited = new Promise((resolve) => {
    const process = instance.process();
    if (process.exitCode !== null || process.signalCode !== null) resolve();
    else process.once("exit", resolve);
  });
  await bounded(
    Promise.all([instance.close().catch(() => {}), exited]),
    "desktop shutdown",
    8000,
  );
  app = null;
}
async function check(name, work) {
  const start = performance.now();
  try {
    await work();
    checks.push({
      name,
      status: "passed",
      durationMs: Math.round(performance.now() - start),
    });
    console.log("PASS", name);
  } catch (error) {
    checks.push({ name, status: "failed", error: error.message });
    throw error;
  }
}
(async () => {
  await fs.mkdir(artifacts, { recursive: true });
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "tableline-draft-qa-"));
  await launch();
  await call("db.demo");
  const demo = (await call("db.connections")).find((p) => p.id === "demo");
  await call("db.saveConnection", {
    ...demo,
    id: "second-draft",
    name: "Drafts second",
    readOnly: true,
  });
  await call("db.saveConnection", {
    id: "broken-draft",
    name: "Unavailable fixture",
    driver: "sqlite",
    filePath: path.join(directory, "absent", "bad.sqlite"),
    readOnly: true,
  });
  await page.evaluate(() =>
    localStorage.setItem("tableline.lastConnection", "demo"),
  );
  await page.reload();
  await page.getByLabel("Connessione attiva", { exact: true }).waitFor();
  await select("demo");
  const first = "SELECT 'draft A 東京' AS value;",
    second = "SELECT 'draft B Müller' AS value;",
    latest = "SELECT 'last keystroke survives immediate exit' AS value;";
  await check(
    "Unsaved SQL drafts survive connection switches and failed connections",
    async () => {
      await (await editor()).fill(first);
      await select("second-draft");
      await (await editor()).fill(second);
      await select("demo");
      assert.equal(await (await editor()).inputValue(), first);
      await page
        .getByLabel("Connessione attiva", { exact: true })
        .selectOption("broken-draft");
      await page.getByRole("button", { name: "SQL", exact: true }).waitFor();
      await page.getByRole("alert").filter({ hasText: /./ }).waitFor();
      assert.equal(
        await page
          .getByLabel("Connessione attiva", { exact: true })
          .inputValue(),
        "demo",
      );
      assert.equal(await (await editor()).inputValue(), first);
      await select("second-draft");
      assert.equal(await (await editor()).inputValue(), second);
    },
  );
  await check(
    "Typing during connection setup preserves the previous SQL draft",
    async () => {
      await app.evaluate(({ app }, sourceRoot) => {
        const qaRequire = process
          .getBuiltinModule("module")
          .createRequire(sourceRoot + "/package.json");
        const prototype = qaRequire(
          process
            .getBuiltinModule("path")
            .join(
              app.isPackaged ? app.getAppPath() : sourceRoot,
              "electron/database.cjs",
            ),
        ).DatabaseService.prototype;
        globalThis.tablelineQAOriginalConnect = prototype.connect;
        prototype.connect = async function (id) {
          if (id === "demo")
            await new Promise((resolve) => {
              globalThis.tablelineQAReleaseConnect = resolve;
            });
          return globalThis.tablelineQAOriginalConnect.call(this, id);
        };
      }, root);
      try {
        await page
          .getByLabel("Connessione attiva", { exact: true })
          .selectOption("demo");
        await (
          await editor()
        ).fill("SELECT 'typed during connection setup' AS value;");
        await app.evaluate(() => globalThis.tablelineQAReleaseConnect());
        await page.waitForFunction(
          () =>
            document.querySelector('[aria-label="Connessione attiva"]')
              ?.value === "demo" &&
            document.querySelectorAll(".data-grid tbody tr").length > 0,
        );
      } finally {
        await app.evaluate(({ app }, sourceRoot) => {
          const qaRequire = process
            .getBuiltinModule("module")
            .createRequire(sourceRoot + "/package.json");
          const prototype = qaRequire(
            process
              .getBuiltinModule("path")
              .join(
                app.isPackaged ? app.getAppPath() : sourceRoot,
                "electron/database.cjs",
              ),
          ).DatabaseService.prototype;
          prototype.connect = globalThis.tablelineQAOriginalConnect;
          delete globalThis.tablelineQAOriginalConnect;
          delete globalThis.tablelineQAReleaseConnect;
        }, root);
      }
      await select("second-draft");
      assert.equal(
        await (await editor()).inputValue(),
        "SELECT 'typed during connection setup' AS value;",
      );
    },
  );
  await check(
    "The final keystroke survives immediate native quit and restart",
    async () => {
      await (await editor()).fill(latest);
      await close();
      await launch();
      await page.waitForFunction(
        () =>
          document.querySelector('[aria-label="Connessione attiva"]')?.value ===
            "second-draft" &&
          document.querySelectorAll(".data-grid tbody tr").length > 0,
      );
      assert.equal(await (await editor()).inputValue(), latest);
    },
  );
  await check(
    "Malformed draft storage recovers without renderer exceptions",
    async () => {
      await page.addInitScript(() => {
        localStorage.setItem("tableline.drafts.v1", "{broken");
        localStorage.setItem("tableline.lastConnection", "demo");
      });
      await page.reload();
      await page.waitForFunction(
        () => document.querySelectorAll(".data-grid tbody tr").length > 0,
      );
      assert.match(await (await editor()).inputValue(), /SELECT/);
      assert.deepEqual(errors, []);
      await page.screenshot({ path: path.join(artifacts, "drafts.png") });
    },
  );
})()
  .catch(async (error) => {
    console.error(error.stack);
    await page
      ?.screenshot({ path: path.join(artifacts, "failure.png") })
      .catch(() => {});
    process.exitCode = 1;
  })
  .finally(async () => {
    await close().catch(() => app?.process().kill("SIGKILL"));
    await fs.mkdir(artifacts, { recursive: true });
    await fs.writeFile(
      path.join(artifacts, "report.json"),
      JSON.stringify(
        {
          date: new Date().toISOString(),
          runtime: packaged ? "packaged Electron" : "source Electron",
          status: process.exitCode ? "failed" : "passed",
          checks,
          rendererErrors: errors,
        },
        null,
        2,
      ),
    );
  });
