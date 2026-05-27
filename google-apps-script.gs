// ==========================================
// GOOGLE APPS SCRIPT - TikTok Order Queue Manager
// ==========================================
// Huong dan:
// 1. Tao Google Sheet moi
// 2. Vao Extensions > Apps Script
// 3. Xoa code mac dinh, dan code nay vao
// 4. Bam "Deploy" > "New deployment"
// 5. Chon Type: "Web app"
// 6. Execute as: "Me"
// 7. Who has access: "Anyone"
// 8. Bam "Deploy" > Copy URL
// 9. Dan URL vao extension
//
// Sheet tu dong tao 2 tab:
//   - "Queue":   Hang doi don hang (orderNo, status, claimedBy, claimedAt)
//   - "Results": Ket qua da extract (orderNo, name, phone, address, profile, timestamp)

var QUEUE_HEADERS = ['orderNo', 'status', 'claimedBy', 'claimedAt'];
var RESULTS_HEADERS = ['orderNo', 'name', 'phone', 'address', 'profile', 'timestamp'];
var STALE_MS = 15 * 60 * 1000; // 15 phut — tu dong release don bi "treo"

// ========== HELPERS ==========

function getOrCreateSheet(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  }
  return sheet;
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ========== ROUTING ==========

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || 'test';
  if (action === 'status') return jsonResponse(getStatus());
  return jsonResponse({ status: 'ready' }); // backward compatible
}

function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents);
    var action = payload.action;
    switch (action) {
      case 'pushOrders':    return jsonResponse(pushOrders(payload.orders));
      case 'claimBatch':    return jsonResponse(claimBatch(payload.profileId, payload.batchSize || 10));
      case 'submitResult':  return jsonResponse(submitResult(payload));
      case 'releaseOrders': return jsonResponse(releaseOrders(payload.orders));
      default:              return jsonResponse(legacySubmit(payload)); // old extension compat
    }
  } catch (err) {
    return jsonResponse({ status: 'error', message: err.message });
  }
}

// ========== PUSH ORDERS ==========
// Them danh sach don vao Queue, bo qua don da ton tai

function pushOrders(orderNos) {
  if (!Array.isArray(orderNos)) return { status: 'error', message: 'orders must be array' };
  // Validate and sanitize order numbers (17-19 digits only)
  orderNos = orderNos.map(String).filter(function(o) { return /^\d{17,19}$/.test(o); });
  if (orderNos.length === 0) return { status: 'ok', added: 0, duplicate: 0 };

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = getOrCreateSheet('Queue', QUEUE_HEADERS);
    var lastRow = sheet.getLastRow();
    var existing = new Set();
    if (lastRow > 1) {
      sheet.getRange(2, 1, lastRow - 1, 1).getValues().forEach(function(r) {
        existing.add(String(r[0]));
      });
    }
    var newOrders = orderNos.filter(function(o) { return !existing.has(String(o)); });
    if (newOrders.length > 0) {
      var rows = newOrders.map(function(o) { return [String(o), 'pending', '', '']; });
      sheet.getRange(lastRow + 1, 1, rows.length, 4).setValues(rows);
      sheet.getRange(lastRow + 1, 1, rows.length, 1).setNumberFormat('@');
    }
    return { status: 'ok', added: newOrders.length, duplicate: orderNos.length - newOrders.length };
  } finally {
    lock.releaseLock();
  }
}

// ========== CLAIM BATCH ==========
// Nhan N don chua ai xu ly, tu dong release don "treo" >15 phut

function claimBatch(profileId, batchSize) {
  if (!profileId || typeof profileId !== 'string') return { status: 'error', message: 'profileId required' };
  // Sanitize profileId to prevent formula injection in Sheet
  profileId = String(profileId).replace(/[^a-z0-9\-]/gi, '').slice(0, 30);
  batchSize = Math.min(Math.max(parseInt(batchSize) || 10, 1), 50);

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = getOrCreateSheet('Queue', QUEUE_HEADERS);
    var lastRow = sheet.getLastRow();
    if (lastRow <= 1) return { status: 'ok', orders: [] };

    var data = sheet.getRange(2, 1, lastRow - 1, 4).getValues();
    var now = new Date().getTime();
    var claimed = [];

    for (var i = 0; i < data.length; i++) {
      // Release don bi treo (claimed >15 phut)
      if (data[i][1] === 'claimed' && data[i][3]) {
        var claimedTime = new Date(data[i][3]).getTime();
        if (now - claimedTime > STALE_MS) {
          data[i][1] = 'pending';
          data[i][2] = '';
          data[i][3] = '';
        }
      }
      // Claim don pending
      if (data[i][1] === 'pending' && claimed.length < batchSize) {
        data[i][1] = 'claimed';
        data[i][2] = profileId;
        data[i][3] = new Date().toISOString();
        claimed.push(String(data[i][0]));
      }
    }

    sheet.getRange(2, 1, data.length, 4).setValues(data);
    return { status: 'ok', orders: claimed };
  } finally {
    lock.releaseLock();
  }
}

