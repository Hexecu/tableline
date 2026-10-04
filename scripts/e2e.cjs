// Copyright (c) 2026 Davide Leopardi
// SPDX-License-Identifier: GPL-3.0-only

"use strict";

// Functional QA launches the production renderer in an actual Electron process.
// The only network peer is a disposable loopback protocol fixture.
const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const artifacts = path.join(
  root,
  "artifacts",
  "e2e",
  process.env.TABLELINE_E2E_EXECUTABLE ? "packaged" : "source",
);
const results = [];
const shutdowns = [];
const errors = [];
const networkRequests = [];
const fixtureKey = "TABLELINE-E2E-FAKE-CREDENTIAL-ONLY";
const credentialAcceptance = process.env.TABLELINE_E2E_CREDENTIALS === "1";
let app, page, server, temporary;
let aborting = false;
function bounded(work, milliseconds, label) {
  let timer;
  return Promise.race([
    work,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} exceeded ${milliseconds} ms.`)),
        milliseconds,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

async function check(name, work) {
  const started = performance.now();
  try {
    const detail = await bounded(Promise.resolve().then(work), 45_000, name);
    const blocked = Boolean(detail?.blocked);
    results.push({
      name,
      status: blocked ? "blocked" : "passed",
      durationMs: Math.round(performance.now() - started),
      ...(detail ? { detail } : {}),
    });
    if (blocked) process.exitCode = 1;
    console.log(`${blocked ? "BLOCKED" : "PASS"} ${name}`);
  } catch (error) {
    aborting = true;
    results.push({
      name,
      status: "failed",
      durationMs: Math.round(performance.now() - started),
      error: error.message,
    });
    throw error;
  }
}
async function closeDesktop() {
  if (!app) return;
  const instance = app;
  const child = instance.process();
  const started = performance.now();
  let closeError;
  const exited = new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", resolve);
  });
  await bounded(
    Promise.all([
      instance.close().catch((error) => {
        closeError = error.message;
      }),
      exited,
    ]),
    8000,
    "Electron shutdown",
  );
  shutdowns.push({
    durationMs: Math.round(performance.now() - started),
    exitCode: child.exitCode,
    signal: child.signalCode,
    ...(closeError ? { closeError } : {}),
  });
  app = null;
}
async function call(method, ...args) {
  return bounded(
    page.evaluate(
      ({ method, args }) => window.tableline.call(method, ...args),
      { method, args },
    ),
    15_000,
    method,
  );
}
async function rejects(method, args, pattern) {
  await assert.rejects(() => call(method, ...args), pattern);
}
async function firstCell(text) {
  await page.waitForFunction(
    (expected) =>
      document.querySelector(".data-grid tbody tr td:nth-child(2)")
        ?.textContent === String(expected),
    text,
  );
}
async function rowsReady() {
  await page.waitForFunction(
    () =>
      document.querySelectorAll(".data-grid tbody tr").length > 0 &&
      !document.querySelector(".grid-progress"),
  );
}
async function readExport(filename) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      return await fs.readFile(filename, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Export was not created: ${path.basename(filename)}`);
}
function fixtureResponse(request) {
  const user =
    request.messages?.findLast((message) => message.role === "user")?.content ||
    "";
  let payload;
  try {
    payload = JSON.parse(user);
  } catch {
    return "Fixture model ready.";
  }
  const prompt = payload.request || "";
  const context = payload.untrusted_database_context || {};
  if (/invalid-json/i.test(prompt)) return "invalid structured model output";
  if (/attack-write-in-read/i.test(prompt))
    return JSON.stringify({
      action: "prepare_write",
      sql: "UPDATE customers SET name=? WHERE id=?",
      params: ["Unapproved", 1],
    });
  if (/update|aggiorna/i.test(prompt))
    return JSON.stringify({
      action: "prepare_write",
      sql: "UPDATE customers SET name=? WHERE id=?",
      params: ["Transport write", 1],
    });
  if (!context.toolResults?.length)
    return JSON.stringify({
      action: "query_read",
      sql: "SELECT COUNT(*) AS count FROM customers",
      params: [],
    });
  return JSON.stringify({
    action: "final",
    answer: `${context.toolResults[0].result.rows[0].count} clienti verificati dalla query.`,
  });
}
async function launch() {
  if (aborting) throw new Error("The acceptance run has already stopped.");
  const executablePath =
    process.env.TABLELINE_E2E_EXECUTABLE || require("electron");
  const entry = process.env.TABLELINE_E2E_EXECUTABLE
    ? []
    : [path.join(root, "electron", "main.cjs")];
  app = await electron.launch({
    executablePath,
    args: [
      ...entry,
      "--tableline-qa",
      `--tableline-data=${temporary}`,
      `--tableline-export=${path.join(temporary, "exports")}`,
    ],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "", TABLELINE_DEV_URL: "" },
    timeout: 45_000,
  });
  page = await app.firstWindow({ timeout: 15_000 });
  if (!credentialAcceptance)
    await app.evaluate(({ safeStorage }) => {
      globalThis.tablelineQANativeCredentialCalls = 0;
      for (const method of [
        "isAsyncEncryptionAvailable",
        "encryptStringAsync",
        "decryptStringAsync",
      ])
        safeStorage[method] = () => {
          globalThis.tablelineQANativeCredentialCalls++;
          throw new Error("Credential acceptance is disabled for this QA run.");
        };
    });
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (error) => errors.push(error.message));
  const resetFixtureLanguage = await page.evaluate(() => {
    if (localStorage.getItem("tableline.language") === "it") return false;
    localStorage.setItem("tableline.language", "it");
    return true;
  });
  if (resetFixtureLanguage) await page.reload();
  await page.waitForFunction(
    () =>
      !!window.tableline && document.querySelector("#root")?.children.length,
  );
}

