let comments = [];
let commentImageUrls = [];
let currentIndex = 0;
let isSendingComment = false;
let runState = null;
const selectedClipboardIds = new Set();
const STORAGE_KEY_CLIPBOARD = 'commentClipboardItems';
const STORAGE_KEY_SELECTED_CLIPBOARD_IDS = 'selectedClipboardIds';
const STORAGE_KEY_TARGET_POST = 'targetPostUrl';
const UPLOAD_TIMEOUT_MS = 9000;
const MAX_UPLOAD_DIMENSION = 1600;
const JPEG_QUALITY = 0.82;
const MAX_CLIPBOARD_IMAGES_PER_ITEM = 6;
const MAX_CLIPBOARD_IMAGE_BYTES = 420 * 1024;

let pendingClipboardImages = [];
let editingClipboardItemId = null;
let clipboardSearchQuery = '';
let isAppInitialized = false;
let isExtensionUnlocked = false;

const STORAGE_KEY_AUTH_STATE = 'extensionAuthState';
const ACTIVATION_PASSWORD = 'Phuctrandev1@';

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

function setAuthStatus(message, isError = false) {
  const statusEl = document.getElementById('authStatus');
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.style.color = isError ? '#b42318' : '#7c305c';
}

function setAppVisibility(isLocked) {
  const gate = document.getElementById('authGate');
  const app = document.getElementById('appContent');

  if (gate) {
    gate.hidden = !isLocked;
    gate.style.display = isLocked ? 'flex' : 'none';
    gate.classList.toggle('is-hidden', !isLocked);
  }

  if (app) {
    app.hidden = isLocked;
    app.classList.toggle('is-hidden', isLocked);
  }
}

function getActivationPasswordInput() {
  return document.getElementById('activationPassword');
}

function saveAuthState(state) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY_AUTH_STATE]: state }, () => resolve());
  });
}

function loadAuthState() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY_AUTH_STATE], (result) => {
      resolve(result[STORAGE_KEY_AUTH_STATE] || null);
    });
  });
}

async function initializeExtensionLock() {
  const storedState = await loadAuthState();
  isExtensionUnlocked = Boolean(storedState?.unlocked);

  if (isExtensionUnlocked) {
    setAppVisibility(false);
    initializeApp();
    return;
  }

  setAppVisibility(true);
  setAuthStatus('Nhập mật khẩu để kích hoạt extension.', false);
}

async function activateExtension() {
  const passwordInput = getActivationPasswordInput();
  const password = (passwordInput?.value || '').trim();

  if (!password) {
    setAuthStatus('Vui lòng nhập mật khẩu trước khi kích hoạt.', true);
    return;
  }

  if (password !== ACTIVATION_PASSWORD) {
    setAuthStatus('Mật khẩu không đúng.', true);
    return;
  }

  await saveAuthState({
    unlocked: true,
    activatedAt: new Date().toISOString(),
    passwordConfirmed: true
  });

  isExtensionUnlocked = true;
  setAuthStatus('Đã kích hoạt. Extension sẽ tự mở ở những lần sau.');
  setAppVisibility(false);
  initializeApp();
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

function getCommentDelayMs() {
  const delayInput = document.getElementById('clipboardCommentDelay');
  const value = Number.parseFloat(delayInput?.value);
  const seconds = Number.isFinite(value) && value >= 1 ? value : 3;
  return seconds * 1000;
}

function createRunState({ targetPosts, commentsPerPost, commentPayloadSet, targetPostUrl }) {
  return {
    active: true,
    targetPosts,
    commentsPerPost,
    commentPayloadSet,
    targetPostUrl: targetPostUrl || '',
    targetTabId: null,
    useBackgroundTab: Boolean(targetPostUrl),
    postIndex: 0,
    commentIndexInPost: 0,
    lockPostFingerprint: '',
    lockPostSessionKey: '',
    lastCompletedPostFingerprint: '',
    lastCompletedPostSessionKey: '',
    stickToCurrentPost: false,
    mode: 'menu1'
  };
}

function getCurrentRunComment() {
  const payload = getCurrentRunPayload();
  return payload?.text || '';
}

function getCurrentRunPayload() {
  if (!runState || !runState.commentPayloadSet?.length) return null;
  const idx = Math.max(0, Math.min(runState.commentIndexInPost, runState.commentPayloadSet.length - 1));
  return runState.commentPayloadSet[idx] || null;
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
    chrome.tabs.remove(closingTabId, () => { });
  }

  const nextBtn = document.getElementById('nextBtn');
  if (nextBtn) nextBtn.disabled = true;

  const stopRunBtn = document.getElementById('stopRunBtn');
  if (stopRunBtn) stopRunBtn.classList.add('is-hidden');

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

async function saveSelectedClipboardIds() {
  return new Promise((resolve) => {
    chrome.storage.local.set({
      [STORAGE_KEY_SELECTED_CLIPBOARD_IDS]: Array.from(selectedClipboardIds)
    }, () => resolve());
  });
}

async function loadSelectedClipboardIds() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY_SELECTED_CLIPBOARD_IDS], (result) => {
      const stored = Array.isArray(result[STORAGE_KEY_SELECTED_CLIPBOARD_IDS])
        ? result[STORAGE_KEY_SELECTED_CLIPBOARD_IDS]
        : [];

      selectedClipboardIds.clear();
      for (const id of stored) {
        if (typeof id === 'string' && id.trim()) {
          selectedClipboardIds.add(id);
        }
      }

      updateSelectedClipboardCount();
      resolve();
    });
  });
}

function updateSelectedClipboardImageCount() {
  const counter = document.getElementById('selectedClipboardImageCount');
  if (!counter) return;
  counter.textContent = `Ảnh gắn mới: ${pendingClipboardImages.length}`;
}

function setClipboardImageStatus(message, isError = false) {
  const statusEl = document.getElementById('clipboardImageStatus');
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.style.color = isError ? '#b42318' : '#7c305c';
}

function updateClipboardEditUI() {
  const saveBtn = document.getElementById('saveClipboardBtn');
  const cancelBtn = document.getElementById('cancelClipboardEditBtn');
  if (saveBtn) {
    saveBtn.textContent = editingClipboardItemId ? 'Cập nhật comment' : 'Lưu comment';
  }
  if (cancelBtn) {
    cancelBtn.style.display = editingClipboardItemId ? 'inline-block' : 'none';
  }
}

function clearClipboardEditingState(resetInput = false) {
  editingClipboardItemId = null;
  if (resetInput) {
    const clipboardInput = getClipboardInput();
    if (clipboardInput) {
      clipboardInput.value = '';
    }
    setFolderCheckboxes([]);
  }
  updateClipboardEditUI();
}

const STORAGE_KEY_FOLDERS = 'commentFolders';
let folders = [];
let activeFolderId = 'all'; // 'all', 'none', or folder.id

function generateFolderId() {
  return `folder_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

const DEFAULT_PRESET_FOLDERS = [

];

async function getFolders() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY_FOLDERS], (result) => {
      let stored = Array.isArray(result[STORAGE_KEY_FOLDERS]) ? result[STORAGE_KEY_FOLDERS] : [];
      let updated = false;

      // Ensure all DEFAULT_PRESET_FOLDERS exist
      for (const defaultName of DEFAULT_PRESET_FOLDERS) {
        if (!stored.some((f) => f.name.trim().toLowerCase() === defaultName.trim().toLowerCase())) {
          stored.push({
            id: `preset_folder_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
            name: defaultName,
            createdAt: new Date().toISOString()
          });
          updated = true;
        }
      }

      if (updated) {
        chrome.storage.local.set({ [STORAGE_KEY_FOLDERS]: stored });
      }

      folders = stored;
      resolve(stored);
    });
  });
}

async function saveFolders(nextFolders) {
  folders = Array.isArray(nextFolders) ? nextFolders : [];
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY_FOLDERS]: folders }, () => resolve());
  });
}

async function renderFolderSection() {
  const folderListEl = document.getElementById('folderList');
  if (!folderListEl) return;

  renderRoomFolderOptions();

  folderListEl.innerHTML = '';

  const items = await getClipboardItems();

  const totalCount = items.length;
  let uncategorizedCount = 0;
  const folderCountMap = {};

  items.forEach((item) => {
    const fIds = Array.isArray(item.folderIds)
      ? item.folderIds
      : (item.folderId ? [item.folderId] : []);

    if (fIds.length === 0) {
      uncategorizedCount++;
    } else {
      fIds.forEach((id) => {
        folderCountMap[id] = (folderCountMap[id] || 0) + 1;
      });
    }
  });

  const createBadge = (count) => {
    const badge = document.createElement('span');
    badge.className = 'folder-count-badge';
    badge.textContent = count;
    return badge;
  };

  // Add default "Tất cả" pill
  const allPill = document.createElement('span');
  allPill.className = `folder-pill${activeFolderId === 'all' ? ' active' : ''}`;
  allPill.textContent = 'Tất cả ';
  allPill.appendChild(createBadge(totalCount));
  allPill.addEventListener('click', () => {
    activeFolderId = 'all';
    renderFolderSection();
    renderClipboardList();
  });
  folderListEl.appendChild(allPill);

  // Add default "Chưa phân loại" pill
  const nonePill = document.createElement('span');
  nonePill.className = `folder-pill${activeFolderId === 'none' ? ' active' : ''}`;
  nonePill.textContent = 'Chưa phân loại ';
  nonePill.appendChild(createBadge(uncategorizedCount));
  nonePill.addEventListener('click', () => {
    activeFolderId = 'none';
    renderFolderSection();
    renderClipboardList();
  });
  folderListEl.appendChild(nonePill);

  // Add custom folders
  for (const folder of folders) {
    const pill = document.createElement('span');
    pill.className = `folder-pill${activeFolderId === folder.id ? ' active' : ''}`;
    pill.textContent = folder.name + ' ';

    const countBadge = createBadge(folderCountMap[folder.id] || 0);
    pill.appendChild(countBadge);

    // Click on folder to filter and select all comments in this folder
    pill.addEventListener('click', async (e) => {
      if (e.target.classList.contains('delete-folder-btn')) return;

      activeFolderId = folder.id;

      // Auto select comments in this folder
      const items = await getClipboardItems();
      selectedClipboardIds.clear();
      for (const item of items) {
        const fIds = Array.isArray(item.folderIds) ? item.folderIds : (item.folderId ? [item.folderId] : []);
        if (fIds.includes(folder.id)) {
          selectedClipboardIds.add(item.id);
        }
      }
      await saveSelectedClipboardIds();
      renderFolderSection();
      renderClipboardList();
      updateSelectedClipboardCount();
    });

    // Delete folder button
    const deleteBtn = document.createElement('span');
    deleteBtn.className = 'delete-folder-btn';
    deleteBtn.textContent = '×';
    deleteBtn.title = 'Xóa thư mục';
    deleteBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const confirmed = confirm(`Xác nhận xóa thư mục "${folder.name}"?\n(Các comment trong thư mục này sẽ chuyển thành Chưa phân loại, không bị xóa)`);
      if (!confirmed) return;

      const nextFolders = folders.filter((f) => f.id !== folder.id);
      await saveFolders(nextFolders);

      // Clean up comments having this folderId
      const items = await getClipboardItems();
      const nextItems = items.map((item) => {
        let fIds = Array.isArray(item.folderIds) ? item.folderIds : (item.folderId ? [item.folderId] : []);
        if (fIds.includes(folder.id)) {
          fIds = fIds.filter((id) => id !== folder.id);
        }
        return {
          ...item,
          folderIds: fIds,
          folderId: '' // Clear legacy single folderId
        };
      });
      await saveClipboardItems(nextItems);

      if (activeFolderId === folder.id) {
        activeFolderId = 'all';
      }

      await renderFolderSection();
      populateFolderDropdown();
      renderClipboardList();
    });

    pill.appendChild(deleteBtn);
    folderListEl.appendChild(pill);
  }
}

function populateFolderCheckboxes() {
  const container = document.getElementById('clipboardFolderCheckboxes');
  if (!container) return;
  container.innerHTML = '';

  if (folders.length === 0) {
    const empty = document.createElement('span');
    empty.style.fontSize = '11px';
    empty.style.color = '#8b4a70';
    empty.textContent = '(Chưa có thư mục nào)';
    container.appendChild(empty);
    return;
  }

  for (const folder of folders) {
    const label = document.createElement('label');
    label.style.fontSize = '11px';
    label.style.display = 'flex';
    label.style.alignItems = 'center';
    label.style.gap = '4px';
    label.style.cursor = 'pointer';
    label.style.color = '#7c305c';
    label.style.userSelect = 'none';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = folder.id;
    checkbox.className = 'folder-checkbox-item';
    checkbox.style.width = 'auto';
    checkbox.style.margin = '0';

    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(folder.name));
    container.appendChild(label);
  }
}

function setFolderCheckboxes(folderIds = []) {
  const checkboxes = document.querySelectorAll('.folder-checkbox-item');
  checkboxes.forEach((cb) => {
    cb.checked = folderIds.includes(cb.value);
  });
}

function getSelectedFolderIds() {
  const checkboxes = document.querySelectorAll('.folder-checkbox-item');
  const ids = [];
  checkboxes.forEach((cb) => {
    if (cb.checked) {
      ids.push(cb.value);
    }
  });
  return ids;
}

function populateFolderDropdown() {
  const bulkSelectEl = document.getElementById('bulkFolderSelect');

  if (bulkSelectEl) {
    while (bulkSelectEl.options.length > 1) {
      bulkSelectEl.remove(1);
    }
    for (const folder of folders) {
      const opt = document.createElement('option');
      opt.value = folder.id;
      opt.textContent = folder.name;
      bulkSelectEl.appendChild(opt);
    }
  }

  populateFolderCheckboxes();
}

