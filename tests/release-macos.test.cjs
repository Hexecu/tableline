"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const crypto = require("node:crypto");
const {
  configuration,
  sanitizer,
  buildEnvironment,
  installedIdentity,
  signedIdentity,
  gatekeeperAccepted,
  verifySignedBundle,
} = require("../scripts/release-macos.cjs");

// All certificate/tool responses below are synthetic. No signing, Keychain
// lookup, notarization request or Gatekeeper change is executed by these tests.
const root = path.resolve(__dirname, "..");
const identity = "Developer ID Application: Tableline QA (ABCDE12345)";
const hash = "A".repeat(40);
const cdhash = "b".repeat(40);
const archiveSha256 = "c".repeat(64);
const submissionId = "11111111-1111-1111-1111-111111111111";
const environment = {
  TABLELINE_SIGN_IDENTITY: identity,
  TABLELINE_NOTARY_PROFILE: "tableline-qa",
};
const signature =
  `Authority=${identity}\nTeamIdentifier=ABCDE12345\n` +
  "CodeDirectory v=20500 size=644 flags=0x10000(runtime) hashes=9+7 location=embedded\n" +
  `Timestamp=Oct 2, 2026 at 12:00:00\nCDHash=${cdhash}`;

test("release preflight rejects missing, foreign, ambiguous and non-Developer-ID identities", () => {
  assert.throws(() => configuration({}, "darwin", "arm64"), /Set TABLELINE/);
  assert.throws(
    () => configuration(environment, "linux", "x64"),
    /requires macOS/,
  );
  for (const value of [
    "-",
    "Apple Development: QA (ABCDE12345)",
    "Developer ID Application: QA\n(ABCDE12345)",
    "Developer ID Application: QA (wrong)",
  ])
    assert.throws(
      () =>
        configuration(
          { ...environment, TABLELINE_SIGN_IDENTITY: value },
          "darwin",
          "arm64",
        ),
      /full, exact/,
    );
  assert.throws(
    () =>
      configuration(
        { ...environment, TABLELINE_NOTARY_PROFILE: "--force" },
        "darwin",
        "arm64",
      ),
    /profile name/,
  );
  assert.equal(
    installedIdentity(
      `1) ${hash} "${identity}"\n1 valid identities found`,
      identity,
    ),
    hash,
  );
  assert.throws(
    () => installedIdentity(`1) ${hash} "Other"`, identity),
    /missing or ambiguous/,
  );
  assert.throws(
    () =>
      installedIdentity(
        `1) ${hash} "${identity}"\n2) ${"B".repeat(40)} "${identity}"`,
        identity,
      ),
    /ambiguous/,
  );
  signedIdentity(signature, { identity, teamId: "ABCDE12345" });
  for (const invalid of [
    signature.replace("(runtime)", "(adhoc)"),
    signature.replace("ABCDE12345", "FOREIGN123"),
    signature.replace(/Timestamp=.+/, ""),
  ])
    assert.throws(
      () => signedIdentity(invalid, { identity, teamId: "ABCDE12345" }),
      /hardened runtime/,
    );
});

test("Developer ID inspection accepts actual codesign CodeDirectory output and rejects missing or misleading runtime flags", () => {
  const config = { identity, teamId: "ABCDE12345" };
  signedIdentity(signature, config);
  signedIdentity(
    signature.replace("0x10000(runtime)", "0x10001(hard,runtime)"),
    config,
  );
  for (const invalid of [
    signature.replace("flags=0x10000(runtime)", "flags=0x0(runtime)"),
    signature.replace("flags=0x10000(runtime)", "flags=0x10000(noruntime)"),
    signature.replace("flags=0x10000(runtime)", "flags=0x0(none) runtime"),
    signature.replace("flags=0x10000(runtime)", "flags=0x10000() runtime"),
    signature.replace("CodeDirectory v=", "CodeDirectory=v="),
    signature.replace(/CodeDirectory[^\n]+\n/, "runtime\n"),
    signature + "\nCodeDirectory v=20500 size=644 flags=0x10000(runtime)",
    signature.replace(/Timestamp=.+/, "Timestamp=none"),
    signature + "\nTeamIdentifier=FOREIGN123",
    signature.replace(`Authority=${identity}`, `Authority=Other\nAuthority=${identity}`),
  ])
    assert.throws(() => signedIdentity(invalid, config), /hardened runtime/);
});

