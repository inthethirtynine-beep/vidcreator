/* ============================================
   VidCreator — Main Application Logic
   ============================================ */

// ---- State ----
const state = {
  currentPage: 'home',
  currentVideoId: null,
  currentVideoInfo: null,
  selectedTemplateId: null,
  selectedTemplate: null,
  editingTemplate: null,
  sliceMode: 'auto',
  segments: [],
  renderJobs: [],
  manualTimecodes: [],
};

// ============================================
// NAVIGATION
// ============================================

function navigate(page) {
  state.currentPage = page;

  // Hide all pages
  document.querySelectorAll('.page-view').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));

  // Show target page
  const pageEl = document.getElementById(`page-${page}`);
  if (pageEl) pageEl.classList.add('active');

  const navBtn = document.querySelector(`.nav-btn[data-page="${page}"]`);
  if (navBtn) navBtn.classList.add('active');

  // Load page data
  if (page === 'templates') loadTemplatesList();
  if (page === 'render') loadRenderJobs();
  if (page === 'home') refreshTemplateSelectGrid();
}

// ============================================
// TOAST NOTIFICATIONS
// ============================================

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const icons = { success: "check-circle-fill", error: "x-circle-fill", info: "info-circle-fill", warning: "exclamation-triangle-fill" };

  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.innerHTML = `
    <span class="toast__icon">${uiIcon(icons[type] || icons.info)}</span>
    <span class="toast__message">${escapeHtml(message)}</span>
  `;

  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
  container.appendChild(toast);
  // Keep the stack short: the oldest message leaves when a fourth one arrives.
  const live = [...container.querySelectorAll('.toast:not(.toast--leaving)')];
  if (live.length > 3) dismissToast(live[0]);

  setTimeout(() => dismissToast(toast), type === 'error' ? 6000 : 3200);
}

function dismissToast(toast) {
  if (!toast.isConnected || toast.classList.contains('toast--leaving')) return;
  toast.classList.add('toast--leaving');
  setTimeout(() => toast.remove(), 220);
}

// ============================================
// MODAL
// ============================================

let confirmCallback = null;

function showConfirmModal(title, text, btnText, callback) {
  document.getElementById('confirm-modal-title').textContent = title;
  document.getElementById('confirm-modal-text').textContent = text;
  document.getElementById('confirm-modal-btn').textContent = btnText;
  document.getElementById('confirm-modal').classList.remove('hidden');
  confirmCallback = callback;
  requestAnimationFrame(() => document.getElementById('confirm-modal-btn').focus());
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !document.getElementById('confirm-modal').classList.contains('hidden')) {
    e.preventDefault();
    closeConfirmModal();
  }
  // Ctrl+S saves the open template instead of the browser saving the page.
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyS' && state.currentPage === 'templates' && state.editingTemplate) {
    e.preventDefault();
    saveCurrentTemplate();
  }
});

function closeConfirmModal() {
  document.getElementById('confirm-modal').classList.add('hidden');
  confirmCallback = null;
}

function confirmModalAction() {
  if (confirmCallback) confirmCallback();
  closeConfirmModal();
}

// ============================================
// WORKFLOW STEPS
// ============================================

function activateStep(stepNum) {
  const steps = document.querySelectorAll('.workflow__step');
  steps.forEach((step, i) => {
    step.classList.remove('active', 'completed');
    if (i + 1 < stepNum) step.classList.add('completed');
    if (i + 1 === stepNum) step.classList.add('active');
  });

  // Load templates for step 2
  if (stepNum === 2) refreshTemplateSelectGrid();
  // Preview slice for step 3
  if (stepNum === 3) updateSlicePreview();
}

// ============================================
// VIDEO UPLOAD
// ============================================

(function initUpload() {
  const zone = document.getElementById('upload-zone');
  const input = document.getElementById('video-input');

  zone.addEventListener('click', () => input.click());

  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('dragover');
  });

  zone.addEventListener('dragleave', () => {
    zone.classList.remove('dragover');
  });

  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) {
      uploadVideo(e.dataTransfer.files[0]);
    }
  });

  input.addEventListener('change', () => {
    if (input.files.length > 0) {
      uploadVideo(input.files[0]);
    }
  });
})();

async function uploadVideo(file) {
  const zone = document.getElementById('upload-zone');
  const progressArea = document.getElementById('upload-progress-area');
  const uploadBar = document.getElementById('upload-bar');
  const filenameEl = document.getElementById('upload-filename');
  const percentEl = document.getElementById('upload-percent');

  zone.style.display = 'none';
  progressArea.style.display = 'block';
  filenameEl.textContent = file.name;

  const formData = new FormData();
  formData.append('video', file);

  try {
    const xhr = new XMLHttpRequest();

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        const percent = Math.round((e.loaded / e.total) * 100);
        uploadBar.style.width = percent + '%';
        percentEl.textContent = percent + '%';
      }
    });

    const response = await new Promise((resolve, reject) => {
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(JSON.parse(xhr.responseText));
        } else {
          try {
            const err = JSON.parse(xhr.responseText);
            reject(new Error(err.error || 'Upload failed'));
          } catch {
            reject(new Error('Upload failed'));
          }
        }
      };
      xhr.onerror = () => reject(new Error('Network error'));
      xhr.open('POST', '/api/videos/upload');
      xhr.send(formData);
    });

    state.currentVideoId = response.id;
    state.currentVideoInfo = response.info;

    // Show video info
    showVideoInfo(response);
    showToast('Видео загружено!', 'success');
  } catch (err) {
    showToast('Ошибка загрузки: ' + err.message, 'error');
    zone.style.display = 'block';
    progressArea.style.display = 'none';
  }
}

// ============================================
// IMPORT MODES (FILE vs YOUTUBE)
// ============================================

let currentImportMode = 'file';
let ytPollInterval = null;

function setImportMode(mode) {
  currentImportMode = mode;
  const fileBtn = document.getElementById('import-tab-file');
  const ytBtn = document.getElementById('import-tab-yt');
  const filePanel = document.getElementById('import-file-panel');
  const ytPanel = document.getElementById('import-yt-panel');

  if (mode === 'youtube') {
    fileBtn.classList.remove('active');
    ytBtn.classList.add('active');
    filePanel.style.display = 'none';
    ytPanel.style.display = 'block';
    refreshYouTubeEngine();
    loadYouTubeAuth();
  } else {
    ytBtn.classList.remove('active');
    fileBtn.classList.add('active');
    ytPanel.style.display = 'none';
    filePanel.style.display = 'block';
  }
}

// ---- YouTube import (local yt-dlp) ----
let ytJobId = null, ytEnginePoll = null, ytRetryAfterAuth = false;

