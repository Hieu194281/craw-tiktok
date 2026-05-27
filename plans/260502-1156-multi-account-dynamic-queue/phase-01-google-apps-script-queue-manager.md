# Phase 1: Google Apps Script Queue Manager

## Context Links
- [Brainstorm Report](../reports/brainstorm-260502-1156-multi-account-dynamic-queue.md)
- [Current GAS code](../../google-apps-script.gs) — 73 lines, single `doPost`/`doGet`
- [Plan overview](plan.md)

## Overview
- **Priority**: P1 (blocks Phase 3)
- **Status**: Pending
- **Effort**: 3h
- **Description**: Rewrite `google-apps-script.gs` to support queue management with 6 endpoints: `pushOrders`, `claimBatch`, `submitResult`, `releaseOrders`, `status`, `test`. Use LockService for concurrency. Add "Queue" sheet alongside existing "Results" sheet.

## Key Insights
- Current GAS (line 20-73) uses single `doPost` that writes directly to active sheet. Must be replaced with action-routed handler.
- `doGet` (line 15-17) currently only returns `{ status: 'ready' }`. Must be extended to route `action` query param.
- Google Apps Script `LockService.getScriptLock()` has 30s max wait. Batch claim + write must complete well within this.
- `appendRow` is slow for bulk ops — use `getRange().setValues()` for `pushOrders`.

## Requirements

### Functional
- **pushOrders**: Accept array of order numbers, dedup against existing Queue entries, write new ones with status=`pending`
- **claimBatch**: Atomically claim next N (default 10) `pending` orders for a given `profileId`, set status=`claimed` + timestamp
- **submitResult**: Write extracted data to Results sheet, mark Queue order as `done`
- **releaseOrders**: Reset specified order numbers back to `pending` (used on rate limit or stop)
- **status**: Return counts: `{ total, pending, claimed, done, failed }`
- **test**: Return `{ status: 'ready' }` (backward compatible)
- **Stale claim recovery**: Orders claimed >15min ago auto-release on any `claimBatch` call

### Non-Functional
- Lock held <5s per request
- Handle concurrent requests from 4 profiles without data loss
- Dedup order numbers on push (idempotent)

## Architecture / Design

### Sheet Structure

**Sheet: "Queue"** (new)
| Column | Index | Content |
|--------|-------|---------|
| A | 1 | orderNo (string, `@` format) |
| B | 2 | status (`pending`/`claimed`/`done`/`failed`) |
| C | 3 | claimedBy (profileId string) |
| D | 4 | claimedAt (ISO timestamp or empty) |

**Sheet: "Results"** (replaces current active sheet)
| Column | Index | Content |
|--------|-------|---------|
| A | 1 | orderNo |
| B | 2 | name |
| C | 3 | phone |
| D | 4 | address |
| E | 5 | profile |
| F | 6 | timestamp |

### Request/Response Formats

**doPost routing** — all POST requests include `action` in JSON body:
```js
// POST body: { action: "pushOrders", orders: ["123...", "456..."] }
// POST body: { action: "claimBatch", profileId: "profile-abc123", batchSize: 10 }
// POST body: { action: "submitResult", orderNo: "123...", name: "...", phone: "...", address: "...", profile: "..." }
// POST body: { action: "releaseOrders", orders: ["123...", "456..."] }
```

**doGet routing** — `action` in query param:
```
// GET ?action=status  →  { status: "ok", total: 100, pending: 40, claimed: 10, done: 45, failed: 5 }
// GET ?action=test    →  { status: "ready" }
// GET (no action)     →  { status: "ready" }   // backward compatible
```

### Concurrency Model
```
claimBatch request arrives
  → LockService.getScriptLock().tryLock(10000)
  → Release stale claims (claimedAt > 15min ago → set status=pending)
  → Find first N rows with status=pending
  → Set status=claimed, claimedBy=profileId, claimedAt=now
  → Release lock
  → Return claimed order numbers
```

## Related Code Files
- **Modify**: `google-apps-script.gs` (complete rewrite, keep backward-compatible `test` endpoint)

## Implementation Steps