test("release child environment removes unrelated credentials and errors remain bounded and redacted", () => {
  const secret = "fixture-secret-value";
  const env = {
    ...environment,
    CSC_LINK: secret,
    APPLE_API_KEY: secret,
    LITELLM_KEY: secret,
    AWS_ACCESS_KEY_ID: secret,
    API_TOKEN: secret,
    PATH: "/usr/bin",
  };
  const clean = buildEnvironment(env);
  for (const key of Object.keys(env).filter((key) => key !== "PATH"))
    assert.equal(clean[key], undefined, key);
  assert.equal(clean.CSC_IDENTITY_AUTO_DISCOVERY, "false");
  assert.equal(clean.PATH, "/usr/bin");
  const redact = sanitizer(env);
  const message = redact(
    `Error ${secret} Bearer abcdef token=defgh https://user:pass@example.invalid/path {"password":"unknown-value"} https://upload.example.invalid/file?signature=signed-query`,
  );
  assert.doesNotMatch(
    message,
    /fixture-secret-value|abcdef|defgh|user:pass|unknown-value|signed-query/,
  );
  assert.ok(redact("x".repeat(10000)).length <= 4096);
});

function loadWithMocks(home, outcome) {
  const calls = [],
    logs = [];
  const leaf = "-----BEGIN CERTIFICATE-----\nLEAF\n-----END CERTIFICATE-----";
  const appleRoot =
    "-----BEGIN CERTIFICATE-----\nROOT\n-----END CERTIFICATE-----";
  const secret = "fixture-secret-value";
  class MockCertificate {
    constructor(pem) {
      this.fingerprint = hash.match(/.{2}/g).join(":");
      this.subject = pem.includes("ROOT")
        ? "CN=Apple Root CA\nO=Apple Inc."
        : `CN=${identity}\nOU=ABCDE12345`;
      this.issuer = "CN=Developer ID Certification Authority\nO=Apple Inc.";
    }
  }
  function spawn(executable, args, options) {
    calls.push({ executable, args, options });
    let stdout = "",
      stderr = "",
      status = 0;
    if (executable === "/usr/bin/security" && args[0] === "find-identity")
      stdout = `1) ${hash} "${identity}"`;
    else if (
      executable === "/usr/bin/security" &&
      args[0] === "find-certificate"
    )
      stdout = args.includes("-c") ? leaf : appleRoot;
    else if (executable === "/usr/bin/codesign" && args.includes("-d"))
      stderr = outcome === "wrong-signature" ? signature.replace(identity, "Developer ID Application: Other (OTHER12345)") : signature;
    else if (executable === "/usr/sbin/spctl" && outcome !== "assessment-failed")
      stderr = `Tableline.app: accepted\nsource=${outcome === "wrong-trust" ? "Unnotarized Developer ID" : "Notarized Developer ID"}` +
        (outcome === "no-origin" ? "" : `\norigin=${outcome === "wrong-origin" ? "Developer ID Application: Other (OTHER12345)" : identity}`);
    else if (executable === "/usr/bin/ditto")
      fs.writeFileSync(
        args.at(-1),
        args.at(-1).includes("final") ? "stapled-zip" : "unstapled-zip",
      );
    else if (args[0] === "notarytool" && args[1] === "submit")
      stdout =
        outcome === "bad-json"
          ? "not-json"
          : JSON.stringify({
              status: outcome === "Invalid" ? "Invalid" : "Accepted",
              id: outcome === "invalid-id" ? "untrusted-text" : submissionId,
            });
    else if (args[0] === "notarytool" && args[1] === "info")
      stdout = outcome === "info-bad-json" ? "not-json" : JSON.stringify({
        id: outcome === "info-wrong-id" ? "22222222-2222-2222-2222-222222222222" : submissionId,
        status: outcome === "info-invalid" ? "Invalid" : "Accepted",
      });
    else if (args[0] === "notarytool" && args[1] === "log")
      stdout = outcome === "log-bad-json" ? "not-json" : JSON.stringify({
        jobId: outcome === "log-wrong-job" ? "22222222-2222-2222-2222-222222222222" : submissionId,
        status: outcome === "log-invalid" ? "Invalid" : "Accepted",
        ticketContents: [{
          path: outcome === "ticket-other-executable" ? "submission.zip/Tableline.app/Contents/MacOS/Helper" : "submission.zip/Tableline.app/Contents/MacOS/Tableline",
          digestAlgorithm: "SHA-256",
          cdhash: outcome === "ticket-other-hash" ? "d".repeat(40) : cdhash,
          arch: outcome === "ticket-other-arch" ? "x86_64" : "arm64",
        }],
      });
    else if (
      (outcome === "staple-failed" &&
        args[0] === "stapler" &&
        args[1] === "staple") ||
      (outcome === "ticket-failed" && args[0] === "stapler" && args[1] === "validate") ||
      (outcome === "assessment-failed" && executable === "/usr/sbin/spctl") ||
      (outcome === "requirement-failed" && executable === "/usr/bin/codesign" && args.includes("-R"))
    ) {
      status = 1;
      stderr = secret;
    }
    return { status, stdout, stderr };
  }
  const mocks = {
    "node:crypto": { ...crypto, X509Certificate: MockCertificate },
    "node:child_process": { spawnSync: spawn },
    "node:os": { ...os, homedir: () => home },
    "./verify-package.cjs": {
      verifyPackage: (bundle, options) => {
        assert.equal(options.arch, "arm64");
        assert.ok(bundle.startsWith(home + path.sep));
        if (outcome === "source-mismatch") throw new Error("Archive source mismatch: dist/index.html");
        return { sourceMatches: true, archiveSha256: outcome === "archive-mismatch" ? "d".repeat(64) : archiveSha256 };
      },
    },
    "./package.cjs": {
      packageMac: ({ identity: selected, outputDir, env, run }) => {
        assert.equal(selected, hash);
        assert.equal(env.CSC_LINK, undefined);
        assert.equal(env.APPLE_PASSWORD, undefined);
        run("mock-builder", [], { env });
        const bundle = path.join(outputDir, "mac-arm64", "Tableline.app");
        fs.mkdirSync(bundle, { recursive: true });
        return { bundle, verification: { sourceMatches: true, archiveSha256 } };
      },
    },
  };
  const module = { exports: {} };
  function mockRequire(name) {
    if (mocks[name]) return mocks[name];
    if (name.endsWith("package.json")) return { version: "0.2.0" };
    return require(name);
  }
  vm.runInNewContext(
    fs.readFileSync(path.join(root, "scripts/release-macos.cjs"), "utf8"),
    {
      module,
      exports: module.exports,
      require: mockRequire,
      __dirname: path.join(root, "scripts"),
      process: { ...process, platform: "darwin", arch: "arm64" },
      Buffer,
      console: { log: (...args) => logs.push(args.join(" ")) },
    },
    { filename: "mock-release-macos.cjs" },
  );
  return { service: module.exports, calls, logs, secret };
}

