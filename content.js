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

  // ========== ORDER LIST: COLLECT ORDER NUMBERS ==========

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

  // ========== PAGINATION HELPERS ==========

  // Detect disabled pagination item (TikTok uses p- prefix, older Arco uses arco-)
  function isPaginationDisabled(el) {
    if (!el) return true;
    if (el.disabled) return true;
    if (el.getAttribute('aria-disabled') === 'true') return true;
    const cls = el.className || '';
    return /(?:^|\s)(p|arco)-pagination-item-disabled(?:\s|$)/.test(cls)
      || /\bdisabled\b/i.test(cls);
  }

  // Find Next pagination button — multiple fallback strategies
  function findNextButton() {
    // Strategy 1: TikTok current DOM uses "p-" prefix
    const tiktokNext = document.querySelector('li.p-pagination-item-next, button.p-pagination-item-next');
    if (tiktokNext && !isPaginationDisabled(tiktokNext) && isVisible(tiktokNext)) return tiktokNext;

    // Strategy 2: Older Arco UI pagination
    const arcoNext = document.querySelector('li.arco-pagination-item-next, button.arco-pagination-item-next');
    if (arcoNext && !isPaginationDisabled(arcoNext) && isVisible(arcoNext)) return arcoNext;

    // Strategy 3: aria-label = "Next" / "Tiếp" / "Trang sau" (case-insensitive)
    const ariaCandidates = document.querySelectorAll('[aria-label="Next" i], [aria-label*="next" i], [aria-label*="tiep" i], [aria-label*="sau" i]');
    for (const el of ariaCandidates) {
      if (!isPaginationDisabled(el) && isVisible(el)) return el;
    }

    // Strategy 4: Any pagination container — find rightmost clickable with right-arrow icon
    const paginations = document.querySelectorAll('.p-pagination, .arco-pagination, [class*="pagination" i]');
    for (const pag of paginations) {
      const items = Array.from(pag.querySelectorAll('li, button, [role="button"]'));
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i];
        if (isPaginationDisabled(item) || !isVisible(item)) continue;
        const text = (item.textContent || '').trim();
        if (text === '>' || /^Next$/i.test(text)
          || item.querySelector('svg[class*="right" i], svg[class*="next" i]')) {
          return item;
        }
      }
    }

    return null;
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  function getCurrentPageNum() {
    // Strategy 1: aria-current (most reliable, TikTok uses this)
    const ariaCurrent = document.querySelector('[aria-current="page"], [aria-current="true"]');
    if (ariaCurrent) {
      const n = parseInt((ariaCurrent.textContent || '').trim(), 10);
      if (!isNaN(n)) return n;
    }
    // Strategy 2: TikTok p- prefix or Arco active class
    const active = document.querySelector('.p-pagination-item-active, .arco-pagination-item-active, [class*="pagination" i] [class*="active" i]');
    if (active) {
      const n = parseInt((active.textContent || '').trim(), 10);
      if (!isNaN(n)) return n;
    }
    return 0;
  }

  // Build a signature of the current page that changes when pagination loads new data.
  // Combines: current page num + first/last order_no on the page + total order count.
  function getPageSignature() {
    const pageNum = getCurrentPageNum();
    const orders = collectOrderNumbers();
    const first = orders[0] || '';
    const last = orders[orders.length - 1] || '';
    return pageNum + '|' + first + '|' + last + '|' + orders.length;
  }

  // Wait for the page to change after clicking Next.
  // Detects via signature change (order_no rotation) — more reliable than UI state.
  async function waitForPageChange(previousSignature, timeout = 12000) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      const current = getPageSignature();
      // Need orders count > 0 to confirm new page rendered
      const orderCount = parseInt(current.split('|').pop(), 10);
      if (current !== previousSignature && orderCount > 0) {
        await sleep(700); // settle time for DOM render + lazy images
        // Re-verify signature stable (not still mutating)
        const verify = getPageSignature();
        if (verify === current) return true;
      }
      await sleep(150);
    }
    return false;
  }

  // Click that simulates real user interaction better
  function clickPaginationButton(el) {
    if (!el) return;
    try {
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
    } catch (e) { /* ignore older browsers */ }

    // Some Arco items wrap the actual button in a span; click the deepest interactive child
    let target = el;
    const inner = el.querySelector('button, a, [role="button"]');
    if (inner && inner !== el) target = inner;

    // Dispatch full pointer + mouse sequence (TikTok React handlers may need this)
    const opts = { bubbles: true, cancelable: true, view: window };
    target.dispatchEvent(new PointerEvent('pointerdown', opts));
    target.dispatchEvent(new MouseEvent('mousedown', opts));
    target.dispatchEvent(new PointerEvent('pointerup', opts));
    target.dispatchEvent(new MouseEvent('mouseup', opts));
    target.dispatchEvent(new MouseEvent('click', opts));
  }

  // Collect orders across multiple pages with auto-pagination
  async function collectOrdersMultiPage(pageCount) {
    const allOrders = [];
    const seen = new Set();

    for (let page = 1; page <= pageCount; page++) {
      log('Thu thap trang ' + page + '/' + pageCount + '...');

      const pageOrders = collectOrderNumbers();
      let newCount = 0;
      for (const order of pageOrders) {
        if (!seen.has(order)) {
          seen.add(order);
          allOrders.push(order);
          newCount++;
        }
      }

      log('Trang ' + page + ': ' + newCount + ' don moi (tong: ' + allOrders.length + ')', 'success');

      if (page >= pageCount) break;
      if (pageOrders.length === 0) {
        log('Trang rong - dung lai', '');
        break;
      }

      // Capture signature BEFORE click
      const prevSig = getPageSignature();

      // Find Next button
      const nextBtn = findNextButton();
      if (!nextBtn) {
        log('Khong tim thay nut "Tiep" - da den trang cuoi', '');
        break;
      }

      log('Click nut Tiep (signature truoc: ' + prevSig.slice(0, 30) + '...)');
      clickPaginationButton(nextBtn);

      const changed = await waitForPageChange(prevSig);
      if (!changed) {
        const newSig = getPageSignature();
        log('Timeout chuyen trang. Sig hien tai: ' + newSig.slice(0, 30) + '... - dung lai', 'error');
        break;
      }

      // Random delay to avoid anti-bot detection (1.5-2.5s)
      const delay = 1500 + Math.random() * 1000;
      await sleep(delay);
    }

    log('Tong cong: ' + allOrders.length + ' don tu ' + pageCount + ' trang', 'success');
    return allOrders;
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

  // ========== VALIDATION ==========

  function isValidOrderNo(orderNo) {
    return /^\d{17,19}$/.test(String(orderNo));
  }

  function buildOrderUrl(orderNo) {
    return 'https://seller-vn.tiktok.com/order/detail?order_no=' + orderNo + '&shop_region=VN';
  }

  // ========== GOOGLE SHEET API ==========

  async function callSheetAPI(sheetUrl, action, data) {
    if (!sheetUrl) return null;
    try {
      const body = action ? { action, ...data } : data;
      const response = await fetch(sheetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(body),
        redirect: 'follow',
      });
      return await response.json();
    } catch (err) {
      log('Sheet API loi (' + (action || 'legacy') + '): ' + err.message, 'error');
      return null;
    }
  }

  async function claimNextBatch(sheetUrl, profileId, batchSize) {
    const result = await callSheetAPI(sheetUrl, 'claimBatch', {
      profileId: profileId,
      batchSize: batchSize || 10,
    });
    if (result && result.status === 'ok') {
      return result.orders || [];
    }
    return [];
  }

  async function releaseRemainingOrders(sheetUrl, currentBatch, batchIndex) {
    const remaining = currentBatch.slice(batchIndex);
    if (remaining.length === 0 || !sheetUrl) return;
    log('Tra lai ' + remaining.length + ' don chua xu ly...', '');
    await callSheetAPI(sheetUrl, 'releaseOrders', { orders: remaining });
  }

  async function submitResultToSheet(sheetUrl, data, profileId) {
    if (!sheetUrl) return;
    const result = await callSheetAPI(sheetUrl, 'submitResult', {
      orderNo: data.orderNo,
      name: data.name,
      phone: data.phone,
      address: data.address,
      profile: profileId,
    });
    if (result && result.status === 'ok') {
      log('→ Sheet Queue: OK', 'success');
    }
  }

  // Push collected orders to Sheet queue (runs in content.js so it survives popup close)
  async function pushOrdersToSheet(sheetUrl, orders) {
    if (!sheetUrl || !orders || orders.length === 0) return null;
    log('Day ' + orders.length + ' don vao hang doi...');
    const result = await callSheetAPI(sheetUrl, 'pushOrders', { orders });
    if (result && result.status === 'ok') {
      log('Hang doi: +' + result.added + ' moi, ' + (result.duplicate || 0) + ' trung', 'success');
      return result;
    }
    log('Loi day vao hang doi: ' + JSON.stringify(result), 'error');
    return null;
  }

  // ========== MAIN PROCESS ==========

  async function processOrderDetail() {
    const state = await chrome.storage.local.get(null);
    if (!state.isRunning) return;

    const sheetUrl = state.sheetUrl || '';
    const profileId = state.profileId || 'local';
    const queueMode = state.queueMode || false;
    const delay = state.delay || 5000;

    // Determine current order from batch (queue) or static list (local)
    let currentOrder;
    if (queueMode) {
      const batch = state.currentBatch || [];
      const batchIdx = state.batchIndex || 0;
      if (batchIdx >= batch.length) {
        // Batch exhausted — claim next batch
        const newBatch = await claimNextBatch(sheetUrl, profileId, 10);
        if (newBatch.length === 0) {
          log('Khong con don nao trong hang doi!', 'success');
          await chrome.storage.local.set({ isRunning: false });
          notifyPopup();
          return;
        }
        await chrome.storage.local.set({ currentBatch: newBatch, batchIndex: 0 });
        // Sync local state for accurate displayIdx below
        state.currentBatch = newBatch;
        state.batchIndex = 0;
        currentOrder = newBatch[0];
        log('Nhan batch moi: ' + newBatch.length + ' don');
      } else {
        currentOrder = batch[batchIdx];
      }
    } else {
      // Local-only mode (backward compat)
      const orders = state.orders || [];
      const currentIndex = state.currentIndex || 0;
      if (currentIndex >= orders.length) {
        log('Da xu ly xong tat ca don hang!', 'success');
        await chrome.storage.local.set({ isRunning: false });
        notifyPopup();
        return;
      }
      currentOrder = orders[currentIndex];
    }

    const displayIdx = queueMode
      ? (state.batchIndex || 0) + 1 + '/' + (state.currentBatch || []).length
      : (state.currentIndex || 0) + 1 + '/' + (state.orders || []).length;
    log('Xu ly don ' + displayIdx + ': ' + currentOrder);

    try {
      await waitForText('Chi tiết khách hàng');
      await sleep(1500);

      const clicked = await clickRevealButton();
      if (!clicked) {
        log('Khong click duoc nut reveal - don ' + currentOrder, 'error');
        await advanceToNext(state, queueMode, false);
        return;
      }

      await sleep(2000);

      // Rate limit check — release remaining batch and stop
      if (checkRateLimit()) {
        log('TikTok CHAN - tra lai don chua xu ly va dung', 'error');
        dismissRateLimit();
        await sleep(1000);

        // Save partial data if name available
        const partialData = extractCustomerData();
        if (partialData && partialData.name) {
          const extractedData = state.extractedData || [];
          if (!extractedData.find((d) => d.orderNo === partialData.orderNo)) {
            extractedData.push(partialData);
          }
          await chrome.storage.local.set({ extractedData });
          if (queueMode) await submitResultToSheet(sheetUrl, partialData, profileId);
        }

        // Release remaining batch orders back to queue
        if (queueMode) {
          const batch = state.currentBatch || [];
          const batchIdx = (state.batchIndex || 0) + 1; // current one partially processed
          await releaseRemainingOrders(sheetUrl, batch, batchIdx);
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

        if (queueMode) {
          await submitResultToSheet(sheetUrl, data, profileId);
        } else if (sheetUrl) {
          // Legacy direct-write for non-queue local mode (Sheet URL set but not pushed to queue)
          await callSheetAPI(sheetUrl, null, {
            orderNo: data.orderNo, name: data.name,
            phone: data.phone, address: data.address,
            profile: profileId,
          });
        }
      } else {
        log('Khong doc duoc du lieu - don ' + currentOrder, 'error');
      }

      await advanceToNext(state, queueMode, true);
    } catch (err) {
      log('Loi: ' + err.message, 'error');
      await advanceToNext(state, queueMode, false);
    }
  }

  // Navigate to next order — handles both queue and local modes
  async function advanceToNext(state, queueMode, success) {
    // Re-check if user stopped during processing
    const freshState = await chrome.storage.local.get(['isRunning']);
    if (!freshState.isRunning) {
      log('Da dung boi nguoi dung', '');
      notifyPopup();
      return;
    }

    const delay = state.delay || 5000;
    const failCount = success ? (state.failCount || 0) : (state.failCount || 0) + 1;

    if (queueMode) {
      const batch = state.currentBatch || [];
      const nextBatchIdx = (state.batchIndex || 0) + 1;

      if (nextBatchIdx >= batch.length) {
        // Batch complete — claim next
        const sheetUrl = state.sheetUrl || '';
        const profileId = state.profileId || 'local';
        const newBatch = await claimNextBatch(sheetUrl, profileId, 10);

        if (newBatch.length === 0) {
          log('HOAN TAT! Khong con don nao.', 'success');
          await chrome.storage.local.set({ isRunning: false, failCount });
          notifyPopup();
          return;
        }

        log('Batch moi: ' + newBatch.length + ' don');
        await chrome.storage.local.set({ currentBatch: newBatch, batchIndex: 0, failCount });
        notifyPopup();
        await sleep(delay);
        window.location.href = buildOrderUrl(newBatch[0]);
      } else {
        await chrome.storage.local.set({ batchIndex: nextBatchIdx, failCount });
        notifyPopup();
        await sleep(delay);
        window.location.href = buildOrderUrl(batch[nextBatchIdx]);
      }
    } else {
      // Local-only mode
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
  }

  // ========== MESSAGE HANDLER ==========

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'collectOrders') {
      const url = window.location.href;
      if (!url.includes('seller-vn.tiktok.com/order') || url.includes('/order/detail')) {
        sendResponse({ success: false, error: 'Khong phai trang danh sach don hang' });
        return;
      }

      const pageCount = msg.pageCount || 1;

      // Async multi-page collection + push to Sheet (runs entirely in content script,
      // survives popup close because content script lifecycle is tied to the tab).
      (async () => {
        try {
          const allOrders = await collectOrdersMultiPage(pageCount);

          if (allOrders.length === 0) {
            sendResponse({ success: false, error: 'Khong tim thay don hang nao' });
            return;
          }

          // Save locally first (always, even if push fails later)
          await chrome.storage.local.set({
            orders: allOrders,
            allOrdersCount: allOrders.length,
            currentIndex: 0,
            extractedData: [],
            failCount: 0,
            rateLimited: false,
          });

          // Push to Sheet queue if URL configured (continues even if popup closed)
          const settings = await chrome.storage.local.get(['sheetUrl']);
          const sheetUrl = settings.sheetUrl || '';
          let pushResult = null;
          if (sheetUrl) {
            pushResult = await pushOrdersToSheet(sheetUrl, allOrders);
            if (pushResult) {
              await chrome.storage.local.set({ queueMode: true });
              notifyPopup(); // tell popup to refresh global progress
            }
          }

          sendResponse({
            success: true,
            count: allOrders.length,
            total: allOrders.length,
            pushed: pushResult ? pushResult.added : 0,
            duplicate: pushResult ? (pushResult.duplicate || 0) : 0,
          });
        } catch (err) {
          log('Loi collectOrders: ' + err.message, 'error');
          try { sendResponse({ success: false, error: err.message }); } catch (e) { /* popup closed */ }
        }
      })();

      return true; // async response
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
