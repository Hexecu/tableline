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
  for (const filename of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) walk(filename);
  return entries;
}

function verifyArchive(archive, plist, { sourceRoot = root, archiveAPI = asar } = {}) {
  const expected = JSON.parse(fs.readFileSync(path.join(sourceRoot, "package.json"), "utf8"));
  if (expected.build?.appId !== APP_ID || plist.CFBundleIdentifier !== APP_ID)
    throw new Error("Unexpected application bundle identifier; existing credential identity must remain stable.");
  if (plist.CFBundleName !== "Tableline" || plist.CFBundleExecutable !== "Tableline")
    throw new Error("Unexpected application name or executable.");
  const { headerString } = archiveAPI.getRawHeader(archive);
  const integrity = plist.ElectronAsarIntegrity?.["Resources/app.asar"];
  if (integrity?.algorithm !== "SHA256" || integrity.hash !== hash(headerString))
    throw new Error("The sealed ASAR header integrity does not match Info.plist.");
  const packaged = JSON.parse(archiveAPI.extractFile(archive, "package.json").toString("utf8"));
  if (packaged.version !== expected.version || packaged.version !== plist.CFBundleShortVersionString)
    throw new Error("Source, application and archive versions do not match.");
  if (packaged.main !== "electron/main.cjs" || packaged.name !== "tableline" || packaged.license !== "MIT")
    throw new Error("Unexpected archive application metadata.");
  for (const entry of ["electron/main.cjs", "electron/preload.cjs", "dist/index.html", "assets/icon.png", "LICENSE", "THIRD_PARTY_NOTICES.md", ...LANGUAGES.map((lang) => `locales/${lang}.json`)]) {
    const contents = archiveAPI.extractFile(archive, entry);
    if (!contents.length) throw new Error(`Missing required package entry: ${entry}`);
    if (entry.startsWith("locales/")) {
      const catalog = JSON.parse(contents.toString("utf8"));
      if (!catalog || typeof catalog !== "object" || !Object.keys(catalog).length)
        throw new Error(`Empty language catalog: ${entry}`);
    }
  }
  const files = sourceFiles(sourceRoot).map((entry) => {
    const sourceHash = hash(fs.readFileSync(path.join(sourceRoot, entry)));
    const archiveHash = hash(archiveAPI.extractFile(archive, entry));
    if (sourceHash !== archiveHash) throw new Error(`Archive source mismatch: ${entry}`);
    return { path: entry, sha256: sourceHash };
  });
  return { version: packaged.version, sourceMatches: true, files, languageCatalogs: LANGUAGES };
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
    app, arch, ...checked,
    archiveSha256: hash(fs.readFileSync(archive)),
    signatureIntegrity: true, asarIntegrity: true,
    notarizationVerified: false,
  };
}

if (require.main === module) {
  try {
    if (process.argv.length !== 3) throw new Error("Usage: node scripts/verify-package.cjs /path/to/Tableline.app");
    const result = verifyPackage(process.argv[2]);
    console.log(JSON.stringify(result, null, 2));
    console.log("Signature/resource integrity is verified. Developer ID trust and notarization are separate release gates.");
  } catch (error) {
    console.error("Package verification failed:", error.message);
    process.exitCode = 1;
  }
}

module.exports = { verifyPackage, verifyArchive, sourceFiles };