(async () => {
  await fs.mkdir(artifacts, { recursive: true });
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "tableline-e2e-"));
  server = http.createServer(async (request, response) => {
    try {
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 100_000) throw new Error("fixture request too large");
      }
      const data = body ? JSON.parse(body) : {};
      networkRequests.push({
        path: request.url,
        method: request.method,
        model: data.model,
        credential: request.headers.authorization === `Bearer ${fixtureKey}`,
        body: data,
      });
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/v1/models")
        response.end(
          JSON.stringify({
            data: [{ id: "fixture-model" }, { id: "fixture-second" }],
          }),
        );
      else if (request.url === "/v1/chat/completions")
        response.end(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: { role: "assistant", content: fixtureResponse(data) },
              },
            ],
          }),
        );
      else {
        response.statusCode = 404;
        response.end(
          JSON.stringify({ error: { message: "Fixture route not found." } }),
        );
      }
    } catch {
      response.statusCode = 400;
      response.end("{}");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  await launch();
  console.log("Desktop renderer connected; checking database IPC.");
  await call("db.catalog");
  console.log("Database IPC responds; checking secure-storage metadata.");
  const nativeStorage = await app.evaluate(({ app, safeStorage }) => ({
    appReady: app.isReady(),
    electron: process.versions.electron,
    asynchronousAvailability: typeof safeStorage.isAsyncEncryptionAvailable,
    asynchronousEncrypt: typeof safeStorage.encryptStringAsync,
    asynchronousDecrypt: typeof safeStorage.decryptStringAsync,
    mockKeychainSwitch: app.commandLine.hasSwitch("use-mock-keychain"),
    passwordStore: app.commandLine.getSwitchValue("password-store"),
  }));
  const availabilityStarted = performance.now();
  const info = await call("runtime.info");
  if (credentialAcceptance) {
    try {
      await call(
        "ai.saveProfile",
        {
          id: "qa-native-storage",
          name: "Disposable native credential fixture",
          provider: "compatible",
          baseUrl: endpoint,
          model: "fixture-model",
          authMode: "apiKey",
        },
        { apiKey: fixtureKey },
      );
    } catch {
      console.log(
        "Native credential acceptance did not complete; recording passive state.",
      );
    }
    Object.assign(info, await call("runtime.info"));
  }
  nativeStorage.credentialAcceptance = credentialAcceptance;
  nativeStorage.credentialStatus = info.credentialStatus;
  nativeStorage.availabilityMs = Math.round(
    performance.now() - availabilityStarted,
  );
  console.log(JSON.stringify(nativeStorage));
  let demo;
  await check("Desktop sandbox, preload and IPC boundary", async () => {
    assert.equal(await page.evaluate(() => typeof window.require), "undefined");
    assert.equal(await page.evaluate(() => typeof window.process), "undefined");
    await rejects("db.constructor", [], /unavailable/);
    const preferences = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(),
    );
    assert.equal(preferences.contextIsolation, true);
    assert.equal(preferences.nodeIntegration, false);
    assert.equal(preferences.sandbox, true);
    const before = await app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    );
    await page.evaluate(() => window.open("https://example.com"));
    assert.equal(
      await app.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
      ),
      before,
    );
    await page.evaluate(() => {
      const script = document.createElement("script");
      script.textContent = "window.__tablelineInlineScriptRan = true";
      document.body.append(script);
    });
    assert.equal(
      await page.evaluate(() => window.__tablelineInlineScriptRan),
      undefined,
    );
    return { encryptedCredentials: info.encryptedCredentials, nativeStorage };
  });
  await check(
    "Deterministic SQLite fixture and complete driver catalog",
    async () => {
      const catalog = await call("db.catalog");
      for (const id of [
        "sqlite",
        "postgres",
        "mysql",
        "aurora-postgresql",
        "aurora-mysql",
        "databricks",
        "sqlserver",
        "mongodb",
        "redis",
        "clickhouse",
        "redshift",
        "cockroachdb",
        "mariadb",
      ])
        assert.ok(
          catalog.find((driver) => driver.id === id),
          id,
        );
      const created = await call("db.demo");
      const profiles = await call("db.connections");
      demo = profiles.find((profile) => profile.id === (created?.id || "demo"));
      assert.ok(demo);
      assert.equal(demo.readOnly, false);
      await call("db.connect", demo.id);
      const schema = await call("db.schema", demo.id);
      assert.deepEqual(schema.map((table) => table.name).sort(), [
        "customers",
        "order_items",
        "orders",
        "products",
      ]);
      const count = await call("db.query", {
        connectionId: demo.id,
        sql: "SELECT COUNT(*) AS count FROM customers",
      });
      assert.equal(Number(count.rows[0].count), 120);
    },
  );
  await check(
    "Browse pagination, descending sort, search and bounded queries",
    async () => {
      const first = await call("db.browse", {
        connectionId: demo.id,
        table: "orders",
        schema: "main",
        limit: 100,
        offset: 0,
        sortColumn: "id",
        sortDirection: "asc",
      });
      const second = await call("db.browse", {
        connectionId: demo.id,
        table: "orders",
        schema: "main",
        limit: 100,
        offset: 100,
        sortColumn: "id",
        sortDirection: "asc",
      });
      assert.equal(first.rows.length, 100);
      assert.equal(first.total, 1000);
      assert.equal(Number(first.rows[0].id), 1);
      assert.equal(Number(second.rows[0].id), 101);
      const descending = await call("db.browse", {
        connectionId: demo.id,
        table: "orders",
        limit: 10,
        sortColumn: "id",
        sortDirection: "desc",
      });
      assert.equal(Number(descending.rows[0].id), 1000);
      const filtered = await call("db.browse", {
        connectionId: demo.id,
        table: "orders",
        limit: 100,
        search: "pending",
      });
      assert.ok(filtered.rows.length > 0);
      assert.ok(
        filtered.rows.every((row) =>
          Object.values(row).some((value) => String(value).includes("pending")),
        ),
      );
      const bounded = await call("db.query", {
        connectionId: demo.id,
        sql: "SELECT * FROM orders",
        limit: 7,
      });
      assert.equal(bounded.rows.length, 7);
      assert.equal(bounded.truncated, true);
      await rejects(
        "db.query",
        [{ connectionId: demo.id, sql: "SELECT missing FROM absent" }],
        /no such|does not exist|missing|absent/i,
      );
      await rejects(
        "db.query",
        [{ connectionId: demo.id, sql: "DELETE FROM customers" }],
        /read|SELECT|write|lettura/i,
      );
      await rejects(
        "db.query",
        [{ connectionId: demo.id, sql: "SELECT 1; DELETE FROM customers" }],
        /single|one|statement|una|istruzione/i,
      );
    },
  );
  await check(
    "Write preview rolls back, approved commit executes once, read-only profile blocks writes",
    async () => {
      const before = await call("db.query", {
        connectionId: demo.id,
        sql: "SELECT name FROM customers WHERE id=1",
      });
      const proposal = await call("db.prepareWrite", {
        connectionId: demo.id,
        sql: "UPDATE customers SET name=? WHERE id=?",
        params: ["E2E approved", 1],
      });
      assert.equal(proposal.affectedRows, 1);
      const pending = await call("db.query", {
        connectionId: demo.id,
        sql: "SELECT name FROM customers WHERE id=1",
      });
      assert.equal(pending.rows[0].name, before.rows[0].name);
      const commit = await call("db.commitWrite", { id: proposal.id });
      assert.equal(commit.affectedRows, 1);
      assert.equal(
        (
          await call("db.query", {
            connectionId: demo.id,
            sql: "SELECT name FROM customers WHERE id=1",
          })
        ).rows[0].name,
        "E2E approved",
      );
      await rejects(
        "db.commitWrite",
        [{ id: proposal.id }],
        /review|proposal|proposta|expired|invalid|not found|already|preview/i,
      );
      const discarded = await call("db.prepareWrite", {
        connectionId: demo.id,
        sql: "UPDATE customers SET name=? WHERE id=?",
        params: ["Not approved", 1],
      });
      assert.ok(discarded.id);
      assert.equal(
        (await call("db.discardWrite", { id: discarded.id })).discarded,
        true,
      );
      await rejects(
        "db.commitWrite",
        [{ id: discarded.id }],
        /review|proposal|proposta|expired|invalid|not found|preview/i,
      );
      assert.equal(
        (
          await call("db.query", {
            connectionId: demo.id,
            sql: "SELECT name FROM customers WHERE id=1",
          })
        ).rows[0].name,
        "E2E approved",
      );
      await call("db.saveConnection", {
        ...demo,
        id: "qa-readonly",
        name: "QA read-only",
        readOnly: true,
      });
      await rejects(
        "db.prepareWrite",
        [
          {
            connectionId: "qa-readonly",
            sql: "UPDATE customers SET name=? WHERE id=?",
            params: ["blocked", 1],
          },
        ],
        /read.?only|lettura/i,
      );
    },
  );
  await check(
    "Native CSV and JSON export preserve real result data",
    async () => {
      const result = await call("db.query", {
        connectionId: demo.id,
        sql: "SELECT id,name FROM customers ORDER BY id LIMIT 3",
      });
      const csv = await call("native.export", {
        format: "csv",
        filename: "customers.csv",
        columns: result.columns,
        rows: result.rows,
      });
      assert.equal(csv.canceled, false);
      assert.match(await fs.readFile(csv.path, "utf8"), /id,name/);
      const json = await call("native.export", {
        format: "json",
        filename: "customers.json",
        rows: result.rows,
      });
      assert.deepEqual(
        JSON.parse(await fs.readFile(json.path, "utf8")),
        result.rows,
      );
    },
  );
  await check(
    "Demo assistant reads grounded data and prepares uncommitted writes",
    async () => {
      const answer = await call("assistant.ask", {
        connectionId: demo.id,
        profileId: "demo",
        prompt: "Quanti clienti ci sono?",
        mode: "read",
      });
      assert.equal(answer.isMock, true);
      assert.equal(answer.grounded, true);
      assert.match(answer.answer, /120/);
      await rejects(
        "assistant.ask",
        [
          {
            connectionId: demo.id,
            profileId: "demo",
            prompt: "Aggiorna ordine 1 a shipped",
            mode: "read",
          },
        ],
        /lettura/i,
      );
      const before = (
        await call("db.query", {
          connectionId: demo.id,
          sql: "SELECT status FROM orders WHERE id=1",
        })
      ).rows[0].status;
      const proposal = await call("assistant.ask", {
        connectionId: demo.id,
        profileId: "demo",
        prompt: "Aggiorna ordine 1 a shipped",
        mode: "write",
      });
      assert.ok(proposal.proposal?.id);
      assert.equal(
        (
          await call("db.query", {
            connectionId: demo.id,
            sql: "SELECT status FROM orders WHERE id=1",
          })
        ).rows[0].status,
        before,
      );
    },
  );
  await check(
    "Real provider HTTP transport, model discovery and credential separation",
    async () => {
      await call(
        "ai.saveProfile",
        {
          id: "qa-provider",
          name: "QA compatible fixture",
          provider: "compatible",
          baseUrl: endpoint,
          model: "fixture-model",
          authMode: info.encryptedCredentials ? "apiKey" : "none",
        },
        info.encryptedCredentials ? { apiKey: fixtureKey } : {},
      );
      await call("ai.selectProfile", "qa-provider");
      assert.deepEqual(
        (await call("ai.discoverModels", "qa-provider")).models,
        ["fixture-model", "fixture-second"],
      );
      assert.equal(
        (await call("ai.test", "qa-provider")).model,
        "fixture-model",
      );
      const config = await call("ai.getConfig");
      assert.equal(JSON.stringify(config).includes(fixtureKey), false);
      assert.equal(
        (
          await fs.readFile(path.join(temporary, "ai-profiles.json"), "utf8")
        ).includes(fixtureKey),
        false,
      );
      if (info.encryptedCredentials) {
        const credentials = await fs.readFile(
          path.join(temporary, "credentials.json"),
          "utf8",
        );
        assert.equal(credentials.includes(fixtureKey), false);
        assert.ok(networkRequests.every((request) => request.credential));
      }
      const answer = await call("assistant.ask", {
        connectionId: demo.id,
        profileId: "qa-provider",
        prompt: "Fixture count customers",
        mode: "read",
      });
      assert.equal(answer.isMock, false);
      assert.equal(answer.grounded, true);
      assert.match(answer.answer, /120/);
      assert.equal(
        networkRequests.filter(
          (request) => request.path === "/v1/chat/completions",
        ).length,
        3,
      );
      const last = networkRequests
        .at(-1)
        .body.messages.findLast((message) => message.role === "user").content;
      assert.equal(last.includes(fixtureKey), false);
      assert.match(last, /untrusted_database_context/);
      return {
        transport: "Disposable localhost HTTP provider",
        authentication: info.encryptedCredentials ? "Fixture API key" : "None",
        encryptedSecretPersistence: info.encryptedCredentials
          ? "verified"
          : "unverified",
      };
    },
  );
  await check(
    "Assistant rejects model write in read mode and malformed actions",
    async () => {
      await rejects(
        "assistant.ask",
        [
          {
            connectionId: demo.id,
            profileId: "qa-provider",
            prompt: "attack-write-in-read",
            mode: "read",
          },
        ],
        /lettura/i,
      );
      await rejects(
        "assistant.ask",
        [
          {
            connectionId: demo.id,
            profileId: "qa-provider",
            prompt: "invalid-json",
            mode: "read",
          },
        ],
        /JSON/i,
      );
      assert.equal(
        (
          await call("db.query", {
            connectionId: demo.id,
            sql: "SELECT name FROM customers WHERE id=1",
          })
        ).rows[0].name,
        "E2E approved",
      );
      const proposal = await call("assistant.ask", {
        connectionId: demo.id,
        profileId: "qa-provider",
        prompt: "Update customer 1 name",
        mode: "write",
      });
      assert.ok(proposal.proposal.id);
      assert.equal(
        (
          await call("db.query", {
            connectionId: demo.id,
            sql: "SELECT name FROM customers WHERE id=1",
          })
        ).rows[0].name,
        "E2E approved",
      );
    },
  );

  await page.reload();
  await page.waitForFunction(
    () =>
      !!window.tableline && document.querySelector("#root")?.children.length,
  );
  await check(
    "UI opens the demo and browses, paginates, sorts and filters real rows",
    async () => {
      await page
        .getByRole("button", { name: "Apri demo locale", exact: true })
        .click();
      await rowsReady();
      await page
        .locator(".table-list button")
        .filter({ hasText: /^orders/ })
        .click();
      await firstCell(1);
      await page
        .getByLabel("Righe per pagina", { exact: true })
        .selectOption("50");
      await page.waitForFunction(
        () =>
          document.querySelectorAll(".data-grid tbody tr").length === 50 &&
          !document.querySelector(".grid-progress"),
      );
      await page
        .getByRole("button", { name: "Pagina successiva", exact: true })
        .click();
      await firstCell(51);
      await page
        .getByRole("button", { name: "Pagina precedente", exact: true })
        .click();
      await firstCell(1);
      const idHeader = page
        .locator(".data-grid thead button")
        .filter({ has: page.locator("span").filter({ hasText: /^id$/ }) });
      await idHeader.click();
      await firstCell(1);
      await idHeader.click();
      await firstCell(1000);
      await page.getByLabel("Filtra righe", { exact: true }).fill("pending");
      await page.waitForFunction(
        () =>
          document.querySelectorAll(".data-grid tbody tr").length > 0 &&
          [...document.querySelectorAll(".data-grid tbody tr")].every((row) =>
            row.textContent.includes("pending"),
          ) &&
          !document.querySelector(".grid-progress"),
      );
      await page
        .getByRole("button", { name: "Esporta CSV", exact: true })
        .click();
      const exported = path.join(temporary, "exports", "orders.csv");
      assert.match(await readExport(exported), /pending/);
      await page
        .getByRole("button", { name: "Rimuovi filtro", exact: true })
        .click();
      await firstCell(1000);
      await page.screenshot({ path: path.join(artifacts, "browse-light.png") });
    },
  );
  await check(
    "UI keyboard SQL, error recovery, history and saved queries",
    async () => {
      await page.keyboard.press(
        process.platform === "darwin" ? "Meta+t" : "Control+t",
      );
      await page
        .getByLabel("Editor SQL", { exact: true })
        .fill("SELECT COUNT(*) AS count FROM customers");
      await page
        .getByLabel("Editor SQL", { exact: true })
        .press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");
      await firstCell(120);
      await page.keyboard.press(
        process.platform === "darwin" ? "Meta+s" : "Control+s",
      );
      await page
        .getByLabel("Nome query", { exact: true })
        .fill("QA customer count");
      await page
        .getByRole("dialog", { name: "Salva query", exact: true })
        .getByRole("button", { name: "Salva", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Query salvate", exact: true })
        .click();
      assert.ok(
        await page
          .locator(".saved-list")
          .getByRole("button", { name: "QA customer count", exact: true })
          .isVisible(),
      );
      await page
        .getByLabel("Editor SQL", { exact: true })
        .fill("SELECT missing FROM absent");
      await page.locator(".run-button").click();
      await page
        .getByRole("alert")
        .filter({ hasText: "Query non riuscita" })
        .waitFor();
      await page
        .getByRole("button", { name: "Cronologia query", exact: true })
        .click();
      await page
        .locator(".history-list button")
        .filter({ hasText: "SELECT missing FROM absent" })
        .waitFor();
      await page
        .getByRole("button", { name: "Chiudi errore", exact: true })
        .click();
      await page
        .getByLabel("Editor SQL", { exact: true })
        .fill("SELECT COUNT(*) AS count FROM orders");
      await page.locator(".run-button").click();
      await firstCell(1000);
      await page
        .getByRole("button", { name: "Esporta CSV", exact: true })
        .click();
      assert.match(
        await readExport(path.join(temporary, "exports", "query.csv")),
        /1000/,
      );
    },
  );
  await check(
    "UI interrupts a running SQLite query and recovers the connection",
    async () => {
      await page
        .getByLabel("Editor SQL", { exact: true })
        .fill(
          "WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers) SELECT SUM(n) AS total FROM numbers",
        );
      await page.locator(".run-button").click();
      await page
        .getByRole("button", { name: "Interrompi query", exact: true })
        .click();
      await page
        .getByRole("alert")
        .filter({ hasText: /cancelled|annullat/i })
        .waitFor();
      assert.equal(await page.locator(".run-button").isEnabled(), true);
      await page
        .getByRole("button", { name: "Chiudi errore", exact: true })
        .click();
      await page
        .getByLabel("Editor SQL", { exact: true })
        .fill("SELECT COUNT(*) AS count FROM customers");
      await page.locator(".run-button").click();
      await firstCell(120);
    },
  );
  await check("UI cell edit, discard, approval and clipboard", async () => {
    await page.getByRole("button", { name: "Tabelle", exact: true }).click();
    await page
      .locator(".table-list button")
      .filter({ hasText: /^customers/ })
      .click();
    await firstCell(1);
    let nameCell = page
      .locator(".data-grid tbody tr")
      .first()
      .locator("td")
      .nth(2);
    await nameCell.dblclick();
    await page.getByLabel("Nuovo valore", { exact: true }).fill("UI discarded");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Rivedi modifica", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "Rivedi la modifica", exact: true })
      .waitFor();
    assert.equal(
      (
        await call("db.query", {
          connectionId: demo.id,
          sql: "SELECT name FROM customers WHERE id=1",
        })
      ).rows[0].name,
      "E2E approved",
    );
    await page.getByRole("button", { name: "Scarta", exact: true }).click();
    nameCell = page.locator(".data-grid tbody tr").first().locator("td").nth(2);
    await nameCell.dblclick();
    await page.getByLabel("Nuovo valore", { exact: true }).fill("UI approved");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Rivedi modifica", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Conferma scrittura", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document.querySelector(".data-grid tbody tr td:nth-child(3)")
          ?.textContent === "UI approved",
    );
    assert.equal(
      (
        await call("db.query", {
          connectionId: demo.id,
          sql: "SELECT name FROM customers WHERE id=1",
        })
      ).rows[0].name,
      "UI approved",
    );
    await page
      .getByRole("button", { name: "Dettaglio riga", exact: true })
      .click();
    await page
      .locator(".data-grid tbody tr")
      .first()
      .locator("td")
      .nth(2)
      .click();
    await page.getByRole("button", { name: "Copia name", exact: true }).click();
    assert.equal(
      await app.evaluate(({ clipboard }) => clipboard.readText()),
      "UI approved",
    );
    await page
      .getByRole("button", { name: "Chiudi dettaglio", exact: true })
      .click();
  });
  await check(
    "UI assistant read, visible SQL evidence and human write review",
    async () => {
      if (
        !(await page.getByLabel("Profilo assistente", { exact: true }).count())
      )
        await page
          .getByRole("button", { name: "Assistente", exact: true })
          .click();
      await page
        .getByLabel("Profilo assistente", { exact: true })
        .selectOption("demo");
      await page
        .getByLabel("Domanda sui dati", { exact: true })
        .fill("Quanti clienti ci sono?");
      await page
        .getByRole("button", { name: "Invia domanda", exact: true })
        .click();
      await page
        .locator(".assistant-message .answer-text")
        .filter({ hasText: /120/ })
        .waitFor();
      await page.locator(".query-evidence summary").last().click();
      assert.match(
        await page.locator(".query-evidence pre").last().innerText(),
        /COUNT\(\*\)/,
      );
      await page
        .getByRole("button", { name: "Prepara modifica", exact: true })
        .click();
      await page
        .getByLabel("Domanda sui dati", { exact: true })
        .fill("Aggiorna ordine 1 a shipped");
      await page
        .getByRole("button", { name: "Invia domanda", exact: true })
        .click();
      await page.locator(".review-ai").last().click();
      await page
        .getByRole("dialog", { name: "Rivedi la modifica", exact: true })
        .waitFor();
      await page.screenshot({ path: path.join(artifacts, "write-review.png") });
      await page.getByRole("button", { name: "Scarta", exact: true }).click();
      await page.getByRole("button", { name: "Leggi", exact: true }).click();
    },
  );
  await check(
    "UI creates a SQLite profile and configures an exact provider model",
    async () => {
      await page
        .getByRole("button", { name: "Nuova connessione", exact: true })
        .click();
      await page
        .locator(".engine-grid button")
        .filter({ hasText: "SQLite" })
        .click();
      await page
        .getByLabel("Nome connessione", { exact: true })
        .fill("QA UI SQLite");
      await page.getByLabel("File SQLite", { exact: true }).fill(demo.filePath);
      const beforeCount = (await call("db.connections")).length;
      await page
        .getByRole("button", { name: "Test connessione", exact: true })
        .click();
      await page
        .getByRole("dialog")
        .locator(".form-success")
        .filter({ hasText: "Connessione riuscita" })
        .waitFor();
      assert.equal((await call("db.connections")).length, beforeCount);
      await page
        .getByRole("button", { name: "Salva e apri", exact: true })
        .click();
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      const savedConnection = (await call("db.connections")).find(
        (profile) => profile.name === "QA UI SQLite",
      );
      assert.ok(savedConnection);
      await page.waitForFunction(
        (id) =>
          document.querySelector('[aria-label="Connessione attiva"]')?.value ===
          id,
        savedConnection.id,
      );
      await rowsReady();
      const selected = await page
        .getByLabel("Connessione attiva", { exact: true })
        .inputValue();
      assert.equal(
        (await call("db.connections")).find(
          (profile) => profile.id === selected,
        ).name,
        "QA UI SQLite",
      );
      await page
        .getByLabel("Connessione attiva", { exact: true })
        .selectOption(demo.id);
      await rowsReady();
      await page
        .locator(".sidebar-bottom")
        .getByRole("button", { name: /Provider AI/ })
        .click();
      await page
        .getByRole("combobox", { name: "Provider AI", exact: true })
        .selectOption("compatible");
      await page
        .getByLabel("Nome profilo AI", { exact: true })
        .fill("QA UI compatible");
      await page.getByLabel("Endpoint AI", { exact: true }).fill(endpoint);
      await page
        .getByLabel("Modello AI", { exact: true })
        .fill("fixture-model");
      if (info.encryptedCredentials)
        await page.getByLabel("API key", { exact: true }).fill(fixtureKey);
      else {
        await page.getByRole("button", { name: "Chiudi", exact: true }).click();
        return {
          blocked: credentialAcceptance
            ? "OS credential acceptance did not complete. SQLite profile test/save succeeded; provider secret persistence remains unverified."
            : "Native credential acceptance is deliberately disabled by default to avoid OS prompts. SQLite profile test/save succeeded; use TABLELINE_E2E_CREDENTIALS=1 only for a supervised native credential run.",
        };
      }
      await page
        .getByRole("button", { name: "Scopri modelli", exact: true })
        .click();
      await page.locator(".provider-form .form-success").waitFor();
      await page
        .getByRole("dialog", { name: "Provider AI", exact: true })
        .getByRole("button", { name: "Test", exact: true })
        .click();
      await page
        .locator(".provider-form .form-success")
        .filter({ hasText: "Connesso" })
        .waitFor();
      await page
        .getByRole("button", { name: "Salva e attiva", exact: true })
        .click();
      await page
        .locator(".provider-form .form-success")
        .filter({ hasText: "Profilo attivo" })
        .waitFor();
      const config = await call("ai.getConfig");
      assert.equal(
        config.profiles.find((profile) => profile.id === config.activeProfileId)
          .name,
        "QA UI compatible",
      );
      await page.getByRole("button", { name: "Chiudi", exact: true }).click();
    },
  );
  await check(
    "UI saves all nine provider profiles using their native auth modes",
    async () => {
      await page
        .locator(".sidebar-bottom")
        .getByRole("button", { name: /Provider AI/ })
        .click();
      for (const provider of [
        "ollama",
        "openai",
        "anthropic",
        "azure",
        "google",
        "vertex",
        "bedrock",
        "litellm",
        "compatible",
      ]) {
        await page
          .getByRole("combobox", { name: "Provider AI", exact: true })
          .selectOption(provider);
        await page
          .getByLabel("Nome profilo AI", { exact: true })
          .fill(`QA profile contract ${provider}`);
        await page
          .getByLabel("Modello AI", { exact: true })
          .fill("fixture-model");
        if (provider === "azure")
          await page
            .getByLabel("Endpoint AI", { exact: true })
            .fill("https://tableline-fixture.openai.azure.com");
        if (provider === "vertex") {
          await page
            .getByLabel("Progetto", { exact: true })
            .fill("tableline-test");
          await page.getByLabel("Location", { exact: true }).fill("global");
        }
        if (provider === "bedrock") {
          await page.getByLabel("Regione", { exact: true }).fill("eu-west-1");
          await page
            .getByLabel("Profilo AWS", { exact: true })
            .fill("tableline-test");
        }
        await page
          .getByRole("button", { name: "Salva e attiva", exact: true })
          .click();
        await page
          .locator(".provider-form .form-success")
          .filter({ hasText: "Profilo attivo" })
          .waitFor();
        const config = await call("ai.getConfig");
        const saved = config.profiles.find(
          (profile) => profile.id === config.activeProfileId,
        );
        assert.equal(saved.provider, provider);
        assert.equal(saved.model, "fixture-model");
        if (provider === "bedrock") assert.equal(saved.authMode, "awsProfile");
        if (provider === "vertex") assert.equal(saved.authMode, "adc");
      }
      await page.getByRole("button", { name: "Chiudi", exact: true }).click();
      return {
        providers: 9,
        externalRequests: 0,
        credentials: "No credentials entered in this metadata-only check.",
      };
    },
  );
  await check(
    "UI command palette, theme and narrow desktop layout",
    async () => {
      await page.keyboard.press(
        process.platform === "darwin" ? "Meta+k" : "Control+k",
      );
      await page.getByLabel("Cerca comando", { exact: true }).fill("orders");
      await page.getByLabel("Cerca comando", { exact: true }).press("Enter");
      await firstCell(1);
      await page
        .getByRole("button", { name: "Cambia tema", exact: true })
        .click();
      assert.equal(
        await page.evaluate(() => document.documentElement.dataset.theme),
        "dark",
      );
      await page.screenshot({ path: path.join(artifacts, "browse-dark.png") });
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setSize(1100, 760),
      );
      await page.waitForFunction(() => window.innerWidth === 1100);
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth,
        ),
        false,
      );
      await page.screenshot({
        path: path.join(artifacts, "narrow-desktop.png"),
      });
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setSize(1512, 980),
      );
    },
  );
  await check("Rendered desktop has no startup exceptions", async () => {
    await page
      .locator("#root")
      .screenshot({ path: path.join(artifacts, "desktop.png") });
    assert.deepEqual(errors, []);
    if (!credentialAcceptance)
      assert.equal(
        await app.evaluate(() => globalThis.tablelineQANativeCredentialCalls),
        0,
        "Non-credential desktop QA must not invoke the Keychain",
      );
    return {
      nativeCredentialCalls: credentialAcceptance
        ? "supervised acceptance enabled"
        : 0,
    };
  });
  await check(
    "Profiles and committed database values survive an application restart",
    async () => {
      await closeDesktop();
      await launch();
      const profiles = await call("db.connections");
      assert.ok(profiles.find((profile) => profile.id === "qa-readonly"));
      assert.ok(
        (await call("ai.getConfig")).profiles.find(
          (profile) => profile.id === "qa-provider",
        ),
      );
      assert.equal(
        (
          await call("db.query", {
            connectionId: demo.id,
            sql: "SELECT name FROM customers WHERE id=1",
          })
        ).rows[0].name,
        "UI approved",
      );
      assert.equal(
        await page.evaluate(() =>
          JSON.parse(localStorage.getItem("tableline.saved")).some(
            (query) => query.name === "QA customer count",
          ),
        ),
        true,
      );
      assert.equal(
        await page.evaluate(() =>
          JSON.parse(localStorage.getItem("tableline.history")).some((query) =>
            query.sql.includes("SELECT missing FROM absent"),
          ),
        ),
        true,
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.dataset.theme),
        "dark",
      );
      assert.deepEqual(errors, []);
      if (!credentialAcceptance)
        assert.equal(
          await app.evaluate(() => globalThis.tablelineQANativeCredentialCalls),
          0,
          "Restart QA must not invoke the Keychain",
        );
      return {
        nativeCredentialCalls: credentialAcceptance
          ? "supervised acceptance enabled"
          : 0,
      };
    },
  );
})()
  .catch(async (error) => {
    console.error(error.message);
    process.exitCode = 1;
    if (page)
      await page
        .screenshot({
          path: path.join(artifacts, "failure.png"),
          timeout: 5000,
        })
        .catch(() => {});
  })
  .finally(async () => {
    if (app) await closeDesktop().catch(() => app.process().kill("SIGKILL"));
    if (server) await new Promise((resolve) => server.close(resolve));
    const report = {
      generatedAt: new Date().toISOString(),
      runtime: process.env.TABLELINE_E2E_EXECUTABLE
        ? "packaged actual Electron desktop"
        : "actual Electron desktop",
      status: process.exitCode ? "failed" : "passed",
      checks: results,
      rendererErrors: errors,
      shutdowns,
      nativeCredentialAcceptance: credentialAcceptance
        ? "explicitly enabled"
        : "disabled; native APIs guarded against invocation",
      network: {
        peer: "loopback disposable compatible-provider fixture",
        requests: networkRequests.length,
      },
      fixtureDirectory: temporary,
      limits: [
        "Remote databases are adapter-contract tested separately; no live cloud account claimed.",
        "Compatible provider is a local HTTP fixture, not a live paid model.",
        "Packaged macOS app is local and unnotarized.",
      ],
    };
    await fs.writeFile(
      path.join(artifacts, "report.json"),
      JSON.stringify(report, null, 2),
    );
    // Keep the isolated database and exports for inspection; never save real secrets.
    console.log(`E2E report: ${path.join(artifacts, "report.json")}`);
  });