async function initializeFoldersMenu() {
  const addFolderBtn = document.getElementById('addFolderBtn');
  const newFolderNameInput = document.getElementById('newFolderName');
  const bulkAddFolderBtn = document.getElementById('bulkAddFolderBtn');
  const bulkRemoveFolderBtn = document.getElementById('bulkRemoveFolderBtn');
  const bulkFolderSelect = document.getElementById('bulkFolderSelect');

  folders = await getFolders();
  activeFolderId = 'all';

  await renderFolderSection();
  populateFolderDropdown();

  if (addFolderBtn && newFolderNameInput) {
    addFolderBtn.addEventListener('click', async () => {
      const name = newFolderNameInput.value.trim();
      if (!name) return;

      const newFolder = {
        id: generateFolderId(),
        name
      };

      folders.push(newFolder);
      await saveFolders(folders);

      newFolderNameInput.value = '';
      await renderFolderSection();
      populateFolderDropdown();
    });

    newFolderNameInput.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        addFolderBtn.click();
      }
    });
  }

  if (bulkAddFolderBtn && bulkFolderSelect) {
    bulkAddFolderBtn.addEventListener('click', async () => {
      if (selectedClipboardIds.size === 0) {
        setUploadStatus('Hãy tích chọn các comment trước.', true);
        return;
      }

      const targetFolderId = bulkFolderSelect.value || '';
      const items = await getClipboardItems();

      const nextItems = items.map((item) => {
        if (selectedClipboardIds.has(item.id)) {
          let fIds = Array.isArray(item.folderIds) ? item.folderIds : (item.folderId ? [item.folderId] : []);

          if (targetFolderId) {
            fIds = Array.from(new Set([...fIds, targetFolderId]));
          } else {
            fIds = []; // clear if "(Không chọn thư mục)" is selected
          }

          return {
            ...item,
            folderIds: fIds,
            folderId: '', // Clear legacy single folderId
            updatedAt: new Date().toISOString()
          };
        }
        return item;
      });

      await saveClipboardItems(nextItems);

      const folderName = targetFolderId
        ? (folders.find((f) => f.id === targetFolderId)?.name || 'thư mục đã chọn')
        : 'Chưa phân loại';

      setUploadStatus(`Đã thêm ${selectedClipboardIds.size} comment vào nhóm: ${folderName}`);
      await renderFolderSection();
      await renderClipboardList();
    });
  }

  if (bulkRemoveFolderBtn && bulkFolderSelect) {
    bulkRemoveFolderBtn.addEventListener('click', async () => {
      if (selectedClipboardIds.size === 0) {
        setUploadStatus('Hãy tích chọn các comment trước.', true);
        return;
      }

      const targetFolderId = bulkFolderSelect.value || '';
      if (!targetFolderId) {
        setUploadStatus('Hãy chọn một thư mục cụ thể để xóa comment khỏi đó.', true);
        return;
      }

      const items = await getClipboardItems();

      const nextItems = items.map((item) => {
        if (selectedClipboardIds.has(item.id)) {
          let fIds = Array.isArray(item.folderIds) ? item.folderIds : (item.folderId ? [item.folderId] : []);
          fIds = fIds.filter((id) => id !== targetFolderId);

          return {
            ...item,
            folderIds: fIds,
            folderId: '', // Clear legacy single folderId
            updatedAt: new Date().toISOString()
          };
        }
        return item;
      });

      await saveClipboardItems(nextItems);

      const folderObj = folders.find((f) => f.id === targetFolderId);
      setUploadStatus(`Đã xóa các comment được chọn khỏi nhóm: ${folderObj?.name || 'thư mục đã chọn'}`);
      await renderFolderSection();
      await renderClipboardList();
    });
  }
}

async function getClipboardItems() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY_CLIPBOARD], (result) => {
      const items = Array.isArray(result[STORAGE_KEY_CLIPBOARD]) ? result[STORAGE_KEY_CLIPBOARD] : [];

      let changed = false;
      const uniqueItems = [];
      const seenTexts = new Set();

      for (const item of items) {
        if (!item || typeof item.text !== 'string') continue;
        const normalizedText = item.text.trim();
        if (seenTexts.has(normalizedText)) {
          changed = true;
          // Merge folder IDs and image URLs
          const existingItem = uniqueItems.find(x => x.text.trim() === normalizedText);
          if (existingItem) {
            const existingFolderIds = Array.isArray(existingItem.folderIds) ? existingItem.folderIds : (existingItem.folderId ? [existingItem.folderId] : []);
            const itemFolderIds = Array.isArray(item.folderIds) ? item.folderIds : (item.folderId ? [item.folderId] : []);
            existingItem.folderIds = Array.from(new Set([...existingFolderIds, ...itemFolderIds]));
            existingItem.folderId = '';

            const existingImages = Array.isArray(existingItem.imageDataUrls) ? existingItem.imageDataUrls : [];
            const itemImages = Array.isArray(item.imageDataUrls) ? item.imageDataUrls : [];
            existingItem.imageDataUrls = Array.from(new Set([...existingImages, ...itemImages])).slice(0, MAX_CLIPBOARD_IMAGES_PER_ITEM);
          }
          continue;
        }
        seenTexts.add(normalizedText);
        uniqueItems.push(item);
      }

      if (changed) {
        chrome.storage.local.set({ [STORAGE_KEY_CLIPBOARD]: uniqueItems }, () => {
          resolve(uniqueItems);
        });
      } else {
        resolve(items);
      }
    });
  });
}

async function saveClipboardItems(items) {
  const normalized = Array.isArray(items) ? items.slice(0, 200) : [];
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY_CLIPBOARD]: normalized }, () => resolve());
  });
}

function downloadJsonFile(fileName, data) {
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportClipboardItems() {
  const items = await getClipboardItems();
  const currentFolders = await getFolders();
  const exportedAt = new Date().toISOString();
  const payload = {
    exportedAt,
    selectedIds: Array.from(selectedClipboardIds),
    folders: currentFolders,
    items
  };

  const stamp = exportedAt.replace(/[:.]/g, '-');
  downloadJsonFile(`facebook-comment-clipboard-${stamp}.json`, payload);
}

function normalizeImportedClipboardItem(item) {
  const text = (item?.text || '').trim();
  if (!text) return null;

  let fIds = [];
  if (Array.isArray(item?.folderIds)) {
    fIds = item.folderIds.filter((id) => typeof id === 'string' && id.trim());
  } else if (typeof item?.folderId === 'string' && item.folderId.trim()) {
    fIds = [item.folderId.trim()];
  }

  return {
    id: typeof item?.id === 'string' && item.id.trim() ? item.id.trim() : generateClipboardId(text),
    text,
    imageDataUrls: normalizeClipboardImageDataUrls(item?.imageDataUrls || []),
    folderIds: fIds,
    createdAt: typeof item?.createdAt === 'string' && item.createdAt.trim() ? item.createdAt.trim() : new Date().toISOString(),
    updatedAt: typeof item?.updatedAt === 'string' && item.updatedAt.trim() ? item.updatedAt.trim() : new Date().toISOString()
  };
}

function normalizeImportedClipboardItems(sourceItems) {
  const items = Array.isArray(sourceItems) ? sourceItems : [];
  const deduped = [];
  const seenByText = new Map();

  for (const item of items) {
    const normalized = normalizeImportedClipboardItem(item);
    if (!normalized) continue;

    const existingIndex = seenByText.get(normalized.text);
    if (existingIndex == null) {
      seenByText.set(normalized.text, deduped.length);
      deduped.push(normalized);
      continue;
    }

    const existing = deduped[existingIndex];
    const mergedFolderIds = Array.from(new Set([
      ...(Array.isArray(existing.folderIds) ? existing.folderIds : []),
      ...(Array.isArray(normalized.folderIds) ? normalized.folderIds : [])
    ]));
    deduped[existingIndex] = {
      ...existing,
      ...normalized,
      folderIds: mergedFolderIds,
      imageDataUrls: normalized.imageDataUrls.length ? normalized.imageDataUrls : existing.imageDataUrls,
      createdAt: existing.createdAt || normalized.createdAt,
      updatedAt: normalized.updatedAt || existing.updatedAt
    };
  }

  return deduped.slice(0, 200);
}

async function importClipboardItemsFromJson(payload) {
  const importedItems = normalizeImportedClipboardItems(payload?.items ?? payload);
  if (!importedItems.length) {
    throw new Error('File JSON không có comment hợp lệ để nhập.');
  }

  if (Array.isArray(payload?.folders)) {
    const existingFolders = await getFolders();
    const mergedFolders = [...existingFolders];
    for (const inf of payload.folders) {
      if (inf?.id && inf?.name && !mergedFolders.some((f) => f.id === inf.id)) {
        mergedFolders.push({ id: inf.id, name: inf.name });
      }
    }
    await saveFolders(mergedFolders);
  }

  const importedSelectedIds = Array.isArray(payload?.selectedIds)
    ? payload.selectedIds.filter((id) => typeof id === 'string' && id.trim())
    : [];
  const selectedIds = importedSelectedIds.filter((id) => importedItems.some((item) => item.id === id));

  await saveClipboardItems(importedItems);
  selectedClipboardIds.clear();
  for (const id of selectedIds) {
    selectedClipboardIds.add(id);
  }
  await saveSelectedClipboardIds();

  folders = await getFolders();
  await renderFolderSection();
  populateFolderDropdown();

  await renderClipboardList();
}

function normalizeClipboardImageDataUrls(imageDataUrls) {
  if (!Array.isArray(imageDataUrls)) return [];
  const urls = imageDataUrls
    .map((url) => (typeof url === 'string' ? url.trim() : ''))
    .filter((url) => /^(data:image\/|https?:\/\/)/i.test(url));
  return Array.from(new Set(urls)).slice(0, MAX_CLIPBOARD_IMAGES_PER_ITEM);
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

  return parts.filter(Boolean).join('\n').trim();
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

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Không chuyển được ảnh sang data URL'));
    reader.readAsDataURL(blob);
  });
}

async function encodeImageForClipboardStorage(file) {
  if (!file || !file.type?.startsWith('image/')) {
    return null;
  }

  try {
    const image = await loadImageFromFile(file);
    const ratio = Math.min(1, 1200 / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * ratio));
    const height = Math.max(1, Math.round(image.height * ratio));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0, width, height);

    let quality = 0.82;
    let blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));

    while (blob && blob.size > MAX_CLIPBOARD_IMAGE_BYTES && quality > 0.56) {
      quality -= 0.08;
      blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    }

    if (!blob) {
      return null;
    }

    return await blobToDataUrl(blob);
  } catch {
    return null;
  }
}

async function encodeClipboardImages(files) {
  const selected = Array.isArray(files) ? files.slice(0, MAX_CLIPBOARD_IMAGES_PER_ITEM) : [];
  const encoded = [];

  for (const file of selected) {
    const dataUrl = await encodeImageForClipboardStorage(file);
    if (dataUrl) {
      encoded.push(dataUrl);
    }
  }

  return normalizeClipboardImageDataUrls(encoded);
}

async function renderClipboardList() {
  const listEl = document.getElementById('clipboardList');
  if (!listEl) return;

  const allItems = await getClipboardItems();
  let items = allItems;

  if (activeFolderId && activeFolderId !== 'all') {
    if (activeFolderId === 'none') {
      items = items.filter((item) => {
        const fIds = Array.isArray(item.folderIds) ? item.folderIds : (item.folderId ? [item.folderId] : []);
        return fIds.length === 0;
      });
    } else {
      items = items.filter((item) => {
        const fIds = Array.isArray(item.folderIds) ? item.folderIds : (item.folderId ? [item.folderId] : []);
        return fIds.includes(activeFolderId);
      });
    }
  }

  if (clipboardSearchQuery) {
    const queryLower = clipboardSearchQuery.toLowerCase();
    items = items.filter((item) => item.text && item.text.toLowerCase().includes(queryLower));
  }

  listEl.innerHTML = '';

  if (!items.length) {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'clipboard-empty';
    if (clipboardSearchQuery) {
      emptyEl.textContent = 'Không tìm thấy comment nào khớp với tìm kiếm.';
    } else {
      emptyEl.textContent = 'Chưa có comment nào được lưu.';
    }
    listEl.appendChild(emptyEl);
    return;
  }

  for (const selectedId of Array.from(selectedClipboardIds)) {
    if (!allItems.some((item) => item.id === selectedId)) {
      selectedClipboardIds.delete(selectedId);
    }
  }

  await saveSelectedClipboardIds();

  if (editingClipboardItemId && !allItems.some((item) => item.id === editingClipboardItemId)) {
    clearClipboardEditingState();
  }

  for (const item of items) {
    const itemEl = document.createElement('div');
    itemEl.className = 'clipboard-item';
    if (selectedClipboardIds.has(item.id)) {
      itemEl.classList.add('is-selected');
    }

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
      saveSelectedClipboardIds();
    });

    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = 'Chọn';

    topEl.appendChild(selector);
    topEl.appendChild(label);

    const itemFolderIds = Array.isArray(item.folderIds) ? item.folderIds : (item.folderId ? [item.folderId] : []);
    if (itemFolderIds.length > 0) {
      for (const fId of itemFolderIds) {
        const folderObj = folders.find((f) => f.id === fId);
        if (folderObj) {
          const badge = document.createElement('span');
          badge.className = 'comment-folder-badge';
          badge.textContent = folderObj.name;
          topEl.appendChild(badge);
        }
      }
    }

    if (item.roomId) {
      const roomBadge = document.createElement('span');
      roomBadge.className = 'comment-folder-badge';
      roomBadge.style.background = '#fff3e0';
      roomBadge.style.color = '#e65100';
      roomBadge.style.borderColor = '#ffe0b2';
      roomBadge.textContent = `#${item.roomId}`;
      topEl.appendChild(roomBadge);
    }

    const textEl = document.createElement('div');
    textEl.className = 'clipboard-item-text';
    textEl.textContent = item.text;

    const imageCount = Array.isArray(item.imageDataUrls) ? item.imageDataUrls.length : 0;
    const metaEl = document.createElement('div');
    metaEl.className = 'hint';
    metaEl.style.marginTop = '6px';
    metaEl.style.marginBottom = '0';
    metaEl.textContent = `Ảnh: ${imageCount}`;

    const actionsEl = document.createElement('div');
    actionsEl.className = 'clipboard-item-actions';

    const useBtn = document.createElement('button');
    useBtn.type = 'button';
    useBtn.textContent = 'Lấy';
    useBtn.addEventListener('click', () => {
      fillFormFromClipboardText(item.text);
      const status = document.getElementById('status');
      if (status) status.textContent = `Đã nạp comment đã lưu vào ô Mô tả${imageCount ? ` (kèm ${imageCount} ảnh)` : ''}.`;
    });

    const attachBtn = document.createElement('button');
    attachBtn.type = 'button';
    attachBtn.textContent = 'Ảnh';

    const attachInput = document.createElement('input');
    attachInput.type = 'file';
    attachInput.accept = 'image/*';
    attachInput.multiple = true;
    attachInput.style.display = 'none';

    attachBtn.addEventListener('click', () => {
      attachInput.click();
    });

    attachInput.addEventListener('change', async (event) => {
      const files = Array.from(event.target.files || []);
      if (!files.length) return;

      const encodedImages = await encodeClipboardImages(files);
      if (!encodedImages.length) {
        setUploadStatus('Không mã hóa được ảnh để lưu. Ảnh cũ vẫn được giữ nguyên.', true);
        attachInput.value = '';
        return;
      }

      const nextItems = items.map((entry) => {
        if (entry.id !== item.id) return entry;
        return {
          ...entry,
          imageDataUrls: encodedImages,
          updatedAt: new Date().toISOString()
        };
      });

      await saveClipboardItems(nextItems);
      await renderClipboardList();
      setUploadStatus(`Đã cập nhật ${encodedImages.length} ảnh cho comment đã lưu.`);
      attachInput.value = '';
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
      await saveSelectedClipboardIds();
      await renderFolderSection();
      await renderClipboardList();
    });

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.textContent = 'Sửa';
    editBtn.addEventListener('click', () => {
      const clipboardInput = getClipboardInput();
      if (clipboardInput) {
        clipboardInput.value = item.text || '';
        clipboardInput.focus();
      }

      const itemFolderIds = Array.isArray(item.folderIds) ? item.folderIds : (item.folderId ? [item.folderId] : []);
      setFolderCheckboxes(itemFolderIds);

      editingClipboardItemId = item.id;
      updateClipboardEditUI();
      setUploadStatus('Đang sửa comment trong ô nhập. Bấm Cập nhật comment để lưu.');

      // Switch to CÀI ĐẶT tab so the user sees the edit form immediately
      document.querySelector('.tab[data-tab="smartskip"]')?.click();
    });

    actionsEl.appendChild(useBtn);
    actionsEl.appendChild(attachBtn);
    actionsEl.appendChild(editBtn);
    actionsEl.appendChild(copyBtn);
    actionsEl.appendChild(deleteBtn);

    itemEl.appendChild(topEl);
    itemEl.appendChild(textEl);
    itemEl.appendChild(metaEl);
    itemEl.appendChild(actionsEl);
    itemEl.appendChild(attachInput);
    listEl.appendChild(itemEl);
  }

  updateSelectedClipboardCount();
}

