// Copyright (c) 2026 Davide Leopardi
// SPDX-License-Identifier: GPL-3.0-only

"use strict";
const crypto = require("node:crypto");
const { guardSql } = require("../sql-guard.cjs");
const MAX_AFFECTED_ROWS = 5000;
function stable(value) {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array)
    return Buffer.from(value).toString("hex");
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stable);
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((k) => [k, stable(value[k])]),
  );
}
function fingerprint(rows) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(rows.map((r) => JSON.stringify(stable(r))).sort()))
    .digest("hex");
}
function projectedParams(sql, tokens, whereStart, dialect, params) {
  const suffix = sql.slice(whereStart);
  let output = suffix,
    bound;
  if (dialect === "postgres") {
    const locations = tokens
      .filter(
        (t) => t.start >= whereStart && t.type === "symbol" && t.value === "$",
      )
      .map((t) => ({
        start: t.start - whereStart,
        match: sql.slice(t.start).match(/^\$(\d+)/),
      }))
      .filter((x) => x.match);
    const ids = [...new Set(locations.map((x) => Number(x.match[1])))];
    bound = ids.map((i) => params[i - 1]);
    for (const p of locations.reverse())
      output =
        output.slice(0, p.start) +
        `$${ids.indexOf(Number(p.match[1])) + 1}` +
        output.slice(p.start + p.match[0].length);
  } else if (dialect === "mysql") {
    const before = tokens.filter(
      (t) => t.type === "symbol" && t.value === "?" && t.start < whereStart,
    ).length;
    const count = tokens.filter(
      (t) => t.type === "symbol" && t.value === "?" && t.start >= whereStart,
    ).length;
    bound = params.slice(before, before + count);
  } else if (dialect === "sqlserver") {
    const names = tokens
      .filter(
        (t) => t.type === "symbol" && t.value === "@" && t.start >= whereStart,
      )
      .map((t) => sql.slice(t.start).match(/^@([A-Za-z_][A-Za-z_0-9]*)/)?.[1])
      .filter(Boolean);
    bound = Object.fromEntries(
      [...new Set(names)].map((name) => [
        name,
        Array.isArray(params)
          ? params[Number(name.replace(/^p/i, "")) - 1]
          : params[name],
      ]),
    );
  } else bound = params;
  if (Object.values(bound).some((v) => v === undefined))
    throw new Error("A WHERE parameter is missing.");
  return { suffix: output, params: bound };
}
function previewSelect(sql, params, dialect) {
  const { tokens, kind } = guardSql(sql, "write");
  if (kind === "insert") return null;
  let start = kind === "delete" ? 2 : 1;
  if (kind === "delete" && tokens[1]?.value !== "FROM")
    throw new Error("Write review supports DELETE FROM table only.");
  let end = start;
  while (end < tokens.length) {
    if (!["word", "identifier"].includes(tokens[end].type))
      throw new Error("Write review needs a simple table identifier.");
    end++;
    if (tokens[end]?.value !== ".") break;
    end++;
  }
  if (kind === "update" && tokens[end]?.value !== "SET")
    throw new Error(
      "Write review supports UPDATE table SET, without target aliases.",
    );
  if (
    kind === "delete" &&
    !["WHERE", "RETURNING"].includes(tokens[end]?.value) &&
    end < tokens.length
  )
    throw new Error(
      "Write review supports a single DELETE table, without joins.",
    );
  let depth = 0,
    where = -1,
    stop = tokens.length;
  for (let i = end; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.value === "(") depth++;
    else if (t.value === ")") depth--;
    if (depth === 0 && t.value === "WHERE") where = i;
    if (depth === 0 && ["RETURNING", "OUTPUT"].includes(t.value)) {
      stop = i;
      break;
    }
    if (depth === 0 && ["FROM", "USING", "LIMIT", "ORDER"].includes(t.value))
      throw new Error(
        "Joined and paginated writes require a simpler statement for review.",
      );
  }
  if (where < 0)
    throw new Error("Remote UPDATE and DELETE require a WHERE clause.");
  const table = sql.slice(tokens[start].start, tokens[end - 1].end);
  const tail = sql.slice(
    0,
    stop < tokens.length ? tokens[stop].start : sql.length,
  );
  const mapped = projectedParams(
    tail,
    tokens.filter((t) => t.start < tail.length),
    tokens[where].start,
    dialect,
    params,
  );
  return {
    sql: `SELECT * FROM ${table} ${mapped.suffix}`,
    params: mapped.params,
  };
}
async function preview(driver, sql, params) {
  const select = previewSelect(sql, params, driver.dialect);
  const warning =
    "Preview does not execute the write. Commit runs in a transaction, with a 5000-row cap; sequences, identities, and external trigger side effects cannot be rolled back. Check database permissions and triggers.";
  if (!select) return { affectedRows: undefined, rows: [], warning };
  const result = await driver.read(
    select.sql,
    select.params,
    MAX_AFFECTED_ROWS,
  );
  if (result.rows.length > MAX_AFFECTED_ROWS)
    throw new Error(
      "Write affects more than 5000 rows. Narrow the WHERE clause.",
    );
  if (
    Buffer.byteLength(JSON.stringify(stable(result.rows)), "utf8") >
    10 * 1024 * 1024
  )
    throw new Error("Write preview exceeds 10 MB. Narrow the WHERE clause.");
  return {
    affectedRows: result.rows.length,
    rows: result.rows.slice(0, 20),
    validation: { ...select, fingerprint: fingerprint(result.rows) },
    warning,
  };
}
function verifyRows(rows, validation) {
  if (
    rows.length > MAX_AFFECTED_ROWS ||
    fingerprint(rows) !== validation.fingerprint
  )
    throw new Error(
      "Matching row values changed since preview. Review the write again.",
    );
}
function verifyAffected(
  affectedRows,
  expectedAffectedRows,
  max = MAX_AFFECTED_ROWS,
) {
  if (affectedRows > max)
    throw new Error(
      `Write exceeds the ${max}-row commit limit and was rolled back.`,
    );
  if (
    expectedAffectedRows !== undefined &&
    affectedRows !== expectedAffectedRows
  )
    throw new Error(
      "Affected rows changed since preview. Review the write again.",
    );
}
module.exports = {
  preview,
  previewSelect,
  fingerprint,
  verifyRows,
  verifyAffected,
  MAX_AFFECTED_ROWS,
};
