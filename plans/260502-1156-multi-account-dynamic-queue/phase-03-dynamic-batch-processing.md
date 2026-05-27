# Phase 3: Dynamic Batch Processing

## Context Links
- [Phase 1: GAS Queue Manager](phase-01-google-apps-script-queue-manager.md) — **must complete first**
- [Current content.js](../../content.js) — `processOrderDetail()` at lines 355-444, `sendToGoogleSheet()` at lines 323-351
- [Plan overview](plan.md)

## Overview
- **Priority**: P1 (blocked by Phase 1)
- **Status**: Pending
- **Effort**: 3h
- **Description**: Replace the static order list processing in content.js with dynamic batch fetching from Google Sheet queue. Instead of processing a pre-determined list from `chrome.storage.local`, the extension now claims batches of 10 from the Sheet, processes them, claims more, and repeats. On rate limit, releases remaining batch orders back to the queue.

## Key Insights
- Current flow (line 355-444): reads `orders[]` array and `currentIndex` from storage, processes sequentially, navigates to next order URL.
- New flow: claims batch from Sheet → processes each order → on completion claims next batch → on rate limit releases remaining.
- `sendToGoogleSheet()` (line 323-351) currently does a plain POST. Must switch to `submitResult` action format for queue integration.
- Need new `callSheetAPI()` utility to handle all Sheet interactions (POST with action routing, GET for status).
- `processOrderDetail()` currently uses `state.orders[currentIndex]` — must be replaced with batch-based tracking.
- Storage keys change: instead of `orders[]` + `currentIndex`, use `currentBatch[]` + `batchIndex` + `profileId`.

## Requirements

### Functional
- **claimBatch**: Before processing starts, claim 10 orders from Sheet queue
- **Process batch**: Navigate to each order detail page, extract data, submit to Sheet
- **Auto-claim**: When batch complete, auto-claim next batch
- **Rate limit handling**: On rate limit detection, release remaining unprocessed orders in current batch, stop processing
- **Stop handling**: On user Stop, release remaining batch orders
- **Local-only fallback**: If no Sheet URL configured, use existing static order list behavior
- **Profile ID**: Read `profileId` from `chrome.storage.local` (auto-generated in Phase 4)

