# Public release procedure

The public source repository is [Hexecu/tableline](https://github.com/Hexecu/tableline). Release binaries, source checks and live-account acceptance are separate evidence. This procedure is for maintainers; completion is recorded in each GitHub release's notes and [validation](VALIDATION.md).

## Review the source

1. Confirm the version in `package.json` and `package-lock.json`, `GPL-3.0-only` metadata, the complete GPLv3 text in `LICENSE`, the notice in `COPYRIGHT` and historical Branchline attribution. Do not reuse an earlier MIT release tag or replace its artifacts; the first GPL binary must have a new version after v0.2.0.
2. Review the staged source and all history being published for credentials, personal paths, proprietary fixtures and local incident logs. Exclude `artifacts/`, `.env*`, app data, databases, build caches and signing material. Public source must contain only synthetic fixtures.
3. Run `npm ci`, `npm test`, `npm run test:i18n`, `npm run build` and `node scripts/e2e-locales.cjs`. Unit and locale desktop QA must not invoke native credential APIs.
4. Run `npm audit --omit=dev` and `npm audit`; report development-only findings separately. Inspect dependency licenses and retain distributed notices. Do not use a forced downgrade as evidence that an advisory is patched.
5. Run the real-server fixture checks for database code changes. Record which engines use actual servers, which use transport contracts and which require live cloud acceptance.

CI uses read-only repository permissions, immutable action commit IDs, a fresh checkout without persisted credentials, Node 22/24 and macOS/Linux runners. It builds and tests; it does not sign, notarize or publish from pull-request code. Ordinary CI excludes real keychain acceptance, real cloud credentials and production databases.

## Build and verify a distribution

`npm run package` produces an unpacked application directory, using `TABLELINE_RELEASE_DIR` when set. On macOS, `TABLELINE_SIGN_IDENTITY` can select an existing signing identity; otherwise packaging uses ad-hoc signing. Private signing credentials must never be committed or printed. The gated `npm run release:check` and `npm run release:macos` commands, required existing notary profile and artifact paths are documented in [MACOS.md](MACOS.md).

Check the actual application's version and architecture, deep/strict signature integrity and bundled license notices. Compare packaged production files with the source snapshot. Launch that exact bundle with disposable application data and verify demo operations, locale persistence and the write-review boundary. Locale QA may use `TABLELINE_E2E_EXECUTABLE` to target the bundle.

The broader desktop suite deliberately reports native credential acceptance as excluded by default and exits nonzero. A separate supervised `TABLELINE_E2E_CREDENTIALS=1` run may open an OS authorization prompt. Do not repeatedly retry an outstanding native request; after a timeout the app blocks further native calls until restart. A fixture or guarded locale run does not establish native credential authorization.

macOS notarization is a separate maintainer step. A locally signed build alone is not a notarized release. When a release is advertised as notarized, verify the notarization result, staple the ticket, validate it and assess Gatekeeper on the final artifact. Do not instruct users to bypass Gatekeeper. Linux and Windows distributions require their own packaging, credential and desktop acceptance checks before being advertised as supported downloads.

## Publish the reviewed artifact

Archive the exact verified app, produce a SHA-256 checksum and test an extracted copy. Avoid repackaging after verification. Attach the binary and checksum to a versioned GitHub release linked to the reviewed source commit. At the same download location, provide equivalent access to the complete Corresponding Source for that exact binary, including the dependency lockfile, build scripts and instructions; clearly link the exact tag/source archive in the release notes. A link to a moving branch is insufficient. Confirm that the tagged source rebuilds the distributed version and that any additional source required by bundled dependencies is accessible with its applicable notices. Release notes must identify `GPL-3.0-only`, platform/architecture, signature/notarization evidence, language coverage, checks performed and material limitations.

Download the published archive, verify its checksum, extract it and inspect its version/signature again. Upload success alone does not prove that the public asset is correct. Do not claim cloud integration acceptance, secure-storage acceptance, universal database coverage or an SLA based on local fixtures.

## First GPL binary dependency sources

Before publishing the first GPL binary after v0.2.0, review the exact native dependency sources as well as Tableline's tagged archive. The current Databricks native kernel package contains a compiled `.node` without a public exact-version source pointer; its presumed source repository was unavailable during the 0.2.1 audit. An npm tarball containing only compiled native code does not establish its Corresponding Source. Resolve that source, or remove the native component and validate the supported fallback, before public binary distribution. Keep runtime and other dependency sources pinned and accessible beside the download. Do not silently add a GPL exception or replace historical MIT assets to work around this requirement. A signed local build and a published source fix are separate from a public binary release.
