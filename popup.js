let comments = [];
let commentImageUrls = [];
let currentIndex = 0;
let isSendingComment = false;
let runState = null;
const selectedClipboardIds = new Set();
const STORAGE_KEY_CLIPBOARD = 'commentClipboardItems';
const STORAGE_KEY_TARGET_POST = 'targetPostUrl';
const UPLOAD_TIMEOUT_MS = 9000;
const MAX_UPLOAD_DIMENSION = 1600;
const JPEG_QUALITY = 0.82;

const UPLOAD_PROVIDERS = [
  {
    name: 'Catbox',
    mode: 'catbox',
    url: 'https://catbox.moe/user/api.php'
  },
  {
    name: '0x0',
    mode: 'simple',
    url: 'https://0x0.st'
  },
  {
    name: 'TmpFiles',
    mode: 'tmpfiles',
    url: 'https://tmpfiles.org/api/v1/upload'
  },
  {
    name: 'Transfer.sh',
    mode: 'transfer',
    url: 'https://transfer.sh'
  }
];

function setUploadStatus(message, isError = false) {
  const statusEl = document.getElementById('uploadStatus');
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.style.color = isError ? '#b42318' : '#8b4a70';
}

function setApiStatus(message, isError = false) {
  const statusEl = document.getElementById('apiStatus');
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.style.color = isError ? '#b42318' : '#7c305c';
}

function getDomainLabel(url) {
  if (!url) return 'Không xác định';
  return /facebook\.com/i.test(url) ? 'Facebook' : 'Không phải Facebook';
}

function sendMessageToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message || 'sendMessage failed'));
        return;
      }

      resolve(response);
    });
  });
}

function injectContentScript(tabId) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript(
      {
        target: { tabId },
        files: ['content.js']
      },
      () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message || 'inject failed'));
          return;
        }

        resolve();
      }
    );
  });
}

async function checkActivePageReady() {
  const getApiBtn = document.getElementById('getApiBtn');
  if (getApiBtn) {
    getApiBtn.disabled = true;
  }

  setApiStatus('Đang kiểm tra tab hiện tại...');

  chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
    const tab = tabs[0];
    if (!tab || !tab.id) {
      setApiStatus('Không tìm thấy tab đang mở.', true);
      if (getApiBtn) getApiBtn.disabled = false;
      return;
    }

    const tabUrl = tab.url || '';
    const domainLabel = getDomainLabel(tabUrl);

    if (!/facebook\.com/i.test(tabUrl)) {
      setApiStatus(
        `Trang: ${tabUrl || 'Không rõ URL'}\n` +
        `Domain: ${domainLabel}\n` +
        'Kết quả: Chưa sẵn sàng. Hãy mở trang Facebook để comment.',
        true
      );
      if (getApiBtn) getApiBtn.disabled = false;
      return;
    }

    let response = null;

    try {
      response = await sendMessageToTab(tab.id, { action: 'pingStatus' });
    } catch {
      try {
        setApiStatus('Đang khởi tạo content script cho tab này...');
        await injectContentScript(tab.id);
        response = await sendMessageToTab(tab.id, { action: 'pingStatus' });
      } catch {
        setApiStatus(
          `Trang: ${tabUrl}\n` +
          `Domain: ${domainLabel}\n` +
          'Kết quả: Chưa nhận diện được content script. Thử tải lại trang Facebook hoặc mở lại tab rồi bấm Kiểm tra.',
          true
        );
        if (getApiBtn) getApiBtn.disabled = false;
        return;
      }
    }

    if (!response || response.status !== 'ready') {
      setApiStatus(
        `Trang: ${tabUrl}\n` +
        `Domain: ${domainLabel}\n` +
        'Kết quả: Content script chưa sẵn sàng.',
        true
      );
      if (getApiBtn) getApiBtn.disabled = false;
      return;
    }

    const hasDetectedPosts = (response.loadedPostCount || response.containerCount || 0) > 0;
    const hasUsableComposer = (response.availableCount || 0) > 0;
    const hasOnlyExternalComposer = !hasDetectedPosts && Boolean(response.externalComposerAvailable);
    const readiness = hasOnlyExternalComposer
      ? 'Có ô comment nhưng chưa ghép được vào post. Hãy cuộn thêm để tải bài hoặc mở post dạng feed.'
      : (hasUsableComposer || Boolean(response.externalComposerAvailable)
        ? 'Sẵn sàng comment'
        : 'Đã nhận diện trang, nhưng chưa thấy ô comment khả dụng');
    const diagnostics = [
      `Trang: ${response.pageUrl || tabUrl}`,
      `Domain: ${domainLabel}`,
      `Content script: OK`,
      `Phiên bản script: ${response.contentScriptVersion || 'unknown'}`,
      `Số post đã tải trong DOM: ${response.loadedPostCount || response.containerCount || 0}`,
      `Số ô comment tìm thấy trong post: ${response.commentBoxCount}`,
      `Số ô có thể dùng ngay trong post: ${response.availableCount || 0}`,
      `Có ô comment đang mở ngoài post: ${response.externalComposerAvailable ? 'Có' : 'Không'}`,
      `Số ô đang bị Bỏ qua thông minh chặn: ${response.historyBlockedCount || 0}`
    ];

    if ((response.noComposerCount || 0) > 0) {
      diagnostics.push(`Số post không tìm/mở được hộp comment ngay trong post: ${response.noComposerCount}`);
    }

    diagnostics.push(`Số container bài viết: ${response.containerCount}`);
    diagnostics.push(`Kết quả: ${readiness}`);

    setApiStatus(diagnostics.join('\n'));

    if (getApiBtn) getApiBtn.disabled = false;
  });
}

function appendImageUrls(urls) {
  const imagesInput = document.getElementById('images');
  const existing = imagesInput.value.trim();
  const incoming = urls.join(', ');

  if (!existing) {
    imagesInput.value = incoming;
  } else {
    imagesInput.value = `${existing}, ${incoming}`;
  }

  // Save form data after appending images
  saveFormData();
}

