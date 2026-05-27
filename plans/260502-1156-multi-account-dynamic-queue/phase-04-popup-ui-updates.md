# Phase 4: Popup UI Updates

## Context Links
- [Phase 2: Auto-Pagination](phase-02-auto-pagination-order-collection.md) — delivers `pageCount` param
- [Phase 3: Dynamic Batch](phase-03-dynamic-batch-processing.md) — delivers queue mode
- [Current popup.html](../../popup.html) — 293 lines
- [Current popup.js](../../popup.js) — 287 lines
- [Plan overview](plan.md)

## Overview
- **Priority**: P1 (blocked by Phase 2)
- **Status**: Pending
- **Effort**: 2.5h
- **Description**: Update popup UI to remove manual profile split inputs, add auto Profile ID, add page count input, add push-to-queue button, show global progress from Sheet. Keep local-only mode working.

## Key Insights
- Current profile UI (popup.html lines 217-223): manual "Profile thu" and "Tong" number inputs — removed
- `profileBadge` (line 211) currently shows `Profile ?/?` — change to show auto-generated Profile ID
- `btnCollect` (line 266) now triggers multi-page collection + push to Sheet queue
- `btnStart` (line 267) now claims batch from Sheet instead of using static list
- Need `pageCount` input (default 1) for auto-pagination
- Need global progress section showing Sheet queue stats (total/pending/done)
- `profileId` auto-generated once per Chrome profile, stored in `chrome.storage.local`

## Requirements

### Functional
- **Remove**: "Profile thu" and "Tong" inputs (profileNum, totalProfiles)
- **Add**: Auto-generated Profile ID (displayed, not editable, stored in `chrome.storage.local`)
- **Add**: "So trang" (page count) number input, default 1, min 1, max 100
- **Change "Thu thap don"**: Collect orders across N pages → push to Sheet queue → show count
- **Change "Bat dau"**: Claims batch from Sheet → starts processing
- **Add**: Global progress section — total/pending/done/failed from Sheet `?action=status`
- **Add**: "Refresh" button for global progress
- **Keep**: Delay input, Sheet URL input, Test Sheet button, Export CSV, Clear, Log, Stop
- **Keep**: Local stats section (orders in current batch, extracted, failed)

### Non-Functional
- Profile ID generated as `profile-{random8chars}` on first open (if none exists)
- Global progress refreshes on: popup open, after collect, after start, manual refresh
- Visual distinction between local stats (this profile) and global stats (all profiles)

## Architecture / Design

### Profile ID Generation
```js
function generateProfileId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = 'profile-';
  for (let i = 0; i < 8; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}
```
Called once on first popup open. Stored in `chrome.storage.local.profileId`. Displayed in header badge.

### UI Layout Changes

**Settings section** (replace current profile row):
```
Google Sheet URL: [________________________]
So trang can cao:  [3]     Delay (giay): [5]
[Luu cai dat]  [Test Google Sheet]
```

**Header badge**: `profile-ab12cd34` (instead of `Profile 1/3`)

**Global progress section** (new, above local stats):
```
TIEN DO CHUNG (tat ca profiles)
[============================------] 72%
Tong: 150 | Xong: 108 | Dang xu ly: 12 | Cho: 25 | Loi: 5
[Cap nhat]
```

**Local stats section** (modified):
```
PROFILE NAY
Batch hien tai: 10 | Da lay: 7 | Loi: 1
```

**Controls** (modified text):
```
[1. Thu thap & Day vao hang doi]  [2. Bat dau lay]  [Dung]
```

### Data Flow

**"Thu thap & Day vao hang doi" click**:
```
popup.js → content.js: collectOrders(pageCount=N)
  ← { success, count, total }
popup.js → Sheet API: pushOrders(orders)
  ← { added, duplicate }
popup.js → Sheet API: status
  ← { total, pending, done, ... }
Update global progress UI
```

Wait — the collect handler currently returns orders to popup via `sendResponse`. But in the new flow, orders are collected in content.js and need to be pushed to Sheet. Two options:
1. Content.js collects → returns to popup → popup pushes to Sheet
2. Content.js collects → content.js pushes to Sheet

