// Copyright (c) 2026 Davide Leopardi
// SPDX-License-Identifier: GPL-3.0-only

"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");
test(
  "macOS shutdown guard terminates only its armed fixture parent",
  { skip: process.platform !== "darwin" },
  async () => {
    const modulePath = path.join(__dirname, "../electron/shutdown-guard.cjs");
    const code = `const {armShutdownGuard}=require(${JSON.stringify(modulePath)}); (async()=>{await armShutdownGuard(); console.log('fixture-armed'); setInterval(()=>{},1000);})().catch(e=>{console.error(e.message);process.exit(1)});`;
    const started = performance.now();
    const child = spawn(process.execPath, ["-e", code], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(Error("Owned shutdown guard did not terminate its fixture."));
      }, 6000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
    assert.match(output, /fixture-armed/);
    assert.equal(result.signal, "SIGKILL");
    assert(performance.now() - started >= 2000);
  },
);
