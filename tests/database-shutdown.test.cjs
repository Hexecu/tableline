"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseService } = require("../electron/database.cjs");
const fixture = () =>
  new DatabaseService({ directory: require("node:os").tmpdir() });
test("database disposal is bounded after a driver stops answering its close request", async () => {
  const db = fixture();
  db.closeTimeoutMs = 20;
  db.adapters.set("stalled", { close: () => new Promise(() => {}) });
  await assert.rejects(db.dispose("stalled"), /disconnection timed out/);
  assert.equal(db.adapters.has("stalled"), false);
});
test("database shutdown drains an active write before applying the disconnect deadline", async () => {
  const db = fixture();
  db.closeTimeoutMs = 20;
  const order = [];
  let acknowledge;
  const acknowledgement = new Promise((resolve) => {
    acknowledge = resolve;
  });
  db.adapters.set("writing", {
    close: () => {
      order.push("driver-close");
      return new Promise(() => {});
    },
  });
  const write = db.serial("writing", async () => {
    order.push("write-start");
    await acknowledgement;
    order.push("write-acknowledged");
  });
  const closed = db.close();
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.deepEqual(order, ["write-start"]);
  assert.equal(db.adapters.has("writing"), true);
  acknowledge();
  await Promise.all([write, closed]);
  assert.deepEqual(order, [
    "write-start",
    "write-acknowledged",
    "driver-close",
  ]);
  assert.equal(db.adapters.size, 0);
});
