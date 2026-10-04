// Copyright (c) 2026 Davide Leopardi
// SPDX-License-Identifier: GPL-3.0-only

"use strict";

const { fork, spawnSync } = require("node:child_process");
const { randomBytes } = require("node:crypto");

const DEADLINE_MS = 2_000;
function identity(pid) {
  const result = spawnSync(
    "/bin/ps",
    ["-p", String(pid), "-o", "lstart=", "-o", "comm="],
    {
      encoding: "utf8",
      timeout: 1_000,
      maxBuffer: 4_096,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  return result.status === 0 && result.stdout.trim()
    ? result.stdout.trim()
    : null;
}

async function armShutdownGuard() {
  if (process.platform !== "darwin") return;
  const token = randomBytes(32).toString("hex");
  const child = fork(__filename, [String(process.pid), token], {
    execPath: process.execPath,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    detached: true,
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => finish(new Error("Shutdown guard did not start.")),
      2_000,
    );
    const finish = (error) => {
      clearTimeout(timer);
      child.removeListener("message", onMessage);
      child.removeListener("error", finish);
      if (error) {
        child.kill("SIGKILL");
        reject(error);
      } else resolve();
    };
    const onMessage = (message) => {
      if (message?.token !== token || message.parentPid !== process.pid) return;
      if (message.type === "ready")
        child.send({ type: "database-closed", token });
      if (message.type === "armed") finish();
    };
    child.on("message", onMessage);
    child.once("error", finish);
  });
  child.unref();
  child.channel?.unref();
  return { pid: child.pid };
}

function watchParent() {
  const parentPid = Number(process.argv[2]);
  const token = process.argv[3];
  if (
    !Number.isSafeInteger(parentPid) ||
    parentPid < 2 ||
    parentPid !== process.ppid ||
    !/^[a-f0-9]{64}$/.test(token || "") ||
    !process.send
  )
    process.exit(78);
  const originalIdentity = identity(parentPid);
  if (!originalIdentity) process.exit(78);
  let armed = false;
  const startup = setTimeout(() => process.exit(78), 3_000);
  process.on("disconnect", () => {
    if (!armed) process.exit(0);
  });
  process.on("message", (message) => {
    if (armed || message?.type !== "database-closed" || message.token !== token)
      return;
    if (identity(parentPid) !== originalIdentity) process.exit(78);
    armed = true;
    clearTimeout(startup);
    setTimeout(() => {
      // The parent may close IPC before a native worker actually stops.
      // Recheck its birth stamp and executable to prevent PID reuse mistakes.
      if (identity(parentPid) === originalIdentity) {
        try {
          process.kill(parentPid, "SIGKILL");
        } catch {}
      }
      process.exit(0);
    }, DEADLINE_MS);
    process.send({ type: "armed", token, parentPid });
  });
  process.send({ type: "ready", token, parentPid });
}

module.exports = { armShutdownGuard };
if (require.main === module) watchParent();
