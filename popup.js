(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // UI elements
  const statusBar = $('statusBar');
  const statusText = $('statusText');
  const totalOrders = $('totalOrders');
  const extracted = $('extracted');
  const failed = $('failed');
  const btnCollect = $('btnCollect');
  const btnStart = $('btnStart');
  const btnStop = $('btnStop');
  const btnExport = $('btnExport');
  const btnClear = $('btnClear');
  const btnSave = $('btnSave');
  const btnTestSheet = $('btnTestSheet');
  const btnRefreshProgress = $('btnRefreshProgress');
  const delayInput = $('delay');
  const pageCountInput = $('pageCount');
  const sheetUrlInput = $('sheetUrl');
  const dataTable = $('dataTable');
  const logArea = $('logArea');
  const profileBadge = $('profileBadge');
  const saveMsg = $('saveMsg');
  const gsStatus = $('gsStatus');
  const orderRange = $('orderRange');
  const globalProgressSection = $('globalProgressSection');
  const globalProgressBar = $('globalProgressBar');
  const globalStats = $('globalStats');

  // ========== PROFILE ID ==========

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

  // ========== UI HELPERS ==========

  function setStatus(type, text) {
    statusBar.className = 'status-bar status-' + type;
    statusText.textContent = text;
  }

  function addLog(msg, type) {
    const entry = document.createElement('div');
    entry.className = 'log-entry' + (type ? ' log-' + type : '');
    const time = new Date().toLocaleTimeString('vi-VN');
    entry.textContent = '[' + time + '] ' + msg;
    logArea.prepend(entry);
  }

  function renderData(data) {
    if (!data || data.length === 0) {
      dataTable.innerHTML = '<div class="empty-msg">Chua co du lieu</div>';
      btnExport.disabled = true;
      return;
    }
    btnExport.disabled = false;

    // Use DOM API to prevent XSS from scraped data
    const table = document.createElement('table');
    const thead = document.createElement('tr');
    ['#', 'Ma don', 'Ten', 'SDT', 'Dia chi'].forEach((h) => {
      const th = document.createElement('th');
      th.textContent = h;
      thead.appendChild(th);
    });
    table.appendChild(thead);

    data.forEach((item, i) => {
      const tr = document.createElement('tr');
      const cells = [
        String(i + 1),
        (item.orderNo || '').slice(-6),
        item.name || '-',
        item.phone || '-',
        item.address || '-',
      ];
      cells.forEach((val) => {
        const td = document.createElement('td');
        td.textContent = val;
        tr.appendChild(td);
      });
      table.appendChild(tr);
    });

    dataTable.innerHTML = '';
    dataTable.appendChild(table);
  }

  function updateUI(state) {
    const data = state.extractedData || [];
    const failCount = state.failCount || 0;
    const isRunning = state.isRunning || false;
    const queueMode = state.queueMode || false;

    // Show batch size or static order count
    if (queueMode) {
      const batch = state.currentBatch || [];
      totalOrders.textContent = batch.length;
    } else {
      totalOrders.textContent = (state.orders || []).length;
    }

    extracted.textContent = data.length;
    failed.textContent = failCount;

    // Order range info
    if (state.allOrdersCount && !queueMode) {
      orderRange.textContent = 'Tong ' + state.allOrdersCount + ' don';
    } else if (queueMode) {
      orderRange.textContent = 'Queue mode — don duoc phan phoi tu Google Sheet';
    } else {
      orderRange.textContent = '';
    }

    if (isRunning) {
      const idx = queueMode ? (state.batchIndex || 0) : (state.currentIndex || 0);
      const total = queueMode ? (state.currentBatch || []).length : (state.orders || []).length;
      setStatus('running', 'Dang chay... (' + idx + '/' + total + ')');
      btnCollect.disabled = true;
      btnStart.disabled = true;
      btnStop.disabled = false;
    } else if (state.rateLimited) {
      setStatus('blocked', 'TikTok da chan! Da lay ' + data.length + ' don.');
      btnCollect.disabled = false;
      btnStart.disabled = false;
      btnStop.disabled = true;
    } else if (!queueMode && data.length > 0 && (state.orders || []).length > 0
      && data.length + failCount >= (state.orders || []).length) {
      setStatus('done', 'Hoan tat!');
      btnCollect.disabled = false;
      btnStart.disabled = true;
      btnStop.disabled = true;
    } else {
      const orderCount = queueMode ? (state.currentBatch || []).length : (state.orders || []).length;
      setStatus('idle', orderCount > 0 ? 'San sang - ' + orderCount + ' don' : 'San sang');
      btnCollect.disabled = false;
      btnStart.disabled = false;
      btnStop.disabled = true;
    }

    renderData(data);
  }

  // ========== GLOBAL PROGRESS ==========

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
      const failedCount = data.failed || 0;
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;

      globalProgressBar.style.width = pct + '%';
      globalStats.textContent = 'Tong: ' + total + ' | Xong: ' + done
        + ' | Dang XL: ' + claimed + ' | Cho: ' + pending + ' | Loi: ' + failedCount;
    } catch (err) {
      globalStats.textContent = 'Loi ket noi Sheet';
    }
  }

  // ========== SETTINGS ==========

  function loadSettings() {
    chrome.storage.local.get(['sheetUrl', 'delay', 'pageCount'], (s) => {
      sheetUrlInput.value = s.sheetUrl || '';
      delayInput.value = (s.delay || 5000) / 1000;
      pageCountInput.value = s.pageCount || 1;
    });
  }

  function loadState() {
    chrome.storage.local.get(null, (state) => {
      updateUI(state);
    });
  }

  // Send message to content script of active tab
  function sendToContent(action, data, callback) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) {
        addLog('Khong tim thay tab TikTok!', 'error');
        return;
      }
      chrome.tabs.sendMessage(tabs[0].id, { action, ...data }, (response) => {
        if (chrome.runtime.lastError) {
          addLog('Loi: ' + chrome.runtime.lastError.message, 'error');
          return;
        }
        if (callback) callback(response);
      });
    });
  }

  // ========== EVENT HANDLERS ==========

  // Save settings
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
      refreshGlobalProgress();
    });
  });

  // Test Google Sheet connection
  btnTestSheet.addEventListener('click', () => {
    const url = sheetUrlInput.value.trim();
    if (!url) {
      gsStatus.textContent = 'Chua nhap URL!';
      gsStatus.className = 'gs-status gs-err';
      gsStatus.style.display = 'block';
      return;
    }
    gsStatus.textContent = 'Dang test...';
    gsStatus.className = 'gs-status';
    gsStatus.style.display = 'block';

    fetch(url + '?action=test', { method: 'GET' })
      .then((r) => r.json())
      .then((data) => {
        if (data.status === 'ready') {
          gsStatus.textContent = 'Ket noi thanh cong!';
          gsStatus.className = 'gs-status gs-ok';
        } else {
          gsStatus.textContent = 'Phan hoi khong dung: ' + JSON.stringify(data);
          gsStatus.className = 'gs-status gs-err';
        }
      })
      .catch((err) => {
        gsStatus.textContent = 'Loi: ' + err.message;
        gsStatus.className = 'gs-status gs-err';
      });
  });

  // Collect orders — content.js handles both DOM scraping AND pushing to Sheet
  // (running fully in content script avoids popup-close interruption during long pagination)
  btnCollect.addEventListener('click', () => {
    const pageCount = parseInt(pageCountInput.value) || 1;
    btnCollect.disabled = true;
    btnCollect.textContent = 'Dang thu thap...';

    sendToContent('collectOrders', { pageCount }, (response) => {
      btnCollect.disabled = false;
      btnCollect.textContent = '1. Thu thap & Day';

      if (response && response.success) {
        addLog('Thu thap ' + response.count + ' don tu ' + pageCount + ' trang', 'success');
        if (response.pushed !== undefined) {
          addLog('Hang doi: +' + response.pushed + ' moi, ' + (response.duplicate || 0) + ' trung', 'success');
        }
        refreshGlobalProgress();
        loadState();
      } else if (response) {
        addLog('Khong thu thap duoc: ' + (response.error || 'unknown'), 'error');
      } else {
        // No response — popup likely closed, but content.js continues. Tell user to refresh progress.
        addLog('Popup mat ket noi. Bam Cap nhat de check.', '');
      }
    });
  });

  // Start extraction
  btnStart.addEventListener('click', async () => {
    const state = await chrome.storage.local.get(['orders', 'delay', 'sheetUrl', 'profileId', 'queueMode']);
    const delay = state.delay || 5000;
    const sheetUrl = state.sheetUrl || '';
    const profileId = state.profileId || 'local';
    const queueMode = state.queueMode || false;

    if (queueMode && sheetUrl) {
      // Queue mode: claim first batch from Sheet
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
          rateLimited: false, failCount: 0, extractedData: [],
        });
        addLog('Bat dau voi ' + batch.length + ' don (delay: ' + (delay / 1000) + 's)', 'success');

        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs[0]) {
            chrome.tabs.update(tabs[0].id, {
              url: 'https://seller-vn.tiktok.com/order/detail?order_no=' + encodeURIComponent(batch[0]) + '&shop_region=VN'
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
              url: 'https://seller-vn.tiktok.com/order/detail?order_no=' + encodeURIComponent(orders[0]) + '&shop_region=VN'
            });
          }
        });
      }
    }
    loadState();
  });

  // Stop — release remaining batch orders
  btnStop.addEventListener('click', async () => {
    const state = await chrome.storage.local.get(['sheetUrl', 'currentBatch', 'batchIndex', 'queueMode']);
    if (state.queueMode && state.sheetUrl && state.currentBatch) {
      // Skip current in-progress order (+1), release only untouched ones
      const remaining = (state.currentBatch || []).slice((state.batchIndex || 0) + 1);
      if (remaining.length > 0) {
        try {
          await fetch(state.sheetUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: JSON.stringify({ action: 'releaseOrders', orders: remaining }),
            redirect: 'follow',
          });
          addLog('Tra lai ' + remaining.length + ' don chua xu ly', '');
        } catch (err) { /* ignore release error */ }
      }
    }
    await chrome.storage.local.set({ isRunning: false });
    addLog('Da dung', 'error');
    loadState();
    refreshGlobalProgress();
  });

  // Export CSV
  btnExport.addEventListener('click', () => {
    chrome.storage.local.get(['extractedData'], (state) => {
      const data = state.extractedData || [];
      if (data.length === 0) return;

      const BOM = '\uFEFF';
      let csv = BOM + 'Ma don hang,Ten khach hang,So dien thoai,Dia chi\n';
      data.forEach((item) => {
        const row = [
          '="' + (item.orderNo || '') + '"',
          '"' + (item.name || '').replace(/"/g, '""') + '"',
          '"' + (item.phone || '') + '"',
          '"' + (item.address || '').replace(/"/g, '""') + '"'
        ];
        csv += row.join(',') + '\n';
      });

      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'tiktok-orders-' + new Date().toISOString().slice(0, 10) + '.csv';
      a.click();
      URL.revokeObjectURL(url);
      addLog('Da xuat CSV (' + data.length + ' dong)', 'success');
    });
  });

  // Clear data
  btnClear.addEventListener('click', () => {
    if (confirm('Xoa du lieu da lay? (Cai dat khong bi xoa)')) {
      chrome.storage.local.get(['profileId', 'sheetUrl', 'delay', 'pageCount'], (settings) => {
        chrome.storage.local.clear(() => {
          chrome.storage.local.set(settings, () => {
            addLog('Da xoa du lieu');
            loadState();
          });
        });
      });
    }
  });

  // Refresh global progress
  btnRefreshProgress.addEventListener('click', () => {
    refreshGlobalProgress();
  });

  // Listen for updates from content script
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'log') {
      addLog(msg.text, msg.logType || '');
    }
    if (msg.type === 'stateChanged') {
      loadState();
    }
  });

  // ========== INITIAL LOAD ==========

  ensureProfileId((id) => {
    profileBadge.textContent = id;
    loadSettings();
    loadState();
    refreshGlobalProgress();
  });
})();
