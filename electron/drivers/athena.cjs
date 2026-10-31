// Copyright (c) 2026 Davide Leopardi
// SPDX-License-Identifier: GPL-3.0-only

"use strict";

const { guardSql, quoteIdentifier } = require("../sql-guard.cjs");
const { boundedSql } = require("./sql.cjs");

const CATALOG = "AwsDataCatalog";
const QUERY_TIMEOUT_MS = 90000;
const RESULT_BYTES_LIMIT = 10 * 1024 * 1024;

function executionParameters(params) {
  if (!Array.isArray(params))
    throw new Error("Athena uses positional parameters (?).");
  return params.map((value) => {
    if (value === null) return "NULL";
    if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
    if (typeof value === "number" && Number.isFinite(value))
      return String(value);
    if (typeof value === "string" && !value.includes("\0")) {
      const quoted = "'" + value.replaceAll("'", "''") + "'";
      if (quoted.length <= 1024) return quoted;
    }
    throw new Error("Athena parameters must be short scalar values.");
  });
}

class AthenaDriver {
  constructor(profile, credentials = {}, sdk) {
    this.profile = profile;
    this.credentials = credentials;
    this.sdk = sdk;
    this.dialect = "athena";
    this.transactional = false;
    this.active = new Map();
    this.inFlight = new Set();
    this.cachedSchema = null;
    this.timeoutMs = QUERY_TIMEOUT_MS;
  }

  async connect() {
    const { awsProfile, region, roleArn, workgroup } = this.profile;
    if (!awsProfile || !region || !workgroup)
      throw new Error("Athena requires an AWS profile, region, and workgroup.");
    const sdk = this.sdk || {
      ...require("@aws-sdk/client-athena"),
      ...require("@aws-sdk/credential-providers"),
    };
    const masterCredentials = sdk.fromIni({
      profile: awsProfile,
      clientConfig: { region },
    });
    const credentials = roleArn
      ? sdk.fromTemporaryCredentials({
          masterCredentials,
          clientConfig: { region },
          params: { RoleArn: roleArn, RoleSessionName: "tableline-athena" },
        })
      : masterCredentials;
    this.sdk = sdk;
    this.client = new sdk.AthenaClient({
      region,
      credentials,
      maxAttempts: 2,
      logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    });
    try {
      const result = await this.client.send(
        new sdk.GetWorkGroupCommand({ WorkGroup: workgroup }),
      );
      if (result.WorkGroup?.State === "DISABLED")
        throw new Error("Athena workgroup is disabled.");
    } catch (error) {
      this.client.destroy();
      this.client = null;
      throw error;
    }
  }

  async schema() {
    if (!this.client) throw new Error("Athena is not connected.");
    const { ListDatabasesCommand, ListTableMetadataCommand } = this.sdk;
    const workgroup = this.profile.workgroup;
    const databases = [];
    if (this.profile.database) databases.push(this.profile.database);
    else {
      let next;
      do {
        const result = await this.client.send(
          new ListDatabasesCommand({
            CatalogName: CATALOG,
            WorkGroup: workgroup,
            MaxResults: 50,
            ...(next ? { NextToken: next } : {}),
          }),
        );
        databases.push(...(result.DatabaseList || []).map((db) => db.Name));
        if (databases.length > 100)
          throw new Error("Athena schema has too many databases.");
        next = result.NextToken;
      } while (next);
    }
    const tables = [];
    for (const database of databases) {
      let next;
      do {
        let result;
        try {
          result = await this.client.send(
            new ListTableMetadataCommand({
              CatalogName: CATALOG,
              DatabaseName: database,
              WorkGroup: workgroup,
              MaxResults: 50,
              ...(next ? { NextToken: next } : {}),
            }),
          );
        } catch (error) {
          // An unrestricted database list can include databases outside a
          // narrow read role. A specifically selected database must still fail.
          if (!this.profile.database && /accessdenied/i.test(error.name || ""))
            break;
          throw error;
        }
        for (const table of result.TableMetadataList || []) {
          const columns = [];
          for (const column of [
            ...(table.Columns || []),
            ...(table.PartitionKeys || []),
          ]) {
            if (!columns.some((current) => current.name === column.Name))
              columns.push({
                name: column.Name,
                type: column.Type || "string",
                nullable: true,
                primaryKey: false,
              });
          }
          tables.push({
            name: table.Name,
            schema: database,
            kind: /view/i.test(table.TableType || "") ? "view" : "table",
            columns,
          });
        }
        if (tables.length > 5000)
          throw new Error("Athena schema has too many tables.");
        next = result.NextToken;
      } while (next);
    }
    this.cachedSchema = tables;
    return tables;
  }

  async read(sql, params = [], limit = 500, options = {}) {
    const statement = guardSql(sql, "read", "athena").sql;
    return this.executeRead(statement, params, limit, options);
  }

