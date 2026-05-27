# Planner Report: Multi-Account Dynamic Queue System

**Date**: 2026-05-02
**Plan**: `plans/260502-1156-multi-account-dynamic-queue/`

## Summary

Created 5-phase implementation plan for Google Sheet-based queue coordinator enabling 2-4 TikTok staff accounts to extract orders in parallel. Core change: replace static profile split with dynamic batch claiming via Google Apps Script API.

## Phases

| # | Phase | Effort | Key Files | Blocked By |
|---|-------|--------|-----------|------------|
| 1 | GAS Queue Manager (6 endpoints + LockService) | 3h | `google-apps-script.gs` | None |
| 2 | Auto-Pagination (click Next, collect N pages) | 2h | `content.js` | None |
| 3 | Dynamic Batch Processing (claim/process/release) | 3h | `content.js` | Phase 1 |
| 4 | Popup UI (auto Profile ID, page count, global progress) | 2.5h | `popup.html`, `popup.js` | Phase 2 |
| 5 | Testing & Integration (37 test cases) | 1.5h | All | All |

**Total effort**: 12h. Phases 1 & 2 parallelizable.

## Key Decisions
- Google Sheet as queue (no extra infra) with LockService concurrency control
- Batch size = 10 (balances API calls vs responsiveness)
- 15min stale claim timeout for crash recovery
- Backward compatible: local-only mode when no Sheet URL
- popup.js pushes orders to Sheet (not content.js) — cleaner separation

## File Ownership (No Conflicts)
- Phase 1: `google-apps-script.gs` only
- Phase 2: `content.js` (pagination section)
- Phase 3: `content.js` (processing section) — sequential after Phase 2
- Phase 4: `popup.html` + `popup.js` only
- Phase 5: read-only testing

## Risks
- TikTok DOM selector changes (Medium) — multiple fallback strategies in code
- GAS concurrent access (Low) — LockService mitigates
- Anti-bot detection during pagination (Low) — random 1.5-2.5s delays

**Status:** DONE
**Summary:** Complete 5-phase plan with code-level guidance, 37 test cases, dependency graph, and backward compatibility strategy created.
