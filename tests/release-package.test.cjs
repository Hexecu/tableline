// Copyright (c) 2026 Davide Leopardi
// SPDX-License-Identifier: GPL-3.0-only

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { verifyArchive, sourceFiles, verifyElectronNotices, electronFrameworkVersion } = require("../scripts/verify-package.cjs");
const preserveElectronNotices = require("../scripts/preserve-electron-notices.cjs");
const { Arch } = require("builder-util");

// Snapshot fixture only; no system codesign, Keychain, or app process is used.
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tableline-package-source-"));
  const entries = {
    "electron/main.cjs": "main fixture", "electron/preload.cjs": "preload fixture",
    "dist/index.html": "<html>fixture</html>", "dist/assets/app.js": "fixture bundle",
    "assets/icon.png": "fixture png", "LICENSE": "GPLv3 fixture",
    "COPYRIGHT": "GPL-3.0-only copyright, warranty and source notice fixture",
    "THIRD_PARTY_NOTICES.md": "fixture notice",
    ...Object.fromEntries(["en", "it", "fr", "de", "es"].map((lang) => [`locales/${lang}.json`, JSON.stringify({ welcome: lang })])),
  };
  const metadata = { name: "tableline", version: "0.2.0", main: "electron/main.cjs", license: "GPL-3.0-only", build: { appId: "local.tableline.desktop" } };
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
    assert.equal(verified.files.length, 13);
    assert.equal(verified.license, "GPL-3.0-only");
    assert.deepEqual(verified.languageCatalogs, ["en", "it", "fr", "de", "es"]);
    assert.ok(verified.files.every((file) => /^[a-f\d]{64}$/.test(file.sha256)));
    fs.writeFileSync(path.join(f.root, "dist/assets/app.js"), "updated after build");
    assert.throws(() => verifyArchive("fixture", f.plist, { sourceRoot: f.root, archiveAPI: f.archiveAPI }), /Archive source mismatch: dist\/assets\/app.js/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

for (const corruption of ["bundle-id", "source-version", "package-version", "header", "missing-language", "empty-language", "missing-license", "missing-copyright", "source-license", "package-license", "metadata"]) {
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
      if (corruption === "missing-copyright") delete f.entries["COPYRIGHT"];
      if (corruption === "source-license") fs.writeFileSync(path.join(f.root, "package.json"), JSON.stringify({ ...f.metadata, license: "MIT" }));
      if (corruption === "package-license") f.entries["package.json"] = JSON.stringify({ ...f.metadata, license: "MIT" });
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

function noticesFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tableline-electron-notices-"));
  const output = path.join(root, "extracted");
  const notices = { "LICENSE.electron.txt": "Synthetic Electron MIT notice", "LICENSES.chromium.html": "<html>Synthetic Chromium notices</html>" };
  const manifest = {
    version: 1, electronVersion: "44.5.1", platform: "darwin", arch: "arm64",
    upstreamArchiveSha256: "a".repeat(64),
    licenses: Object.fromEntries(Object.entries(notices).map(([name, bytes]) => [name, {
      bytes: Buffer.byteLength(bytes), sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    }])),
  };
  fs.mkdirSync(path.join(root, "assets"), { recursive: true });
  fs.writeFileSync(path.join(root, "assets/electron-notices.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ devDependencies: { electron: "44.5.1" } }));
  const bundle = path.join(output, "Electron.app");
  fs.mkdirSync(path.join(bundle, "Contents/Resources"), { recursive: true });
  fs.writeFileSync(path.join(output, "LICENSE"), notices["LICENSE.electron.txt"]);
  fs.writeFileSync(path.join(output, "LICENSES.chromium.html"), notices["LICENSES.chromium.html"]);
  const context = {
    electronPlatformName: "darwin", arch: Arch.arm64, appOutDir: output,
    packager: { projectDir: root, info: { framework: { version: "44.5.1", distMacOsAppName: "Electron.app" } } },
  };
  return { root, output, bundle, context, manifest };
}

test("official Electron framework plist uses CFBundleVersion without a short version", () => {
  // The official 44.5.1 framework has this version field and no short version.
  const plist = JSON.parse('{"CFBundleIdentifier":"com.github.Electron.framework","CFBundleName":"Electron Framework","CFBundleVersion":"44.5.1"}');
  assert.equal(Object.hasOwn(plist, "CFBundleShortVersionString"), false);
  assert.equal(electronFrameworkVersion(plist), "44.5.1");
  assert.equal(electronFrameworkVersion({ ...plist, CFBundleShortVersionString: "44.5.1" }), "44.5.1");
  for (const invalid of [
    {}, { CFBundleShortVersionString: "44.5.1" }, { CFBundleVersion: 44.5 },
    { ...plist, CFBundleShortVersionString: "44.5.0" },
  ]) assert.throws(() => electronFrameworkVersion(invalid), /version metadata/);
});

test("afterExtract preserves exact upstream Electron and Chromium notices before rename and signing", async () => {
  const f = noticesFixture();
  try {
    await preserveElectronNotices(f.context);
    fs.unlinkSync(path.join(f.output, "LICENSE"));
    fs.unlinkSync(path.join(f.output, "LICENSES.chromium.html"));
    const renamed = path.join(f.output, "Tableline.app");
    fs.renameSync(f.bundle, renamed);
    const checked = verifyElectronNotices(renamed, { sourceRoot: f.root, arch: "arm64", electronVersion: "44.5.1" });
    assert.equal(checked.licenses.length, 2);
    assert.ok(checked.licenses.every((entry) => entry.sha256 === f.manifest.licenses[path.basename(entry.path)].sha256));
    fs.appendFileSync(path.join(renamed, "Contents/Resources/licenses/LICENSES.chromium.html"), "corrupted");
    assert.throws(() => verifyElectronNotices(renamed, { sourceRoot: f.root, arch: "arm64", electronVersion: "44.5.1" }), /reviewed upstream bytes/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

for (const corruption of ["missing", "wrong-hash", "version", "arch", "symlink"]) {
  test(`afterExtract fails before copying notices for ${corruption}`, async () => {
    const f = noticesFixture();
    try {
      if (corruption === "missing") fs.unlinkSync(path.join(f.output, "LICENSES.chromium.html"));
      if (corruption === "wrong-hash") fs.appendFileSync(path.join(f.output, "LICENSES.chromium.html"), "wrong");
      if (corruption === "version") f.context.packager.info.framework.version = "44.5.2";
      if (corruption === "arch") f.context.arch = 1;
      if (corruption === "symlink") {
        fs.renameSync(path.join(f.output, "LICENSES.chromium.html"), path.join(f.output, "other-notices.html"));
        fs.symlinkSync(path.join(f.output, "other-notices.html"), path.join(f.output, "LICENSES.chromium.html"));
      }
      await assert.rejects(preserveElectronNotices(f.context));
      assert.equal(fs.existsSync(path.join(f.bundle, "Contents/Resources/licenses")), false);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
}

test("package verifier refuses missing notices, wrong Electron version and unsupported notice snapshot arch", async () => {
  const f = noticesFixture();
  try {
    assert.throws(() => verifyElectronNotices(f.bundle, { sourceRoot: f.root, arch: "arm64", electronVersion: "44.5.1" }));
    await preserveElectronNotices(f.context);
    assert.throws(() => verifyElectronNotices(f.bundle, { sourceRoot: f.root, arch: "arm64", electronVersion: "44.5.2" }), /version\/architecture/);
    assert.throws(() => verifyElectronNotices(f.bundle, { sourceRoot: f.root, arch: "x64", electronVersion: "44.5.1" }), /version\/architecture/);
    fs.unlinkSync(path.join(f.bundle, "Contents/Resources/licenses/LICENSE.electron.txt"));
    assert.throws(() => verifyElectronNotices(f.bundle, { sourceRoot: f.root, arch: "arm64", electronVersion: "44.5.1" }));
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

for (const ancestor of ["Contents", "Contents/Resources", "Contents/Resources/licenses"]) {
  test(`notice hooks and verifier reject symlinked ${ancestor} ancestors`, async () => {
    const f = noticesFixture();
    try {
      await preserveElectronNotices(f.context);
      const original = path.join(f.bundle, ancestor), external = path.join(f.root, "external");
      fs.renameSync(original, external);
      fs.symlinkSync(external, original);
      assert.throws(() => verifyElectronNotices(f.bundle, { sourceRoot: f.root, arch: "arm64", electronVersion: "44.5.1" }), /director/);
      await assert.rejects(preserveElectronNotices(f.context), /director/);
      const remaining = ancestor === "Contents" ? "Resources/licenses" : ancestor === "Contents/Resources" ? "licenses" : "";
      for (const [filename, expected] of Object.entries(f.manifest.licenses)) {
        const bytes = fs.readFileSync(path.join(external, remaining, filename));
        assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), expected.sha256);
      }
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
}
