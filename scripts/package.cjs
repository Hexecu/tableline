// Copyright (c) 2026 Davide Leopardi
// SPDX-License-Identifier: GPL-3.0-only

"use strict";

// Packaging/signing strategy adapted from Branchline (MIT), copyright (c)
// 2026 Davide Leopardi. See THIRD_PARTY_NOTICES.md.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { verifyPackage, verifyDesktopPackage } = require("./verify-package.cjs");

const root = path.resolve(__dirname, "..");
const version = require(path.join(root, "package.json")).version;

function runCommand(file, args, options = {}) {
  const result = spawnSync(file, args, {
    timeout: 1200000,
    killSignal: "SIGTERM",
    ...options,
  });
  // A timeout or signal yields status=null. It must never count as success.
  if (result.error || result.status !== 0)
    throw new Error(
      `Packaging command failed (${result.error?.code || result.signal || result.status || "process error"}).`,
    );
  return result;
}

function packageApp({
  identity,
  outputDir,
  buildRenderer = true,
  env = process.env,
  run = runCommand,
  log = console.log,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  if (!["darwin", "win32", "linux"].includes(platform))
    throw new Error("Local packaging supports macOS, Windows and Linux.");
  if (!["arm64", "x64"].includes(arch))
    throw new Error("Supported package architectures are arm64 and x64.");
  const base = platform === "darwin"
    ? path.join(os.homedir(), "Library", "Caches", "Tableline")
    : platform === "win32" ? path.join(env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Tableline")
    : path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "Tableline");
  const output = path.resolve(outputDir || env.TABLELINE_RELEASE_DIR || path.join(base, "build", `v${version}`));
  fs.mkdirSync(output, { recursive: true });
  const builderEnv = { ...env, CSC_IDENTITY_AUTO_DISCOVERY: "false" };
  // The local package command cannot import certificates or submit to Apple.
  for (const key of Object.keys(builderEnv))
    if (/^(?:CSC_(?!IDENTITY_AUTO_DISCOVERY)|APPLE_)/.test(key) || /(?:token|password|secret|(?:^|_)key(?:_|$)|credential|csc_link)/i.test(key))
      delete builderEnv[key];
  delete builderEnv.DEBUG;
  delete builderEnv.ELECTRON_BUILDER_ALLOW_UNRESOLVED_DEPENDENCIES;
  if (buildRenderer) {
    // Invoke JavaScript CLIs directly: .cmd scripts require a shell on Windows.
    run(process.execPath, [require.resolve("typescript/bin/tsc"), "--noEmit"], {
      cwd: root, env: builderEnv, stdio: "inherit",
    });
    run(process.execPath, [path.join(path.dirname(require.resolve("vite/package.json")), "bin", "vite.js"), "build"], {
      cwd: root, env: builderEnv, stdio: "inherit",
    });
  }
  const args = [
    require.resolve("electron-builder/out/cli/cli.js"),
    platform === "darwin" ? "--mac" : platform === "win32" ? "--win" : "--linux",
    "dir", `--${arch}`, "--publish", "never",
    `--config.directories.output=${output}`,
  ];
  if (platform === "darwin") {
    const selected = String(identity || env.TABLELINE_SIGN_IDENTITY || "-").replace(/^Developer ID Application:\s*/, "");
    args.push(`--config.mac.identity=${selected}`, "--config.mac.notarize=false");
    if (selected === "-") {
      // Ad-hoc binaries have no Team ID; hardened library validation prevents
      // even Electron's framework from loading. Local CI packages never become
      // public release artifacts. Developer ID releases retain hardened runtime.
      args.push("--config.mac.hardenedRuntime=false");
    } else args.push(
      "--config.forceCodeSigning=true", "--config.mac.type=distribution",
      "--config.mac.hardenedRuntime=true",
    );
  }
  run(process.execPath, args, { cwd: root, env: builderEnv, stdio: "inherit" });
  if (platform !== "darwin") {
    const folder = `${platform === "win32" ? "win" : "linux"}${arch === "arm64" ? "-arm64" : ""}-unpacked`;
    const bundle = path.join(output, folder);
    const verification = verifyDesktopPackage(bundle, { platform, arch });
    log(`Verified Tableline local ${platform}/${arch} package: ${bundle}`);
    return { bundle, output, platform, arch, verification, publicRelease: false };
  }
  const bundle = path.join(output, arch === "x64" ? "mac" : `mac-${arch}`, "Tableline.app");
  const verification = verifyPackage(bundle, { arch });
  log(`Verified Tableline ${version}: ${bundle}`);
  return { bundle, output, verification, publicRelease: false };
}

function packageMac(options = {}) {
  if ((options.platform || process.platform) !== "darwin")
    throw new Error("macOS packaging requires macOS.");
  return packageApp({ ...options, platform: "darwin" });
}

if (require.main === module) {
  try {
    if (process.argv.length > 2) throw new Error("Usage: node scripts/package.cjs");
    packageApp();
    console.log("This is a local package. Only release:macos creates a verified public macOS archive.");
  } catch (error) {
    console.error("Package failed:", error.message);
    process.exitCode = 1;
  }
}

module.exports = { packageApp, packageMac, runCommand };
