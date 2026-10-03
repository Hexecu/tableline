"use strict";

// Opt-in acceptance run against the root task's disposable Docker fixtures.
// This script reads fixture databases only. It creates app profiles in a fresh
// temporary directory and uses a deterministic localhost assistant transport.
const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const root = path.resolve(__dirname, "..");
const artifacts = path.join(
  root,
  "artifacts",
  "e2e",
  "fixtures",
  process.env.TABLELINE_E2E_EXECUTABLE ? "packaged" : "source",
);
const checks = [],
  errors = [];
let app, page, server, directory;
const selectedDrivers =
  process.env.TABLELINE_FIXTURE_DRIVERS?.split(",").filter(Boolean);
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
async function call(method, ...args) {
  return bounded(
    page.evaluate(
      ({ method, args }) => window.tableline.call(method, ...args),
      { method, args },
    ),
    15000,
    method,
  );
}
async function rowsReady() {
  await page.waitForFunction(
    () =>
      document.querySelectorAll(".data-grid tbody tr").length > 0 &&
      !document.querySelector(".grid-progress"),
  );
}
async function check(name, task) {
  const start = performance.now();
  try {
    await bounded(Promise.resolve().then(task), 45000, name);
    checks.push({
      name,
      status: "passed",
      durationMs: Math.round(performance.now() - start),
    });
    console.log(`PASS ${name}`);
  } catch (error) {
    checks.push({ name, status: "failed", error: error.message });
    throw error;
  }
}
function infer(body) {
  const user = JSON.parse(
    body.messages.findLast((message) => message.role === "user").content,
  );
  const context = user.untrusted_database_context;
  if (context.toolResults?.length) {
    const first = context.toolResults[0].result.rows[0];
    return {
      action: "final",
      answer:
        context.dialect === "redis"
          ? `Stato verificato: ${first.value}.`
          : `${first.count} clienti verificati.`,
    };
  }
  return {
    action: "query_read",
    params: [],
    sql:
      context.dialect === "mongodb"
        ? JSON.stringify({
            collection: "customers",
            operation: "count",
            filter: {},
          })
        : context.dialect === "redis"
          ? JSON.stringify({ command: "GET", args: ["fixture:status"] })
          : "SELECT count() AS count FROM customers",
  };
}