function getTargetPostUrl() {
  const input = document.getElementById('targetPostUrl');
  return (input?.value || '').trim();
}

function normalizeTargetPostUrl(url) {
  const raw = (url || '').trim();
  if (!raw) return '';

  const withScheme = /^(https?:)?\/\//i.test(raw)
    ? raw.replace(/^\/\//, 'https://')
    : (/^(?:m\.|www\.|mbasic\.)?facebook\.com\//i.test(raw) ? `https://${raw}` : raw);

  return withScheme
    .replace(/[?#].*$/, '')
    .replace(/\/$/, '');
}

function extractFacebookPostKeyFromUrl(url) {
  const raw = (url || '').trim();
  if (!raw) return '';

  const decoded = (() => {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  })();

  const shareMatch = decoded.match(/\/share\/p\/([A-Za-z0-9_-]{6,})/i);
  if (shareMatch) {
    return `share:${shareMatch[1]}`;
  }

  const match = decoded.match(/(?:story_fbid|fbid|posts(?:\/)?)=(\d{5,})|\/posts\/(\d{5,})|\/permalink\/(\d{5,})|story_fbid=(\d{5,})|fbid=(\d{5,})/i);
  if (!match) return '';
  return match[1] || match[2] || match[3] || match[4] || match[5] || '';
}

function urlsLikelySameTarget(expectedUrl, actualUrl) {
  const expected = normalizeTargetPostUrl(expectedUrl);
  const actual = normalizeTargetPostUrl(actualUrl);
  if (!expected || !actual) return false;

  const expectedKey = extractFacebookPostKeyFromUrl(expectedUrl);
  const actualKey = extractFacebookPostKeyFromUrl(actualUrl);
  if (expectedKey && actualKey) {
    return expectedKey === actualKey;
  }

  if (actual === expected) return true;
  if (actual.includes(expected) || expected.includes(actual)) return true;

  return false;
}

function isFacebookAccessibleUrl(url) {
  return /^https?:\/\/(?:m\.|www\.|mbasic\.)?facebook\.com\//i.test((url || '').trim());
}

function getClipboardCount() {
  const countInput = document.getElementById('clipboardCommentsPerPost');
  const value = Number.parseInt(countInput?.value, 10);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function createRunState({ targetPosts, commentsPerPost, commentSet, targetPostUrl }) {
  return {
    active: true,
    targetPosts,
    commentsPerPost,
    commentSet,
    targetPostUrl: targetPostUrl || '',
    targetTabId: null,
    useBackgroundTab: Boolean(targetPostUrl),
    postIndex: 0,
    commentIndexInPost: 0,
    lockPostFingerprint: '',
    lockPostSessionKey: ''
  };
}

function getCurrentRunComment() {
  if (!runState || !runState.commentSet?.length) return '';
  const idx = Math.max(0, Math.min(runState.commentIndexInPost, runState.commentSet.length - 1));
  return runState.commentSet[idx] || '';
}

function shouldStayOnCurrentPost() {
  if (!runState) return false;
  return runState.commentIndexInPost < (runState.commentsPerPost - 1);
}

function updateRunProgressStatus(extra = '') {
  if (!runState) return;
  const status = document.getElementById('status');
  if (!status) return;

  const currentPost = runState.postIndex + 1;
  const currentCmt = runState.commentIndexInPost + 1;
  status.textContent = `Đang chạy post ${currentPost}/${runState.targetPosts}, comment ${currentCmt}/${runState.commentsPerPost}${extra ? ` ${extra}` : ''}`;
}

function finishRun(finalMessage) {
  const closingTabId = runState?.useBackgroundTab ? runState?.targetTabId : null;
  runState = null;

  if (closingTabId) {
    chrome.tabs.remove(closingTabId, () => {});
  }

  const nextBtn = document.getElementById('nextBtn');
  if (nextBtn) nextBtn.disabled = true;
  const status = document.getElementById('status');
  if (status) status.textContent = finalMessage;
}

function getClipboardInput() {
  return document.getElementById('clipboardInput');
}

function updateSelectedClipboardCount() {
  const counter = document.getElementById('selectedClipboardCount');
  if (!counter) return;
  counter.textContent = `Đã chọn: ${selectedClipboardIds.size}`;
}

async function getClipboardItems() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY_CLIPBOARD], (result) => {
      const items = Array.isArray(result[STORAGE_KEY_CLIPBOARD]) ? result[STORAGE_KEY_CLIPBOARD] : [];
      resolve(items);
    });
  });
}

async function saveClipboardItems(items) {
  const normalized = Array.isArray(items) ? items.slice(0, 200) : [];
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY_CLIPBOARD]: normalized }, () => resolve());
  });
}

function generateClipboardId(text) {
  const value = `${text || ''}`;
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) - hash) + value.charCodeAt(i);
    hash |= 0;
  }
  return `${Date.now()}-${Math.abs(hash)}`;
}

function buildCommentFromCurrentForm(index = 0) {
  const desc = document.getElementById('description').value.trim();
  const feesInput = document.getElementById('fees').value.trim();
  const price = document.getElementById('price').value.trim();
  const amenities = document.getElementById('amenities').value.trim();
  const images = document.getElementById('images').value.trim();
  const contactPhone = document.getElementById('contactPhone').value.trim();

  const [serviceFeeRaw = '', parkingFeeRaw = '', electricityFeeRaw = ''] = feesInput.split(',').map((part) => part.trim());

  const parts = [desc];
  if (serviceFeeRaw) parts.push(`Tiền dịch vụ: ${serviceFeeRaw}`);
  if (parkingFeeRaw) parts.push(`Tiền xe: ${parkingFeeRaw}`);
  if (electricityFeeRaw) parts.push(`Tiền điện: ${electricityFeeRaw}`);
  if (price) parts.push(`Giá: ${price}`);
  if (amenities) parts.push(`Tiện nghi: ${amenities}`);
  if (images) parts.push(`Hình ảnh: ${images}`);
  if (contactPhone) parts.push(`Liên hệ: ${contactPhone}`);

  return parts.filter(Boolean).join(' - ').trim();
}