// ---- Signing in to YouTube (bot check behind VPN, 18+ videos) ----
let ytAuth = null;
async function loadYouTubeAuth() {
  try {
    const response = await fetch('/api/videos/youtube/auth');
    ytAuth = await response.json();
    if (!response.ok) throw new Error(ytAuth.error);
    renderYouTubeAuth();
  } catch (err) { showToast('Вход в YouTube: ' + err.message, 'error'); }
}
function renderYouTubeAuth() {
  const a = ytAuth; if (!a) return;
  const browserName = a.browsers.find(b => b.id === a.browser)?.name || a.browser;
  document.getElementById('yt-auth-summary').textContent = a.mode === 'file' ? (a.source === 'login' ? 'Вход выполнен' : 'Файл cookies.txt') : a.mode === 'browser' || a.mode === 'env' ? `Из браузера ${browserName}` : 'Без входа';
  renderYouTubeLogin();
  const options = [['none', null, 'Без входа'], ...a.browsers.map(b => ['browser', b.id, b.name]), ['file', null, 'Файл cookies.txt']];
  document.getElementById('yt-auth-options').replaceChildren(...options.map(([mode, browser, label]) => {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'yt-auth__option'; button.textContent = label;
    const active = mode === 'file' ? a.mode === 'file' : mode === 'browser' ? a.mode === 'browser' && a.browser === browser : a.mode === 'none';
    button.setAttribute('aria-pressed', String(active));
    button.disabled = a.mode === 'env';
    button.onclick = () => mode === 'file' && !a.cookiesFile ? showCookiesFilePanel() : chooseYouTubeAuth(mode, browser);
    return button;
  }));
  const panel = document.getElementById('yt-auth-file');
  panel.hidden = a.mode !== 'file' && !panel.dataset.open;
  document.getElementById('yt-auth-file-state').textContent = a.cookiesFile ? `Загружен ${new Date(a.cookiesFile.updatedAt).toLocaleString('ru')}` : '';
}
// ---- Google account (sidebar card): VidCreator opens its own sign-in window and keeps the session ----
let ytLoginPoll = null;
function renderYouTubeLogin() {
  const login = ytAuth?.login; if (!login) return;
  const card = document.getElementById('account-card'), avatar = document.getElementById('account-avatar');
  const name = document.getElementById('account-name'), detail = document.getElementById('account-detail'), action = document.getElementById('account-action');
  const waiting = login.state === 'waiting', account = login.profile ? login.account : null;
  card.classList.toggle('signed-in', !!login.profile);
  card.classList.toggle('waiting', waiting);
  if (account?.photo) {
    const img = document.createElement('img'); img.src = account.photo; img.alt = ''; img.referrerPolicy = 'no-referrer';
    avatar.replaceChildren(img);
  } else if (login.profile) {
    avatar.textContent = (account?.name || account?.email || 'G').trim().charAt(0).toUpperCase();
  } else avatar.innerHTML = uiIcon('lock-fill');
  name.textContent = waiting ? 'Вход в аккаунт…' : login.profile ? (account?.name || 'Аккаунт Google') : 'Аккаунт Google';
  detail.textContent = waiting ? (login.message || 'Войди в открывшемся окне') : login.state === 'error' ? login.message : login.profile ? (account?.email || 'Подключён') : 'Не подключён';
  if (!login.browsers.length && !login.profile) detail.textContent = 'Нужен Edge или Chrome';
  detail.title = detail.textContent;
  detail.classList.toggle('error', login.state === 'error' && !waiting);
  action.textContent = waiting ? 'Отменить' : login.profile ? 'Выйти' : 'Войти в аккаунт';
  action.disabled = !login.browsers.length && !login.profile;
  const pointer = document.getElementById('yt-login-state');
  if (pointer) pointer.textContent = login.profile
    ? `Вход выполнен: ${account?.email || 'аккаунт Google'}. Обновляется сам, выйти можно в карточке слева внизу.`
    : 'Вход через аккаунт Google — в карточке слева внизу. Войди один раз, дальше вход обновляется сам.';
  clearTimeout(ytLoginPoll); ytLoginPoll = null;
  if (waiting) ytLoginPoll = setTimeout(async () => {
    await loadYouTubeAuth();
    if (ytAuth?.login.state === 'saved' && ytAuth.source === 'login') { showToast('Аккаунт Google подключён', 'success'); retryYouTubeAfterAuth(); }
  }, 2000);
}
async function youtubeLoginAction(url, method = 'POST', body = {}) {
  const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  ytAuth = data; renderYouTubeAuth();
}
// One button: sign in, cancel a sign-in in progress, or sign out.
async function accountAction() {
  const login = ytAuth?.login;
  try {
    if (login?.state === 'waiting') return await youtubeLoginAction('/api/videos/youtube/login/cancel');
    if (login?.profile) return showConfirmModal('Выйти из аккаунта Google?', 'Сохранённый вход будет удалён с этого компьютера. Для видео, где YouTube просит подтверждение, нужно будет войти снова.', 'Выйти', async () => {
      try { await youtubeLoginAction('/api/videos/youtube/login', 'DELETE'); showToast('Вы вышли из аккаунта', 'info'); } catch (err) { showToast(err.message, 'error'); }
    });
    await youtubeLoginAction('/api/videos/youtube/login/start', 'POST', {});
  } catch (err) { showToast(err.message, 'error'); }
}
function focusAccountCard() {
  const card = document.getElementById('account-card');
  card.classList.remove('attention'); void card.offsetWidth; card.classList.add('attention');
  setTimeout(() => card.classList.remove('attention'), 2400);
}

function showCookiesFilePanel() {
  const panel = document.getElementById('yt-auth-file');
  panel.dataset.open = '1'; panel.hidden = false;
}
async function chooseYouTubeAuth(mode, browser = null) {
  try {
    const response = await fetch('/api/videos/youtube/auth', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode, browser }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    ytAuth = data;
    if (mode !== 'file') delete document.getElementById('yt-auth-file').dataset.open;
    renderYouTubeAuth();
    retryYouTubeAfterAuth();
  } catch (err) { showToast(err.message, 'error'); }
}
async function uploadYouTubeCookies(file) {
  if (!file) return;
  try {
    if (file.size > 2 * 1024 * 1024) throw new Error('Файл cookies слишком большой — экспортируй cookies только для youtube.com');
    const response = await fetch('/api/videos/youtube/auth/cookies', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: await file.text() }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    ytAuth = data; renderYouTubeAuth();
    showToast('Вход в YouTube сохранён', 'success');
    retryYouTubeAfterAuth();
  } catch (err) { showToast(err.message, 'error'); }
}
// After the user fixes sign-in, repeat the download that hit the bot check.
function retryYouTubeAfterAuth() {
  if (!ytRetryAfterAuth || ytJobId || !document.getElementById('yt-url-input').value.trim()) return;
  ytRetryAfterAuth = false;
  startYouTubeDownload();
}

async function refreshYouTubeEngine() {
  const label = document.getElementById('yt-engine-status');
  try {
    const engine = await (await fetch('/api/videos/youtube/engine')).json();
    const installing = engine.installation?.status === 'processing';
    const failed = engine.installation?.status === 'error';
    document.getElementById('yt-engine-setup').hidden = engine.ready && !installing;
    document.getElementById('yt-engine-update').hidden = !engine.ready || installing;
    document.getElementById('yt-engine-version').textContent = engine.version ? `yt-dlp ${engine.version}` : '';
    document.getElementById('yt-download-btn').disabled = !engine.ready || installing || !!ytJobId;
    const installBtn = document.getElementById('yt-engine-install');
    installBtn.disabled = installing;
    label.classList.toggle('ready', engine.ready && !installing);
    label.textContent = installing
      ? `${engine.installation.phase || 'Установка'}${engine.installation.progress != null ? ` · ${engine.installation.progress}%` : ''}`
      : engine.ready ? 'Загрузчик готов' : 'Нужна установка';
    if (failed && ytEnginePoll) showToast('yt-dlp: ' + engine.installation.error, 'error');
    clearTimeout(ytEnginePoll); ytEnginePoll = null;
    if (installing) ytEnginePoll = setTimeout(refreshYouTubeEngine, 800);
    else if (engine.installation?.status === 'completed' && installBtn.dataset.waiting) { showToast('yt-dlp установлен — можно скачивать', 'success'); delete installBtn.dataset.waiting; }
    return engine;
  } catch {
    label.textContent = 'Сервер недоступен';
    return null;
  }
}

