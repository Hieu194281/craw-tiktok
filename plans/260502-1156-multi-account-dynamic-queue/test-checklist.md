# Phase 5 - Test Checklist (Manual)

> Workflow: lam tu T1 -> T6 theo thu tu. Moi muc tick `[x]` khi pass.
> Khi fail: ghi lai loi vao **Notes**, fix code, re-run.

## Pre-requisites

- [ ] Da deploy GAS theo `docs/setup-guide.md` Phan A
- [ ] Da pass tat ca **T1** trong `test-helper.html`
- [ ] Da xoa data test (orderNo `9000...`) khoi Sheet
- [ ] Co it nhat 2 Chrome profiles, moi profile 1 account TikTok khac nhau
- [ ] Profile A da cai extension va dan GAS URL

---

## T1: GAS Endpoints (chay qua test-helper.html)

| # | Test | Pass |
|---|------|:----:|
| T1.1 | GET ?action=test => `{ status: "ready" }` | [ ] |
| T1.2 | GET ?action=status => co `total`, `pending`, `done`, `claimed`, `failed` | [ ] |
| T1.3 | POST pushOrders 5 don => `added: 5, duplicate: 0` | [ ] |
| T1.4 | POST pushOrders cung 5 don => `added: 0, duplicate: 5` | [ ] |
| T1.5 | claimBatch profile-test-a, size 3 => 3 don | [ ] |
| T1.6 | claimBatch profile-test-b, size 3 => 2 don con lai, KHONG overlap T1.5 | [ ] |
| T1.7 | submitResult 1 don => Queue=done, Results +1 row | [ ] |
| T1.8 | releaseOrders 2 don con cua T1.5 => `released: 2` | [ ] |
| T1.9 | status sau khi xong => `total:5, done:1, claimed:2, pending:2` | [ ] |
| T1.10 | POST khong co `action` (legacy) => Results +1 row | [ ] |

**Notes T1:**
```
(ghi loi neu fail)
```

---

## T2: Auto-Pagination (Profile A, page seller-vn.tiktok.com/order)

> Setup: extension popup -> So trang = N -> Thu thap & Day. Quan sat log + Sheet Queue.

- [ ] **T2.1** `pageCount=1` -> log hien `Tong cong: ~50 don tu 1 trang`
- [ ] **T2.2** `pageCount=3` -> log hien `Tong cong: ~150 don`, khong co duplicate trong Sheet Queue
- [ ] **T2.3** `pageCount=10` khi shop chi co 4 trang -> log hien `Khong tim thay nut Tiep - da den trang cuoi`, dung som
- [ ] **T2.4** Goi Thu thap khi dang o trang khac (vd `/order/detail`) -> log: `Khong phai trang danh sach don hang`
- [ ] **T2.5** Khi mang cham (DevTools throttle) -> page change timeout 10s -> log: `Timeout cho trang tiep theo`, tra ve cac don da thu

**Cach test T2.5**: F12 -> Network tab -> dropdown `No throttling` -> chon `Slow 3G` -> bam Thu thap.

**Notes T2:**
```

```

---

## T3: Dynamic Batch Processing (Profile A)

> Setup: Sheet Queue co ~25 don pending. Extension da config GAS URL.

- [ ] **T3.1** `Queue` co 25 don -> bam **Bat dau lay** -> claim 10, xu ly, claim 10 tiep, claim 5, het -> log `HOAN TAT! Khong con don nao.`
- [ ] **T3.2** Stop giua batch (vd da xu ly 3/10) -> Sheet Queue: 7 don con lai chuyen `claimed -> pending`
- [ ] **T3.3** Stop khi mang dang loi -> extension van dung duoc, log loi nhung khong crash
- [ ] **T3.4** Sheet Queue rong, bam **Bat dau lay** -> log: `Hang doi rong! Thu thap don truoc.`
- [ ] **T3.5** Block GAS URL trong DevTools (Network -> Block request URL) -> bam **Bat dau lay** -> log loi network, khong crash
- [ ] **T3.6** Xoa GAS URL trong cai dat -> Thu thap (saves locally), Bat dau (uses local list) -> hoat dong nhu v2.0

**Cach simulate T3.5**: F12 > Network > right-click GAS URL trong list > Block request URL.