function fillFormFromClipboardText(text) {
  const clipboardInput = getClipboardInput();
  if (clipboardInput) clipboardInput.value = text;

  const description = document.getElementById('description');
  const fees = document.getElementById('fees');
  const price = document.getElementById('price');
  const amenities = document.getElementById('amenities');
  const images = document.getElementById('images');
  const contactPhone = document.getElementById('contactPhone');
  const numPosts = document.getElementById('numPosts');

  if (description) description.value = text;
  if (fees) fees.value = '';
  if (price) price.value = '';
  if (amenities) amenities.value = '';
  if (images) images.value = '';
  if (contactPhone) contactPhone.value = '';
  if (numPosts) numPosts.value = '1';

  saveFormData();
}

async function renderClipboardList() {
  const listEl = document.getElementById('clipboardList');
  if (!listEl) return;

  const items = await getClipboardItems();
  listEl.innerHTML = '';

  if (!items.length) {
    selectedClipboardIds.clear();
    updateSelectedClipboardCount();

    const emptyEl = document.createElement('div');
    emptyEl.className = 'clipboard-empty';
    emptyEl.textContent = 'Chưa có comment nào được lưu.';
    listEl.appendChild(emptyEl);
    return;
  }

  for (const selectedId of Array.from(selectedClipboardIds)) {
    if (!items.some((item) => item.id === selectedId)) {
      selectedClipboardIds.delete(selectedId);
    }
  }

  for (const item of items) {
    const itemEl = document.createElement('div');
    itemEl.className = 'clipboard-item';

    const topEl = document.createElement('div');
    topEl.className = 'clipboard-item-top';

    const selector = document.createElement('input');
    selector.type = 'checkbox';
    selector.checked = selectedClipboardIds.has(item.id);
    selector.addEventListener('change', () => {
      if (selector.checked) {
        selectedClipboardIds.add(item.id);
      } else {
        selectedClipboardIds.delete(item.id);
      }
      updateSelectedClipboardCount();
    });

    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = 'Chọn comment này';

    topEl.appendChild(selector);
    topEl.appendChild(label);

    const textEl = document.createElement('div');
    textEl.className = 'clipboard-item-text';
    textEl.textContent = item.text;

    const actionsEl = document.createElement('div');
    actionsEl.className = 'clipboard-item-actions';

    const useBtn = document.createElement('button');
    useBtn.type = 'button';
    useBtn.textContent = 'Dùng';
    useBtn.addEventListener('click', () => {
      fillFormFromClipboardText(item.text);
      const status = document.getElementById('status');
      if (status) status.textContent = 'Đã nạp comment đã lưu vào ô Mô tả.';
    });

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(item.text);
        const status = document.getElementById('status');
        if (status) status.textContent = 'Đã copy comment đã lưu.';
      } catch {
        const status = document.getElementById('status');
        if (status) status.textContent = 'Không copy được, bạn có thể chọn và copy thủ công.';
      }
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.textContent = 'Xóa';
    deleteBtn.addEventListener('click', async () => {
      selectedClipboardIds.delete(item.id);
      const nextItems = items.filter((entry) => entry.id !== item.id);
      await saveClipboardItems(nextItems);
      await renderClipboardList();
    });

    actionsEl.appendChild(useBtn);
    actionsEl.appendChild(copyBtn);
    actionsEl.appendChild(deleteBtn);

    itemEl.appendChild(topEl);
    itemEl.appendChild(textEl);
    itemEl.appendChild(actionsEl);
    listEl.appendChild(itemEl);
  }

  updateSelectedClipboardCount();
}

async function addClipboardItem(text) {
  const normalized = (text || '').trim();
  if (!normalized) return false;

  const items = await getClipboardItems();
  const exists = items.some((item) => item.text === normalized);
  if (exists) return true;

  items.unshift({
    id: generateClipboardId(normalized),
    text: normalized,
    createdAt: new Date().toISOString()
  });

  await saveClipboardItems(items);
  await renderClipboardList();
  return true;
}

async function buildCommentsFromClipboard(limit) {
  const items = await getClipboardItems();
  const usable = items
    .map((item) => (item?.text || '').trim())
    .filter(Boolean);

  const selected = items
    .filter((item) => selectedClipboardIds.has(item.id))
    .map((item) => (item?.text || '').trim())
    .filter(Boolean);

  const source = selected.length ? selected : usable;

  if (!source.length) {
    return [];
  }

  if (limit > 0) {
    return source.slice(0, limit);
  }

  return source;
}

function waitForTabUpdated(tabId, expectedUrl, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let done = false;

    const cleanup = () => {
      chrome.tabs.onUpdated.removeListener(listener);
      clearInterval(timerId);
    };

    const resolveIfReady = (tab) => {
      if (!tab || done) return false;

      const sameTarget = expectedUrl && tab.url ? urlsLikelySameTarget(expectedUrl, tab.url) : false;
      const facebookLoaded = isFacebookAccessibleUrl(tab.url || '');
      const isReady = tab.status === 'complete' && (sameTarget || facebookLoaded);

      if (!isReady) return false;

      done = true;
      cleanup();
      resolve(tab);
      return true;
    };

    const listener = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === 'complete') {
        resolveIfReady(tab);
      }
    };

    const timerId = setInterval(() => {
      if (done) {
        cleanup();
        return;
      }

      chrome.tabs.get(tabId, (tab) => {
        if (!done && !chrome.runtime.lastError) {
          resolveIfReady(tab);
        }
      });

      if (Date.now() - startedAt > timeoutMs) {
        done = true;
        cleanup();
        reject(new Error('Navigation timeout (khong vao duoc trang Facebook hop le)'));
      }
    }, 250);

    chrome.tabs.onUpdated.addListener(listener);

    // Check immediately to avoid missing a fast redirect/load that completed before listener registration.
    chrome.tabs.get(tabId, (tab) => {
      if (!done && !chrome.runtime.lastError) {
        resolveIfReady(tab);
      }
    });
  });
}

