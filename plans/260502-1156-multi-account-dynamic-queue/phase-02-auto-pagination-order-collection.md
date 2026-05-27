# Phase 2: Auto-Pagination Order Collection

## Context Links
- [Brainstorm Report](../reports/brainstorm-260502-1156-multi-account-dynamic-queue.md)
- [Current content.js](../../content.js) — `collectOrderNumbers()` at lines 55-95
- [Plan overview](plan.md)

## Overview
- **Priority**: P1 (blocks Phase 4)
- **Status**: Pending
- **Effort**: 2h
- **Description**: Extend `collectOrderNumbers()` in content.js to auto-paginate across N pages. Current implementation only scrapes the visible page (max 50 orders). New version clicks "Next" button, waits for page load, collects orders, and repeats for user-specified page count.

## Key Insights
- TikTok Seller Center pagination: numbered page buttons + Next (`>`) / Prev (`<`) buttons
- Page selector: `.arco-pagination` container with `.arco-pagination-item` page buttons and `.arco-pagination-item-next` for Next
- Each page shows up to 50 orders. 3 pages = 150 orders maximum.
- Must wait for DOM update after page click — order links change on each page
- Current `collectOrderNumbers()` (line 55-95) returns synchronously. New version must be `async`.
- The message handler at line 471-504 calls `collectOrderNumbers()` synchronously — must be updated for async.

## Requirements

### Functional
- Accept `pageCount` parameter (default 1, max 100)
- On current page: collect orders using existing strategies (lines 59-93)
- Click Next button, wait for new page to load (new order links appear)
- Repeat collection for each page, deduplicating across all pages
- Return combined array of all order numbers
- Report progress per page via `log()` messages
- If Next button disabled/missing, stop early (last page reached)

### Non-Functional
- Delay between pages: 1.5-2.5s (avoid anti-bot detection)
- Timeout per page load: 10s (fail gracefully)
- Must not break existing single-page behavior (pageCount=1 = same as before)

## Architecture / Design

### Data Flow
```
User clicks "Thu thap don" (popup)
  → popup.js sends { action: 'collectOrders', pageCount: N }
  → content.js collectOrdersMultiPage(pageCount)
     → page 1: collectOrderNumbers() → [50 orders]
     → click Next, wait
     → page 2: collectOrderNumbers() → [50 orders]
     → ...
     → page N: collectOrderNumbers() → [50 orders]
  → Return combined deduped array
  → (Phase 4: popup pushes to Google Sheet)
```

### Pagination DOM Selectors
```js
// Pagination container
const pagination = document.querySelector('.arco-pagination');

// Next button (multiple fallback strategies)
const nextBtn = document.querySelector('.arco-pagination-item-next');
// Fallback: button with aria-label or containing > symbol
const nextBtnFallback = document.querySelector('li.arco-pagination-item-next:not(.arco-pagination-item-disabled)');

// Current page indicator
const activePage = document.querySelector('.arco-pagination-item-active');

// Disabled check
const isDisabled = nextBtn.classList.contains('arco-pagination-item-disabled');
```

### Wait-for-page-change Strategy
After clicking Next:
1. Record current active page number
2. Click Next
3. Poll (100ms intervals, 10s timeout) until:
   - Active page number changes, OR
   - Order links in DOM change (different `order_no` values)
4. Additional 500ms settle time for DOM to fully render

## Related Code Files
- **Modify**: `content.js`
  - Add `collectOrdersMultiPage(pageCount)` async function (after line 95)
  - Modify message handler (lines 471-504) to pass `pageCount` and use async collection
  - Keep `collectOrderNumbers()` unchanged (still used for single-page collection)
  - Remove `getProfileOrders()` (lines 98-106) — no longer needed with queue system

## Implementation Steps

### 1. Add pagination helper functions (insert after line 95)

```js
// ========== PAGINATION HELPERS ==========

function findNextButton() {
  // Strategy 1: Arco UI pagination next button
  const next = document.querySelector('li.arco-pagination-item-next:not(.arco-pagination-item-disabled)');
  if (next) return next;

  // Strategy 2: SVG arrow in pagination
  const pagination = document.querySelector('.arco-pagination, [class*="pagination"]');
  if (pagination) {
    const items = pagination.querySelectorAll('li, button');
    for (const item of items) {
      if (item.textContent.trim() === '>' || item.querySelector('svg[class*="right"]')) {
        if (!item.classList.contains('arco-pagination-item-disabled') && !item.disabled) {
          return item;
        }
      }
    }
  }

  return null;
}

function getCurrentPageNum() {
  const active = document.querySelector('.arco-pagination-item-active');
  return active ? parseInt(active.textContent.trim(), 10) : 0;
}

async function waitForPageChange(previousPageNum, timeout = 10000) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    const currentPage = getCurrentPageNum();
    if (currentPage !== previousPageNum && currentPage > 0) {
      await sleep(500); // settle time
      return true;
    }
    await sleep(100);
  }
  return false;
}
```

