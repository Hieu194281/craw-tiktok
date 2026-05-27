# Phase 5: Testing & Integration

## Context Links
- [Phase 1: GAS Queue Manager](phase-01-google-apps-script-queue-manager.md)
- [Phase 2: Auto-Pagination](phase-02-auto-pagination-order-collection.md)
- [Phase 3: Dynamic Batch Processing](phase-03-dynamic-batch-processing.md)
- [Phase 4: Popup UI Updates](phase-04-popup-ui-updates.md)
- [Plan overview](plan.md)

## Overview
- **Priority**: P1 (blocked by all other phases)
- **Status**: Pending
- **Effort**: 1.5h
- **Description**: Integration testing across multiple Chrome profiles. Verify concurrency, rate limit handling, data integrity, and backward compatibility.

## Key Insights
- No automated test framework for this Chrome extension — testing is manual
- Need 2-3 separate Chrome profiles with extension installed
- Google Sheet is the shared state — inspect it during tests
- TikTok rate limit is hard to trigger intentionally — simulate with modified checkRateLimit()

## Requirements

### Functional
- All 5 phases work together end-to-end
- 2-3 profiles can process orders simultaneously without conflicts
- Rate-limited profile's orders get picked up by other profiles
- Data in Google Sheet matches what each profile extracted
- Local CSV export contains this profile's data only
- Extension works without Sheet URL (local-only mode)

### Non-Functional
- Setup time for new profile < 2 minutes
- No data loss under normal operation
- Clear error messages for common failure modes

## Test Matrix

### T1: Google Apps Script Unit Tests (curl/fetch)
| # | Test | Expected | Pass |
|---|------|----------|------|
| T1.1 | GET `?action=test` | `{ status: "ready" }` | [ ] |
| T1.2 | GET `?action=status` (empty queue) | `{ total: 0, pending: 0, ... }` | [ ] |
| T1.3 | POST `pushOrders` with 5 orders | `{ added: 5, duplicate: 0 }` | [ ] |
| T1.4 | POST `pushOrders` same 5 orders again | `{ added: 0, duplicate: 5 }` | [ ] |
| T1.5 | POST `claimBatch` profileA, size 3 | `{ orders: [3 items] }` | [ ] |
| T1.6 | POST `claimBatch` profileB, size 3 | `{ orders: [2 remaining] }` (no overlap with T1.5) | [ ] |
| T1.7 | POST `submitResult` for 1 order | Queue status=done, Results row added | [ ] |
| T1.8 | POST `releaseOrders` for T1.5 remaining | Status changes to pending | [ ] |
| T1.9 | GET `?action=status` | Counts match sheet data | [ ] |
| T1.10 | POST without `action` (legacy) | Results row added (backward compat) | [ ] |

### T2: Auto-Pagination (Single Profile)
| # | Test | Expected | Pass |
|---|------|----------|------|
| T2.1 | Collect 1 page (pageCount=1) | ~50 orders from visible page | [ ] |
| T2.2 | Collect 3 pages (pageCount=3) | ~150 orders, no duplicates | [ ] |
| T2.3 | Collect more pages than exist | Stops at last page, no error | [ ] |
| T2.4 | Collect on non-order-list page | Error message, no crash | [ ] |
| T2.5 | Page load timeout | Graceful stop, returns orders collected so far | [ ] |

### T3: Dynamic Batch Processing (Single Profile)
| # | Test | Expected | Pass |
|---|------|----------|------|
| T3.1 | Start with queue of 25 orders | Claims 10 → processes → claims 10 → claims 5 → done | [ ] |
| T3.2 | Stop mid-batch | Remaining orders released to queue | [ ] |
| T3.3 | Rate limit mid-batch | Remaining released, processing stops | [ ] |
| T3.4 | Empty queue on start | "Hang doi rong" message | [ ] |
| T3.5 | Sheet API unreachable during claim | Error logged, stops gracefully | [ ] |
| T3.6 | Local-only mode (no Sheet URL) | Works exactly like v2.0 behavior | [ ] |

### T4: Multi-Profile Concurrency
| # | Test | Expected | Pass |
|---|------|----------|------|
| T4.1 | 2 profiles claim simultaneously | No overlapping orders (LockService) | [ ] |
| T4.2 | Profile A rate-limited, Profile B claims | B gets A's released orders | [ ] |
| T4.3 | Profile A crashes, B claims after 15min | Stale orders auto-released and claimed by B | [ ] |
| T4.4 | Both profiles submit results | All results in Sheet, no duplicates | [ ] |
| T4.5 | Both profiles view global progress | Same numbers displayed | [ ] |