async function installYouTubeEngine(force = false) {
  try {
    const response = await fetch('/api/videos/youtube/engine/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ force }) });
    if (!response.ok) throw new Error((await response.json()).error);
    document.getElementById('yt-engine-install').dataset.waiting = '1';
    ytEnginePoll = setTimeout(refreshYouTubeEngine, 300);
  } catch (err) { showToast('Не удалось начать установку: ' + err.message, 'error'); }
}

const formatSpeed = bytes => bytes ? `${(bytes / 1048576).toFixed(1).replace('.', ',')} МБ/с` : '';
const formatEta = seconds => seconds == null ? '' : `осталось ${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;

function resetYouTubeForm() {
  if (ytPollInterval) clearInterval(ytPollInterval);
  ytPollInterval = null; ytJobId = null;
  const button = document.getElementById('yt-download-btn');
  button.disabled = false;
  button.innerHTML = uiIcon("cloud-arrow-down-fill") + ' Скачать';
}

async function startYouTubeDownload() {
  const urlInput = document.getElementById('yt-url-input');
  const downloadBtn = document.getElementById('yt-download-btn');
  const progressArea = document.getElementById('yt-progress-area');
  const progressBar = document.getElementById('yt-progress-bar');
  const progressTitle = document.getElementById('yt-progress-title-text');
  const progressPercent = document.getElementById('yt-progress-percent');
  const progressStatus = document.getElementById('yt-progress-status-text');

  const url = (urlInput.value || '').trim();
  if (!url) {
    showToast('Вставь ссылку на видео YouTube', 'warning');
    urlInput.focus();
    return;
  }
  if (ytJobId) return;

  downloadBtn.disabled = true;
  downloadBtn.innerHTML = uiIcon("clock-fill") + ' Скачивание…';
  progressArea.style.display = 'block';
  progressBar.style.width = '2%';
  progressTitle.textContent = 'Видео с YouTube';
  progressPercent.textContent = '0%';
  progressStatus.textContent = 'Получение информации о видео…';

  try {
    const startRes = await fetch('/api/videos/youtube/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, format: document.getElementById('yt-format-select').value || '1080' }),
    });
    const startData = await startRes.json();
    if (!startRes.ok) throw new Error(startData.error || 'Не удалось начать загрузку');
    ytJobId = startData.jobId;

    ytPollInterval = setInterval(async () => {
      try {
        const pollRes = await fetch(`/api/videos/youtube/status/${ytJobId}`);
        const job = await pollRes.json();
        if (!pollRes.ok) throw new Error(job.error || 'Ошибка проверки статуса');

        if (job.title) progressTitle.textContent = job.title;
        progressBar.style.width = `${Math.max(2, job.percent || 0)}%`;
        progressPercent.textContent = `${job.percent || 0}%`;
        progressStatus.textContent = [job.stage, formatSpeed(job.speed), job.status === 'downloading' ? formatEta(job.eta) : ''].filter(Boolean).join(' · ');

        if (job.status === 'completed' && job.video) {
          resetYouTubeForm();
          progressArea.style.display = 'none';
          urlInput.value = '';
          state.currentVideoId = job.video.id;
          state.currentVideoInfo = job.video.info;
          const library = document.getElementById('source-library');
          if (library) { library.add(new Option(`${job.video.originalName} · ${formatTime(job.video.info.duration)}`, job.video.id), 1); library.style.display = 'block'; }
          showVideoInfo(job.video);
          showToast('Видео с YouTube скачано и добавлено в библиотеку', 'success');
        } else if (job.status === 'failed') {
          resetYouTubeForm();
          progressStatus.textContent = job.error || 'Не удалось скачать видео';
          if (job.needsAuth) {
            // Open the sign-in block right where it is needed; choosing a method repeats the download.
            ytRetryAfterAuth = true;
            const auth = document.getElementById('yt-auth');
            auth.open = true; auth.classList.add('attention');
            // Not signed in yet: point at the account card in the sidebar.
            loadYouTubeAuth().then(() => { if (!ytAuth?.login?.profile) { focusAccountCard(); showToast('YouTube просит войти. Нажми «Войти в аккаунт» слева внизу — загрузка повторится сама.', 'info'); } });
            auth.scrollIntoView({ behavior: 'smooth', block: 'center' });
          } else {
            showToast(job.error || 'Не удалось скачать видео', 'error');
          }
        } else if (job.status === 'cancelled') {
          resetYouTubeForm();
          progressArea.style.display = 'none';
        }
      } catch (err) {
        resetYouTubeForm();
        progressStatus.textContent = err.message;
        showToast(err.message, 'error');
      }
    }, 1000);
  } catch (err) {
    resetYouTubeForm();
    progressArea.style.display = 'none';
    showToast(err.message, 'error');
    refreshYouTubeEngine();
  }
}

async function cancelYouTubeDownload() {
  if (!ytJobId) { document.getElementById('yt-progress-area').style.display = 'none'; return; }
  try { await fetch(`/api/videos/youtube/cancel/${ytJobId}`, { method: 'POST' }); } catch {}
  resetYouTubeForm();
  document.getElementById('yt-progress-area').style.display = 'none';
  showToast('Загрузка отменена', 'info');
}

function showVideoInfo(video) {
  const infoArea = document.getElementById('video-info-area');
  const progressArea = document.getElementById('upload-progress-area');
  const uploadArea = document.getElementById('upload-area');
  const switcher = document.querySelector('.import-switcher');

  if (uploadArea) uploadArea.style.display = 'none';
  if (switcher) switcher.style.display = 'none';
  if (progressArea) progressArea.style.display = 'none';
  infoArea.style.display = 'block';

  document.getElementById('video-thumb').src = video.thumbnailUrl;
  document.getElementById('video-name').textContent = video.originalName;
  document.getElementById('video-duration').textContent = formatTime(video.info.duration);
  document.getElementById('video-resolution').textContent = `${video.info.width}×${video.info.height}`;
  document.getElementById('video-codec').textContent = video.info.codec;
  document.getElementById('video-fps').textContent = Math.round(video.info.fps);
}

function removeVideo() {
  showConfirmModal(
    'Удалить видео?',
    'Файл исчезнет из библиотеки и с диска. Чтобы просто взять другое видео, нажми «Другое видео».',
    'Удалить',
    async () => {
      if (state.currentVideoId) {
        try {
          const id = state.currentVideoId;
          const response = await fetch(`/api/videos/${id}`, { method: 'DELETE' });
          if (!response.ok) throw new Error((await response.json()).error);
          const option = document.querySelector(`#source-library option[value="${id}"]`);
          if (option) option.remove();
        } catch (e) { showToast(e.message,'error'); return; }
      }
      resetSourceView();
      showToast('Видео удалено', 'info');
    }
  );
}

// Back to the import screen without deleting anything; the file stays in the library.
function changeSource() {
  resetSourceView();
  const library = document.getElementById('source-library');
  if (library) library.value = '';
}

function resetSourceView() {
  state.currentVideoId = null;
  state.currentVideoInfo = null;
  if (typeof resetStudioSource === 'function') resetStudioSource();
  state.currentVideoInfo = null;

  document.getElementById('video-info-area').style.display = 'none';
  document.getElementById('upload-progress-area').style.display = 'none';
  document.getElementById('upload-area').style.display = 'block';
  const switcher = document.querySelector('.import-switcher');
  if (switcher) switcher.style.display = 'flex';
  document.getElementById('upload-zone').style.display = 'block';
  document.getElementById('video-input').value = '';
  const ytUrl = document.getElementById('yt-url-input');
  if (ytUrl) ytUrl.value = '';
  const ytProg = document.getElementById('yt-progress-area');
  if (ytProg) ytProg.style.display = 'none';

  // Reset workflow
  activateStep(1);
}

// ============================================
// TEMPLATES LIST
// ============================================

async function loadTemplatesList() {
  try {
    const response = await fetch('/api/templates');
    const templates = await response.json();
    renderTemplatesGrid(templates, 'templates-grid', true);
  } catch (err) {
    showToast('Ошибка загрузки шаблонов: ' + err.message, 'error');
  }
}

function renderTemplatesGrid(templates, containerId, showActions = false) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';

  // "Create new" card
  if (showActions) {
    const createCard = document.createElement('div');
    createCard.className = 'card card--create';
    createCard.onclick = () => createNewTemplate();
    createCard.innerHTML = `
      <div class="card--create__icon">${uiIcon("plus-circle-fill")}</div>
      <div class="card--create__label">Создать шаблон</div>
    `;
    container.appendChild(createCard);
  }

  templates.forEach(t => {
    const card = document.createElement('div');
    card.className = 'card template-card';
    card.innerHTML = `
      <div class="template-card__header">
        <div class="template-card__name">${escapeHtml(t.name)}</div>
        <span class="template-card__ratio">${t.aspectRatio || '9:16'}</span>
      </div>
      <div class="template-card__description">${escapeHtml(t.description || 'Без описания')}</div>
      <div class="template-card__footer">
        <span class="template-card__date">${new Date(t.createdAt).toLocaleDateString('ru')}</span>
        <div class="template-card__actions">
          ${showActions ? `
            <button class="btn btn--ghost btn--sm" onclick="event.stopPropagation(); editTemplate('${t.id}')" title="Редактировать">${uiIcon("pencil-fill")}</button>
            <button class="btn btn--ghost btn--sm" onclick="event.stopPropagation(); duplicateTemplate('${t.id}')" title="Дублировать">${uiIcon("stickies-fill")}</button>
            <button class="btn btn--danger btn--sm" onclick="event.stopPropagation(); deleteTemplate('${t.id}')" title="Удалить">${uiIcon("trash3-fill")}</button>
          ` : `
            <button class="btn btn--primary btn--sm" onclick="event.stopPropagation(); selectTemplate('${t.id}')">Выбрать</button>
          `}
        </div>
      </div>
    `;

    if (showActions) {
      card.onclick = () => editTemplate(t.id);
    } else {
      card.onclick = () => selectTemplate(t.id);
    }

    container.appendChild(card);
  });

  if (templates.length === 0 && !showActions) {
    container.innerHTML = `
      <div class="empty-state" style="grid-column: 1/-1;">
        <div class="empty-state__icon">${uiIcon("grid-3x3-gap-fill")}</div>
        <div class="empty-state__title">Нет шаблонов</div>
        <div class="empty-state__text">Создай первый шаблон во вкладке "Шаблоны"</div>
        <button class="btn btn--primary" style="margin-top: var(--space-md);" onclick="navigate('templates')">Создать шаблон</button>
      </div>
    `;
  }
}

