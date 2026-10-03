"use strict";

const { pathToFileURL } = require("node:url");

const CHANNEL = "tableline:call";
const MAX_REQUEST_BYTES = 1_048_576;
const MAX_EXPORT_REQUEST_BYTES = 32 * 1024 * 1024;
const METHOD_ARGUMENTS = Object.freeze({
  "db.catalog": 0,
  "db.connections": 0,
  "db.saveConnection": 2,
  "db.testConnection": 2,
  "db.removeConnection": 1,
  "db.connect": 1,
  "db.schema": 1,
  "db.query": 1,
  "db.browse": 1,
  "db.prepareWrite": 1,
  "db.commitWrite": 1,
  "db.discardWrite": 1,
  "db.cancel": 1,
  "db.demo": 0,
  "db.close": 1,
  "ai.getConfig": 0,
  "ai.saveProfile": 2,
  "ai.selectProfile": 2,
  "ai.removeProfile": 1,
  "ai.discoverModels": 1,
  "ai.test": 2,
  "ai.providerDestination": 1,
  "assistant.ask": 1,
  "runtime.info": 0,
  "runtime.setLanguage": 1,
  "native.pickFile": 1,
  "native.export": 1,
});

function failure(message, code = "INVALID_REQUEST") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertRequest(method, args) {
  if (typeof method !== "string" || !Object.hasOwn(METHOD_ARGUMENTS, method)) {
    throw failure("This operation is unavailable.", "METHOD_NOT_ALLOWED");
  }
  if (!Array.isArray(args) || args.length > METHOD_ARGUMENTS[method]) {
    throw failure("Invalid operation arguments.");
  }
  let encoded;
  try {
    encoded = JSON.stringify(args);
  } catch {
    throw failure("Arguments must be serializable.");
  }
  const maximum =
    method === "native.export" ? MAX_EXPORT_REQUEST_BYTES : MAX_REQUEST_BYTES;
  if (typeof encoded !== "string" || Buffer.byteLength(encoded) > maximum) {
    throw failure("The request is too large.", "PAYLOAD_TOO_LARGE");
  }
  function visit(value, depth = 0) {
    if (depth > 40) throw failure("Arguments are nested too deeply.");
    if (
      value === null ||
      value === undefined ||
      ["string", "boolean"].includes(typeof value)
    )
      return;
    if (typeof value === "number" && Number.isFinite(value)) return;
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1));
      return;
    }
    if (
      typeof value !== "object" ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      throw failure("Arguments must contain plain JSON values.");
    }
    for (const [key, item] of Object.entries(value)) {
      if (["__proto__", "constructor", "prototype"].includes(key))
        throw failure("Invalid argument key.");
      visit(item, depth + 1);
    }
  }
  args.forEach((item) => visit(item));
}

function documentURL(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.search = "";
    return parsed.href;
  } catch {
    return null;
  }
}

function allowedDocument(url, { indexPath, devURL } = {}) {
  const actual = documentURL(url);
  if (!actual) return false;
  if (devURL) return actual === documentURL(devURL);
  return actual === pathToFileURL(indexPath).href;
}

function assertSender(event, window, options) {
  if (
    !window ||
    window.isDestroyed() ||
    event.sender !== window.webContents ||
    !event.senderFrame ||
    event.senderFrame !== window.webContents.mainFrame ||
    !allowedDocument(event.senderFrame.url, options)
  ) {
    throw failure("This page cannot access Tableline.", "UNTRUSTED_SENDER");
  }
}

function safeError(error) {
  let message = String(error?.message || "The operation failed.");
  message = message
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(
      /\b(password|api[_-]?key|token|secret|authorization)\s*[:=]\s*([^\s,;]+)/gi,
      "$1=[redacted]",
    )
    .replace(/\bBearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
      "[redacted private key]",
    );
  return {
    message: message.slice(0, 1500),
    code:
      typeof error?.code === "string"
        ? error.code.slice(0, 80)
        : "OPERATION_FAILED",
  };
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const raw = typeof value === "object" ? JSON.stringify(value) : String(value);
  // CSV files are often opened in spreadsheet apps. Prefix executable formulas.
  const text =
    /^[\s\t\r\n]*[=+@-]/.test(raw) && typeof value === "string"
      ? `'${raw}`
      : raw;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function exportContent(payload) {
  if (
    !payload ||
    !["csv", "json"].includes(payload.format) ||
    !Array.isArray(payload.rows)
  ) {
    throw failure("Choose CSV or JSON and provide rows.");
  }
  if (payload.rows.length > 100_000)
    throw failure("Export supports up to 100,000 rows.", "PAYLOAD_TOO_LARGE");
  const columns = (payload.columns || Object.keys(payload.rows[0] || {})).map(
    (column) =>
      typeof column === "string"
        ? { key: column, name: column }
        : {
            key: column?.key || column?.name,
            name: column?.name || column?.key,
          },
  );
  if (
    columns.some(
      (column) =>
        typeof column.key !== "string" || typeof column.name !== "string",
    )
  ) {
    throw failure("Invalid export columns.");
  }
  const body =
    payload.format === "json"
      ? `${JSON.stringify(payload.rows, null, 2)}\n`
      : "\uFEFF" +
        [
          columns.map((column) => csvCell(column.name)).join(","),
          ...payload.rows.map((row) =>
            columns
              .map((column, index) =>
                csvCell(Array.isArray(row) ? row[index] : row?.[column.key]),
              )
              .join(","),
          ),
        ].join("\r\n") +
        "\r\n";
  if (Buffer.byteLength(body) > 32 * 1024 * 1024)
    throw failure("Export exceeds 32 MiB.", "PAYLOAD_TOO_LARGE");
  return body;
}

module.exports = {
  CHANNEL,
  METHOD_ARGUMENTS,
  MAX_REQUEST_BYTES,
  MAX_EXPORT_REQUEST_BYTES,
  assertRequest,
  assertSender,
  allowedDocument,
  safeError,
  exportContent,
  failure,
};