function extractRoomIdFromUrl(url) {
  if (!url) return '';
  const match = url.match(/\/products\/(?:show\/)?(\d+)/i) || url.match(/\/(\d+)(?:\?|#|$)/);
  return match ? match[1] : '';
}

async function checkRoomInClipboard(roomId, roomUrl) {
  if (!roomId && !roomUrl) return null;
  const items = await getClipboardItems();
  const found = items.find((item) => {
    if (roomId && item.roomId === roomId) return true;
    if (roomUrl && item.roomUrl === roomUrl) return true;
    if (roomId && item.text && (item.text.includes(roomId) || item.text.includes(`/show/${roomId}`))) return true;
    return false;
  });
  return found || null;
}

function getFolderNamesForClipboardItem(item) {
  if (!item) return 'Chưa phân loại';
  const itemFolderIds = Array.isArray(item.folderIds) ? item.folderIds : (item.folderId ? [item.folderId] : []);
  if (!itemFolderIds.length) return 'Chưa phân loại';
  const names = itemFolderIds.map((fId) => {
    const f = folders.find((folder) => folder.id === fId);
    return f ? f.name : '';
  }).filter(Boolean);
  return names.length ? names.join(', ') : 'Chưa phân loại';
}

async function addClipboardItem(text, imageDataUrls = [], folderIds = [], metadata = {}) {
  const normalized = (text || '').trim();
  if (!normalized) return false;

  const items = await getClipboardItems();
  const sanitizedImages = normalizeClipboardImageDataUrls(imageDataUrls);
  const roomId = metadata.roomId || extractRoomIdFromUrl(metadata.roomUrl || '');

  const existingIndex = items.findIndex((item) => {
    if (roomId && item.roomId === roomId) return true;
    if (metadata.roomUrl && item.roomUrl === metadata.roomUrl) return true;
    if (item.text === normalized) return true;
    return false;
  });

  if (existingIndex >= 0) {
    const existing = items[existingIndex];
    let mergedFolderIds = Array.isArray(existing.folderIds) ? existing.folderIds : (existing.folderId ? [existing.folderId] : []);
    if (Array.isArray(folderIds) && folderIds.length > 0) {
      mergedFolderIds = Array.from(new Set([...mergedFolderIds, ...folderIds]));
    }

    items[existingIndex] = {
      ...existing,
      text: normalized,
      imageDataUrls: sanitizedImages.length ? sanitizedImages : existing.imageDataUrls,
      folderIds: mergedFolderIds,
      roomId: roomId || existing.roomId || '',
      roomUrl: metadata.roomUrl || existing.roomUrl || '',
      folderId: '',
      updatedAt: new Date().toISOString()
    };
    await saveClipboardItems(items);
    await renderFolderSection();
    await renderClipboardList();
    return { success: true, updated: true, existingItem: items[existingIndex] };
  }

  const newItem = {
    id: generateClipboardId(normalized),
    text: normalized,
    imageDataUrls: sanitizedImages,
    folderIds: Array.isArray(folderIds) ? folderIds : [],
    roomId: roomId || '',
    roomUrl: metadata.roomUrl || '',
    folderId: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  items.unshift(newItem);

  await saveClipboardItems(items);
  await renderFolderSection();
  await renderClipboardList();
  return { success: true, updated: false, newItem };
}

async function buildCommentPayloadsFromClipboard(limit) {
  const items = await getClipboardItems();
  const usable = items
    .map((item) => ({
      text: (item?.text || '').trim(),
      imageUrls: normalizeClipboardImageDataUrls(item?.imageDataUrls || [])
    }))
    .filter((item) => Boolean(item.text));

  const selected = items
    .filter((item) => selectedClipboardIds.has(item.id))
    .map((item) => ({
      text: (item?.text || '').trim(),
      imageUrls: normalizeClipboardImageDataUrls(item?.imageDataUrls || [])
    }))
    .filter((item) => Boolean(item.text));

  const source = selected.length ? selected : usable;

  if (!source.length) {
    return [];
  }

  if (limit > 0) {
    return source.slice(0, limit);
  }

  return source;
}

function extractImagePayloadFromCommentText(rawComment) {
  const original = (rawComment || '').trim();
  if (!original) {
    return { commentText: '', imageUrls: [] };
  }

  const segments = original
    .split(/\s-\s|\s–\s|\s—\s|\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const kept = [];
  const urls = [];

  const isLikelyImageUrl = (value) => {
    const url = (value || '').toLowerCase();
    if (!/^https?:\/\//.test(url)) return false;
    if (/\.(png|jpe?g|webp|gif|bmp|svg)(\?|$)/i.test(url)) return true;
    if (url.includes('files.catbox.moe')) return true;
    if (url.includes('tmpfiles.org')) return true;
    if (url.includes('0x0.st')) return true;
    if (url.includes('transfer.sh')) return true;
    return false;
  };

  const extractUrls = (text) => {
    return (text.match(/https?:\/\/[^\s,]+/gi) || [])
      .map((part) => part.trim())
      .filter(Boolean);
  };

  for (const segment of segments) {
    const lower = segment.toLowerCase();
    const segmentUrls = extractUrls(segment);
    const hasImageLabel = lower.includes('hình ảnh') || lower.includes('hinh anh') || lower.includes('image:') || lower.includes('img:');
    const imageUrlsInSegment = segmentUrls.filter(isLikelyImageUrl);

    if (hasImageLabel && imageUrlsInSegment.length) {
      urls.push(...imageUrlsInSegment);
      continue;
    }

    if (!hasImageLabel && segmentUrls.length && imageUrlsInSegment.length === segmentUrls.length && imageUrlsInSegment.length > 0) {
      urls.push(...imageUrlsInSegment);
      continue;
    }

    kept.push(segment);
  }

  return {
    commentText: kept.join('\n').trim(),
    imageUrls: Array.from(new Set(urls))
  };
}

async function fetchImageUrlAsDataUrl(url) {
  const normalizedUrl = `${url || ''}`.trim().replace(/[\])}>.,;!?]+$/g, '');
  const response = await fetch(normalizedUrl, {
    method: 'GET',
    cache: 'no-store',
    referrerPolicy: 'no-referrer'
  });
  if (!response.ok) {
    throw new Error(`Không tải được ảnh: ${response.status}`);
  }
  const blob = await response.blob();
  if (!blob.type.startsWith('image/')) {
    throw new Error('URL không trả về dữ liệu ảnh');
  }
  return blobToDataUrl(blob);
}

async function hydrateClipboardPayloadImages(commentPayloads) {
  const source = Array.isArray(commentPayloads) ? commentPayloads : [];
  const hydrated = [];
  let hydratedCount = 0;
  let failedCount = 0;

  for (const payload of source) {
    const normalizedPayloadUrls = normalizeClipboardImageDataUrls(payload?.imageUrls || []);
    const fallbackFromText = extractImagePayloadFromCommentText(payload?.text || '').imageUrls;
    const candidateUrls = normalizedPayloadUrls.length ? normalizedPayloadUrls : fallbackFromText;

    if (!candidateUrls.length) {
      hydrated.push(payload);
      continue;
    }

    const materialized = [];
    for (const url of candidateUrls.slice(0, MAX_CLIPBOARD_IMAGES_PER_ITEM)) {
      if (/^data:image\//i.test(url)) {
        materialized.push(url);
        hydratedCount += 1;
        continue;
      }

      try {
        const dataUrl = await fetchImageUrlAsDataUrl(url);
        materialized.push(dataUrl);
        hydratedCount += 1;
      } catch {
        failedCount += 1;
      }
    }

    hydrated.push({
      ...payload,
      imageUrls: normalizeClipboardImageDataUrls(materialized)
    });
  }

  if (failedCount > 0) {
    setUploadStatus(`Có ${failedCount} ảnh không chuyển được sang ảnh đính kèm. Hãy bấm Gắn ảnh để chọn lại ảnh cho comment đó.`, true);
  } else if (hydratedCount > 0) {
    setUploadStatus(`Đã chuẩn bị ${hydratedCount} ảnh đính kèm từ clipboard.`);
  }

  return hydrated;
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

function getPreferredFacebookTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (activeTabs) => {
      const activeFacebookTab = (activeTabs || []).find((tab) => isFacebookAccessibleUrl(tab?.url || ''));
      if (activeFacebookTab?.id) {
        resolve(activeFacebookTab);
        return;
      }

      chrome.tabs.query({ active: true }, (allActiveTabs) => {
        const anyActiveFacebookTab = (allActiveTabs || []).find((tab) => isFacebookAccessibleUrl(tab?.url || ''));
        if (anyActiveFacebookTab?.id) {
          resolve(anyActiveFacebookTab);
          return;
        }

        chrome.tabs.query({ url: ['*://*.facebook.com/*'] }, (facebookTabs) => {
          const candidate = (facebookTabs || [])[0] || null;
          resolve(candidate);
        });
      });
    });
  });
}

function getFacebookCandidateTabs() {
  return new Promise((resolve) => {
    const ordered = [];
    const seen = new Set();

    const pushTabs = (tabs) => {
      for (const tab of tabs || []) {
        if (!tab?.id) continue;
        if (!isFacebookAccessibleUrl(tab.url || '')) continue;
        if (seen.has(tab.id)) continue;
        seen.add(tab.id);
        ordered.push(tab);
      }
    };

    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabsLastFocused) => {
      pushTabs(tabsLastFocused);

      chrome.tabs.query({ active: true }, (tabsActive) => {
        pushTabs(tabsActive);

        chrome.tabs.query({ url: ['*://*.facebook.com/*'] }, (tabsAllFacebook) => {
          pushTabs(tabsAllFacebook);
          resolve(ordered);
        });
      });
    });
  });
}

async function probeClipboardCurrentPostOnTab(tabId) {
  try {
    return await sendMessageToTab(tabId, { action: 'pingClipboardCurrentPost' });
  } catch {
    try {
      await injectContentScript(tabId);
      return await sendMessageToTab(tabId, { action: 'pingClipboardCurrentPost' });
    } catch {
      return null;
    }
  }
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

  if (runState?.mode === 'menu2' || runState?.stickToCurrentPost) {
    const candidates = await getFacebookCandidateTabs();
    if (!candidates.length) {
      throw new Error('Không tìm thấy tab Facebook đang mở.');
    }

    let lastProbeMessage = '';
    for (const tab of candidates) {
      const probe = await probeClipboardCurrentPostOnTab(tab.id);
      if (!probe) continue;
      if (probe.status === 'ready' && probe.openedPostReady) {
        return tab.id;
      }

      if (probe.message) {
        lastProbeMessage = probe.message;
      }
    }

    throw new Error(lastProbeMessage || 'Không nhận diện được post đang mở có ô bình luận khả dụng.');
  }

  const preferredTab = await getPreferredFacebookTab();
  if (!preferredTab?.id) {
    throw new Error('Không tìm thấy tab Facebook đang mở.');
  }

  if (!isFacebookAccessibleUrl(preferredTab.url || '')) {
    throw new Error('Tab hiện tại không phải Facebook. Hãy mở post Facebook rồi chạy lại.');
  }

  return preferredTab.id;
}

