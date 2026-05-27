# Brainstorm: Multi-Account Dynamic Queue for TikTok Order Extractor

**Date**: 2026-05-02
**Status**: Approved

## Problem Statement

TikTok Seller Center limits phone number reveals to ~50/day/account. Extension currently works with 1 account only. Need to support multiple staff accounts (same shop) running in parallel Chrome profiles to bypass this limit and extract 50-150 orders per session.

Additionally, TikTok paginates order list at 50/page — current `collectOrderNumbers()` only scrapes 1 page.

## Context

- **Scale**: 50-150 orders/run, 2-4 staff accounts
- **Limit**: 50 SĐT/day/account, resets daily
- **Accounts**: Multiple sub-accounts (staff) in same TikTok shop
- **Workflow**: User filters orders on TikTok first, then extension scrapes
- **Pagination**: Traditional numbered pages with Next/Prev buttons, 50/page, up to 2652 pages

## Evaluated Approaches

### A: Enhanced Static Split (Rejected)
Keep current `profileNum/totalProfiles` static split. Google Sheet merges data.
- (+) Minimal code changes
- (-) Static split wastes capacity when 1 profile hits limit early
- (-) Manual profile assignment, manual CSV merge

### B: Dynamic Queue via Google Sheet (Selected)
Google Sheet as central queue manager. Profiles claim batches dynamically.
- (+) Auto load-balancing — blocked profile's orders picked up by others
- (+) No manual merge, data centralizes in Sheet
- (+) No extra infrastructure (reuses existing Google Sheet integration)
- (-) Slight latency from Google Apps Script API calls

### C: Local Server + Dashboard (Rejected)
Node.js WebSocket server coordinates profiles, live dashboard.
- (+) Real-time, most powerful
- (-) Overkill for 2-4 profiles and 150 orders
- (-) Requires running separate server

## Final Solution: Dynamic Queue via Google Sheet

### Architecture

```
Chrome Profile 1 --\
Chrome Profile 2 ---+--> Google Apps Script API --> Google Sheet (Queue + Results)
Chrome Profile 3 --/
```

### Google Sheet Structure

**Sheet: Queue**
| Column | Type | Description |
|--------|------|-------------|
| orderNo | string | 18-digit order number |
| status | string | pending / claimed / done / failed |
| claimedBy | string | Profile ID that claimed this order |
| claimedAt | timestamp | When claimed |

**Sheet: Results**
| Column | Type | Description |
|--------|------|-------------|
| orderNo | string | Order number |
| name | string | Customer name |
| phone | string | Phone number |
| address | string | Shipping address |
| profile | string | Which profile extracted |
| timestamp | timestamp | When extracted |

### Apps Script API Endpoints

| Action | Method | Description |
|--------|--------|-------------|
| pushOrders | POST | Push order numbers to queue (dedup) |
| claimBatch | POST | Claim next 10 unclaimed orders (LockService) |
| submitResult | POST | Submit extracted data for 1 order |
| releaseOrders | POST | Release uncompleted orders back to queue |
| status | GET | Get overall progress stats |
| test | GET | Test connection (existing) |

### Extension Changes

**content.js**:
- Add auto-pagination: collect orders across N pages (click Next, wait, collect, repeat)
- Replace static order list with dynamic batch fetching from Google Sheet
- On rate limit: release remaining batch orders, stop processing
- Remove `getProfileOrders()` static split logic

**popup.html/popup.js**:
- Remove "Profile thu / Tong" inputs
- Add auto-generated Profile ID (stored per Chrome profile in chrome.storage.local)
- Add "So trang can cao" input (default: 1)
- Show global progress from Google Sheet (total/done/pending/failed)
- "Thu thap don" now auto-paginates and pushes to Sheet queue
- "Bat dau" now claims batch from Sheet and processes

### Workflow

1. User filters orders on TikTok Seller Center (date, status, etc.)
2. **Any profile**: Click "Thu thap don" → auto-paginate N pages → push all order numbers to Sheet queue
3. **All profiles**: Click "Bat dau" → claim batch of 10 → process each order detail → claim next batch → repeat
4. **On rate limit**: Release uncompleted orders → stop → other profiles pick up
5. **Result**: Google Sheet has all extracted data, deduplicated, from all profiles

### Edge Cases

- **Double-claim prevention**: Apps Script uses LockService.getScriptLock()
- **Stale claims**: Orders claimed >15min auto-release (profile crash recovery)
- **Dedup on push**: Orders already in queue are skipped
- **Rate limit mid-batch**: Only release unprocessed orders from current batch
- **Pagination selector**: Next button = `>` arrow in pagination, page numbers = `1, 2, 3...`

### Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| TikTok changes DOM selectors | Medium | Multiple fallback strategies already in code |
| Google Apps Script rate limits | Low | Batch operations, 10 orders/claim reduces API calls |
| Profile crash mid-batch | Low | 15min stale claim auto-release |
| TikTok detects automation | Medium | Configurable delay between orders (2-60s) |

### Success Metrics

- Extract 150 orders/day using 3 accounts (vs 50 with 1 account)
- Zero manual CSV merging
- Auto load-balancing when profiles hit rate limit
- Setup time per new profile < 2 minutes

## Implementation Considerations

- Keep backward compatible: extension should still work without Google Sheet (local-only mode)
- Apps Script code should be provided as a ready-to-paste snippet
- Profile ID auto-generated on first install, no manual config needed
- Pagination delay between pages to avoid triggering TikTok anti-bot

## Next Steps

Create implementation plan with phases:
1. Google Apps Script queue manager
2. Auto-pagination in content.js
3. Dynamic batch processing in content.js
4. Popup UI updates
5. Testing with multiple profiles
