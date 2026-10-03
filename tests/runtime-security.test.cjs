"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const {
  assertRequest,
  assertSender,
  allowedDocument,
  safeError,
  exportContent,
} = require("../electron/runtime-security.cjs");

test("IPC only permits explicit methods and bounded plain JSON", () => {
  assert.doesNotThrow(() =>
    assertRequest("db.saveConnection", [
      { id: "test", driver: "sqlite" },
      { password: "secret" },
    ]),
  );
  assert.throws(() => assertRequest("db.constructor", []), {
    code: "METHOD_NOT_ALLOWED",
  });
  assert.throws(() => assertRequest("native.openShell", []), {
    code: "METHOD_NOT_ALLOWED",
  });
  assert.throws(
    () => assertRequest("db.query", [{ sql: "x".repeat(1_048_577) }]),
    { code: "PAYLOAD_TOO_LARGE" },
  );
  assert.doesNotThrow(() =>
    assertRequest("native.export", [
      { format: "json", rows: [{ value: "x".repeat(1_048_577) }] },
    ]),
  );
  assert.throws(
    () => assertRequest("db.query", [JSON.parse('{"__proto__":{}}')]),
    /Invalid argument key/,
  );
  assert.throws(() => assertRequest("db.query", [new Date()]), /plain JSON/);
  assert.throws(() => assertRequest("db.catalog", [{}]), /arguments/);
  assert.doesNotThrow(() =>
    assertRequest("db.query", [{ sql: "SELECT 1", optional: undefined }]),
  );
  assert.throws(
    () => assertRequest("db.query", [{ sql: () => "SELECT 1" }]),
    /plain JSON/,
  );
});

test("IPC rejects other windows, child frames and remote pages", () => {
  const mainFrame = { url: "http://127.0.0.1:5188/" };
  const webContents = { mainFrame };
  const window = { isDestroyed: () => false, webContents };
  const options = { devURL: "http://127.0.0.1:5188" };
  assert.doesNotThrow(() =>
    assertSender(
      { sender: webContents, senderFrame: mainFrame },
      window,
      options,
    ),
  );
  assert.throws(
    () => assertSender({ sender: {}, senderFrame: mainFrame }, window, options),
    { code: "UNTRUSTED_SENDER" },
  );
  assert.throws(
    () =>
      assertSender(
        { sender: webContents, senderFrame: { ...mainFrame } },
        window,
        options,
      ),
    { code: "UNTRUSTED_SENDER" },
  );
  mainFrame.url = "https://example.com/";
  assert.throws(
    () =>
      assertSender(
        { sender: webContents, senderFrame: mainFrame },
        window,
        options,
      ),
    { code: "UNTRUSTED_SENDER" },
  );
});

test("document allowlist matches the exact app document", () => {
  const indexPath = "/tmp/Tableline/dist/index.html";
  assert.equal(
    allowedDocument(pathToFileURL(indexPath).href + "#workspace", {
      indexPath,
    }),
    true,
  );
  assert.equal(allowedDocument("file:///tmp/other.html", { indexPath }), false);
  assert.equal(
    allowedDocument("http://127.0.0.1:5188.evil.test/", {
      devURL: "http://127.0.0.1:5188",
    }),
    false,
  );
  assert.equal(
    allowedDocument("http://localhost:5188/", {
      devURL: "http://127.0.0.1:5188",
    }),
    false,
  );
});

test("CSV export preserves quotes, Unicode and newlines while neutralizing formula strings", () => {
  const body = exportContent({
    format: "csv",
    columns: ["label", "value"],
    rows: [
      {
        label: 'caffè, "yes"\nnext',
        value: '=HYPERLINK("https://example.com")',
      },
      { label: "-danger", value: -42 },
      { label: null, value: true },
    ],
  });
  assert.equal(body[0], "\uFEFF");
  assert.match(body, /"caffè, ""yes""\nnext"/);
  assert.match(body, /'\=HYPERLINK/);
  assert.match(body, /'-danger,-42/);
  assert.match(body, /,true\r\n$/);
  assert.deepEqual(
    JSON.parse(exportContent({ format: "json", rows: [{ id: 1, ok: true }] })),
    [{ id: 1, ok: true }],
  );
  assert.equal(
    exportContent({
      format: "csv",
      columns: [{ name: "id", type: "INTEGER" }],
      rows: [{ id: 7 }],
    }),
    "\uFEFFid\r\n7\r\n",
  );
  assert.throws(
    () => exportContent({ format: "exe", rows: [] }),
    /CSV or JSON/,
  );
});

test("error envelope removes recognizable secrets and bounds output", () => {
  const error = new Error(
    "postgres://alice:password@host/db token=abc Bearer foo apiKey:xyz",
  );
  error.code = "DB_ERROR";
  assert.deepEqual(safeError(error), {
    code: "DB_ERROR",
    message:
      "postgres://[redacted]@host/db token=[redacted] Bearer [redacted] apiKey=[redacted]",
  });
  assert.equal(safeError(new Error("x".repeat(2000))).message.length, 1500);
});