### Non-Functional
- API calls batched (claim 10 at once, not 1 at a time)
- Fail gracefully if Sheet API is down (log error, stop, don't lose data)
- Local extraction data still saved to `chrome.storage.local` for CSV export

## Architecture / Design

### Processing Flow (Queue Mode)
```
Start clicked
  → Read profileId + sheetUrl from storage
  → claimBatch(profileId, 10) via Sheet API
  → Store batch in chrome.storage.local: { currentBatch, batchIndex: 0 }
  → Navigate to first order detail page
  → processOrderDetail():
      → Extract data → submitResult to Sheet
      → batchIndex++
      → If batchIndex < batch.length → navigate to next in batch
      → If batchIndex >= batch.length → claimBatch again
      → If new batch empty → DONE (all orders processed)
  → On rate limit:
      → Release remaining orders: currentBatch.slice(batchIndex)
      → Set isRunning=false, rateLimited=true
```

### Processing Flow (Local-Only Mode)
```
Same as current behavior — no Sheet URL means no API calls.
Uses orders[] + currentIndex from storage.
```

### Storage Keys (Queue Mode)
| Key | Type | Description |
|-----|------|-------------|
| `queueMode` | boolean | true when Sheet URL is configured and orders pushed |
| `profileId` | string | Auto-generated profile identifier |
| `sheetUrl` | string | Google Apps Script URL |
| `currentBatch` | string[] | Currently claimed order numbers |
| `batchIndex` | number | Index within current batch |
| `extractedData` | object[] | Local copy of extracted data (for CSV export) |
| `failCount` | number | Orders that failed extraction |
| `isRunning` | boolean | Processing active flag |
| `rateLimited` | boolean | Rate limit detected flag |

### API Call Format
```js
// POST requests
async function callSheetAPI(sheetUrl, action, data) {
  const response = await fetch(sheetUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ action, ...data }),
    redirect: 'follow',
  });
  return response.json();
}

// GET requests
async function getSheetStatus(sheetUrl) {
  const response = await fetch(sheetUrl + '?action=status', { method: 'GET' });
  return response.json();
}
```

## Related Code Files
- **Modify**: `content.js`
  - Add `callSheetAPI()` utility (replace `sendToGoogleSheet()`)
  - Add `claimNextBatch()` function
  - Add `releaseRemainingOrders()` function
  - Rewrite `processOrderDetail()` for batch-based flow
  - Update `saveFailAndNext()` for batch tracking
  - Update `init()` to read queue mode state

## Implementation Steps

### 1. Add Sheet API utility (replace `sendToGoogleSheet` at lines 323-351)

```js
// ========== GOOGLE SHEET API ==========

async function callSheetAPI(sheetUrl, action, data) {
  if (!sheetUrl) return null;
  try {
    const response = await fetch(sheetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ action, ...data }),
      redirect: 'follow',
    });
    return await response.json();
  } catch (err) {
    log('Sheet API loi (' + action + '): ' + err.message, 'error');
    return null;
  }
}

async function getSheetStatus(sheetUrl) {
  if (!sheetUrl) return null;
  try {
    const response = await fetch(sheetUrl + '?action=status', { method: 'GET' });
    return await response.json();
  } catch (err) {
    log('Sheet status loi: ' + err.message, 'error');
    return null;
  }
}
```

### 2. Add batch management functions

```js
async function claimNextBatch(sheetUrl, profileId, batchSize) {
  const result = await callSheetAPI(sheetUrl, 'claimBatch', {
    profileId: profileId,
    batchSize: batchSize || 10,
  });
  if (result && result.status === 'ok') {
    return result.orders || [];
  }
  return [];
}

async function releaseRemainingOrders(sheetUrl, currentBatch, batchIndex) {
  const remaining = currentBatch.slice(batchIndex);
  if (remaining.length === 0 || !sheetUrl) return;
  log('Tra lai ' + remaining.length + ' don chua xu ly...', '');
  await callSheetAPI(sheetUrl, 'releaseOrders', { orders: remaining });
}

async function submitResultToSheet(sheetUrl, data, profileId) {
  if (!sheetUrl) return;
  const result = await callSheetAPI(sheetUrl, 'submitResult', {
    orderNo: data.orderNo,
    name: data.name,
    phone: data.phone,
    address: data.address,
    profile: profileId,
  });
  if (result && result.status === 'ok') {
    log('→ Sheet Queue: OK', 'success');
  }
}
```

### 3. Rewrite `processOrderDetail()` (replace lines 355-444)

The key change: instead of `orders[currentIndex]`, use `currentBatch[batchIndex]`. When batch exhausted, claim next batch.

```js
async function processOrderDetail() {
  const state = await chrome.storage.local.get(null);
  if (!state.isRunning) return;

  const sheetUrl = state.sheetUrl || '';
  const profileId = state.profileId || 'local';
  const queueMode = state.queueMode || false;
  const delay = state.delay || 5000;

  // Determine current order from batch or static list
  let currentOrder, isLastInSet;
  if (queueMode) {
    const batch = state.currentBatch || [];
    const batchIdx = state.batchIndex || 0;
    if (batchIdx >= batch.length) {
      // Claim next batch
      const newBatch = await claimNextBatch(sheetUrl, profileId, 10);
      if (newBatch.length === 0) {
        log('Khong con don nao trong hang doi!', 'success');
        await chrome.storage.local.set({ isRunning: false });
        notifyPopup();
        return;
      }
      await chrome.storage.local.set({ currentBatch: newBatch, batchIndex: 0 });
      currentOrder = newBatch[0];
      isLastInSet = false;
      log('Nhan batch moi: ' + newBatch.length + ' don');
    } else {
      currentOrder = batch[batchIdx];
      isLastInSet = batchIdx + 1 >= batch.length;
    }
  } else {
    // Local-only mode (backward compat)
    const orders = state.orders || [];
    const currentIndex = state.currentIndex || 0;
    if (currentIndex >= orders.length) {
      log('Da xu ly xong tat ca don hang!', 'success');
      await chrome.storage.local.set({ isRunning: false });
      notifyPopup();
      return;
    }
    currentOrder = orders[currentIndex];
    isLastInSet = currentIndex + 1 >= orders.length;
  }

  const displayIdx = queueMode
    ? (state.batchIndex || 0) + 1 + '/' + (state.currentBatch || []).length
    : (state.currentIndex || 0) + 1 + '/' + (state.orders || []).length;
  log('Xu ly don ' + displayIdx + ': ' + currentOrder);

  try {
    await waitForText('Chi tiết khách hàng');
    await sleep(1500);

    const clicked = await clickRevealButton();
    if (!clicked) {
      log('Khong click duoc nut reveal - don ' + currentOrder, 'error');
      await advanceToNext(state, queueMode, false);
      return;
    }

    await sleep(2000);

    // Rate limit check
    if (checkRateLimit()) {
      log('TikTok CHAN - tra lai don chua xu ly va dung', 'error');
      dismissRateLimit();
      await sleep(1000);

      // Save partial data if available
      const partialData = extractCustomerData();
      if (partialData && partialData.name) {
        const extractedData = state.extractedData || [];
        if (!extractedData.find((d) => d.orderNo === partialData.orderNo)) {
          extractedData.push(partialData);
        }
        await chrome.storage.local.set({ extractedData });
        if (queueMode) await submitResultToSheet(sheetUrl, partialData, profileId);
      }

      // Release remaining batch orders
      if (queueMode) {
        const batch = state.currentBatch || [];
        const batchIdx = (state.batchIndex || 0) + 1; // current one is processed (partially)
        await releaseRemainingOrders(sheetUrl, batch, batchIdx);
      }

      await chrome.storage.local.set({ isRunning: false, rateLimited: true });
      notifyPopup();
      return;
    }

    // Extract data
    const data = extractCustomerData();
    if (data) {
      const extractedData = state.extractedData || [];
      if (!extractedData.find((d) => d.orderNo === data.orderNo)) {
        extractedData.push(data);
      }
      await chrome.storage.local.set({ extractedData });
      log('OK: ' + (data.name || '?') + ' | ' + (data.phone || 'khong co SDT'), 'success');

      if (queueMode) {
        await submitResultToSheet(sheetUrl, data, profileId);
      } else if (sheetUrl) {
        // Legacy direct-write mode
        await callSheetAPI(sheetUrl, null, {
          orderNo: data.orderNo, name: data.name,
          phone: data.phone, address: data.address,
          profile: 'Profile ' + (state.profileNum || 1),
        });
      }
    } else {
      log('Khong doc duoc du lieu - don ' + currentOrder, 'error');
    }

    await advanceToNext(state, queueMode, true);
  } catch (err) {
    log('Loi: ' + err.message, 'error');
    await advanceToNext(state, queueMode, false);
  }
}
```

### 4. Add `advanceToNext()` helper (replaces `saveFailAndNext`)

```js
async function advanceToNext(state, queueMode, success) {
  const delay = state.delay || 5000;

  if (queueMode) {
    const batch = state.currentBatch || [];
    const nextBatchIdx = (state.batchIndex || 0) + 1;
    const failCount = success ? (state.failCount || 0) : (state.failCount || 0) + 1;

    if (nextBatchIdx >= batch.length) {
      // Batch complete — claim next
      const sheetUrl = state.sheetUrl || '';
      const profileId = state.profileId || 'local';
      const newBatch = await claimNextBatch(sheetUrl, profileId, 10);

      if (newBatch.length === 0) {
        log('HOAN TAT! Khong con don nao.', 'success');
        await chrome.storage.local.set({ isRunning: false, failCount });
        notifyPopup();
        return;
      }

      log('Batch moi: ' + newBatch.length + ' don');
      await chrome.storage.local.set({ currentBatch: newBatch, batchIndex: 0, failCount });
      notifyPopup();
      await sleep(delay);
      window.location.href = 'https://seller-vn.tiktok.com/order/detail?order_no=' + newBatch[0] + '&shop_region=VN';
    } else {
      await chrome.storage.local.set({ batchIndex: nextBatchIdx, failCount });
      notifyPopup();
      await sleep(delay);
      window.location.href = 'https://seller-vn.tiktok.com/order/detail?order_no=' + batch[nextBatchIdx] + '&shop_region=VN';
    }
  } else {
    // Local-only mode
    const orders = state.orders || [];
    const nextIndex = (state.currentIndex || 0) + 1;
    const failCount = success ? (state.failCount || 0) : (state.failCount || 0) + 1;

    await chrome.storage.local.set({ currentIndex: nextIndex, failCount });
    notifyPopup();

    if (nextIndex < orders.length) {
      await sleep(delay);
      window.location.href = 'https://seller-vn.tiktok.com/order/detail?order_no=' + orders[nextIndex] + '&shop_region=VN';
    } else {
      log('HOAN TAT! Da xu ly ' + orders.length + ' don.', 'success');
      await chrome.storage.local.set({ isRunning: false });
      notifyPopup();
    }
  }
}
```

### 5. Delete `saveFailAndNext()` (lines 447-466) and `sendToGoogleSheet()` (lines 323-351)

Replaced by `advanceToNext()` and `submitResultToSheet()` respectively.

### 6. Update `init()` (lines 509-520)

Add queue mode initial batch claim:
```js
async function init() {
  const url = window.location.href;
  if (url.includes('/order/detail')) {
    const state = await chrome.storage.local.get(['isRunning']);
    if (state.isRunning) {
      await sleep(2000);
      processOrderDetail();
    }
  }
}
```
No change needed — `processOrderDetail()` now handles both modes internally.

## Todo List
- [ ] Add `callSheetAPI()` utility function
- [ ] Add `getSheetStatus()` utility function
- [ ] Add `claimNextBatch()` function
- [ ] Add `releaseRemainingOrders()` function
- [ ] Add `submitResultToSheet()` function
- [ ] Rewrite `processOrderDetail()` for dual-mode (queue + local)
- [ ] Add `advanceToNext()` to replace `saveFailAndNext()`
- [ ] Delete `sendToGoogleSheet()` (replaced by `submitResultToSheet`)
- [ ] Delete `saveFailAndNext()` (replaced by `advanceToNext`)
- [ ] Test local-only mode (no Sheet URL) still works
- [ ] Test queue mode with Sheet URL + batch claiming
- [ ] Test rate limit → releases remaining orders
- [ ] Test user Stop → releases remaining orders

## Success Criteria
- **Queue mode**: Claims 10, processes all, auto-claims next 10, repeats until queue empty
- **Rate limit**: Remaining batch orders released back to queue within 2s
- **Local mode**: Behaves identically to current version (no regressions)
- **Data integrity**: Every extracted record submitted to Sheet AND saved locally
- **Stop button**: Releases remaining batch orders before stopping

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Sheet API down mid-processing | Low | High | Null check on all API responses, continue local-only |
| Batch claim returns 0 during processing | Low | Low | Treated as "done" — stop gracefully |
| Browser crash mid-batch | Low | Medium | 15min stale claim recovery in GAS (Phase 1) |
| Storage race condition | Low | Low | Chrome storage is serialized per-extension |

## Security Considerations
- `profileId` is a random string, not PII
- Sheet API calls use same `fetch` approach as existing code — no new attack surface
- `Content-Type: text/plain` bypass CORS preflight (existing pattern, line 337)

## Next Steps
- Depends on Phase 1 (GAS endpoints must exist)
- Phase 4 (UI) integrates the queue flow triggers
- Phase 5 tests multi-profile coordination
