(function () {
  'use strict';

  // ========== UTILITIES ==========

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function log(text, logType) {
    console.log('[TikTok Extractor]', text);
    chrome.runtime.sendMessage({ type: 'log', text, logType }).catch(() => {});
  }

  function notifyPopup() {
    chrome.runtime.sendMessage({ type: 'stateChanged' }).catch(() => {});
  }

  function findByText(searchText) {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      null
    );
    while (walker.nextNode()) {
      if (walker.currentNode.textContent.trim() === searchText) {
        return walker.currentNode.parentElement;
      }
    }
    return null;
  }

  function waitForText(text, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const el = findByText(text);
      if (el) return resolve(el);

      const observer = new MutationObserver(() => {
        const el = findByText(text);
        if (el) {
          observer.disconnect();
          resolve(el);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => {
        observer.disconnect();
        reject(new Error('Timeout waiting for: ' + text));
      }, timeout);
    });
  }

  // ========== ORDER LIST: COLLECT ORDER NUMBERS (CURRENT PAGE ONLY) ==========

  function collectOrderNumbers() {
    const orders = [];
    const seen = new Set();

    // Strategy 1: Find from links to order detail pages
    document.querySelectorAll('a[href*="order/detail"], a[href*="order_no"]').forEach((link) => {
      const match = link.href.match(/order_no=(\d+)/);
      if (match) {
        const id = String(match[1]);
        if (!seen.has(id)) {
          seen.add(id);
          orders.push(id);
        }
      }
    });

    // Strategy 2: Find from page header spans
    if (orders.length === 0) {
      document.querySelectorAll('.p-page-header-title span').forEach((el) => {
        const text = String(el.textContent).trim();
        if (/^\d{17,19}$/.test(text) && !seen.has(text)) {
          seen.add(text);
          orders.push(text);
        }
      });
    }

    // Strategy 3: Find long numeric strings from table cells
    if (orders.length === 0) {
      const allElements = document.querySelectorAll('td, div, span, a');
      allElements.forEach((el) => {
        const text = String(el.textContent).trim();
        if (/^\d{17,19}$/.test(text) && !seen.has(text) && el.children.length === 0) {
          seen.add(text);
          orders.push(text);
        }
      });
    }

    return orders;
  }

  // ========== ORDER DETAIL: EXTRACT DATA ==========

  function findCustomerSection() {
    const header = findByText('Chi tiết khách hàng');
    if (!header) return null;

    let section = header;
    for (let i = 0; i < 6; i++) {
      if (!section.parentElement) break;
      section = section.parentElement;
      const style = window.getComputedStyle(section);
      if (
        style.backgroundColor !== 'rgba(0, 0, 0, 0)' &&
        style.backgroundColor !== 'transparent' &&
        section.offsetHeight > 100
      ) {
        return section;
      }
    }
    return section;
  }

  function simulateClick(el) {
    if (!el) return;
    const event = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      view: window,
    });
    el.dispatchEvent(event);
  }

  function findClickTarget(el) {
    let current = el;
    for (let i = 0; i < 5; i++) {
      if (!current) return el;
      if (current.tagName === 'BUTTON' || current.getAttribute('role') === 'button') {
        return current;
      }
      const style = window.getComputedStyle(current);
      if (style.cursor === 'pointer') return current;
      current = current.parentElement;
    }
    return el;
  }

  async function clickRevealButton() {
    const section = findCustomerSection();
    if (!section) {
      log('Khong tim thay phan "Chi tiet khach hang"', 'error');
      return false;
    }

    // Strategy 1: Direct selector within customer section
    const eyeIcons = section.querySelectorAll('svg[data-log_click_for="open_phone_plaintext"]');
    if (eyeIcons.length > 0) {
      for (const icon of eyeIcons) {
        const clickTarget = findClickTarget(icon);
        log('Click eye icon trong Chi tiet KH (' + eyeIcons.length + ' found)');
        simulateClick(clickTarget);
        await sleep(800);
      }
      return true;
    }

    // Strategy 2: Find by class name within customer section
    const eyeByCls = section.querySelectorAll('svg.arco-icon-eye_invisible, svg.arco-icon-eye');
    if (eyeByCls.length > 0) {
      for (const icon of eyeByCls) {
        const clickTarget = findClickTarget(icon);
        log('Click eye icon by class trong Chi tiet KH (' + eyeByCls.length + ' found)');
        simulateClick(clickTarget);
        await sleep(800);
      }
      return true;
    }

    // Strategy 3: Fallback - any small SVGs in customer section
    const allSvgs = section.querySelectorAll('svg');
    for (const svg of allSvgs) {
      const rect = svg.getBoundingClientRect();
      if (rect.width > 0 && rect.width <= 30) {
        const clickTarget = findClickTarget(svg);
        log('Click fallback SVG trong Chi tiet KH');
        simulateClick(clickTarget);
        await sleep(800);
      }
    }
    if (allSvgs.length > 0) return true;

    log('Khong tim thay nut hien thi thong tin!', 'error');
    return false;
  }

  function checkRateLimit() {
    const rateTexts = [
      'bảo vệ quyền riêng tư',
      'phần trò chuyện chính thức',
      'gửi đơn khiếu nại',
    ];

    const allText = document.body.innerText;
    for (const text of rateTexts) {
      if (allText.includes(text)) {
        const modals = document.querySelectorAll(
          '[class*="modal"], [class*="dialog"], [class*="popup"], [class*="overlay"], [role="dialog"]'
        );
        for (const modal of modals) {
          if (modal.offsetHeight > 0 && modal.innerText.includes(text)) {
            return true;
          }
        }

        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          if (walker.currentNode.textContent.includes(text)) {
            const parent = walker.currentNode.parentElement;
            if (parent && parent.offsetHeight > 0) {
              const style = window.getComputedStyle(parent);
              if (style.display !== 'none' && style.visibility !== 'hidden') {
                return true;
              }
            }
          }
        }
      }
    }
    return false;
  }

  function dismissRateLimit() {
    const modalCancel = document.querySelector('button[data-log_click_for="modal_footer_cancel"]');
    if (modalCancel) {
      modalCancel.click();
      return true;
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return true;
  }

  function extractCustomerData() {
    const section = findCustomerSection();
    if (!section) return null;

    const sectionText = section.innerText;
    const lines = sectionText.split('\n').map((l) => l.trim()).filter(Boolean);

    let phone = '';
    let address = '';
    let name = '';

    // Extract name
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('Tên người dùng')) {
        if (i + 1 < lines.length) {
          name = lines[i + 1].replace(/\s*[~↗]?\s*$/, '').trim();
        }
        break;
      }
    }

    // Extract phone number
    const phonePatterns = [
      /\(\+84\)\d{9,10}/,
      /\(\+84\)[\d\s-]{9,12}/,
      /0\d{9,10}/,
      /\+84\d{9,10}/,
    ];

    for (const line of lines) {
      if (line.includes('*****')) continue;
      for (const pattern of phonePatterns) {
        const match = line.match(pattern);
        if (match) {
          phone = match[0];
          break;
        }
      }
      if (phone) break;
    }

    // Extract address
    const addressLines = [];
    let foundAddress = false;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('Địa chỉ vận chuyển')) {
        foundAddress = true;
        continue;
      }
      if (foundAddress) {
        const line = lines[i];
        if (addressLines.length === 0 && !line.includes('(+84)') && !line.match(/^\d/) && !line.includes(',')) {
          continue;
        }
        if (line.match(/\(\+84\)/) || line.match(/^0\d{9}/)) continue;
        if (line === 'Chi tiết khách hàng' || line === 'Tên người dùng') continue;
        if (line.includes('Lịch sử') || line.includes('Số tiền')) break;

        if (line.length > 3 && !line.includes('*****')) {
          addressLines.push(line);
        }
      }
    }
    address = addressLines.join(', ');

    // Get order number as STRING
    const headerSpan = document.querySelector('.p-page-header-title span');
    const urlParams = new URLSearchParams(window.location.search);
    const orderNo = String((headerSpan && headerSpan.textContent.trim()) || urlParams.get('order_no') || '');

    return { orderNo, name, phone, address };
  }

  // ========== UTILITIES ==========

  function buildOrderUrl(orderNo) {
    return 'https://seller-vn.tiktok.com/order/detail?order_no=' + orderNo + '&shop_region=VN';
  }

  // ========== GOOGLE SHEET (DIRECT WRITE) ==========

  async function pushResultToSheet(sheetUrl, data) {
    if (!sheetUrl) return;
    try {
      await fetch(sheetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({
          orderNo: data.orderNo,
          name: data.name,
          phone: data.phone,
          address: data.address,
        }),
        redirect: 'follow',
      });
      log('→ Sheet: OK', 'success');
    } catch (err) {
      log('Sheet loi: ' + err.message, 'error');
    }
  }

  // ========== MAIN PROCESS (ORDER DETAIL) ==========

  async function processOrderDetail() {
    const state = await chrome.storage.local.get(null);
    if (!state.isRunning) return;

    const sheetUrl = state.sheetUrl || '';
    const delay = state.delay || 5000;
    const orders = state.orders || [];
    const currentIndex = state.currentIndex || 0;

    if (currentIndex >= orders.length) {
      log('Da xu ly xong tat ca don hang!', 'success');
      await chrome.storage.local.set({ isRunning: false });
      notifyPopup();
      return;
    }

    const currentOrder = orders[currentIndex];
    log('Xu ly don ' + (currentIndex + 1) + '/' + orders.length + ': ' + currentOrder);

    try {
      await waitForText('Chi tiết khách hàng');
      await sleep(1500);

      const clicked = await clickRevealButton();
      if (!clicked) {
        log('Khong click duoc nut reveal - don ' + currentOrder, 'error');
        await advanceToNext(state, false);
        return;
      }

      await sleep(2000);

      // Rate limit check — stop and save partial data
      if (checkRateLimit()) {
        log('TikTok CHAN - dung lai', 'error');
        dismissRateLimit();
        await sleep(1000);

        const partialData = extractCustomerData();
        if (partialData && partialData.name) {
          const extractedData = state.extractedData || [];
          if (!extractedData.find((d) => d.orderNo === partialData.orderNo)) {
            extractedData.push(partialData);
          }
          await chrome.storage.local.set({ extractedData });
          await pushResultToSheet(sheetUrl, partialData);
        }

        await chrome.storage.local.set({ isRunning: false, rateLimited: true });
        notifyPopup();
        return;
      }

      // Extract data
      const data = extractCustomerData();
      if (data) {
        const extractedData = state.extractedData || [];
        if (!extractedData.find((d) => d.orderNo === data.orderNo)) {
          extractedData.push(data);
        }
        await chrome.storage.local.set({ extractedData });
        log('OK: ' + (data.name || '?') + ' | ' + (data.phone || 'khong co SDT'), 'success');
        await pushResultToSheet(sheetUrl, data);
      } else {
        log('Khong doc duoc du lieu - don ' + currentOrder, 'error');
      }

      await advanceToNext(state, true);
    } catch (err) {
      log('Loi: ' + err.message, 'error');
      await advanceToNext(state, false);
    }
  }

  // Navigate to next order
  async function advanceToNext(state, success) {
    const freshState = await chrome.storage.local.get(['isRunning']);
    if (!freshState.isRunning) {
      log('Da dung boi nguoi dung', '');
      notifyPopup();
      return;
    }

    const delay = state.delay || 5000;
    const failCount = success ? (state.failCount || 0) : (state.failCount || 0) + 1;
    const orders = state.orders || [];
    const nextIndex = (state.currentIndex || 0) + 1;

    await chrome.storage.local.set({ currentIndex: nextIndex, failCount });
    notifyPopup();

    if (nextIndex < orders.length) {
      await sleep(delay);
      window.location.href = buildOrderUrl(orders[nextIndex]);
    } else {
      log('HOAN TAT! Da xu ly ' + orders.length + ' don.', 'success');
      await chrome.storage.local.set({ isRunning: false });
      notifyPopup();
    }
  }

  // ========== MESSAGE HANDLER ==========

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'collectOrders') {
      const url = window.location.href;
      if (!url.includes('seller-vn.tiktok.com/order') || url.includes('/order/detail')) {
        sendResponse({ success: false, error: 'Khong phai trang danh sach don hang' });
        return;
      }

      try {
        const allOrders = collectOrderNumbers();

        if (allOrders.length === 0) {
          sendResponse({ success: false, error: 'Khong tim thay don hang nao' });
          return;
        }

        chrome.storage.local.set({
          orders: allOrders,
          allOrdersCount: allOrders.length,
          currentIndex: 0,
          extractedData: [],
          failCount: 0,
          rateLimited: false,
        }, () => {
          sendResponse({
            success: true,
            count: allOrders.length,
            total: allOrders.length,
          });
        });

        return true; // async sendResponse
      } catch (err) {
        log('Loi collectOrders: ' + err.message, 'error');
        sendResponse({ success: false, error: err.message });
      }
    }
  });

  // ========== AUTO-START ON ORDER DETAIL PAGE ==========

  async function init() {
    const url = window.location.href;
    if (url.includes('/order/detail')) {
      const state = await chrome.storage.local.get(['isRunning']);
      if (state.isRunning) {
        await sleep(2000);
        processOrderDetail().catch((err) => {
          console.error('[TikTok Extractor] Fatal:', err);
        });
      }
    }
  }

  init();
})();