**Notes T3:**
```

```

---

## T4: Multi-Profile Concurrency (Profile A + B)

> Setup: ca 2 profile da cai extension va dan cung GAS URL. Sheet Queue co >=20 don pending.

- [ ] **T4.1** Bam **Bat dau lay** o ca 2 profile trong vong 5s -> mo Sheet Queue, cot `claimedBy` co 2 profile khac nhau, KHONG co don nao bi 2 profile cung claim
- [ ] **T4.2** Profile A bi rate limit (xem T6.6 de simulate) -> Profile B claim batch tiep theo se nhan duoc cac don A da release
- [ ] **T4.3** Profile A crash (close tab giua chung) -> doi >15 phut -> Profile B claim -> nhan duoc cac don cua A (auto-release stale)
- [ ] **T4.4** Ca 2 profile chay den het queue -> Sheet Results khong co duplicate, dung tong don da xu ly
- [ ] **T4.5** Tien do chung trong popup A va B hien cung so

**Cach test T4.3 nhanh hon**: tam thoi sua `STALE_MS = 15 * 60 * 1000` thanh `30 * 1000` (30 giay) trong GAS, redeploy. **Nho doi lai sau khi test xong.**

**Notes T4:**
```

```

---

## T5: Popup UI

- [ ] **T5.1** Lan dau mo extension -> header hien `profile-xxxxxxxx` (8 chars random)
- [ ] **T5.2** Dong popup, mo lai -> profile ID y nguyen
- [ ] **T5.3** Cai dat **So trang = 5**, dong popup, mo lai -> van la 5
- [ ] **T5.4** Co GAS URL: Thu thap & Day -> orders pushed to Sheet, **Tien do chung** xuat hien
- [ ] **T5.5** Khong GAS URL: Thu thap & Day -> orders luu local, khong push Sheet, **Tien do chung** an
- [ ] **T5.6** **Tien do chung** so khop voi Sheet (count thu cong)
- [ ] **T5.7** Bam **Cap nhat** -> so cap nhat dung
- [ ] **T5.8** Test Google Sheet -> hien `Ket noi thanh cong!`
- [ ] **T5.9** Sau khi extract vai don -> bam **Xuat CSV** -> file co BOM, mo Excel khong lon font, du cot
- [ ] **T5.10** Bam **Xoa du lieu** -> data clear, sheetUrl/profileId/delay/pageCount giu nguyen

**Notes T5:**
```

```

---

## T6: Edge Cases

- [ ] **T6.1** Push 200 don 1 lan -> hoan tat <10s, Sheet co du
- [ ] **T6.2** Don 17 chu so dau `0` (vd `09000...`) -> Sheet hien dang text, khong bi cat so 0
- [ ] **T6.3** Khach co ten chua dau phay/quote (vd `Nguyen, "An"`) -> CSV export khong vo cot
- [ ] **T6.4** Disconnect mang giua chung (DevTools Offline) -> log loi, dung; reconnect + Bat dau lay -> tiep tuc
- [ ] **T6.5** Don bi push 2 lan vao Queue -> chi co 1 row (T1.4 da cover, retest E2E)
- [ ] **T6.6** Rate limit: tam sua `checkRateLimit()` return `true` luc dau (de force trigger) -> remaining batch released, status `rateLimited: true`. **Phuc hoi sau khi test.**

**Cach simulate T6.4 mid-batch**: Khi extension dang xu ly, F12 > Network > toggle `Offline`, sau 30s toggle `Online`.

**Notes T6:**
```

```

---

## Tong ket

| Group | Tong test | Pass | Fail |
|-------|-----------|:----:|:----:|
| T1    | 10        |      |      |
| T2    | 5         |      |      |
| T3    | 6         |      |      |
| T4    | 5         |      |      |
| T5    | 10        |      |      |
| T6    | 6         |      |      |
| **Total** | **42** |      |      |

## Definition of Done

- [ ] Tat ca 42 tests pass
- [ ] Khong co data test sot lai trong Sheet
- [ ] Code da fix bug phat hien (neu co)
- [ ] Update plan.md status Phase 5 -> Done
- [ ] Update version manifest.json (neu can release v3.1)

## Unresolved questions / blockers

- (ghi vao day neu phat hien issue khong fix duoc trong scope)