async function initializeClipboardMenu() {
  const clipboardInput = getClipboardInput();
  const saveBtn = document.getElementById('saveClipboardBtn');
  const clearBtn = document.getElementById('clearClipboardInputBtn');
  const cancelEditBtn = document.getElementById('cancelClipboardEditBtn');
  const clearSelectedBtn = document.getElementById('clearSelectedClipboardBtn');
  const importBtn = document.getElementById('importClipboardBtn');
  const importFileInput = document.getElementById('importClipboardFileInput');
  const exportBtn = document.getElementById('exportClipboardBtn');

  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      const text = (clipboardInput?.value || '').trim() || buildCommentFromCurrentForm(currentIndex);
      if (!text) {
        setUploadStatus('Không có comment nào để lưu.', true);
        return;
      }

      if (editingClipboardItemId) {
        const items = await getClipboardItems();
        const existing = items.find((entry) => entry.id === editingClipboardItemId);
        if (!existing) {
          clearClipboardEditingState();
          setUploadStatus('Comment cần sửa không còn tồn tại.', true);
          await renderClipboardList();
          return;
        }

        const nextImages = pendingClipboardImages.length
          ? normalizeClipboardImageDataUrls(pendingClipboardImages)
          : normalizeClipboardImageDataUrls(existing.imageDataUrls || []);

        const folderIds = getSelectedFolderIds();

        const nextItems = items.map((entry) => {
          if (entry.id !== editingClipboardItemId) return entry;
          return {
            ...entry,
            text,
            imageDataUrls: nextImages,
            folderIds,
            folderId: '',
            updatedAt: new Date().toISOString()
          };
        });

        await saveClipboardItems(nextItems);
        await renderClipboardList();
        setUploadStatus('Đã cập nhật comment đã lưu.');
        pendingClipboardImages = [];
        updateSelectedClipboardImageCount();
        setClipboardImageStatus('');
        clearClipboardEditingState(true);
        return;
      }

      const folderIds = getSelectedFolderIds();
      await addClipboardItem(text, pendingClipboardImages, folderIds);
      if (clipboardInput) clipboardInput.value = text;
      setUploadStatus(`Đã lưu comment vào clipboard${pendingClipboardImages.length ? ` (kèm ${pendingClipboardImages.length} ảnh)` : ''}.`);
      pendingClipboardImages = [];
      updateSelectedClipboardImageCount();
      setClipboardImageStatus('');
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      if (clipboardInput) clipboardInput.value = '';
      setFolderCheckboxes([]);
      if (editingClipboardItemId) {
        clearClipboardEditingState();
      }
      setUploadStatus('Đã xóa ô nhập clipboard.');
    });
  }

  if (cancelEditBtn) {
    cancelEditBtn.addEventListener('click', () => {
      clearClipboardEditingState(true);
      setUploadStatus('Đã hủy chế độ sửa comment.');
    });
  }

  if (clearSelectedBtn) {
    clearSelectedBtn.addEventListener('click', async () => {
      selectedClipboardIds.clear();
      updateSelectedClipboardCount();
      await saveSelectedClipboardIds();
      await renderClipboardList();
      setUploadStatus('Đã bỏ chọn tất cả comment trong clipboard.');
    });
  }

  const deleteAllBtn = document.getElementById('deleteAllClipboardBtn');
  if (deleteAllBtn) {
    deleteAllBtn.addEventListener('click', async () => {
      const items = await getClipboardItems();
      if (!items.length) {
        setUploadStatus('Clipboard đang trống, không có gì để xóa.', true);
        return;
      }

      const confirmed = confirm(`Xác nhận xóa tất cả ${items.length} comment trong clipboard?\nHành động này không thể hoàn tác.`);
      if (!confirmed) {
        return;
      }

      await saveClipboardItems([]);
      selectedClipboardIds.clear();
      updateSelectedClipboardCount();
      await saveSelectedClipboardIds();
      clearClipboardEditingState();
      await renderFolderSection();
      await renderClipboardList();
      setUploadStatus('Đã xóa tất cả comment trong clipboard.');
    });
  }

  if (importBtn && importFileInput) {
    importBtn.addEventListener('click', () => {
      importFileInput.click();
    });

    importFileInput.addEventListener('change', async (event) => {
      const file = (event.target.files || [])[0];
      if (!file) return;

      try {
        const rawText = await file.text();
        const parsed = JSON.parse(rawText);
        await importClipboardItemsFromJson(parsed);
        setUploadStatus(`Đã nhập JSON và khôi phục ${selectedClipboardIds.size} comment được chọn.`);
      } catch (error) {
        setUploadStatus(`Không nhập được JSON: ${error.message}`, true);
      } finally {
        importFileInput.value = '';
      }
    });
  }

  if (exportBtn) {
    exportBtn.addEventListener('click', async () => {
      const items = await getClipboardItems();
      if (!items.length) {
        setUploadStatus('Clipboard đang trống, chưa có gì để xuất.', true);
        return;
      }

      await exportClipboardItems();
      setUploadStatus(`Đã xuất ${items.length} comment clipboard ra file JSON.`);
    });
  }

  if (clipboardInput) {
    clipboardInput.addEventListener('change', saveFormData);
    clipboardInput.addEventListener('input', saveFormData);
  }

  const searchInput = document.getElementById('clipboardSearchInput');
  if (searchInput) {
    searchInput.addEventListener('input', async (e) => {
      clipboardSearchQuery = e.target.value.trim();
      await renderClipboardList();
    });
  }

  await loadSelectedClipboardIds();
  await renderClipboardList();
  updateSelectedClipboardCount();
  updateClipboardEditUI();
}

function initializeClipboardImagePicker() {
  const pickBtn = document.getElementById('pickClipboardImagesBtn');
  const fileInput = document.getElementById('clipboardImageFileInput');
  if (!pickBtn || !fileInput) return;

  pickBtn.addEventListener('click', () => {
    fileInput.click();
  });

  fileInput.addEventListener('change', async (event) => {
    const files = Array.from(event.target.files || []);
    if (!files.length) return;

    pendingClipboardImages = await encodeClipboardImages(files);
    if (!pendingClipboardImages.length) {
      setClipboardImageStatus('Không xử lý được ảnh đã chọn, vui lòng thử ảnh khác.', true);
      updateSelectedClipboardImageCount();
      fileInput.value = '';
      return;
    }

    updateSelectedClipboardImageCount();
    setClipboardImageStatus(`Đã chọn ${pendingClipboardImages.length} ảnh để gắn vào comment sắp lưu.`);
    fileInput.value = '';
  });

  updateSelectedClipboardImageCount();
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

function sendCurrentCommentMenu1(ignoreHistory = false, hasRetriedIgnoreHistory = false, hasRetriedConnection = false) {
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
        imageUrls: runState
          ? (getCurrentRunPayload()?.imageUrls || [])
          : commentImageUrls,
        targetPostUrl: runState?.targetPostUrl || getTargetPostUrl(),
        lockPostFingerprint: runState?.lockPostFingerprint || '',
        lockPostSessionKey: runState?.lockPostSessionKey || '',
        excludePostFingerprint: runState?.lastCompletedPostFingerprint || '',
        excludePostSessionKey: runState?.lastCompletedPostSessionKey || '',
        keepOnCurrentPost: runState ? shouldStayOnCurrentPost() : false,
        allowScroll: runState ? !runState.stickToCurrentPost : true,
        maxScrollRounds: runState?.stickToCurrentPost ? 0 : 4,
        markProcessed: runState ? (runState.stickToCurrentPost ? false : !shouldStayOnCurrentPost()) : true,
        scrollAfterSubmit: runState ? (runState.stickToCurrentPost ? false : !shouldStayOnCurrentPost()) : true,
        ignoreHistory
      },
      (response) => {
        isSendingComment = false;
        if (startBtn) startBtn.disabled = false;

        if (chrome.runtime.lastError) {
          if (!hasRetriedConnection) {
            document.getElementById('status').textContent = 'Mất kết nối content script, đang tự khởi tạo lại...';

            ensureContentScriptReady(tabId)
              .then(() => {
                sendCurrentCommentMenu1(ignoreHistory, hasRetriedIgnoreHistory, true);
              })
              .catch(() => {
                document.getElementById('status').textContent = 'Không thể kết nối với trang Facebook. Hãy mở tab Facebook hợp lệ rồi thử lại.';
                if (nextBtn) nextBtn.disabled = comments.length <= 1;
              });

            return;
          }

          document.getElementById('status').textContent = 'Không thể kết nối với trang Facebook. Hãy mở tab Facebook hợp lệ rồi thử lại.';
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
            sendCurrentCommentMenu1(true, true);
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

        if (response.status === 'FacebookBlocked') {
          if (runState?.active) {
            finishRun(`Dừng batch: ${response.message || 'Bị Facebook chặn/hạn chế bình luận.'}`);
            return;
          }

          document.getElementById('status').textContent = response.message || 'Bị Facebook chặn/hạn chế bình luận.';
          if (nextBtn) nextBtn.disabled = false;
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
            runState.lastCompletedPostFingerprint = response.postFingerprint || runState.lockPostFingerprint || '';
            runState.lastCompletedPostSessionKey = response.postSessionKey || runState.lockPostSessionKey || '';
            runState.postIndex += 1;
            runState.commentIndexInPost = 0;
            runState.lockPostFingerprint = '';
            runState.lockPostSessionKey = '';
          }

          if (runState.postIndex >= runState.targetPosts) {
            finishRun(`Đã hoàn tất ${runState.targetPosts} post, mỗi post ${runState.commentsPerPost} comment.`);
            return;
          }

          setTimeout(() => sendCurrentCommentMenu1(), getCommentDelayMs());
        }
      }
    );
  })();
}

function sendCurrentCommentMenu2(hasRetriedConnection = false) {
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
      document.getElementById('status').textContent = `Không xác định được tab chạy Menu 2: ${error.message}`;
      isSendingComment = false;
      if (startBtn) startBtn.disabled = false;
      return;
    }

    chrome.tabs.sendMessage(
      tabId,
      {
        action: 'fillClipboardCurrentPost',
        comment: runState ? getCurrentRunComment() : comments[currentIndex],
        imageUrls: runState
          ? (getCurrentRunPayload()?.imageUrls || [])
          : commentImageUrls,
        keepOnCurrentPost: runState ? shouldStayOnCurrentPost() : false,
        allowScroll: false,
        maxScrollRounds: 0,
        markProcessed: false,
        scrollAfterSubmit: false,
        ignoreHistory: false
      },
      (response) => {
        if (menu2TimeoutId) {
          clearTimeout(menu2TimeoutId);
          menu2TimeoutId = null;
        }
        isSendingComment = false;
        if (startBtn) startBtn.disabled = false;

        if (chrome.runtime.lastError) {
          if (!hasRetriedConnection) {
            document.getElementById('status').textContent = 'Menu 2 mất kết nối content script, đang tự khởi tạo lại...';

            ensureContentScriptReady(tabId)
              .then(() => {
                sendCurrentCommentMenu2(true);
              })
              .catch(() => {
                document.getElementById('status').textContent = 'Menu 2 không thể kết nối tab Facebook đang mở post. Hãy bấm vào tab post Facebook rồi chạy lại.';
              });

            return;
          }

          document.getElementById('status').textContent = 'Menu 2 không thể kết nối tab Facebook đang mở post. Hãy bấm vào tab post Facebook rồi chạy lại.';
          return;
        }

        if (!response) {
          document.getElementById('status').textContent = 'Menu 2 không nhận được phản hồi từ tab Facebook.';
          return;
        }

        if (response.status === 'No more posts') {
          finishRun('Menu 2 không tìm thấy post đang mở có ô bình luận hợp lệ.');
          return;
        }

        if (response.status === 'FacebookBlocked') {
          finishRun(`Menu 2 dừng: ${response.message || 'Bị Facebook chặn/hạn chế bình luận.'}`);
          return;
        }

        if (response.status === 'SubmitFailed') {
          finishRun('Menu 2 đã điền nhưng chưa bấm gửi thành công.');
          return;
        }

        if (response.status === 'InternalError') {
          finishRun(`Menu 2 lỗi xử lý: ${response.message || 'Không rõ nguyên nhân'}`);
          return;
        }

        if (response.status !== 'Filled') {
          finishRun('Menu 2 nhận phản hồi không hợp lệ từ content script.');
          return;
        }

        const attached = Number(response.attachedImages || 0);
        const skipped = Number(response.skippedImages || 0);
        const reason = response.attachmentReason ? `, lý do: ${response.attachmentReason}` : '';
        if (attached > 0 || skipped > 0) {
          document.getElementById('status').textContent = `Menu 2 điền comment ${currentIndex + 1}/${comments.length} (ảnh đính kèm: ${attached}, lỗi: ${skipped}${reason})`;
        } else {
          document.getElementById('status').textContent = `Menu 2 điền comment ${currentIndex + 1}/${comments.length}`;
        }

        if (runState?.active) {
          if (shouldStayOnCurrentPost()) {
            runState.commentIndexInPost += 1;
            updateRunProgressStatus();
          } else {
            runState.postIndex += 1;
            runState.commentIndexInPost = 0;
          }

          if (runState.postIndex >= runState.targetPosts) {
            finishRun(`Menu 2 đã hoàn tất ${runState.commentsPerPost} comment trên post đang mở.`);
            return;
          }

          setTimeout(() => sendCurrentCommentMenu2(), getCommentDelayMs());
        }
      }
    );

    let menu2TimeoutId = setTimeout(() => {
      menu2TimeoutId = null;
      if (!isSendingComment) return;
      isSendingComment = false;
      if (startBtn) startBtn.disabled = false;
      finishRun('Menu 2 timeout: quá lâu không nhận phản hồi từ tab Facebook đang mở.');
    }, 15000);
  })();
}

function sendCurrentCommentByMode(ignoreHistory = false, hasRetriedIgnoreHistory = false) {
  if (runState?.mode === 'menu2') {
    sendCurrentCommentMenu2();
    return;
  }

  sendCurrentCommentMenu1(ignoreHistory, hasRetriedIgnoreHistory);
}

async function startRunWithConfig({ targetPosts, commentsPerPost, commentSet, targetPostUrl, stickToCurrentPost = false, mode = 'menu1' }) {
  const payloadSet = Array.isArray(commentSet)
    ? commentSet.map((entry) => {
      if (typeof entry === 'string') {
        return { text: entry, imageUrls: [] };
      }

      return {
        text: (entry?.text || '').trim(),
        imageUrls: normalizeClipboardImageDataUrls(entry?.imageUrls || [])
      };
    }).filter((entry) => Boolean(entry.text))
    : [];

  if (!payloadSet.length) {
    document.getElementById('status').textContent = 'Không có comment nào để chạy.';
    return;
  }

  comments = payloadSet.map((entry) => entry.text);
  currentIndex = 0;
  runState = createRunState({
    targetPosts,
    commentsPerPost,
    commentPayloadSet: payloadSet,
    targetPostUrl
  });
  runState.stickToCurrentPost = Boolean(stickToCurrentPost);
  runState.mode = mode === 'menu2' ? 'menu2' : 'menu1';

  const nextBtn = document.getElementById('nextBtn');
  if (nextBtn) nextBtn.disabled = true;

  const stopRunBtn = document.getElementById('stopRunBtn');
  if (stopRunBtn) stopRunBtn.classList.remove('is-hidden');

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
    } else {
      const activeTabId = await resolveRunTabId();
      await ensureContentScriptReady(activeTabId);
    }

    sendCurrentCommentByMode();
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

  const singleComment = parts.join('\n');
  await startRunWithConfig({
    targetPosts: numPosts,
    commentsPerPost: 1,
    commentSet: [{ text: singleComment, imageUrls: commentImageUrls.slice() }],
    targetPostUrl,
    mode: 'menu1'
  });
}

