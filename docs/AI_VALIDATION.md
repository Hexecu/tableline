# LiteLLM assistant validation for 0.2.1

On 4 October 2026, the configured LiteLLM gateway was tested with exact aliases returned by its own model catalogue. Tests used a new synthetic Commerce SQLite database, not a user database. Credentials were read through the existing signed app identity and remained only in process memory; public reports exclude credentials, gateway addresses and local account paths.

## Reproduced failures

The screenshot's Gemini failure was reproduced after one successful read: the next response used JavaScript-style unquoted object keys. The old system prompt included that invalid example and requested JSON only in prose. A separate response-limit path appended a warning to structured output. Recent GPT backends also rejected LiteLLM requests using `max_tokens`, requiring `max_completion_tokens`. Configuring a provider on the demo connection did not reliably select it for the assistant. Repeated live checks also exposed a valid SQLite `LIKE … ESCAPE '\'` query being rejected by both SQL guards. The guards now apply SQLite's actual single-quote rules for the configured SQLite dialect; other dialects retain their stricter backslash policy, and injected statement separators remain blocked.

The revised flow uses valid JSON examples, provider JSON output controls, a separate model-test prompt and an 8,192-token assistant completion budget. Truncation fails before dispatch. One malformed response permits one same-model format regeneration per question; the strict format instruction then persists through later rounds. Malformed content is not extracted, executed or forwarded. Network failures, blocked SQL and write previews are not retried.

## Live model cases

Each alias was checked for plain model inference, the original Italian question, an explicit count/stock question and a write proposal. Exact configured model IDs were preserved.

| Gateway alias | Explicit name count and stock | Write proposal | Original ambiguous wording |
| --- | --- | --- | --- |
| `gemini-3.5-flash` | 3 products, 182 units | Preview only | 3 products |
| `gpt-5.6-luna` | 3 products, 182 units | Preview only | 3 products |
| `gpt-5.5` | 3 products, 182 units | Preview only | 3 products |
| `global-claude-sonnet-5` | 3 products, 182 units | Preview only | 3 products, category distinction |
| `claude-opus-4.6` | 3 products, 182 units | Preview only | 3 products after bounded format repair |
| `gemini-3.1-pro-preview` | 3 products, 182 units | Preview only | 3 products |
| `qwen3-vl-235b-a22b` | 3 products, 182 units | Preview only | Assumed category; answer scoped to the zero-match query |
| `gpt-5.4-mini` | 3 products, 182 units | Preview only | Assumed category; answer scoped to the zero-match query |

The explicit question was: “Conta i prodotti che contengono 'camera' nel nome e somma il loro stock. Usa i dati del database.” The original wording was: “quanti prodotti di tipo camera ho”. Some models interpreted “tipo” as an exact stored category. Tableline now replaces an unsupported broad absence claim with a query-scoped zero-result notice; it does not rewrite SQL or invent the intended filter. This is a safety bound, not a guarantee of correct semantic interpretation for every model.

Every proposed update targeted fixture product 9. An independent read confirmed its stock remained 0 after every preview; the assistant did not commit any update.

`databricks-claude-opus-4-7` and `gpt-oss-120b` failed with upstream gateway TLS hostname/certificate errors. Those aliases were not accepted as working. Tableline retained certificate verification and did not substitute another model. Gateway availability, quotas and latency may change after this validation.

## Reproducible regression checks

`npm test` covers transport parameters, strict parsing, persistent bounded format repair, truncation, prompt-context separation, write guards and conservative zero-result handling. SQLite integration tests exercise real reads and rollback previews. `npm run test:e2e:ai` exercises discovery, exact IDs, save/activate on the demo connection, profile/model changes and stale catalogue invalidation using the production renderer and a loopback provider. It asserts zero native credential calls. `npm run test:e2e:locales` checks all five languages, retained drafts and conversations, write-review dialogs and persistence.

Live-account checks are supervised acceptance evidence, separate from those credential-free fixtures. A successful model-test response alone does not establish database answering or write-review behavior.

Local source verification: **273 passing unit tests, two optional tests skipped**, a successful production build, **9 AI configuration desktop checks** and **35 locale desktop checks** across five catalogs of 521 messages. Native credential APIs remained unused in those desktop fixtures. Signed-package acceptance and installed-app checks are separate from source tests and will be recorded after completion.