**Decision**: Option 1 (popup pushes). Cleaner separation — content.js handles DOM only, popup handles Sheet API. Content.js returns orders array in response, popup pushes to Sheet.

Need to modify `collectOrders` response to include the actual orders array:
```js
sendResponse({ success: true, count: orders.length, orders: orders });
```

## Related Code Files
- **Modify**: `popup.html` — remove profile inputs, add page count, add global progress section
- **Modify**: `popup.js` — auto Profile ID, push to queue, claim batch, global progress

## Implementation Steps

### 1. popup.html — Remove profile inputs, add page count

**Delete** lines 217-223 (profile-row with profileNum and totalProfiles):
```html
<!-- REMOVE THIS -->
<div class="profile-row">
  <label>Profile thu:</label>
  <input type="number" id="profileNum" value="1" min="1" max="99">
  <label>/ Tong:</label>
  <input type="number" id="totalProfiles" value="1" min="1" max="99">
  <label>profiles</label>
</div>
```

**Replace with** page count + delay row:
```html
<div class="setting-row">
  <label>So trang can cao:</label>
  <input type="number" id="pageCount" value="1" min="1" max="100">
  <label style="margin-left:12px">Delay (giay):</label>
  <input type="number" id="delay" value="5" min="2" max="60">
</div>
```

**Delete** the separate delay setting-row (line 228-231) since it's now combined above.

### 2. popup.html — Add global progress section

Insert **before** the existing status section (before line 241):
```html
<!-- Global Progress -->
<div class="section" id="globalProgressSection" style="display:none;">
  <div class="section-title">Tien do chung (tat ca profiles)</div>
  <div class="progress-bar-container">
    <div class="progress-bar" id="globalProgressBar" style="width:0%"></div>
  </div>
  <div class="global-stats" id="globalStats">
    Tong: 0 | Xong: 0 | Dang XL: 0 | Cho: 0 | Loi: 0
  </div>
  <button id="btnRefreshProgress" class="btn-secondary" style="margin-top:6px;font-size:11px;padding:4px 8px;">Cap nhat</button>
</div>
```

**Add CSS** for progress bar:
```css
.progress-bar-container {
  height: 6px;
  background: #e8e8e8;
  border-radius: 3px;
  overflow: hidden;
  margin-bottom: 6px;
}
.progress-bar {
  height: 100%;
  background: #1a8917;
  border-radius: 3px;
  transition: width 0.3s;
}
.global-stats {
  font-size: 11px;
  color: #666;
  text-align: center;
}
```

### 3. popup.html — Update stat labels

Change `Don hang (profile nay)` (line 249) to `Batch`:
```html
<div class="stat-label">Batch hien tai</div>
```

### 4. popup.html — Update button text

Change line 266:
```html
<button id="btnCollect" class="btn-secondary">1. Thu thap don</button>
```
To:
```html
<button id="btnCollect" class="btn-secondary">1. Thu thap & Day</button>
```

### 5. popup.js — Auto Profile ID

**Remove** references to `profileNumInput` and `totalProfilesInput` (lines 20-21).

**Add** Profile ID initialization at top of IIFE:
```js
// Auto-generate and persist Profile ID
function ensureProfileId(callback) {
  chrome.storage.local.get(['profileId'], (s) => {
    if (s.profileId) {
      callback(s.profileId);
    } else {
      const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
      let id = 'profile-';
      for (let i = 0; i < 8; i++) id += chars.charAt(Math.floor(Math.random() * chars.length));
      chrome.storage.local.set({ profileId: id }, () => callback(id));
    }
  });
}
```

**Update** `loadSettings()` (lines 112-120):
```js
function loadSettings() {
  chrome.storage.local.get(['profileId', 'sheetUrl', 'delay', 'pageCount'], (s) => {
    sheetUrlInput.value = s.sheetUrl || '';
    delayInput.value = (s.delay || 5000) / 1000;
    pageCountInput.value = s.pageCount || 1;
    profileBadge.textContent = s.profileId || '...';
  });
}
```

### 6. popup.js — Save settings (modify btnSave handler, lines 146-158)