function waitForFacebookTabAccessible(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();

    const check = () => {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab) {
          reject(new Error('Không lấy được trạng thái tab mục tiêu.'));
          return;
        }

        const isReady = tab.status === 'complete' && isFacebookAccessibleUrl(tab.url || '');
        if (isReady) {
          resolve(tab);
          return;
        }

        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error('Tab mục tiêu chưa vào được trang Facebook hợp lệ (timeout).'));
          return;
        }

        setTimeout(check, 300);
      });
    };

    check();
  });
}

async function navigateToTargetPost(tabId, targetUrl) {
  const normalized = normalizeTargetPostUrl(targetUrl);
  if (!normalized) return;

  const currentTab = await new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => resolve(tab || null));
  });

  if (currentTab?.url && urlsLikelySameTarget(normalized, currentTab.url)) {
    return;
  }

  await new Promise((resolve, reject) => {
    chrome.tabs.update(tabId, { url: normalized }, (updatedTab) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message || 'Không mở được URL bài viết'));
        return;
      }

      resolve(updatedTab);
    });
  });

  await waitForTabUpdated(tabId, normalized);
}

function createBackgroundTargetTab(targetUrl) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url: targetUrl, active: false }, (tab) => {
      if (chrome.runtime.lastError || !tab?.id) {
        reject(new Error(chrome.runtime.lastError?.message || 'Không tạo được tab nền cho URL mục tiêu'));
        return;
      }
      resolve(tab.id);
    });
  });
}

function getActiveTabId() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs[0]?.id || null);
    });
  });
}

async function ensureContentScriptReady(tabId) {
  try {
    await sendMessageToTab(tabId, { action: 'pingStatus' });
    return true;
  } catch {
    await injectContentScript(tabId);
    await sendMessageToTab(tabId, { action: 'pingStatus' });
    return true;
  }
}

async function resolveRunTabId() {
  if (runState?.useBackgroundTab) {
    if (runState.targetTabId) {
      try {
        await new Promise((resolve, reject) => {
          chrome.tabs.get(runState.targetTabId, (tab) => {
            if (chrome.runtime.lastError || !tab?.id) {
              reject(new Error('Target tab not found'));
              return;
            }
            resolve(tab);
          });
        });
      } catch {
        runState.targetTabId = null;
      }
    }

    if (!runState.targetTabId) {
      const targetUrl = normalizeTargetPostUrl(runState.targetPostUrl);
      if (!targetUrl) {
        throw new Error('Thiếu URL bài viết mục tiêu');
      }

      if (!isFacebookAccessibleUrl(targetUrl)) {
        throw new Error('URL mục tiêu phải là link Facebook đầy đủ (https://...facebook.com/...).');
      }

      runState.targetTabId = await createBackgroundTargetTab(targetUrl);
      await waitForTabUpdated(runState.targetTabId, targetUrl);
      await waitForFacebookTabAccessible(runState.targetTabId);
      await ensureContentScriptReady(runState.targetTabId);
    }

    return runState.targetTabId;
  }

  const activeTabId = await getActiveTabId();
  if (!activeTabId) {
    throw new Error('Không tìm thấy tab Facebook đang mở.');
  }

  return activeTabId;
}

async function initializeClipboardMenu() {
  const clipboardInput = getClipboardInput();
  const saveBtn = document.getElementById('saveClipboardBtn');
  const useBtn = document.getElementById('useClipboardBtn');
  const clearBtn = document.getElementById('clearClipboardInputBtn');
  const clearSelectedBtn = document.getElementById('clearSelectedClipboardBtn');

  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      const text = (clipboardInput?.value || '').trim() || buildCommentFromCurrentForm(currentIndex);
      if (!text) {
        setUploadStatus('Không có comment nào để lưu.', true);
        return;
      }

      await addClipboardItem(text);
      if (clipboardInput) clipboardInput.value = text;
      setUploadStatus('Đã lưu comment vào clipboard.');
    });
  }

  if (useBtn) {
    useBtn.addEventListener('click', async () => {
      const text = (clipboardInput?.value || '').trim();
      if (!text) {
        setUploadStatus('Hãy nhập comment hoàn chỉnh vào ô clipboard trước.', true);
        return;
      }

      await addClipboardItem(text);
      fillFormFromClipboardText(text);
      setUploadStatus('Đã nạp comment clipboard vào form.');
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      if (clipboardInput) clipboardInput.value = '';
      setUploadStatus('Đã xóa ô nhập clipboard.');
    });
  }

  if (clearSelectedBtn) {
    clearSelectedBtn.addEventListener('click', async () => {
      selectedClipboardIds.clear();
      updateSelectedClipboardCount();
      await renderClipboardList();
      setUploadStatus('Đã bỏ chọn tất cả comment trong clipboard.');
    });
  }

  if (clipboardInput) {
    clipboardInput.addEventListener('change', saveFormData);
    clipboardInput.addEventListener('input', saveFormData);
  }

  await renderClipboardList();
  updateSelectedClipboardCount();
}

function parseImageUrls(raw) {
  if (!raw) return [];

  const parts = raw
    .split(/[\s,\n]+/)
    .map((part) => part.trim())
    .filter((part) => /^https?:\/\//i.test(part));

  return Array.from(new Set(parts));
}

async function uploadViaFetch(url, options) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  const response = await fetch(url, {
    ...options,
    signal: controller.signal
  });
  clearTimeout(timeoutId);
  const resultText = (await response.text()).trim();

  if (!response.ok) {
    throw new Error(resultText || `HTTP ${response.status}`);
  }

  return resultText;
}

