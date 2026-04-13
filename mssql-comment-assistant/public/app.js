const state = {
  editingTemplateId: null,
  pendingImages: []
};

function qs(id) {
  return document.getElementById(id);
}

function setHealth(ok, text) {
  qs('healthDot').style.background = ok ? 'var(--success)' : 'var(--danger)';
  qs('healthDot').style.boxShadow = ok ? '0 0 0 6px rgba(52, 211, 153, 0.18)' : '0 0 0 6px rgba(251, 113, 133, 0.18)';
  qs('healthText').textContent = text;
}

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    throw new Error(data.message || `HTTP ${response.status}`);
  }
  return data.data;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

async function renderTemplatePreview(files) {
  const preview = qs('templatePreview');
  preview.innerHTML = '';
  for (const file of files) {
    const img = document.createElement('img');
    img.alt = file.name;
    img.src = await fileToDataUrl(file);
    preview.appendChild(img);
  }
}

function resetTemplateForm() {
  qs('templateId').value = '';
  qs('templateTitle').value = '';
  qs('templateBody').value = '';
  qs('templateUrl').value = '';
  qs('templateNotes').value = '';
  qs('templateImages').value = '';
  qs('templatePreview').innerHTML = '';
  state.pendingImages = [];
  state.editingTemplateId = null;
  qs('saveTemplateBtn').textContent = 'Lưu template';
}

function populateTemplateForm(template) {
  state.editingTemplateId = template.templateId;
  qs('templateId').value = template.templateId;
  qs('templateTitle').value = template.title || '';
  qs('templateBody').value = template.body || '';
  qs('templateUrl').value = template.targetPostUrl || '';
  qs('templateNotes').value = template.notes || '';
  qs('saveTemplateBtn').textContent = 'Cập nhật template';
}

function renderTemplates(items) {
  const list = qs('templateList');
  const select = qs('jobTemplateSelect');
  list.innerHTML = '';
  select.innerHTML = '<option value="">Chọn template</option>';

  if (!items.length) {
    list.innerHTML = '<div class="card"><div class="meta">Chưa có template nào.</div></div>';
    return;
  }

  for (const item of items) {
    const option = document.createElement('option');
    option.value = item.templateId;
    option.textContent = item.title;
    select.appendChild(option);

    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="card-head">
        <div>
          <h3>${item.title}</h3>
          <div class="meta">${escapeHtml(item.body)}</div>
        </div>
        <span class="badge">${item.imageCount || 0} ảnh</span>
      </div>
      <div class="meta" style="margin-top:10px;">${item.targetPostUrl ? `URL mặc định: ${escapeHtml(item.targetPostUrl)}<br>` : ''}${item.notes ? `Ghi chú: ${escapeHtml(item.notes)}<br>` : ''}Tạo lúc: ${new Date(item.createdAt).toLocaleString()}</div>
      <div class="actions" style="margin-top:12px;">
        <button data-action="edit" data-id="${item.templateId}">Sửa</button>
        <button class="secondary" data-action="duplicate" data-id="${item.templateId}">Xem</button>
        <button class="ghost" data-action="delete" data-id="${item.templateId}">Xóa</button>
      </div>
    `;
    list.appendChild(card);
  }

  list.querySelectorAll('button[data-action]').forEach((button) => {
    button.addEventListener('click', async () => {
      const action = button.dataset.action;
      const id = button.dataset.id;
      if (action === 'delete') {
        if (!confirm('Xóa template này?')) return;
        await fetch(`/api/templates/${id}`, { method: 'DELETE' });
        await refreshAll();
        return;
      }

      if (action === 'edit' || action === 'duplicate') {
        const template = await api(`/templates/${id}`, { method: 'GET', headers: {} });
        populateTemplateForm(template);
        state.pendingImages = [];
        qs('templateImages').value = '';
        qs('templatePreview').innerHTML = '';
        if (template.images?.length) {
          qs('templatePreview').innerHTML = template.images.map((img) => `<img src="/api/templates/${template.templateId}/images/${img.imageId}" alt="${escapeHtml(img.fileName)}">`).join('');
        }
      }
    });
  });
}

function renderJobs(items) {
  const list = qs('jobList');
  list.innerHTML = '';

  if (!items.length) {
    list.innerHTML = '<div class="card"><div class="meta">Chưa có job nào.</div></div>';
    return;
  }

  for (const item of items) {
    const statusNames = ['Pending', 'Ready', 'Processing', 'Done', 'Failed'];
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="card-head">
        <div>
          <h3>${escapeHtml(item.templateTitle)}</h3>
          <div class="meta">${escapeHtml(item.targetPostUrl)}</div>
        </div>
        <span class="badge">${statusNames[item.status] || item.status}</span>
      </div>
      <div class="meta" style="margin-top:10px;">${item.lastMessage ? escapeHtml(item.lastMessage) + '<br>' : ''}Tạo lúc: ${new Date(item.createdAt).toLocaleString()}</div>
    `;
    list.appendChild(card);
  }
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function refreshTemplates() {
  const templates = await api('/templates');
  renderTemplates(templates);
}

async function refreshJobs() {
  const jobs = await api('/jobs');
  renderJobs(jobs);
}

async function refreshAll() {
  await Promise.all([refreshTemplates(), refreshJobs()]);
}

async function bindEvents() {
  qs('templateImages').addEventListener('change', async (event) => {
    const files = Array.from(event.target.files || []);
    state.pendingImages = files;
    await renderTemplatePreview(files);
  });

  qs('clearTemplateImagesBtn').addEventListener('click', () => {
    state.pendingImages = [];
    qs('templateImages').value = '';
    qs('templatePreview').innerHTML = '';
  });

  qs('resetTemplateBtn').addEventListener('click', resetTemplateForm);

  qs('templateForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData();
    formData.append('title', qs('templateTitle').value.trim());
    formData.append('body', qs('templateBody').value.trim());
    formData.append('targetPostUrl', qs('templateUrl').value.trim());
    formData.append('notes', qs('templateNotes').value.trim());
    formData.append('isActive', 'true');
    if (state.editingTemplateId) {
      formData.append('replaceImages', 'true');
    }

    for (const file of state.pendingImages) {
      formData.append('images', file);
    }

    const response = await fetch(state.editingTemplateId ? `/api/templates/${state.editingTemplateId}` : '/api/templates', {
      method: state.editingTemplateId ? 'PUT' : 'POST',
      body: formData
    });

    const data = await response.json();
    if (!response.ok || data.ok === false) {
      throw new Error(data.message || 'Save failed');
    }

    resetTemplateForm();
    await refreshAll();
  });

  qs('jobForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const templateId = qs('jobTemplateSelect').value;
    const targetPostUrls = qs('jobUrls').value.trim();
    const scheduledAt = qs('jobSchedule').value;
    const response = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templateId, targetPostUrls, scheduledAt })
    });
    const data = await response.json();
    if (!response.ok || data.ok === false) {
      throw new Error(data.message || 'Create job failed');
    }

    qs('jobUrls').value = '';
    qs('jobSchedule').value = '';
    await refreshJobs();
  });

  qs('reloadBtn').addEventListener('click', refreshAll);
}

async function init() {
  try {
    await api('/health', { method: 'GET', headers: {} });
    setHealth(true, 'Server OK');
  } catch (error) {
    setHealth(false, error.message);
  }

  await bindEvents();
  await refreshAll();
}

init().catch((error) => {
  setHealth(false, error.message);
  console.error(error);
});
