// Copyright (c) 2026 Davide Leopardi
// SPDX-License-Identifier: GPL-3.0-only

"use strict";

const {
  command: documentCommand,
  redisCommand,
} = require("./drivers/document.cjs");
const MAX_TOOL_ROUNDS = 4;
const MAX_QUERY_ROWS = 100;
const WRITE_INTENT =
  /\b(aggiorna|modifica|imposta|cambia|segna|elimina|rimuovi|cancella|inserisci|aggiungi|update|set|delete|remove|insert|add|change|mark|actualise|actualisez|mets a jour|mettez a jour|modifie|modifiez|definis|supprime|supprimez|ajoute|ajoutez|insere|inserez|aktualisiere|aktualisieren|andere|andern|setze|setzen|losche|loschen|entferne|entfernen|fuge hinzu|hinzufugen|actualiza|actualice|modifica|establece|cambia|elimina|borra|inserta|anade|agrega)\b/i;
const LANGUAGES = ["en", "it", "fr", "de", "es"];
function normalizedRequest(value) {
  return value.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
}
const UNSAFE_READ =
  /\b(insert|update|delete|merge|replace|drop|alter|create|truncate|grant|revoke|call|exec|execute|copy|attach|detach|vacuum|pragma|into|set|use|begin|commit|rollback|savepoint|lock|unlock|load|outfile|dumpfile|pg_sleep|sleep|benchmark|load_file|read_csv|read_parquet|read_json|readfile|writefile|openrowset|opendatasource|dblink|pg_read_file|pg_read_binary_file|pg_write_file|pg_ls_dir|lo_import|lo_export|sys_eval|sys_exec|http_get|http_post)\b/i;

function plain(value) {
  return (
    value &&
    typeof value === "object" &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  );
}

