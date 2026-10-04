// Copyright (c) 2026 Davide Leopardi
// SPDX-License-Identifier: GPL-3.0-only

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Arch } = require("builder-util");
const { electronLicensesDirectory } = require("./verify-package.cjs");

// Electron's macOS framework preparation removes its extracted notices before
// afterPack. Preserve them from this exact distribution in afterExtract, before
// renaming/signing, and require the source-controlled upstream hash snapshot.
module.exports = async (context) => {
  if (context.electronPlatformName !== "darwin") return;
  const project = context.packager.projectDir;
  const manifest = JSON.parse(fs.readFileSync(path.join(project, "assets", "electron-notices.json"), "utf8"));
  const expectedVersion = JSON.parse(fs.readFileSync(path.join(project, "package.json"), "utf8")).devDependencies?.electron;
  const framework = context.packager.info.framework;
  const arch = typeof context.arch === "string" ? context.arch : Arch[context.arch];
  if (manifest.version !== 1 || manifest.platform !== "darwin" || manifest.arch !== arch ||
      manifest.electronVersion !== expectedVersion || framework.version !== expectedVersion ||
      !/^[a-f\d]{64}$/.test(manifest.upstreamArchiveSha256))
    throw new Error("Electron distribution/version/architecture does not match the reviewed notice snapshot.");
  const distributionApp = framework.distMacOsAppName;
  if (!/^[A-Za-z0-9 ._-]+\.app$/.test(distributionApp)) throw new Error("Unexpected extracted Electron bundle name.");
  const files = [
    ["LICENSE", "LICENSE.electron.txt"],
    ["LICENSES.chromium.html", "LICENSES.chromium.html"],
  ].map(([source, target]) => {
    const filename = path.join(context.appOutDir, source);
    if (!fs.lstatSync(filename).isFile()) throw new Error(`Electron notice is not a regular distribution file: ${source}`);
    const contents = fs.readFileSync(filename), expected = manifest.licenses?.[target];
    const sha256 = crypto.createHash("sha256").update(contents).digest("hex");
    if (!expected || !contents.length || contents.length !== expected.bytes || sha256 !== expected.sha256)
      throw new Error(`Electron distribution notice does not match the reviewed upstream hash: ${source}`);
    return { target, contents };
  });
  const licenses = electronLicensesDirectory(path.join(context.appOutDir, distributionApp), { create: true });
  for (const { target, contents } of files)
    fs.writeFileSync(path.join(licenses, target), contents, { flag: "wx", mode: 0o644 });
};
