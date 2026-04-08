let comments = [];
let currentIndex = 0;
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

    const hasUsableComposer = (response.availableCount || 0) > 0 || Boolean(response.externalComposerAvailable);
    const readiness = hasUsableComposer ? 'Sẵn sàng comment' : 'Đã nhận diện trang, nhưng chưa thấy ô comment khả dụng';
    const diagnostics = [
      `Trang: ${response.pageUrl || tabUrl}`,
      `Domain: ${domainLabel}`,
      `Content script: OK`,
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
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]?.id) {
      document.getElementById('status').textContent = 'Không tìm thấy tab Facebook đang mở.';
      return;
    }

    chrome.tabs.sendMessage(
      tabs[0].id,
      { action: 'fillNext', comment: comments[currentIndex], ignoreHistory },
      (response) => {
        if (chrome.runtime.lastError) {
          document.getElementById('status').textContent = 'Không thể kết nối với trang Facebook. Hãy reload trang và thử lại.';
          return;
        }

        if (!response) {
          document.getElementById('status').textContent = 'Không nhận được phản hồi từ tab Facebook.';
          document.getElementById('nextBtn').disabled = true;
          return;
        }

        if (response.status === 'HistoryBlocked') {
          if (!hasRetriedIgnoreHistory) {
            document.getElementById('status').textContent = 'Bỏ qua thông minh đang chặn hết bài hiện tại, thử điền lại bỏ qua lịch sử...';
            sendCurrentComment(true, true);
            return;
          }

          document.getElementById('status').textContent = 'Các bài hiện tại đã nằm trong lịch sử bỏ qua. Hãy vào tab BỎ QUA THÔNG MINH để đặt lại.';
          document.getElementById('nextBtn').disabled = true;
          return;
        }

        if (response.status === 'No more posts') {
          if ((response.totalCandidates || 0) === 0) {
            document.getElementById('status').textContent = 'Chưa thấy ô comment phù hợp trong vùng đang hiển thị. Hãy cuộn feed và mở ô bình luận rồi thử lại.';
          } else if (response.noComposerInViewport) {
            document.getElementById('status').textContent = `Đã thấy ${response.totalCandidates} post nhưng chưa có ô Bình luận dưới tên... khả dụng trong vùng hiện tại. Không tự cuộn thêm để tránh bỏ qua.`;
          } else if ((response.noComposerCount || 0) > 0) {
            document.getElementById('status').textContent = `Tìm thấy ${response.totalCandidates} post nhưng không mở được hộp comment (có thể là fanpage). Hãy cuộn và thử lại.`;
          } else {
            document.getElementById('status').textContent = 'Không còn post phù hợp để điền comment.';
          }
          document.getElementById('nextBtn').disabled = true;
          return;
        }

        if (response.status === 'SubmitFailed') {
          document.getElementById('status').textContent = 'Đã điền vào ô comment nhưng chưa bấm gửi thành công. Không bỏ qua post này, bạn bấm lại để thử tiếp.';
          document.getElementById('nextBtn').disabled = false;
          return;
        }

        if (response.status !== 'Filled') {
          document.getElementById('status').textContent = 'Không thể điền comment ở lần này.';
          document.getElementById('nextBtn').disabled = true;
          return;
        }

        document.getElementById('status').textContent = `Điền comment ${currentIndex + 1}/${comments.length}`;
      }
    );
  });
}

document.getElementById('startBtn').addEventListener('click', () => {
  const desc = document.getElementById('description').value.trim();
  const feesInput = document.getElementById('fees').value.trim();
  const price = document.getElementById('price').value.trim();
  const amenities = document.getElementById('amenities').value.trim();
  const images = document.getElementById('images').value.trim();
  const contactPhone = document.getElementById('contactPhone').value.trim();
  const numPosts = parseInt(document.getElementById('numPosts').value);

  const [serviceFeeRaw = '', parkingFeeRaw = '', electricityFeeRaw = ''] = feesInput.split(',').map((part) => part.trim());

  if (!desc || !numPosts) {
    document.getElementById('status').textContent = 'Cần nhập tối thiểu Mô tả và Số post.';
    return;
  }

  // Generate different comments for each post
  comments = [];
  for (let i = 1; i <= numPosts; i++) {
    const parts = [desc];
    if (serviceFeeRaw) parts.push(`Tiền dịch vụ: ${serviceFeeRaw}`);
    if (parkingFeeRaw) parts.push(`Tiền xe: ${parkingFeeRaw}`);
    if (electricityFeeRaw) parts.push(`Tiền điện: ${electricityFeeRaw}`);
    if (price) parts.push(`Giá: ${price}`);
    if (amenities) parts.push(`Tiện nghi: ${amenities}`);
    if (images) parts.push(`Hình ảnh: ${images}`);
    if (contactPhone) parts.push(`Liên hệ: ${contactPhone}`);
    comments.push(parts.join(' - '));
  }

  currentIndex = 0;
  document.getElementById('nextBtn').disabled = false;
  sendCurrentComment();
});

document.getElementById('nextBtn').addEventListener('click', () => {
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
    numPosts: document.getElementById('numPosts').value
  };

  chrome.storage.local.set({ [STORAGE_KEY_FORM_DATA]: formData });
}

function loadFormData() {
  chrome.storage.local.get([STORAGE_KEY_FORM_DATA], (result) => {
    const formData = result[STORAGE_KEY_FORM_DATA];
    if (!formData) return;

    // Restore each field
    const fields = ['description', 'fees', 'price', 'amenities', 'images', 'contactPhone', 'numPosts'];
    for (const field of fields) {
      const el = document.getElementById(field);
      if (el && formData[field]) {
        el.value = formData[field];
      }
    }
  });
}

function initializeFormAutoSave() {
  const fields = ['description', 'fees', 'price', 'amenities', 'images', 'contactPhone', 'numPosts'];

  for (const field of fields) {
    const el = document.getElementById(field);
    if (el) {
      el.addEventListener('change', saveFormData);
      el.addEventListener('input', saveFormData);
    }
  }
}

loadFormData();
initializeFormAutoSave();
initializeImageUpload();
initializeApiCheckMenu();
initializeTabs();
initializeSmartSkipMenu();