async function startClipboardMenu() {
  if (runState?.active || isSendingComment) {
    document.getElementById('status').textContent = 'Đang có batch chạy, vui lòng đợi hoàn tất.';
    return;
  }

  const commentsPerPost = getClipboardCount();

  if (!Number.isFinite(commentsPerPost) || commentsPerPost <= 0) {
    document.getElementById('status').textContent = 'Menu 2 cần nhập Số cmt / post.';
    return;
  }

  const selectedCommentsRaw = await buildCommentPayloadsFromClipboard(commentsPerPost);
  if (selectedCommentsRaw.length < commentsPerPost) {
    document.getElementById('status').textContent = 'Số comment đã chọn trong clipboard không đủ.';
    return;
  }

  document.getElementById('status').textContent = 'Đang chuẩn bị ảnh cho comment clipboard...';
  const selectedComments = await hydrateClipboardPayloadImages(selectedCommentsRaw);

  commentImageUrls = [];
  await startRunWithConfig({
    targetPosts: 1,
    commentsPerPost,
    commentSet: selectedComments.slice(0, commentsPerPost),
    targetPostUrl: '',
    stickToCurrentPost: true,
    mode: 'menu2'
  });
}

document.getElementById('startFormBtn')?.addEventListener('click', startFormMenu);
document.getElementById('startClipboardBtn')?.addEventListener('click', startClipboardMenu);

document.getElementById('stopRunBtn')?.addEventListener('click', async () => {
  if (runState) {
    if (runState.targetTabId) {
      chrome.tabs.sendMessage(runState.targetTabId, { action: 'stopRun' }, () => { });
    }
    finishRun('Đã dừng chạy bình luận.');
  }
});

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

  sendCurrentCommentMenu1();
});

// #region Room Extractor & AI Parsing Logic
function parsePriceToHashtag(priceRaw) {
  if (!priceRaw) return '';

  let text = priceRaw.replace(/💸|đ|VNĐ|vnd|VND/g, '').trim();

  const existingHash = text.match(/#(\d+\s*tr\s*\d*)/i);
  if (existingHash) return `#${existingHash[1].replace(/\s+/g, '')}`;

  const trMatch = text.match(/(\d+)\s*tr\s*(\d*)/i);
  if (trMatch) {
    const main = trMatch[1];
    const sub = trMatch[2];
    return sub ? `#${main}tr${sub}` : `#${main}tr`;
  }

  const cleanDigits = text.replace(/[^\d]/g, '');
  if (!cleanDigits) return '';

  const num = parseInt(cleanDigits, 10);
  if (isNaN(num)) return '';

  if (num >= 100000) {
    const million = num / 1000000;
    const whole = Math.floor(million);
    const decimal = Math.round((million - whole) * 10);

    if (decimal > 0) {
      return `#${whole}tr${decimal}`;
    } else {
      return `#${whole}tr`;
    }
  } else if (num < 100) {
    return `#${num}tr`;
  }

  return '';
}

function parseVietnameseAddress(addressRaw) {
  if (!addressRaw) return '';

  let str = addressRaw.trim();

  // Strip room/code suffix like "- A666C", "/ A666C", " - Mã..."
  str = str.replace(/\s*[-/]\s*[A-Z0-9]{3,}$/i, '');

  const districtMap = [
    { regex: /\b(PN|Phú Nhuận)\b/i, name: 'Phú Nhuận' },
    { regex: /\b(TB|Tân Bình)\b/i, name: 'Tân Bình' },
    { regex: /\b(BT|Bình Thạnh)\b/i, name: 'Bình Thạnh' },
    { regex: /\b(TĐ|TPTĐ|Thủ Đức)\b/i, name: 'Thủ Đức' },
    { regex: /\b(GV|Gò Vấp)\b/i, name: 'Gò Vấp' },
    { regex: /\b(TP|Tân Phú)\b/i, name: 'Tân Phú' },
    { regex: /\b(BTP|Bình Tân)\b/i, name: 'Bình Tân' },
    { regex: /\b(NB|Nhà Bè)\b/i, name: 'Nhà Bè' },
    { regex: /\b(BC|Bình Chánh)\b/i, name: 'Bình Chánh' },
    { regex: /\b(HM|Hóc Môn)\b/i, name: 'Hóc Môn' },
    { regex: /\b(Q\.?\s*0?1|Quận\s*0?1)\b/i, name: 'Quận 1' },
    { regex: /\b(Q\.?\s*0?2|Quận\s*0?2)\b/i, name: 'Quận 2' },
    { regex: /\b(Q\.?\s*0?3|Quận\s*0?3)\b/i, name: 'Quận 3' },
    { regex: /\b(Q\.?\s*0?4|Quận\s*0?4)\b/i, name: 'Quận 4' },
    { regex: /\b(Q\.?\s*0?5|Quận\s*0?5)\b/i, name: 'Quận 5' },
    { regex: /\b(Q\.?\s*0?6|Quận\s*0?6)\b/i, name: 'Quận 6' },
    { regex: /\b(Q\.?\s*0?7|Quận\s*0?7)\b/i, name: 'Quận 7' },
    { regex: /\b(Q\.?\s*0?8|Quận\s*0?8)\b/i, name: 'Quận 8' },
    { regex: /\b(Q\.?\s*0?9|Quận\s*0?9)\b/i, name: 'Quận 9' },
    { regex: /\b(Q\.?\s*10|Quận\s*10)\b/i, name: 'Quận 10' },
    { regex: /\b(Q\.?\s*11|Quận\s*11)\b/i, name: 'Quận 11' },
    { regex: /\b(Q\.?\s*12|Quận\s*12)\b/i, name: 'Quận 12' }
  ];

  let detectedDistrict = '';
  for (const item of districtMap) {
    if (item.regex.test(str)) {
      detectedDistrict = item.name;
      break;
    }
  }

  let streetName = str;
  // Remove leading house/alley number e.g. "298/14 ", "123A ", "Hẻm 298 "
  streetName = streetName.replace(/^(?:Hẻm\s+)?\d+[\d/a-zA-Z-]*\s+/, '');

  // Remove district part from street name
  for (const item of districtMap) {
    streetName = streetName.replace(item.regex, '');
  }

  // Clean trailing punctuation
  streetName = streetName.replace(/^[,.\s-]+|[,.\s-]+$/g, '').trim();

  if (streetName && detectedDistrict) {
    return `${streetName}, ${detectedDistrict}`;
  } else if (streetName) {
    return streetName;
  } else if (detectedDistrict) {
    return detectedDistrict;
  }

  return addressRaw;
}

function parseFurnitureText(furnitureRaw) {
  if (!furnitureRaw) return 'FULL nội thất';

  let clean = furnitureRaw.replace(/^[^\w\s]*\s*(?:Nội thất\s*:\s*)?/i, '').trim();
  clean = clean.replace(/^Nội thất\s*:\s*/i, '').trim();

  if (!clean || clean.toLowerCase() === 'full nội thất') {
    return 'FULL nội thất';
  }

  return `${clean} + FULL nội thất`;
}

async function parseRoomWithGeminiAPI(raw, apiKey) {
  const prompt = `Xử lý thông tin phòng trọ:
- "cleanAddress": Rút gọn địa chỉ thành chỉ "Tên đường, Tên quận". Ví dụ: "298/14 Nguyễn Thượng Hiền, PN - A666C" -> "Nguyễn Thượng Hiền, Phú Nhuận". PN=Phú Nhuận, TB=Tân Bình, BT=Bình Thạnh, Q10=Quận 10.
- "priceHashtag": Chỉ tạo duy nhất hashtag giá như #15tr, #7tr6, #10tr8 từ số tiền (15.000.000đ -> "#15tr", 7.600.000đ -> "#7tr6"). Không ghi chữ Giá hay full số tiền.
- "cleanFurniture": Làm sạch nội thất, trả về dạng "[Nội thất đọc được] + FULL nội thất" (ví dụ: "Máy giặt riêng + FULL nội thất").

Dữ liệu thô:
- Địa chỉ: ${raw.address || ''}
- Giá: ${raw.price || ''}
- Nội thất: ${raw.furnitureRaw || ''}

Trả về duy nhất JSON: {"cleanAddress": "...", "priceHashtag": "...", "cleanFurniture": "..."}`;

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }]
    })
  });

  if (!res.ok) return null;
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const cleanJson = text.replace(/```json|```/g, '').trim();
  return JSON.parse(cleanJson);
}

let currentExtractedRoomImage = '';

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function parseNumericPrice(priceRaw) {
  if (!priceRaw) return 0;
  let text = priceRaw.replace(/💸|đ|VNĐ|vnd|VND/gi, '').trim();

  const trMatch = text.match(/(\d+)\s*tr\s*(\d*)/i);
  if (trMatch) {
    const main = parseInt(trMatch[1], 10) || 0;
    const sub = trMatch[2] ? parseInt(trMatch[2], 10) : 0;
    return (main * 1000000) + (sub * 100000);
  }

  const cleanDigits = text.replace(/[^\d]/g, '');
  if (!cleanDigits) return 0;
  const num = parseInt(cleanDigits, 10);
  if (isNaN(num)) return 0;

  if (num < 100) {
    return num * 1000000;
  }
  return num;
}

function autoMatchRoomFolder(districtName, priceRaw, roomTypeRaw, currentFolders) {
  if (!districtName || !Array.isArray(currentFolders) || currentFolders.length === 0) {
    return '';
  }

  const is2PN = /2\s*(?:phòng|pn)/i.test(roomTypeRaw || '');
  const numPrice = parseNumericPrice(priceRaw);

  const distKeyMap = {
    'Phú Nhuận': 'Phú Nhuận',
    'Bình Thạnh': 'Bình Thạnh',
    'Quận 3': 'Quận 3',
    'Quận 1': 'Quận 1',
    'Thủ Đức': 'Thủ Đức',
    'Gò Vấp': 'Gò Vấp',
    'Quận 10': 'Quận 10',
    'Tân Bình': 'Tân Bình',
    'Tân Phú': 'Tân Phú'
  };

  const distKey = distKeyMap[districtName] || districtName;
  const lowerDist = distKey.toLowerCase();

  let matchedFolder = null;

  if (is2PN) {
    matchedFolder = currentFolders.find((f) => {
      const fn = (f.name || '').toLowerCase();
      return fn.includes(lowerDist) && (fn.includes('2pn') || fn.includes('2 phòng') || fn.includes('2 pn'));
    });
  } else if (numPrice >= 8000000) {
    matchedFolder = currentFolders.find((f) => {
      const fn = (f.name || '').toLowerCase();
      return fn.includes(lowerDist) && fn.includes('trên 8');
    });
  } else if (numPrice > 0 && numPrice < 8000000) {
    matchedFolder = currentFolders.find((f) => {
      const fn = (f.name || '').toLowerCase();
      return fn.includes(lowerDist) && fn.includes('dưới 8');
    });
  }

  return matchedFolder ? matchedFolder.id : '';
}

async function getActivePageTab() {
  let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tabs && tabs[0] && tabs[0].id) return tabs[0];

  tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs && tabs[0] && tabs[0].id) return tabs[0];

  tabs = await chrome.tabs.query({ active: true });
  return (tabs && tabs[0]) || null;
}

function isTyrahomeProductUrl(url) {
  return /^https?:\/\/(www\.)?tyrahome\.net\/products\//i.test((url || '').trim());
}

async function extractRoomInfoFromActiveTab(xpathMap) {
  const activeTab = await getActivePageTab();
  if (!activeTab || !activeTab.id) {
    throw new Error('Không tìm thấy tab đang mở trên trình duyệt.');
  }

  const tabUrl = activeTab.url || '';
  if (!isTyrahomeProductUrl(tabUrl)) {
    throw new Error('NOT_TYRAHOME_PRODUCT');
  }

  const response = await chrome.scripting.executeScript({
    target: { tabId: activeTab.id },
    func: (xpaths) => {
      function getByXPath(xpath, attr = 'textContent') {
        if (!xpath || typeof xpath !== 'string') return '';
        try {
          const result = document.evaluate(
            xpath.trim(),
            document,
            null,
            XPathResult.FIRST_ORDERED_NODE_TYPE,
            null
          );
          const node = result.singleNodeValue;
          if (!node) return '';
          if (attr === 'src') {
            return node.src || node.getAttribute('src') || node.dataset?.src || '';
          }
          return (node.textContent || '').trim();
        } catch (e) {
          console.error('[RoomExtractor] Error evaluating XPath:', xpath, e);
          return '';
        }
      }

      let price = getByXPath(xpaths.price, 'textContent');
      let address = getByXPath(xpaths.address, 'textContent');
      let furnitureRaw = getByXPath(xpaths.furniture, 'textContent');
      let utilities = getByXPath(xpaths.utilities, 'textContent');
      let imageSrc = getByXPath(xpaths.image, 'src');
      let roomTypeRaw = getByXPath(xpaths.roomType, 'textContent');

      // Smart Fallback for Address
      if (!address) {
        const h1 = document.querySelector('#app h1, main h1, h1, #app h2, header h1');
        if (h1 && h1.textContent.trim()) {
          address = h1.textContent.trim();
        }
      }

      // Smart Fallback for Price
      if (!price) {
        const allNodes = Array.from(document.querySelectorAll('#app p, #app div, #app span, #app h2, #app h3'));
        for (const el of allNodes) {
          const text = el.textContent.trim();
          if (/(?:💸|\b\d{1,3}(?:\.\d{3})+\s*đ|\b\d+(?:\.\d+)?\s*tr\b)/i.test(text) && text.length < 50) {
            price = text;
            break;
          }
        }
      }

      // Smart Fallback for Furniture
      if (!furnitureRaw) {
        const allNodes = Array.from(document.querySelectorAll('#app p, #app div, #app li, #app span'));
        for (const el of allNodes) {
          const text = el.textContent.trim();
          if (/Nội thất/i.test(text) && text.length < 80 && el.children.length === 0) {
            furnitureRaw = text;
            break;
          }
        }
      }

      // Check Status element ("Còn hàng" vs "Đã cho thuê") to pick proper Utilities XPath
      const statusText = getByXPath('//*[@id="app"]/div/div/div[2]/div/div[2]/div[1]/div', 'textContent') || (document.body ? document.body.innerText : '');

      let preferredUtilitiesXPath = xpaths.utilities;
      if (/Đã cho thuê/i.test(statusText)) {
        preferredUtilitiesXPath = '//*[@id="app"]/div/div/div[2]/div/div[2]/div[4]/p[2]';
      } else if (/Còn hàng/i.test(statusText)) {
        preferredUtilitiesXPath = '//*[@id="app"]/div/div/div[2]/div/div[2]/div[5]/p[2]';
      }

      function isGarbageUtilities(str) {
        if (!str) return true;
        return /arrow_back|favorite_border|Chi tiết bất động sản|share/i.test(str);
      }

      utilities = getByXPath(preferredUtilitiesXPath, 'textContent');

      if (isGarbageUtilities(utilities)) {
        const altXPath = preferredUtilitiesXPath.includes('div[5]')
          ? '//*[@id="app"]/div/div/div[2]/div/div[2]/div[4]/p[2]'
          : '//*[@id="app"]/div/div/div[2]/div/div[2]/div[5]/p[2]';
        const altText = getByXPath(altXPath, 'textContent');
        if (!isGarbageUtilities(altText)) {
          utilities = altText;
        } else {
          utilities = '';
        }
      }

      // Smart Fallback for Utilities if empty or garbage
      if (!utilities || isGarbageUtilities(utilities)) {
        const allNodes = Array.from(document.querySelectorAll('#app p, #app div, #app li, #app span'));
        let foundHeader = false;
        for (const el of allNodes) {
          const text = el.textContent.trim();
          if (/^Tiện ích$/i.test(text) || text === 'Tiện ích') {
            foundHeader = true;
            continue;
          }
          if (foundHeader && text && !isGarbageUtilities(text) && text.length < 100) {
            utilities = text;
            break;
          }
        }
      }

      if (isGarbageUtilities(utilities)) {
        utilities = '';
      }

      // Smart Fallback for Image
      if (!imageSrc) {
        const img = document.querySelector('#app img, main img, article img, img[src*="http"]');
        if (img) {
          imageSrc = img.src || img.getAttribute('src') || img.dataset?.src || '';
        }
      }

      // Smart Fallback for Room Type filter
      if (!roomTypeRaw) {
        const btn3 = document.querySelector('#app button:nth-of-type(3), main button:nth-of-type(3)');
        if (btn3 && btn3.textContent.trim()) {
          roomTypeRaw = btn3.textContent.trim();
        }
      }

      return {
        price,
        address,
        furnitureRaw,
        utilities,
        imageSrc,
        roomTypeRaw,
        url: window.location.href,
        title: document.title
      };
    },
    args: [xpathMap]
  });

  if (response && response[0] && response[0].result) {
    return response[0].result;
  }
  return null;
}

