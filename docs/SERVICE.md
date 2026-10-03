# Local operation and recovery

[Italiano](SERVICE.it.md)

Tableline is a local application. It has no hosted database service, telemetry or synchronization, and makes no service SLA or universal-provider reliability claim.

## Operational limits

- Grid pages contain 50/100/250/500 rows; editor results are capped at 1,000 rows. Query and browse results are limited to 10 MiB, and supported drivers have a 30-second operation deadline. Schema introspection uses adapter-specific metadata limits.
- SQLite runs in a dedicated child process. Cancellation actually stops a blocked query and recreates the connection for the next request. Remote drivers have different cancellation support.
- Operations are serialized per connection. Profile and encrypted-vault writes are atomic; a single desktop instance owns the normal data directory.
- Write reviews are bounded, short-lived, single-use and held in memory. They do not survive a restart or retry automatically after a network error. Remote SQL commits are capped at 5,000 affected rows.
- Redis browse cursors expire after five minutes and retain excess keys returned by SCAN. Narrow searches beyond 10,000 keys. JSON COUNT is capped at 1,000 and remains a Redis hint rather than a strict server-result limit.
- DDL, stored procedures, arbitrary SQL functions, bulk import and backup/restore are outside the supported query surface. Rejected statements produce a visible error.
- SQL drafts preserve up to 16 tabs for each of the last 16 connections, 256,000 characters per tab and 2 MiB overall. Older connections can be evicted with a notice. Explicitly save important queries. A storage-quota failure preserves the previous draft archive.

## Local data

On macOS the normal directory is `~/Library/Application Support/Tableline/`. It contains connection/provider metadata, encrypted credentials and the SQLite demo. Renderer storage holds preferences, SQL drafts, history and saved queries, which may contain private query text. On other systems Electron uses the platform's application-data directory.

Back up the complete directory while the app is closed. Remote databases require their own backups. Keep credentials in the dedicated fields rather than query text. The encrypted vault requires the operating-system protection of the original account; copying its file alone does not guarantee decryptability on another machine.

Native keychain operations are serialized. After an eight-second deadline the process blocks further native credential requests until the app restarts. Passive status does not open the keychain. Demo, metadata and profiles without secrets remain usable, and late approval cannot persist a secret from an expired save. Unavailable secure storage never permits plaintext persistence.

## Recovery

A query error leaves the editor available. Fix the statement and run it again; results and history are isolated per tab. Cancelling SQLite stops its worker and restores the connection on the next operation.

Drafts save after 350 ms and before changing connections or quitting. A failed connection leaves the previous editor intact. Shutdown interrupts SQLite/Redis reads, waits for current database operations and bounds each subsequent driver disconnection to five seconds. A Redis write that exceeds 30 seconds has an uncertain acknowledgement and is not retried.

On macOS an owned helper may terminate its own app after two seconds if native keychain work remains pending. It is armed only after database closure and verifies the parent's executable identity and start time to avoid acting on a reused PID.

A network error after a commit is not proof of rollback. Perform a targeted read to determine the outcome, then prepare another review if needed. Tableline never automatically retries a write.

## External account acceptance

Before using important data, verify connectivity, schema, a limited read and the server principal's permissions. Actual remote-account TLS, network access, provider inference and native credential authorization require separate acceptance. The local fixtures and public CI do not establish those external permissions. Review the query and available backups before approving a real write.
