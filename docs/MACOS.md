# macOS packages and public releases

The initial public target is **macOS on Apple Silicon (arm64)**. Intel macOS,
Windows and Linux have local packaging configuration, but they are not verified
public downloads. A passing local build is not evidence of notarization.

Tableline keeps the bundle identifier `local.tableline.desktop`, product name
`Tableline` and the existing encrypted credential identity. Changing these when
releasing an update can break existing Keychain access. The application does not
initialize encrypted credential storage merely to report its status; repeated
native requests stop after the first timed out operation until the app restarts.

## Local package

Use Node.js 22.13 or later and the locked dependencies:

```sh
npm ci
npm test
npm run build
npm run package
```

On macOS the package command builds outside the checkout, under
`~/Library/Caches/Tableline/build/v<version>`. Override the output directory with
`TABLELINE_RELEASE_DIR` if required. The default macOS package has an ad-hoc
signature and is for local development. An installed Developer ID identity can
be selected with `TABLELINE_SIGN_IDENTITY`; this still does not notarize or
publish the app. Windows and Linux outputs are unpacked local application
directories, not installers or signed public artifacts.

`npm run verify:package -- /path/to/Tableline.app` checks the entire code/resource
signature, executable architecture, sealed ASAR header, stable app identifier, matching source/build/app
versions, packaged icon, MIT license/notices and all five language catalogs.
Every source file under `electron`, `dist`, `assets` and `locales` must match its
packaged SHA-256 hash. Verification never launches the app or accesses its
credential store. Freeze these source files while building and verifying.

## Developer ID and notarization

The owner must first install an Apple-issued **Developer ID Application**
certificate and configure an existing `notarytool` Keychain profile. The scripts
do not import certificates, accept passwords/private keys, change Keychain ACLs,
or create authentication profiles. Use non-secret identity and profile names:

```sh
export TABLELINE_SIGN_IDENTITY='Developer ID Application: Your Name (TEAMID1234)'
export TABLELINE_NOTARY_PROFILE='your-existing-keychain-profile'
npm run release:check
npm run release:macos
```

The `--check` command is offline: it locates release tools, matches exactly one
installed signing identity, verifies the Apple certificate chain and Team ID,
and checks configuration. It reads public certificates only. It does not sign,
build, submit to Apple or authenticate the notarization profile. Profile
authentication is checked during submission.

The release command uses a fresh build directory and the pinned certificate
fingerprint, enables hardened runtime and a secure Apple timestamp, and disables
electron-builder's automatic publishing and notarization. Signing grants only
Electron's required `allow-jit` entitlement; device permissions and disabled
library validation are not requested. Finder/resource-fork metadata is removed
only from the generated bundle before signing; quarantine and all other
attributes remain untouched.

Apple must return **Accepted** with a valid submission ID. The app's ticket must
then be stapled and validated, the packaged source must still match the frozen
checkout, the Developer ID signature must pass strict verification, and
Gatekeeper must accept it as `Notarized Developer ID` with the selected identity.
Disabled assessment or manually granted trust does not satisfy this gate.
Only after all these gates pass is the stapled app
archived as:

```text
~/Library/Caches/Tableline/releases/v<version>/
  Tableline-<version>-mac-arm64.zip
  Tableline-<version>-mac-arm64.zip.sha256
```

Completed archives and checksums are published locally without overwriting
existing artifacts. A rejected submission, failed ticket, invalid signature,
source mismatch or Gatekeeper rejection produces no final distributable. The
signed staging app may remain for diagnosis. The release command does not upload
anything to GitHub; the owner publishes verified assets separately to
[`Hexecu/tableline`](https://github.com/Hexecu/tableline).

## Verification boundaries

Release regression tests use synthetic certificates, processes and submission
responses. They verify rejection gates, redacted output, environment isolation,
no overwrite, and failure of signaled/timed out child processes. They are not
evidence that a particular artifact is Apple-approved; record the actual
submission, stapler and Gatekeeper output for each release.

Desktop QA disables native credential acceptance by default and asserts no
safeStorage calls. `TABLELINE_E2E_CREDENTIALS=1` is a separate supervised opt-in
that may open macOS Keychain dialogs. Signing and notarization do not prove live
database or LLM credentials work. Never put secrets in release logs or source.

The release/signing strategy is adapted from Branchline under MIT; attribution
is retained in `THIRD_PARTY_NOTICES.md`.
