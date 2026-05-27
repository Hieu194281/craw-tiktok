# Setup Guide - Multi-Account Dynamic Queue System

> Huong dan setup he thong extract don TikTok song song tren nhieu Chrome profiles
> Thoi gian setup: ~15 phut cho lan dau, ~2 phut moi profile them

## Tong quan

```
Chrome Profile 1 (account A) --\
Chrome Profile 2 (account B) ---+--> Google Apps Script --> Google Sheet
Chrome Profile 3 (account C) --/                            |- Queue (hang doi)
                                                            |- Results (du lieu)
```

- **Sheet** la noi luu hang doi don + ket qua extract
- **GAS** la API trung gian (LockService chong race condition)
- **Extension** chay tren tung Chrome profile, claim batch tu Sheet va xu ly

---

## Phan A - Setup Google Sheet & Apps Script (1 lan duy nhat)

### A1. Tao Google Sheet
1. Vao https://sheets.google.com -> tao Sheet moi
2. Doi ten Sheet (vd: `TikTok Orders Queue`)
3. Sheet se tu tao 2 tab `Queue` va `Results` khi GAS deploy lan dau

### A2. Deploy Google Apps Script
1. Trong Sheet vua tao: **Extensions > Apps Script**
2. Xoa toan bo code `Code.gs` mac dinh
3. Mo file `google-apps-script.gs` cua repo nay -> copy toan bo -> dan vao
4. Bam icon **Save** (Ctrl+S), dat ten project (vd: `TikTok Queue API`)
5. Bam **Deploy > New deployment**
6. Bam icon banh rang ben canh "Select type" -> chon **Web app**
7. Cau hinh:
   - **Description**: `v3.0 queue manager`
   - **Execute as**: `Me`
   - **Who has access**: `Anyone`
8. Bam **Deploy** -> Google se hoi authorize -> bam **Authorize access**
   - Chon Google account -> **Advanced** -> **Go to {ten project} (unsafe)** -> **Allow**
9. Copy **Web app URL** (dang `https://script.google.com/macros/s/AKfycb.../exec`)

### A3. Test endpoints (rat quan trong - lam truoc khi cai extension)
1. Mo file `test-helper.html` cua repo trong browser (double-click hoac drag vao Chrome)
2. Dan URL vua copy vao o **Google Apps Script URL** -> bam **Luu URL**
3. Bam **Run All Tests** -> doi ~10s
4. Tat ca 10 test phai **PASS** mau xanh
5. Neu fail:
   - T1.1 fail -> URL sai hoac chua deploy dung "Anyone" access
   - T1.3 fail -> orders array bi reject -> kiem tra GAS code da paste day du chua
   - T1.5/T1.6 overlap -> LockService khong chay -> redeploy lai
6. Sau khi all pass: bam **Xoa data test** de xoa cac don test ID `9000...`
   - Vao Sheet > tab `Queue` xoa thu cong cac dong orderNo bat dau `9000`
   - Vao tab `Results` xoa cac dong test (Test Customer, Legacy Test)

---

## Phan B - Setup Chrome Profile dau tien

### B1. Tao Chrome profile rieng cho account TikTok
1. Mo Chrome -> click avatar goc tren phai -> **Add** -> dat ten (vd: `TikTok Acc 1`)
2. Mot cua so Chrome moi mo ra voi profile rieng
3. Trong cua so do: dang nhap account TikTok Seller can dung
4. Ghi nho: moi profile = 1 account TikTok = 1 instance extension

### B2. Cai extension
1. Trong Chrome profile do, mo `chrome://extensions/`
2. Bat **Developer mode** (toggle goc tren phai)
3. Bam **Load unpacked** -> chon folder repo `tiktok-order-extractor`
4. Extension xuat hien voi name `TikTok Order Extractor`
5. Pin extension len toolbar (icon ghim ben canh thanh address)

### B3. Cau hinh extension
1. Click icon extension -> popup mo ra
2. Header se hien `profile-xxxxxxxx` (ID tu sinh, **moi profile mot ID khac nhau**)
3. Dan **Google Apps Script URL** vao o `Google Sheet URL`
4. Set **So trang can cao**: `3` (lay 3 trang = ~150 don/lan)
5. Set **Delay (giay)**: `5` (5s giua moi don, an toan voi rate limit)
6. Bam **Luu cai dat**
7. Bam **Test Google Sheet** -> phai hien `Ket noi thanh cong!`

---

## Phan C - Test luong end-to-end (single profile)

### C1. Thu thap don
1. Mo tab moi -> vao https://seller-vn.tiktok.com/order
2. Login (neu chua), filter theo trang thai don muon extract
3. Mo extension popup -> bam **1. Thu thap & Day**
4. Doi ~10-30s (extension auto-paginate qua N trang)
5. Log se hien:
   ```
   Thu thap trang 1/3...
   Trang 1: 50 don moi (tong: 50)
   Thu thap trang 2/3...
   Trang 2: 50 don moi (tong: 100)
   Thu thap trang 3/3...
   Trang 3: 50 don moi (tong: 150)
   Tong cong: 150 don tu 3 trang
   Day 150 don vao hang doi...
   Hang doi: +150 moi, 0 trung
   ```