async function refreshTemplateSelectGrid() {
  try {
    const response = await fetch('/api/templates');
    const templates = await response.json();
    renderTemplatesGrid(templates, 'template-select-grid', false);
  } catch (err) {
    console.error('Error loading templates:', err);
  }
}

// ============================================
// TEMPLATE SELECT (for workflow)
// ============================================

async function selectTemplate(id) {
  try {
    const response = await fetch(`/api/templates/${id}`);
    const template = await response.json();

    state.selectedTemplateId = id;
    state.selectedTemplate = template;

    document.getElementById('selected-template-name').textContent = template.name;
    document.getElementById('selected-template-desc').textContent = template.description || 'Без описания';
    document.getElementById('selected-template-info').style.display = 'block';
    document.getElementById('template-select-area').style.display = 'none';

    if (!state.restoringSession) showToast(`Шаблон «${template.name}» выбран`, 'success');
  } catch (err) {
    showToast('Ошибка: ' + err.message, 'error');
  }
}

function deselectTemplate() {
  state.selectedTemplateId = null;
  state.selectedTemplate = null;

  document.getElementById('selected-template-info').style.display = 'none';
  document.getElementById('template-select-area').style.display = 'block';
  refreshTemplateSelectGrid();
}

// ============================================
// TEMPLATE EDITOR
// ============================================

async function createNewTemplate() {
  try {
    const response = await fetch('/api/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Новый шаблон' }),
    });
    const template = await response.json();
    openTemplateEditor(template);
    // A new template stays a draft until it is saved; leaving without saving removes it.
    state.editingTemplateIsNew = true;
  } catch (err) {
    showToast('Ошибка: ' + err.message, 'error');
  }
}

async function editTemplate(id) {
  try {
    const response = await fetch(`/api/templates/${id}`);
    const template = await response.json();
    openTemplateEditor(template);
  } catch (err) {
    showToast('Ошибка: ' + err.message, 'error');
  }
}

function openTemplateEditor(template) {
  state.editingTemplate = { ...template };
  state.editingTemplateIsNew = false;
  state.templateDirty = false;

  document.getElementById('templates-list-view').style.display = 'none';
  document.getElementById('template-editor-view').style.display = 'block';

  // Populate fields
  document.getElementById('editor-template-name').value = template.name;

  // Output
  document.getElementById('editor-aspect').value = template.output?.aspectRatio || '9:16';
  document.getElementById('editor-preset').value = template.output?.preset || 'medium';
  document.getElementById('editor-crf').value = template.output?.crf || 23;
  document.getElementById('editor-crf-value').textContent = template.output?.crf || 23;

  // Crop
  document.getElementById('editor-crop-x').value = template.crop?.x || 'iw/2-ow/2';
  document.getElementById('editor-crop-y').value = template.crop?.y || '0';

  // Color
  document.getElementById('editor-brightness').value = template.colorCorrection?.brightness || 0;
  document.getElementById('editor-brightness-value').textContent = template.colorCorrection?.brightness || 0;
  document.getElementById('editor-contrast').value = template.colorCorrection?.contrast || 1;
  document.getElementById('editor-contrast-value').textContent = template.colorCorrection?.contrast || 1;
  document.getElementById('editor-saturation').value = template.colorCorrection?.saturation || 1;
  document.getElementById('editor-saturation-value').textContent = template.colorCorrection?.saturation || 1;

  // Watermark
  document.getElementById('editor-wm-enabled').checked = template.watermark?.enabled || false;
  document.getElementById('editor-wm-path').value = template.watermark?.path || '';
  document.getElementById('editor-wm-opacity').value = template.watermark?.opacity || 0.7;
  document.getElementById('editor-wm-opacity-value').textContent = template.watermark?.opacity || 0.7;

  // Transitions
  document.getElementById('editor-fade-in').value = template.transitions?.fadeIn || 0;
  document.getElementById('editor-fade-in-value').textContent = template.transitions?.fadeIn || 0;
  document.getElementById('editor-fade-out').value = template.transitions?.fadeOut || 0;
  document.getElementById('editor-fade-out-value').textContent = template.transitions?.fadeOut || 0;

  // Audio
  document.getElementById('editor-volume').value = template.audio?.volume ?? 1;
  document.getElementById('editor-volume-value').textContent = template.audio?.volume ?? 1;
  document.getElementById('editor-audio-fade-in').value = template.audio?.fadeIn || 0;
  document.getElementById('editor-audio-fade-in-value').textContent = template.audio?.fadeIn || 0;
  document.getElementById('editor-audio-fade-out').value = template.audio?.fadeOut || 0;
  document.getElementById('editor-audio-fade-out-value').textContent = template.audio?.fadeOut || 0;

  // Text overlays
  renderTextOverlays(template.textOverlays || []);

  // Update preview
  updatePreviewInfo();
}

function closeTemplateEditor(force = false) {
  if (!force && state.editingTemplate && state.templateDirty) {
    showConfirmModal('Выйти без сохранения?', 'Изменения в шаблоне пропадут.', 'Выйти', () => closeTemplateEditor(true));
    return;
  }
  if (state.editingTemplate && state.editingTemplateIsNew) {
    fetch(`/api/templates/${state.editingTemplate.id}`, { method: 'DELETE' }).catch(() => {});
  }
  state.editingTemplateIsNew = false;
  state.templateDirty = false;
  document.getElementById('templates-list-view').style.display = 'block';
  document.getElementById('template-editor-view').style.display = 'none';
  state.editingTemplate = null;
  loadTemplatesList();
}

function onTemplatePropChange() {
  if (!state.editingTemplate) return;
  state.templateDirty = true;

  // Collect all values
  state.editingTemplate.name = document.getElementById('editor-template-name').value;

  // Output
  state.editingTemplate.output = state.editingTemplate.output || {};
  state.editingTemplate.output.aspectRatio = document.getElementById('editor-aspect').value;
  state.editingTemplate.output.preset = document.getElementById('editor-preset').value;
  state.editingTemplate.output.crf = parseInt(document.getElementById('editor-crf').value);

  // Update aspect-dependent dimensions
  const aspectMap = {
    '9:16': { width: 1080, height: 1920 },
    '16:9': { width: 1920, height: 1080 },
    '1:1': { width: 1080, height: 1080 },
    '4:5': { width: 1080, height: 1350 },
  };
  const dims = aspectMap[state.editingTemplate.output.aspectRatio] || aspectMap['9:16'];
  state.editingTemplate.output.width = dims.width;
  state.editingTemplate.output.height = dims.height;

  // Crop
  state.editingTemplate.crop = {
    x: document.getElementById('editor-crop-x').value,
    y: document.getElementById('editor-crop-y').value,
    width: `min(iw,ih*${dims.width}/${dims.height})`,
    height: `min(ih,iw*${dims.height}/${dims.width})`,
  };

  // Color
  state.editingTemplate.colorCorrection = {
    brightness: parseFloat(document.getElementById('editor-brightness').value),
    contrast: parseFloat(document.getElementById('editor-contrast').value),
    saturation: parseFloat(document.getElementById('editor-saturation').value),
  };

  // Watermark
  state.editingTemplate.watermark = {
    enabled: document.getElementById('editor-wm-enabled').checked,
    path: document.getElementById('editor-wm-path').value,
    opacity: parseFloat(document.getElementById('editor-wm-opacity').value),
    x: state.editingTemplate.watermark?.x || 'W-w-20',
    y: state.editingTemplate.watermark?.y || '20',
  };

  // Transitions
  state.editingTemplate.transitions = {
    fadeIn: parseFloat(document.getElementById('editor-fade-in').value),
    fadeOut: parseFloat(document.getElementById('editor-fade-out').value),
  };

  // Audio
  state.editingTemplate.audio = {
    volume: parseFloat(document.getElementById('editor-volume').value),
    fadeIn: parseFloat(document.getElementById('editor-audio-fade-in').value),
    fadeOut: parseFloat(document.getElementById('editor-audio-fade-out').value),
  };

  // Update range display values
  updateRangeDisplays();
  updatePreviewInfo();
}

