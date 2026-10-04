# Third-party notices

Tableline's original application source, documentation and assets are licensed under [GNU GPL version 3 only](LICENSE) (`GPL-3.0-only`); see [COPYRIGHT](COPYRIGHT). Third-party components retain the licenses and notices listed below. Earlier MIT releases, including v0.2.0, retain their original terms.
Its visual design and assets are original. TablePlus is a product reference and is not affiliated with this project; no TablePlus source, brand assets or credentials are included.

## Branchline provider integrations

`electron/ai.cjs`, `electron/ai-import.cjs` and the credential-vault foundation adapt code from [Branchline](https://github.com/Hexecu/branchline), maintained by Davide Leopardi. The reference snapshot is commit `b408b409a2722a7941eb1e34dd602b45dd2d6c4e`. The release/signing helpers under `scripts/` also adapt Branchline's release strategy. Tableline modifies the assistant protocol, database grounding, credentials namespace, native storage queue, endpoint policy, release gates and public API for its own application.

That reference snapshot was released under MIT. Its original notice is reproduced below to preserve attribution and the permissions already granted for that snapshot. This historical notice does not offer the current Tableline project and subsequent modifications under an alternative MIT license.

```text
MIT License

Copyright (c) 2026 Davide Leopardi

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Branchline configuration, repositories, user data and credentials are not distributed with Tableline.

## Packaged dependencies

The application uses the following main open-source packages. Their source distributions retain their respective license and notice files in `node_modules`; the macOS app retains the complete Electron MIT and Chromium notices in `Contents/Resources/licenses/`, copied from the same upstream distribution before signing.

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
