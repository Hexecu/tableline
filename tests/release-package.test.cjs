"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { verifyArchive, sourceFiles } = require("../scripts/verify-package.cjs");

// Snapshot fixture only; no system codesign, Keychain, or app process is used.
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tableline-package-source-"));
  const entries = {
    "electron/main.cjs": "main fixture", "electron/preload.cjs": "preload fixture",
    "dist/index.html": "<html>fixture</html>", "dist/assets/app.js": "fixture bundle",
    "assets/icon.png": "fixture png", "LICENSE": "MIT fixture",
    "THIRD_PARTY_NOTICES.md": "fixture notice",
    ...Object.fromEntries(["en", "it", "fr", "de", "es"].map((lang) => [`locales/${lang}.json`, JSON.stringify({ welcome: lang })])),
  };
  const metadata = { name: "tableline", version: "0.2.0", main: "electron/main.cjs", license: "MIT", build: { appId: "local.tableline.desktop" } };
  entries["package.json"] = JSON.stringify(metadata);
  for (const [entry, data] of Object.entries(entries)) {
    const filename = path.join(root, entry);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, data);
  }
  const headerString = "synthetic sealed ASAR header";
  const plist = {
    CFBundleIdentifier: "local.tableline.desktop", CFBundleName: "Tableline",
    CFBundleExecutable: "Tableline", CFBundleShortVersionString: "0.2.0",
    ElectronAsarIntegrity: { "Resources/app.asar": { algorithm: "SHA256", hash: crypto.createHash("sha256").update(headerString).digest("hex") } },
  };
  const archiveAPI = {
    getRawHeader: () => ({ headerString }),
    extractFile: (_archive, entry) => {
      if (!(entry in entries)) throw new Error(`Missing package file: ${entry}`);
      return Buffer.from(entries[entry]);
    },
  };
  return { root, entries, metadata, plist, archiveAPI };
}

test("release verifier matches every runtime file, license, icon source and all five catalog hashes", () => {
  const f = fixture();
  try {
    const verified = verifyArchive("fixture", f.plist, { sourceRoot: f.root, archiveAPI: f.archiveAPI });
    assert.equal(verified.sourceMatches, true);
    assert.equal(verified.files.length, 12);
    assert.deepEqual(verified.languageCatalogs, ["en", "it", "fr", "de", "es"]);
    assert.ok(verified.files.every((file) => /^[a-f\d]{64}$/.test(file.sha256)));
    fs.writeFileSync(path.join(f.root, "dist/assets/app.js"), "updated after build");
    assert.throws(() => verifyArchive("fixture", f.plist, { sourceRoot: f.root, archiveAPI: f.archiveAPI }), /Archive source mismatch: dist\/assets\/app.js/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

for (const corruption of ["bundle-id", "source-version", "package-version", "header", "missing-language", "empty-language", "missing-license", "metadata"]) {
  test(`release verifier rejects ${corruption}`, () => {
    const f = fixture();
    try {
      if (corruption === "bundle-id") f.plist.CFBundleIdentifier = "new.tableline.identity";
      if (corruption === "source-version") {
        fs.writeFileSync(path.join(f.root, "package.json"), JSON.stringify({ ...f.metadata, version: "0.1.0" }));
      }
      if (corruption === "package-version") f.entries["package.json"] = JSON.stringify({ ...f.metadata, version: "0.1.0" });
      if (corruption === "header") f.plist.ElectronAsarIntegrity["Resources/app.asar"].hash = "0".repeat(64);
      if (corruption === "missing-language") delete f.entries["locales/it.json"];
      if (corruption === "empty-language") f.entries["locales/it.json"] = "{}";
      if (corruption === "missing-license") delete f.entries["LICENSE"];
      if (corruption === "metadata") f.entries["package.json"] = JSON.stringify({ ...f.metadata, main: "other.cjs" });
      assert.throws(() => verifyArchive("fixture", f.plist, { sourceRoot: f.root, archiveAPI: f.archiveAPI }));
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
}

test("release source inventory rejects symlinked runtime entries", () => {
  const f = fixture();
  try {
    fs.symlinkSync(path.join(f.root, "LICENSE"), path.join(f.root, "electron/foreign.cjs"));
    assert.throws(() => sourceFiles(f.root), /symlink/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
