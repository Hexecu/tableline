# Third-party notices

Tableline's application source is licensed under the MIT license in `LICENSE`.
Its visual design and assets are original. TablePlus is a product reference and is not affiliated with this project; no TablePlus source, brand assets or credentials are included.

## Branchline provider integrations

`electron/ai.cjs`, `electron/ai-import.cjs` and the credential-vault foundation adapt code from [Branchline](https://github.com/Hexecu/branchline), maintained by Davide Leopardi. The reference snapshot is commit `b408b409a2722a7941eb1e34dd602b45dd2d6c4e`. The release/signing helpers under `scripts/` also adapt Branchline's release strategy. Tableline modifies the assistant protocol, database grounding, credentials namespace, native storage queue, endpoint policy, release gates and public API for its own application.

The following notice applies to that adapted source:

> MIT License — Copyright (c) 2026 Davide Leopardi. Permission is granted under the complete MIT license included in [LICENSE](LICENSE), including its copyright-preservation requirement and warranty disclaimer.

Branchline configuration, repositories, user data and credentials are not distributed with Tableline.

## Packaged dependencies

The application uses the following main open-source packages. Their source distributions retain their respective license and notice files in `node_modules`; the Electron distribution retains its Chromium and dependency license notices.

| Component | License |
| --- | --- |
| React, React DOM | MIT |
| Lucide React | ISC |
| Electron | MIT; bundled Chromium and components have their own notices |
| node-postgres (`pg`) | MIT |
| mysql2 | MIT |
| Databricks SQL Node.js driver | Apache-2.0 |
| node-mssql | MIT |
| MongoDB Node.js driver | Apache-2.0 |
| node-redis | MIT |
| ClickHouse JavaScript client | Apache-2.0 |
| AWS SDK for JavaScript v3 | Apache-2.0 |
| Google Auth Library for Node.js | Apache-2.0 |
| Databricks native SQL kernel and FlatBuffers | Apache-2.0 |
| LZ4 N-API native bindings | MIT |
| TypeScript, Playwright | Apache-2.0; build and test tooling |
| Vite, electron-builder | MIT; build tooling |

`package-lock.json` identifies exact dependency versions. The installed runtime dependency license inventory uses MIT, Apache-2.0, ISC, BSD-2-Clause, BSD-3-Clause and 0BSD, including the Apache-2.0 text in FlatBuffers' `LICENSE`. Platform-specific optional packages differ by installation. Transitive packages keep their distributed copyright and license notices; Electron's Chromium notices must remain in distributed bundles. No third-party service grants or account rights are implied by the integration adapters.