function normalizeUploadedUrl(mode, rawText) {
  if (!rawText) {
    throw new Error('Phản hồi rỗng');
  }

  if (mode === 'tmpfiles') {
    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      throw new Error('TmpFiles trả về dữ liệu không hợp lệ');
    }

    const pageUrl = data?.data?.url;
    if (!pageUrl || !pageUrl.startsWith('http')) {
      throw new Error('TmpFiles không trả về link');
    }

    // Convert page link to direct download link.
    return pageUrl.replace('tmpfiles.org/', 'tmpfiles.org/dl/');
  }

  if (!rawText.startsWith('http')) {
    throw new Error(rawText);
  }

  return rawText;
}

function buildUploadRequest(file, provider) {
  if (provider.mode === 'transfer') {
    const safeName = (file.name || `image-${Date.now()}.png`).replace(/[^a-zA-Z0-9._-]/g, '_');
    return {
      url: `${provider.url}/${safeName}`,
      options: {
        method: 'PUT',
        body: file
      }
    };
  }

  const formData = new FormData();

  if (provider.mode === 'catbox') {
    formData.append('reqtype', 'fileupload');
    formData.append('fileToUpload', file, file.name || `image-${Date.now()}.png`);
  } else if (provider.mode === 'simple') {
    formData.append('file', file, file.name || `image-${Date.now()}.png`);
  } else if (provider.mode === 'tmpfiles') {
    formData.append('file', file, file.name || `image-${Date.now()}.png`);
  }

  return {
    url: provider.url,
    options: {
      method: 'POST',
      body: formData
    }
  };
}

async function uploadViaXhr(url, formData) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.timeout = UPLOAD_TIMEOUT_MS;

    xhr.onload = () => {
      const resultText = (xhr.responseText || '').trim();
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(resultText);
        return;
      }

      reject(new Error(resultText || `HTTP ${xhr.status}`));
    };

    xhr.onerror = () => {
      reject(new Error('Lỗi mạng/XHR'));
    };

    xhr.ontimeout = () => {
      reject(new Error('Hết thời gian chờ'));
    };

    xhr.send(formData);
  });
}

async function uploadImageWithProvider(file, provider) {
  const request = buildUploadRequest(file, provider);

  try {
    const rawText = await uploadViaFetch(request.url, request.options);
    return normalizeUploadedUrl(provider.mode, rawText);
  } catch (fetchError) {
    if (provider.mode !== 'catbox') {
      throw fetchError;
    }

    // Catbox sometimes fails in fetch mode on some networks; retry with XHR.
    const retryFormData = new FormData();
    retryFormData.append('reqtype', 'fileupload');
    retryFormData.append('fileToUpload', file, file.name || `image-${Date.now()}.png`);
    const rawText = await uploadViaXhr(provider.url, retryFormData);
    return normalizeUploadedUrl(provider.mode, rawText);
  }
}

async function uploadImageToHosts(file) {
  const errors = [];

  for (const provider of UPLOAD_PROVIDERS) {
    try {
      return await uploadImageWithProvider(file, provider);
    } catch (error) {
      errors.push(`${provider.name}: ${error.message}`);
    }
  }

  throw new Error(errors.join(' | '));
}

function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const objectUrl = URL.createObjectURL(file);

    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(image);
    };

    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Không đọc được ảnh'));
    };

    image.src = objectUrl;
  });
}

async function compressImageIfNeeded(file) {
  if (!file.type.startsWith('image/')) {
    return file;
  }

  if (file.size <= 1024 * 1024) {
    return file;
  }

  try {
    const image = await loadImageFromFile(file);
    const ratio = Math.min(1, MAX_UPLOAD_DIMENSION / Math.max(image.width, image.height));
    const targetWidth = Math.max(1, Math.round(image.width * ratio));
    const targetHeight = Math.max(1, Math.round(image.height * ratio));

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;

    const context = canvas.getContext('2d');
    if (!context) {
      return file;
    }

    context.drawImage(image, 0, 0, targetWidth, targetHeight);

    const blob = await new Promise((resolve) => {
      canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY);
    });

    if (!blob || blob.size >= file.size) {
      return file;
    }

    return new File([blob], `${(file.name || 'image').replace(/\.[^.]+$/, '')}.jpg`, { type: 'image/jpeg' });
  } catch {
    return file;
  }
}

async function uploadFileJob(file, index, total) {
  setUploadStatus(`Đang xử lý ảnh ${index + 1}/${total}...`);
  const optimized = await compressImageIfNeeded(file);
  setUploadStatus(`Đang upload ảnh ${index + 1}/${total}...`);
  return uploadImageToHosts(optimized);
}

async function uploadFilesAndAppendUrls(files) {
  if (!files.length) return;

  try {
    setUploadStatus(`Đang upload ${files.length} ảnh...`);
    const jobs = files.map((file, index) => uploadFileJob(file, index, files.length));
    const urls = await Promise.all(jobs);

    appendImageUrls(urls);
    setUploadStatus(`Upload xong ${urls.length} ảnh.`);
  } catch (error) {
    setUploadStatus(`Lỗi upload: ${error.message}`, true);
  }
}

