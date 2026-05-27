---
title: "Multi-Account Dynamic Queue System"
description: "Google Sheet-based queue coordinator for parallel TikTok order extraction across multiple staff accounts"
status: in-progress
priority: P1
effort: 12h
branch: feat/multi-account-dynamic-queue
tags: [chrome-extension, google-apps-script, multi-account, queue]
created: 2026-05-02
---

# Multi-Account Dynamic Queue System

## Problem
TikTok limits phone reveals to ~50/day/account. Need 2-4 staff accounts running in parallel Chrome profiles to extract 50-150 orders/day. Current extension only supports 1 account with static split.

## Architecture
```
Chrome Profile 1 --\
Chrome Profile 2 ---+--> Google Apps Script API --> Google Sheet (Queue + Results)
Chrome Profile 3 --/
```

## Phases

| # | Phase | Status | Effort | Files |
|---|-------|--------|--------|-------|
| 1 | [Google Apps Script Queue Manager](phase-01-google-apps-script-queue-manager.md) | Done | 3h | `google-apps-script.gs` |
| 2 | [Auto-Pagination Order Collection](phase-02-auto-pagination-order-collection.md) | Done | 2h | `content.js` |
| 3 | [Dynamic Batch Processing](phase-03-dynamic-batch-processing.md) | Done | 3h | `content.js` |
| 4 | [Popup UI Updates](phase-04-popup-ui-updates.md) | Done | 2.5h | `popup.html`, `popup.js` |
| 5 | [Testing & Integration](phase-05-testing-and-integration.md) | Pending | 1.5h | All files |

## Dependencies
```
Phase 1 (GAS) ──> Phase 3 (Dynamic Batch) ──> Phase 5 (Testing)
Phase 2 (Pagination) ──> Phase 4 (UI) ──────> Phase 5 (Testing)
```
Phase 1 and Phase 2 are independent — can be developed in parallel.

## Key Decisions
- Google Sheet as queue coordinator (no extra infra)
- LockService for concurrency control (prevents double-claims)
- Batch size = 10 orders (balances API calls vs responsiveness)
- 15min stale claim timeout (crash recovery)
- Backward compatible: local-only mode when no Sheet URL configured

## Success Criteria
- 3 profiles extract 150 orders/day with zero manual CSV merging
- Rate-limited profile's orders auto-reassigned to others
- New profile setup < 2 minutes
- Extension works without Google Sheet (local-only fallback)

## Brainstorm Report
[brainstorm-260502-1156-multi-account-dynamic-queue.md](../reports/brainstorm-260502-1156-multi-account-dynamic-queue.md)
