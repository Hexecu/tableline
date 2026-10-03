# Servizio locale e recupero

Tableline 0.1 è un’app locale. Non esiste un servizio remoto Tableline, telemetry o sincronizzazione dei dati. L’app non dichiara un SLA o affidabilità universale sui provider.

## Limiti operativi

- Pagine di 50/100/250/500 righe nella griglia; query UI limitate a 1.000 righe. Il servizio limita i risultati di query e griglia a 10 MiB e le operazioni a 30 secondi dove il driver lo supporta. L’introspezione dello schema ha limiti di righe specifici degli adapter; non applica lo stesso limite di byte ai metadati.
- SQLite usa un processo figlio dedicato: anche una query ricorsiva bloccata può essere interrotta realmente. Il collegamento viene ricreato per la query successiva. Gli adapter remoti hanno timeout e supporto di annullamento variabile.
- Letture e scritture sono serializzate per connessione. Profili e vault sono salvati atomicamente con permessi restrittivi. Una sola istanza desktop usa la directory normale.
- Le proposte sono in memoria, limitate e temporanee. Non sopravvivono al riavvio e non vengono ripetute automaticamente dopo un errore di rete.
- I commit SQL remoti hanno un limite di 5.000 righe. I cursori della griglia Redis durano cinque minuti e preservano le chiavi eccedenti restituite da SCAN; restringi la ricerca oltre 10.000 chiavi. Nei comandi JSON, COUNT è limitato a 1.000 e resta un’indicazione per Redis, senza garantire il numero massimo di chiavi restituite.
- Il client non consente DDL, stored procedure o ogni funzione SQL. La policy conservativa ammette una sola query e funzioni note, in aggiunta alle protezioni del database. Query fuori dalla superficie consentita producono un errore visibile.
- Le bozze SQL ripristinano fino a 16 schede per ciascuna delle ultime 16 connessioni, con 256.000 caratteri per scheda e 2 MiB complessivi. Oltre questo spazio le bozze delle connessioni meno recenti vengono rimosse con un avviso. **⌘ S** conserva esplicitamente le query importanti. Un errore di quota mantiene l'archivio precedente e mostra che il ripristino non è disponibile.

## Dati locali

Su macOS, i dati dell’app sono in `~/Library/Application Support/Tableline/`: `connections.json`, `ai-profiles.json`, vault cifrato e `demo-commerce.sqlite`. Preferenze, cronologia SQL e query salvate sono nello storage locale del renderer. Le query salvate possono contenere dati immessi: tratta la directory dell’app come dato privato. Non inserire credenziali nelle query; usa i campi dedicati.

Per un backup locale a app chiusa, conserva l’intera directory. I database remoti richiedono i propri backup: Tableline non implementa dump/restore. Se il portachiavi non è disponibile, il client rifiuta di salvare segreti in chiaro.

Da 0.1.1 le richieste native al portachiavi sono serializzate. Dopo otto secondi senza risposta, il client blocca nuove richieste per tutta la sessione: serve riavviare Tableline, senza ripetere tentativi nella stessa sessione. I controlli di stato non aprono il portachiavi. Demo, profili senza credenziali e gestione dei metadati restano utilizzabili; una richiesta tardiva non salva il segreto di un tentativo scaduto.

## Recupero

Un errore di query lascia disponibile l’editor. Correggi il SQL e riesegui; cronologia e risultati restano separati per scheda. Una query SQLite annullata interrompe il processo DB e lo riapre alla richiesta successiva.

Le bozze vengono salvate dopo 350 ms e prima del cambio connessione o dell'uscita. Se una connessione fallisce, l'editor precedente resta disponibile. L'uscita interrompe le letture SQLite/Redis, attende le operazioni in corso e limita a cinque secondi la successiva disconnessione di ogni driver. Una scrittura Redis che supera 30 secondi produce un errore con esito incerto, senza ritentare. Su macOS un processo ausiliario può terminare esclusivamente la propria app dopo due secondi se un'operazione nativa del portachiavi rimane sospesa; si attiva solo dopo questa chiusura dei database e verifica identità e avvio del processo per evitare di agire su un PID riutilizzato.

Se un commit restituisce un errore di connessione, non presumere che la modifica sia stata annullata. Esegui una lettura mirata e verifica l’esito; poi prepara un nuovo token se necessario. Le scritture non sono ritentate automaticamente.

## Verifiche prima di dati importanti

La suite locale testa demo, boundary, trasporti e server isolati. Prima di usare un account cloud, esegui Test connessione, scopri lo schema, prova una lettura limitata e verifica i permessi del principal. Le scritture su dati reali devono avere backup e una richiesta specifica revisionabile. Nessun test locale dimostra disponibilità, accesso o idoneità di un ambiente di produzione esterno.