function extractImagesFromClipboard(event) {
  const items = Array.from(event.clipboardData?.items || []);
  return items
    .filter((item) => item.type && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter((file) => file && file.size > 0);
}

async function handleClipboardImagePaste(event) {
  const imageFiles = extractImagesFromClipboard(event);
  if (!imageFiles.length) {
    return false;
  }

  event.preventDefault();
  await uploadFilesAndAppendUrls(imageFiles);
  return true;
}

function initializeImageUpload() {
  const pickBtn = document.getElementById('pickImagesBtn');
  const fileInput = document.getElementById('imageFileInput');
  const pasteArea = document.getElementById('pasteArea');
  const imagesInput = document.getElementById('images');

  if (!pickBtn || !fileInput || !pasteArea || !imagesInput) return;

  pickBtn.addEventListener('click', () => {
    fileInput.click();
  });

  fileInput.addEventListener('change', async (event) => {
    const selectedFiles = Array.from(event.target.files || []);
    await uploadFilesAndAppendUrls(selectedFiles);
    fileInput.value = '';
  });

  pasteArea.addEventListener('focus', () => {
    pasteArea.classList.add('active');
  });

  pasteArea.addEventListener('blur', () => {
    pasteArea.classList.remove('active');
  });

  pasteArea.addEventListener('paste', async (event) => {
    const handled = await handleClipboardImagePaste(event);
    if (!handled) {
      setUploadStatus('Clipboard không có ảnh. Hãy copy ảnh rồi Ctrl+V lại.', true);
    }
  });

  imagesInput.addEventListener('paste', async (event) => {
    const handled = await handleClipboardImagePaste(event);
    if (handled) {
      setUploadStatus('Đã nhận ảnh từ clipboard và chèn link vào ô Hình ảnh.');
    }
  });
}

function initializeApiCheckMenu() {
  const getApiBtn = document.getElementById('getApiBtn');
  if (!getApiBtn) return;

  getApiBtn.addEventListener('click', () => {
    checkActivePageReady();
  });

  checkActivePageReady();
}

function initializeTabs() {
  const tabButtons = Array.from(document.querySelectorAll('.tab[data-tab]'));

  tabButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const selectedTab = button.getAttribute('data-tab');
      if (!selectedTab) return;

      tabButtons.forEach((tab) => tab.classList.remove('active'));
      button.classList.add('active');

      const tabContents = Array.from(document.querySelectorAll('.tab-content'));
      tabContents.forEach((content) => content.classList.remove('active'));

      const selectedContent = document.getElementById(`${selectedTab}Tab`);
      if (selectedContent) {
        selectedContent.classList.add('active');
      }

      if (selectedTab === 'getapi') {
        checkActivePageReady();
      }
    });
  });
}

function initializeSmartSkipMenu() {
  const resetBtn = document.getElementById('resetSkipBtn');
  const skipStatus = document.getElementById('skipStatus');
  if (!resetBtn || !skipStatus) return;

  resetBtn.addEventListener('click', () => {
    skipStatus.textContent = 'Đang đặt lại lịch sử Bỏ qua thông minh...';

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab?.id) {
        skipStatus.textContent = 'Không tìm thấy tab hiện tại.';
        return;
      }

      chrome.tabs.sendMessage(tab.id, { action: 'resetProcessedHistory' }, (response) => {
        if (chrome.runtime.lastError) {
          skipStatus.textContent = 'Không đặt lại được. Thử mở tab Facebook và bấm lại.';
          return;
        }

        if (response?.status === 'ResetDone') {
          skipStatus.textContent = 'Đã đặt lại lịch sử Bỏ qua thông minh trong tab này.';
          checkActivePageReady();
          return;
        }

        skipStatus.textContent = 'Đặt lại không thành công.';
      });
    });
  });
}

