# Code Review: Multi-Account Dynamic Queue Implementation

**Date**: 2026-05-02
**Reviewer**: code-reviewer
**Files**: `google-apps-script.gs`, `content.js`, `popup.js`, `popup.html`, `manifest.json`
**LOC**: ~1090 total (250 GAS + 673 content + 439 popup + 307 HTML + 23 manifest)
**Focus**: Full review — logic correctness, race conditions, security, error handling, edge cases

---

## Overall Assessment

Solid implementation of a Google Sheet-backed queue coordination system. The GAS backend uses `LockService` correctly for concurrency, backward compatibility with local-only mode is preserved, and the content script has multi-strategy DOM extraction with sensible fallbacks. However, there are several **critical** and **high-priority** issues around race conditions in the content script, XSS via innerHTML, unvalidated external input, and stale state reads that could cause production bugs.

---

## Critical Issues (Blocking)

### C1. XSS via `innerHTML` in `popup.js:renderData()` (line 71-82)

**File**: `popup.js` lines 71-82

User-controlled data (`item.name`, `item.address`, `item.orderNo`) from TikTok DOM extraction is concatenated directly into HTML via `innerHTML`. A crafted or malformed order name like `<img src=x onerror=alert(1)>` would execute arbitrary JS in the extension popup context.

**Impact**: Extension popup runs with `chrome.storage` and `chrome.tabs` permissions. XSS here gives attacker access to stored data and tab manipulation.

**Fix**: Use `textContent` or DOM APIs instead of string concatenation:
```js
function renderData(data) {
  if (!data || data.length === 0) {
    dataTable.textContent = '';
    const msg = document.createElement('div');
    msg.className = 'empty-msg';
    msg.textContent = 'Chua co du lieu';
    dataTable.appendChild(msg);
    btnExport.disabled = true;
    return;
  }
  btnExport.disabled = false;
  dataTable.textContent = '';
  const table = document.createElement('table');
  // ... build rows with createElement/textContent
}
```

---

### C2. Stale state race condition in `content.js:processOrderDetail()` (lines 451-568)

**File**: `content.js` lines 451-453, 462-479

The function reads `state = await chrome.storage.local.get(null)` once at the top, then uses `state.currentBatch` and `state.batchIndex` throughout, including passing `state` to `advanceToNext()`. Between the initial read and the `advanceToNext()` call (which itself does storage writes and navigations), **5-10 seconds elapse** (multiple `sleep()` calls, network waits). If the user clicks Stop in the popup during this window, the popup sets `isRunning: false` but the content script still proceeds with stale state and navigates to the next order.

**Impact**: User clicks Stop but processing continues. Batch index written by content script overwrites the popup's stop state.

**Fix**: Re-read `isRunning` from storage before navigation in `advanceToNext()`:
```js
async function advanceToNext(state, queueMode, success) {
  // Check if user stopped during processing
  const currentState = await chrome.storage.local.get(['isRunning']);
  if (!currentState.isRunning) {
    log('Dung boi nguoi dung.');
    if (queueMode) {
      const batch = state.currentBatch || [];
      const batchIdx = (state.batchIndex || 0) + 1;
      await releaseRemainingOrders(state.sheetUrl, batch, batchIdx);
    }
    notifyPopup();
    return;
  }
  // ... rest of navigation logic
}
```

---

### C3. Order number injection into URL without validation (content.js lines 597, 602, 614)

**File**: `content.js` lines 597, 602, 614; `popup.js` lines 322, 341

Order numbers from the Google Sheet queue are concatenated directly into URLs:
```js
window.location.href = 'https://seller-vn.tiktok.com/order/detail?order_no=' + batch[nextBatchIdx] + '&shop_region=VN';
```

If a malicious actor has write access to the shared Google Sheet and inserts a value like `123&redirect=evil.com`, it would manipulate the URL query. More critically, while TikTok's server-side will likely reject bad order_no values, there is no client-side validation that order numbers match the expected `^\d{17,19}$` format.

**Impact**: Low probability (requires Sheet write access) but defense-in-depth violation. Could cause unexpected navigation behavior.

