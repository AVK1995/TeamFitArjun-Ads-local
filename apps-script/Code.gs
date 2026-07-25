/**
 * Arjun CRM — downstream Meta CAPI event firing engine.
 *
 * Bound to the Arjun CRM Google Sheet. On every USER edit to a trigger column
 * (call_booked / call_showed / sale_closed) this script reads the lead's row,
 * builds a Meta Conversions API event payload with full hashed user_data,
 * POSTs to graph.facebook.com directly, and stamps the row with the resulting
 * event_id + dedup flag. Failures are logged to the hidden `_Errors` tab so
 * the row remains retry-able.
 *
 * The tripwire `sales` event for the ₹97 payment is fired separately by the
 * Next.js backend from the Razorpay webhook. This script handles only the
 * three downstream events. Both systems share the same Meta pixel + token but
 * never talk to each other directly — the Sheet is the only link.
 *
 * NOTE: the shared dataset is categorised "Health and wellness condition", so
 * Meta blocks STANDARD event names. The three names below (CallBooked /
 * CallDone / HighTicketPurchase) are custom names and are unaffected — but do
 * not rename any of them to a standard Meta event, and keep their payloads
 * free of product/condition strings.
 *
 * Source-of-truth schema: 36-column row, A..AJ (see README.md).
 */

/* ============================================================
   Configuration
   ============================================================ */

const MAIN_SHEET_NAME_DEFAULT = 'Sheet1';
const ERROR_SHEET_NAME = '_Errors';
const COL_COUNT = 36;
const GRAPH_API_VERSION_DEFAULT = 'v25.0';
const MAX_RETRIES = 3;

// Column index map (1-indexed; matches A..AJ in the Sheet).
const COL = {
  // --- Auto-fill by Pabbly ---
  LEAD_ID:             1,   // A
  CREATED_AT:          2,   // B
  FIRST_NAME:          3,   // C
  LAST_NAME:           4,   // D
  EMAIL:               5,   // E
  PHONE:               6,   // F
  CITY:                7,   // G
  COUNTRY_CODE:        8,   // H
  FBC:                 9,   // I
  FBP:                 10,  // J
  CLIENT_IP_ADDRESS:   11,  // K
  CLIENT_USER_AGENT:   12,  // L
  EXTERNAL_ID:         13,  // M
  EVENT_SOURCE_URL:    14,  // N
  AMOUNT:              15,  // O
  IS_TEST:             16,  // P
  PURCHASE_EVENT_ID:   17,  // Q
  UTM_SOURCE:          18,  // R
  UTM_MEDIUM:          19,  // S
  UTM_CAMPAIGN:        20,  // T
  UTM_CONTENT:         21,  // U
  UTM_TERM:            22,  // V
  FBCLID:              23,  // W

  // --- Manual / Apps Script-written ---
  CALL_BOOKED:               24,  // X
  BOOKING_TIME:              25,  // Y
  SCHEDULE_CAPI_EVENT_ID:    26,  // Z
  SCHEDULE_CAPI_SENT:        27,  // AA
  CALL_SHOWED:               28,  // AB
  SHOWUP_TIME:               29,  // AC
  SHOWUP_CAPI_EVENT_ID:      30,  // AD
  SHOWUP_CAPI_SENT:          31,  // AE
  SALE_CLOSED:               32,  // AF
  CONTRACTED_VALUE:          33,  // AG
  SALES_TIME:                34,  // AH
  HTSALE_CAPI_EVENT_ID:      35,  // AI
  HTSALE_CAPI_SENT:          36,  // AJ
};

// One entry per downstream event. The triggerCol dropdown flipping to TRUE
// is what causes the event to fire. valueCol is only relevant for the HT sale.
const EVENTS = {
  CALL_BOOKED: {
    eventName: 'CallBooked',
    triggerCol: COL.CALL_BOOKED,
    timeCol: COL.BOOKING_TIME,
    eventIdCol: COL.SCHEDULE_CAPI_EVENT_ID,
    sentCol: COL.SCHEDULE_CAPI_SENT,
    eventIdSuffix: 'schedule',
    includeValue: false,
  },
  CALL_SHOWED: {
    eventName: 'CallDone',
    triggerCol: COL.CALL_SHOWED,
    timeCol: COL.SHOWUP_TIME,
    eventIdCol: COL.SHOWUP_CAPI_EVENT_ID,
    sentCol: COL.SHOWUP_CAPI_SENT,
    eventIdSuffix: 'showup',
    includeValue: false,
  },
  SALE_CLOSED: {
    eventName: 'HighTicketPurchase',
    triggerCol: COL.SALE_CLOSED,
    timeCol: COL.SALES_TIME,
    eventIdCol: COL.HTSALE_CAPI_EVENT_ID,
    sentCol: COL.HTSALE_CAPI_SENT,
    eventIdSuffix: 'htsale',
    includeValue: true,
    valueCol: COL.CONTRACTED_VALUE,
  },
};