function sendCurrentComment(ignoreHistory = false, hasRetriedIgnoreHistory = false) {
  if (isSendingComment) {
    return;
  }

  isSendingComment = true;
  const startBtn = document.getElementById('startBtn');
  const nextBtn = document.getElementById('nextBtn');
  if (startBtn) startBtn.disabled = true;
  if (nextBtn) nextBtn.disabled = true;

  (async () => {
    let tabId = null;

    try {
      tabId = await resolveRunTabId();
    } catch (error) {
      document.getElementById('status').textContent = `Không xác định được tab chạy: ${error.message}`;
      isSendingComment = false;
      if (startBtn) startBtn.disabled = false;
      if (nextBtn && comments.length > 0) nextBtn.disabled = false;
      return;
    }

    chrome.tabs.sendMessage(
      tabId,
      {
        action: 'fillNext',
        comment: runState ? getCurrentRunComment() : comments[currentIndex],
        imageUrls: commentImageUrls,
        targetPostUrl: runState?.targetPostUrl || getTargetPostUrl(),
        lockPostFingerprint: runState?.lockPostFingerprint || '',
        lockPostSessionKey: runState?.lockPostSessionKey || '',
        keepOnCurrentPost: runState ? shouldStayOnCurrentPost() : false,
        markProcessed: runState ? !shouldStayOnCurrentPost() : true,
        scrollAfterSubmit: runState ? !shouldStayOnCurrentPost() : true,
        ignoreHistory
      },
      (response) => {
        isSendingComment = false;
        if (startBtn) startBtn.disabled = false;

        if (chrome.runtime.lastError) {
          document.getElementById('status').textContent = 'Không thể kết nối với trang Facebook. Hãy reload trang và thử lại.';
          if (nextBtn) nextBtn.disabled = comments.length <= 1;
          return;
        }

        if (!response) {
          document.getElementById('status').textContent = 'Không nhận được phản hồi từ tab Facebook.';
          if (nextBtn) nextBtn.disabled = true;
          return;
        }

        if (response.status === 'HistoryBlocked') {
          if (!hasRetriedIgnoreHistory) {
            document.getElementById('status').textContent = 'Bỏ qua thông minh đang chặn hết bài hiện tại, thử điền lại bỏ qua lịch sử...';
            sendCurrentComment(true, true);
            return;
          }

          if (runState?.active) {
            finishRun('Dừng batch: lịch sử bỏ qua đang chặn hết bài hiện tại.');
            return;
          }

          document.getElementById('status').textContent = 'Các bài hiện tại đã nằm trong lịch sử bỏ qua. Hãy vào tab BỎ QUA THÔNG MINH để đặt lại.';
          if (nextBtn) nextBtn.disabled = true;
          return;
        }

        if (response.status === 'No more posts') {
          if (runState?.active) {
            finishRun('Dừng batch: không còn post phù hợp để điền comment.');
            return;
          }

          if ((response.totalCandidates || 0) === 0) {
            document.getElementById('status').textContent = 'Chưa thấy ô comment phù hợp trong vùng đang hiển thị. Hãy cuộn feed và mở ô bình luận rồi thử lại.';
          } else if (response.noComposerInViewport) {
            document.getElementById('status').textContent = `Đã thấy ${response.totalCandidates} post nhưng chưa có ô Bình luận dưới tên... khả dụng trong vùng hiện tại. Không tự cuộn thêm để tránh bỏ qua.`;
          } else if ((response.noComposerCount || 0) > 0) {
            document.getElementById('status').textContent = `Tìm thấy ${response.totalCandidates} post nhưng không mở được hộp comment (có thể là fanpage). Hãy cuộn và thử lại.`;
          } else {
            document.getElementById('status').textContent = 'Không còn post phù hợp để điền comment.';
          }
          if (nextBtn) nextBtn.disabled = true;
          return;
        }

        if (response.status === 'SubmitFailed') {
          if (runState?.active) {
            finishRun('Dừng batch: submit comment thất bại.');
            return;
          }

          document.getElementById('status').textContent = 'Đã điền vào ô comment nhưng chưa bấm gửi thành công. Không bỏ qua post này, bạn bấm lại để thử tiếp.';
          if (nextBtn) nextBtn.disabled = false;
          return;
        }

        if (response.status === 'InternalError') {
          if (runState?.active) {
            finishRun(`Dừng batch: lỗi xử lý (${response.message || 'unknown'}).`);
            return;
          }

          document.getElementById('status').textContent = `Lỗi xử lý: ${response.message || 'Không rõ nguyên nhân'}`;
          if (nextBtn) nextBtn.disabled = false;
          return;
        }

        if (response.status !== 'Filled') {
          if (runState?.active) {
            finishRun('Dừng batch: phản hồi không hợp lệ từ content script.');
            return;
          }

          document.getElementById('status').textContent = 'Không thể điền comment ở lần này.';
          if (nextBtn) nextBtn.disabled = true;
          return;
        }

        if (runState) {
          if (response.postFingerprint) {
            runState.lockPostFingerprint = response.postFingerprint;
          }
          if (response.postSessionKey) {
            runState.lockPostSessionKey = response.postSessionKey;
          }
        }

        const attached = Number(response.attachedImages || 0);
        const skipped = Number(response.skippedImages || 0);
        const reason = response.attachmentReason ? `, lý do: ${response.attachmentReason}` : '';
        if (attached > 0 || skipped > 0) {
          document.getElementById('status').textContent = `Điền comment ${currentIndex + 1}/${comments.length} (ảnh đính kèm: ${attached}, lỗi: ${skipped}${reason})`;
        } else {
          document.getElementById('status').textContent = `Điền comment ${currentIndex + 1}/${comments.length}`;
        }
        if (nextBtn) {
          nextBtn.disabled = runState?.active ? true : (currentIndex >= comments.length - 1);
        }

        if (runState?.active) {
          if (shouldStayOnCurrentPost()) {
            runState.commentIndexInPost += 1;
            updateRunProgressStatus();
          } else {
            runState.postIndex += 1;
            runState.commentIndexInPost = 0;
            runState.lockPostFingerprint = '';
            runState.lockPostSessionKey = '';
          }

          if (runState.postIndex >= runState.targetPosts) {
            finishRun(`Đã hoàn tất ${runState.targetPosts} post, mỗi post ${runState.commentsPerPost} comment.`);
            return;
          }

          setTimeout(() => sendCurrentComment(), 700);
        }
      }
    );
  })();
}

async function startRunWithConfig({ targetPosts, commentsPerPost, commentSet, targetPostUrl }) {
  if (!Array.isArray(commentSet) || !commentSet.length) {
    document.getElementById('status').textContent = 'Không có comment nào để chạy.';
    return;
  }

  comments = commentSet.slice();
  currentIndex = 0;
  runState = createRunState({
    targetPosts,
    commentsPerPost,
    commentSet: commentSet.slice(),
    targetPostUrl
  });

  const nextBtn = document.getElementById('nextBtn');
  if (nextBtn) nextBtn.disabled = true;
  updateRunProgressStatus();

  try {
    if (runState.useBackgroundTab) {
      const targetUrl = normalizeTargetPostUrl(targetPostUrl);

      if (!isFacebookAccessibleUrl(targetUrl)) {
        throw new Error('URL mục tiêu phải là link Facebook đầy đủ (https://...facebook.com/...).');
      }

      runState.targetTabId = await createBackgroundTargetTab(targetUrl);
      await waitForTabUpdated(runState.targetTabId, targetUrl);
      await waitForFacebookTabAccessible(runState.targetTabId);
      await ensureContentScriptReady(runState.targetTabId);
    }

    sendCurrentComment();
  } catch (error) {
    finishRun(`Dừng batch: ${error.message}`);
  }
}

async function startFormMenu() {
  if (runState?.active || isSendingComment) {
    document.getElementById('status').textContent = 'Đang có batch chạy, vui lòng đợi hoàn tất.';
    return;
  }

  const description = document.getElementById('description').value.trim();
  const feesInput = document.getElementById('fees').value.trim();
  const price = document.getElementById('price').value.trim();
  const amenities = document.getElementById('amenities').value.trim();
  const images = document.getElementById('images').value.trim();
  const contactPhone = document.getElementById('contactPhone').value.trim();
  const numPosts = Number.parseInt(document.getElementById('numPosts').value, 10);
  const targetPostUrl = getTargetPostUrl();

  if (!Number.isFinite(numPosts) || numPosts <= 0) {
    document.getElementById('status').textContent = 'Menu 1 cần nhập Số post.';
    return;
  }

  if (!description) {
    document.getElementById('status').textContent = 'Menu 1 cần nhập Mô tả.';
    return;
  }

  commentImageUrls = parseImageUrls(images);
  const [serviceFeeRaw = '', parkingFeeRaw = '', electricityFeeRaw = ''] = feesInput.split(',').map((part) => part.trim());
  const parts = [description];
  if (serviceFeeRaw) parts.push(`Tiền dịch vụ: ${serviceFeeRaw}`);
  if (parkingFeeRaw) parts.push(`Tiền xe: ${parkingFeeRaw}`);
  if (electricityFeeRaw) parts.push(`Tiền điện: ${electricityFeeRaw}`);
  if (price) parts.push(`Giá: ${price}`);
  if (amenities) parts.push(`Tiện nghi: ${amenities}`);
  if (contactPhone) parts.push(`Liên hệ: ${contactPhone}`);

  const singleComment = parts.join(' - ');
  await startRunWithConfig({
    targetPosts: numPosts,
    commentsPerPost: 1,
    commentSet: [singleComment],
    targetPostUrl
  });
}