  async executeRead(sql, params = [], limit = 500, { requestId, alreadyBound = false } = {}) {
    if (!this.client) throw new Error("Athena is not connected.");
    if (!Number.isInteger(limit) || limit < 1 || limit > 10000)
      throw new Error("Athena result limit must be between 1 and 10000.");
    const bound = executionParameters(params);
    const sdk = this.sdk;
    const response = await this.client.send(
      new sdk.StartQueryExecutionCommand({
        QueryString: alreadyBound ? sql : boundedSql(sql, "athena", limit),
        WorkGroup: this.profile.workgroup,
        QueryExecutionContext: {
          Catalog: CATALOG,
          Database: this.profile.database || "default",
        },
        ...(bound.length ? { ExecutionParameters: bound } : {}),
      }),
    );
    const id = response.QueryExecutionId;
    if (!id) throw new Error("Athena did not return a query ID.");
    this.inFlight.add(id);
    if (requestId) this.active.set(requestId, id);
    const deadline = Date.now() + this.timeoutMs;
    try {
      let delayMs = 300;
      while (true) {
        const result = await this.client.send(
          new sdk.GetQueryExecutionCommand({ QueryExecutionId: id }),
        );
        const state = result.QueryExecution?.Status?.State;
        if (state === "SUCCEEDED") break;
        if (state === "FAILED" || state === "CANCELLED")
          throw new Error(
            `Athena query ${state.toLowerCase()}: ${result.QueryExecution?.Status?.StateChangeReason || "unknown reason"}`,
          );
        if (Date.now() >= deadline) {
          const stopped = await this.stop(id);
          throw new Error(stopped
            ? "Athena query timed out and was stopped."
            : "Athena query timed out; it could not be stopped.");
        }
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        delayMs = Math.min(Math.round(delayMs * 1.5), 2000);
      }
      return await this.results(id, limit + 1);
    } finally {
      this.inFlight.delete(id);
      if (requestId && this.active.get(requestId) === id)
        this.active.delete(requestId);
    }
  }

  async results(id, maxRows) {
    const columns = [];
    const rows = [];
    let next;
    let firstPage = true;
    let bytes = 0;
    do {
      const result = await this.client.send(
        new this.sdk.GetQueryResultsCommand({
          QueryExecutionId: id,
          MaxResults: Math.min(1000, maxRows - rows.length + (firstPage ? 1 : 0)),
          ...(next ? { NextToken: next } : {}),
        }),
      );
      if (firstPage) {
        for (const column of result.ResultSet?.ResultSetMetadata?.ColumnInfo || [])
          columns.push({ name: column.Name, type: column.Type });
      }
      const pageRows = result.ResultSet?.Rows || [];
      for (const row of firstPage && columns.length ? pageRows.slice(1) : pageRows) {
        const value = {};
        columns.forEach((column, index) => {
          value[column.name] = row.Data?.[index]?.VarCharValue ?? null;
        });
        bytes += Buffer.byteLength(JSON.stringify(value), "utf8");
        if (bytes > RESULT_BYTES_LIMIT)
          throw new Error("Result exceeds 10 MB. Select fewer columns or rows.");
        rows.push(value);
        if (rows.length >= maxRows) break;
      }
      firstPage = false;
      next = result.NextToken;
    } while (next && rows.length < maxRows);
    return { columns, rows };
  }

  async browse({
    table,
    schema,
    search = "",
    sortColumn,
    sortDirection = "asc",
    offset = 0,
    limit = 100,
  } = {}) {
    if (!Number.isInteger(offset) || offset < 0 || offset > 1000000)
      throw new Error("Offset must be between 0 and 1000000.");
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new Error("Limit must be between 1 and 1000.");
    if (typeof search !== "string" || search.length > 500)
      throw new Error("Search must be text of up to 500 characters.");
    if (!["asc", "desc"].includes(sortDirection))
      throw new Error("Choose ascending or descending sort.");
    const tables = this.cachedSchema || (await this.schema());
    const selected = tables.find(
      (candidate) => candidate.name === table && (!schema || candidate.schema === schema),
    );
    if (!selected) throw new Error("Table not found. Refresh the schema.");
    if (sortColumn && !selected.columns.some((column) => column.name === sortColumn))
      throw new Error("Sort column not found.");
    const q = (name) => quoteIdentifier(name, "athena");
    const fullName = `${q(selected.schema)}.${q(selected.name)}`;
    const searchable = selected.columns
      .filter((column) => /^(?:varchar|char|string|text)\b/i.test(column.type))
      .slice(0, 20);
    if (search && !searchable.length)
      return {
        columns: selected.columns.map(({ name, type }) => ({ name, type })),
        rows: [],
      };
    const where = search
      ? " WHERE " + searchable.map((column) =>
          `strpos(lower(${q(column.name)}), lower(?)) > 0`,
        ).join(" OR ")
      : "";
    const ordering = sortColumn
      ? ` ORDER BY ${q(sortColumn)} ${sortDirection.toUpperCase()}`
      : "";
    const sql = `SELECT * FROM ${fullName}${where}${ordering} OFFSET ${offset} LIMIT ${limit + 1}`;
    const raw = await this.executeRead(
      sql,
      search ? searchable.map(() => search) : [],
      limit,
      { alreadyBound: true },
    );
    raw.columns = raw.columns.length
      ? raw.columns.map((column) => ({
          ...column,
          type: selected.columns.find((item) => item.name === column.name)?.type || column.type,
        }))
      : selected.columns.map(({ name, type }) => ({ name, type }));
    return raw;
  }

  async stop(id) {
    if (!this.client) return false;
    try {
      await this.client.send(
        new this.sdk.StopQueryExecutionCommand({ QueryExecutionId: id }),
      );
      return true;
    } catch {
      return false;
    }
  }

  async cancel(requestId) {
    const id = this.active.get(requestId);
    if (!id) return false;
    return this.stop(id);
  }

  async abortReads() {
    await Promise.all([...this.inFlight].map((id) => this.stop(id)));
  }

  async close() {
    await this.abortReads();
    this.client?.destroy();
    this.client = null;
    this.cachedSchema = null;
  }
}

module.exports = { AthenaDriver, executionParameters };
