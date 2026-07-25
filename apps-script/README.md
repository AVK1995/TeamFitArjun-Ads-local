# Arjun CRM — Apps Script Downstream CAPI Engine

Apps Script bound to the **Arjun CRM** Google Sheet. Fires three downstream
Meta Conversions API events when a sales-team-edited dropdown is set to TRUE:

| Sheet dropdown set to TRUE | Meta CAPI event fired | Carries value? |
|---|---|---|
| `call_booked` (col X) | `CallBooked` | no |
| `call_showed` (col AB) | `CallDone` | no |
| `sale_closed` (col AF) | `HighTicketPurchase` | yes — `contracted_value` from col AG |

All three are **custom** event names, which matters: the shared dataset is
categorised "Health and wellness condition" and Meta blocks standard event
names. Do not rename any of them to a standard Meta event.

The tripwire `sales` event for the ₹97 Blueprint Call is fired
separately by the Next.js backend from the Razorpay webhook (see
`PURCHASE_TRACKING_ARCHITECTURE.md` in the repo root). This script handles only
the three downstream lifecycle events. The two systems share the same Meta
pixel (`738176472687210`, "Arjun Pixel 2") + CAPI token but never talk to each
other directly — the Sheet is the only link.

---

## Files in this folder

- **`Code.gs`** — paste into the Apps Script editor (replaces the default file)
- **`appsscript.json`** — paste into the manifest (Apps Script editor → gear icon → Show appsscript.json)
- **`README.md`** — this file

These are a template. They are NOT auto-deployed. To make them live, copy-paste
into the Sheet's Apps Script editor (steps below).

---

## Prerequisites

1. **The Arjun CRM Google Sheet exists** with the 36-column schema in row 1, A→AJ:

```
lead_id | created_at | first_name | last_name | email | phone | city | country_code | fbc | fbp | client_ip_address | client_user_agent | external_id | event_source_url | amount | is_test | purchase_event_id | utm_source | utm_medium | utm_campaign | utm_content | utm_term | fbclid | call_booked | booking_time | schedule_capi_event_id | schedule_capi_sent | call_showed | showup_time | showup_capi_event_id | showup_capi_sent | sale_closed | contracted_value | sales_time | htsale_capi_event_id | htsale_capi_sent
```

(also in `sheet-header.tsv` in this folder — paste that into A1 directly).

2. **The hidden `_Errors` tab exists** with this header in row 1:
   `timestamp | row_number | event_type | http_status | response_body | retry_count`

3. **Column types**:
   - X, AB, AF — **Dropdown** (Data → Data validation → Dropdown → values `TRUE` and `FALSE`, exact uppercase). **Do NOT use checkboxes** — they pre-populate as FALSE when Pabbly creates a row, indistinguishable from "sales team marked FALSE". Dropdowns stay blank until someone picks a value.
   - AA, AE, AJ — Dropdown `TRUE`/`FALSE` too (Apps Script writes `TRUE` here on success).
   - Y, AC, AH — **Date+time** (Format → Number → Date time)
   - AG — **Plain number** (no thousands separator, no currency symbol)

4. **Spreadsheet timezone is `Asia/Kolkata`** (File → Settings → Timezone).

5. **Pabbly is writing rows correctly** — at least one real payment has produced
   a row with all 23 auto-fill columns populated (especially `lead_id`, `email`,
   `fbc`, `fbp`, `client_ip_address`, `client_user_agent`, `external_id`).

---

## Deployment (~10 minutes)

1. **Open the Sheet's Apps Script editor:** Extensions → Apps Script.
2. **Paste `Code.gs`:** select-all in the default file → delete → paste the entire
   contents of `Code.gs` from this folder → Save.
3. **Replace the manifest:** gear icon (Project Settings) → tick "Show
   'appsscript.json' manifest file in editor" → back to Editor → open
   `appsscript.json` → replace with this folder's version → Save.
4. **Add Script Properties** (Project Settings → Script Properties → Add):

| Property | Value |
|---|---|
| `META_PIXEL_ID` | `738176472687210` |
| `META_CAPI_ACCESS_TOKEN` | the same value as Vercel's `META_CAPI_ACCESS_TOKEN` (treat as secret) |
| `EVENT_SOURCE_URL_DEFAULT` | `https://teamfitarjun.com/book-a-call` |

Optional overrides: `MAIN_SHEET_NAME` (default `Sheet1`), `META_GRAPH_API_VERSION` (default `v25.0`).

5. **Install the trigger:** function dropdown → `setupTriggers` → Run → authorize
   (you'll see "Google hasn't verified this app" — Advanced → Go to project → allow
   the 3 scopes). Look for `setupTriggers OK — removed 0 old, installed 1 new`.
6. **Smoke test** (below).

---

## Smoke test

1. In Meta Events Manager → "Arjun Pixel 2" → **Test Events**, copy the test code.
2. Paste the dummy row from `dummy-row.tsv` into row 2 (or use a real row).
3. Set `call_booked` (col X) dropdown → `TRUE`. Within ~10s:
   - Col Z = `<lead_id>_schedule`, Col AA = `TRUE`
   - Meta Test Events shows `CallBooked`, source Server, EMQ 9+
4. Fill `showup_time` (AC) → set `call_showed` (AB) → `TRUE`. Expect `CallDone`.
5. Fill `contracted_value` (AG, e.g. `60000`) + `sales_time` (AH) → set `sale_closed`
   (AF) → `TRUE`. Expect `HighTicketPurchase` with `value: 60000, currency: INR`.

If a step fails, check the `_Errors` tab + Apps Script → Executions log.

---

## How it works

- Sales team sets a trigger dropdown to TRUE → installable `onSheetEdit` fires.
- Script reads the row, builds high-EMQ `user_data` (SHA-256 hashes
  em/ph/fn/ln/ct/country + external_id; forwards raw fbc/fbp/IP/UA).
- For `HighTicketPurchase`, includes `value` = contracted_value + `currency: INR`.
- POSTs to `graph.facebook.com/v25.0/<pixel>/events`. Retries 3× on 429/5xx.
- On 200: stamps `*_capi_event_id` + `*_capi_sent = TRUE`.
- On failure: appends to `_Errors`, leaves the row retry-able.

### Dedup
- **Sheet-side:** `*_capi_sent` flag checked before firing.
- **Meta-side:** deterministic `event_id = <lead_id>_<suffix>` — Meta dedupes same
  event_name+event_id within 48h.
- **Cross-event:** each event has a distinct name, so they never collide.

### Bulk replay (after a Meta outage)
Function dropdown → `replayPendingEvents` → Run. Fires every row that has a TRUE
trigger but no sent flag, paced 500ms apart.

### Rotate the token
Project Settings → Script Properties → update `META_CAPI_ACCESS_TOKEN` → Save. No
redeploy needed.

---

## Replicating for another client (~15 min, no code change)

1. New Google Sheet, paste the 36-column header.
2. Extensions → Apps Script → paste `Code.gs` + `appsscript.json`.
3. Customize the `EVENTS` block's three `eventName` values for that client.
4. Set the 3 Script Properties (their pixel, token, booking URL).
5. Run `setupTriggers`, authorize, smoke-test.

The engine code is identical across clients — only the event names + properties differ.
