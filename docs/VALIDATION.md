# Validation

Tests distinguish application behavior, synthetic fixtures, actual server access and external account acceptance. A green build does not establish permission to a user's database or cloud account.

## Public preview 0.2.0

The public preview adds five complete UI languages (English, Italian, French, German and Spanish), persistent language switching, locale-aware formatting, localized guided assistant responses and guarded macOS distribution tooling. Language changes preserve SQL, identifiers, model IDs, data values and existing workspace state.

The checked local server fixtures are PostgreSQL 16, MySQL 8.4, Redis 7, MongoDB 8 and ClickHouse 25.8. They use disposable containers, synthetic records and loopback ports. PostgreSQL/MySQL tests exercise schema and keys, pagination, Unicode filtering, injection rejection, nonexecuting write preview, concurrent-row rejection, explicit commit and discard. Redis/MongoDB/ClickHouse checks exercise native commands, bounded reads and adapter policies. These are server tests, not access evidence for Aurora, Databricks or another cloud account.


## Local source results for 0.2.0

The frozen source was checked on Apple Silicon macOS with Electron 44.5.1 and 517 messages in each of the five locale catalogs:

| Check | Observed result |
| --- | --- |
| Unit tests | 232 passed; 0 failed; 2 opt-in database tests skipped |
| Catalog audit | 5 passed, included in the unit total |
| Locale desktop checks | 35 passed; no renderer errors; zero native credential API calls |
| Broad desktop checks | 17 passed; 1 native credential acceptance path excluded; nonzero overall exit |
| SQL draft restoration desktop checks | 4 passed |
| Actual PostgreSQL/MySQL servers | 2 passed in a separate opt-in run |
| Actual MongoDB/Redis/ClickHouse servers | 3 passed |
| Desktop access to MongoDB/Redis/ClickHouse | 3 passed |
| Build and production dependency audit | Passed; zero production advisories |

A separate synthetic SQLite benchmark checked 100,000 rows and ten ordered pages: 100-row page latency was 0.92–2.08 ms (median 1.55 ms), Unicode filtering 87.97 ms and aggregation 23.77 ms. These local backend measurements do not establish UI or production latency. Reproduce with `node scripts/benchmark.cjs`.

Signing and packaged-app checks are recorded separately in the versioned release notes. Native credential acceptance and live cloud/provider accounts are not established by these results.

## Reproduce the checks

```sh
npm ci
npm test
npm run test:i18n
npm run build
npm run test:e2e:locales
node scripts/e2e-drafts.cjs
npm run test:e2e
```

On a headless Linux host run desktop checks with `xvfb-run -a`. `npm run test:e2e` deliberately returns nonzero while its native credential acceptance check is excluded; read the report and distinguish `blocked` from `failed`. It must not be turned into a green CI check with `|| true`. The separate locale desktop suite requires every tested path to pass.

Default desktop QA rejects native credential API calls and asserts zero calls; it does not emulate encryption. Native secret persistence requires an explicitly supervised `TABLELINE_E2E_CREDENTIALS=1` run and can open an OS authorization window. Ordinary release checks and locale QA do not perform that test. A local HTTP provider fixture proves transport and discovery behavior, not the quality or availability of a live model.

The vault has mock coverage for namespace separation, atomic persistence, credential rotation, concurrent callers, shared native serialization, deadlines, late approvals, and metadata access after a timeout. After an eight-second native deadline the app blocks further native credential calls until restart. Passive runtime status never initializes native encryption. No plaintext fallback is permitted.

Release pipeline tests simulate signing/notarization failures and verify that rejected submissions, invalid identity, missing hardening/timestamp, unstapled tickets, source mismatches and non-notarized Gatekeeper results cannot produce a final release ZIP. Actual release notarization is checked separately; see [macOS distribution](MACOS.md).

```sh
TABLELINE_DB_INTEGRATION=1 node --test tests/database-integration.test.cjs
docker compose -f fixtures/compose.yaml up -d
node scripts/integration-extras.cjs
node scripts/e2e-fixtures.cjs
docker compose -f fixtures/compose.yaml down -v
npm audit --omit=dev
```

The ClickHouse desktop fixture has an empty password so this isolated loopback-only QA does not request the OS keychain. It is synthetic test infrastructure, not a production configuration.

## Security and remaining acceptance

The renderer is sandboxed with context isolation, no Node access, a restrictive CSP and blocked external navigation. Main-process IPC validates the exact trusted window/frame/document, method allowlist and bounded input. Credentials remain outside renderer profiles. Query results have row and byte limits; writes use short-lived service-generated single-use review IDs. The assistant cannot commit a proposal.

The production dependency audit recorded zero advisories on 4 October 2026. The complete tooling tree reports eight high findings from the unpatched `http-cache-semantics` advisory [GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp). That tooling audit is not clean. Dependency licenses and public source/history scans are reviewed before publishing; generated reports and user data are excluded from Git.

Live database account permissions, remote TLS/network conditions, cloud LLM inference and the native credential authorization flow remain separate acceptance work. Windows/Linux distributions, Intel macOS binaries, automatic updates, SSH tunnels, database IAM/OAuth, bulk import, DDL and backup/restore are not certified by the initial Apple Silicon preview. There is no service SLA.

Local detailed logs are written under ignored `artifacts/`. Public release notes record the final test totals, distribution checksum and tested platform; GitHub Actions supplies reproducible public CI evidence.