/* ============================================================
   Entry point — installable onEdit trigger
   ============================================================ */

function onSheetEdit(e) {
  try {
    if (!e || !e.range) return;

    const sheet = e.range.getSheet();
    if (sheet.getName() !== getMainSheetName()) return;

    const editedRow = e.range.getRow();
    if (editedRow === 1) return; // header

    const editedCol = e.range.getColumn();

    // Find which event (if any) this edit triggers.
    let cfg = null;
    for (const key of Object.keys(EVENTS)) {
      if (EVENTS[key].triggerCol === editedCol) {
        cfg = EVENTS[key];
        break;
      }
    }
    if (!cfg) return;

    // Only fire when the dropdown flips TO true.
    if (!isTruthy(e.value)) return;

    // Dedup: skip if this event already fired for this row.
    const sentValue = sheet.getRange(editedRow, cfg.sentCol).getValue();
    if (isTruthy(sentValue)) {
      console.log('Row ' + editedRow + ': ' + cfg.eventName + ' already sent, skipping');
      return;
    }

    fireDownstreamEvent(sheet, editedRow, cfg);
  } catch (err) {
    console.error('onSheetEdit fatal: ' + err.message + '\n' + (err.stack || ''));
  }
}

/* ============================================================
   Core: read row, build payload, POST to Meta, stamp row
   ============================================================ */

function fireDownstreamEvent(sheet, row, cfg) {
  const rowData = sheet.getRange(row, 1, 1, COL_COUNT).getValues()[0];

  // Required fields gate.
  const leadId = stringAt(rowData, COL.LEAD_ID);
  const email = stringAt(rowData, COL.EMAIL);
  if (!leadId) {
    logError(row, cfg.eventName, 0, 'Missing lead_id in row', 0);
    return;
  }
  if (!email) {
    logError(row, cfg.eventName, 0, 'Missing email in row', 0);
    return;
  }

  // Deterministic event_id: {leadId}_{suffix}. Stable across retries.
  const eventId = leadId + '_' + cfg.eventIdSuffix;

  // event_time: prefer the time column the sales team filled. Fall back to now.
  const timeValue = rowData[cfg.timeCol - 1];
  const eventTime = (timeValue instanceof Date && !isNaN(timeValue.getTime()))
    ? Math.floor(timeValue.getTime() / 1000)
    : Math.floor(Date.now() / 1000);

  // user_data — the EMQ payload.
  const userData = buildUserData(rowData);

  // custom_data — reporting metadata (not part of EMQ).
  const customData = {
    payment_id: leadId,
  };
  if (cfg.includeValue) {
    const valueRaw = rowData[cfg.valueCol - 1];
    const value = Number(valueRaw);
    if (!isFinite(value) || value <= 0) {
      logError(row, cfg.eventName, 0,
        'Invalid contracted_value: "' + valueRaw + '"; must be a positive integer', 0);
      return;
    }
    customData.currency = 'INR';
    customData.value = value;
  }
  // Forward useful UTM context for Ads Manager filtering.
  copyIfPresent(customData, 'utm_source',   stringAt(rowData, COL.UTM_SOURCE));
  copyIfPresent(customData, 'utm_medium',   stringAt(rowData, COL.UTM_MEDIUM));
  copyIfPresent(customData, 'utm_campaign', stringAt(rowData, COL.UTM_CAMPAIGN));
  copyIfPresent(customData, 'utm_content',  stringAt(rowData, COL.UTM_CONTENT));
  copyIfPresent(customData, 'utm_term',     stringAt(rowData, COL.UTM_TERM));
  copyIfPresent(customData, 'fbclid',       stringAt(rowData, COL.FBCLID));

  // event_source_url: prefer the row's stored URL, then PropertiesService default.
  const eventSourceUrl =
    stringAt(rowData, COL.EVENT_SOURCE_URL) ||
    PropertiesService.getScriptProperties().getProperty('EVENT_SOURCE_URL_DEFAULT') ||
    '';

  const eventBody = {
    event_name: cfg.eventName,
    event_time: eventTime,
    event_id: eventId,
    action_source: 'website',
    event_source_url: eventSourceUrl,
    user_data: userData,
    custom_data: customData,
  };

  const result = postToMetaCapi({ data: [eventBody] });

  if (result.ok) {
    // Stamp success. We write the STRING 'TRUE' (not boolean true) so it
    // renders correctly in dropdown cells that have data validation list
    // {TRUE, FALSE}. Reading is handled by isTruthy() which accepts either.
    sheet.getRange(row, cfg.eventIdCol).setValue(eventId);
    sheet.getRange(row, cfg.sentCol).setValue('TRUE');
    console.log('Row ' + row + ' ' + cfg.eventName + ' OK | event_id=' + eventId
      + ' attempts=' + (result.retryCount + 1));
  } else {
    logError(row, cfg.eventName, result.status, result.body, result.retryCount);
  }
}

