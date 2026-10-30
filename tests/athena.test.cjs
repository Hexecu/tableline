// Copyright (c) 2026 Davide Leopardi
// SPDX-License-Identifier: GPL-3.0-only

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { AthenaDriver, executionParameters } = require("../electron/drivers/athena.cjs");

function fakeSdk(handler) {
  let client;
  let ini;
  let assume;
  class Command {
    constructor(input) { this.input = input; }
  }
  class GetWorkGroupCommand extends Command {}
  class ListDatabasesCommand extends Command {}
  class ListTableMetadataCommand extends Command {}
  class StartQueryExecutionCommand extends Command {}
  class GetQueryExecutionCommand extends Command {}
  class GetQueryResultsCommand extends Command {}
  class StopQueryExecutionCommand extends Command {}
  class AthenaClient {
    constructor(config) {
      this.config = config;
      this.calls = [];
      client = this;
    }
    async send(command) {
      this.calls.push(command);
      return handler(command);
    }
    destroy() { this.destroyed = true; }
  }
  return {
    AthenaClient,
    GetWorkGroupCommand,
    ListDatabasesCommand,
    ListTableMetadataCommand,
    StartQueryExecutionCommand,
    GetQueryExecutionCommand,
    GetQueryResultsCommand,
    StopQueryExecutionCommand,
    fromIni: (options) => {
      ini = options;
      return async () => ({ accessKeyId: "SSO" });
    },
    fromTemporaryCredentials: (options) => {
      assume = options;
      return async () => ({ accessKeyId: "ROLE" });
    },
    get client() { return client; },
    get ini() { return ini; },
    get assume() { return assume; },
  };
}

const profile = {
  awsProfile: "sample-sso-profile",
  region: "eu-west-1",
  roleArn: "arn:aws:iam::123456789012:role/tableline-read",
  workgroup: "tableline-read",
  database: "analytics",
};

test("Athena execution parameters quote scalar SQL expressions", () => {
  assert.deepEqual(
    executionParameters(["O'Reilly", 42, true, false, null]),
    ["'O''Reilly'", "42", "TRUE", "FALSE", "NULL"],
  );
  assert.throws(() => executionParameters({ name: "x" }), /positional/);
  assert.throws(() => executionParameters([{}]), /scalar/);
  assert.throws(() => executionParameters([Infinity]), /scalar/);
  assert.throws(() => executionParameters(["a".repeat(1024)]), /scalar/);
});

test("Athena uses SSO then a refreshing role provider and reads paginated rows", async () => {
  const sdk = fakeSdk((command) => {
    if (command instanceof sdk.GetWorkGroupCommand)
      return { WorkGroup: { State: "ENABLED" } };
    if (command instanceof sdk.StartQueryExecutionCommand)
      return { QueryExecutionId: "query-1" };
    if (command instanceof sdk.GetQueryExecutionCommand)
      return { QueryExecution: { Status: { State: "SUCCEEDED" } } };
    if (command instanceof sdk.GetQueryResultsCommand)
      return command.input.NextToken
        ? { ResultSet: { Rows: [{ Data: [{ VarCharValue: "second" }, {}] }] } }
        : {
            ResultSet: {
              ResultSetMetadata: { ColumnInfo: [
                { Name: "text", Type: "varchar" },
                { Name: "missing", Type: "varchar" },
              ] },
              Rows: [
                { Data: [{ VarCharValue: "text" }, { VarCharValue: "missing" }] },
                { Data: [{ VarCharValue: "first" }, { VarCharValue: "value" }] },
              ],
            },
            NextToken: "page-2",
          };
    throw new Error("Unexpected command");
  });
  const driver = new AthenaDriver(profile, {}, sdk);
  await driver.connect();
  assert.equal(sdk.ini.profile, profile.awsProfile);
  assert.equal(sdk.assume.params.RoleArn, profile.roleArn);
  assert.equal(sdk.assume.masterCredentials instanceof Function, true);
  assert.equal(sdk.client.config.credentials instanceof Function, true);
  const result = await driver.read("SELECT ? AS text, ? AS missing", ["first", null], 2);
  assert.deepEqual(result.columns, [
    { name: "text", type: "varchar" },
    { name: "missing", type: "varchar" },
  ]);
  assert.deepEqual(result.rows, [
    { text: "first", missing: "value" },
    { text: "second", missing: null },
  ]);
  const start = sdk.client.calls.find((call) => call instanceof sdk.StartQueryExecutionCommand);
  assert.equal(start.input.WorkGroup, profile.workgroup);
  assert.equal(start.input.QueryExecutionContext.Database, "analytics");
  assert.deepEqual(start.input.ExecutionParameters, ["'first'", "NULL"]);
  assert.match(start.input.QueryString, /LIMIT 3$/);
  await driver.close();
  assert.equal(sdk.client.destroyed, true);
});

