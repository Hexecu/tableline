# Contributing to Tableline

Small, reproducible changes are welcome. Use [issues](https://github.com/Hexecu/tableline/issues) for bugs and feature proposals, and follow [SECURITY.md](SECURITY.md) for vulnerabilities.

## Local setup

Use Node.js 22.13 or newer and npm:

```sh
npm ci
npm run dev
```

Run the checks relevant to your change:

```sh
npm test
npm run test:i18n
npm run build
node scripts/e2e-locales.cjs
```

The unit tests use synthetic credentials and mocks for native storage. Locale desktop checks use a temporary data directory and reject native credential API calls. On Linux, run the desktop checks under a display such as `xvfb-run -a`. Never enter real credentials into a test fixture.

The broader `npm run test:e2e` deliberately reports native credential acceptance as blocked by default and exits nonzero. A supervised opt-in is separate from ordinary CI; do not change that result into a successful credential claim or mask real failed checks. Optional real-server commands and operational limits are in [README.md](README.md) and [docs/VALIDATION.md](docs/VALIDATION.md).

## Changes

Explain the concrete problem, the resulting behavior and the checks run in your pull request. Add a focused test when changing a service, security boundary or data operation. Use disposable fixture data to demonstrate driver behavior; a mocked SDK test does not establish access to a live cloud account.

Keep database and provider secrets out of the renderer, logs, screenshots and repository. Preserve TLS verification, safeStorage's fail-closed behavior and human write approval. The assistant may prepare a proposal but must never gain a commit tool. A lost write acknowledgement must not trigger an automatic retry.

For translations, update the same message key in all five files under `locales/`. Keep interpolation placeholders identical and leave SQL, IDs, user data and provider model names unchanged. Use `npm run test:i18n` to check key parity and interpolation. Locale UI changes need a desktop smoke check, including persisted language selection.

## Community

Be respectful, explain disagreements with evidence and keep discussions focused on the work. Do not post other people's private data. Public contributions are accepted under the project's [GPL-3.0-only license](LICENSE); retain applicable third-party attribution and the source file's copyright/license notice. Add an accurate copyright notice for your own contributions when appropriate. Third-party components retain their original licenses.