/* ============================================================
   user_data construction — hashing + normalization
   ============================================================ */

function buildUserData(rowData) {
  const out = {};

  // Email → em + external_id share the same hash for cross-channel matching.
  const emailNorm = stringAt(rowData, COL.EMAIL).toLowerCase();
  if (emailNorm) {
    const emHash = sha256Hex(emailNorm);
    out.em = [emHash];
    out.external_id = [emHash];
  }

  // Phone → digits only (E.164 without +).
  const phoneNorm = stringAt(rowData, COL.PHONE).replace(/\D/g, '');
  if (phoneNorm) out.ph = [sha256Hex(phoneNorm)];

  // First name.
  const fnNorm = stringAt(rowData, COL.FIRST_NAME).toLowerCase();
  if (fnNorm) out.fn = [sha256Hex(fnNorm)];

  // Last name.
  const lnNorm = stringAt(rowData, COL.LAST_NAME).toLowerCase();
  if (lnNorm) out.ln = [sha256Hex(lnNorm)];

  // City → lowercase, strip everything that isn't a-z (per Meta spec).
  const ctNorm = stringAt(rowData, COL.CITY).toLowerCase().replace(/[^a-z]/g, '');
  if (ctNorm) out.ct = [sha256Hex(ctNorm)];

  // Country → 2-letter ISO, lowercase.
  const countryNorm = stringAt(rowData, COL.COUNTRY_CODE).toLowerCase();
  if (countryNorm) out.country = [sha256Hex(countryNorm)];

  // Raw context — never hashed.
  const fbc = stringAt(rowData, COL.FBC);
  if (fbc) out.fbc = fbc;

  const fbp = stringAt(rowData, COL.FBP);
  if (fbp) out.fbp = fbp;

  const ip = stringAt(rowData, COL.CLIENT_IP_ADDRESS);
  if (ip) out.client_ip_address = ip;

  const ua = stringAt(rowData, COL.CLIENT_USER_AGENT);
  if (ua) out.client_user_agent = ua;

  return out;
}

/* ============================================================
   HTTP — POST to Meta with retry/backoff on 429 + 5xx
   ============================================================ */

function postToMetaCapi(payload) {
  const props = PropertiesService.getScriptProperties();
  const pixelId = props.getProperty('META_PIXEL_ID');
  const accessToken = props.getProperty('META_CAPI_ACCESS_TOKEN');
  const apiVersion = props.getProperty('META_GRAPH_API_VERSION') || GRAPH_API_VERSION_DEFAULT;

  if (!pixelId || !accessToken) {
    return {
      ok: false,
      status: 0,
      body: 'Missing META_PIXEL_ID or META_CAPI_ACCESS_TOKEN in Script Properties',
      retryCount: 0,
    };
  }

  const url = 'https://graph.facebook.com/' + apiVersion + '/' + pixelId + '/events'
    + '?access_token=' + encodeURIComponent(accessToken);

  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  let lastStatus = 0;
  let lastBody = '';

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let status = 0;
    let body = '';
    try {
      const response = UrlFetchApp.fetch(url, options);
      status = response.getResponseCode();
      body = response.getContentText();
    } catch (err) {
      // Network/timeout → treat as retryable transient.
      status = 0;
      body = 'UrlFetchApp threw: ' + err.message;
    }
    lastStatus = status;
    lastBody = body;

    if (status >= 200 && status < 300) {
      return { ok: true, status: status, body: body, retryCount: attempt };
    }

    // Retry only on 0 (network), 429 (rate limit), or 5xx (server).
    const retryable = (status === 0 || status === 429 || status >= 500);
    if (retryable && attempt < MAX_RETRIES - 1) {
      Utilities.sleep(Math.pow(2, attempt) * 1000); // 1s, 2s, 4s
      continue;
    }
    break;
  }

  return {
    ok: false,
    status: lastStatus,
    body: lastBody,
    retryCount: MAX_RETRIES,
  };
}