6. **Tien do chung** se hien thanh xanh, `Tong: 150 | Cho: 150`
7. Mo Sheet > tab `Queue` -> phai co 150 dong status `pending`

### C2. Bat dau extract
1. Trong popup -> bam **2. Bat dau lay**
2. Tab TikTok se nhay sang trang detail don dau tien
3. Extension tu dong:
   - Click nut "hien thi SDT" (eye icon)
   - Extract ten + SDT + dia chi
   - Submit ket qua ve Sheet
   - Sleep 5s -> nhay sang don tiep theo
4. Quan sat:
   - Sheet tab `Queue` -> status chuyen `pending` -> `claimed` -> `done`
   - Sheet tab `Results` -> moi don submit them 1 dong moi
   - Popup -> `Da lay` tang dan, `Batch hien tai` la 10 (1 batch)
5. Sau 10 don: extension tu dong claim batch tiep theo (log: `Nhan batch moi: 10 don`)

### C3. Test rate limit / dung
1. Trong qua trinh chay -> bam **Dung**
2. Log: `Tra lai X don chua xu ly`
3. Sheet -> cac don dang claimed cua profile nay duoc release ve `pending`
4. Extension dung lai

---

## Phan D - Setup Chrome Profile thu 2, 3, ...

Lap lai **Phan B** voi profile moi:
1. Tao Chrome profile moi (`TikTok Acc 2`)
2. Login account TikTok khac
3. Cai extension (Load unpacked cung folder)
4. Mo popup -> **Profile ID khac nhau** so voi profile 1 (kiem tra header badge)
5. Dan **cung GAS URL** vao -> Luu cai dat
6. Khong can **Thu thap & Day** o profile 2 (don da co tu profile 1)
7. Bam **2. Bat dau lay** -> profile 2 se claim batch khac voi profile 1

### Cach test concurrency
1. Profile 1: bam **Bat dau lay**
2. Profile 2: bam **Bat dau lay** trong 10s ngay sau profile 1
3. Mo Sheet `Queue` -> cot `claimedBy` se thay xen ke `profile-xxx` cua 2 profiles
4. Khong co don nao bi 2 profile cung claim (LockService dam bao)

---

## Phan E - Troubleshooting

| Loi | Nguyen nhan | Cach fix |
|-----|-------------|----------|
| `Test Sheet` fail | URL sai hoac chua deploy "Anyone" | Re-deploy GAS, copy URL moi |
| `Khong tim thay nut Tiep` | TikTok thay doi DOM pagination | Check console, update selector trong `findNextButton()` |
| `Khong thu thap duoc` | Khong dang o trang `/order` (list) | Vao seller-vn.tiktok.com/order roi F5 |
| `TikTok CHAN` (rate limit) | Vuot ~50 reveals/account/ngay | Doi sang ngay sau, dung profile khac |
| Don bi `claimed` >15 phut | Profile crash giua chung | Tu dong release o lan claim ke tiep |
| `Hang doi rong` khi Bat dau | Chua thu thap don nao | Bam **Thu thap & Day** truoc |
| 2 profile cung claim 1 don | Khong xay ra (LockService) | Neu xay ra, redeploy GAS, kiem tra log |

### Reset toan bo
- **Reset Sheet**: vao tab `Queue` -> chon tat ca rows (tru header) -> Delete. Tuong tu `Results`.
- **Reset extension state**: popup -> `Xoa du lieu` (giu cai dat)
- **Reset profile ID**: chrome.storage.local.remove(['profileId']) trong DevTools console

---

## Phan F - Daily workflow goi y

**Buoi sang (1 nguoi setup chinh)**:
1. Vao Sheet -> xoa data hom truoc (tab Queue + Results)
2. Profile chinh: filter don can extract -> **Thu thap & Day** (3 trang, 150 don)
3. Bao team profile 2, 3, ... bam **Bat dau lay**

**Trong ngay**:
- Moi profile chay den khi rate limit hoac het queue
- Profile bi limit -> Stop -> don release -> profile khac claim
- Theo doi **Tien do chung** trong popup (bam **Cap nhat**)

**Cuoi ngay**:
- Mo Sheet tab `Results` -> File -> Download -> CSV
- Luu lai du lieu, xoa Sheet de san sang ngay mai

---

## Capacity tham khao

| Profile | Reveals/ngay | Don/3 trang | Throughput |
|---------|--------------|-------------|------------|
| 1 profile | ~50 | 150 (chia se queue) | 50 don/profile/ngay |
| 2 profiles | ~100 | 150 | 75 don/profile/ngay |
| 3 profiles | ~150 | 150 | 50 don/profile/ngay (toi uu) |
| 4 profiles | ~200 | Phai thu thap >150 | Tang queue thu thap nhieu trang hon |

**Khuyen nghi**: 3 profiles + 150 don = 1 ngay xu ly het queue.