**Fix**: Validate order numbers before using them:
```js
function isValidOrderNo(orderNo) {
  return /^\d{17,19}$/.test(String(orderNo));
}
// Before navigation:
if (!isValidOrderNo(currentOrder)) {
  log('Ma don khong hop le: ' + currentOrder, 'error');
  await advanceToNext(state, queueMode, false);
  return;
}
```

---

## High Priority Issues

### H1. GAS `pushOrders()` does not validate input array (google-apps-script.gs line 68)

**File**: `google-apps-script.gs` line 68

`pushOrders(orderNos)` receives the array directly from the HTTP POST body with no validation. If `orderNos` is `null`, `undefined`, or a non-array, the function crashes. If entries contain non-string evil content, it gets written to the Sheet.

**Fix**:
```js
function pushOrders(orderNos) {
  if (!Array.isArray(orderNos) || orderNos.length === 0) {
    return { status: 'error', message: 'orders must be a non-empty array' };
  }
  // Validate each order number
  orderNos = orderNos.map(String).filter(function(o) {
    return /^\d{17,19}$/.test(o);
  });
  if (orderNos.length === 0) return { status: 'ok', added: 0, duplicate: 0 };
  // ... rest of function
}
```

### H2. GAS `claimBatch` / `submitResult` do not validate `profileId` (google-apps-script.gs lines 95, 136)

**File**: `google-apps-script.gs` lines 55, 95

`profileId` is written directly to the Sheet with no sanitation. A crafted profileId could contain formulas (`=IMPORTRANGE(...)`) that execute in Google Sheets context (CSV/formula injection).

**Fix**: Prefix with apostrophe or validate format:
```js
profileId = String(profileId || '').replace(/^[=+\-@]/, "'$&").slice(0, 50);
```

### H3. `processOrderDetail()` does not await `processOrderDetail()` in `init()` (content.js line 667)

**File**: `content.js` lines 661-672

```js
async function init() {
  ...
  if (state.isRunning) {
    await sleep(2000);
    processOrderDetail(); // NOT awaited
  }
}
init(); // also NOT awaited
```

`processOrderDetail()` is a fire-and-forget async call. Unhandled promise rejections from it will crash silently. While the function has its own try/catch, any error in the preamble (before the try block, e.g. `chrome.storage.local.get` failing) would be an unhandled rejection.

**Fix**: Add error boundary:
```js
processOrderDetail().catch(err => {
  log('Loi xu ly don: ' + err.message, 'error');
});
```

### H4. Duplicate extraction data not properly deduplicated (content.js lines 543-547)

**File**: `content.js` lines 543-547

```js
const extractedData = state.extractedData || [];
if (!extractedData.find((d) => d.orderNo === data.orderNo)) {
  extractedData.push(data);
}
await chrome.storage.local.set({ extractedData });
```

This reads `extractedData` from stale state (read at line 452). If the user has another tab extracting concurrently (multi-profile scenario), each tab reads an old snapshot and overwrites the other's data.

**Impact**: In local-only mode this is unlikely (single tab). In queue mode, each profile runs in separate Chrome profile, so separate storage. Low risk but worth noting for future changes.

### H5. `btnStop` releases from `batchIndex` instead of `batchIndex + 1` (popup.js line 354)

**File**: `popup.js` lines 353-354

```js
const remaining = (state.currentBatch || []).slice(state.batchIndex || 0);
```

This releases the **current** order being processed (at `batchIndex`). Meanwhile `content.js` rate limit handler at line 531 uses `batchIndex + 1` because it already processed the current order. The Stop button should also skip the current order if it's mid-processing:

**Impact**: The current order may get released back to pending even though it was already navigated to (or partially extracted). Another profile could then claim and re-extract it.

**Fix**: Use `batchIndex + 1` when the order at `batchIndex` may already be in progress:
```js
const remaining = (state.currentBatch || []).slice((state.batchIndex || 0) + 1);
```

### H6. `getStatus()` counts only known status values; unknown statuses silently ignored (google-apps-script.gs line 211)

**File**: `google-apps-script.gs` line 211

```js
statuses.forEach(function(s) { if (counts.hasOwnProperty(s)) counts[s]++; });
```

