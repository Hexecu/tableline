# Data handling

Tableline is a local database client. There is no Tableline account, hosted relay, telemetry, analytics or automatic crash-upload service. There is no automatic updater. GitHub downloads and issue reports are subject to GitHub's own policies.

## On your computer

Connection and AI profile metadata, the encrypted credential vault and the SQLite demo are stored in Electron's application-data directory. On macOS this is `~/Library/Application Support/Tableline/`. Preferences, language choice, SQL drafts, query history and saved queries use local renderer storage. Exported CSV/JSON files are written to the path you choose. Those files and saved SQL can contain private data.

Secrets supplied in dedicated credential fields are encrypted through Electron safeStorage and stored separately from metadata. OS security facilities vary by platform. An unavailable backend is rejected, including Linux `basic_text`; no plaintext fallback is used. Credentials are used in the main process and can exist in memory while connecting to a database/provider. Native credential acceptance is outside ordinary CI coverage.

Removing a profile removes its associated stored credential entry, but does not delete database records, exported files, operating-system backups or copies you made. To remove all local application data, close Tableline and remove its application-data directory using your operating system's file manager. This also removes local drafts, saved queries and the demo; back up anything you need first. Remote database backups and deletion remain your responsibility.

## Database connections

Connecting, testing a connection, loading schema, browsing and running queries communicate directly with the chosen database endpoint. Driver libraries may perform protocol negotiation and metadata requests. A saved connection can be restored when you use the workspace. Tableline does not proxy traffic through a maintainer-controlled service.

Use dedicated credential fields rather than secrets embedded in SQL. TLS verifies remote certificates when enabled, and a profile can explicitly disable TLS for local fixtures. Server permissions remain authoritative. Synthetic test fixtures are separate from normal application data.

## AI providers

Selecting or editing profile metadata does not send database rows to a model. Discovering models and testing a provider contact the endpoint you configured; a model test sends a small test prompt. Cloud credential SDKs can contact their authentication services, and named AWS profiles or Google ADC use your local account configuration.

When you ask an assistant question, the selected provider can receive the question, bounded schema metadata, recent bounded question history, bounded query results and sanitized error context. Up to four bounded data reads are permitted. The visible destination and model identify where the request goes. Provider retention, training, billing, regional processing and logging depend on that provider and your agreement with it. Tableline's OpenAI adapter uses `store: false`; this does not override a provider's other retention policies.

The deterministic local demo has no LLM provider traffic. Local Ollama and compatible endpoints can keep inference on your computer when configured on loopback; a remote gateway can forward data elsewhere. A local URL alone does not establish the gateway's downstream policy.

Read mode cannot prepare a write. Write mode can prepare a proposal only after an explicit mutation request, and the user must separately confirm it. The assistant has no credential, filesystem, shell or write-commit tools. Database rows and schema are untrusted input, and model text can still be inaccurate.

## Reports and screenshots

Public bug reports, screenshots, exported query results and logs may reveal schema, SQL, hostnames or business data even when passwords are redacted. Reproduce problems with synthetic data. Remove secrets, personal identifiers and proprietary data before sharing. Security issues should use [private reporting](../SECURITY.md).