### 2. Add multi-page collection function

```js
async function collectOrdersMultiPage(pageCount) {
  const allOrders = [];
  const seen = new Set();

  for (let page = 1; page <= pageCount; page++) {
    log('Thu thap trang ' + page + '/' + pageCount + '...');

    const pageOrders = collectOrderNumbers();
    let newCount = 0;
    for (const order of pageOrders) {
      if (!seen.has(order)) {
        seen.add(order);
        allOrders.push(order);
        newCount++;
      }
    }

    log('Trang ' + page + ': ' + newCount + ' don moi (tong: ' + allOrders.length + ')', 'success');

    // If this is the last requested page, stop
    if (page >= pageCount) break;

    // Find and click Next button
    const nextBtn = findNextButton();
    if (!nextBtn) {
      log('Khong tim thay nut "Tiep" - da den trang cuoi', '');
      break;
    }

    const currentPageNum = getCurrentPageNum();
    simulateClick(nextBtn);

    // Wait for page to change
    const changed = await waitForPageChange(currentPageNum);
    if (!changed) {
      log('Timeout cho trang tiep theo - dung lai', 'error');
      break;
    }

    // Random delay to avoid detection (1.5-2.5s)
    const delay = 1500 + Math.random() * 1000;
    await sleep(delay);
  }

  log('Tong cong: ' + allOrders.length + ' don tu ' + Math.min(pageCount, allOrders.length > 0 ? pageCount : 1) + ' trang', 'success');
  return allOrders;
}
```

### 3. Update message handler (modify lines 471-504)

Replace the `collectOrders` handler block:

```js
if (msg.action === 'collectOrders') {
  const url = window.location.href;
  if (!url.includes('seller-vn.tiktok.com/order') || url.includes('/order/detail')) {
    sendResponse({ success: false, error: 'Khong phai trang danh sach don hang' });
    return;
  }

  const pageCount = msg.pageCount || 1;

  // Use async multi-page collection
  collectOrdersMultiPage(pageCount).then((allOrders) => {
    if (allOrders.length > 0) {
      chrome.storage.local.set({
        orders: allOrders,
        allOrdersCount: allOrders.length,
        currentIndex: 0,
        extractedData: [],
        failCount: 0,
        rateLimited: false,
      }, () => {
        sendResponse({ success: true, count: allOrders.length, total: allOrders.length });
      });
    } else {
      sendResponse({ success: false, error: 'Khong tim thay don hang nao' });
    }
  }).catch((err) => {
    sendResponse({ success: false, error: err.message });
  });

  return true; // async response
}
```

### 4. Remove `getProfileOrders()` (delete lines 98-106)

This static split function is replaced by the dynamic queue system. Remove it entirely.

## Todo List
- [ ] Add `findNextButton()` with fallback strategies
- [ ] Add `getCurrentPageNum()` helper
- [ ] Add `waitForPageChange()` with timeout
- [ ] Add `collectOrdersMultiPage(pageCount)` async function
- [ ] Update message handler to accept `pageCount` param and use async collection
- [ ] Remove `getProfileOrders()` static split function
- [ ] Test with 1 page (backward compat)
- [ ] Test with 3+ pages on TikTok Seller Center
- [ ] Test early stop when last page reached

## Success Criteria
- `collectOrdersMultiPage(1)` returns same result as old `collectOrderNumbers()` (single page)
- `collectOrdersMultiPage(3)` collects ~150 orders from 3 pages (50/page)
- Stops gracefully at last page if fewer pages than requested
- No duplicate order numbers in returned array
- Progress logged per page
- Random delay between pages (anti-detection)

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| TikTok changes pagination DOM | Medium | High | 2 fallback selector strategies |
| Anti-bot detects rapid pagination | Low | Medium | Random 1.5-2.5s delay between pages |
| Page load timeout | Low | Medium | 10s timeout + graceful stop |
| Memory on very large page counts | Low | Low | Orders are strings, 10K orders ~ trivial memory |

## Security Considerations
- No new permissions needed. Extension already has `https://seller-vn.tiktok.com/*` host permission.
- `simulateClick` already exists in codebase (line 130-138).

## Next Steps
- Phase 4 (UI Updates) will add `pageCount` input to popup and pass it to this handler
- This phase is independent of Phase 1 (GAS) — can develop in parallel