// SQL returned by a model is untrusted. The database applies its own dialect-aware
// policy and read-only transaction too; this independent guard prevents dispatch
// of writes or external access through the assistant's read tool.
function tokens(sql, dialect = "unknown") {
  if (
    typeof sql !== "string" ||
    !sql.trim() ||
    sql.length > 16000 ||
    sql.includes("\0") ||
    (dialect !== "sqlite" && sql.includes("\\"))
  )
    throw new Error("SQL AI non valido.");
  let clean = "",
    statements = 0;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i],
      next = sql[i + 1];
    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      const begin = i + 1;
      if (quote === "'") clean += " value ";
      let closed = false;
      for (i++; i < sql.length; i++) {
        if (sql[i] === "\\") {
          if (dialect !== "sqlite" || quote !== "'")
            throw new Error("SQL AI non valido.");
          // SQLite treats backslash as an ordinary literal character. It never
          // escapes the following apostrophe; only doubled apostrophes do that.
          continue;
        }
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i++;
            continue;
          }
          closed = true;
          break;
        }
      }
      if (!closed) throw new Error("SQL AI contiene una stringa non chiusa.");
      if (quote !== "'") clean += " " + sql.slice(begin, i) + " ";
    } else if (c === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      if (sql.slice(i, end < 0 ? sql.length : end).includes("\\"))
        throw new Error("SQL AI non valido.");
      while (i < sql.length && sql[i] !== "\n") i++;
      clean += " ";
    } else if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end < 0 || sql[i + 2] === "!")
        throw new Error("Commento SQL non supportato.");
      if (sql.slice(i, end + 2).includes("\\"))
        throw new Error("SQL AI non valido.");
      i = end + 1;
      clean += " ";
    } else if (c === ";") {
      statements++;
      if (sql.slice(i + 1).trim())
        throw new Error("L'assistente consente una sola istruzione SQL.");
    } else if (c === "\\") throw new Error("SQL AI non valido.");
    else clean += c;
  }
  if (statements > 1 || /\$[a-zA-Z_]*\$/.test(clean))
    throw new Error("SQL AI non supportato.");
  return clean.trim();
}
function readSQL(sql, dialect = "unknown") {
  const clean = tokens(sql, dialect);
  if (
    !/^(select|with|explain\s+select|explain\s+with)\b/i.test(clean) ||
    UNSAFE_READ.test(clean) ||
    /\bfor\s+(update|share)\b/i.test(clean)
  )
    throw new Error(
      "La modalità lettura consente solo query SELECT senza scritture o accessi esterni.",
    );
  return sql.trim();
}
function writeSQL(sql, dialect = "unknown") {
  const clean = tokens(sql, dialect);
  if (
    !/^(update|insert\s+into|delete\s+from)\b/i.test(clean) ||
    /\b(returning|copy|call|exec|execute|create|drop|alter|truncate|grant|revoke)\b/i.test(
      clean,
    )
  )
    throw new Error("Sono ammesse solo proposte INSERT, UPDATE o DELETE.");
  if (/^(update|delete)\b/i.test(clean) && !/\bwhere\b/i.test(clean))
    throw new Error("La proposta deve delimitare le righe con WHERE.");
  return sql.trim();
}
function params(input) {
  if (input === undefined) return [];
  if (
    (!Array.isArray(input) && !plain(input)) ||
    Object.keys(input).length > 100 ||
    (!Array.isArray(input) &&
      Object.keys(input).some(
        (key) =>
          !/^[A-Za-z_][A-Za-z_0-9]{0,63}$/.test(key) ||
          ["__proto__", "constructor", "prototype"].includes(key),
      ))
  )
    throw new Error("Parametri SQL AI non validi.");
  const values = Object.values(input);
  if (
    values.some(
      (value) =>
        value !== null &&
        !["string", "number", "boolean"].includes(typeof value),
    ) ||
    values.some((value) => typeof value === "string" && value.length > 8000) ||
    values.some((value) => typeof value === "number" && !Number.isFinite(value))
  )
    throw new Error("Parametri SQL AI non validi.");
  return structuredClone(input);
}
function dataCommand(input, dialect, mode, schema) {
  if (!["mongodb", "redis"].includes(dialect))
    return mode === "read" ? readSQL(input, dialect) : writeSQL(input, dialect);
  if (typeof input !== "string" || !input.trim() || input.length > 16000)
    throw new Error("Comando dati AI non valido.");
  const value = documentCommand(input);
  if (dialect === "redis") {
    const validated = redisCommand(JSON.stringify(value), mode === "write");
    return JSON.stringify({ command: validated.cmd, args: validated.args });
  }
  if (
    typeof value.collection !== "string" ||
    !schema.tables.some((table) => table.name === value.collection)
  )
    throw new Error("Usa una collection presente nello schema scoperto.");
  if (mode === "read") {
    if (!["find", "aggregate", "count"].includes(value.operation))
      throw new Error(
        "Lettura MongoDB: sono consentite solo find, aggregate e count.",
      );
    if (
      value.operation === "aggregate" &&
      (!Array.isArray(value.pipeline) ||
        value.pipeline.some(
          (stage) =>
            !plain(stage) ||
            Object.keys(stage).length !== 1 ||
            ![
              "$match",
              "$group",
              "$sort",
              "$limit",
              "$skip",
              "$project",
              "$count",
              "$unwind",
              "$addFields",
              "$set",
              "$unset",
              "$replaceRoot",
            ].includes(Object.keys(stage)[0]),
        ))
    )
      throw new Error(
        "Pipeline MongoDB non supportata: scritture e JavaScript sono disabilitati.",
      );
  } else {
    if (!["insertOne", "updateMany", "deleteMany"].includes(value.operation))
      throw new Error(
        "Scrittura MongoDB: sono consentite solo proposte insertOne, updateMany e deleteMany.",
      );
    if (
      value.operation !== "insertOne" &&
      (!plain(value.filter) || !Object.keys(value.filter).length)
    )
      throw new Error("Una proposta MongoDB richiede un filtro non vuoto.");
    if (value.operation === "insertOne" && !plain(value.document))
      throw new Error("insertOne richiede un documento.");
    if (
      value.operation === "updateMany" &&
      (!plain(value.update) ||
        !Object.keys(value.update).length ||
        Object.keys(value.update).some(
          (key) =>
            ![
              "$set",
              "$unset",
              "$inc",
              "$min",
              "$max",
              "$rename",
              "$push",
              "$pull",
              "$addToSet",
            ].includes(key),
        ))
    )
      throw new Error("Aggiornamento MongoDB non supportato.");
  }
  return JSON.stringify(value);
}
function syntaxGuide(dialect) {
  if (dialect === "mongodb")
    return 'sql must contain a JSON-encoded command string. Read format: {"collection":"DISCOVERED_COLLECTION","operation":"find|count|aggregate","filter":{},"projection":{},"pipeline":[]}. Write proposal format: {"collection":"DISCOVERED_COLLECTION","operation":"insertOne|updateMany|deleteMany","filter":{"DISCOVERED_FIELD":"BOUND_VALUE"},"document":{},"update":{"$set":{"DISCOVERED_FIELD":"BOUND_VALUE"}}}. Use actual discovered names; no JavaScript, $out, $merge, $lookup or administrative commands. JSON command values belong inside the command, params must be empty.';
  if (dialect === "redis")
    return 'sql must contain a JSON-encoded command string: {"command":"COMMAND","args":["KEY", "ARGUMENT"]}. Read commands GET,MGET,HGET,HGETALL,HMGET,LRANGE,LLEN,SCARD,SISMEMBER,SMEMBERS,ZRANGE,ZCARD,ZSCORE,TYPE,TTL,PTTL,EXISTS,STRLEN,SCAN. Write proposals SET,DEL,HSET,HDEL,LPUSH,RPUSH,SADD,SREM,ZADD,ZREM,EXPIRE,PERSIST. Never EVAL,FLUSHALL,CONFIG or arbitrary commands. Range reads require finite positive start/end. params must be empty.';
  if (dialect === "clickhouse")
    return 'Use SQL with named typed placeholders {name:String} and params as an object {"name":"value"}.';
  return "Use a single SQL statement and scalar bound parameters in the database dialect.";
}
function decisionOf(text) {
  if (typeof text !== "string" || text.length > 24000)
    throw new Error("Risposta strutturata AI non valida.");
  let parsed;
  try {
    parsed = JSON.parse(
      text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, "$1"),
    );
  } catch {
    const error = new Error(
      "Il modello deve restituire una decisione JSON valida. Nessuna ulteriore query eseguita.",
    );
    error.code = "AI_INVALID_DECISION_JSON";
    throw error;
  }
  if (
    !plain(parsed) ||
    !["query_read", "prepare_write", "final"].includes(parsed.action)
  )
    throw new Error("Strumento AI non supportato. Nessuna ulteriore azione eseguita.");
  if (
    parsed.action === "final" &&
    (typeof parsed.answer !== "string" ||
      !parsed.answer.trim() ||
      parsed.answer.length > 8000)
  )
    throw new Error("Risposta finale AI non valida.");
  return parsed;
}

