# Desktop platform verification

Tableline 0.2.2 targets six native desktop combinations. Compatibility is tied to a named OS, CPU and tested application package; it is not a guarantee for every operating system, processor or database deployment.

| Platform | CPU | Native CI system |
| --- | --- | --- |
| macOS | Apple Silicon / arm64 | macOS 15 (`macos-15`) |
| macOS | Intel / x64 | macOS 15 Intel (`macos-15-intel`) |
| Linux | x64 | Ubuntu 24.04 |
| Linux | arm64 | Ubuntu 24.04 ARM |
| Windows | x64 | Windows Server 2025 |
| Windows | arm64 | Windows 11 ARM |

Electron 44.5.1 requires macOS 13 or later and supports 64-bit desktop targets. The runtime's [versioned platform requirements](https://github.com/electron/electron/blob/v44.5.1/README.md) are a minimum; the table identifies the systems actually exercised by CI. Linux packages use glibc and a graphical desktop. Alpine/musl, 32-bit systems, FreeBSD and old unsupported OS releases are outside this matrix. Windows Server CI does not establish every Windows desktop build or enterprise policy configuration.

## Required checks

Each native lane asserts its own `process.platform` and `process.arch`, installs the locked dependencies, runs the source tests and builds an unpacked application on that target. The package verifier checks executable architecture, complete application/source matching, GPL metadata and the exact Electron/Chromium notices from that OS/CPU's checksum-verified upstream archive.

The packaged desktop suite opens that exact executable with temporary application data. It exercises the renderer/preload/IPC boundary, native Ctrl/Cmd hints, real SQLite utility processes, Unicode paths and parameters, write previews that preserve rows, exports, production database/provider module imports, a real native LZ4 compression roundtrip and Databricks SDK backend selection. Separate packaged suites exercise all five languages and AI configuration against a synthetic loopback provider. No production database or LLM account is used in CI.

Reports identify the target, source/package verification and individual checks. CI uploads reports, then removes the temporary compiled application. It does not publish installers, import signing credentials or submit notarization requests. A green source-only job or a cross-compiled binary alone is insufficient platform acceptance.

## Credential storage

Linux and Windows acceptance uses synthetic credentials and temporary application data. Linux creates a disposable DBus/Secret Service session with GNOME Keyring; Windows uses its actual OS encryption APIs. Tests require encrypted roundtrips across application reload, rejection of corrupted ciphertext and no synthetic plaintext in application/keyring files. An unavailable secure backend is an explicit failure, never a plaintext fallback.

macOS native credential authorization is supervised separately because CI ad-hoc signing does not establish access for the installed Developer ID identity. Package fixtures forbid credential calls. The installed 0.2.1 signed-app LiteLLM acceptance is recorded in [AI_VALIDATION.md](AI_VALIDATION.md); it does not certify every Mac keychain configuration. A locked, absent or administratively restricted keyring can still prevent saving credentials on any supported target.

## Database boundaries

Driver imports and fixture protocols establish package/runtime compatibility. Real PostgreSQL, MySQL/Aurora, SQL Server, MongoDB, Redis, ClickHouse and cloud authentication still require deployment-specific acceptance. Network access, certificates, permissions and server versions are separate from OS/CPU compatibility.

Databricks uses the supported JavaScript Thrift backend. Distribution packages deliberately exclude the optional experimental native kernel. Warehouses that require SEA/Reyden return an explicit unsupported-warehouse message; they are outside this build's supported database deployments. The normal Thrift backend is tested in the real packaged Electron process. The connector's [backend reference](https://github.com/databricks/databricks-sql-nodejs/blob/main/CONNECTION_PARAMETERS.md) distinguishes these implementations.

## Building and distributing

Run `npm ci`, `npm test`, `npm run build` and `npm run package` on the desired native system. Set `TABLELINE_RELEASE_DIR` to choose an output directory. Run the workflow's packaged acceptance commands against that directory; they need a display on Linux. Ad-hoc Mac packages are local verification builds. Developer ID releases retain hardened runtime and require the signature/notarization checks in [MACOS.md](MACOS.md).

Packaging, runtime acceptance, installer trust and public distribution are separate steps. Windows Authenticode, macOS notarization, Linux desktop integration and native keyring policy must be reviewed for a release. New public binaries must include access to the exact GPL corresponding sources and must not replace historical MIT release assets. See [PUBLIC_RELEASE.md](PUBLIC_RELEASE.md).
