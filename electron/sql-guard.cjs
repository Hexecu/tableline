// Copyright (c) 2026 Davide Leopardi
// SPDX-License-Identifier: GPL-3.0-only

"use strict";

// A deliberately small SQL surface. Database-level read-only transactions are a
// second boundary; this guard also excludes extension/UDF calls with side effects.
const SAFE_FUNCTIONS = new Set(
  `abs acos acosh asin asinh atan atan2 atanh avg ceil ceiling char char_length character_length coalesce concat concat_ws cos cosh count date date_add date_diff date_format date_part date_sub date_trunc datediff datetime day dayofmonth dayofweek decode dense_rank extract first_value floor format formatdatetime greatest group_concat hex if ifnull instr json json_array json_array_length json_arrayagg json_build_array json_build_object json_extract json_extract_path_text json_group_array json_group_object json_object json_objectagg json_query json_type json_unquote json_valid json_value jsonb_array_length jsonb_build_array jsonb_build_object jsonb_extract_path_text lag last_value lead least left length ln log log10 lower lpad ltrim max min mod month nullif nth_value ntile octet_length percentile_cont percentile_disc power printf rank replace right round row_number rpad rtrim sin sinh sqrt strftime string_agg substr substring sum tan tanh time timestamp timestampdiff to_char to_date to_timestamp trim trunc typeof unixepoch upper week year`.split(
    /\s+/,
  ),
);
const STRUCTURAL = new Set(
  "IN EXISTS AS OVER FILTER VALUES SELECT WITH ON USING GROUP PARTITION ORDER BY CASE WHEN THEN ELSE DISTINCT ALL NOT AND OR CAST CONVERT EXTRACT".split(
    " ",
  ),
);
for (const name of "iif now current_date current_time current_timestamp current_database current_schema database db_name sqlite_version version generate_series unnest json_each json_tree varchar nvarchar char nchar decimal numeric bigint integer smallint real double float text string timestamp date binary varbinary".split(
  " ",
))
  SAFE_FUNCTIONS.add(name);
const FORBIDDEN = new Set(
  `ALTER ATTACH BEGIN CALL CHECKPOINT COMMIT COPY CREATE DEALLOCATE DELETE DETACH DO DROP EXEC EXECUTE GRANT IMPORT INSERT INSTALL INTO KILL LOAD LOCK MERGE OPTIMIZE PRAGMA REINDEX RELEASE REPLACE RESET REVOKE ROLLBACK SAVEPOINT SET TRUNCATE UNLOAD UPDATE VACUUM USE OUTFILE DUMPFILE`.split(
    " ",
  ),
);

