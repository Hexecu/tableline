// Copyright (c) 2026 Davide Leopardi
// SPDX-License-Identifier: GPL-3.0-only

"use strict";

// ASAR/signature checks adapted from Branchline (MIT), copyright (c) 2026
// Davide Leopardi. See THIRD_PARTY_NOTICES.md. This verifier never starts the app.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const asar = require("@electron/asar");

const root = path.resolve(__dirname, "..");
const APP_ID = "local.tableline.desktop";
const LANGUAGES = ["en", "it", "fr", "de", "es"];
const hash = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

function sourceFiles(sourceRoot) {
  const entries = [];
  function walk(relative) {
    const filename = path.join(sourceRoot, relative);
    const stat = fs.lstatSync(filename);
    if (stat.isSymbolicLink()) throw new Error(`Source release entry is a symlink: ${relative}`);
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(filename).sort()) walk(path.join(relative, child));
    } else if (stat.isFile()) entries.push(relative.split(path.sep).join("/"));
    else throw new Error(`Unsupported source release entry: ${relative}`);
  }
  for (const folder of ["electron", "dist", "assets", "locales"]) walk(folder);
  for (const filename of ["LICENSE", "COPYRIGHT", "THIRD_PARTY_NOTICES.md"]) walk(filename);
  return entries;
}

function verifyArchiveContents(archive, { sourceRoot = root, archiveAPI = asar } = {}) {
  // ASAR's API splits directory keys using the host's path.sep. Evidence keeps
  // portable slash paths; nested lookups must use native separators on Windows.
  const extract = entry => archiveAPI.extractFile(archive, entry.split("/").join(path.sep));
  const expected = JSON.parse(fs.readFileSync(path.join(sourceRoot, "package.json"), "utf8"));
  if (expected.build?.appId !== APP_ID)
    throw new Error("Unexpected application bundle identifier; existing credential identity must remain stable.");
  const packaged = JSON.parse(extract("package.json").toString("utf8"));
  if (packaged.version !== expected.version)
    throw new Error("Source, application and archive versions do not match.");
  if (packaged.main !== "electron/main.cjs" || packaged.name !== "tableline" ||
      packaged.license !== "GPL-3.0-only" || expected.license !== packaged.license)
    throw new Error("Unexpected archive application metadata.");
  for (const entry of ["electron/main.cjs", "electron/preload.cjs", "dist/index.html", "assets/icon.png", "LICENSE", "COPYRIGHT", "THIRD_PARTY_NOTICES.md", ...LANGUAGES.map((lang) => `locales/${lang}.json`)]) {
    const contents = extract(entry);
    if (!contents.length) throw new Error(`Missing required package entry: ${entry}`);
    if (entry.startsWith("locales/")) {
      const catalog = JSON.parse(contents.toString("utf8"));
      if (!catalog || typeof catalog !== "object" || !Object.keys(catalog).length)
        throw new Error(`Empty language catalog: ${entry}`);
    }
  }
  const files = sourceFiles(sourceRoot).map((entry) => {
    const sourceHash = hash(fs.readFileSync(path.join(sourceRoot, entry)));
    const archiveHash = hash(extract(entry));
    if (sourceHash !== archiveHash) throw new Error(`Archive source mismatch: ${entry}`);
    return { path: entry, sha256: sourceHash };
  });
  return { version: packaged.version, license: packaged.license, sourceMatches: true, files, languageCatalogs: LANGUAGES };
}

function verifyArchive(archive, plist, options = {}) {
  if (plist.CFBundleIdentifier !== APP_ID)
    throw new Error("Unexpected application bundle identifier; existing credential identity must remain stable.");
  if (plist.CFBundleName !== "Tableline" || plist.CFBundleExecutable !== "Tableline")
    throw new Error("Unexpected application name or executable.");
  const { headerString } = (options.archiveAPI || asar).getRawHeader(archive);
  const integrity = plist.ElectronAsarIntegrity?.["Resources/app.asar"];
  if (integrity?.algorithm !== "SHA256" || integrity.hash !== hash(headerString))
    throw new Error("The sealed ASAR header integrity does not match Info.plist.");
  const checked = verifyArchiveContents(archive, options);
  if (checked.version !== plist.CFBundleShortVersionString)
    throw new Error("Source, application and archive versions do not match.");
  return checked;
}