(async () => {
  await fs.mkdir(artifacts, { recursive: true });
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "tableline-live-ui-"));
  server = http.createServer(async (request, response) => {
    try {
      let data = "";
      for await (const chunk of request) {
        data += chunk;
        if (data.length > 100000) throw new Error("oversize");
      }
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: { content: JSON.stringify(infer(JSON.parse(data))) },
            },
          ],
        }),
      );
    } catch {
      response.statusCode = 400;
      response.end("{}");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const executablePath =
    process.env.TABLELINE_E2E_EXECUTABLE || require("electron");
  app = await electron.launch({
    executablePath,
    args: [
      ...(process.env.TABLELINE_E2E_EXECUTABLE
        ? []
        : [path.join(root, "electron", "main.cjs")]),
      "--tableline-qa",
      `--tableline-data=${directory}`,
    ],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "", TABLELINE_DEV_URL: "" },
    timeout: 45000,
  });
  page = await app.firstWindow({ timeout: 15000 });
  await app.evaluate(({ safeStorage }) => {
    globalThis.tablelineQANativeCredentialCalls = 0;
    for (const method of ["isAsyncEncryptionAvailable", "encryptStringAsync", "decryptStringAsync"])
      safeStorage[method] = () => {
        globalThis.tablelineQANativeCredentialCalls++;
        throw new Error("Fixture desktop QA must not invoke native credential APIs.");
      };
  });
  page.setDefaultTimeout(15000);
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
  await call("ai.saveProfile", {
    id: "qa-document-ai",
    provider: "compatible",
    name: "Fixture assistant",
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    model: "fixture-model",
    authMode: "none",
  });
  await call("ai.selectProfile", "qa-document-ai");
  let profiles = [
    {
      id: "qa-mongodb",
      name: "QA MongoDB",
      driver: "mongodb",
      host: "127.0.0.1",
      port: 57028,
      database: "tableline_fixture",
      ssl: false,
      readOnly: true,
    },
    {
      id: "qa-redis",
      name: "QA Redis",
      driver: "redis",
      host: "127.0.0.1",
      port: 56388,
      database: "0",
      ssl: false,
      readOnly: true,
    },
    {
      id: "qa-clickhouse",
      name: "QA ClickHouse",
      driver: "clickhouse",
      host: "127.0.0.1",
      port: 58138,
      database: "default",
      username: "tableline_qa",
      ssl: false,
      readOnly: true,
    },
  ];
  if (selectedDrivers) {
    assert.ok(
      selectedDrivers.length > 0,
      "Select at least one fixture driver.",
    );
    assert.ok(
      selectedDrivers.every((driver) =>
        profiles.some((profile) => profile.driver === driver),
      ),
      "Unknown fixture driver.",
    );
    profiles = profiles.filter((profile) =>
      selectedDrivers.includes(profile.driver),
    );
  }
  for (const profile of profiles)
    await call(
      "db.saveConnection",
      profile,
      {},
    );
  await page.reload();
  await page.getByLabel("Connessione attiva", { exact: true }).waitFor();
  for (const profile of profiles) {
    await check(
      `${profile.driver}: actual desktop browse, paging, native query and grounded assistant`,
      async () => {
        await page
          .getByLabel("Connessione attiva", { exact: true })
          .selectOption(profile.id);
        await rowsReady();
        assert.equal(
          await page
            .getByLabel("Connessione attiva", { exact: true })
            .inputValue(),
          profile.id,
        );
        await page
          .getByLabel("Righe per pagina", { exact: true })
          .selectOption("50");
        await page.waitForFunction(
          () =>
            document.querySelectorAll(".data-grid tbody tr").length === 50 &&
            !document.querySelector(".grid-progress"),
        );
        const firstPage = await page
          .locator(".data-grid tbody tr td:nth-child(2)")
          .allTextContents();
        await page
          .getByRole("button", { name: "Pagina successiva", exact: true })
          .click();
        await page.waitForFunction(
          (first) =>
            !document.querySelector(".grid-progress") &&
            document.querySelector(".data-grid tbody tr td:nth-child(2)")
              ?.textContent !== first,
          firstPage[0],
        );
        const secondPage = await page
          .locator(".data-grid tbody tr td:nth-child(2)")
          .allTextContents();
        assert.equal(
          secondPage.some((value) => firstPage.includes(value)),
          false,
        );
        await page
          .getByRole("button", { name: "Pagina precedente", exact: true })
          .click();
        await page.waitForFunction(
          (first) =>
            !document.querySelector(".grid-progress") &&
            document.querySelector(".data-grid tbody tr td:nth-child(2)")
              ?.textContent === first,
          firstPage[0],
        );
        await page
          .getByRole("button", {
            name: ["mongodb", "redis"].includes(profile.driver)
              ? "Query"
              : "SQL",
            exact: true,
          })
          .click();
        const initial = await page
          .getByLabel("Editor SQL", { exact: true })
          .inputValue();
        if (profile.driver === "mongodb")
          assert.equal(JSON.parse(initial).collection, "customers");
        if (profile.driver === "redis")
          assert.equal(JSON.parse(initial).command, "SCAN");
        const sql =
          profile.driver === "mongodb"
            ? JSON.stringify(
                { collection: "customers", operation: "count", filter: {} },
                null,
                2,
              )
            : profile.driver === "redis"
              ? JSON.stringify(
                  { command: "GET", args: ["fixture:status"] },
                  null,
                  2,
                )
              : "SELECT count() AS count FROM customers";
        await page.getByLabel("Editor SQL", { exact: true }).fill(sql);
        await page.locator(".run-button").click();
        await page.waitForFunction(
          (expected) =>
            document
              .querySelector(".data-grid tbody tr")
              ?.textContent.includes(expected) &&
            !document.querySelector(".grid-progress"),
          profile.driver === "redis" ? "reviewed" : "127",
        );
        if (
          !(await page
            .getByLabel("Profilo assistente", { exact: true })
            .count())
        )
          await page
            .getByRole("button", { name: "Assistente", exact: true })
            .click();
        await page
          .getByLabel("Profilo assistente", { exact: true })
          .selectOption("qa-document-ai");
        await page
          .getByLabel("Domanda sui dati", { exact: true })
          .fill(
            profile.driver === "redis"
              ? "Fixture GET fixture:status"
              : "Fixture count customers",
          );
        await page
          .getByRole("button", { name: "Invia domanda", exact: true })
          .click();
        await page
          .locator(".answer-text")
          .filter({ hasText: profile.driver === "redis" ? /reviewed/ : /127/ })
          .waitFor();
        await page.locator(".query-evidence summary").last().click();
        assert.match(
          await page.locator(".query-evidence pre").last().innerText(),
          profile.driver === "redis" ? /fixture:status/ : /customers/,
        );
        assert.deepEqual(errors, []);
        assert.equal(await app.evaluate(() => globalThis.tablelineQANativeCredentialCalls), 0);
        await page.screenshot({
          path: path.join(artifacts, `${profile.driver}.png`),
        });
      },
    );
  }
})()
  .catch(async (error) => {
    process.exitCode = 1;
    console.error(error.message);
    if (page)
      await page
        .screenshot({
          path: path.join(artifacts, "failure.png"),
          timeout: 5000,
        })
        .catch(() => {});
  })
  .finally(async () => {
    if (app)
      await bounded(app.close(), 8000, "Electron shutdown").catch(() =>
        app.process().kill("SIGKILL"),
      );
    if (server) await new Promise((resolve) => server.close(resolve));
    await fs.writeFile(
      path.join(artifacts, "report.json"),
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          status: process.exitCode ? "failed" : "passed",
          runtime: process.env.TABLELINE_E2E_EXECUTABLE
            ? "packaged actual Electron desktop"
            : "actual Electron desktop",
          requestedDrivers: selectedDrivers || [
            "mongodb",
            "redis",
            "clickhouse",
          ],
          checks,
          rendererErrors: errors,
          limits: [
            "Read-only access to disposable local Redis, MongoDB and ClickHouse containers.",
            "Assistant uses a deterministic localhost protocol fixture; it reads real database rows.",
            "No remote cloud service or paid LLM access claimed.",
          ],
        },
        null,
        2,
      ),
    );
    console.log(`Fixture UI report: ${path.join(artifacts, "report.json")}`);
  });