```js
btnSave.addEventListener('click', () => {
  const settings = {
    sheetUrl: sheetUrlInput.value.trim(),
    delay: (parseInt(delayInput.value) || 5) * 1000,
    pageCount: parseInt(pageCountInput.value) || 1,
  };
  chrome.storage.local.set(settings, () => {
    saveMsg.style.display = 'block';
    setTimeout(() => { saveMsg.style.display = 'none'; }, 2000);
    addLog('Luu cai dat OK', 'success');
  });
});
```

### 7. popup.js — Global progress fetching

```js
async function refreshGlobalProgress() {
  const sheetUrl = sheetUrlInput.value.trim();
  if (!sheetUrl) {
    globalProgressSection.style.display = 'none';
    return;
  }
  globalProgressSection.style.display = 'block';
  try {
    const response = await fetch(sheetUrl + '?action=status', { method: 'GET' });
    const data = await response.json();
    const total = data.total || 0;
    const done = data.done || 0;
    const claimed = data.claimed || 0;
    const pending = data.pending || 0;
    const failed = data.failed || 0;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;

    globalProgressBar.style.width = pct + '%';
    globalStats.textContent = 'Tong: ' + total + ' | Xong: ' + done
      + ' | Dang XL: ' + claimed + ' | Cho: ' + pending + ' | Loi: ' + failed;
  } catch (err) {
    globalStats.textContent = 'Loi ket noi Sheet';
  }
}
```

### 8. popup.js — Collect + Push to queue

**Modify** `btnCollect` handler (lines 192-201):

```js
btnCollect.addEventListener('click', () => {
  const pageCount = parseInt(pageCountInput.value) || 1;

  sendToContent('collectOrders', { pageCount }, async (response) => {
    if (response && response.success) {
      addLog('Thu thap ' + response.count + ' don tu ' + pageCount + ' trang', 'success');

      // Push to Sheet queue if URL configured
      const sheetUrl = sheetUrlInput.value.trim();
      if (sheetUrl && response.orders && response.orders.length > 0) {
        addLog('Day ' + response.orders.length + ' don vao hang doi...', '');
        try {
          const pushResult = await fetch(sheetUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: JSON.stringify({ action: 'pushOrders', orders: response.orders }),
            redirect: 'follow',
          });
          const pushData = await pushResult.json();
          addLog('Hang doi: +' + pushData.added + ' moi, ' + (pushData.duplicate || 0) + ' trung', 'success');
          await chrome.storage.local.set({ queueMode: true });
          refreshGlobalProgress();
        } catch (err) {
          addLog('Loi day vao hang doi: ' + err.message, 'error');
        }
      }

      loadState();
    } else {
      addLog('Khong thu thap duoc. Mo trang danh sach don hang va F5!', 'error');
    }
  });
});
```

### 9. popup.js — Start with batch claim

**Modify** `btnStart` handler (lines 204-221):

```js
btnStart.addEventListener('click', async () => {
  const state = await chrome.storage.local.get(['orders', 'delay', 'sheetUrl', 'profileId', 'queueMode']);
  const delay = state.delay || 5000;
  const sheetUrl = state.sheetUrl || '';
  const profileId = state.profileId || 'local';
  const queueMode = state.queueMode || false;

  if (queueMode && sheetUrl) {
    // Queue mode: claim first batch
    addLog('Claim batch tu hang doi...', '');
    try {
      const response = await fetch(sheetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ action: 'claimBatch', profileId, batchSize: 10 }),
        redirect: 'follow',
      });
      const data = await response.json();
      const batch = data.orders || [];

      if (batch.length === 0) {
        addLog('Hang doi rong! Thu thap don truoc.', 'error');
        return;
      }

      await chrome.storage.local.set({
        isRunning: true, currentBatch: batch, batchIndex: 0,
        rateLimited: false, failCount: 0,
      });
      addLog('Bat dau voi ' + batch.length + ' don (delay: ' + (delay / 1000) + 's)', 'success');

      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
          chrome.tabs.update(tabs[0].id, {
            url: 'https://seller-vn.tiktok.com/order/detail?order_no=' + batch[0] + '&shop_region=VN'
          });
        }
      });
    } catch (err) {
      addLog('Loi claim batch: ' + err.message, 'error');
      return;
    }
  } else {
    // Local-only mode (original behavior)
    await chrome.storage.local.set({
      isRunning: true, currentIndex: 0, rateLimited: false, failCount: 0,
    });
    addLog('Bat dau (local mode, delay: ' + (delay / 1000) + 's)', 'success');
    const orders = state.orders || [];
    if (orders.length > 0) {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
          chrome.tabs.update(tabs[0].id, {
            url: 'https://seller-vn.tiktok.com/order/detail?order_no=' + orders[0] + '&shop_region=VN'
          });
        }
      });
    }
  }
  loadState();
});
```

