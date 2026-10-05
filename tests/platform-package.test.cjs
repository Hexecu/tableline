// Copyright (c) 2026 Davide Leopardi
// SPDX-License-Identifier: GPL-3.0-only
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { executableArchitecture, noticeSnapshot, verifyDatabricksInventory } = require("../scripts/verify-package.cjs");
const root = path.resolve(__dirname, "..");
for (const [platform, arch, machine] of [["linux", "x64", 62], ["linux", "arm64", 183], ["win32", "x64", 0x8664], ["win32", "arm64", 0xaa64]]) {
  test(`package executable requires native ${platform}/${arch} architecture`, () => {
    const bytes = Buffer.alloc(160);
    if (platform === "linux") {
      bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]); bytes.writeUInt16LE(machine, 18);
    } else {
      bytes.write("MZ"); bytes.writeUInt32LE(96, 0x3c); bytes.writeUInt32LE(0x4550, 96); bytes.writeUInt16LE(machine, 100);
    }
    assert.equal(executableArchitecture(bytes, platform), arch);
    assert.throws(() => executableArchitecture(bytes.subarray(0, 12), platform));
    bytes.fill(0);
    assert.throws(() => executableArchitecture(bytes, platform));
  });
}
test("reviewed upstream Electron snapshots cover exactly six supported desktop targets", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "assets/electron-notices.json"), "utf8"));
  const expected = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"];
  assert.deepEqual(Object.keys(manifest.distributions).sort(), expected);
  for (const target of expected) {
    const [platform, arch] = target.split("-");
    const snapshot = noticeSnapshot(root, platform, arch, "44.5.1");
    assert.match(snapshot.upstreamArchiveSha256, /^[a-f\d]{64}$/);
    assert.equal(Object.keys(snapshot.licenses).length, 2);
  }
  assert.throws(() => noticeSnapshot(root, "linux", "ia32", "44.5.1"));
  assert.throws(() => noticeSnapshot(root, "darwin", "x64", "44.5.2"));
});
test("distribution inventory rejects native kernel but retains Databricks Thrift", () => {
  const thrift = "/node_modules/@databricks/sql/dist/thrift-backend/ThriftBackend.js";
  const check = files => verifyDatabricksInventory("fixture", { archiveAPI: { listPackage: () => files } });
  assert.equal(check([thrift]).databricksKernelBundled, false);
  assert.throws(() => check([thrift, "/node_modules/@databricks/databricks-sql-kernel-win32-arm64-msvc/index.node"]), /kernel/);
  assert.throws(() => check([thrift, "/node_modules/@databricks/sql/native/kernel/embedded.node"]), /kernel/);
  assert.throws(() => check([]), /Thrift backend/);
  // SDK's portable router remains available, allowing standard module import.
  assert.doesNotThrow(() => check([thrift, "/node_modules/@databricks/sql/native/kernel/index.js"]));
});
test("local Mac packages launch without hardened ad-hoc validation while signed releases retain it", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "tableline-platform-package-"));
  try {
    const mocked = { exports: {} }, calls = [];
    const mockRequire = name => name === "./verify-package.cjs"
      ? { verifyPackage: () => ({ sourceMatches: true }) } : require(name);
    mockRequire.resolve = require.resolve;
    vm.runInNewContext(fs.readFileSync(path.join(root, "scripts/package.cjs"), "utf8"), {
      module: mocked, require: mockRequire, __dirname: path.join(root, "scripts"), process,
    });
    for (const identity of ["-", "Developer ID Application: Fixture (TEST123)"]) {
      calls.length = 0;
      mocked.exports.packageMac({ platform: "darwin", arch: "arm64", identity, outputDir: temporary,
        run: (file, args) => calls.push({ file, args }), log: () => {} });
      assert.equal(calls.every(call => call.file === process.execPath), true);
      const args = calls.at(-1).args;
      assert.ok(args.includes(identity === "-" ? "--config.mac.hardenedRuntime=false" : "--config.mac.hardenedRuntime=true"));
      assert.equal(args[args.indexOf("--publish") + 1], "never");
    }
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