function tokenize(sql) {
  if (typeof sql !== "string" || !sql.trim())
    throw new Error("Enter a SQL statement.");
  if (sql.length > 100000 || sql.includes("\0"))
    throw new Error("SQL is too large or contains invalid characters.");
  const tokens = [];
  for (let i = 0; i < sql.length;) {
    const c = sql[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      i = sql.indexOf("\n", i + 2);
      if (i < 0) break;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      if (sql[i + 2] === "!" || sql[i + 2] === "+")
        throw new Error(
          "Executable comments and optimizer hints are not supported.",
        );
      const end = sql.indexOf("*/", i + 2);
      if (end < 0 || sql.slice(i + 2, end).includes("/*"))
        throw new Error("Unclosed or nested SQL comment.");
      i = end + 2;
      continue;
    }
    if (c === "#") throw new Error("Use standard SQL comments (--).");
    const dollar =
      c === "$" && sql.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/);
    if (dollar) {
      const tag = dollar[0],
        end = sql.indexOf(tag, i + tag.length);
      if (end < 0) throw new Error("Unclosed SQL string.");
      tokens.push({
        type: "literal",
        value: "?",
        start: i,
        end: end + tag.length,
      });
      i = end + tag.length;
      continue;
    }
    if (c === "'" || c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c,
        start = i++;
      let value = "",
        closed = false;
      while (i < sql.length) {
        if (sql[i] === "\\")
          throw new Error("Bind backslash-containing values as parameters.");
        if (sql[i] === close) {
          if (sql[i + 1] === close) {
            value += close;
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        value += sql[i++];
      }
      if (!closed) throw new Error("Unclosed SQL string or identifier.");
      tokens.push({
        type: c === "'" ? "literal" : "identifier",
        value: value.toUpperCase(),
        start,
        end: i,
      });
      continue;
    }
    const word = sql.slice(i).match(/^[A-Za-z_][A-Za-z_0-9$]*/);
    if (word) {
      tokens.push({
        type: "word",
        value: word[0].toUpperCase(),
        start: i,
        end: i + word[0].length,
      });
      i += word[0].length;
      continue;
    }
    tokens.push({ type: "symbol", value: c, start: i, end: i + 1 });
    i++;
  }
  const semis = tokens.filter((t) => t.value === ";");
  if (semis.length > 1 || (semis.length && tokens.at(-1).value !== ";"))
    throw new Error("Run one statement at a time.");
  if (semis.length) tokens.pop();
  if (!tokens.length) throw new Error("Enter a SQL statement.");
  return tokens;
}

function guardSql(sql, mode = "read") {
  const tokens = tokenize(sql),
    first = tokens[0].value;
  if (mode === "read" && !["SELECT", "WITH", "EXPLAIN"].includes(first))
    throw new Error("Read mode accepts SELECT, WITH, and EXPLAIN SELECT only.");
  if (mode === "write" && !["INSERT", "UPDATE", "DELETE"].includes(first))
    throw new Error("Write review accepts a single INSERT, UPDATE, or DELETE.");
  if (first === "EXPLAIN" && !tokens.some((t) => t.value === "SELECT"))
    throw new Error("Only EXPLAIN SELECT is supported.");
  if (
    mode === "read" &&
    tokens.some((t) => t.type === "word" && FORBIDDEN.has(t.value))
  )
    throw new Error(
      "This statement can modify data or session state. Use write review.",
    );
  if (mode === "write") {
    const mutations = tokens.filter(
      (t) =>
        t.type === "word" && ["INSERT", "UPDATE", "DELETE"].includes(t.value),
    );
    if (
      mutations.length !== 1 ||
      tokens.some(
        (t) =>
          t.type === "word" &&
          FORBIDDEN.has(t.value) &&
          !["INSERT", "UPDATE", "DELETE", "INTO", "SET"].includes(t.value),
      )
    )
      throw new Error(
        "Nested mutations, DDL, and session commands are not supported.",
      );
    if (tokens.some((t) => t.value === "WITH"))
      throw new Error(
        "CTE writes are not supported. Use a single DML statement.",
      );
  }
  if (
    tokens.some(
      (t) => t.type === "word" && ["FOR", "ANALYZE"].includes(t.value),
    ) &&
    mode === "read"
  )
    throw new Error("Locking reads and EXPLAIN ANALYZE are not supported.");
  let depth = 0,
    mainStarted = first !== "WITH";
  for (let i = 0; i < tokens.length - 1; i++) {
    const t = tokens[i];
    if (depth === 0 && t.value === "SELECT") mainStarted = true;
    if (
      ["word", "identifier"].includes(t.type) &&
      tokens[i + 1].value === "("
    ) {
      // INSERT INTO table(column, ...) and WITH alias(column, ...) are syntax,
      // not functions. Everything else must be a known pure SQL function.
      const insertTarget =
        mode === "write" &&
        first === "INSERT" &&
        tokens.slice(0, i).some((x) => x.value === "INTO") &&
        !tokens.slice(0, i).some((x) => ["SELECT", "VALUES"].includes(x.value));
      let close = i + 1,
        nesting = 0;
      for (; close < tokens.length; close++) {
        if (tokens[close].value === "(") nesting++;
        if (tokens[close].value === ")" && --nesting === 0) break;
      }
      const cteAlias =
        first === "WITH" &&
        !mainStarted &&
        depth === 0 &&
        ["WITH", "RECURSIVE", ","].includes(tokens[i - 1]?.value) &&
        tokens[close + 1]?.value === "AS";
      if (tokens[i - 1]?.value === "." && !insertTarget)
        throw new Error(
          "Qualified functions are not supported in protected queries.",
        );
      if (
        !insertTarget &&
        !cteAlias &&
        !SAFE_FUNCTIONS.has(t.value.toLowerCase()) &&
        !STRUCTURAL.has(t.value)
      )
        throw new Error(
          `Function ${t.value.toLowerCase()} is not allowed in protected queries.`,
        );
    }
    if (t.value === "(") depth++;
    if (t.value === ")") depth--;
  }
  return {
    sql: sql.slice(0, tokens.at(-1).end).trim(),
    kind: first.toLowerCase(),
    tokens,
  };
}

function quoteIdentifier(value, dialect = "sqlite") {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > 256 ||
    /[\0\r\n]/.test(value)
  )
    throw new Error("Invalid database identifier.");
  if (
    dialect === "mysql" ||
    dialect === "databricks" ||
    dialect === "clickhouse"
  )
    return "`" + value.replaceAll("`", "``") + "`";
  if (dialect === "sqlserver") return "[" + value.replaceAll("]", "]]") + "]";
  return '"' + value.replaceAll('"', '""') + '"';
}

module.exports = { guardSql, tokenize, quoteIdentifier };
