# Tableline

Un workspace desktop locale per database e AI: esplora tabelle, esegui query, conserva le bozze SQL e revisiona ogni scrittura prima di applicarla.

[English](README.md) · [Release](https://github.com/Hexecu/tableline/releases/tag/v0.2.0) · [Contribuire](CONTRIBUTING.md) · [Privacy](docs/PRIVACY.md) · [Sicurezza](SECURITY.md)


![Tableline con demo SQLite locale e risposta verificata sui dati](docs/screenshots/workspace-en.png)

## Provalo

Scarica l'app e il checksum dalle [release GitHub](https://github.com/Hexecu/tableline/releases/tag/v0.2.0). Le note indicano architettura e stato di firma. La distribuzione desktop è per **macOS su Apple Silicon**; non vengono ancora distribuiti installer Linux o Windows. La CI verifica il sorgente su macOS e Linux.

Apri **Demo locale**: SQLite contiene 120 clienti, 36 prodotti, 1.000 ordini e 1.000 righe ordine. È un vero file locale. L'assistente della demo è dichiarato deterministico e funziona senza un account LLM.

Il selettore di lingua offre **inglese, italiano, francese, tedesco e spagnolo** e conserva la scelta al riavvio. Nomi dei database, SQL, risposte del modello e diagnostica dei server mantengono il contenuto originale.

## Flusso rapido

- Filtra, ordina e cambia pagina nella griglia. Consulta struttura, chiavi, dettaglio riga e JSON.
- Usa schede SQL con completamento, cronologia, query salvate e ripristino delle bozze. Esporta pagina o risultati in CSV o JSON.
- **⌘ K** cerca comandi e tabelle, **⌘ T** apre una query, **⌘ Invio** la esegue, **⌘ S** la salva e **⌘ I** apre l'assistente.
- Modifica celle SQL con chiave primaria oppure prepara INSERT, UPDATE e DELETE. Controlla la proposta e conferma il token monouso per applicarla.
- Il tema chiaro/scuro è persistente. Il ripristino delle bozze ha limiti di spazio: salva esplicitamente le query importanti.

## Database

13 profili: **SQLite, PostgreSQL, Aurora PostgreSQL, CockroachDB, Redshift, MySQL, MariaDB, Aurora MySQL, Databricks SQL, SQL Server, ClickHouse, MongoDB e Redis**. Gli adapter usano driver reali; Aurora usa il protocollo del proprio engine. Databricks, Redshift e ClickHouse sono in lettura. MongoDB e Redis usano operazioni JSON consentite, con scritture revisionate e senza rollback comune.

SQLite, PostgreSQL, MySQL, MongoDB, Redis e ClickHouse hanno prove su fixture locali reali. Account cloud Databricks/Aurora/Redshift e server CockroachDB, MariaDB e SQL Server richiedono una verifica specifica. Consulta [capacità e limiti](docs/DATABASES.md) e [validazione](docs/VALIDATION.md).

Le nuove connessioni sono in lettura. TLS verifica i certificati remoti quando attivo; i ruoli nel database restano l'autorità sul server. Questa versione non implementa tunnel SSH, IAM/OAuth dei database, Oracle, Snowflake, BigQuery, Cassandra, DuckDB, Elasticsearch, DDL, backup/restore o importazioni massive.

## Assistente

Provider disponibili: **OpenAI, Anthropic, Azure OpenAI, Google AI Studio, Vertex AI, Amazon Bedrock, LiteLLM, Ollama** ed **endpoint compatibili con OpenAI**. Modello e destinazione selezionati sono visibili.

Una domanda esplicita può inviare al provider schema, cronologia della domanda e risultati limitati di massimo quattro letture. Le risposte espongono le evidenze delle query riuscite; quelle basate sul solo schema sono indicate separatamente. **Prepara modifica** richiede una richiesta di mutazione esplicita e produce una proposta: l'assistente non ha uno strumento di commit. La conferma umana passa dal flusso comune di revisione del database. Consulta [AI.md](docs/AI.md) e [privacy](docs/PRIVACY.md).

I segreti sono separati dai metadati e cifrati tramite Electron safeStorage. Una protezione indisponibile viene rifiutata, incluso `basic_text` su Linux, senza salvataggio in chiaro. Le richieste native sono serializzate; un timeout blocca nuovi tentativi fino al riavvio. La CI usa mock e non certifica l'autorizzazione delle credenziali nel portachiavi.

## Sviluppo

Node.js **22.13 o successivo** e npm; CI su Node 22 e 24.

```sh
git clone https://github.com/Hexecu/tableline.git
cd tableline
npm ci
npm run dev
```

```sh
npm test
npm run test:i18n
npm run build
node scripts/e2e-locales.cjs
npm run package
```

I test desktop delle lingue avviano Electron isolato e impediscono chiamate alle API native delle credenziali. Su Linux occorre un display, ad esempio `xvfb-run -a node scripts/e2e-locales.cjs`. La suite completa `npm run test:e2e` resta intenzionalmente non verde mentre la prova nativa delle credenziali è esclusa. `TABLELINE_E2E_CREDENTIALS=1` abilita quella prova supervisionata e può aprire una richiesta di autorizzazione del sistema operativo.

Le istruzioni per fixture Docker, limiti operativi, recupero e packaging sono in [README.md](README.md), [SERVICE.md](docs/SERVICE.md) e [procedura di release](docs/PUBLIC_RELEASE.md). Non sono presenti telemetria, aggiornamenti automatici o un servizio remoto Tableline.

## Licenza

MIT. Il livello provider adatta codice di [Branchline](https://github.com/Hexecu/branchline), con attribuzione e licenza conservate nelle [note terze parti](THIRD_PARTY_NOTICES.md). Tableline ha codice, asset visivi e identità propri. TablePlus è un prodotto indipendente e non è affiliato.