// ========== SUBMIT RESULT ==========
// Ghi ket qua vao Results, danh dau Queue la done

function submitResult(payload) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    // Ghi vao Results
    var results = getOrCreateSheet('Results', RESULTS_HEADERS);
    results.appendRow([
      String(payload.orderNo),
      payload.name || '',
      payload.phone || '',
      payload.address || '',
      payload.profile || '',
      new Date().toLocaleString('vi-VN')
    ]);
    results.getRange(results.getLastRow(), 1).setNumberFormat('@');

    // Danh dau done trong Queue
    var queue = getOrCreateSheet('Queue', QUEUE_HEADERS);
    var lastRow = queue.getLastRow();
    if (lastRow > 1) {
      var orders = queue.getRange(2, 1, lastRow - 1, 1).getValues();
      for (var i = 0; i < orders.length; i++) {
        if (String(orders[i][0]) === String(payload.orderNo)) {
          queue.getRange(i + 2, 2).setValue('done');
          break;
        }
      }
    }
    return { status: 'ok' };
  } finally {
    lock.releaseLock();
  }
}

// ========== RELEASE ORDERS ==========
// Tra lai don chua xu ly ve pending (khi bi rate limit hoac user Stop)

function releaseOrders(orderNos) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = getOrCreateSheet('Queue', QUEUE_HEADERS);
    var lastRow = sheet.getLastRow();
    if (lastRow <= 1) return { status: 'ok', released: 0 };

    var data = sheet.getRange(2, 1, lastRow - 1, 4).getValues();
    var releaseSet = new Set(orderNos.map(String));
    var released = 0;

    for (var i = 0; i < data.length; i++) {
      if (releaseSet.has(String(data[i][0])) && data[i][1] === 'claimed') {
        data[i][1] = 'pending';
        data[i][2] = '';
        data[i][3] = '';
        released++;
      }
    }

    sheet.getRange(2, 1, data.length, 4).setValues(data);
    return { status: 'ok', released: released };
  } finally {
    lock.releaseLock();
  }
}

// ========== STATUS ==========
// Tra ve so luong tung trang thai

function getStatus() {
  var sheet = getOrCreateSheet('Queue', QUEUE_HEADERS);
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return { status: 'ok', total: 0, pending: 0, claimed: 0, done: 0, failed: 0 };

  var statuses = sheet.getRange(2, 2, lastRow - 1, 1).getValues().flat();
  var validStatuses = { pending: 0, claimed: 0, done: 0, failed: 0 };
  statuses.forEach(function(s) { if (validStatuses.hasOwnProperty(s)) validStatuses[s]++; });
  var counts = { status: 'ok', total: statuses.length, pending: validStatuses.pending, claimed: validStatuses.claimed, done: validStatuses.done, failed: validStatuses.failed };
  return counts;
}

// ========== LEGACY COMPAT ==========
// Ho tro extension cu gui data khong co truong "action"

function legacySubmit(payload) {
  var items = Array.isArray(payload) ? payload : [payload];
  var results = getOrCreateSheet('Results', RESULTS_HEADERS);

  var lastRow = results.getLastRow();
  var existingOrders = [];
  if (lastRow > 1) {
    existingOrders = results.getRange(2, 1, lastRow - 1, 1).getValues()
      .flat().map(function(v) { return String(v); });
  }

  var added = 0;
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var orderNo = String(item.orderNo || '');
    if (existingOrders.indexOf(orderNo) >= 0) continue;

    results.appendRow([
      orderNo,
      item.name || '',
      item.phone || '',
      item.address || '',
      item.profile || '',
      new Date().toLocaleString('vi-VN')
    ]);
    results.getRange(results.getLastRow(), 1).setNumberFormat('@');
    existingOrders.push(orderNo);
    added++;
  }

  return { status: 'ok', added: added };
}
