# How it works

Sincronizza i gruppi di schede di Firefox fra più computer usando un server
scelto dall'utente, e li recupera da una cronologia.

ID estensione: `tab-groups-sync-restore@fribbynetwork.net`
Firefox minimo: **139** (il namespace `browser.tabGroups` esiste da lì)

---

## Un file per computer

Ogni computer scrive un solo file, che porta il suo nome:

```
ComputerCasa.json                 i gruppi di quel computer, e nient'altro
Portatile.json                    quelli di un altro
history/ComputerCasa/<ts>.json    le sue istantanee
```

**Nessuno scrive nel file di un altro.** Da qui discende quasi tutto il resto:
la scrittura concorrente non può accadere, non c'è nulla da fondere, e un gruppo
chiuso semplicemente non compare nella scrittura successiva — senza bisogno di
annunciare la cancellazione a nessuno.

La versione precedente teneva un indice condiviso che ogni macchina modificava,
con lapidi e una fusione a tre vie per riconciliarle. Quasi tutti i bug difficili
venivano da quell'unico file conteso.

## Identità

**Il nome è l'identità.** Reinstallando e digitando lo stesso nome si riprende lo
stesso file, invece di lasciarsi dietro un fantasma. Il nome diventa un nome di
file, quindi ammette solo lettere, cifre, `-` e `_`; gli spazi diventano
trattini bassi mentre si digita.

Dentro al file c'è anche un `installId`, che distingue "questo computer,
reinstallato" da "un altro computer che ha scelto lo stesso nome". Nel secondo
caso l'estensione avvisa e chiede conferma esplicita, perché prendere il
controllo di quel file è giusto dopo una reinstallazione e sbagliato fra due
macchine vive.

## Come si accorge dei cambiamenti

Ogni file porta in testa, in chiaro, un `updatedAt`. Un computer è "cambiato"
quando il suo file è più recente di quanto questa macchina ha riconosciuto
l'ultima volta.

**Niente viene mai applicato da solo**, nemmeno all'avvio: all'avvio si guarda,
non si agisce. Il popup propone tre risposte per ogni computer cambiato:

- **Aprili qui** — aggiunge i suoi gruppi a quelli già aperti. I tuoi restano.
- **Sostituisci i miei** — chiude quelli aperti qui e apre i suoi. Prima salva
  un'istantanea, che è l'annullamento.
- **Non fare nulla** — toglie l'avviso. Anche questa è una risposta: riconosce
  quella versione, quindi la stessa modifica non viene più riproposta.

Dopo "Aprili qui" quei gruppi sono a tutti gli effetti di questo computer, e la
prossima scrittura li include. L'altro computer vedrà il file cambiato e potrà
decidere a sua volta.

## Cosa si sincronizza

Solo ciò che sta dentro a un gruppo. Le schede fuori dai gruppi restano locali:
è lo spazio di lavoro implicito di ogni macchina, e non essendoci copia non
vengono mai chiuse da un ripristino.

## Identità dei gruppi

Ogni gruppo porta un UUID, così ripescandolo una seconda volta viene aggiornato
invece che duplicato. Gli id numerici di Firefox vengono riassegnati al ripristino
della sessione, quindi l'associazione è mantenuta su tre livelli: la mappa viva,
il valore di sessione del gruppo, e un'impronta (titolo più primo indirizzo)
salvata in locale. Senza quest'ultima, ogni riavvio conierebbe UUID nuovi e il
file risulterebbe cambiato a tutti gli altri computer senza che nulla lo fosse.

## Cifratura

Opzionale. La passphrase non viene mai salvata: viene stesa con PBKDF2 in una
`CryptoKey` AES-GCM non estraibile conservata in IndexedDB.

I parametri (salt, verifier, keyId) stanno **in chiaro nell'intestazione di ogni
file**, quindi un computer nuovo li legge dal primo file che trova e deriva la
chiave. Non serve nessun file condiviso nemmeno per questo. Il `verifier`
permette di dire "password sbagliata" invece di mostrare un errore di
decifratura, e il `keyId` distingue "password sbagliata" da "password cambiata
altrove" — nel secondo caso la sincronizzazione si sospende invece di
riprovare inutilmente.

## Ogni destinazione è indipendente

Impostazioni, credenziali e stato (cosa ho scritto per ultimo, cosa ho
riconosciuto dagli altri) sono separati per destinazione. Si può passare da
Firefox Sync a un endpoint personale a Nextcloud e tornare indietro senza
reinserire nulla.