for (const outcome of [
  "Accepted",
  "Invalid",
  "bad-json",
  "staple-failed",
  "assessment-failed",
])
  test(`notarization outcome ${outcome} gates ticket verification and final archive`, () => {
    const home = fs.mkdtempSync(
      path.join(os.tmpdir(), "tableline-release-test-"),
    );
    try {
      const { service, calls, logs, secret } = loadWithMocks(home, outcome);
      let result, error;
      try {
        result = service.releaseMac({
          env: {
            ...environment,
            API_TOKEN: secret,
            CSC_LINK: secret,
            APPLE_PASSWORD: secret,
          },
        });
      } catch (failure) {
        error = failure;
      }
      const submitted = calls.find(
        (call) => call.args[0] === "notarytool" && call.args[1] === "submit",
      );
      assert.ok(submitted);
      assert.ok(submitted.args.includes("--keychain-profile"));
      assert.ok(!submitted.args.includes("--password"));
      assert.ok(!submitted.args.includes("--force"));
      assert.equal(submitted.options.env.API_TOKEN, undefined);
      assert.equal(submitted.options.env.CSC_LINK, undefined);
      assert.equal(submitted.options.env.APPLE_PASSWORD, undefined);
      const requirementChecks = calls.filter(
        (call) =>
          call.executable === "/usr/bin/codesign" && call.args.includes("-R"),
      );
      assert.equal(
        requirementChecks.length,
        outcome === "Accepted" || outcome === "assessment-failed" ? 2 : 1,
      );
      for (const call of requirementChecks)
        assert.equal(
          call.args[call.args.indexOf("-R") + 1],
          '=anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "ABCDE12345"',
        );
      const finalArchive = calls.find(
        (call) =>
          call.executable === "/usr/bin/ditto" &&
          call.args.at(-1).endsWith("final.zip"),
      );
      if (outcome === "Accepted") {
        assert.equal(error, undefined);
        assert.ok(fs.existsSync(result.zip));
        assert.ok(fs.existsSync(result.checksum));
        assert.equal(result.sourceMatches, true);
        assert.match(
          fs.readFileSync(result.checksum, "utf8"),
          new RegExp(result.sha256),
        );
        assert.ok(finalArchive);
        assert.ok(
          calls.find(
            (call) => call.args[0] === "stapler" && call.args[1] === "validate",
          ),
        );
        assert.ok(calls.find((call) => call.executable === "/usr/sbin/spctl"));
      } else {
        assert.ok(error);
        assert.equal(finalArchive, undefined);
        assert.ok(!error.message.includes(secret));
        if (outcome === "Invalid" || outcome === "bad-json")
          assert.ok(!calls.find((call) => call.args[0] === "stapler"));
      }
      assert.ok(!logs.join("\n").includes(secret));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

test("signed packaging pins identity, disables publishing/automatic notarization, and uses x64 mac output", () => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "tableline-package-test-"),
  );
  try {
    const calls = [],
      module = { exports: {} };
    function mockRequire(name) {
      if (name === "./verify-package.cjs")
        return {
          verifyPackage: (bundle, options) => {
            assert.equal(bundle, path.join(temporary, "mac", "Tableline.app"));
            assert.equal(options.arch, "x64");
            return { sourceMatches: true };
          },
        };
      if (name.endsWith("package.json")) return { version: "0.2.0" };
      return require(name);
    }
    mockRequire.resolve = require.resolve;
    vm.runInNewContext(
      fs.readFileSync(path.join(root, "scripts/package.cjs"), "utf8"),
      {
        module,
        exports: module.exports,
        require: mockRequire,
        __dirname: path.join(root, "scripts"),
        process: { ...process, platform: "darwin", arch: "x64" },
        console,
      },
    );
    module.exports.packageMac({
      identity: hash,
      outputDir: temporary,
      run: (file, args) => calls.push({ file, args }),
      log: () => {},
    });
    const args = calls.at(-1).args;
    assert.ok(args.includes(`--config.mac.identity=${hash}`));
    assert.ok(args.includes("--config.forceCodeSigning=true"));
    assert.ok(args.includes("--config.mac.hardenedRuntime=true"));
    assert.ok(args.includes("--config.mac.notarize=false"));
    assert.ok(args.includes("--publish"));
    assert.equal(args[args.indexOf("--publish") + 1], "never");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

for (const outcome of ["ticket-failed", "source-mismatch", "invalid-id", "wrong-trust"])
  test(`public archive is withheld after ${outcome}`, () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tableline-release-gate-"));
    try {
      const { service, calls } = loadWithMocks(home, outcome);
      assert.throws(() => service.releaseMac({ env: environment }));
      assert.ok(!calls.some((call) => call.executable === "/usr/bin/ditto" && call.args.at(-1).endsWith("final.zip")));
      const output = path.join(home, "Library", "Caches", "Tableline", "releases", "v0.2.0");
      assert.deepEqual(fs.readdirSync(output).filter((name) => !name.startsWith(".")), []);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

test("offline check does not build, sign, submit, or call application crypto", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tableline-release-check-"));
  try {
    const { service, calls } = loadWithMocks(home, "Accepted");
    assert.equal(service.releaseMac({ env: environment, checkOnly: true }).preflight, true);
    assert.ok(calls.some((call) => call.executable === "/usr/bin/security" && call.args.includes("offline")));
    assert.ok(!calls.some((call) => call.executable === "mock-builder" || call.executable === "/usr/bin/codesign" || call.args[0] === "notarytool"));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("Gatekeeper result must establish notarized Developer ID trust for the selected identity", () => {
  const config = { identity, teamId: "ABCDE12345" };
  const accepted = `Tableline.app: accepted\nsource=Notarized Developer ID\norigin=${identity}`;
  gatekeeperAccepted(accepted, config);
  for (const response of [
    "assessments disabled", accepted.replace("accepted", "rejected"),
    accepted.replace("Notarized Developer ID", "Unnotarized Developer ID"),
    accepted.replace(identity, "Developer ID Application: Other (OTHER12345)"),
  ]) assert.throws(() => gatekeeperAccepted(response, config), /did not confirm/);
  const withoutOrigin = `Tableline.app: accepted\nsource=Notarized Developer ID`;
  assert.throws(() => gatekeeperAccepted(withoutOrigin, config), /did not confirm/);
  const bundle = path.join(os.tmpdir(), "Tableline.app"), calls = [];
  const proof = verifySignedBundle((label, executable, args) => {
    calls.push({ executable, args });
    return { stdout: "", stderr: args.includes("-d") ? signature : "" };
  }, bundle, config);
  assert.ok(calls.some((call) => call.args.includes("--strict") && call.args.includes("-R")));
  gatekeeperAccepted(withoutOrigin, config, { bundle, signatureProof: proof });
  for (const invalid of [
    { bundle, signatureProof: {} },
    { bundle: path.join(os.tmpdir(), "Other.app"), signatureProof: proof },
  ]) assert.throws(() => gatekeeperAccepted(withoutOrigin, config, invalid), /did not confirm/);
  assert.throws(() => gatekeeperAccepted(withoutOrigin, { ...config, teamId: "OTHER12345" }, { bundle, signatureProof: proof }), /did not confirm/);
  assert.throws(() => gatekeeperAccepted(`${withoutOrigin}\norigin=Developer ID Application: Other (OTHER12345)`, config, { bundle, signatureProof: proof }), /did not confirm/);
  assert.throws(() => verifySignedBundle((_label, _file, args) => {
    if (args.includes("-R")) throw new Error("Cryptographic requirement rejected");
    return { stdout: "", stderr: signature };
  }, bundle, config), /requirement rejected/);
});

for (const outcome of [
  "Accepted", "no-origin", "info-invalid", "info-wrong-id", "info-bad-json",
  "log-invalid", "log-wrong-job", "log-bad-json", "ticket-other-hash",
  "ticket-other-executable", "ticket-other-arch", "ticket-failed", "source-mismatch",
  "archive-mismatch", "wrong-signature", "requirement-failed", "wrong-trust", "wrong-origin", "assessment-failed",
]) test(`existing notarized bundle finalization ${outcome} reruns all gates without signing or submitting`, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tableline-finalize-test-"));
  try {
    const bundle = path.join(home, "staging", "Tableline.app");
    fs.mkdirSync(bundle, { recursive: true });
    const { service, calls } = loadWithMocks(home, outcome);
    let result, error;
    try {
      result = service.finalizeMac({ env: environment, bundle, submissionId, expectedArchiveSha256: archiveSha256 });
    } catch (failure) { error = failure; }
    assert.ok(calls.some((call) => call.args[0] === "notarytool" && call.args[1] === "info"));
    assert.ok(!calls.some((call) => call.executable === "mock-builder" || call.executable === "/usr/bin/security" ||
      call.args.includes("--sign") || (call.args[0] === "notarytool" && call.args[1] === "submit") ||
      (call.args[0] === "stapler" && call.args[1] === "staple")));
    const finalArchive = calls.find((call) => call.executable === "/usr/bin/ditto" && call.args.at(-1).endsWith("final.zip"));
    const output = path.join(home, "Library", "Caches", "Tableline", "releases", "v0.2.0");
    if (outcome === "Accepted" || outcome === "no-origin") {
      assert.equal(error, undefined);
      assert.ok(finalArchive);
      assert.equal(result.submissionId, submissionId);
      assert.equal(result.archiveSha256, archiveSha256);
      assert.equal(result.cdhash, cdhash);
      assert.ok(fs.existsSync(result.zip));
      assert.ok(fs.existsSync(result.checksum));
    } else {
      assert.ok(error);
      assert.equal(finalArchive, undefined);
      assert.deepEqual(fs.readdirSync(output), []);
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("finalization refuses malformed identity evidence and already published assets before Apple lookup", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tableline-finalize-input-"));
  try {
    const bundle = path.join(home, "staging", "Tableline.app");
    fs.mkdirSync(bundle, { recursive: true });
    for (const args of [{ submissionId: "--other", expectedArchiveSha256: archiveSha256 }, { submissionId, expectedArchiveSha256: "bad" }]) {
      const { service, calls } = loadWithMocks(home, "Accepted");
      assert.throws(() => service.finalizeMac({ env: environment, bundle, ...args }), /valid submission ID/);
      assert.equal(calls.length, 0);
    }
    const first = loadWithMocks(home, "Accepted");
    const released = first.service.finalizeMac({ env: environment, bundle, submissionId, expectedArchiveSha256: archiveSha256 });
    const second = loadWithMocks(home, "Accepted");
    assert.throws(() => second.service.finalizeMac({ env: environment, bundle, submissionId, expectedArchiveSha256: archiveSha256 }), /already exist/);
    assert.equal(second.calls.length, 0);
    assert.equal(fs.readFileSync(released.zip, "utf8"), "stapled-zip");
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("completed release artifacts cannot be overwritten", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tableline-release-exists-"));
  try {
    const first = loadWithMocks(home, "Accepted");
    const released = first.service.releaseMac({ env: environment });
    const bytes = fs.readFileSync(released.zip);
    const second = loadWithMocks(home, "Accepted");
    assert.throws(() => second.service.releaseMac({ env: environment }), /already exist/);
    assert.deepEqual(fs.readFileSync(released.zip), bytes);
    assert.ok(!second.calls.some((call) => call.executable === "mock-builder" || call.args[0] === "notarytool"));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("packaging rejects signaled or timed out children with null status", () => {
  for (const result of [
    { status: null, signal: "SIGTERM" },
    { status: null, error: Object.assign(new Error("fixture timeout"), { code: "ETIMEDOUT" }) },
    { status: 1 },
  ]) {
    const module = { exports: {} };
    function mockRequire(name) {
      if (name === "node:child_process") return { spawnSync: () => result };
      if (name === "./verify-package.cjs") return {};
      return require(name);
    }
    vm.runInNewContext(fs.readFileSync(path.join(root, "scripts/package.cjs"), "utf8"), {
      module, exports: module.exports, require: mockRequire,
      __dirname: path.join(root, "scripts"), process, console,
    });
    assert.throws(() => module.exports.runCommand("fixture-process", []), /Packaging command failed/);
  }
});
