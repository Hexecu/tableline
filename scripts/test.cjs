// Copyright (c) 2026 Davide Leopardi
// SPDX-License-Identifier: GPL-3.0-only
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
// cmd.exe does not expand POSIX globs. Explicitly enumerate the full suite on
// every host rather than relying on shell or Node-version-specific globbing.
const files = fs.readdirSync(path.join(root, "tests"))
  .filter(filename => filename.endsWith(".test.cjs")).sort()
  .map(filename => path.join(root, "tests", filename));
if (!files.length) throw new Error("No tests found.");
const result = spawnSync(process.execPath, ["--test", ...files], { cwd: root, stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status === null ? 1 : result.status;