async function formatRoomCommentText({ price, address, furnitureRaw, utilities }, phone = '', geminiApiKey = '') {
  const lines = [];
  let cleanAddress = '';
  let hashtagPrice = '';
  let cleanFurniture = '';

  if (geminiApiKey && geminiApiKey.trim()) {
    try {
      const aiResult = await parseRoomWithGeminiAPI({ price, address, furnitureRaw, utilities }, geminiApiKey.trim());
      if (aiResult) {
        cleanAddress = aiResult.cleanAddress || '';
        hashtagPrice = aiResult.priceHashtag || '';
        cleanFurniture = aiResult.cleanFurniture || '';
      }
    } catch (e) {
      console.warn('[Gemini AI] Call failed, using local parser:', e);
    }
  }

  if (!cleanAddress) {
    cleanAddress = parseVietnameseAddress(address);
  }

  if (!hashtagPrice) {
    hashtagPrice = parsePriceToHashtag(price);
  }

  if (!cleanFurniture) {
    cleanFurniture = parseFurnitureText(furnitureRaw);
  }

  if (hashtagPrice) {
    lines.push(hashtagPrice);
  } else if (price) {
    const rawPriceClean = price.replace(/💸/g, '').trim();
    lines.push(`#${rawPriceClean}`);
  }

  if (cleanAddress) {
    lines.push(`Địa chỉ: ${cleanAddress}`);
  } else {
    lines.push(`Địa chỉ: (Không đọc được)`);
  }

  lines.push(`Nội thất: ${cleanFurniture}`);

  if (utilities) {
    lines.push(`Tiện ích: ${utilities}`);
  } else {
    lines.push(`Tiện ích: (Không đọc được)`);
  }

  const inputContact = (document.getElementById('contactPhone')?.value || document.getElementById('captionPhone')?.value || '').trim();
  const finalContact = (phone && phone.trim()) || inputContact;

  if (finalContact) {
    lines.push(`Liên hệ: ${finalContact}`);
  } else {
    lines.push(`Liên hệ: (Chưa nhập SĐT cấu hình)`);
  }

  return lines.map((l) => l.trim() + ' ').join('\n');
}

let lastExtractedRoomData = null;

function getNearbyUniversities(addressStr) {
  const addr = (addressStr || '').toLowerCase();
  if (addr.includes('bình thạnh') || addr.includes('binh thanh')) {
    return 'Gần ĐH HUTECH, UEF, Văn Lang, GTVT';
  }
  if (addr.includes('quận 10') || addr.includes('quan 10')) {
    return 'Gần ĐH Bách Khoa, HUFLIT, UEH, Y Dược';
  }
  if (addr.includes('thủ đức') || addr.includes('thu duc')) {
    return 'Gần Làng Đại Học Quốc Gia, SPKT, Nông Lâm, HUTECH';
  }
  if (addr.includes('gò vấp') || addr.includes('go vap')) {
    return 'Gần ĐH Công Nghiệp (IUH), Văn Lang CS3, Cao Đẳng Bách Việt';
  }
  if (addr.includes('tân bình') || addr.includes('tan binh')) {
    return 'Gần ĐH Tài Nguyên Môi Trường, Học viện Hàng Không';
  }
  if (addr.includes('quận 3') || addr.includes('quan 3')) {
    return 'Gần ĐH Mở, Kiến Trúc, UEH, SP';
  }
  if (addr.includes('quận 1') || addr.includes('quan 1')) {
    return 'Gần ĐH KHXH&NV, ĐH Ngân Hàng, Sài Gòn';
  }
  if (addr.includes('phú nhuận') || addr.includes('phu nhuan')) {
    return 'Gần ĐH Y Dược, Cao Đẳng FPT, ĐH FPT';
  }
  if (addr.includes('tân phú') || addr.includes('tan phu')) {
    return 'Gần ĐH Công Thương (HUIT), ĐH Văn Hiến';
  }
  if (addr.includes('quận 7') || addr.includes('quan 7')) {
    return 'Gần ĐH Tôn Đức Thắng, RMIT, UFM';
  }
  return '';
}

function parseAddressComponents(addressRaw) {
  const clean = parseVietnameseAddress(addressRaw);
  const parts = clean.split(',').map((s) => s.trim()).filter(Boolean);
  const street = parts[0] || '';
  const district = parts[1] || parts[0] || '';
  return { clean, street, district };
}

