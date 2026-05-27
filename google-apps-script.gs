// ==========================================
// GOOGLE APPS SCRIPT - TikTok Order Results
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
// Sheet tu dong tao tab "Results" voi cot:
//   orderNo | name | phone | address | timestamp

var RESULTS_HEADERS = ['orderNo', 'name', 'phone', 'address', 'timestamp'];

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
  return jsonResponse({ status: 'ready' });
}

function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents);
    return jsonResponse(submitResult(payload));
  } catch (err) {
    return jsonResponse({ status: 'error', message: err.message });
  }
}

// ========== SUBMIT RESULT ==========
// Ghi mot hoac nhieu ket qua vao Results. Bo qua don da co.

function submitResult(payload) {
  var items = Array.isArray(payload) ? payload : [payload];
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
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
      if (!orderNo || existingOrders.indexOf(orderNo) >= 0) continue;

      results.appendRow([
        orderNo,
        item.name || '',
        item.phone || '',
        item.address || '',
        new Date().toLocaleString('vi-VN')
      ]);
      results.getRange(results.getLastRow(), 1).setNumberFormat('@');
      existingOrders.push(orderNo);
      added++;
    }

    return { status: 'ok', added: added };
  } finally {
    lock.releaseLock();
  }
}