### 1. Sheet setup helpers
```js
function getOrCreateSheet(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  }
  return sheet;
}

var QUEUE_HEADERS = ['orderNo', 'status', 'claimedBy', 'claimedAt'];
var RESULTS_HEADERS = ['orderNo', 'name', 'phone', 'address', 'profile', 'timestamp'];
```

### 2. doGet — route by action param
```js
function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || 'test';
  if (action === 'status') return jsonResponse(getStatus());
  return jsonResponse({ status: 'ready' });
}
```

### 3. doPost — route by action in body
```js
function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents);
    var action = payload.action;
    switch (action) {
      case 'pushOrders':   return jsonResponse(pushOrders(payload.orders));
      case 'claimBatch':   return jsonResponse(claimBatch(payload.profileId, payload.batchSize || 10));
      case 'submitResult': return jsonResponse(submitResult(payload));
      case 'releaseOrders':return jsonResponse(releaseOrders(payload.orders));
      default:             return jsonResponse(legacySubmit(payload)); // backward compat
    }
  } catch (err) {
    return jsonResponse({ status: 'error', message: err.message });
  }
}
```
Note: `default` case calls `legacySubmit` which mimics old `doPost` behavior (direct write to Results) for backward compatibility with extensions that haven't updated yet.

### 4. pushOrders — bulk insert to Queue
```js
function pushOrders(orderNos) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = getOrCreateSheet('Queue', QUEUE_HEADERS);
    var lastRow = sheet.getLastRow();
    var existing = new Set();
    if (lastRow > 1) {
      sheet.getRange(2, 1, lastRow - 1, 1).getValues().forEach(function(r) {
        existing.add(String(r[0]));
      });
    }
    var newOrders = orderNos.filter(function(o) { return !existing.has(String(o)); });
    if (newOrders.length > 0) {
      var rows = newOrders.map(function(o) { return [String(o), 'pending', '', '']; });
      sheet.getRange(lastRow + 1, 1, rows.length, 4).setValues(rows);
      // Format orderNo column as text
      sheet.getRange(lastRow + 1, 1, rows.length, 1).setNumberFormat('@');
    }
    return { status: 'ok', added: newOrders.length, duplicate: orderNos.length - newOrders.length };
  } finally {
    lock.releaseLock();
  }
}
```

### 5. claimBatch — atomic claim with stale recovery
```js
function claimBatch(profileId, batchSize) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = getOrCreateSheet('Queue', QUEUE_HEADERS);
    var lastRow = sheet.getLastRow();
    if (lastRow <= 1) return { status: 'ok', orders: [] };

    var data = sheet.getRange(2, 1, lastRow - 1, 4).getValues();
    var now = new Date().getTime();
    var staleMs = 15 * 60 * 1000; // 15 minutes
    var claimed = [];

    for (var i = 0; i < data.length; i++) {
      // Release stale claims
      if (data[i][1] === 'claimed' && data[i][3]) {
        var claimedTime = new Date(data[i][3]).getTime();
        if (now - claimedTime > staleMs) {
          data[i][1] = 'pending';
          data[i][2] = '';
          data[i][3] = '';
        }
      }
      // Claim pending orders
      if (data[i][1] === 'pending' && claimed.length < batchSize) {
        data[i][1] = 'claimed';
        data[i][2] = profileId;
        data[i][3] = new Date().toISOString();
        claimed.push(String(data[i][0]));
      }
    }

    sheet.getRange(2, 1, data.length, 4).setValues(data);
    return { status: 'ok', orders: claimed };
  } finally {
    lock.releaseLock();
  }
}
```

### 6. submitResult — write to Results, mark Queue as done
```js
function submitResult(payload) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    // Write to Results sheet
    var results = getOrCreateSheet('Results', RESULTS_HEADERS);
    results.appendRow([
      String(payload.orderNo),
      payload.name || '',
      payload.phone || '',
      payload.address || '',
      payload.profile || '',
      new Date().toLocaleString('vi-VN')
    ]);
    var newRow = results.getLastRow();
    results.getRange(newRow, 1).setNumberFormat('@');

    // Mark as done in Queue
    var queue = getOrCreateSheet('Queue', QUEUE_HEADERS);
    var lastRow = queue.getLastRow();
    if (lastRow > 1) {
      var orders = queue.getRange(2, 1, lastRow - 1, 1).getValues();
      for (var i = 0; i < orders.length; i++) {
        if (String(orders[i][0]) === String(payload.orderNo)) {
          queue.getRange(i + 2, 2).setValue('done');
          break;
        }
      }
    }
    return { status: 'ok' };
  } finally {
    lock.releaseLock();
  }
}
```