### 10. popup.js — Stop with order release

**Modify** `btnStop` handler (lines 224-229):

```js
btnStop.addEventListener('click', async () => {
  const state = await chrome.storage.local.get(['sheetUrl', 'currentBatch', 'batchIndex', 'queueMode']);
  if (state.queueMode && state.sheetUrl && state.currentBatch) {
    const remaining = (state.currentBatch || []).slice(state.batchIndex || 0);
    if (remaining.length > 0) {
      try {
        await fetch(state.sheetUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify({ action: 'releaseOrders', orders: remaining }),
          redirect: 'follow',
        });
        addLog('Tra lai ' + remaining.length + ' don chua xu ly', '');
      } catch (err) { /* ignore */ }
    }
  }
  await chrome.storage.local.set({ isRunning: false });
  addLog('Da dung', 'error');
  loadState();
});
```

### 11. popup.js — Update UI for queue mode

Modify `updateUI()` to handle both modes and show batch info:

```js
// In updateUI(), update profileBadge and totalOrders for queue mode
if (state.queueMode) {
  const batch = state.currentBatch || [];
  totalOrders.textContent = batch.length;
  // Keep extracted and failed as-is
} else {
  totalOrders.textContent = (state.orders || []).length;
}
```

### 12. popup.js — Initialize Profile ID on load

At the bottom, replace initial `loadSettings()`:
```js
ensureProfileId((id) => {
  profileBadge.textContent = id;
  loadSettings();
  loadState();
  refreshGlobalProgress();
});
```

### 13. content.js — Return orders array in collectOrders response

Modify the `collectOrders` response in content.js message handler to include orders:
```js
sendResponse({ success: true, count: allOrders.length, total: allOrders.length, orders: allOrders });
```

## Todo List
- [ ] Remove profileNum/totalProfiles inputs from popup.html
- [ ] Add pageCount input to popup.html
- [ ] Add global progress section with progress bar to popup.html
- [ ] Add progress bar CSS
- [ ] Update button text and stat labels
- [ ] Add `ensureProfileId()` to popup.js
- [ ] Add `refreshGlobalProgress()` to popup.js
- [ ] Modify btnCollect to push orders to Sheet queue
- [ ] Modify btnStart for queue mode batch claiming
- [ ] Modify btnStop to release remaining orders
- [ ] Update `loadSettings()` for new fields
- [ ] Update `btnSave` for new fields
- [ ] Update `updateUI()` for queue mode display
- [ ] Update content.js collectOrders response to include orders array
- [ ] Ensure local-only mode still works (no Sheet URL)

## Success Criteria
- Profile ID auto-generated, visible in header, persists across popup opens
- Page count input accepted and passed to content.js for multi-page collection
- "Thu thap & Day" collects orders + pushes to Sheet queue
- "Bat dau" claims batch from Sheet and starts processing
- "Dung" releases remaining batch orders to Sheet
- Global progress bar shows accurate Sheet queue stats
- No regressions when Sheet URL is empty (local-only mode)
- All buttons disabled/enabled correctly per state

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| popup.js exceeds 200 lines | High | Low | Acceptable for single popup file; could split later if needed |
| Race between popup close and async fetch | Medium | Low | Chrome keeps fetch alive even after popup closes |
| Sheet API slow → UI feels laggy | Medium | Low | Show "Dang tai..." loading state on buttons |
| User confused by two stats sections | Low | Medium | Clear labels: "Tien do chung" vs "Profile nay" |

## Security Considerations
- Profile ID is random, not tied to user identity
- No new permissions needed in manifest.json
- Sheet URL stored in `chrome.storage.local` (per-profile, not synced)

## Next Steps
- Depends on Phase 2 (pageCount param) and Phase 3 (queue mode, batch claiming)
- Phase 5 integrates and tests everything together
