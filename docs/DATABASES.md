# Database e capacità

| Profilo           | Driver reale                     | Query                      | Scritture                                     | Verifica                                                 |
| ----------------- | -------------------------------- | -------------------------- | --------------------------------------------- | -------------------------------------------------------- |
| SQLite            | `node:sqlite`, processo dedicato | SQL                        | INSERT, UPDATE, DELETE con anteprima e commit | File reale, servizio e app desktop                       |
| PostgreSQL        | `pg`                             | SQL, transazione READ ONLY | Proposta non eseguita, transazione al commit  | Server Docker isolato                                    |
| Aurora PostgreSQL | `pg`                             | SQL                        | Come PostgreSQL                               | Contratto; cluster AWS non verificato                    |
| CockroachDB       | `pg`                             | SQL                        | Come PostgreSQL                               | Contratto; server non verificato                         |
| Redshift          | `pg`                             | SQL                        | Disabilitate                                  | Contratto; warehouse non verificato                      |
| MySQL             | `mysql2`                         | SQL, transazione READ ONLY | Solo tabelle InnoDB; proposta e commit        | Server Docker isolato                                    |
| MariaDB           | `mysql2`                         | SQL                        | Come MySQL                                    | Contratto; server MariaDB non verificato                 |
| Aurora MySQL      | `mysql2`                         | SQL                        | Come MySQL                                    | Contratto; cluster AWS non verificato                    |
| Databricks SQL    | `@databricks/sql` 2.2            | SQL, warehouse HTTP path   | Disabilitate                                  | Driver/API e trasporto isolato; warehouse non verificato |
| SQL Server        | `mssql`                          | SQL protetto               | Proposta e commit in transazione              | Contratto; server non verificato                         |
| ClickHouse        | `@clickhouse/client`             | SQL, `readonly=1`          | Disabilitate                                  | Server Docker isolato                                    |
| MongoDB           | `mongodb`                        | JSON find/count/aggregate  | JSON insertOne/updateMany/deleteMany          | Server Docker isolato                                    |
| Redis             | `redis`                          | JSON comandi allowlist     | JSON comandi allowlist                        | Server Docker isolato                                    |

Le informazioni di schema MongoDB sono campionate su un massimo di 20 documenti per collection: non costituiscono un vincolo formale sui documenti. Redis usa SCAN; la griglia conserva le chiavi eccedenti in cursori opachi del servizio che scadono dopo cinque minuti. La scansione è limitata a 10.000 chiavi e il database può cambiare durante il percorso. I cursori della query JSON SCAN sono invece quelli nativi di Redis. La griglia offre paginazione; per operazioni mirate usa query JSON.

## Esempi JSON

MongoDB:

```json
{
  "collection": "customers",
  "operation": "find",
  "filter": { "country": "IT" },
  "limit": 100
}
```

```json
{
  "collection": "customers",
  "operation": "aggregate",
  "pipeline": [{ "$group": { "_id": "$country", "count": { "$sum": 1 } } }]
}
```

Redis:

```json
{ "command": "GET", "args": ["customer:1"] }
```

```json
{ "command": "SCAN", "args": ["0", "MATCH", "customer:*", "COUNT", "100"] }
```

Comandi di amministrazione, scripting server-side e pipeline che scrivono ($out/$merge) non passano dalla lettura.

## Scritture

La connessione deve consentire la revisione. Una proposta scade dopo cinque minuti, è legata alla connessione e alla sua configurazione, ed è consumata al primo tentativo di commit. Scartarla o cambiare configurazione la invalida. Una perdita di rete durante COMMIT può lasciare un esito incerto: verifica i dati prima di preparare una nuova proposta.

SQLite esegue l’anteprima nel processo dedicato e la annulla; mostra righe se la query include RETURNING, altrimenti il conteggio modificato. Al commit ricontrolla il conteggio, senza confrontare l’intero contenuto delle righe. Gli adapter SQL remoti stimano UPDATE/DELETE senza eseguire la mutazione; al commit confrontano l’impronta delle righe lette in una transazione SERIALIZABLE. Le istruzioni remote devono indicare una tabella semplice e un WHERE, senza join o alias del target. INSERT non esegue una prova e non presenta un conteggio stimato. Il commit SQL remoto impone un limite di 5.000 righe. Sequenze, identity e trigger possono avere effetti che il rollback non annulla completamente: il commit non è un sistema di undo.

MongoDB e Redis mostrano una stima o lo stato attuale. Le scritture non hanno rollback comune e le operazioni multiple possono riuscire parzialmente; il dialogo lo dichiara. La modifica diretta delle celle è disponibile per tabelle SQL con chiave primaria. Per documenti e key-value usa la query JSON.

## Collegamenti

I profili nuovi sono in lettura. TLS verifica i certificati remoti; per i server locali di test puoi configurare esplicitamente una connessione senza TLS. Non vengono modificati i ruoli nel database. SQL Server non offre una transazione READ ONLY: usa un principal di sola lettura per applicare la policy anche sul server.

Databricks richiede un warehouse, host, HTTP path e token. Aurora usa host/porta/database/utente del cluster e TLS; IAM e tunnel SSH non sono implementati. I provider LLM e i database hanno vault namespace separati.
