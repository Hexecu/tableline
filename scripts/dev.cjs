"use strict";

const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const node = process.execPath;
const children = new Set();
let ending = false;

function run(command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: "inherit",
    detached: process.platform !== "win32",
    env: { ...process.env, ...env },
  });
  children.add(child);
  child.once("exit", (code) => {
    children.delete(child);
    if (!ending) finish(code || 0);
  });
  child.once("error", (error) => {
    console.error(error.message);
    finish(1);
  });
  return child;
}
function finish(code) {
  if (ending) return;
  ending = true;
  for (const child of children) {
    try {
      if (process.platform !== "win32" && child.pid)
        process.kill(-child.pid, "SIGTERM");
      else child.kill("SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") console.error(error.message);
    }
  }
  process.exitCode = code;
}
process.on("SIGINT", () => finish(0));
process.on("SIGTERM", () => finish(0));

run(node, [
  path.join(root, "node_modules", "vite", "bin", "vite.js"),
  "--host",
  "127.0.0.1",
  "--port",
  "5188",
  "--strictPort",
]);
async function waitForServer() {
  const deadline = Date.now() + 30_000;
  while (!ending && Date.now() < deadline) {
    const available = await new Promise((resolve) => {
      const request = http.get("http://127.0.0.1:5188", (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      });
      request.setTimeout(500, () => request.destroy());
      request.on("error", () => resolve(false));
    });
    if (available) {
      run(require("electron"), ["."], {
        TABLELINE_DEV_URL: "http://127.0.0.1:5188",
        ELECTRON_RUN_AS_NODE: "",
      });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (!ending) {
    console.error("The local UI did not start within 30 seconds.");
    finish(1);
  }
}
waitForServer();