### T5: Popup UI
| # | Test | Expected | Pass |
|---|------|----------|------|
| T5.1 | First open → Profile ID generated | Unique ID shown in header badge | [ ] |
| T5.2 | Second open → same Profile ID | ID persisted from first open | [ ] |
| T5.3 | Page count input saved | Value persists after popup close/reopen | [ ] |
| T5.4 | "Thu thap & Day" with Sheet URL | Orders collected + pushed to queue + progress updated | [ ] |
| T5.5 | "Thu thap & Day" without Sheet URL | Orders collected locally only (local mode) | [ ] |
| T5.6 | Global progress shows Sheet stats | Numbers match Sheet data | [ ] |
| T5.7 | "Cap nhat" refreshes progress | Fresh data from Sheet | [ ] |
| T5.8 | Test Google Sheet button | "Ket noi thanh cong" with valid URL | [ ] |
| T5.9 | Export CSV | CSV contains this profile's extracted data | [ ] |
| T5.10 | Clear data | Clears local data, settings preserved | [ ] |

### T6: Edge Cases
| # | Test | Expected | Pass |
|---|------|----------|------|
| T6.1 | Push 500 orders at once | All pushed, <10s latency | [ ] |
| T6.2 | Order number with leading zeros | Preserved as string in Sheet (@ format) | [ ] |
| T6.3 | Customer name with commas/quotes | No CSV corruption on export | [ ] |
| T6.4 | Network disconnect during processing | Error logged, stops, resumable | [ ] |
| T6.5 | Duplicate order in different batches | submitResult deduped by Sheet row check | [ ] |

## Related Code Files
- All files: `google-apps-script.gs`, `content.js`, `popup.html`, `popup.js`, `manifest.json`

## Implementation Steps

### 1. Deploy Google Apps Script
- Open Google Sheet
- Extensions > Apps Script
- Replace code with new `google-apps-script.gs`
- Deploy > New deployment > Web app > Anyone
- Copy deployment URL

### 2. Test GAS endpoints (T1)
Use browser console or curl:
```js
// T1.1
fetch(SCRIPT_URL + '?action=test').then(r => r.json()).then(console.log)

// T1.3
fetch(SCRIPT_URL, {
  method: 'POST', headers: {'Content-Type': 'text/plain'},
  body: JSON.stringify({ action: 'pushOrders', orders: ['100001','100002','100003','100004','100005'] })
}).then(r => r.json()).then(console.log)

// T1.5
fetch(SCRIPT_URL, {
  method: 'POST', headers: {'Content-Type': 'text/plain'},
  body: JSON.stringify({ action: 'claimBatch', profileId: 'test-profile-a', batchSize: 3 })
}).then(r => r.json()).then(console.log)
```

### 3. Install extension in Chrome profiles
- Profile 1: Load unpacked extension
- Profile 2: Load same extension folder
- Profile 3: (optional) Load same extension
- Each gets unique auto-generated profileId

### 4. Test pagination (T2)
- Navigate to seller-vn.tiktok.com/order
- Apply desired filters
- Set page count to 3
- Click "Thu thap & Day"
- Verify log shows 3 pages collected
- Verify Sheet "Queue" has ~150 pending orders

### 5. Test multi-profile extraction (T4)
- Profile 1: Click "Bat dau"
- Profile 2: Click "Bat dau" (within 10s of Profile 1)
- Monitor Sheet "Queue" — claimedBy should alternate between profiles
- Monitor Sheet "Results" — both profiles submitting data
- Check global progress from both popups

### 6. Test rate limit recovery (T4.2)
- If TikTok rate-limits Profile 1: verify remaining orders released
- Profile 2: verify it claims those released orders on next batch
- Final Sheet state: all orders = done

### 7. Test backward compatibility (T3.6, T5.5)
- Remove Sheet URL from settings
- Collect orders → stored locally only
- Start → processes from local list (original v2.0 behavior)
- Export CSV → works as before

## Todo List
- [ ] Deploy new Google Apps Script
- [ ] Run T1 endpoint tests
- [ ] Install extension in 2+ Chrome profiles
- [ ] Run T2 pagination tests
- [ ] Run T3 single-profile batch tests
- [ ] Run T4 multi-profile concurrency tests
- [ ] Run T5 popup UI tests
- [ ] Run T6 edge case tests
- [ ] Fix any issues found during testing
- [ ] Clean up test data from Sheet

## Success Criteria
- All T1-T6 tests pass
- 3 profiles extract 150 orders from same queue without conflicts
- Zero manual CSV merging required
- Extension installs and works in new Chrome profile in < 2 minutes
- Local-only mode has zero regressions from v2.0

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| TikTok DOM changes between dev and test | Medium | High | Test on live site, not mocks |
| GAS deployment caching | Medium | Low | Use new deployment (not version update) |
| Chrome profile storage isolation issues | Low | Low | Each profile has separate storage by design |
| Rate limit hard to reproduce | High | Medium | Can simulate by modifying checkRateLimit() temporarily |

## Security Considerations
- Test Sheet should not contain real customer data — use filtered test orders
- Delete test data from Sheet after testing complete
- Verify Sheet sharing permissions are restricted to team only

## Next Steps
- After all tests pass, update extension version in manifest.json to 3.0
- Update project docs if needed
- Consider: add Sheet cleanup/archive script for daily queue reset