test("Athena metadata and browser use discovered identifiers without a count scan", async () => {
  const sdk = fakeSdk((command) => {
    if (command instanceof sdk.GetWorkGroupCommand)
      return { WorkGroup: { State: "ENABLED" } };
    if (command instanceof sdk.ListTableMetadataCommand)
      return {
        TableMetadataList: [{
          Name: "messaggi",
          TableType: "VIRTUAL_VIEW",
          Columns: [
            { Name: "testo", Type: "string" },
            { Name: "numero", Type: "bigint" },
          ],
          PartitionKeys: [{ Name: "mese", Type: "string" }],
        }],
      };
    if (command instanceof sdk.StartQueryExecutionCommand)
      return { QueryExecutionId: "browse-1" };
    if (command instanceof sdk.GetQueryExecutionCommand)
      return { QueryExecution: { Status: { State: "SUCCEEDED" } } };
    if (command instanceof sdk.GetQueryResultsCommand)
      return {
        ResultSet: {
          ResultSetMetadata: { ColumnInfo: [
            { Name: "testo", Type: "varchar" },
            { Name: "numero", Type: "bigint" },
            { Name: "mese", Type: "varchar" },
          ] },
          Rows: [
            { Data: [{ VarCharValue: "testo" }, { VarCharValue: "numero" }, { VarCharValue: "mese" }] },
            { Data: [{ VarCharValue: "hello" }, { VarCharValue: "1" }, { VarCharValue: "2026-10" }] },
          ],
        },
      };
    throw new Error("Unexpected command");
  });
  const driver = new AthenaDriver(profile, {}, sdk);
  await driver.connect();
  const schema = await driver.schema();
  assert.deepEqual(schema.map((table) => [table.schema, table.name, table.kind]), [
    ["analytics", "messaggi", "view"],
  ]);
  assert.deepEqual(schema[0].columns.map((column) => column.name), ["testo", "numero", "mese"]);
  const result = await driver.browse({
    table: "messaggi",
    schema: "analytics",
    search: "O'Reilly",
    sortColumn: "mese",
    sortDirection: "desc",
    offset: 20,
    limit: 2,
  });
  assert.equal(result.total, undefined);
  assert.deepEqual(result.rows, [{ testo: "hello", numero: "1", mese: "2026-10" }]);
  const start = sdk.client.calls.find((call) => call instanceof sdk.StartQueryExecutionCommand);
  assert.match(start.input.QueryString, /^SELECT \* FROM "analytics"\."messaggi"/);
  assert.match(start.input.QueryString, /ORDER BY "mese" DESC OFFSET 20 LIMIT 3$/);
  assert.doesNotMatch(start.input.QueryString, /count\s*\(/i);
  assert.deepEqual(start.input.ExecutionParameters, ["'O''Reilly'", "'O''Reilly'"]);
  await driver.browse({ table: "messaggi", schema: "analytics", offset: 100, limit: 2 });
  const unsorted = sdk.client.calls.filter((call) =>
    call instanceof sdk.StartQueryExecutionCommand).at(-1);
  assert.match(unsorted.input.QueryString, / OFFSET 100 LIMIT 3$/);
  assert.doesNotMatch(unsorted.input.QueryString, /ORDER BY/);
  await assert.rejects(driver.browse({ table: "messaggi", sortColumn: "not_discovered" }), /Sort column/);
  await driver.close();
});

test("Athena lists accessible databases and uses default SQL context when none is selected", async () => {
  const names = [];
  const sdk = fakeSdk((command) => {
    if (command instanceof sdk.GetWorkGroupCommand)
      return { WorkGroup: { State: "ENABLED" } };
    if (command instanceof sdk.ListDatabasesCommand)
      return { DatabaseList: [{ Name: "analytics" }, { Name: "archive" }] };
    if (command instanceof sdk.ListTableMetadataCommand) {
      names.push(command.input.DatabaseName);
      return { TableMetadataList: [{ Name: "data", Columns: [{ Name: "id", Type: "string" }] }] };
    }
    if (command instanceof sdk.StartQueryExecutionCommand)
      return { QueryExecutionId: "connection-test" };
    if (command instanceof sdk.GetQueryExecutionCommand)
      return { QueryExecution: { Status: { State: "SUCCEEDED" } } };
    if (command instanceof sdk.GetQueryResultsCommand)
      return {
        ResultSet: {
          ResultSetMetadata: { ColumnInfo: [{ Name: "connected", Type: "integer" }] },
          Rows: [
            { Data: [{ VarCharValue: "connected" }] },
            { Data: [{ VarCharValue: "1" }] },
          ],
        },
      };
    throw new Error("Unexpected command");
  });
  const driver = new AthenaDriver({ ...profile, database: "" }, {}, sdk);
  await driver.connect();
  assert.deepEqual((await driver.schema()).map((table) => table.schema), ["analytics", "archive"]);
  assert.deepEqual(names, ["analytics", "archive"]);
  await driver.read("SELECT 1 AS connected", [], 1);
  const start = sdk.client.calls.find((call) => call instanceof sdk.StartQueryExecutionCommand);
  assert.equal(start.input.QueryExecutionContext.Database, "default");
  await driver.close();
});

test("Athena stops a query that exceeds its polling deadline", async () => {
  let stopped = false;
  const sdk = fakeSdk((command) => {
    if (command instanceof sdk.GetWorkGroupCommand)
      return { WorkGroup: { State: "ENABLED" } };
    if (command instanceof sdk.StartQueryExecutionCommand)
      return { QueryExecutionId: "slow-1" };
    if (command instanceof sdk.GetQueryExecutionCommand)
      return { QueryExecution: { Status: { State: "QUEUED" } } };
    if (command instanceof sdk.StopQueryExecutionCommand) {
      stopped = true;
      return {};
    }
    throw new Error("Unexpected command");
  });
  const driver = new AthenaDriver(profile, {}, sdk);
  await driver.connect();
  driver.timeoutMs = -1;
  await assert.rejects(driver.read("SELECT 1", [], 1), /timed out/);
  assert.equal(stopped, true);
  assert.equal(driver.inFlight.size, 0);
  await driver.close();
});

test("Athena cancellation reports a failed stop request", async () => {
  const sdk = fakeSdk((command) => {
    if (command instanceof sdk.GetWorkGroupCommand)
      return { WorkGroup: { State: "ENABLED" } };
    if (command instanceof sdk.StopQueryExecutionCommand)
      throw new Error("Access denied");
    throw new Error("Unexpected command");
  });
  const driver = new AthenaDriver(profile, {}, sdk);
  await driver.connect();
  driver.active.set("request-1", "query-1");
  assert.equal(await driver.cancel("request-1"), false);
  assert.equal(await driver.cancel("unknown"), false);
  await driver.close();
});