function noticeSnapshot(sourceRoot, platform, arch, electronVersion) {
  const manifest = JSON.parse(fs.readFileSync(path.join(sourceRoot, "assets", "electron-notices.json"), "utf8"));
  const expected = JSON.parse(fs.readFileSync(path.join(sourceRoot, "package.json"), "utf8")).devDependencies?.electron;
  const snapshot = manifest.version === 2 ? manifest.distributions?.[`${platform}-${arch}`]
    : manifest.version === 1 && manifest.platform === platform && manifest.arch === arch ? manifest : null;
  if (!snapshot || manifest.electronVersion !== expected || electronVersion !== expected ||
      !/^[a-f\d]{64}$/.test(snapshot.upstreamArchiveSha256))
    throw new Error("Packaged Electron version/architecture does not match the reviewed notice snapshot.");
  return snapshot;
}

function electronLicensesDirectory(bundle, { create = false, platform = "darwin" } = {}) {
  const ancestors = platform === "darwin" ? ["", "Contents", "Contents/Resources"] : ["", "resources"];
  for (const relative of ancestors)
    if (!fs.lstatSync(path.join(bundle, relative)).isDirectory())
      throw new Error("Electron notice bundle ancestors must be real directories, not symlinks.");
  const licenses = path.join(bundle, ...ancestors.at(-1).split("/"), "licenses");
  if (create && !fs.existsSync(licenses)) fs.mkdirSync(licenses);
  if (!fs.lstatSync(licenses).isDirectory())
    throw new Error("Packaged Electron notices must be a directory inside the application.");
  if (!fs.realpathSync(licenses).startsWith(fs.realpathSync(bundle) + path.sep))
    throw new Error("Electron notices resolve outside the application bundle.");
  return licenses;
}

function verifyElectronNotices(bundle, { sourceRoot = root, arch = process.arch, platform = "darwin", electronVersion } = {}) {
  const snapshot = noticeSnapshot(sourceRoot, platform, arch, electronVersion);
  const licensesDir = electronLicensesDirectory(bundle, { platform });
  const licenses = ["LICENSE.electron.txt", "LICENSES.chromium.html"].map((filename) => {
    const fullPath = path.join(licensesDir, filename);
    if (!fs.lstatSync(fullPath).isFile()) throw new Error(`Missing regular packaged Electron notice: ${filename}`);
    const content = fs.readFileSync(fullPath), expected = snapshot.licenses?.[filename];
    if (!expected || !content.length || content.length !== expected.bytes || hash(content) !== expected.sha256)
      throw new Error(`Packaged Electron notice does not match reviewed upstream bytes: ${filename}`);
    return { path: `${platform === "darwin" ? "Contents/Resources" : "resources"}/licenses/${filename}`, bytes: content.length, sha256: expected.sha256 };
  });
  return { electronVersion, upstreamArchiveSha256: snapshot.upstreamArchiveSha256, licenses };
}

function executableArchitecture(bytes, platform) {
  if (!Buffer.isBuffer(bytes)) throw new Error("Expected executable bytes.");
  let machine;
  if (platform === "linux") {
    if (bytes.length < 20 || !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) || bytes[4] !== 2 || bytes[5] !== 1)
      throw new Error("Expected a 64-bit little-endian ELF executable.");
    machine = bytes.readUInt16LE(18);
    if (machine === 62) return "x64";
    if (machine === 183) return "arm64";
  } else if (platform === "win32") {
    if (bytes.length < 64 || bytes.toString("ascii", 0, 2) !== "MZ") throw new Error("Expected a Windows PE executable.");
    const offset = bytes.readUInt32LE(0x3c);
    if (offset > bytes.length - 6 || bytes.readUInt32LE(offset) !== 0x4550) throw new Error("Invalid Windows PE header.");
    machine = bytes.readUInt16LE(offset + 4);
    if (machine === 0x8664) return "x64";
    if (machine === 0xaa64) return "arm64";
  }
  throw new Error("Unsupported executable platform or architecture.");
}

function verifyDatabricksInventory(archive, { archiveAPI = asar } = {}) {
  const files = archiveAPI.listPackage(archive).map(entry => entry.replaceAll("\\", "/"));
  if (files.some(entry => /\/node_modules\/@databricks\/databricks-sql-kernel-[^/]+(?:\/|$)/.test(entry) ||
      /\/node_modules\/@databricks\/sql\/native\/kernel\/[^/]+\.node$/.test(entry)))
    throw new Error("The unused native Databricks kernel must not be distributed.");
  if (!files.some(entry => entry.endsWith("/node_modules/@databricks/sql/dist/thrift-backend/ThriftBackend.js")))
    throw new Error("The supported Databricks Thrift backend is missing.");
  return { databricksBackend: "thrift", databricksKernelBundled: false };
}

