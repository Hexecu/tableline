// Copyright (c) 2026 Davide Leopardi
// SPDX-License-Identifier: GPL-3.0-only

"use strict";

// Adapted from Branchline (MIT), copyright (c) 2026 Davide Leopardi.
// See THIRD_PARTY_NOTICES.md.

const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Arch } = require("builder-util");
const { verifyElectronNotices } = require("./verify-package.cjs");

// Finder metadata can be inherited while Electron is copied into the build
// output. codesign rejects it even when it is attached to a parent bundle.
// Only clean generated bundle metadata, before signing; retain quarantine and
// every other extended attribute. Never alter an installed or downloaded app.
module.exports = async (context) => {
  const platform = context.electronPlatformName;
  const bundle = platform === "darwin" ? path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  ) : context.appOutDir;
  verifyElectronNotices(bundle, {
    sourceRoot: context.packager.projectDir,
    arch: typeof context.arch === "string" ? context.arch : Arch[context.arch],
    electronVersion: context.packager.info.framework.version,
    platform,
  });
  if (platform !== "darwin") return;
  for (const attribute of ["com.apple.FinderInfo", "com.apple.ResourceFork"])
    execFileSync("/usr/bin/xattr", ["-dr", attribute, bundle], {
      stdio: ["ignore", "pipe", "pipe"],
    });
};
