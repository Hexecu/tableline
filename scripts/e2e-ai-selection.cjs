// Copyright (c) 2026 Davide Leopardi
// SPDX-License-Identifier: GPL-3.0-only

"use strict";

// Exercise configuration -> model discovery -> activation -> assistant in the
// production renderer, using disposable data and a loopback model fixture.
const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
let app, server, directory;
const errors = [], requests = [], checks = [];
const check = async (name, work) => {
  await work();
  checks.push(name);
  console.log("PASS", name);
};

(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "tableline-ai-selection-"));
  server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = body ? JSON.parse(body) : null;
    requests.push({ url: request.url, model: payload?.model });
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/v1/models") {
      response.end(JSON.stringify({ data: [{ id: "fixture-chat-a" }, { id: "fixture-chat-b" }] }));
      return;
    }
    assert.equal(request.url, "/v1/chat/completions");
    const content = JSON.parse(payload.messages.findLast(message => message.role === "user").content);
    const context = content.untrusted_database_context;
    const text = context?.toolResults?.length
      ? JSON.stringify({ action: "final", answer: `There are ${context.toolResults[0].result.rows[0].count} customers.` })
      : JSON.stringify({ action: "query_read", sql: "SELECT COUNT(*) AS count FROM customers", params: [] });
    response.end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: "stop" }] }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  await fs.writeFile(path.join(directory, "ai-profiles.json"), JSON.stringify({
    profiles: [{ id: "gateway", name: "LiteLLM QA", provider: "litellm", baseUrl: endpoint, model: "", authMode: "none" }],
    activeProfileId: "gateway",
  }), { mode: 0o600 });
  const launchEnv = { ...process.env, TABLELINE_DEV_URL: "" };
  delete launchEnv.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    executablePath: process.env.TABLELINE_E2E_EXECUTABLE || require("electron"),
    args: [...(process.env.TABLELINE_E2E_EXECUTABLE ? [] : [path.join(root, "electron/main.cjs")]), "--tableline-qa", `--tableline-data=${directory}`],
    env: launchEnv,
    timeout: 20000,
  });
  await app.evaluate(({ safeStorage }) => {
    globalThis.selectionNativeCalls = 0;
    for (const method of ["isAsyncEncryptionAvailable", "encryptStringAsync", "decryptStringAsync"]) safeStorage[method] = () => {
      globalThis.selectionNativeCalls++;
      throw new Error("Native credential access is forbidden in selection QA.");
    };
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  page.on("pageerror", error => errors.push(error.message));
  await page.getByTestId("language-selector").selectOption("en");
  await page.getByRole("button", { name: "Open local demo", exact: true }).click();
  await page.locator(".data-grid tbody tr").first().waitFor();
  const assistantProfile = page.getByLabel("Assistant profile", { exact: true });
  await check("Incomplete profiles cannot be selected for inference", async () => {
    assert.equal(await assistantProfile.inputValue(), "demo");
    assert.equal(await assistantProfile.locator('option[value="gateway"]').isDisabled(), true);
  });
  await page.getByLabel("AI settings", { exact: true }).click();
  await page.locator(".profile-row").filter({ hasText: "LiteLLM QA" }).click();
  await page.getByLabel("Discover models", { exact: true }).click();
  await page.locator(".provider-form .form-success").waitFor();
  await check("Discovery reports the actual provider note and retains exact model IDs", async () => {
    assert.match(await page.locator(".provider-form .form-success").innerText(), /catalog|endpoint|chat/i);
    assert.deepEqual(await page.locator("#model-list option").evaluateAll(options => options.map(option => option.value)), ["fixture-chat-a", "fixture-chat-b"]);
  });
  await page.getByLabel("AI model", { exact: true }).fill("fixture-chat-a");
  await page.getByRole("button", { name: "Save and activate", exact: true }).click();
  await page.locator(".provider-form .form-success").filter({ hasText: "Profile active" }).waitFor();
  await page.getByRole("dialog").getByLabel("Close", { exact: true }).click();
  await check("Save and activate selects the provider on a demo database", async () => {
    await page.waitForFunction(() => document.querySelector('[aria-label="Assistant profile"]')?.value === "gateway");
    assert.match(await page.locator(".destination").innerText(), /fixture-chat-a/);
  });
  await page.getByLabel("Question about data", { exact: true }).fill("How many customers are there?");
  await page.getByLabel("Send question", { exact: true }).click();
  await page.locator(".answer-text").last().waitFor();
  await check("Selected exact model executes a real SQLite read and returns query evidence", async () => {
    assert.match(await page.locator(".answer-text").last().innerText(), /120/);
    assert.match(await page.locator(".query-evidence pre").last().textContent(), /COUNT\(\*\)/);
    assert.equal(requests.filter(request => request.model === "fixture-chat-a").length, 2);
    assert.equal(await page.locator(".assistant .form-error").count(), 0);
  });
  await assistantProfile.selectOption("demo");
  await page.getByLabel("AI settings", { exact: true }).click();
  await page.locator(".profile-row").filter({ hasText: "LiteLLM QA" }).click();
  await page.getByRole("button", { name: "Save and activate", exact: true }).click();
  await page.locator(".provider-form .form-success").filter({ hasText: "Profile active" }).waitFor();
  await page.getByRole("dialog").getByLabel("Close", { exact: true }).click();
  await check("Explicit reactivation overrides a manually selected local demo", async () => {
    await page.waitForFunction(() => document.querySelector('[aria-label="Assistant profile"]')?.value === "gateway");
  });
  await page.getByLabel("AI settings", { exact: true }).click();
  await page.locator(".profile-row").filter({ hasText: "LiteLLM QA" }).click();
  await page.getByLabel("AI model", { exact: true }).fill("fixture-chat-b");
  await page.getByRole("button", { name: "Save and activate", exact: true }).click();
  await page.locator(".provider-form .form-success").filter({ hasText: "Profile active" }).waitFor();
  await page.getByRole("dialog").getByLabel("Close", { exact: true }).click();
  await page.getByLabel("Question about data", { exact: true }).fill("How many customers are there with the other model?");
  await page.getByLabel("Send question", { exact: true }).click();
  await page.locator(".answer-text").nth(1).waitFor();
  await check("Changing the model of an existing profile uses the new exact ID", async () => {
    assert.match(await page.locator(".destination").innerText(), /fixture-chat-b/);
    assert.match(await page.locator(".answer-text").last().innerText(), /120/);
    assert.equal(requests.filter(request => request.model === "fixture-chat-b").length, 2);
  });
  await page.getByLabel("AI settings", { exact: true }).click();
  await page.locator(".profile-row").filter({ hasText: "LiteLLM QA" }).click();
  await page.getByLabel("Discover models", { exact: true }).click();
  await page.locator(".provider-form .form-success").waitFor();
  await page.getByLabel("AI endpoint", { exact: true }).fill(`${endpoint}/other`);
  await check("Changing endpoint clears the stale model catalog", async () => {
    assert.equal(await page.locator("#model-list option").count(), 0);
  });
  await page.getByLabel("AI model", { exact: true }).fill("   ");
  await check("Whitespace-only models cannot be tested or activated", async () => {
    assert.equal(await page.getByRole("button", { name: "Test", exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "Save and activate", exact: true }).isDisabled(), true);
  });
  await check("Selection QA has no renderer errors or OS credential calls", async () => {
    assert.deepEqual(errors, []);
    assert.equal(await app.evaluate(() => globalThis.selectionNativeCalls), 0);
  });
  console.log(JSON.stringify({ passed: checks.length, models: ["fixture-chat-a", "fixture-chat-b"], nativeCredentialCalls: 0 }));
})().catch(error => {
  console.error(error.stack);
  process.exitCode = 1;
}).finally(async () => {
  if (app) await app.close().catch(() => app.process().kill("SIGTERM"));
  if (server) await new Promise(resolve => server.close(resolve));
  if (directory) await fs.rm(directory, { recursive: true, force: true });
});