/* ============================================================
   Error logging — append to _Errors tab
   ============================================================ */

function logError(row, eventType, status, body, retryCount) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const errSheet = ss.getSheetByName(ERROR_SHEET_NAME);
    if (!errSheet) {
      console.error('Cannot log to _Errors: tab not found. Create it with header: '
        + 'timestamp | row_number | event_type | http_status | response_body | retry_count');
      return;
    }

    const timestamp = Utilities.formatDate(
      new Date(),
      Session.getScriptTimeZone() || 'Asia/Kolkata',
      "yyyy-MM-dd'T'HH:mm:ssXXX"
    );
    const safeBody = (body == null ? '' : String(body)).substring(0, 500);

    errSheet.appendRow([
      timestamp,
      row,
      eventType,
      status,
      safeBody,
      retryCount,
    ]);

    console.warn('Row ' + row + ' ' + eventType + ' FAILED | status=' + status
      + ' | body=' + safeBody);
  } catch (err) {
    console.error('Failed to log error to _Errors: ' + err.message);
  }
}

/* ============================================================
   Setup — run once after first paste-in
   ============================================================ */

function setupTriggers() {
  // Remove any existing onSheetEdit triggers to avoid duplicates.
  const triggers = ScriptApp.getProjectTriggers();
  let removed = 0;
  for (const t of triggers) {
    if (t.getHandlerFunction() === 'onSheetEdit') {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  }

  // Install a fresh installable onEdit trigger bound to this spreadsheet.
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ScriptApp.newTrigger('onSheetEdit')
    .forSpreadsheet(ss)
    .onEdit()
    .create();

  const msg = 'setupTriggers OK — removed ' + removed + ' old, installed 1 new onSheetEdit trigger';
  console.log(msg);
  SpreadsheetApp.getActive().toast(msg, 'Arjun CRM', 5);
}

/* ============================================================
   Recovery — manually re-fire any pending events
   Run from Apps Script editor when a row's flag wasn't set due to an
   earlier failure and you've already toggled the dropdown.
   ============================================================ */

function replayPendingEvents() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(getMainSheetName());
  if (!sheet) {
    console.error('Main sheet not found: ' + getMainSheetName());
    return;
  }
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const data = sheet.getRange(2, 1, lastRow - 1, COL_COUNT).getValues();
  let replayed = 0;

  for (let i = 0; i < data.length; i++) {
    const row = i + 2;
    const rowData = data[i];

    for (const key of Object.keys(EVENTS)) {
      const cfg = EVENTS[key];
      const triggered = isTruthy(rowData[cfg.triggerCol - 1]);
      const alreadySent = isTruthy(rowData[cfg.sentCol - 1]);
      if (triggered && !alreadySent) {
        console.log('Replaying row ' + row + ' ' + cfg.eventName);
        fireDownstreamEvent(sheet, row, cfg);
        replayed++;
        Utilities.sleep(500); // pacing — gentle to Meta API
      }
    }
  }
  console.log('replayPendingEvents finished — replayed ' + replayed + ' event(s)');
  SpreadsheetApp.getActive().toast('Replayed ' + replayed + ' pending event(s)', 'Arjun CRM', 5);
}

/* ============================================================
   Helpers
   ============================================================ */

function getMainSheetName() {
  return PropertiesService.getScriptProperties().getProperty('MAIN_SHEET_NAME')
    || MAIN_SHEET_NAME_DEFAULT;
}

function isTruthy(v) {
  return v === true || v === 'TRUE' || v === 'True' || v === 'true';
}

function stringAt(rowData, col1Indexed) {
  const v = rowData[col1Indexed - 1];
  return (v == null) ? '' : String(v).trim();
}

function copyIfPresent(obj, key, value) {
  if (value) obj[key] = value;
}

function sha256Hex(value) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    value,
    Utilities.Charset.UTF_8
  );
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    let b = bytes[i];
    if (b < 0) b += 256;
    const h = b.toString(16);
    hex += (h.length === 1 ? '0' : '') + h;
  }
  return hex;
}