function generateDynamicHashtags(roomData, customHashtags = '') {
  const { street, district } = parseAddressComponents(roomData.address || '');

  const removeAccents = (str) => (str || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
  const toPascalCase = (str) => removeAccents(str).replace(/[^a-zA-Z0-9]/g, ' ').split(/\s+/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('');

  const tagList = [];

  // Custom / Brand tags
  if (customHashtags && customHashtags.trim()) {
    const rawTags = customHashtags.trim().split(/\s+/).filter((t) => t.startsWith('#'));
    tagList.push(...rawTags);
  } else {
    tagList.push('#KeyZoneHome', '#Studio');
  }

  // Location tags
  if (street) tagList.push(`#${toPascalCase(street)}`);
  if (district) tagList.push(`#${toPascalCase(district)}`);

  // Price tag
  const numPrice = parseNumericPrice(roomData.price);
  if (numPrice > 0) {
    const tr = numPrice / 1000000;
    tagList.push(`#${tr.toString().replace('.', 't')}Trieu`);
  }

  // Feature tags extracted from text
  const combinedText = `${roomData.furnitureRaw || ''} ${roomData.utilities || ''}`.toLowerCase();
  if (combinedText.includes('nội thất') || combinedText.includes('noi that')) tagList.push('#PhongFullNoiThat');
  if (combinedText.includes('máy giặt') || combinedText.includes('may giat')) tagList.push('#MayGiatRieng');
  if (combinedText.includes('thang máy') || combinedText.includes('thang may')) tagList.push('#ThangMay');
  if (combinedText.includes('ban công') || combinedText.includes('ban cong')) tagList.push('#BanCongRong');
  if (combinedText.includes('cửa sổ') || combinedText.includes('cua so')) tagList.push('#CuaSoThoang');

  // General real estate tags
  tagList.push('#ChoThuePhong', '#TimPhongTro', '#PhongTroDep');

  return Array.from(new Set(tagList)).join(' ');
}

async function fetchGeminiAiCaption(aiPrompt, geminiApiKey) {
  const cleanKey = (geminiApiKey || '').trim();
  if (!cleanKey) {
    throw new Error('Chưa nhập Gemini API Key. Vui lòng dán API Key tại tab GET API -> Cấu hình & AI.');
  }

  // Validate API Key & fetch supported models directly from Google AI Studio
  const listRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${cleanKey}`);
  const listData = await listRes.json().catch(() => ({}));

  if (!listRes.ok) {
    const errMsg = listData.error?.message || `HTTP ${listRes.status} (${listRes.statusText})`;
    if (listRes.status === 400 || errMsg.toLowerCase().includes('key not valid') || errMsg.toLowerCase().includes('invalid')) {
      throw new Error(`API Key không hợp lệ (${errMsg}). Hãy tạo API Key mới miễn phí tại https://aistudio.google.com/app/apikey`);
    }
    if (listRes.status === 403 || errMsg.toLowerCase().includes('permission') || errMsg.toLowerCase().includes('disabled')) {
      throw new Error(`API Key chưa được cấp quyền Generative Language API (${errMsg}). Hãy tạo Key mới tại https://aistudio.google.com/app/apikey`);
    }
    throw new Error(`Lỗi xác thực Gemini API Key: ${errMsg}`);
  }

  // Extract models that support generateContent for this API key
  const models = listData.models || [];
  const validModels = models.filter((m) =>
    m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent')
  );

  if (!validModels.length) {
    throw new Error('API Key của bạn không có model Gemini nào hỗ trợ tạo văn bản. Hãy tạo Key mới tại https://aistudio.google.com/app/apikey');
  }

  // Preferred model ordering: gemini-3.6-flash first, gemini-1.5-flash, gemini-2.0-flash, gemini-1.5-pro, etc.
  const preferredNames = ['gemini-3.6-flash', 'gemini-1.5-flash', 'gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-2.5-flash'];
  const orderedModels = [];

  for (const pref of preferredNames) {
    const found = validModels.find((m) => m.name.toLowerCase().includes(pref));
    if (found && !orderedModels.includes(found.name)) {
      orderedModels.push(found.name);
    }
  }

  for (const m of validModels) {
    if (!orderedModels.includes(m.name)) {
      orderedModels.push(m.name);
    }
  }

  // Direct fallback names if ListModels returned models without flash
  if (!orderedModels.length) {
    orderedModels.push('models/gemini-3.6-flash', 'models/gemini-1.5-flash', 'models/gemini-2.0-flash');
  }

  let lastErrMsg = '';

  for (const modelPath of orderedModels) {
    // modelPath is full string like "models/gemini-3.6-flash" or "models/gemini-1.5-flash"
    try {
      const cleanPath = modelPath.startsWith('models/') ? modelPath : `models/${modelPath}`;
      const url = `https://generativelanguage.googleapis.com/v1beta/${cleanPath}:generateContent?key=${cleanKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: aiPrompt }] }],
          generationConfig: {
            temperature: 1.0,
            topP: 0.95
          }
        })
      });

      if (res.ok) {
        const data = await res.json();
        let text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        if (text && text.trim()) {
          // Remove Markdown bold/italic asterisks (* and **) since Facebook plain text doesn't render them
          text = text.replace(/\*\*/g, '').replace(/^\s*\*+/gm, '• ').replace(/\*/g, '');
          return text.trim();
        }
      } else {
        const errBody = await res.json().catch(() => ({}));
        lastErrMsg = errBody.error?.message || `HTTP ${res.status} (${res.statusText})`;
        console.warn(`[Gemini Model Retry] Model ${cleanPath} failed: ${lastErrMsg}. Retrying next available model...`);
      }
    } catch (err) {
      lastErrMsg = err.message || String(err);
    }
  }

  throw new Error(`Lỗi tạo bài đăng từ Gemini API (${lastErrMsg}).`);
}

async function formatRoomCaptionText(roomData, { titleTemplate, phone, customHashtags, currentCommentText }, geminiApiKey = '', forceAi = false) {
  if (!roomData && !currentCommentText) return '';
  const priceStr = roomData?.price ? roomData.price.replace(/💸/g, '').trim() : '';
  const { clean: cleanAddr } = parseAddressComponents(roomData?.address || '');

  // Attempt Gemini AI if key is present or AI button clicked
  if (geminiApiKey && geminiApiKey.trim()) {
    try {
      const styles = [
        'Phong cách Ngắn gọn, Đắt giá & Nổi bật (câu từ súc tích, gạch đầu dòng tiện ích rõ ràng, dễ đọc)',
        'Phong cách Săn Phòng Hot / Chốt cọc nhanh (ngắn gọn, giật tin hot, nhấn mạnh điểm cộng nổi bật)',
        'Phong cách Đặt câu hỏi súc tích (dành cho người tìm phòng gấp, trực diện vào vị trí & mức giá)',
        'Phong cách Review ngắn gọn (liệt kê điểm cộng nổi bật, thông tin đắt giá, đọc là muốn cọc)'
      ];
      const selectedStyle = styles[Math.floor(Math.random() * styles.length)];
      const randomSeed = Math.floor(Math.random() * 1000000);

      const aiPrompt = `Bạn là một chuyên gia viết bài đăng cho thuê phòng trọ Facebook cực kỳ chuyên nghiệp và súc tích.
Mã sáng tạo ngẫu nhiên: #${randomSeed}

NHIỆM VỤ: Dựa vào NỘI DUNG COMMENT PHÒNG dưới đây, hãy sáng tạo 1 bài đăng Facebook NGẮN GỌN, SÚC TÍCH, NỔI BẬT VÀ DỄ ĐỌC.

NỘI DUNG COMMENT PHÒNG DÙNG ĐỂ VIẾT:
"""
${currentCommentText || `Giá: ${priceStr}\nĐịa chỉ: ${roomData?.address || ''}\nNội thất: ${roomData?.furnitureRaw || ''}\nTiện ích: ${roomData?.utilities || ''}\nLiên hệ: ${phone || ''}`}
"""

PHONG CÁCH YÊU CẦU: ${selectedStyle}

QUY TẮC VIẾT (RẤT QUAN TRỌNG):
1. VIẾT NGẮN GỌN & RÕ RÀNG:
   - TUYỆT ĐỐI KHÔNG VIẾT DÀI DÒNG THÀNH BÀI VĂN TÂM SỰ/TRIẾT LÝ HỌC (Không viết kiểu "Có những ngày chỉ muốn gạt hết bộn bề...", "Nếu bạn đang tìm chốn về...").
   - TUYỆT ĐỐI KHÔNG DÙNG DẤU SAO * HOẶC ** ĐỂ IN ĐẬM (Vì bài viết Facebook không hỗ trợ Markdown, sẽ bị hiện rác dấu **). Hãy dùng chữ IN HOA hoặc Emoji nếu muốn làm nổi bật!
   - Trình bày súc tích dạng các câu ngắn gọn, dùng emoji hợp lý và gạch đầu dòng các tiện nghi để người mua lướt qua là nắm ngay thông tin.
2. ĐẦY ĐỦ THÔNG TIN CỐT LÕI:
   - Trích xuất chuẩn xác Địa chỉ, Mức giá, Nội thất, Tiện ích và SĐT Liên hệ (${phone || '[Số điện thoại]'}) từ nội dung comment trên.
3. ĐẠI HỌC LÂN CẬN CHUẨN TPHCM:
   - Tự động phân tích tên đường / tên quận ở TP.HCM từ địa chỉ trên để gợi ý 2-4 trường đại học lân cận phù hợp (Bình Thạnh -> HUTECH, UEF, Văn Lang; Quận 10 -> Bách Khoa, HUFLIT,...).
4. HASHTAGS ĐỘNG:
   - Tạo 8-12 hashtags động ngắn ở cuối bài (#TenDuong, #TenQuan, #MucGia, #TienNhi, #TimPhongTro...). ${customHashtags ? `Thêm: ${customHashtags}` : ''}

Chỉ trả về DUY NHẤT nội dung bài đăng Facebook hoàn chỉnh. Không kèm lời chào, không giải thích hay mở ngoặc.`;

      return await fetchGeminiAiCaption(aiPrompt, geminiApiKey);
    } catch (e) {
      console.warn('[Gemini AI Caption] Error:', e);
      if (forceAi) {
        throw e;
      }
    }
  } else if (forceAi) {
    throw new Error('Chưa có Gemini API Key. Vui lòng dán API Key tại tab GET API -> Cấu hình & AI.');
  }

  // Fallback Local Template Generator
  let titleStr = (titleTemplate || '🏡 STUDIO FULL NỘI THẤT – {ADDRESS} ✨').trim();
  const shortAddrUpper = (cleanAddr || roomData.address || '').toUpperCase();
  if (titleStr.includes('{ADDRESS}')) {
    titleStr = titleStr.replace('{ADDRESS}', shortAddrUpper);
  } else {
    titleStr = `${titleStr} – ${shortAddrUpper} ✨`;
  }

  const nearbyUnis = getNearbyUniversities(cleanAddr || roomData.address);
  const addressLine = cleanAddr
    ? `📍 Đường ${cleanAddr}${nearbyUnis ? ` (${nearbyUnis})` : ''}`
    : `📍 ${roomData.address || 'Đang cập nhật địa chỉ'}`;

  const priceLine = priceStr
    ? `💰 Chỉ ${priceStr}${/tháng|thang/i.test(priceStr) ? '' : '/tháng'}`
    : '💰 Giá: Thỏa thuận';

  const cleanFurniture = parseFurnitureText(roomData.furnitureRaw);
  const utilsList = [];
  if (cleanFurniture) utilsList.push(cleanFurniture);
  if (roomData.utilities) utilsList.push(roomData.utilities);
  const utilitiesLine = utilsList.length
    ? `✨ Tiện ích: ${utilsList.join(' | ')}`
    : '✨ Tiện ích: Full nội thất | Giờ giấc tự do | An ninh';

  const phoneLine = `LH: ${phone || '090xxxxxxx'}`;
  const ctaBlock = `📩 Inbox ngay để xem phòng thực tế và giữ phòng!\n${phoneLine}`;

  const hashtagsLine = generateDynamicHashtags(roomData, customHashtags);

  return `${titleStr}\n\n${addressLine}\n\n${priceLine}\n\n${utilitiesLine}\n\n${ctaBlock}\n\n${hashtagsLine}`;
}

async function renderRoomFolderOptions() {
  const roomFolderSelect = document.getElementById('roomFolderSelect');
  if (!roomFolderSelect) return;

  const currentFolders = await getFolders();
  const selectedVal = roomFolderSelect.value;

  let html = '<option value="">(Không chọn thư mục - Chưa phân loại)</option>';
  currentFolders.forEach((f) => {
    html += `<option value="${escapeHtml(f.id)}">${escapeHtml(f.name)}</option>`;
  });

  roomFolderSelect.innerHTML = html;
  if (selectedVal && currentFolders.some((f) => f.id === selectedVal)) {
    roomFolderSelect.value = selectedVal;
  }
}

let autoExtractTimer = null;

async function performAutoRoomExtract(isManual = false) {
  const roomCommentText = document.getElementById('roomCommentText');
  const roomExtractedResultBox = document.getElementById('roomExtractedResultBox');
  const roomExtractStatus = document.getElementById('roomExtractStatus');
  const extractRoomBtn = document.getElementById('extractRoomBtn');
  const roomImagePreviewContainer = document.getElementById('roomImagePreviewContainer');
  const roomImagePreview = document.getElementById('roomImagePreview');

  const activeTab = await getActivePageTab();
  const tabUrl = activeTab?.url || '';

  if (!isTyrahomeProductUrl(tabUrl)) {
    if (roomExtractStatus) {
      if (isManual) {
        roomExtractStatus.textContent = 'ℹ Chỉ tự động đọc thông tin từ link sản phẩm Tyrahome (https://tyrahome.net/products/...).';
      } else {
        roomExtractStatus.textContent = 'ℹ Tab hiện tại không phải link sản phẩm Tyrahome (https://tyrahome.net/products/...).';
      }
      roomExtractStatus.style.color = '#7c305c';
    }
    return;
  }

  const xpathPrice = document.getElementById('xpathPrice')?.value || '';
  const xpathAddress = document.getElementById('xpathAddress')?.value || '';
  const xpathFurniture = document.getElementById('xpathFurniture')?.value || '';
  const xpathUtilities = document.getElementById('xpathUtilities')?.value || '';
  const xpathImage = document.getElementById('xpathImage')?.value || '';
  const xpathRoomType = document.getElementById('xpathRoomType')?.value || '';
  const geminiApiKey = document.getElementById('geminiApiKeyInput')?.value || '';

  if (roomExtractStatus) {
    roomExtractStatus.textContent = '⚡ Đang tự động đọc dữ liệu phòng...';
    roomExtractStatus.style.color = '#7c305c';
  }

  try {
    const roomData = await extractRoomInfoFromActiveTab({
      price: xpathPrice,
      address: xpathAddress,
      furniture: xpathFurniture,
      utilities: xpathUtilities,
      image: xpathImage,
      roomType: xpathRoomType
    });

    if (!roomData || (!roomData.price && !roomData.address && !roomData.furnitureRaw)) {
      if (roomExtractStatus) {
        roomExtractStatus.textContent = 'ℹ Tab hiện tại không thấy dữ liệu phòng. Hãy mở tab chi tiết phòng.';
      }
      return;
    }

    lastExtractedRoomData = roomData;

    const captionPhone = document.getElementById('captionPhone')?.value || '';
    const contactPhone = document.getElementById('contactPhone')?.value || '';
    const phone = (captionPhone || contactPhone || '').trim();

    const commentString = await formatRoomCommentText(roomData, phone, geminiApiKey);

    if (roomCommentText) {
      roomCommentText.value = commentString;
    }

    // Handle Image Preview
    if (roomData.imageSrc && roomData.imageSrc.trim()) {
      currentExtractedRoomImage = roomData.imageSrc.trim();
      if (roomImagePreview) roomImagePreview.src = currentExtractedRoomImage;
      if (roomImagePreviewContainer) roomImagePreviewContainer.classList.remove('is-hidden');
    } else {
      currentExtractedRoomImage = '';
      if (roomImagePreviewContainer) roomImagePreviewContainer.classList.add('is-hidden');
    }

    await renderRoomFolderOptions();

    // Auto Match Folder
    const cleanAddress = parseVietnameseAddress(roomData.address);
    let detectedDistrict = '';
    const knownDistricts = ['Phú Nhuận', 'Bình Thạnh', 'Quận 3', 'Quận 1', 'Thủ Đức', 'Gò Vấp', 'Quận 10', 'Tân Bình', 'Tân Phú'];
    for (const d of knownDistricts) {
      if (cleanAddress.toLowerCase().includes(d.toLowerCase())) {
        detectedDistrict = d;
        break;
      }
    }

    const currentFolders = await getFolders();
    const matchedFolderId = autoMatchRoomFolder(detectedDistrict, roomData.price, roomData.roomTypeRaw, currentFolders);
    if (matchedFolderId) {
      const roomFolderSelect = document.getElementById('roomFolderSelect');
      if (roomFolderSelect) {
        roomFolderSelect.value = matchedFolderId;
      }
    }

    if (roomExtractedResultBox) {
      roomExtractedResultBox.classList.remove('is-hidden');
    }

    const folderObj = currentFolders.find((f) => f.id === matchedFolderId);
    const matchedName = folderObj ? folderObj.name : 'Chưa phân loại';

    const currentRoomId = extractRoomIdFromUrl(tabUrl);
    const existingInClipboard = await checkRoomInClipboard(currentRoomId, tabUrl);

    if (existingInClipboard) {
      const existingFolderNames = getFolderNamesForClipboardItem(existingInClipboard);
      if (roomExtractStatus) {
        roomExtractStatus.innerHTML = `⚠️ <b>CẢNH BÁO: Phòng này (Mã #${currentRoomId}) ĐÃ CÓ trong Clipboard!</b><br><span style="font-size: 11px; color: #e65100;">(Thuộc thư mục: ${escapeHtml(existingFolderNames)})</span>`;
      }
      if (addRoomCommentBtn) {
        addRoomCommentBtn.textContent = `⚠️ Đã có trong Clipboard (Bấm để cập nhật lại)`;
        addRoomCommentBtn.style.background = 'linear-gradient(180deg, #f57c00 0%, #e65100 100%)';
      }
    } else {
      if (roomExtractStatus) {
        roomExtractStatus.textContent = `✨ Phòng mới (Mã #${currentRoomId || 'N/A'}) - Tự động chọn thư mục "${matchedName}"!${currentExtractedRoomImage ? ' (Kèm 1 ảnh)' : ''}`;
        roomExtractStatus.style.color = '#1b5e20';
      }
      if (addRoomCommentBtn) {
        addRoomCommentBtn.textContent = `➕ Thêm vào danh sách Comment`;
        addRoomCommentBtn.style.background = 'linear-gradient(180deg, #388e3c 0%, #2e7d32 100%)';
      }
    }
  } catch (err) {
    if (err.message === 'NOT_TYRAHOME_PRODUCT') {
      if (roomExtractStatus) {
        roomExtractStatus.textContent = 'ℹ Chỉ tự động đọc thông tin từ link sản phẩm Tyrahome (https://tyrahome.net/products/...).';
        roomExtractStatus.style.color = '#7c305c';
      }
      return;
    }
    console.error('[AutoExtract] Error:', err);
    if (roomExtractStatus) {
      roomExtractStatus.textContent = `ℹ ${err.message || 'Mở tab chi tiết phòng rồi nhấn Đọc lại.'}`;
      roomExtractStatus.style.color = '#7c305c';
    }
  }
}

function initializeRoomExtractorMenu() {
  const toggleXPathConfigBtn = document.getElementById('toggleXPathConfigBtn');
  const xpathConfigBox = document.getElementById('xpathConfigBox');
  const extractRoomBtn = document.getElementById('extractRoomBtn');
  const roomExtractedResultBox = document.getElementById('roomExtractedResultBox');
  const roomCommentText = document.getElementById('roomCommentText');
  const roomFolderSelect = document.getElementById('roomFolderSelect');
  const addRoomCommentBtn = document.getElementById('addRoomCommentBtn');
  const generateAiCaptionBtn = document.getElementById('generateAiCaptionBtn');
  const generateCaptionBtn = document.getElementById('generateCaptionBtn');
  const fbCaptionResultBox = document.getElementById('fbCaptionResultBox');
  const fbCaptionText = document.getElementById('fbCaptionText');
  const copyCaptionBtn = document.getElementById('copyCaptionBtn');
  const addCaptionToClipboardBtn = document.getElementById('addCaptionToClipboardBtn');
  const captionTitlePattern = document.getElementById('captionTitlePattern');
  const captionPhone = document.getElementById('captionPhone');
  const captionHashtags = document.getElementById('captionHashtags');
  const contactPhone = document.getElementById('contactPhone');
  const roomExtractStatus = document.getElementById('roomExtractStatus');
  const geminiApiKeyInput = document.getElementById('geminiApiKeyInput');

  // Load user-entered Gemini API Key & XPath Config
  const xpathFields = ['xpathPrice', 'xpathAddress', 'xpathFurniture', 'xpathUtilities', 'xpathImage', 'xpathRoomType'];
  chrome.storage.local.get(['geminiApiKey', 'xpathConfig'], (res) => {
    let savedKey = res.geminiApiKey || '';
    if (savedKey.includes('AIzaSyBYGsY2uvXNjpNDzLmI')) {
      savedKey = '';
      chrome.storage.local.remove(['geminiApiKey']);
    }
    if (geminiApiKeyInput) geminiApiKeyInput.value = savedKey;

    const config = res.xpathConfig || {};
    for (const field of xpathFields) {
      const el = document.getElementById(field);
      if (el && config[field]) el.value = config[field];
    }
  });

  if (geminiApiKeyInput) {
    geminiApiKeyInput.addEventListener('change', () => {
      chrome.storage.local.set({ geminiApiKey: geminiApiKeyInput.value.trim() });
    });
    geminiApiKeyInput.addEventListener('input', () => {
      chrome.storage.local.set({ geminiApiKey: geminiApiKeyInput.value.trim() });
    });
  }

  const saveXpathConfigBtn = document.getElementById('saveXpathConfigBtn');
  const resetXpathConfigBtn = document.getElementById('resetXpathConfigBtn');

  if (saveXpathConfigBtn) {
    saveXpathConfigBtn.addEventListener('click', () => {
      const config = {};
      for (const field of xpathFields) {
        const el = document.getElementById(field);
        if (el) config[field] = el.value.trim();
      }
      const apiKeyVal = (geminiApiKeyInput?.value || '').trim();
      chrome.storage.local.set({ xpathConfig: config, geminiApiKey: apiKeyVal }, () => {
        setRoomStatus('🎉 Đã lưu cấu hình XPath & Gemini API Key!');
      });
    });
  }

  if (resetXpathConfigBtn) {
    resetXpathConfigBtn.addEventListener('click', () => {
      for (const field of xpathFields) {
        const el = document.getElementById(field);
        if (el) el.value = '';
      }
      chrome.storage.local.remove(['xpathConfig'], () => {
        setRoomStatus('🔄 Đã khôi phục mặc định XPath.');
      });
    });
  }

  function setRoomStatus(msg, isError = false) {
    if (roomExtractStatus) {
      roomExtractStatus.textContent = msg;
      roomExtractStatus.style.color = isError ? '#b42318' : '#7c305c';
    }
  }

  if (toggleXPathConfigBtn && xpathConfigBox) {
    toggleXPathConfigBtn.addEventListener('click', () => {
      xpathConfigBox.classList.toggle('is-hidden');
    });
  }

  if (extractRoomBtn) {
    extractRoomBtn.addEventListener('click', async () => {
      extractRoomBtn.disabled = true;
      await performAutoRoomExtract(true);
      extractRoomBtn.disabled = false;
    });
  }

  if (addRoomCommentBtn) {
    addRoomCommentBtn.addEventListener('click', async () => {
      const text = (roomCommentText?.value || '').trim();
      if (!text) {
        setRoomStatus('❌ Nội dung comment phòng rỗng, không thể thêm.', true);
        return;
      }

      const selectedFolderId = roomFolderSelect?.value || '';
      const folderIds = selectedFolderId ? [selectedFolderId] : [];
      const imagesToSave = currentExtractedRoomImage ? [currentExtractedRoomImage] : [];

      addRoomCommentBtn.disabled = true;
      try {
        const activeTab = await getActivePageTab();
        const roomUrl = activeTab?.url || '';
        const roomId = extractRoomIdFromUrl(roomUrl);

        const result = await addClipboardItem(text, imagesToSave, folderIds, { roomId, roomUrl });
        await renderClipboardList();
        await renderFolderSection();

        const folderObj = folders.find((f) => f.id === selectedFolderId);
        const folderName = folderObj ? folderObj.name : 'Chưa phân loại (Không chọn thư mục)';

        if (result && result.updated) {
          setRoomStatus(`🎉 Đã cập nhật lại thông tin phòng (Mã #${roomId || 'N/A'}) trong Clipboard! (Thư mục: ${folderName})`);
        } else {
          setRoomStatus(`🎉 Đã thêm phòng mới (Mã #${roomId || 'N/A'}) vào danh sách Clipboard! (Thư mục: ${folderName}${imagesToSave.length ? ' - Kèm 1 ảnh' : ''})`);
        }
      } catch (err) {
        setRoomStatus(`❌ Không thêm được comment: ${err.message}`, true);
      } finally {
        addRoomCommentBtn.disabled = false;
      }
    });
  }

  if (generateAiCaptionBtn) {
    generateAiCaptionBtn.addEventListener('click', async () => {
      const apiKeyInput = document.getElementById('geminiApiKeyInput');
      const apiKey = (apiKeyInput?.value || '').trim();

      if (!apiKey) {
        setRoomStatus('⚠️ Vui lòng nhập Gemini API Key trong mục "⚙ Cấu hình & AI" (tab GET API) trước khi dùng AI!', true);
        return;
      }

      generateAiCaptionBtn.disabled = true;
      setRoomStatus('🤖 AI (Gemini) đang phân tích phòng và tự động sinh bài viết + Hashtags động...');

      try {
        let roomData = lastExtractedRoomData;
        if (!roomData) {
          const xpathPrice = document.getElementById('xpathPrice')?.value || '';
          const xpathAddress = document.getElementById('xpathAddress')?.value || '';
          const xpathFurniture = document.getElementById('xpathFurniture')?.value || '';
          const xpathUtilities = document.getElementById('xpathUtilities')?.value || '';
          const xpathImage = document.getElementById('xpathImage')?.value || '';
          const xpathRoomType = document.getElementById('xpathRoomType')?.value || '';

          roomData = await extractRoomInfoFromActiveTab({
            price: xpathPrice,
            address: xpathAddress,
            furniture: xpathFurniture,
            utilities: xpathUtilities,
            image: xpathImage,
            roomType: xpathRoomType
          });
          if (roomData) lastExtractedRoomData = roomData;
        }

        if (!roomData) {
          setRoomStatus('❌ Không thấy dữ liệu phòng để AI viết bài. Hãy mở tab chi tiết phòng.', true);
          return;
        }

        const titleTemplate = captionTitlePattern?.value || '🏡 STUDIO FULL NỘI THẤT – {ADDRESS} ✨';
        const phone = (captionPhone?.value || contactPhone?.value || '').trim();
        const customHashtags = (captionHashtags?.value || '').trim();
        const currentCommentText = (document.getElementById('roomCommentText')?.value || '').trim();

        const captionStr = await formatRoomCaptionText(roomData, { titleTemplate, phone, customHashtags, currentCommentText }, apiKey, true);

        if (fbCaptionText) {
          fbCaptionText.value = captionStr;
        }

        if (fbCaptionResultBox) {
          fbCaptionResultBox.classList.remove('is-hidden');
          fbCaptionResultBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }

        setRoomStatus('✨ AI Gemini đã viết bài và sinh Hashtags động thành công!');
      } catch (err) {
        setRoomStatus(`❌ Lỗi AI viết bài: ${err.message || err}`, true);
      } finally {
        generateAiCaptionBtn.disabled = false;
      }
    });
  }

  if (generateCaptionBtn) {
    generateCaptionBtn.addEventListener('click', async () => {
      generateCaptionBtn.disabled = true;
      setRoomStatus('⚡ Đang tạo bài đăng mẫu...');

      try {
        let roomData = lastExtractedRoomData;
        if (!roomData) {
          const xpathPrice = document.getElementById('xpathPrice')?.value || '';
          const xpathAddress = document.getElementById('xpathAddress')?.value || '';
          const xpathFurniture = document.getElementById('xpathFurniture')?.value || '';
          const xpathUtilities = document.getElementById('xpathUtilities')?.value || '';
          const xpathImage = document.getElementById('xpathImage')?.value || '';
          const xpathRoomType = document.getElementById('xpathRoomType')?.value || '';

          roomData = await extractRoomInfoFromActiveTab({
            price: xpathPrice,
            address: xpathAddress,
            furniture: xpathFurniture,
            utilities: xpathUtilities,
            image: xpathImage,
            roomType: xpathRoomType
          });
          if (roomData) lastExtractedRoomData = roomData;
        }

        const titleTemplate = captionTitlePattern?.value || '🏡 STUDIO FULL NỘI THẤT – {ADDRESS} ✨';
        const phone = (captionPhone?.value || contactPhone?.value || '').trim();
        const customHashtags = (captionHashtags?.value || '').trim();
        const currentCommentText = (document.getElementById('roomCommentText')?.value || '').trim();
        const geminiApiKey = (geminiApiKeyInput?.value || '').trim();

        const captionStr = await formatRoomCaptionText(roomData, { titleTemplate, phone, customHashtags, currentCommentText }, geminiApiKey, false);

        if (fbCaptionText) {
          fbCaptionText.value = captionStr;
        }

        if (fbCaptionResultBox) {
          fbCaptionResultBox.classList.remove('is-hidden');
          fbCaptionResultBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }

        setRoomStatus('✨ Đã tạo bài đăng mẫu thành công!');
      } catch (err) {
        setRoomStatus(`❌ Lỗi tạo bài đăng: ${err.message || err}`, true);
      } finally {
        generateCaptionBtn.disabled = false;
      }
    });
  }

  if (copyCaptionBtn) {
    copyCaptionBtn.addEventListener('click', async () => {
      const text = (fbCaptionText?.value || '').trim();
      if (!text) {
        setRoomStatus('❌ Nội dung caption rỗng, không thể sao chép.', true);
        return;
      }

      try {
        await navigator.clipboard.writeText(text);
        setRoomStatus('🎉 Đã sao chép caption bài đăng Facebook vào bộ nhớ tạm!');
      } catch (err) {
        if (fbCaptionText) {
          fbCaptionText.select();
          document.execCommand('copy');
          setRoomStatus('🎉 Đã sao chép caption bài đăng Facebook vào bộ nhớ tạm!');
        } else {
          setRoomStatus(`❌ Không sao chép được: ${err.message}`, true);
        }
      }
    });
  }

  if (addCaptionToClipboardBtn) {
    addCaptionToClipboardBtn.addEventListener('click', async () => {
      const text = (fbCaptionText?.value || '').trim();
      if (!text) {
        setRoomStatus('❌ Nội dung caption rỗng, không thể thêm.', true);
        return;
      }

      const selectedFolderId = roomFolderSelect?.value || '';
      const folderIds = selectedFolderId ? [selectedFolderId] : [];
      const imagesToSave = currentExtractedRoomImage ? [currentExtractedRoomImage] : [];

      addCaptionToClipboardBtn.disabled = true;
      try {
        const activeTab = await getActivePageTab();
        const roomUrl = activeTab?.url || '';
        const roomId = extractRoomIdFromUrl(roomUrl);

        await addClipboardItem(text, imagesToSave, folderIds, { roomId, roomUrl });
        await renderClipboardList();
        await renderFolderSection();

        const folderObj = folders.find((f) => f.id === selectedFolderId);
        const folderName = folderObj ? folderObj.name : 'Chưa phân loại (Không chọn thư mục)';

        setRoomStatus(`🎉 Đã lưu bài đăng FB vào Clipboard Comment (Mã #${roomId || 'N/A'})! (Thư mục: ${folderName})`);
      } catch (err) {
        setRoomStatus(`❌ Không thêm được bài đăng: ${err.message}`, true);
      } finally {
        addCaptionToClipboardBtn.disabled = false;
      }
    });
  }

  // Trigger auto extract immediately on load
  performAutoRoomExtract(false);

  // Listen to tab changes to auto extract when user switches tab
  chrome.tabs.onActivated.addListener(async () => {
    const activeTab = await getActivePageTab();
    if (activeTab && isTyrahomeProductUrl(activeTab.url)) {
      if (autoExtractTimer) clearTimeout(autoExtractTimer);
      autoExtractTimer = setTimeout(() => performAutoRoomExtract(false), 500);
    }
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.active && isTyrahomeProductUrl(tab.url)) {
      if (autoExtractTimer) clearTimeout(autoExtractTimer);
      autoExtractTimer = setTimeout(() => performAutoRoomExtract(false), 500);
    }
  });
}
// #endregion

