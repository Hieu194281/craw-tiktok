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
  const delayInput = $('delay');
  const sheetUrlInput = $('sheetUrl');
  const dataTable = $('dataTable');
  const logArea = $('logArea');
  const saveMsg = $('saveMsg');
  const gsStatus = $('gsStatus');
  const orderRange = $('orderRange');

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
    const orders = state.orders || [];

    totalOrders.textContent = orders.length;
    extracted.textContent = data.length;
    failed.textContent = failCount;

    if (orders.length > 0) {
      orderRange.textContent = 'Tong ' + orders.length + ' don tu trang nay';
    } else {
      orderRange.textContent = '';
    }

    if (isRunning) {
      const idx = state.currentIndex || 0;
      setStatus('running', 'Dang chay... (' + idx + '/' + orders.length + ')');
      btnCollect.disabled = true;
      btnStart.disabled = true;
      btnStop.disabled = false;
    } else if (state.rateLimited) {
      setStatus('blocked', 'TikTok da chan! Da lay ' + data.length + ' don.');
      btnCollect.disabled = false;
      btnStart.disabled = false;
      btnStop.disabled = true;
    } else if (data.length > 0 && orders.length > 0 && data.length + failCount >= orders.length) {
      setStatus('done', 'Hoan tat!');
      btnCollect.disabled = false;
      btnStart.disabled = true;
      btnStop.disabled = true;
    } else {
      setStatus('idle', orders.length > 0 ? 'San sang - ' + orders.length + ' don' : 'San sang');
      btnCollect.disabled = false;
      btnStart.disabled = orders.length === 0;
      btnStop.disabled = true;
    }

    renderData(data);
  }

  // ========== SETTINGS ==========

  function loadSettings() {
    chrome.storage.local.get(['sheetUrl', 'delay'], (s) => {
      sheetUrlInput.value = s.sheetUrl || '';
      delayInput.value = (s.delay || 5000) / 1000;
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
    };
    chrome.storage.local.set(settings, () => {
      saveMsg.style.display = 'block';
      setTimeout(() => { saveMsg.style.display = 'none'; }, 2000);
      addLog('Luu cai dat OK', 'success');
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

  // Collect orders from current page
  btnCollect.addEventListener('click', () => {
    btnCollect.disabled = true;
    btnCollect.textContent = 'Dang thu thap...';

    sendToContent('collectOrders', {}, (response) => {
      btnCollect.disabled = false;
      btnCollect.textContent = '1. Thu thap trang nay';

      if (response && response.success) {
        addLog('Thu thap ' + response.count + ' don tu trang hien tai', 'success');
        loadState();
      } else if (response) {
        addLog('Khong thu thap duoc: ' + (response.error || 'unknown'), 'error');
      } else {
        addLog('Mat ket noi voi tab.', 'error');
      }
    });
  });

  // Start extraction
  btnStart.addEventListener('click', async () => {
    const state = await chrome.storage.local.get(['orders', 'delay']);
    const orders = state.orders || [];
    const delay = state.delay || 5000;

    if (orders.length === 0) {
      addLog('Chua co don nao, hay thu thap truoc!', 'error');
      return;
    }

    await chrome.storage.local.set({
      isRunning: true, currentIndex: 0, rateLimited: false, failCount: 0,
    });
    addLog('Bat dau (delay: ' + (delay / 1000) + 's)', 'success');

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.update(tabs[0].id, {
          url: 'https://seller-vn.tiktok.com/order/detail?order_no=' + encodeURIComponent(orders[0]) + '&shop_region=VN'
        });
      }
    });
    loadState();
  });

  // Stop
  btnStop.addEventListener('click', async () => {
    await chrome.storage.local.set({ isRunning: false });
    addLog('Da dung', 'error');
    loadState();
  });

  // Export CSV
  btnExport.addEventListener('click', () => {
    chrome.storage.local.get(['extractedData'], (state) => {
      const data = state.extractedData || [];
      if (data.length === 0) return;

      const BOM = '﻿';
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

  // Clear data (preserve settings)
  btnClear.addEventListener('click', () => {
    if (confirm('Xoa du lieu da lay? (Cai dat khong bi xoa)')) {
      chrome.storage.local.get(['sheetUrl', 'delay'], (settings) => {
        chrome.storage.local.clear(() => {
          chrome.storage.local.set(settings, () => {
            addLog('Da xoa du lieu');
            loadState();
          });
        });
      });
    }
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

  loadSettings();
  loadState();
})();
