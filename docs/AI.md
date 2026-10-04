# Grounded database assistant

Tableline offers a local guided demo and configurable inference providers. The demo is deterministic and the UI labels it **Demo locale** through `isMock`; it queries the selected database and never invents figures. A local HTTP transport fixture is used for tests. A passing fixture is not proof of access to a live cloud account.

## Providers

| Provider         | Native transport                              | Credentials                                 | Model discovery                                  |
| ---------------- | --------------------------------------------- | ------------------------------------------- | ------------------------------------------------ |
| OpenAI           | Chat Completions, `store: false`              | API key / bearer token                      | `/v1/models`                                     |
| Anthropic        | Messages                                      | API key                                     | paginated `/v1/models`                           |
| Azure OpenAI     | v1 Chat Completions or dated deployment route | API key / Entra bearer token                | enter deployment name; inference test            |
| Google AI Studio | Gemini `generateContent`                      | API key                                     | paginated models with generateContent capability |
| Vertex AI        | Gemini `generateContent`                      | ADC / Google service account / bearer token | enter exact model; inference test                |
| LiteLLM          | OpenAI-compatible Chat Completions            | API key / bearer / explicit none            | configured gateway catalogue                     |
| Bedrock          | native Converse                               | Bedrock API key / SigV4 / named AWS profile | SDK TEXT catalogue and inference profiles        |
| Ollama           | local generate                                | none / configured auth                      | installed local GGUF models, rechecked with show |
| Compatible       | Chat Completions                              | explicit auth                               | configured endpoint catalogue                    |

Endpoints require HTTPS except loopback local endpoints. Redirects, embedded URL credentials, endpoint query strings and URL fragments are rejected. Exact model IDs are preserved; inference failures never silently select another model. Azure deployments and Vertex project access are verified through **Test model**, not inferred from public catalogue entries. Ollama cloud models are excluded from the local provider.