This uses `hasOwnProperty` on the `counts` object, which also has `status` and `total` as properties. If a cell somehow contains "status" or "total" as its value, it would increment those fields. More importantly, `hasOwnProperty` is inherited and could be overridden.

**Fix**: Use explicit list:
```js
var validStatuses = { pending: true, claimed: true, done: true, failed: true };
statuses.forEach(function(s) { if (validStatuses[s]) counts[s]++; });
```

---

## Medium Priority Issues

### M1. `legacySubmit` unbounded `appendRow` loop (google-apps-script.gs lines 230-246)

**File**: `google-apps-script.gs` lines 230-246

For each item in the legacy payload, `appendRow()` is called individually inside a loop. With a large batch, this causes N Sheets API calls within a single request, which could hit GAS execution time limits (6 min for web apps).

Additionally, `legacySubmit` does NOT use `LockService`, unlike all other write functions. Concurrent legacy submissions could cause race conditions.

**Fix**: Batch writes with `setValues()` and add locking:
```js
function legacySubmit(payload) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    // ... batch logic with setValues()
  } finally {
    lock.releaseLock();
  }
}
```

### M2. No timeout/retry on `fetch()` calls to Google Apps Script (content.js, popup.js)

All `fetch()` calls to the GAS API have no timeout configuration. GAS cold starts can take 10-30 seconds. If the GAS endpoint is slow or down, the extension hangs indefinitely.

**Fix**: Use `AbortController` with timeout:
```js
async function callSheetAPI(sheetUrl, action, data) {
  if (!sheetUrl) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(sheetUrl, {
      method: 'POST', signal: controller.signal, ...
    });
    clearTimeout(timeout);
    return await response.json();
  } catch (err) { ... }
}
```

### M3. `collectOrdersMultiPage()` has no stop check (content.js lines 139-183)

While paginating, there's no check for `isRunning` state. If user clicks Stop during multi-page collection, the collection loop continues until all pages are scraped.

### M4. `chrome.runtime.sendMessage` can throw if popup is closed (content.js lines 13, 17)

**File**: `content.js` lines 12-13, 16-17

```js
chrome.runtime.sendMessage({ type: 'log', text, logType });
chrome.runtime.sendMessage({ type: 'stateChanged' });
```

If the popup is closed (which is the normal state during extraction), these calls throw `Could not establish connection. Receiving end does not exist.` errors. They are not caught.

**Fix**: Add error suppression:
```js
function log(text, logType) {
  console.log('[TikTok Extractor]', text);
  chrome.runtime.sendMessage({ type: 'log', text, logType }).catch(() => {});
}

function notifyPopup() {
  chrome.runtime.sendMessage({ type: 'stateChanged' }).catch(() => {});
}
```

### M5. `extractedData` cleared on Start but not across batches in queue mode (popup.js line 315)

**File**: `popup.js` line 315

When starting queue mode, `extractedData` is reset to `[]`. But across batches (when content.js auto-claims next batch), the `extractedData` continues to grow in local storage without bound. After hundreds of orders, this could hit Chrome's `storage.local` 10MB limit.

### M6. CSV export formula injection (popup.js lines 383)

**File**: `popup.js` line 383

```js
'="' + (item.orderNo || '') + '"',
```

The `="..."` pattern is used to preserve long numbers in Excel, but other fields (`name`, `address`) could contain formula-triggering characters (`=`, `+`, `-`, `@`). While `address` and `name` are wrapped in quotes and have `""` escaping for double quotes, a value starting with `=` inside quotes can still execute in some spreadsheet apps.

---

## Low Priority Issues

### L1. `profileId` generated with Math.random() (popup.js line 42)

`Math.random()` is not cryptographically secure. For a profile identifier that's shared with other users via Google Sheet, collision probability is low but `crypto.getRandomValues()` would be more robust.

### L2. `simulateClick()` defined but `findClickTarget()` defined later (content.js)

Minor readability: `simulateClick` at line 207 is referenced in `collectOrdersMultiPage` at line 168 before `findClickTarget` at line 217. Not a bug (hoisting works within the IIFE), but reordering for readability would help.