### 7. releaseOrders — return orders to pending
```js
function releaseOrders(orderNos) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = getOrCreateSheet('Queue', QUEUE_HEADERS);
    var lastRow = sheet.getLastRow();
    if (lastRow <= 1) return { status: 'ok', released: 0 };

    var data = sheet.getRange(2, 1, lastRow - 1, 4).getValues();
    var releaseSet = new Set(orderNos.map(String));
    var released = 0;

    for (var i = 0; i < data.length; i++) {
      if (releaseSet.has(String(data[i][0])) && data[i][1] === 'claimed') {
        data[i][1] = 'pending';
        data[i][2] = '';
        data[i][3] = '';
        released++;
      }
    }

    sheet.getRange(2, 1, data.length, 4).setValues(data);
    return { status: 'ok', released: released };
  } finally {
    lock.releaseLock();
  }
}
```

### 8. getStatus + legacySubmit
```js
function getStatus() {
  var sheet = getOrCreateSheet('Queue', QUEUE_HEADERS);
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return { status: 'ok', total: 0, pending: 0, claimed: 0, done: 0, failed: 0 };

  var statuses = sheet.getRange(2, 2, lastRow - 1, 1).getValues().flat();
  var counts = { total: statuses.length, pending: 0, claimed: 0, done: 0, failed: 0 };
  statuses.forEach(function(s) { if (counts.hasOwnProperty(s)) counts[s]++; });
  return counts;
}

// Backward compat: old extension sends { orderNo, name, phone, address, profile } without action
function legacySubmit(payload) {
  var items = Array.isArray(payload) ? payload : [payload];
  var results = getOrCreateSheet('Results', RESULTS_HEADERS);
  // ... (same logic as current doPost lines 27-64)
}
```

### 9. Utility
```js
function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
```

## Todo List
- [ ] Rewrite `doGet` with action routing (test, status)
- [ ] Rewrite `doPost` with action routing (pushOrders, claimBatch, submitResult, releaseOrders, legacy)
- [ ] Implement `getOrCreateSheet` helper
- [ ] Implement `pushOrders` with dedup + LockService
- [ ] Implement `claimBatch` with stale recovery + LockService
- [ ] Implement `submitResult` with Queue status update
- [ ] Implement `releaseOrders` for rate limit / stop scenarios
- [ ] Implement `getStatus` for progress tracking
- [ ] Implement `legacySubmit` for backward compat (no `action` field)
- [ ] Implement `jsonResponse` utility
- [ ] Test with manual curl/fetch calls
- [ ] Verify concurrent access with 2+ simultaneous claims

## Success Criteria
- `pushOrders` with 100 order numbers completes <5s, dedup works
- Two simultaneous `claimBatch` calls return non-overlapping orders
- `submitResult` writes to Results AND marks Queue as done
- `releaseOrders` returns claimed orders to pending
- `status` returns accurate counts
- Old extension (no `action` field) still works via `legacySubmit`

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| LockService timeout under load | Low | Medium | 10s timeout, batch size limited to 10 |
| `appendRow` slow for 200+ orders | Medium | Low | Use `setValues` for bulk pushOrders |
| Sheet size limits | Low | Low | Queue rarely exceeds 500 rows/day, can add cleanup |
| GAS execution time limit (6min) | Low | Low | Each request <5s, no long-running ops |

## Security Considerations
- Web app deployed as "Anyone" — no auth. Acceptable for internal tool.
- Order numbers are not PII. Phone/name go to Results sheet which is access-controlled by Google Sheet sharing.
- LockService prevents race conditions but not malicious requests. Low risk for internal use.

## Next Steps
- Blocks Phase 3 (Dynamic Batch Processing)
- After completing, test endpoints manually before integrating with extension