Native references: [OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create), [Anthropic Messages](https://platform.claude.com/docs/en/api/messages), [Anthropic models](https://platform.claude.com/docs/en/api/models/list), [Google generateContent](https://ai.google.dev/api/generate-content), [Vertex AI](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/start/quickstart), [Bedrock Converse](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html), [Ollama generate](https://docs.ollama.com/api/generate).

## Read flow

Nothing is queried or transmitted by constructing the assistant. An explicit **Ask** discovers the selected connection's schema, then sends bounded metadata and the question to the visible selected provider destination. The model returns a single JSON decision. Tableline requests JSON mode on compatible chat transports, JSON MIME output on Gemini and JSON output on Ollama. Inference tests use a separate brief plain-text prompt. Assistant decisions receive an 8,192-token completion budget, including reasoning tokens; LiteLLM uses `max_completion_tokens` so recent GPT backends can accept the request. A provider-reported token limit fails before further database dispatch. It can request protected SQL reads or validated MongoDB/Redis JSON read commands; the backend applies an independent assistant guard and the database policy, sets a 100-row limit, and sends bounded results back as evidence. Up to four tool operations and one final response are allowed. The UI receives SQL, rows, query steps, destination metadata and whether the response is a mock. A malformed JSON response allows one format-only regeneration for the entire question, pinned to the same exact model. The invalid response is neither extracted nor executed. The parser and all read/write guards still apply; network failures, invalid tools, blocked SQL and failed write previews are not retried.

Schemas, history, row values and database errors are encoded as untrusted data. Embedded instructions do not grant write permission, change the selected connection or expose credentials. Code rejects unknown tools and does not give models filesystem, network, command execution or credential tools. LLM-generated prose can still be incorrect; inspect the attached SQL and results. The backend explicitly marks whether a final answer has query evidence. Failed queries cannot produce an invented success answer.

The provider context is capped at 48 KB. Schema, history and row evidence have smaller individual caps; truncation is explicit. The full bounded result returned to the UI may contain more rows than the model saw. A truncated result size is not a total count. Use COUNT or another aggregate for totals. If the final evidence is a non-truncated empty result or a recognized direct scalar COUNT(*)/COUNT(1) of zero, Tableline scopes the answer to that query and asks the user to check the filter. A guessed category with no matches does not establish that the requested concept is absent. This narrow check does not reinterpret nullable-column counts, sums, percentages or arbitrary SQL.

## Write flow

Both **Write mode** and an explicit human mutation request are required to prepare a write. The assistant accepts a single INSERT, UPDATE or DELETE proposal. UPDATE and DELETE require WHERE. For MongoDB it accepts insertOne/updateMany/deleteMany with discovered collections and nonempty update/delete filters; for Redis it accepts a small explicit write-command allowlist. The same database review flow applies. DDL, administrative commands, batches, write CTEs, MongoDB JavaScript/$out/$merge and Redis EVAL/FLUSHALL are rejected.

The assistant calls `database.prepareWrite` and returns its review proposal. It has no commit tool and never calls `commitWrite`. The user reviews SQL, parameters, preview and affected rows, then confirms through the separate database write flow. SQLite executes and rolls back its preview; returned row values are available when the statement includes `RETURNING`. Remote SQL previews never execute the mutation: simple UPDATE/DELETE statements read the matching rows, and commit checks their fingerprint in a serializable transaction. Remote INSERT previews do not estimate an affected count. Remote SQL commits enforce a 5,000-row cap. MongoDB and Redis show estimated matches or current key metadata without rollback; multi-document or multi-command outcomes can be partial. Every preview remains a pending proposal until the user confirms.

## Local demo

The guided demo supports actual counts, pending orders, distribution by status, paid/shipped revenue by currency and country, top customers and bounded order-status proposals. Currency groups remain separate. It does not convert currencies or invent an exchange rate. MongoDB and Redis explicitly decline guided demo analysis. Freeform analysis on other schemas requires a configured inference provider; unsupported questions return a short explicit explanation.

## Credential storage

Profile configuration contains public metadata only. AI credentials use `ai-<profile ID>` and database credentials use `db-<connection ID>` in the same encrypted vault. Electron safeStorage protects persisted values; unavailable encryption and the Linux `basic_text` backend fail closed. There is no plaintext fallback. A browser QA MemoryVault keeps values only in memory. Saving and removing an AI profile cannot overwrite or delete database credentials with the same public ID.

The vault uses only Electron's asynchronous `isAsyncEncryptionAvailable`, `encryptStringAsync` and `decryptStringAsync` APIs, following the [official safeStorage guidance](https://www.electronjs.org/docs/latest/api/safe-storage). Each operation has an eight-second caller deadline. This deadline does not cancel native OS work: version 0.1.1 keeps one shared native queue alive until the OS work settles, coalesces availability checks and blocks further native calls after the first timeout until Tableline is restarted. A late native response cannot persist a timed-out save or remove that block. `runtime.info` reads a passive cached status and never initializes the keychain. Metadata checks and profiles with no stored secrets remain available. There is no automatic retry or plaintext fallback. Concurrent saves use atomic file replacement; key rotation cannot overwrite a newer save or restore a deleted credential.

Errors and provider output redact known credential values and private keys. Service-account imports reject external-account/executable credential configuration and non-Google token endpoints. Configuration import parses JSON/environment files as data; it does not evaluate shell expressions.

## Service contracts

`AIService({vault, file, fetch?, googleAuth?, bedrock?, bedrockModels?, awsCredentialProviders?})` exposes `getConfig`, `saveProfile`, `selectProfile`, `removeProfile`, `discoverModels`, `test`, `providerDestination` and `generate`. Branchline aliases `settings`, `save`, `activate`, `remove` and `models` remain available. Profiles and credentials are separate arguments, or `saveProfile({profile, credentials})`.

`AssistantService({ai, database}).ask({connectionId, prompt, profileId?, mode: 'read' | 'write', history?})` returns `{answer, sql?, result?, proposal?, steps, provider, isMock, evidence?, grounded?}`. Select `profileId: 'demo'` explicitly for the guided local demo. Saving and activating a configured provider also selects it on the demo database; profiles without an exact model cannot be selected for inference. Endpoint or authentication changes clear stale model discovery results. Schema-only answers carry no query-grounding claim.

## Validation boundaries

Unit tests exercise all provider transports with synthetic fetch/SDK responses; they cover auth routing, exact model IDs, discovery, encrypted persistence, namespace separation, endpoint policies and redaction. Assistant tests cover explicit asks, bounded loops, prompt-injection boundaries, read/write separation, proposal-only behavior, SQL escape attempts, truncated evidence, grounded failures and demo results. End-to-end tests use the real Electron app, SQLite demo and a separate local HTTP provider fixture. No cloud provider account, deployment, quota, latency or live permissions are claimed by these fixtures. Separately supervised live LiteLLM acceptance on synthetic SQLite data is recorded in [the AI validation report](AI_VALIDATION.md); its results apply only to the tested gateway aliases and date.

Vault tests additionally verify asynchronous roundtrips, availability/encryption/decryption timeouts, no late writes, concurrent setters across vault instances, Linux plaintext-backend rejection and key-rotation races. The complete unit-test output is saved in `artifacts/unit-tests.txt`.

Version 0.1.1 adds call-count assertions for repeated attempts after timeout across profiles and files, passive status reads, native serialization, late approvals and metadata access during the block. These are mock-only tests and do not open macOS permission dialogs. Default desktop QA also guards native credential APIs against invocation; a supervised real credential run requires explicit `TABLELINE_E2E_CREDENTIALS=1`.

Production dependencies were upgraded to Databricks 2.2 with patched `basic-ftp` and dual CommonJS/ESM `uuid` overrides. `artifacts/npm-audit-production.json` records zero known production findings at the verification time; `npm-audit-all.json` separately records residual development-only HTTP cache advisories for which the registry currently provides no patched release.