### L3. Hardcoded `shop_region=VN` in navigation URLs (content.js lines 597, 602, 614)

Region is hardcoded. If this extension is ever used for other TikTok seller regions, all navigation will break.

### L4. No visual indication of queue mode vs local mode in popup

The `orderRange` text shows "Queue mode" but buttons and flow are identical. User might not realize which mode is active.

---

## Edge Cases Found by Scouting

1. **Empty batch after claim**: Handled correctly (lines 468-471 content.js, lines 308-310 popup.js)
2. **Rate limit mid-batch**: Handled correctly -- releases remaining, saves partial data, sets `rateLimited` flag
3. **Sheet URL removed after queue mode started**: `queueMode` flag persists in storage even if Sheet URL is cleared. `claimNextBatch` would fail silently, returning empty array, causing premature "done"
4. **GAS LockService 10s timeout exceeded**: If the lock can't be acquired in 10s, `waitLock` throws. The top-level `doPost` catch returns error JSON. Extension should handle this gracefully -- currently it does via `callSheetAPI` null return
5. **Page count > actual pages**: Handled -- `findNextButton()` returns null, loop breaks (line 162)
6. **Concurrent `pushOrders` with same order list**: Handled by `LockService` + `existing` Set check
7. **GAS `getLastRow()` returns 1 on empty sheet with headers**: Correctly handled with `lastRow <= 1` checks
8. **User navigates away during processing**: `init()` re-checks `isRunning` on page load, continues processing

---

## Positive Observations

- **LockService usage** in GAS is correct and consistent across all write operations (except `legacySubmit` -- see M1)
- **Multi-strategy DOM extraction** with 3 fallback levels for order numbers and eye icons is resilient
- **Backward compatibility** is clean -- local-only mode works when Sheet URL is not configured
- **Rate limit detection and recovery** is well thought out (detect, dismiss modal, release batch, stop)
- **Stale claim timeout** (15 min) provides crash recovery without manual intervention
- **`String()` coercion** consistently applied to order numbers avoids type mismatch bugs
- **Number format `@`** applied to order number cells prevents Sheets from truncating long numbers

---

## Recommended Actions (Priority Order)

1. **[CRITICAL] Fix XSS in `renderData()`** -- replace `innerHTML` with DOM API (C1)
2. **[CRITICAL] Add `isRunning` re-check before navigation** in `advanceToNext()` (C2)
3. **[CRITICAL] Validate order numbers** before URL construction (C3)
4. **[HIGH] Add input validation** in GAS endpoints: `pushOrders`, `claimBatch`, `submitResult` (H1, H2)
5. **[HIGH] Add `.catch()` to fire-and-forget promises** in content.js (H3, M4)
6. **[HIGH] Fix Stop button release offset** -- use `batchIndex + 1` (H5)
7. **[MEDIUM] Add LockService to `legacySubmit`** and batch the writes (M1)
8. **[MEDIUM] Add fetch timeout** via AbortController (M2)
9. **[LOW] Consider data pruning strategy** for `extractedData` growth (M5)

---

## Metrics

| Metric | Value |
|--------|-------|
| Type Coverage | N/A (vanilla JS) |
| Test Coverage | 0% (no test files found) |
| Linting Issues | Not run (no linter config) |
| Security Issues | 3 Critical, 2 High |
| Logic Issues | 2 Critical, 3 High |

---

## Unresolved Questions

1. Is `legacySubmit` still actively used by old extension installations? If so, the missing LockService (M1) is more urgent.
2. Should `extractedData` be bounded or periodically flushed to Sheet-only storage in queue mode?
3. Is there a plan for test coverage? The planner report mentions 37 test cases but no test files exist.
4. Should the GAS web app have any authentication (API key header) or is "Anyone with link" acceptable for this use case?

---

**Status:** DONE
**Summary:** Found 3 critical issues (XSS in renderData, stale state race condition in processOrderDetail, unvalidated order numbers in URLs), 6 high-priority issues, and 6 medium/low issues. Core queue/batch logic is sound; GAS concurrency control is correctly implemented. Main risks are in client-side input handling and state synchronization.
