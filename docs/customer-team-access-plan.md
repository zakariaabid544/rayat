# Customer Team Access Plan

## 1. Obiettivo prodotto

Supportare aziende agricole con un solo router Rayat e piu utenti autenticati con credenziali proprie, senza duplicare router, sensori o letture.

Obiettivi:
- mantenere un solo owner tecnico del router;
- permettere accesso condiviso ai dati dello stesso impianto;
- introdurre ruoli interni cliente con permessi differenziati;
- minimizzare l'impatto sull'architettura esistente.

## 2. Scenario reale: Azienda Banana Agadir

Entita:
- 1 azienda agricola: `Azienda Banana Agadir`
- 1 router Rayat
- X sensori collegati al router
- 4 utenti

Utenti:
- `owner`: proprietario, account principale
- `agronomist` o `manager`: consultazione avanzata e analisi
- `technician`: operativita tecnica sui sensori
- `viewer`: sola lettura

Principio chiave:
- `devices.user_id` continua a puntare all'owner principale;
- gli utenti secondari non possiedono il router;
- gli utenti secondari leggono i dati nello scope dell'owner.

## 3. Modello ruoli e permessi

Ruoli cliente proposti:

| customer_role | Dashboard | Storico | CSV | Alert | Configurazione sensori | Gestione personale |
|---|---|---|---|---|---|---|
| `owner` | yes | yes | yes | yes | yes | yes |
| `agronomist` | yes | yes | yes | yes | no | no |
| `manager` | yes | yes | yes | yes | limited | yes |
| `technician` | yes | yes | optional | yes | yes | no |
| `viewer` | yes | yes | no | read-only | no | no |

Note:
- `manager` puo essere usato come ruolo business interno; `agronomist` come variante funzionale. Se serve massima semplicita iniziale, sceglierne uno solo.
- `viewer` deve essere esplicitamente read-only su API e UI.
- i permessi vanno applicati lato backend; la UI deve solo rifletterli.

## 4. Modello dati consigliato

Soluzione consigliata minima:

### `users`
- aggiungere in futuro `owner_user_id` nullable
- aggiungere in futuro `customer_role`

Semantica:
- account principale: `owner_user_id = NULL`
- account secondario: `owner_user_id = <id owner>`

Scelta naming:
- preferibile `owner_user_id` per chiarezza di dominio;
- `parent_user_id` e accettabile ma piu generico.

### `devices`
- `devices.user_id` resta associato all'owner principale
- nessuna duplicazione di device

### `sensors`
- restano collegati al device esistente

### `sensor_readings`
- restano collegati ai sensori esistenti

### Regola di scope
- se `owner_user_id` e valorizzato, lo scope dati dell'utente e quello dell'owner;
- se `owner_user_id` e null, lo scope dati dell'utente e il proprio `id`.

Pseudo-regola:

```text
scope_owner_id = users.owner_user_id ?? users.id
```

## 5. API da modificare in futuro

Endpoint da aggiornare:
- `POST /api/auth/login`
- `GET /api/auth/me`
- `GET /api/sensors/status`
- `GET /api/sensors/latest`
- `GET /api/sensors/:type/latest`
- `GET /api/sensors/:type/history`
- `GET /api/iot/devices`
- `GET /api/sensors/alerts`
- `POST /api/sensors/alerts/:id/acknowledge`
- `GET /api/sensors/thresholds`
- `PUT /api/sensors/thresholds`

Endpoint nuovi consigliati:
- `GET /api/admin/clients/:id/team`
- `POST /api/admin/clients/:id/team`
- `PUT /api/admin/clients/:id/team/:userId`
- `DELETE /api/admin/clients/:id/team/:userId`

Linee guida API:
- `login` e `me` devono restituire `customer_role`, `owner_user_id`, permessi risolti e flag `is_primary_account`;
- gli endpoint dati devono filtrare tramite `scope_owner_id`, non tramite `req.user.id` puro;
- gli endpoint write devono verificare il ruolo prima di eseguire modifiche.

## 6. Sicurezza e isolamento dati

Vincoli richiesti:
- un utente secondario vede solo i dati del proprio owner;
- non puo accedere a router di altri clienti;
- `viewer` non puo scrivere;
- `admin` e `super_admin` mantengono visibilita e controllo globale.

Controlli minimi:
- risolvere lo scope utente lato backend a ogni request autenticata;
- applicare ACL per ruolo su endpoint write;
- non fidarsi del ruolo lato frontend;
- loggare creazione, modifica e revoca utenti secondari.

Nota:
- l'isolamento dati deve essere centralizzato in middleware o helper condiviso, non duplicato in query sparse.

## 7. Piano implementazione step-by-step

1. Introdurre il concetto di account principale e secondario nel modello `users`.
2. Definire `customer_role` e matrice permessi backend.
3. Implementare un resolver condiviso dello `scope_owner_id`.
4. Aggiornare tutti gli endpoint dati per usare lo scope owner.
5. Aggiornare endpoint alert e soglie per coerenza di accesso.
6. Bloccare operazioni write per i ruoli read-only.
7. Aggiungere API admin per gestione team cliente.
8. Aggiornare frontend web per mostrare o nascondere azioni in base ai permessi.
9. Verificare retrocompatibilita con clienti esistenti senza utenti secondari.

## 8. Rischi tecnici

- Rischio di introdurre ruoli cliente dentro `users.role` e rompere logiche esistenti: evitare.
- Rischio di query non aggiornate che continuano a filtrare su `req.user.id`.
- Rischio di incoerenza tra accesso ai dati e accesso ad alert/soglie.
- Rischio di permessi solo UI e non backend.
- Rischio di confondere utenti secondari con clienti primari nei pannelli admin.

## 9. Test da eseguire

Test funzionali:
- owner vede il proprio router e tutti i sensori;
- utente secondario vede lo stesso router dell'owner;
- utente secondario non vede router di altri owner;
- viewer accede a dashboard e storico ma non puo modificare;
- technician puo operare solo sulle API tecniche consentite;
- manager o owner puo aggiungere/rimuovere personale;
- revoca di un utente secondario rimuove immediatamente l'accesso.

Test di sicurezza:
- tentativo di accesso cross-company con ID manuali;
- tentativo di write con ruolo `viewer`;
- tentativo di escalation ruolo via payload client;
- verifica retrocompatibilita per account legacy senza team.

## 10. Cosa NON implementare ora

Fuori scope per questa fase:
- nuova tabella `companies` o `organizations`
- tabella `user_device_access`
- accesso multi-router per singolo consulente esterno
- refactor architetturale ampio
- modifiche Android o iOS
- migrazioni e rollout database in questa attivita
- ridefinizione completa del modello alert/notification

Decisione di fase:
- adottare il minimo modello compatibile con l'architettura corrente;
- rinviare un vero modello organization-based a una fase successiva.