const STORAGE_KEY_FORM_DATA = 'formData';

function initializeApp() {
  if (isAppInitialized) return;
  isAppInitialized = true;

  loadFormData();
  initializeFormAutoSave();
  initializeImageUpload();
  initializeApiCheckMenu();
  initializeTabs();
  initializeSmartSkipMenu();
  initializeClipboardImagePicker();
  initializeClipboardMenu();
  initializeFoldersMenu();
  initializeRoomExtractorMenu();
}

function saveFormData() {
  const formData = {
    description: document.getElementById('description')?.value || '',
    fees: document.getElementById('fees')?.value || '',
    price: document.getElementById('price')?.value || '',
    amenities: document.getElementById('amenities')?.value || '',
    images: document.getElementById('images')?.value || '',
    contactPhone: document.getElementById('contactPhone')?.value || '',
    numPosts: document.getElementById('numPosts')?.value || '',
    targetPostUrl: document.getElementById('targetPostUrl')?.value || '',
    clipboardCommentsPerPost: document.getElementById('clipboardCommentsPerPost')?.value || '',
    clipboardCommentDelay: document.getElementById('clipboardCommentDelay')?.value || '',
    captionTitlePattern: document.getElementById('captionTitlePattern')?.value || '',
    captionPhone: document.getElementById('captionPhone')?.value || '',
    captionHashtags: document.getElementById('captionHashtags')?.value || ''
  };

  chrome.storage.local.set({ [STORAGE_KEY_FORM_DATA]: formData });
}

function loadFormData() {
  chrome.storage.local.get([STORAGE_KEY_FORM_DATA], (result) => {
    const formData = result[STORAGE_KEY_FORM_DATA];
    if (!formData) return;

    // Restore each field
    const fields = ['description', 'fees', 'price', 'amenities', 'images', 'contactPhone', 'numPosts', 'targetPostUrl', 'clipboardCommentsPerPost', 'clipboardCommentDelay', 'captionTitlePattern', 'captionPhone', 'captionHashtags'];
    for (const field of fields) {
      const el = document.getElementById(field);
      if (el && formData[field]) {
        el.value = formData[field];
      }
    }
  });
}

function initializeFormAutoSave() {
  const fields = ['description', 'fees', 'price', 'amenities', 'images', 'contactPhone', 'numPosts', 'targetPostUrl', 'clipboardCommentsPerPost', 'clipboardCommentDelay', 'captionTitlePattern', 'captionPhone', 'captionHashtags'];

  for (const field of fields) {
    const el = document.getElementById(field);
    if (el) {
      el.addEventListener('change', saveFormData);
      el.addEventListener('input', saveFormData);
    }
  }
}

// Removed initializeCommentModeTabs as Form Mode is disabled

function initializeAuthGate() {
  const activateBtn = document.getElementById('activateBtn');
  const passwordInput = getActivationPasswordInput();

  activateBtn?.addEventListener('click', () => {
    activateExtension().catch((error) => {
      setAuthStatus(`Không kích hoạt được: ${error.message}`, true);
    });
  });

  passwordInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      activateBtn?.click();
    }
  });
}

initializeAuthGate();
initializeExtensionLock();

// Listen to stopRun messages from the content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'stopRun') {
    finishRun(`Dừng batch: ${request.reason || 'người dùng hủy'}`);
  }
});