function zeroResultKind(result, sql, dialect) {
  if (!result || result.truncated || !Array.isArray(result.rows)) return;
  if (result.rows.length === 0) return "rows";
  if (result.rows.length !== 1 || result.columns?.length !== 1) return;
  const row = result.rows[0];
  if (!plain(row) || Object.keys(row).length !== 1) return;
  const column = result.columns[0];
  const key = typeof column === "string" ? column : column?.name;
  if (typeof key !== "string" || !Object.hasOwn(row, key)) return;
  if (![0, 0n, "0"].includes(row[key])) return;
  // tokens() removes identifier quotes: COUNT("1") or COUNT("*") could refer
  // to nullable columns rather than count rows. Keep quoted SQL outside this
  // conservative classifier; the actual-empty-rows check above still applies.
  if (typeof sql !== "string" || /["`]/.test(sql)) return;
  let clean;
  try {
    clean = tokens(sql, dialect);
  } catch {
    return;
  }
  // Deliberately recognize only direct scalar COUNT(*) or COUNT(1). COUNT(column)
  // can be zero for nonempty rows with NULL values. SUMs, expressions, grouped
  // counts and percentages also remain outside this narrow match-count guard.
  if (/\b(group\s+by|having|union|intersect|except)\b/i.test(clean)) return;
  if (/^select\s+(?:all\s+)?count\s*\(\s*(?:\*|1)\s*\)\s*(?:(?:as\s+)?[a-z_][a-z_0-9$]*\s+)?from\b/i.test(clean))
    return "count";
}

function safeHistory(history) {
  if (history === undefined) return [];
  if (!Array.isArray(history) || history.length > 100)
    throw new Error("Cronologia AI non valida.");
  return history.slice(-4).map((item) => {
    if (!plain(item)) return { text: "" };
    const value = item.content || item.text || item.answer || item.prompt || "";
    return {
      speaker: ["user", "assistant"].includes(item.role)
        ? item.role
        : "untrusted",
      text: typeof value === "string" ? value.slice(0, 800) : "",
    };
  });
}
function trimData(result, byteBudget = 4000) {
  const output = {
    columns: [],
    rowCount: Number.isFinite(Number(result.rowCount))
      ? Number(result.rowCount)
      : undefined,
    truncated: !!result.truncated,
    rows: [],
  };
  for (const column of (result.columns || []).slice(0, 60)) {
    const metadata =
      typeof column === "string"
        ? { name: column.slice(0, 200) }
        : {
            name: String(column.name || "").slice(0, 200),
            type:
              typeof column.type === "string"
                ? column.type.slice(0, 100)
                : undefined,
          };
    output.columns.push(metadata);
    if (Buffer.byteLength(JSON.stringify(output)) > byteBudget / 2) {
      output.columns.pop();
      output.truncated = true;
      break;
    }
  }
  const source = Array.isArray(result.rows) ? result.rows : [];
  for (const row of source.slice(0, 50)) {
    const clean = {};
    for (const [key, value] of Object.entries(row || {}).slice(0, 60)) {
      const field = key.slice(0, 200);
      if (["__proto__", "constructor", "prototype"].includes(field)) continue;
      if (typeof value === "string") clean[field] = value.slice(0, 1000);
      else if (typeof value === "bigint") clean[field] = value.toString();
      else if (value === null || ["number", "boolean"].includes(typeof value))
        clean[field] = value;
      else clean[field] = (JSON.stringify(value) || "").slice(0, 1000);
    }
    output.rows.push(clean);
    if (Buffer.byteLength(JSON.stringify(output)) > byteBudget) {
      output.rows.pop();
      output.truncated = true;
      break;
    }
  }
  if (output.rows.length < source.length) output.truncated = true;
  output.returnedRows = output.rows.length;
  return output;
}
function schemaData(schema) {
  const tables = Array.isArray(schema) ? schema : schema?.tables || [];
  const safe = tables.slice(0, 80).map((table) => ({
    name: String(table.name || table.table || "").slice(0, 200),
    schema:
      typeof table.schema === "string" ? table.schema.slice(0, 200) : undefined,
    columnsTruncated: (table.columns || []).length > 80,
    columns: (table.columns || []).slice(0, 80).map((column) => ({
      name: String(column.name || "").slice(0, 200),
      type: String(column.type || "").slice(0, 100),
      primaryKey: !!column.primaryKey,
      nullable: column.nullable,
    })),
  }));
  while (Buffer.byteLength(JSON.stringify(safe)) > 10000 && safe.length)
    safe.pop();
  return { tables: safe, truncated: safe.length < tables.length };
}
function number(value, language = "it") {
  return new Intl.NumberFormat(language, { maximumFractionDigits: 2 }).format(
    Number(value),
  );
}
function rowText(rows, columns, max = 8, language = "it", t = (key) => key) {
  return rows
    .slice(0, max)
    .map((row) => {
      if (row.revenue !== undefined)
        return `${row.country || row.customer || ""}${row.country || row.customer ? " · " : ""}${row.currency} ${number(row.revenue, language)}${row.orders !== undefined ? ` · ${number(row.orders, language)} ${t("ordini")}` : ""}`;
      if (row.id !== undefined && row.total !== undefined)
        return `#${row.id} · ${row.currency} ${number(row.total, language)} · ${row.status}`;
      if (row.status !== undefined && row.count !== undefined)
        return `${row.status}: ${number(row.count, language)} ${t("ordini")}`;
      return columns
        .map(
          (key) =>
            `${typeof row[key] === "number" ? number(row[key], language) : (row[key] ?? "—")}`,
        )
        .join(" · ");
    })
    .join("\n");
}

class AssistantService {
  constructor({ ai, database } = {}) {
    if (
      !ai ||
      !database ||
      !["query", "schema", "prepareWrite"].every(
        (method) => typeof database[method] === "function",
      )
    )
      throw new Error("Servizi assistente non disponibili.");
    this.ai = ai;
    this.database = database;
  }
  queryParams(input, dialect) {
    const value = params(input);
    if (["mongodb", "redis"].includes(dialect) && Object.keys(value).length)
      throw new Error(
        "I valori dei comandi JSON devono essere nel comando; params deve essere vuoto.",
      );
    return value;
  }
  async profile(profileId) {
    if (profileId === "demo")
      return {
        id: "demo",
        name: "Demo locale",
        provider: "mock",
        model: "Deterministic demo",
        destination: "Solo in questo dispositivo",
        isLocal: true,
        isMock: true,
      };
    return this.ai.providerDestination(profileId);
  }
  async dialect(connectionId) {
    const connections =
      typeof this.database.connections === "function"
        ? await this.database.connections()
        : [];
    const profiles = Array.isArray(connections)
      ? connections
      : connections.profiles || connections.connections || [];
    const selected = profiles.find((profile) => profile.id === connectionId);
    return selected?.driver || "unknown";
  }
  async ask({ connectionId, prompt, profileId, mode = "read", history, language = "it" } = {}) {
    if (!LANGUAGES.includes(language)) throw new Error("Unsupported assistant language.");
    const { translateForLanguage } = await import("../locales/runtime.mjs");
    const t = (key, params) => translateForLanguage(language, key, params);
    if (
      typeof connectionId !== "string" ||
      !connectionId ||
      connectionId.length > 100
    )
      throw new Error("Seleziona una connessione database.");
    if (
      typeof prompt !== "string" ||
      !prompt.trim() ||
      prompt.length > 8000 ||
      prompt.includes("\0")
    )
      throw new Error("Richiesta AI non valida: massimo 8000 caratteri.");
    if (!["read", "write"].includes(mode))
      throw new Error("Modalità assistente non valida.");
    const past = safeHistory(history);
    const provider = await this.profile(profileId);
    if (provider.isMock) {
      provider.name = t(provider.name);
      provider.destination = t(provider.destination);
    }
    const dialect = await this.dialect(connectionId);
    // Discovery contains metadata only. No rows are read or sent before ask().
    const schema = schemaData(await this.database.schema(connectionId));
    const steps = [
      {
        action: "schema",
        tables: schema.tables.length,
        truncated: schema.truncated,
      },
    ];
    if (provider.isMock)
      return this.mock({
        connectionId,
        prompt,
        mode,
        dialect,
        schema,
        steps,
        provider,
        language,
        t,
      });
    const evidence = [];
    let result, sql, resultSQL;
    let protocolRepairUsed = false;
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const request = {
        profileId: provider.id,
        model: provider.model,
        prompt,
        ...(protocolRepairUsed ? { protocolRepair: true } : {}),
        context: {
          mode,
          responseLanguage: language,
          dialect,
          maximumRows: MAX_QUERY_ROWS,
          queryFormat: ["mongodb", "redis"].includes(dialect)
            ? "json-command"
            : "sql",
          syntaxGuide: syntaxGuide(dialect),
          round,
          remainingToolCalls: MAX_TOOL_ROUNDS - round,
          schema,
          history: past,
          toolResults: structuredClone(evidence),
        },
      };
      const raw = await this.ai.generate(request);
      let decision;
      try {
        decision = decisionOf(raw);
      } catch (error) {
        if (error.code !== "AI_INVALID_DECISION_JSON" || protocolRepairUsed)
          throw error;
        // One extra protocol-only generation for the entire ask, on the same
        // exact model. Keep its instruction in all later rounds, without granting
        // another extra attempt when malformed JSON recurs.
        // No raw response is extracted, executed or forwarded as instructions;
        // transport supplies the controlled repair instruction outside data.
        protocolRepairUsed = true;
        decision = decisionOf(await this.ai.generate({
          ...request,
          protocolRepair: true,
        }));
      }
      if (decision.action === "final") {
        const grounded = evidence.some((item) => item.result);
        const zeroKind = grounded ? zeroResultKind(result, resultSQL, dialect) : undefined;
        const answer =
          evidence.length && !grounded
            ? t("Non ho ottenuto risultati dal database.") + " " +
              (evidence.at(-1).error ||
                t("Ripeti la richiesta con una query diversa."))
            : zeroKind === "count"
              ? t("Il conteggio della query è 0. Verifica il criterio prima di concludere che i dati richiesti siano assenti.")
              : zeroKind === "rows"
                ? t("La query non ha restituito righe. Verifica il criterio prima di concludere che i dati richiesti siano assenti.")
                : decision.answer.trim();
        return {
          answer,
          sql: resultSQL || sql,
          result,
          steps,
          provider,
          isMock: false,
          evidence: grounded ? "query" : "schema",
          grounded,
        };
      }
      if (round === MAX_TOOL_ROUNDS)
        throw new Error(
          "Limite di quattro operazioni AI raggiunto. Nessuna ulteriore query eseguita.",
        );
      if (decision.action === "prepare_write") {
        if (mode !== "write")
          throw new Error(
            "Scrittura AI bloccata in modalità lettura. Passa a Scrittura per preparare una proposta.",
          );
        if (!WRITE_INTENT.test(normalizedRequest(prompt)))
          throw new Error(
            "Una proposta di scrittura richiede una richiesta esplicita dell'utente.",
          );
        sql = dataCommand(decision.sql, dialect, "write", schema);
        const proposal = await this.database.prepareWrite({
          connectionId,
          sql,
          params: this.queryParams(decision.params, dialect),
        });
        steps.push({ action: "prepare_write", sql, proposalId: proposal.id });
        return {
          answer:
            t("Proposta pronta. Controlla SQL e righe coinvolte, poi conferma per applicarla."),
          sql,
          proposal,
          steps,
          provider,
          isMock: false,
        };
      }
      sql = dataCommand(decision.sql, dialect, "read", schema);
      try {
        result = await this.database.query({
          connectionId,
          sql,
          params: this.queryParams(decision.params, dialect),
          limit: MAX_QUERY_ROWS,
        });
        resultSQL = sql;
        steps.push({
          action: "query_read",
          sql,
          rowCount: result.rowCount,
          durationMs: result.durationMs,
          truncated: result.truncated,
        });
        evidence.push({
          action: "query_read",
          sql: sql.slice(0, 1500),
          sqlTruncated: sql.length > 1500,
          result: trimData(result),
        });
      } catch (error) {
        const message =
          typeof this.ai.scrub === "function"
            ? this.ai.scrub(error.message, 500)
            : String(error.message).slice(0, 500);
        steps.push({ action: "query_read", sql, error: message });
        evidence.push({
          action: "query_read",
          sql: sql.slice(0, 1500),
          sqlTruncated: sql.length > 1500,
          error: message,
        });
      }
    }
    throw new Error("Il modello non ha prodotto una risposta finale.");
  }
  async mock({ connectionId, prompt, mode, dialect, schema, steps, provider, language, t }) {
    if (["mongodb", "redis"].includes(dialect))
      return {
        answer:
          t("Seleziona un provider AI per analizzare questa connessione. La demo guidata usa il database Commerce locale."),
        steps,
        provider,
        isMock: true,
      };
    const request = normalizedRequest(prompt);
    const hasTable = (name) =>
      schema.tables.some((table) => table.name === name);
    if (WRITE_INTENT.test(normalizedRequest(prompt))) {
      if (mode !== "write")
        throw new Error(
          "Scrittura bloccata in modalità lettura. Passa a Scrittura per preparare una proposta.",
        );
      if (!hasTable("orders"))
        throw new Error(
          "La demo guidata supporta proposte solo sulla tabella orders del database dimostrativo.",
        );
      const statuses = ["paid", "pending", "shipped", "cancelled", "refunded"];
      const supplied = [
        ...request.matchAll(/\b(paid|pending|shipped|cancelled|refunded)\b/g),
      ].map((match) => match[0]);
      const italian = request.match(
        /\b(spediti|spedito|pagati|pagato|annullati|annullato|rimborsati|rimborsato)\b/,
      );
      const target =
        supplied.at(-1) ||
        (italian
          ? {
              spediti: "shipped",
              spedito: "shipped",
              pagati: "paid",
              pagato: "paid",
              annullati: "cancelled",
              annullato: "cancelled",
              rimborsati: "refunded",
              rimborsato: "refunded",
            }[italian[0]]
          : null);
      if (!statuses.includes(target))
        return {
          answer:
            t("Indica uno stato fra paid, pending, shipped, cancelled e refunded, e un ordine o uno stato di origine."),
          steps,
          provider,
          isMock: true,
        };
      const order = request.match(
        /\b(?:order|ordine|commande|bestellung|pedido)\s*(?:id\s*)?[#:]?\s*(\d+)\b/,
      );
      const source =
        supplied.length > 1
          ? supplied[0]
          : /\b(in attesa|pendenti|pending)\b/.test(request) &&
              target !== "pending"
            ? "pending"
            : null;
      if (!order && (!source || source === target))
        return {
          answer:
            t("Specifica l'ID ordine o lo stato di origine per delimitare la modifica."),
          steps,
          provider,
          isMock: true,
        };
      const placeholder = (index) =>
        [
          "postgres",
          "postgresql",
          "aurora-postgres",
          "aurora-postgresql",
          "cockroachdb",
          "redshift",
        ].includes(dialect)
          ? `$${index}`
          : ["mssql", "sqlserver"].includes(dialect)
            ? `@p${index}`
            : "?";
      const sql = writeSQL(
        `UPDATE orders SET status = ${placeholder(1)} WHERE ${order ? "id" : "status"} = ${placeholder(2)}`,
        dialect,
      );
      const proposal = await this.database.prepareWrite({
        connectionId,
        sql,
        params: [target, order ? Number(order[1]) : source],
      });
      steps.push({ action: "prepare_write", sql, proposalId: proposal.id });
      return {
        answer:
          t("Proposta preparata. Controlla le righe e conferma per applicare."),
        sql,
        proposal,
        steps,
        provider,
        isMock: true,
      };
    }
    let sql, intro, columns, countLabel;
    const revenue =
      /\b(fatturato|ricavi|revenue|sales|vendite|spesa|speso|spend|total[ei]?|revenus|revenu|chiffre|umsatz|einnahmen|ingresos|ventas)\b/.test(
        request,
      );
    if (/\b(schema|tabelle|tables|struttura|structure|tabellen|struktur|esquema|tablas|estructura)\b/.test(request) && !revenue)
      return {
        answer: `${schema.tables.map((table) => `${table.name} (${t("{count} colonne", {count: number(table.columns.length, language)})})`).join("; ")}.`,
        steps,
        provider,
        isMock: true,
        evidence: "schema",
      };
    if (!hasTable("orders") || !hasTable("customers"))
      return {
        answer:
          t("Queste domande guidate richiedono le tabelle orders e customers. Seleziona un provider reale per esplorare altri schemi."),
        steps,
        provider,
        isMock: true,
      };
    if (
      revenue &&
      /\b(paese|paesi|country|countries|nazione|pays|land|lander|pais|paises)\b/.test(request)
    ) {
      sql =
        "SELECT c.country, o.currency, ROUND(SUM(o.total), 2) AS revenue, COUNT(*) AS orders FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.status IN ('paid', 'shipped') GROUP BY c.country, o.currency ORDER BY revenue DESC LIMIT 30";
      intro = t("Ricavi degli ordini paid e shipped per paese e valuta.");
      columns = ["country", "currency", "revenue", "orders"];
    } else if (
      revenue &&
      /\b(cliente|clienti|customer|customers|top|miglior[ei]|clients|client|kunden|kunde|clientes|meilleurs|beste)\b/.test(request)
    ) {
      sql =
        "SELECT c.name AS customer, o.currency, ROUND(SUM(o.total), 2) AS revenue, COUNT(*) AS orders FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.status IN ('paid', 'shipped') GROUP BY c.id, c.name, o.currency ORDER BY revenue DESC LIMIT 10";
      intro = t("Primi clienti per ricavi paid e shipped, separati per valuta.");
      columns = ["customer", "currency", "revenue", "orders"];
    } else if (revenue) {
      sql =
        "SELECT currency, ROUND(SUM(total), 2) AS revenue, COUNT(*) AS orders FROM orders WHERE status IN ('paid', 'shipped') GROUP BY currency ORDER BY currency";
      intro = t("Ricavi degli ordini paid e shipped, separati per valuta.");
      columns = ["currency", "revenue", "orders"];
    } else if (/\b(pending|pendenti|attesa|aperti|open|attente|ausstehende[nr]?|offene[nr]?|pendientes|pendiente)\b/.test(request)) {
      sql =
        "SELECT id, customer_id, status, total, currency, created_at FROM orders WHERE status = 'pending' ORDER BY created_at DESC, id DESC LIMIT 50";
      intro = t("Ultimi ordini in attesa (massimo 50).");
      columns = ["id", "total", "currency", "status"];
    } else if (
      /\b(status|stato|stati|distribuzione|distribution|etat|statut|verteilung|estado|estados|distribucion)\b/.test(request)
    ) {
      sql =
        "SELECT status, COUNT(*) AS count FROM orders GROUP BY status ORDER BY count DESC";
      intro = t("Ordini per stato.");
      columns = ["status", "count"];
    } else if (/\b(quanti|conteggio|count|how many|numero|combien|nombre|wie viele|anzahl|cuantos|cuantas)\b/.test(request)) {
      const table = /\b(cliente|clienti|customer|customers|clients|client|kunden|kunde|clientes)\b/.test(request)
        ? "customers"
        : /\b(prodotti|prodotto|products|produits|produit|produkte|produkt|productos|producto)\b/.test(request)
          ? "products"
          : "orders";
      sql = `SELECT COUNT(*) AS count FROM ${table}`;
      countLabel = {
        customers: "clienti",
        products: "prodotti",
        orders: "ordini",
      }[table];
      intro = "";
      columns = ["count"];
    } else {
      return {
        answer:
          t("Chiedi ricavi per paese, primi clienti, ordini pending, conteggi o distribuzione per stato. Per domande libere seleziona un provider AI."),
        steps,
        provider,
        isMock: true,
      };
    }
    sql = readSQL(sql, dialect);
    const result = await this.database.query({
      connectionId,
      sql,
      limit: MAX_QUERY_ROWS,
    });
    steps.push({
      action: "query_read",
      sql,
      rowCount: result.rowCount,
      durationMs: result.durationMs,
      truncated: result.truncated,
    });
    return {
      answer: countLabel
        ? t("Ci sono {count} {entity}.", {count: number(result.rows[0]?.count || 0, language), entity: t(countLabel)})
        : `${intro}\n${rowText(result.rows, columns, 8, language, t) || t("Nessuna riga.")}${result.rows.length > 8 ? "\n" + t("Mostro 8 di {count} righe: consulta il risultato completo.", { count: number(result.rows.length, language) }) : ""}`,
      sql,
      result,
      steps,
      provider,
      isMock: true,
      evidence: "query",
      grounded: true,
    };
  }
}

module.exports = {
  AssistantService,
  dataCommand,
  readSQL,
  writeSQL,
  decisionOf,
  trimData,
  MAX_TOOL_ROUNDS,
  MAX_QUERY_ROWS,
};
