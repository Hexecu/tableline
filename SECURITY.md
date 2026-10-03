# Security policy

## Reporting

Report vulnerabilities privately using [GitHub's private vulnerability reporting](https://github.com/Hexecu/tableline/security/advisories/new). Include a minimal reproduction with synthetic data, the affected version/platform, expected boundary and observed result. Do not publish credentials, database contents or an exploit against someone else's system in an issue.

If private reporting is unavailable, open a public issue requesting a private contact without disclosing the vulnerability or sensitive data. The project has no guaranteed response time or security support SLA. Maintainers prioritize the latest release; fixes are not promised for older versions.

## Boundaries

- Electron uses renderer sandboxing, context isolation, no Node integration, a restrictive CSP and a main-process IPC allowlist that verifies sender, frame and arguments.
- Database/provider secrets are stored in a namespaced vault encrypted by Electron safeStorage. Missing secure storage and Linux `basic_text` are rejected; there is no plaintext fallback. OS authorization can still require user interaction.
- Database profiles default to read-only. Reads pass an independent query policy and server-side read-only transactions where supported. Use a least-privilege database principal, particularly for SQL Server, which has no transaction READ ONLY setting.
- Every write uses a server-generated, expiring, single-use proposal. The assistant cannot commit it. MongoDB/Redis operations may be partial; remote commit acknowledgements can be lost. Review the driver-specific behavior before writing important data.
- Remote AI endpoints require HTTPS, with HTTP allowed only on loopback. Redirects and embedded URL credentials are rejected. A configured provider receives bounded schema/history/results after an explicit assistant question; see [privacy](docs/PRIVACY.md).

The application does not attempt to protect against a compromised OS, a compromised database/provider, or a person with control of the local application files. Query results may contain sensitive data, and model prose may be incorrect.

## Dependency audit

Run `npm audit --omit=dev` to assess the production dependency graph and `npm audit` to assess the entire toolchain. A production-only clean result does not clear development dependencies.

At the public preparation audit on 4 October 2026, production dependencies had zero reported findings. The full audit had eight high-severity dependency-path findings stemming from [GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp) in `http-cache-semantics`, reached through electron-builder's download/cache tooling. The registry's latest release, 4.2.0, remained affected. An npm downgrade suggestion is not a patched release. These findings remain open; they are not shipped as application runtime packages. Recheck the lockfile and advisories for each release.