function verifyDesktopPackage(directory, { sourceRoot = root, platform = process.platform, arch = process.arch } = {}) {
  if (platform === "darwin") return verifyPackage(directory, { sourceRoot, platform, arch });
  if (!["linux", "win32"].includes(platform) || !["x64", "arm64"].includes(arch)) throw new Error("Unsupported desktop package target.");
  const app = path.resolve(directory);
  const executable = path.join(app, platform === "win32" ? "Tableline.exe" : "tableline");
  if (!fs.lstatSync(app).isDirectory() || !fs.lstatSync(executable).isFile()) throw new Error("Expected a completed desktop package.");
  if (executableArchitecture(fs.readFileSync(executable), platform) !== arch) throw new Error("Package executable architecture mismatch.");
  const archive = path.join(app, "resources", "app.asar");
  if (!fs.lstatSync(archive).isFile()) throw new Error("Missing regular application archive.");
  const electronVersion = JSON.parse(fs.readFileSync(path.join(sourceRoot, "package.json"), "utf8")).devDependencies.electron;
  return { app, executable, platform, arch,
    ...verifyArchiveContents(archive, { sourceRoot }),
    ...verifyDatabricksInventory(archive),
    ...verifyElectronNotices(app, { sourceRoot, platform, arch, electronVersion }),
    archiveSha256: hash(fs.readFileSync(archive)), signatureIntegrity: false, asarIntegrity: false, notarizationVerified: false };
}

function electronFrameworkVersion(plist) {
  const version = plist?.CFBundleVersion;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version) ||
      (Object.hasOwn(plist, "CFBundleShortVersionString") && plist.CFBundleShortVersionString !== version))
    throw new Error("Electron framework has missing or inconsistent version metadata.");
  return version;
}

function verifyPackage(bundlePath, { sourceRoot = root, run = execFileSync, platform = process.platform, arch = process.arch } = {}) {
  if (platform !== "darwin") throw new Error("macOS package verification requires macOS.");
  if (!["arm64", "x64"].includes(arch)) throw new Error("Unsupported package architecture.");
  const app = path.resolve(bundlePath);
  if (!app.endsWith(".app") || !fs.statSync(app).isDirectory())
    throw new Error("Expected a completed .app bundle.");
  const options = { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000 };
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", app], options);
  const contents = path.join(app, "Contents");
  if (!fs.statSync(path.join(contents, "_CodeSignature", "CodeResources")).isFile())
    throw new Error("The app bundle has no sealed code resources.");
  const plist = JSON.parse(run("/usr/bin/plutil", ["-convert", "json", "-o", "-", path.join(contents, "Info.plist")], options));
  const framework = JSON.parse(run("/usr/bin/plutil", ["-convert", "json", "-o", "-", path.join(contents, "Frameworks", "Electron Framework.framework", "Resources", "Info.plist")], options));
  const notices = verifyElectronNotices(app, { sourceRoot, arch, electronVersion: electronFrameworkVersion(framework) });
  if (plist.CFBundleExecutable !== "Tableline") throw new Error("Unexpected application executable.");
  run("/usr/bin/lipo", [path.join(contents, "MacOS", "Tableline"), "-verify_arch", arch === "x64" ? "x86_64" : arch], options);
  const iconName = plist.CFBundleIconFile;
  if (typeof iconName !== "string" || !/^[A-Za-z0-9_.-]+$/.test(iconName))
    throw new Error("Missing or invalid application icon metadata.");
  const icon = path.join(contents, "Resources", iconName.endsWith(".icns") ? iconName : `${iconName}.icns`);
  if (!fs.statSync(icon).isFile() || fs.statSync(icon).size < 1024)
    throw new Error("The packaged application icon is missing or empty.");
  const archive = path.join(contents, "Resources", "app.asar");
  const checked = verifyArchive(archive, plist, { sourceRoot });
  return {
    app, arch, ...checked, ...notices,
    ...verifyDatabricksInventory(archive),
    archiveSha256: hash(fs.readFileSync(archive)),
    signatureIntegrity: true, asarIntegrity: true,
    notarizationVerified: false,
  };
}

if (require.main === module) {
  try {
    if (process.argv.length !== 3) throw new Error("Usage: node scripts/verify-package.cjs /path/to/native/Tableline-package");
    const result = verifyDesktopPackage(process.argv[2]);
    console.log(JSON.stringify(result, null, 2));
    console.log(process.platform === "darwin"
      ? "Signature/resource integrity is verified. Developer ID trust and notarization are separate release gates."
      : "Source contents, executable architecture and upstream notices are verified. OS signing and installation trust are separate release gates.");
  } catch (error) {
    console.error("Package verification failed:", error.message);
    process.exitCode = 1;
  }
}

module.exports = { verifyPackage, verifyDesktopPackage, verifyArchive, verifyArchiveContents, sourceFiles, verifyElectronNotices, electronLicensesDirectory, electronFrameworkVersion, noticeSnapshot, executableArchitecture, verifyDatabricksInventory };