async function startClipboardMenu() {
  if (runState?.active || isSendingComment) {
    document.getElementById('status').textContent = 'Đang có batch chạy, vui lòng đợi hoàn tất.';
    return;
  }

  const targetPostUrl = (document.getElementById('clipboardTargetPostUrl')?.value || '').trim();
  const numPosts = Number.parseInt(document.getElementById('clipboardNumPosts')?.value, 10);
  const commentsPerPost = getClipboardCount();

  if (!Number.isFinite(numPosts) || numPosts <= 0) {
    document.getElementById('status').textContent = 'Menu 2 cần nhập Số post.';
    return;
  }

  if (!Number.isFinite(commentsPerPost) || commentsPerPost <= 0) {
    document.getElementById('status').textContent = 'Menu 2 cần nhập Số cmt / post.';
    return;
  }

  const selectedComments = await buildCommentsFromClipboard(commentsPerPost);
  if (selectedComments.length < commentsPerPost) {
    document.getElementById('status').textContent = 'Số comment đã chọn trong clipboard không đủ.';
    return;
  }

  commentImageUrls = [];
  await startRunWithConfig({
    targetPosts: numPosts,
    commentsPerPost,
    commentSet: selectedComments.slice(0, commentsPerPost),
    targetPostUrl
  });
}

document.getElementById('startFormBtn')?.addEventListener('click', startFormMenu);
document.getElementById('startClipboardBtn')?.addEventListener('click', startClipboardMenu);

document.getElementById('saveFormToClipboardBtn')?.addEventListener('click', async () => {
  const generated = buildCommentFromCurrentForm(0);
  if (!generated) {
    setUploadStatus('Không có nội dung form để lưu.', true);
    return;
  }

  await addClipboardItem(generated);
  setUploadStatus('Đã lưu comment form vào clipboard.');
});

document.getElementById('nextBtn').addEventListener('click', () => {
  if (runState?.active) {
    document.getElementById('status').textContent = 'Đang chạy tự động theo batch. Vui lòng đợi hoàn tất.';
    return;
  }

  currentIndex++;
  if (currentIndex >= comments.length) {
    document.getElementById('status').textContent = 'Đã điền hết comment!';
    document.getElementById('nextBtn').disabled = true;
    return;
  }

  sendCurrentComment();
});

const STORAGE_KEY_FORM_DATA = 'formData';

function saveFormData() {
  const formData = {
    description: document.getElementById('description').value,
    fees: document.getElementById('fees').value,
    price: document.getElementById('price').value,
    amenities: document.getElementById('amenities').value,
    images: document.getElementById('images').value,
    contactPhone: document.getElementById('contactPhone').value,
    numPosts: document.getElementById('numPosts').value,
    targetPostUrl: document.getElementById('targetPostUrl').value,
    clipboardTargetPostUrl: document.getElementById('clipboardTargetPostUrl')?.value || '',
    clipboardNumPosts: document.getElementById('clipboardNumPosts')?.value || '',
    clipboardCommentsPerPost: document.getElementById('clipboardCommentsPerPost')?.value || ''
  };

  chrome.storage.local.set({ [STORAGE_KEY_FORM_DATA]: formData });
}

function loadFormData() {
  chrome.storage.local.get([STORAGE_KEY_FORM_DATA], (result) => {
    const formData = result[STORAGE_KEY_FORM_DATA];
    if (!formData) return;

    // Restore each field
    const fields = ['description', 'fees', 'price', 'amenities', 'images', 'contactPhone', 'numPosts', 'targetPostUrl', 'clipboardTargetPostUrl', 'clipboardNumPosts', 'clipboardCommentsPerPost'];
    for (const field of fields) {
      const el = document.getElementById(field);
      if (el && formData[field]) {
        el.value = formData[field];
      }
    }
  });
}

function initializeFormAutoSave() {
  const fields = ['description', 'fees', 'price', 'amenities', 'images', 'contactPhone', 'numPosts', 'targetPostUrl', 'clipboardTargetPostUrl', 'clipboardNumPosts', 'clipboardCommentsPerPost'];

  for (const field of fields) {
    const el = document.getElementById(field);
    if (el) {
      el.addEventListener('change', saveFormData);
      el.addEventListener('input', saveFormData);
    }
  }
}

function initializeCommentModeTabs() {
  const formTabBtn = document.getElementById('formModeTabBtn');
  const clipboardTabBtn = document.getElementById('clipboardModeTabBtn');
  const formPanel = document.getElementById('formModePanel');
  const clipboardPanel = document.getElementById('clipboardModePanel');

  const activate = (mode) => {
    const formActive = mode === 'form';
    formTabBtn?.classList.toggle('active', formActive);
    clipboardTabBtn?.classList.toggle('active', !formActive);
    formPanel?.classList.toggle('active', formActive);
    clipboardPanel?.classList.toggle('active', !formActive);
  };

  formTabBtn?.addEventListener('click', () => activate('form'));
  clipboardTabBtn?.addEventListener('click', () => activate('clipboard'));
}

loadFormData();
initializeFormAutoSave();
initializeImageUpload();
initializeApiCheckMenu();
initializeTabs();
initializeSmartSkipMenu();
initializeClipboardMenu();
initializeCommentModeTabs();