function updateRangeDisplays() {
  const ranges = [
    ['editor-crf', 'editor-crf-value'],
    ['editor-brightness', 'editor-brightness-value'],
    ['editor-contrast', 'editor-contrast-value'],
    ['editor-saturation', 'editor-saturation-value'],
    ['editor-wm-opacity', 'editor-wm-opacity-value'],
    ['editor-fade-in', 'editor-fade-in-value'],
    ['editor-fade-out', 'editor-fade-out-value'],
    ['editor-volume', 'editor-volume-value'],
    ['editor-audio-fade-in', 'editor-audio-fade-in-value'],
    ['editor-audio-fade-out', 'editor-audio-fade-out-value'],
  ];

  ranges.forEach(([inputId, displayId]) => {
    const input = document.getElementById(inputId);
    const display = document.getElementById(displayId);
    if (input && display) display.textContent = input.value;
  });
}

function setPresetDuration(sec) {
  const input = document.getElementById('segment-duration');
  if (input) {
    input.value = sec;
  }
  document.querySelectorAll('.preset-chips .chip-btn').forEach(btn => {
    btn.classList.remove('active');
    if (btn.textContent.includes(`${sec} `) || btn.textContent.includes(`${sec / 60} мин`)) {
      btn.classList.add('active');
    }
  });
  updateSlicePreview();
}

function toggleGridOverlay() {
  const grid = document.getElementById('preview-grid');
  const btn = document.getElementById('grid-toggle-btn');
  if (!grid) return;
  const isHidden = grid.style.display === 'none';
  grid.style.display = isHidden ? 'grid' : 'none';
  if (btn) btn.classList.toggle('active', isHidden);
}

function onAspectChange() {
  onTemplatePropChange();
  updatePreviewInfo();
}

function updatePreviewInfo() {
  if (!state.editingTemplate) return;
  const t = state.editingTemplate;

  const aspect = t.output?.aspectRatio || '9:16';
  const tagEl = document.getElementById('preview-aspect-tag');
  if (tagEl) tagEl.textContent = aspect;

  document.getElementById('preview-aspect').textContent = aspect;
  document.getElementById('preview-resolution').textContent =
    `${t.output?.width || 1080}×${t.output?.height || 1920}`;

  // Update preview frame dimensions
  const frame = document.getElementById('template-preview-frame');
  const aspectMap = {
    '9:16': { w: 270, h: 480 },
    '16:9': { w: 480, h: 270 },
    '1:1': { w: 340, h: 340 },
    '4:5': { w: 320, h: 400 },
  };
  const size = aspectMap[aspect] || aspectMap['9:16'];
  if (frame) {
    frame.style.width = size.w + 'px';
    frame.style.height = size.h + 'px';
  }

  // Live media preview (if current video or thumbnail exists)
  const mediaContainer = document.getElementById('preview-media');
  if (mediaContainer) {
    const thumbImg = document.getElementById('video-thumb');
    if (thumbImg && thumbImg.getAttribute('src')) {
      mediaContainer.innerHTML = `<img src="${thumbImg.src}" class="preview-frame__img" alt="Превью" style="width:100%; height:100%; object-fit:cover;">`;
    }
    // Apply live color correction filter preview
    const b = (t.colorCorrection?.brightness || 0) * 50 + 100;
    const c = (t.colorCorrection?.contrast || 1) * 100;
    const s = (t.colorCorrection?.saturation || 1) * 100;
    mediaContainer.style.filter = `brightness(${b}%) contrast(${c}%) saturate(${s}%)`;
  }

  // Live text overlays rendering
  const textLayer = document.getElementById('preview-text-layer');
  if (textLayer) {
    textLayer.innerHTML = '';
    const texts = t.textOverlays || [];
    texts.forEach((txt, idx) => {
      if (!txt.content) return;
      const el = document.createElement('div');
      el.className = 'preview-rendered-text';
      el.textContent = txt.content;
      el.style.color = txt.fontColor || '#ffffff';
      
      const scale = size.w / (t.output?.width || 1080);
      const scaledSize = Math.max(12, Math.round((txt.fontSize || 48) * scale));
      el.style.fontSize = `${scaledSize}px`;

      const yVal = parseFloat(txt.y);
      if (!isNaN(yVal)) {
        el.style.top = `${Math.round(yVal * scale)}px`;
        el.style.left = '50%';
      } else {
        el.style.top = `${(idx + 1) * 25}%`;
        el.style.left = '50%';
      }
      textLayer.appendChild(el);
    });
  }

  // Live Watermark preview
  const wmLayer = document.getElementById('preview-watermark-layer');
  if (wmLayer) {
    wmLayer.style.display = t.watermark?.enabled ? 'block' : 'none';
    wmLayer.style.opacity = t.watermark?.opacity ?? 0.7;
  }
}

async function saveCurrentTemplate() {
  if (!state.editingTemplate) return;

  // Collect text overlays
  state.editingTemplate.textOverlays = collectTextOverlays();

  try {
    const response = await fetch(`/api/templates/${state.editingTemplate.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state.editingTemplate),
    });

    if (!response.ok) throw new Error('Failed to save');
    state.templateDirty = false;
    state.editingTemplateIsNew = false;
    if (state.selectedTemplateId === state.editingTemplate.id) {
      state.selectedTemplate = structuredClone(state.editingTemplate);
      document.getElementById('selected-template-name').textContent = state.editingTemplate.name;
      if (typeof syncStudioPreview === 'function') syncStudioPreview();
    }
    showToast('Шаблон сохранён!', 'success');
  } catch (err) {
    showToast('Ошибка сохранения: ' + err.message, 'error');
  }
}

async function duplicateTemplate(id) {
  try {
    await fetch(`/api/templates/${id}/duplicate`, { method: 'POST' });
    showToast('Шаблон дублирован', 'success');
    loadTemplatesList();
  } catch (err) {
    showToast('Ошибка: ' + err.message, 'error');
  }
}

function deleteTemplate(id, name = 'этот шаблон') {
  showConfirmModal(
    'Удалить шаблон?',
    `Шаблон "${name}" будет удалён навсегда.`,
    'Удалить',
    async () => {
      try {
        await fetch(`/api/templates/${id}`, { method: 'DELETE' });
        showToast('Шаблон удалён', 'info');
        loadTemplatesList();
      } catch (err) {
        showToast('Ошибка: ' + err.message, 'error');
      }
    }
  );
}

// ============================================
// SECTION TOGGLE
// ============================================

function toggleSection(headerEl) {
  headerEl.parentElement.classList.toggle('collapsed');
}

// ============================================
// TEXT OVERLAYS
// ============================================

function renderTextOverlays(overlays) {
  const container = document.getElementById('text-overlays-list');
  container.innerHTML = '';

  overlays.forEach((overlay, i) => {
    const item = document.createElement('div');
    item.className = 'text-overlay-item';
    item.dataset.index = i;
    item.innerHTML = `
      <div class="text-overlay-item__header">
        <span style="font-weight: 600; font-size: 0.85rem;">Текст #${i + 1}</span>
        <button class="btn btn--ghost btn--sm" onclick="removeTextOverlay(${i})" aria-label="Удалить текстовое наложение">${uiIcon("x-circle-fill")}</button>
      </div>
      <div class="form-group">
        <label class="form-label">Текст</label>
        <input type="text" class="form-input text-overlay-content" value="${escapeHtml(overlay.content || '')}" data-index="${i}" placeholder="Текст для наложения">
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Размер</label>
          <input type="number" class="form-input text-overlay-size" value="${overlay.fontSize || 48}" data-index="${i}" min="12" max="200">
        </div>
        <div class="form-group">
          <label class="form-label">Цвет</label>
          <input type="text" class="form-input text-overlay-color" value="${overlay.fontColor || 'white'}" data-index="${i}" placeholder="white">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Позиция X</label>
          <input type="text" class="form-input text-overlay-x" value="${overlay.x || '(w-text_w)/2'}" data-index="${i}" placeholder="(w-text_w)/2">
        </div>
        <div class="form-group">
          <label class="form-label">Позиция Y</label>
          <input type="text" class="form-input text-overlay-y" value="${overlay.y || '(h-text_h)/2'}" data-index="${i}" placeholder="(h-text_h)/2">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Показывать от (сек)</label>
          <input type="number" class="form-input text-overlay-from" value="${overlay.showFrom ?? ''}" data-index="${i}" placeholder="0" min="0" step="0.1">
        </div>
        <div class="form-group">
          <label class="form-label">Показывать до (сек)</label>
          <input type="number" class="form-input text-overlay-to" value="${overlay.showTo ?? ''}" data-index="${i}" placeholder="∞" min="0" step="0.1">
        </div>
      </div>
    `;
    container.appendChild(item);
  });
}

function addTextOverlay() {
  if (!state.editingTemplate) return;
  if (!state.editingTemplate.textOverlays) state.editingTemplate.textOverlays = [];

  state.editingTemplate.textOverlays.push({
    content: 'Текст',
    fontSize: 48,
    fontColor: 'white',
    x: '(w-text_w)/2',
    y: 'h-text_h-60',
    borderWidth: 2,
    shadowColor: 'black',
  });

  renderTextOverlays(state.editingTemplate.textOverlays);
}

function removeTextOverlay(index) {
  if (!state.editingTemplate) return;
  state.editingTemplate.textOverlays.splice(index, 1);
  renderTextOverlays(state.editingTemplate.textOverlays);
}

function collectTextOverlays() {
  const overlays = [];
  const items = document.querySelectorAll('.text-overlay-item');

  items.forEach(item => {
    const i = parseInt(item.dataset.index);
    const content = item.querySelector('.text-overlay-content')?.value || '';
    const fontSize = parseInt(item.querySelector('.text-overlay-size')?.value) || 48;
    const fontColor = item.querySelector('.text-overlay-color')?.value || 'white';
    const x = item.querySelector('.text-overlay-x')?.value || '(w-text_w)/2';
    const y = item.querySelector('.text-overlay-y')?.value || '(h-text_h)/2';
    const showFrom = item.querySelector('.text-overlay-from')?.value;
    const showTo = item.querySelector('.text-overlay-to')?.value;

    const overlay = {
      content,
      fontSize,
      fontColor,
      x,
      y,
      borderWidth: 2,
      shadowColor: 'black',
    };

    if (showFrom !== '' && showFrom !== undefined) overlay.showFrom = parseFloat(showFrom);
    if (showTo !== '' && showTo !== undefined) overlay.showTo = parseFloat(showTo);

    overlays.push(overlay);
  });

  return overlays;
}

// ============================================
// WATERMARK POSITION
// ============================================

const wmPositions = {
  'tl': { x: '20', y: '20' },
  'tc': { x: '(W-w)/2', y: '20' },
  'tr': { x: 'W-w-20', y: '20' },
  'ml': { x: '20', y: '(H-h)/2' },
  'mc': { x: '(W-w)/2', y: '(H-h)/2' },
  'mr': { x: 'W-w-20', y: '(H-h)/2' },
  'bl': { x: '20', y: 'H-h-20' },
  'bc': { x: '(W-w)/2', y: 'H-h-20' },
  'br': { x: 'W-w-20', y: 'H-h-20' },
};

function setWmPosition(pos) {
  document.querySelectorAll('.position-grid__cell').forEach(c => c.classList.remove('active'));
  document.querySelector(`.position-grid__cell[data-pos="${pos}"]`)?.classList.add('active');

  if (state.editingTemplate && wmPositions[pos]) {
    state.editingTemplate.watermark = state.editingTemplate.watermark || {};
    state.editingTemplate.watermark.x = wmPositions[pos].x;
    state.editingTemplate.watermark.y = wmPositions[pos].y;
  }
}

// ============================================
// SLICE MODE & PREVIEW
// ============================================

function setSliceMode(mode) {
  state.sliceMode = mode;

  document.querySelectorAll('.slice-mode-tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.slice-mode-tab[data-mode="${mode}"]`)?.classList.add('active');

  document.getElementById('slice-auto-controls').style.display = mode === 'auto' ? 'block' : 'none';
  document.getElementById('slice-manual-controls').style.display = mode === 'manual' ? 'block' : 'none';

  if (mode === 'manual' && state.manualTimecodes.length === 0) {
    addTimecodeRow();
  }

  updateSlicePreview();
}

function addTimecodeRow() {
  state.manualTimecodes.push({ start: 0, end: 60 });
  renderTimecodeRows();
}

function removeTimecodeRow(index) {
  state.manualTimecodes.splice(index, 1);
  renderTimecodeRows();
  updateSlicePreview();
}

function renderTimecodeRows() {
  const container = document.getElementById('timecodes-list');
  container.innerHTML = '';

  state.manualTimecodes.forEach((tc, i) => {
    const row = document.createElement('div');
    row.className = 'timecode-row';
    row.innerHTML = `
      <span class="timecode-row__index">#${i + 1}</span>
      <input type="text" class="form-input" style="width:100px" value="${formatTime(tc.start)}" placeholder="00:00:00"
        onchange="updateTimecode(${i}, 'start', this.value)">
      <span style="color: var(--text-muted);">${uiIcon("arrow-right-circle-fill")}</span>
      <input type="text" class="form-input" style="width:100px" value="${formatTime(tc.end)}" placeholder="00:02:00"
        onchange="updateTimecode(${i}, 'end', this.value)">
      <span class="timecode-row__duration">${formatTime(tc.end - tc.start)}</span>
      <button class="btn btn--ghost btn--sm" onclick="removeTimecodeRow(${i})" aria-label="Удалить интервал">${uiIcon("x-circle-fill")}</button>
    `;
    container.appendChild(row);
  });
}

function updateTimecode(index, field, value) {
  state.manualTimecodes[index][field] = parseTimecode(value);
  updateSlicePreview();
}

async function updateSlicePreview() {
  if (!state.currentVideoId) return;

  const sliceConfig = getSliceConfig();

  try {
    const response = await fetch(`/api/videos/${state.currentVideoId}/slice-preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sliceConfig),
    });
    const data = await response.json();

    state.segments = data.segments;
    document.getElementById('segments-count').textContent = `${data.totalSegments} сегментов`;

    renderTimelineSegments(data.segments, data.totalDuration);
    renderSegmentsGrid(data.segments);
  } catch (err) {
    console.error('Slice preview error:', err);
  }
}

function getSliceConfig() {
  if (state.sliceMode === 'auto') {
    return {
      mode: 'auto',
      segmentDuration: parseInt(document.getElementById('segment-duration').value) || 120,
      overlap: parseInt(document.getElementById('segment-overlap').value) || 0,
    };
  } else {
    return {
      mode: 'manual',
      timecodes: state.manualTimecodes,
    };
  }
}

function renderTimelineSegments(segments, totalDuration) {
  const timeline = document.getElementById('timeline');

  // Remove old segments
  timeline.querySelectorAll('.timeline__segment').forEach(s => s.remove());

  segments.forEach((seg, i) => {
    const el = document.createElement('div');
    el.className = 'timeline__segment';
    el.style.left = `${(seg.start / totalDuration) * 100}%`;
    el.style.width = `${(seg.duration / totalDuration) * 100}%`;
    el.innerHTML = `<span class="timeline__segment-label">${i + 1}</span>`;
    timeline.appendChild(el);
  });

  // Time marks
  const marksContainer = document.getElementById('timeline-marks');
  marksContainer.innerHTML = '';
  const markCount = 6;
  for (let i = 0; i <= markCount; i++) {
    const time = (totalDuration / markCount) * i;
    const mark = document.createElement('span');
    mark.className = 'timeline__time-mark';
    mark.textContent = formatTime(time);
    marksContainer.appendChild(mark);
  }
}

function renderSegmentsGrid(segments) {
  const container = document.getElementById('segments-grid');
  container.innerHTML = '';

  // The speed from "Оформление" applies to every clip: show each clip's length after it.
  const speed = typeof framingSpeed === 'function' ? framingSpeed() : 1, sped = Math.abs(speed - 1) > .001;
  const speedLabel = `${String(Math.round(speed * 100) / 100).replace('.', ',')}×`;
  segments.forEach(seg => {
    const card = document.createElement('div');
    card.className = 'segment-card';
    card.innerHTML = `
      <div class="segment-card__number">Клип #${seg.index + 1}${sped ? ` <span class="segment-card__speed">${speedLabel}</span>` : ''}</div>
      <div class="segment-card__time">${formatTime(seg.start)} → ${formatTime(seg.end)}</div>
      <div class="segment-card__duration">${sped ? `Длительность: ${formatTime(seg.duration / speed)} <s>${formatTime(seg.duration)}</s>` : `Длительность: ${formatTime(seg.duration)}`}</div>
    `;
    container.appendChild(card);
  });
}

// ============================================
// RENDER
// ============================================

async function startRender() {
  if (!state.currentVideoId) {
    showToast('Сначала загрузи видео', 'warning');
    return;
  }
  if (!state.selectedTemplateId) {
    showToast('Сначала выбери шаблон', 'warning');
    return;
  }
  if (state.segments.length === 0) {
    showToast('Нет сегментов для рендера', 'warning');
    return;
  }

  const btn = document.getElementById('start-render-btn');
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner"></div> Запуск...';

  try {
    const response = await fetch('/api/render/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoId: state.currentVideoId,
        templateId: state.selectedTemplateId,
        sliceConfig: getSliceConfig(),
        adConfig: typeof getAdConfig === 'function' ? getAdConfig() : undefined,
        framing: typeof getFraming === 'function' ? getFraming() : undefined,
        reaction: typeof getReactionForRender === 'function' ? getReactionForRender() : undefined,
        fps: typeof getExportFps === 'function' ? getExportFps() : 30,
      }),
    });

    const job = await response.json();
    if (!response.ok) throw new Error(job.error);

    showToast(`Рендер запущен · клипов: ${job.totalSegments}`, 'success');

    // Navigate to render page and watch progress
    navigate('render');
    watchJobProgress(job.jobId);
  } catch (err) {
    showToast('Ошибка запуска: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'Экспортировать клипы ' + uiIcon("arrow-up-right-circle-fill");
  }
}

const jobStreams = new Map();
function watchJobProgress(jobId) {
  if (jobStreams.has(jobId)) return;
  const eventSource = new EventSource(`/api/render/jobs/${jobId}/progress`);
  jobStreams.set(jobId, eventSource);
  const close = () => { eventSource.close(); jobStreams.delete(jobId); };

  eventSource.addEventListener('status', (e) => {
    const data = JSON.parse(e.data);
    updateJobUI(jobId, data);
    if (['completed', 'partial', 'error', 'cancelled'].includes(data.status)) { close(); loadRenderJobs(); }
  });

  eventSource.addEventListener('progress', (e) => {
    const data = JSON.parse(e.data);
    updateJobProgress(jobId, data);
  });

  eventSource.addEventListener('started', (e) => {
    const data = JSON.parse(e.data);
    updateJobUI(jobId, { status: 'processing', overallProgress: 0, totalSegments: data.totalSegments, doneSegments: 0, encoder: data.encoder });
  });

  eventSource.addEventListener('segment_complete', (e) => {
    const data = JSON.parse(e.data);
    showToast(`Клип ${data.fileName} готов!`, 'success');
  });

  eventSource.addEventListener('segment_error', (e) => {
    const data = JSON.parse(e.data);
    showToast(`Ошибка в сегменте ${data.segmentIndex + 1}: ${data.error}`, 'error');
  });

  eventSource.addEventListener('completed', (e) => {
    const data = JSON.parse(e.data);
    showToast(`Готово ${data.results.length} клипов за ${Math.round(data.duration)}с${data.errors.length ? ` · ошибок: ${data.errors.length}` : ''}`, data.errors.length ? 'warning' : 'success');
    close();
    loadRenderJobs();
  });

  eventSource.addEventListener('error', () => {
    // SSE connection error — just reload jobs
    close();
    setTimeout(() => loadRenderJobs(), 2000);
  });
}

async function loadRenderJobs() {
  try {
    const response = await fetch('/api/render/jobs');
    const jobs = await response.json();
    renderJobsList(jobs);
  } catch (err) {
    console.error('Error loading jobs:', err);
  }
}

let emptyJobsElement = null;
function formatBytes(bytes) {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1).replace('.', ',')} ГБ`;
  if (bytes >= 1048576) return `${Math.round(bytes / 1048576)} МБ`;
  return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}
// Old exports: one at a time, or every finished one at once (running renders are never touched).
function deleteRenderJob(jobId) {
  showConfirmModal('Удалить экспорт?', 'Клипы этой задачи будут удалены с диска без возможности восстановления.', 'Удалить', async () => {
    try {
      const response = await fetch(`/api/render/jobs/${jobId}`, { method: 'DELETE' });
      if (!response.ok) throw new Error((await response.json()).error);
      showToast('Экспорт удалён', 'info'); loadRenderJobs();
    } catch (err) { showToast(err.message, 'error'); }
  });
}
function deleteAllRenderJobs() {
  const finished = (window.lastRenderJobs || []).filter(j => !['queued', 'processing'].includes(j.status));
  const size = finished.reduce((sum, j) => sum + (j.sizeBytes || 0), 0);
  showConfirmModal('Удалить все готовые экспорты?', `Будет удалено задач: ${finished.length}, освободится ${formatBytes(size)}. Идущие рендеры не затрагиваются. Восстановить файлы будет нельзя.`, 'Удалить все', async () => {
    try {
      const result = await (await fetch('/api/render/jobs', { method: 'DELETE' })).json();
      showToast(`Удалено экспортов: ${result.count}, освобождено ${formatBytes(result.bytes)}`, 'success'); loadRenderJobs();
    } catch (err) { showToast(err.message, 'error'); }
  });
}

function renderJobsList(jobs) {
  window.lastRenderJobs = jobs;
  const finished = jobs.filter(j => !['queued', 'processing'].includes(j.status));
  const total = finished.reduce((sum, j) => sum + (j.sizeBytes || 0), 0);
  document.getElementById('render-clear-all').hidden = !finished.length;
  document.getElementById('render-summary').textContent = jobs.length ? `Задач: ${jobs.length}${total ? ` · на диске ${formatBytes(total)}` : ''}` : 'Все задачи рендеринга';
  const container = document.getElementById('render-jobs-list');
  const emptyState = document.getElementById('no-jobs-state') || emptyJobsElement;
  emptyJobsElement = emptyState;

  if (jobs.length === 0) {
    container.innerHTML = '';
    container.appendChild(emptyState);
    emptyState.style.display = 'flex';
    return;
  }

  emptyState.style.display = 'none';
  container.innerHTML = '';

  jobs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  jobs.forEach(job => {
    const el = document.createElement('div');
    el.className = 'render-job';
    el.id = `job-${job.id}`;
    el.innerHTML = `
      <div class="render-job__header">
        <div>
          <span class="render-job__id">${escapeHtml(job.name || job.id.slice(0, 8)+'...')}</span>${job.sizeBytes ? ` <span class="render-job__size">${formatBytes(job.sizeBytes)}</span>` : ''}
          <span style="margin-left: var(--space-sm); font-size: 0.8rem; color: var(--text-muted);">
            ${new Date(job.createdAt).toLocaleString('ru')}
          </span>
        </div>
        <div class="render-job__actions">
          <span class="status-badge status-badge--${job.status}">${getStatusText(job.status)}</span>
          ${['queued', 'processing'].includes(job.status) ? `<button class="btn btn--ghost btn--sm render-job__cancel" onclick="cancelRenderJob('${job.id}')">${uiIcon("x-circle-fill")} Отменить</button>` : ''}
        </div>
      </div>
      <div class="progress-bar">
        <div class="progress-bar__fill" style="width: ${job.overallProgress}%"></div>
      </div>
      <div class="progress-info">
        <span class="progress-percent">${job.overallProgress}%</span>
        <span class="progress-status" id="job-status-${job.id}">${renderJobStatusText(job)}</span>
      </div>
      ${job.errorsCount ? `<div class="render-error">Ошибки в ${job.errorsCount} клипах. Открой детали задачи для проверки.</div>` : ''}
      ${['completed', 'partial', 'error', 'cancelled'].includes(job.status) ? `
        <div class="render-job__buttons">
          ${job.resultsCount ? `<button class="btn btn--primary btn--sm" onclick="viewJobResults('${job.id}')">${uiIcon("folder-fill")} Показать файлы</button>` : ''}
          ${job.resultsCount ? `<a class="btn btn--secondary btn--sm" href="/api/render/jobs/${job.id}/download-all" download title="Все клипы задачи одним ZIP-архивом">${uiIcon("cloud-arrow-down-fill")} Скачать все${job.resultsCount > 1 ? ` (${job.resultsCount})` : ''}${job.sizeBytes ? ` · ${formatBytes(job.sizeBytes)}` : ''}</a>` : ''}
          <button class="btn btn--ghost btn--sm render-job__delete" onclick="deleteRenderJob('${job.id}')">${uiIcon("trash3-fill")} Удалить</button>
        </div>
        <div class="results-grid" id="job-results-${job.id}" style="margin-top: var(--space-md); display: none;"></div>
      ` : ''}
    `;
    container.appendChild(el);
    jobState.set(job.id, job);

    // Watch progress if still processing
    if (job.status === 'processing' || job.status === 'queued') {
      watchJobProgress(job.id);
    }
  });
}

// "Готово 4 из 19 · осталось ~3:20 · Видеокарта NVIDIA (NVENC)"
function renderJobStatusText(job) {
  const parts = [];
  if (job.totalSegments) parts.push(`Готово ${job.doneSegments ?? 0} из ${job.totalSegments}`);
  if (job.status === 'processing') parts.push(job.etaSeconds != null ? `осталось ~${formatDuration(job.etaSeconds)}` : 'оцениваю время…');
  if (job.status === 'queued') parts.push('ждёт очереди');
  if (job.status === 'cancelled') parts.push('рендер отменён');
  if (job.encoder && ['processing', 'queued'].includes(job.status)) parts.push(job.encoder);
  return parts.join(' · ');
}
function formatDuration(seconds) {
  seconds = Math.max(0, Math.round(seconds));
  const h = Math.floor(seconds / 3600), m = Math.floor(seconds % 3600 / 60), s = seconds % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
const jobState = new Map();
function cancelRenderJob(jobId) {
  showConfirmModal('Отменить рендер?', 'Уже готовые клипы останутся, недоделанные будут удалены.', 'Отменить рендер', async () => {
    try {
      const response = await fetch(`/api/render/jobs/${jobId}/cancel`, { method: 'POST' });
      if (!response.ok) throw new Error((await response.json()).error);
      showToast('Рендер отменяется…', 'info');
      setTimeout(loadRenderJobs, 1200);
    } catch (err) { showToast(err.message, 'error'); }
  });
}

function updateJobUI(jobId, data) {
  const merged = { ...(jobState.get(jobId) || {}), ...data };
  jobState.set(jobId, merged);
  updateJobSegmentStatus(jobId, renderJobStatusText(merged));
  const el = document.getElementById(`job-${jobId}`);
  if (!el) return;

  const badge = el.querySelector('.status-badge');
  if (badge) {
    badge.className = `status-badge status-badge--${data.status}`;
    badge.textContent = getStatusText(data.status);
  }

  const fill = el.querySelector('.progress-bar__fill');
  if (fill) fill.style.width = data.overallProgress + '%';

  const percent = el.querySelector('.progress-percent');
  if (percent) percent.textContent = data.overallProgress + '%';
}

function updateJobProgress(jobId, data) {
  const el = document.getElementById(`job-${jobId}`);
  if (!el) return;
  const merged = { ...(jobState.get(jobId) || {}), status: 'processing', ...data };
  jobState.set(jobId, merged);
  updateJobSegmentStatus(jobId, renderJobStatusText(merged));
  const badge = el.querySelector('.status-badge');
  if (badge && !badge.classList.contains('status-badge--processing')) { badge.className = 'status-badge status-badge--processing'; badge.textContent = getStatusText('processing'); }

  const fill = el.querySelector('.progress-bar__fill');
  if (fill) fill.style.width = data.overallProgress + '%';

  const percent = el.querySelector('.progress-percent');
  if (percent) percent.textContent = data.overallProgress + '%';
}

function updateJobSegmentStatus(jobId, text) {
  const statusEl = document.getElementById(`job-status-${jobId}`);
  if (statusEl) statusEl.textContent = text;
}

async function viewJobResults(jobId) {
  const container = document.getElementById(`job-results-${jobId}`);
  if (!container) return;

  if (container.style.display !== 'none') {
    container.style.display = 'none';
    return;
  }

  try {
    const response = await fetch(`/api/render/jobs/${jobId}/files`);
    const files = await response.json();
    if (!response.ok) throw new Error(files.error);

    container.innerHTML = '';
    files.forEach(file => {
      const card = document.createElement('div');
      card.className = 'result-card';
      card.innerHTML = `
        <div class="result-card__preview">
          <video src="${file.downloadUrl}#t=1" preload="metadata" muted></video>
        </div>
        <div class="result-card__info">
          <div class="result-card__name">${file.fileName}</div>
          <div class="result-card__meta">Исходник ${formatTime(file.start)} → ${formatTime(file.end)}<br>Итог: ${formatTime(file.outputDuration || file.duration)}</div>
        </div>
        <div class="result-card__actions">
          <a href="${file.downloadUrl}" download class="btn btn--primary btn--sm">${uiIcon("cloud-arrow-down-fill")} Скачать</a>
          <button class="btn btn--secondary btn--sm" onclick="previewClip('${file.downloadUrl}')">${uiIcon('play-fill')} Играть</button>
        </div>
      `;
      container.appendChild(card);
    });
    const details = await (await fetch(`/api/render/jobs/${jobId}`)).json();
    (details.errors || []).forEach(error => {
      const el = document.createElement('p'); el.className = 'render-error';
      el.textContent = typeof error === 'string' ? error : `Клип ${(error.segmentIndex ?? 0) + 1}: ${error.error}`;
      container.appendChild(el);
    });

    container.style.display = 'grid';
  } catch (err) {
    showToast('Ошибка: ' + err.message, 'error');
  }
}

function previewClip(url) {
  // Simple video preview in modal
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  overlay.innerHTML = `
    <div class="modal" style="padding: 0; overflow: hidden; max-width: 400px;">
      <video src="${url}" controls autoplay style="width: 100%; display: block;"></video>
    </div>
  `;
  document.body.appendChild(overlay);
}

function getStatusText(status) {
  const map = {
    queued: 'В очереди',
    processing: 'Рендерится',
    completed: 'Готово',
    partial: 'Готово частично',
    error: 'Ошибка',
    cancelled: 'Отменён',
  };
  return map[status] || status;
}

// ============================================
// UTILITIES
// ============================================

function formatTime(seconds) {
  if (seconds === undefined || seconds === null || isNaN(seconds)) return '00:00:00';
  seconds = Math.max(0, seconds);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function parseTimecode(tc) {
  if (typeof tc === 'number') return tc;
  const parts = tc.toString().split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ============================================
// INIT
// ============================================

// Add range input live update listeners
document.querySelectorAll('input[type="range"]').forEach(input => {
  input.addEventListener('input', function () {
    const valueEl = document.getElementById(this.id + '-value');
    if (valueEl) valueEl.textContent = this.value;
  });
});

// Initial page load
navigate('home');

// The sidebar account card is visible on every page, so load the sign-in state on start.
loadYouTubeAuth();
