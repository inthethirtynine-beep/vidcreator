/* Local creator workspace; 21st.dev sidebar adapted to the existing vanilla app. */
let adConfig;
try { adConfig = JSON.parse(localStorage.getItem('vidcreator.ads.v1')); } catch {}
adConfig = { enabled: false, freezeOnAd: true, assetIds: [], count: 2, duration: 6, firstStart: 26, minGap: 8, endPadding: 3, width: 90, x: 50, y: 48, opacity: 1, fade: .3, animation: 'fade', rotation: 'clip', clips: {}, ...adConfig };
let bannerAssets = [], adPlans = [], selectedClip = 0, studioStepNumber = 1, previewSourceId = null, previewAssetId = null;
let sliceRequestVersion = 0;
let previewOutputTime = 0, previewPlaying = false, previewTickTime = 0, previewAnimation = null;
let previewSound = localStorage.getItem('vidcreator.previewSound') !== 'off';
const originalActivateStep = activateStep;
activateStep = function (n) {
  studioStepNumber = n;
  originalActivateStep(n);
  document.querySelectorAll('.studio-step').forEach((el, i) => el.classList.toggle('active', i === n - 1));
  document.getElementById('studio-panel-title').textContent = ['Добавь исходное видео', 'Задай стиль своим клипам', 'Собери свою серию', 'Реклама под твоим контролем'][n - 1];
  document.getElementById('studio-step-count').textContent = `Шаг ${n} из 4`;
  if (n === 4) { renderAdEditor(); updateAdPlan(); }
  refreshStudioSteps();
  // Banner tools belong to the ads step only; hide them as soon as another step opens.
  if (typeof syncCanvasEditor === 'function') syncCanvasEditor(canvasData);
  if (typeof applyPreviewFraming === 'function') { applyPreviewFraming(); renderFramingControls(); }
};
function studioStep(n) {
  if (n > 1 && !state.currentVideoId) return showToast('Сначала добавь исходное видео', 'info');
  if (n > 2 && !state.selectedTemplateId) return showToast('Выбери шаблон оформления', 'info');
  if (n === 4 && !state.segments.length) return showToast('Сначала настрой нарезку', 'info');
  activateStep(n);
}
const originalNavigate = navigate;
navigate = function (page) {
  if (page !== 'home') pauseStudioPlayback();
  originalNavigate(page);
  document.getElementById('studio-breadcrumb').textContent = { home: 'Видеостудия', templates: 'Мои шаблоны', render: 'Экспорт и файлы' }[page] || page;
};
const originalShowVideoInfo = showVideoInfo;
showVideoInfo = function (video) {
  originalShowVideoInfo(video);
  pauseStudioPlayback(); previewOutputTime = 0;
  selectedClip = 0;
  state.segments = [];
  if (localStorage.getItem('vidcreator.source') !== video.id) { adConfig.clips = {}; saveAds(); }
  localStorage.setItem('vidcreator.source', video.id);
  syncStudioPreview();
};
const originalSelectTemplate = selectTemplate;
selectTemplate = async function (id) { await originalSelectTemplate(id); localStorage.setItem('vidcreator.template',id); syncStudioPreview(); };
setSliceMode = function (mode) {
  state.sliceMode = mode;
  document.querySelectorAll('.slice-mode-tab').forEach(el => el.classList.toggle('active', el.dataset.mode === mode));
  ['auto', 'manual', 'count'].forEach(value => document.getElementById(`slice-${value}-controls`).style.display = mode === value ? 'block' : 'none');
  if (mode === 'manual' && !state.manualTimecodes.length) addTimecodeRow();
  updateSlicePreview();
};
const originalGetSliceConfig = getSliceConfig;
getSliceConfig = function () {
  if (state.sliceMode === 'count') return { mode: 'count', clipCount: Number(document.getElementById('clip-count').value) };
  if (state.sliceMode === 'auto') return { mode: 'auto', segmentDuration: Number(document.getElementById('segment-duration').value), overlap: Number(document.getElementById('segment-overlap').value), mergeTail: document.getElementById('slice-merge-tail').checked };
  return originalGetSliceConfig();
};
updateSlicePreview = async function () {
  if (!state.currentVideoId) return;
  const version = ++sliceRequestVersion;
  try {
    const response = await fetch(`/api/videos/${state.currentVideoId}/slice-preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(getSliceConfig()) });
    const data = await response.json();
    if (version !== sliceRequestVersion) return;
    if (!response.ok) throw new Error(data.error);
    state.segments = data.segments;
    localStorage.setItem('vidcreator.slice', JSON.stringify(getSliceConfig()));
    selectedClip = Math.min(selectedClip, state.segments.length - 1);
    document.getElementById('segments-count').textContent = `Клипов: ${data.totalSegments}`;
    renderTimelineSegments(data.segments, data.totalDuration);
    renderSegmentsGrid(data.segments);
    updateAdPlan();
    syncStudioPreview();
  } catch (err) {
    state.segments = [];
    document.getElementById('segments-count').textContent = 'Проверь настройки';
    document.getElementById('segments-grid').textContent = err.message;
    showToast(err.message, 'error');
  }
};
async function restoreSource(id, restore = false) {
  if (!id) return;
  try {
    const response = await fetch(`/api/videos/${id}`);
    const video = await response.json();
    if (!response.ok) throw new Error(video.error);
    state.currentVideoId = id;
    state.currentVideoInfo = video.info;
    showVideoInfo(video);
    activateStep(1);
    if (restore) {
      const templateId = localStorage.getItem('vidcreator.template');
      if (templateId) {
        const templateResponse = await fetch(`/api/templates/${templateId}`);
        // Restoring the last session is not a user action, so it stays silent.
        state.restoringSession = true;
        try { if (templateResponse.ok) await selectTemplate(templateId); } finally { state.restoringSession = false; }
      }
      let slice;
      try { slice = JSON.parse(localStorage.getItem('vidcreator.slice')); } catch {}
      if (slice) {
        document.getElementById('segment-duration').value = slice.segmentDuration ?? 120;
        document.getElementById('segment-overlap').value = slice.overlap ?? 0;
        document.getElementById('slice-merge-tail').checked = slice.mergeTail !== false;
        document.getElementById('clip-count').value = slice.clipCount ?? 5;
        state.manualTimecodes = slice.timecodes || [];
        renderTimecodeRows();
        setSliceMode(slice.mode || 'auto');
      }
    }
  } catch (err) { localStorage.removeItem('vidcreator.source'); showToast(err.message, 'error'); }
}
async function loadSourceLibrary() {
  try {
    const response = await fetch('/api/videos');
    const videos = await response.json();
    const select = document.getElementById('source-library');
    videos.forEach(v => { const option = new Option(`${v.originalName} · ${formatTime(v.duration)}`, v.id); select.add(option); });
    select.style.display = videos.length ? 'block' : 'none';
  } catch { /* Upload remains available if the library is unavailable. */ }
}
function saveAds() { localStorage.setItem('vidcreator.ads.v1', JSON.stringify(adConfig)); }
function adSet(key, value) {
  if (typeof recordAdChange === 'function') recordAdChange();
  pauseStudioPlayback();
  if (typeof setScopedAdValue === 'function' && ['x','y','width','opacity','animation','fade'].includes(key)) setScopedAdValue(key,value);
  else adConfig[key] = value;
  saveAds(); updateAdPlan();
}
function adNumber(id, label, key, min, max, step = 1) {
  return `<div class="form-group"><label class="form-label" for="${id}">${label}</label><input id="${id}" class="form-input" type="number" min="${min}" max="${max}" step="${step}" value="${adConfig[key]}" onchange="adSet('${key}',Number(this.value))"></div>`;
}
function renderAdEditor() {
  const container = document.getElementById('ad-editor');
  container.innerHTML = `<label class="ad-toggle"><input type="checkbox" ${adConfig.enabled ? 'checked' : ''} onchange="adSet('enabled',this.checked);renderAdEditor();updateAdPlan()">Добавлять рекламные баннеры</label>
    <p class="ad-help">Баннер поверх видео, как в твоём примере. Каждый клип получает собственное расписание.</p>
    <label class="btn btn--secondary" style="cursor:pointer;display:inline-flex">${uiIcon("plus-circle-fill")} Загрузить баннер<input id="banner-upload" type="file" accept=".png,.jpg,.jpeg,.webp,.gif,.mp4,.webm,.mov" hidden onchange="uploadBanner(this.files[0])"></label>
    <p class="ad-help">PNG с прозрачностью, JPG, WebP, GIF, MP4, WebM, MOV · до 100 МБ. У видеобаннеров сохраняется звук.</p>
    <div class="ad-library" id="ad-library"></div>
    <div class="ad-fields" ${adConfig.enabled ? '' : 'hidden'}>
    <label class="ad-toggle"><input id="ad-freeze" type="checkbox" ${adConfig.freezeOnAd ? 'checked' : ''} onchange="adSet('freezeOnAd',this.checked)">Стоп-кадр и пауза звука на время рекламы</label>
    <p class="ad-help">После баннера видео и звук продолжаются с того же места. Длительность клипа увеличивается на время рекламных показов.</p>
    <label class="ad-toggle"><input id="ad-audio" type="checkbox" ${adConfig.adAudio !== false ? 'checked' : ''} onchange="adSet('adAudio',this.checked);applyPreviewAudio()">Звук видеобаннера</label>
    <p class="ad-help">Звук из MP4, WebM и MOV играет во время показа. На стоп-кадре звук исходника на паузе, поэтому слышна только реклама.</p>
    <div class="form-row">${adNumber('ad-count','Показов в каждом клипе','count',0,20)}${adNumber('ad-duration','Показ PNG / JPG, сек','duration',.2,120,.1)}</div>
    <p class="ad-help">Видеобаннеры и GIF проигрываются один раз по длине файла. Стоп-кадр подстраивается под каждый баннер автоматически.</p>
    <div class="form-row">${adNumber('ad-first','Первый показ, сек','firstStart',0,86400,.1)}${adNumber('ad-gap','Минимальная пауза, сек','minGap',0,3600,.1)}</div>
    <div class="form-row">${adNumber('ad-end','Отступ от конца, сек','endPadding',0,3600,.1)}<div class="form-group"><label class="form-label" for="ad-rotation">Чередование баннеров</label><select id="ad-rotation" class="form-select" onchange="adSet('rotation',this.value)"><option value="clip">Один баннер на клип</option><option value="show">Каждый показ — следующий</option><option value="fixed">Первый баннер для всех</option></select></div></div>
    <div class="form-row"><div class="form-group"><label class="form-label" for="ad-animation">Появление и уход</label><select id="ad-animation" class="form-select" onchange="adSet('animation',this.value)"><option value="fade">Плавное затухание</option><option value="slide-up">Слайд снизу</option><option value="slide-left">Слайд справа</option><option value="zoom">Мягкое масштабирование</option><option value="none">Без анимации</option></select></div>${adNumber('ad-fade','Длительность входа / ухода, сек','fade',0,3,.05)}</div>
    <div class="ad-style"><div class="ad-style__head"><span>Углы и тень баннера</span><span class="framing__quick"><button type="button" class="framing__preset" onclick="adSet('radius',35);renderAdEditor()">Скруглить</button><button type="button" class="framing__preset" onclick="adSet('shadow',60);renderAdEditor()">Тень</button></span></div>
    <div class="form-row"><div class="form-group"><label class="form-label" for="ad-radius">Скругление <b id="ad-radius-label">${adConfig.radius ? Math.round(adConfig.radius) + '%' : 'нет'}</b></label><input id="ad-radius" type="range" min="0" max="100" step="1" value="${adConfig.radius || 0}" oninput="document.getElementById('ad-radius-label').textContent=this.value>0?this.value+'%':'нет';adPreviewStyle({radius:Number(this.value)})" onchange="adSet('radius',Number(this.value))"></div>
    <div class="form-group"><label class="form-label" for="ad-shadow">Тень <b id="ad-shadow-label">${adConfig.shadow ? Math.round(adConfig.shadow) + '%' : 'нет'}</b></label><input id="ad-shadow" type="range" min="0" max="100" step="1" value="${adConfig.shadow || 0}" oninput="document.getElementById('ad-shadow-label').textContent=this.value>0?this.value+'%':'нет';adPreviewStyle({shadow:Number(this.value)})" onchange="adSet('shadow',Number(this.value))"></div></div></div>
    <button class="btn btn--secondary" onclick="editBannerOnCanvas()">${uiIcon("cursor-fill")} Изменить баннер в кадре</button>
    <details class="ad-advanced"><summary class="ad-help">Точные параметры размера и позиции</summary>
    <div class="form-row">${adNumber('ad-width','Ширина, % кадра','width',10,100)}${adNumber('ad-opacity','Непрозрачность, 0–1','opacity',0,1,.05)}</div>
    <div class="form-row">${adNumber('ad-x','Центр по горизонтали, %','x',0,100)}${adNumber('ad-y','Центр по вертикали, %','y',0,100)}</div>
    </details>
    <p class="ad-help">Время показов задаётся по исходному содержимому каждой нарезки. При стоп-кадре дальнейшие моменты сдвигаются на время пауз; дорожка ниже показывает итоговое видео.</p></div>
    <div id="ad-validation" role="status" aria-live="polite"></div><div id="ad-clips"></div>
    <div class="export-settings"><label class="form-label" for="export-fps">Частота кадров в готовых клипах</label><select id="export-fps" class="form-select" onchange="setExportFps(this.value)"><option value="30">30 кадров/с — быстрее, стандарт Shorts и TikTok</option><option value="60">60 кадров/с — плавнее, рендер примерно вдвое дольше</option><option value="0">Как в исходнике</option></select></div>
    <div class="ad-toolbar"><button class="btn btn--ghost" onclick="studioStep(3)">${uiIcon("arrow-left-circle-fill")} Нарезка</button><button class="btn btn--primary" id="start-render-btn" onclick="startRender()">Экспортировать клипы ${uiIcon("arrow-up-right-circle-fill")}</button></div>`;
  document.getElementById('ad-rotation').value = adConfig.rotation;
  document.getElementById('ad-animation').value = adConfig.animation;
  const usedIds=[...adConfig.assetIds,...Object.values(adConfig.clips).flatMap(c=>c.assetIds||[])];
  const staticInput=document.getElementById('ad-duration');
  staticInput.disabled=usedIds.length>0&&usedIds.every(id=>bannerAssets.find(a=>a.id===id)?.animated);
  staticInput.title=staticInput.disabled?'Длина видео определяется по файлу; это поле используется только для статичных изображений':'';
  const library = document.getElementById('ad-library');
  bannerAssets.forEach(asset => {
    const el = document.createElement('button');
    el.type = 'button'; el.className = `ad-asset ${adConfig.assetIds.includes(asset.id) ? 'selected' : ''}`;
    el.setAttribute('aria-pressed', adConfig.assetIds.includes(asset.id));
    el.innerHTML = `${asset.animated && (!/\.gif$/i.test(asset.url) || asset.previewUrl) ? `<video src="${asset.previewUrl || asset.url}" muted preload="metadata"></video>` : `<img src="${asset.url}" alt="">`}<p></p>`;
    el.querySelector('p').textContent = `${asset.name}${asset.animated ? ` · ${asset.duration}с` : ''}`;
    el.title = asset.name;
    el.onclick = () => { if(typeof recordAdChange==='function') recordAdChange(); adConfig.assetIds = adConfig.assetIds.includes(asset.id) ? adConfig.assetIds.filter(id => id !== asset.id) : [...adConfig.assetIds, asset.id]; saveAds(); renderAdEditor(); updateAdPlan(); };
    library.appendChild(el);
  });
  if(typeof syncCanvasInspector==='function')syncCanvasInspector();
}
async function uploadBanner(file) {
  if (!file) return;
  const button = document.querySelector('#banner-upload').parentElement;
  button.style.pointerEvents = 'none';
  const data = new FormData(); data.append('banner', file);
  try {
    showToast('Загружаю баннер…', 'info');
    const response = await fetch('/api/banners', { method: 'POST', body: data });
    const asset = await response.json();
    if (!response.ok) throw new Error(asset.error);
    bannerAssets.push(asset); adConfig.assetIds.push(asset.id); adConfig.enabled = true; saveAds();
    renderAdEditor(); updateAdPlan(); showToast('Баннер добавлен', 'success');
  } catch (err) { showToast(err.message, 'error'); button.style.pointerEvents = ''; }
}
function updateAdPlan() {
  pauseStudioPlayback();
  let error = '';
  try {
    adPlans = AdSchedule.plan(adConfig, state.segments.map(segment => ({ ...segment, duration: clipContentDuration(segment) })), id => bannerAssets.find(a=>a.id===id));
    adPlans.flat().forEach(event => { if (!bannerAssets.some(a => a.id === event.assetId)) throw new Error('Один из баннеров больше недоступен. Выбери баннер заново.'); });
  } catch (err) { error = err.message; adPlans = []; }
  const validation = document.getElementById('ad-validation');
  if (validation) {
    validation.className = error ? 'ad-error' : 'ad-valid';
    validation.textContent = error || (adConfig.enabled ? `Показов: ${adPlans.flat().length} · клипов: ${state.segments.length} · расписание готово` : 'Экспорт без рекламных баннеров');
    document.getElementById('start-render-btn').disabled = !!error;
    renderAdClips();
  }
  previewOutputTime = Math.min(previewOutputTime, studioOutputDuration());
  if (document.getElementById('studio-video').src) applyStudioPlayback();
  paintPreview();
  document.getElementById('preview-seek').max = studioOutputDuration();
  return !error;
}
function renderAdClips() {
  const container = document.getElementById('ad-clips');
  const open = [...container.querySelectorAll('details[open]')].map(el => el.dataset.clip);
  container.innerHTML = '';
  state.segments.forEach((segment, index) => {
    const sourceEvents = adPlans[index] || [];
    const events = AdSchedule.outputEvents(sourceEvents);
    const resultDuration = AdSchedule.outputDuration(clipContentDuration(segment), sourceEvents);
    const row = document.createElement('div'); row.className = 'ad-clip-row';
    const override = adConfig.clips[index] || {};
    row.innerHTML = `<div class="ad-clip-head"><span>Клип ${String(index + 1).padStart(2,'0')} <span style="color:#78888b">· ${formatTime(resultDuration)}${resultDuration > segment.duration ? ` (+${Math.round((resultDuration-segment.duration)*100)/100}с рекламы)` : ''}</span></span><button onclick="selectPreviewClip(${index})">Смотреть ${uiIcon("arrow-up-right-circle-fill")}</button></div><div class="ad-track" title="Нажми на показ для предпросмотра"></div>
      <details data-clip="${index}" ${open.includes(String(index)) ? 'open' : ''}><summary class="ad-help" style="cursor:pointer">Настроить этот клип ${Object.keys(override).length ? '• изменён' : ''}</summary><div class="ad-clip-detail">
      <label>Показы (пусто — общие настройки)<input class="form-input" type="number" min="0" max="20" value="${override.count ?? ''}" onchange="setClipAd(${index},'count',this.value)"></label>
      <label>Баннер<select class="form-select" onchange="setClipAd(${index},'assetIds',this.value)"><option value="">По общему правилу</option>${bannerAssets.map(a => `<option value="${a.id}" ${override.assetIds?.[0] === a.id ? 'selected' : ''}>${escapeHtml(a.name)}</option>`).join('')}</select></label>
      <label>Начало показов по исходнику, секунды через запятую<input class="form-input" value="${override.starts?.join(', ') || ''}" placeholder="26, 160" onchange="setClipAd(${index},'starts',this.value)"></label>
      <button class="btn btn--ghost btn--sm" onclick="delete adConfig.clips[${index}];saveAds();updateAdPlan()">Сбросить настройки клипа</button></div></details>`;
    events.forEach((event, eventIndex) => {
      const marker = document.createElement('span'); marker.className='ad-event'; marker.dataset.clip=index; marker.dataset.event=eventIndex;
      marker.style.left = `${event.start / resultDuration * 100}%`; marker.style.width = `${event.duration / resultDuration * 100}%`; marker.textContent = `${Math.round(event.start*100)/100}с`;
      const asset = bannerAssets.find(a=>a.id===event.assetId);
      if (!asset?.animated) {
        const handle=document.createElement('button'); handle.className='ad-event-end'; handle.dataset.resize='end'; handle.title='Потяни, чтобы изменить длительность изображения'; handle.setAttribute('aria-label','Изменить длительность статичного баннера'); marker.appendChild(handle);
      }
      marker.tabIndex=0; marker.setAttribute('role','button'); marker.setAttribute('aria-label',`Реклама ${eventIndex+1}, начало ${event.start.toFixed(2)} сек, длительность ${event.duration} сек. Перетащи для изменения времени.`);
      marker.title = `${bannerAssets.find(a => a.id === event.assetId)?.name}: ${event.start}–${event.start + event.duration} сек`;
      marker.onclick = () => { if (typeof timelineClickSuppressed==='function' && timelineClickSuppressed()) return; selectPreviewClip(index); seekStudio(event.start + Math.min(event.fade + .1, event.duration / 2)); };
      row.querySelector('.ad-track').appendChild(marker);
    });
    container.appendChild(row);
  });
}
function setClipAd(index, key, value) {
  if(typeof recordAdChange==='function')recordAdChange();
  const c = adConfig.clips[index] ||= {};
  if (value === '') delete c[key];
  else c[key] = key === 'starts' ? value.split(',').map(v => Number(v.trim())) : key === 'assetIds' ? [value] : Number(value);
  saveAds(); updateAdPlan();
}
function selectPreviewClip(index) { pauseStudioPlayback(); selectedClip = index; syncStudioPreview(); seekStudio(0); }
async function syncStudioPreview() {
  const video = document.getElementById('studio-video');
  if (!state.currentVideoId) { video.pause(); video.style.display = 'none'; document.getElementById('preview-empty').style.display = 'flex'; return; }
  if (previewSourceId !== state.currentVideoId) {
    const response = await fetch(`/api/videos/${state.currentVideoId}`); const data = await response.json();
    if (!response.ok || data.id !== state.currentVideoId) return;
    video.src = data.videoUrl; previewSourceId = data.id;
  }
  video.style.display = 'block'; document.getElementById('preview-empty').style.display = 'none';
  const output = state.selectedTemplate?.output;
  const ratio = output ? output.width / output.height : 9 / 16;
  const frame = document.getElementById('preview-frame');
  frame.style.aspectRatio = String(ratio); frame.style.width = ratio > 1 ? '100%' : '';
  document.getElementById('preview-ratio').textContent = output?.aspectRatio || '9:16';
  document.getElementById('preview-format').textContent = output ? `${output.width} × ${output.height}` : 'Вертикальный формат';
  const color = state.selectedTemplate?.colorCorrection || {};
  video.style.filter = `brightness(${1 + (color.brightness || 0)}) contrast(${color.contrast ?? 1}) saturate(${color.saturation ?? 1})`;
  applyPreviewFraming();
  const segment = state.segments[selectedClip];
  const duration = studioOutputDuration();
  document.getElementById('preview-seek').max = duration;
  document.getElementById('preview-clip-label').textContent = segment ? `КЛИП ${String(selectedClip + 1).padStart(2,'0')}` : 'ИСХОДНИК';
  paintPreview();
}
function seekStudio(seconds) {
  const video = document.getElementById('studio-video');
  if (!video.src) return;
  previewOutputTime = Math.max(0, Math.min(Number(seconds), studioOutputDuration()));
  previewTickTime = performance.now();
  applyStudioPlayback(); paintPreview();
}
// Speed from the framing settings: a clip of D source seconds plays for D / speed in the result.
function framingSpeed() { return Math.max(.25, Math.min(4, Number((typeof getFraming === 'function' && getFraming()?.speed) || 1))); }
function clipContentDuration(segment) { return (segment?.duration || 0) / framingSpeed(); }
function studioOutputDuration() { return AdSchedule.outputDuration((state.segments[selectedClip]?.duration || state.currentVideoInfo?.duration || 0) / framingSpeed(), adPlans[selectedClip]); }
function pauseStudioPlayback() {
  previewPlaying = false;
  if (previewAnimation !== null) cancelAnimationFrame(previewAnimation);
  previewAnimation = null;
  document.getElementById('studio-video').pause();
  document.getElementById('preview-ad-video').pause();
}
// Source sound follows the template volume; banner sound follows the ads setting.
function applyPreviewAudio() {
  const video = document.getElementById('studio-video');
  video.muted = !previewSound;
  video.volume = Math.max(0, Math.min(1, state.selectedTemplate?.audio?.volume ?? 1));
  document.getElementById('preview-ad-video').muted = !previewSound || adConfig.adAudio === false;
}
function paintSoundButton() {
  uiSetIcon('preview-sound', previewSound ? 'volume-up-fill' : 'volume-mute-fill');
  const button = document.getElementById('preview-sound');
  button.setAttribute('aria-pressed', String(previewSound));
  button.setAttribute('aria-label', previewSound ? 'Выключить звук' : 'Включить звук');
}
function toggleStudioSound() {
  previewSound = !previewSound;
  localStorage.setItem('vidcreator.previewSound', previewSound ? 'on' : 'off');
  applyPreviewAudio(); paintSoundButton();
}
function applyStudioPlayback() {
  const video = document.getElementById('studio-video');
  applyPreviewAudio();
  const source = AdSchedule.sourceAt(previewOutputTime, adPlans[selectedClip]);
  const target = (state.segments[selectedClip]?.start || 0) + source.time * framingSpeed();
  if (Math.abs(video.playbackRate - framingSpeed()) > .001) video.playbackRate = framingSpeed();
  if (source.frozen || !previewPlaying) {
    video.pause();
    if (Math.abs(video.currentTime - target) > .015) video.currentTime = target;
  } else {
    if (Math.abs(video.currentTime - target) > .2) video.currentTime = target;
    if (video.paused) video.play().catch(() => { pauseStudioPlayback(); paintPreview(); });
  }
}
function studioTick(now) {
  if (!previewPlaying) return;
  const source = AdSchedule.sourceAt(previewOutputTime, adPlans[selectedClip]);
  const video = document.getElementById('studio-video');
  // Do not consume content time while the local video is buffering or seeking.
  if (source.frozen || video.readyState >= 2 && !video.seeking) previewOutputTime += Math.max(0,now-previewTickTime)/1000;
  previewTickTime = now;
  if (previewOutputTime >= studioOutputDuration()) { previewOutputTime = studioOutputDuration(); pauseStudioPlayback(); }
  applyStudioPlayback(); paintPreview();
  if (previewPlaying) previewAnimation = requestAnimationFrame(studioTick);
}
function toggleStudioPlayback() {
  const video = document.getElementById('studio-video'); if (!video.src) return;
  if (previewPlaying) pauseStudioPlayback();
  else {
    if (previewOutputTime >= studioOutputDuration()) previewOutputTime = 0;
    previewPlaying = true; previewTickTime = performance.now(); applyStudioPlayback();
    previewAnimation = requestAnimationFrame(studioTick);
  }
  paintPreview();
}
function paintPreview() {
  const video = document.getElementById('studio-video');
  const segment = state.segments[selectedClip];
  const relative = previewOutputTime;
  const source = AdSchedule.sourceAt(relative, adPlans[selectedClip]);
  const duration = studioOutputDuration();
  document.getElementById('preview-clock').textContent = `${formatTime(relative).slice(3)} / ${formatTime(duration).slice(3)}`;
  document.getElementById('preview-seek').value = relative;
  uiSetIcon('preview-play',previewPlaying ? 'pause-fill' : 'play-fill');document.getElementById('preview-play').setAttribute('aria-label',previewPlaying?'Пауза':'Воспроизвести');
  document.getElementById('preview-play').setAttribute('aria-label',previewPlaying?'Пауза':'Воспроизвести');
  const event = AdSchedule.outputEvents(adPlans[selectedClip]).find(e => relative >= e.start && relative < e.start + e.duration);
  let canvasData = null;
  const image = document.getElementById('preview-ad-image'), motion = document.getElementById('preview-ad-video');
  image.style.display = 'none'; motion.style.display = 'none';
  if (event && adConfig.enabled) {
    const asset = bannerAssets.find(a => a.id === event.assetId);
    if (asset) {
      const isVideo = asset.animated && (!/\.gif$/i.test(asset.url) || asset.previewUrl); const el = isVideo ? motion : image;
      const mediaUrl = isVideo ? (asset.previewUrl || asset.url) : asset.url;
      if (el.getAttribute('src') !== mediaUrl) el.src = mediaUrl;
      const frame = document.getElementById('preview-frame');
      const placement = typeof canvasPlacement === 'function' ? canvasPlacement(event) : event;
      const w = Math.min(frame.clientWidth * placement.width / 100, frame.clientHeight * asset.width / asset.height);
      const h = w * asset.height / asset.width;
      const left = Math.max(0,Math.min(frame.clientWidth-w,frame.clientWidth*placement.x/100-w/2));
      const top = Math.max(0,Math.min(frame.clientHeight-h,frame.clientHeight*placement.y/100-h/2));
      const progress = event.fade ? Math.max(0,Math.min(1,(relative-event.start)/event.fade,(event.start+event.duration-relative)/event.fade)) : 1;
      const ease = progress*progress*(3-2*progress);
      const transform = event.animation === 'zoom' ? `scale(${.88+.12*ease})` : event.animation === 'slide-up' ? `translateY(${frame.clientHeight*.08*(1-ease)}px)` : event.animation === 'slide-left' ? `translateX(${frame.clientWidth*.1*(1-ease)}px)` : 'none';
      Object.assign(el.style, { display: 'block', width: `${w}px`, height: `${h}px`, left: `${left}px`, top: `${top}px`, opacity: event.opacity * progress, transform });
      styleBannerPreview(el, w, h, event.radius ?? adConfig.radius, event.shadow ?? adConfig.shadow, frame.clientWidth);
      canvasData = { left, top, width:w, height:h, event, asset, frameWidth:frame.clientWidth, frameHeight:frame.clientHeight };
      if (isVideo) {
        const t = Math.min(relative - event.start, Math.max(0,asset.duration-.001));
        motion.loop = false;
        if (Number.isFinite(t) && (previewAssetId !== asset.id || Math.abs(motion.currentTime - t) > (previewPlaying ? .25 : .015))) motion.currentTime = t;
        if (previewPlaying && motion.paused && !motion.ended) motion.play().catch(() => {});
        if (!previewPlaying) motion.pause();
      }
      previewAssetId = asset.id;
    }
  } else { motion.pause(); previewAssetId = null; }
  document.getElementById('preview-ad-status').textContent = event && adConfig.enabled ? (source.frozen ? 'СТОП-КАДР · РЕКЛАМА' : 'Рекламный показ') : adConfig.enabled ? 'Между показами' : 'Без рекламы';
  const textLayer = document.getElementById('preview-text');
  const template = state.selectedTemplate;
  const visibleTexts=(template?.textOverlays || []).filter(t => t.showFrom === undefined || source.time >= t.showFrom && source.time <= t.showTo);
  const textKey=JSON.stringify(visibleTexts)+document.getElementById('preview-frame').clientWidth;
  if(textLayer.dataset.renderKey!==textKey) {
  textLayer.dataset.renderKey=textKey; textLayer.replaceChildren();
  visibleTexts.forEach(text => {
    const el = document.createElement('span'); el.textContent = text.content; const scale = document.getElementById('preview-frame').clientWidth / (template.output?.width || 1080);
    Object.assign(el.style,{ position:'absolute', fontSize:`${(text.fontSize || 48)*scale}px`, color:text.fontColor || 'white', textShadow:'0 1px 2px black', whiteSpace:'nowrap', left: text.x?.includes('text_w') ? '50%' : `${(parseFloat(text.x)||0)*scale}px`, top:text.y?.includes('text_h') ? '50%' : `${(parseFloat(text.y)||0)*scale}px`, transform:text.x?.includes('text_w') ? 'translateX(-50%)' : '' }); textLayer.appendChild(el);
  });
  }
  if (typeof syncCanvasEditor === 'function') syncCanvasEditor(canvasData);
}
document.getElementById('studio-video').addEventListener('timeupdate', paintPreview);
['play','pause','seeked','loadedmetadata'].forEach(event => document.getElementById('studio-video').addEventListener(event, paintPreview));
window.addEventListener('resize', paintPreview);
const originalStartRender = startRender;
startRender = async function () {
  if (!updateAdPlan()) return;
  return originalStartRender();
};
function getAdConfig() { return adConfig; }
const engineHealth = async () => {
  try {
    const response = await fetch('/api/health'); const health = await response.json();
    document.querySelector('#engine-status span:last-child').textContent = health.ffmpeg && health.ffprobe ? 'FFmpeg готов к работе' : 'FFmpeg не найден';
    document.querySelector('#engine-status .status-pill__dot').style.background = health.ffmpeg && health.ffprobe ? '#a5d76a' : '#ef8a74';
  } catch { document.querySelector('#engine-status span:last-child').textContent = 'Сервер недоступен'; }
};
fetch('/api/banners').then(r => r.json()).then(assets => { bannerAssets = assets; renderAdEditor(); updateAdPlan(); }).catch(err => showToast('Библиотека баннеров: ' + err.message,'error'));
loadSourceLibrary().then(() => {
  const id = localStorage.getItem('vidcreator.source');
  if (id) restoreSource(id,true);
}); engineHealth();
function resetStudioSource() {
  localStorage.removeItem('vidcreator.source');
  previewSourceId = null; adPlans = []; state.segments = [];
  pauseStudioPlayback(); previewOutputTime = 0;
  const video = document.getElementById('studio-video'); video.pause(); video.removeAttribute('src'); video.load();
  syncStudioPreview(); paintPreview();
}

/* Step ruler: what each step already holds, which steps are reachable, and where the playhead stands. */
const plural = (n, one, few, many) => {
  const mod10 = n % 10, mod100 = n % 100;
  return `${n} ${mod10 === 1 && mod100 !== 11 ? one : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? few : many}`;
};
function studioStepReachable(n) {
  if (n <= 1) return true;
  if (!state.currentVideoId) return false;
  if (n === 2) return true;
  if (!state.selectedTemplateId) return false;
  return n === 3 || state.segments.length > 0;
}
function refreshStudioSteps() {
  const ads = adConfig.enabled ? (adConfig.assetIds.length ? plural(adConfig.assetIds.length, 'баннер', 'баннера', 'баннеров') : 'Нужен баннер') : 'Без рекламы';
  const notes = [
    state.currentVideoId ? formatTime(state.currentVideoInfo?.duration || 0) : 'Нет видео',
    state.selectedTemplate?.name || 'Не выбрано',
    state.segments.length ? plural(state.segments.length, 'клип', 'клипа', 'клипов') + (Math.abs(framingSpeed() - 1) > .001 ? ` · все ${String(Math.round(framingSpeed() * 100) / 100).replace('.', ',')}×` : '') : 'Не задана',
    ads,
  ];
  const done = [!!state.currentVideoId, !!state.selectedTemplateId, state.segments.length > 0, false];
  document.querySelectorAll('.studio-step').forEach((el, i) => {
    const n = i + 1, current = n === studioStepNumber, reachable = studioStepReachable(n);
    el.classList.toggle('done', done[i] && !current);
    el.classList.toggle('locked', !reachable);
    el.setAttribute('aria-disabled', String(!reachable));
    if (current) el.setAttribute('aria-current', 'step'); else el.removeAttribute('aria-current');
    const note = document.getElementById(`studio-step-note-${n}`);
    if (note) { note.textContent = notes[i]; note.title = notes[i]; }
  });
  document.getElementById('studio-steps-progress').style.transform = `translateX(${(studioStepNumber - 1) * 100}%)`;
  const chip = document.getElementById('studio-source-chip-text');
  if (chip) chip.textContent = state.currentVideoId ? 'Открыть в редакторе' : 'Открыть редактор';
}
const baseSyncStudioPreview = syncStudioPreview;
syncStudioPreview = function (...args) { refreshStudioSteps(); return baseSyncStudioPreview.apply(this, args); };
const baseUpdateAdPlan = updateAdPlan;
updateAdPlan = function (...args) { const result = baseUpdateAdPlan.apply(this, args); refreshStudioSteps(); return result; };
const baseDeselectTemplate = deselectTemplate;
deselectTemplate = function (...args) { baseDeselectTemplate.apply(this, args); refreshStudioSteps(); };
refreshStudioSteps();
setTimeout(() => document.body.classList.remove('booting'), 700);
paintSoundButton(); applyPreviewAudio();

/* Framing: zoom 0 shows the whole source, 1 fills the output frame, up to 1.5 zooms further in.
   Stored per source video; the same numbers drive the export (src/services/ffmpeg.js). */
const FRAMING_KEY = 'vidcreator.framing.v1';
const FRAMING_DEFAULT = { zoom: 1, x: .5, y: .5, background: 'blur', blur: 50, opacity: .8, radius: 0, shadow: 0, speed: 1 };
function framingStore() { try { return JSON.parse(localStorage.getItem(FRAMING_KEY)) || {}; } catch { return {}; } }
let framingDraft = null;
// null means "not customised": the template's own crop is used, as before.
function getFraming() { return framingDraft || (state.currentVideoId && framingStore()[state.currentVideoId]) || null; }
function framingGeometry(f = getFraming() || FRAMING_DEFAULT) {
  const frame = document.getElementById('preview-frame'), info = state.currentVideoInfo;
  if (!info?.width || !info?.height || !frame.clientWidth) return null;
  const fw = frame.clientWidth, fh = frame.clientHeight, fit = Math.min(fw / info.width, fh / info.height), fill = Math.max(fw / info.width, fh / info.height);
  const scale = fit * Math.pow(fill / fit, f.zoom), w = info.width * scale, h = info.height * scale;
  return { fw, fh, w, h, fit, scale, left: w > fw ? -(w - fw) * f.x : (fw - w) / 2, top: h > fh ? -(h - fh) * f.y : (fh - h) / 2 };
}
// Blur radius as a share of the frame width, so the preview and the 1080p export look alike.
const framingBlurPx = (f, width) => (f.blur ?? FRAMING_DEFAULT.blur) / 100 * .06 * width;
function applyPreviewFraming() {
  const video = document.getElementById('studio-video'), frame = document.getElementById('preview-frame');
  let bg = document.getElementById('preview-bg');
  if (!bg || bg.tagName !== 'CANVAS') {
    bg?.remove();
    bg = document.createElement('canvas'); bg.id = 'preview-bg'; bg.className = 'preview-bg'; bg.width = 96; bg.height = 170;
    frame.insertBefore(bg, video);
  }
  // Composition templates (reaction layout) draw their own preview; framing does not apply.
  const composed = typeof composedLayers === 'function' && !!composedLayers();
  const f = composed ? null : getFraming(), g = f && framingGeometry(f);
  frame.classList.toggle('framing-active', studioStepNumber === 2 && !!state.currentVideoId && !composed);
  if (!g) {
    ['position', 'left', 'top', 'width', 'height', 'objectFit', 'maxWidth'].forEach(key => { video.style[key] = ''; });
    const crop = state.selectedTemplate?.crop || {};
    video.style.objectPosition = `${crop.x && !/[a-z]/i.test(crop.x) ? '0%' : '50%'} ${crop.y && /[a-z]/i.test(crop.y) ? '50%' : '0%'}`;
    bg.style.display = 'none'; frame.style.background = '';
    video.style.clipPath = ''; const legacyShadow = document.getElementById('preview-shadow'); if (legacyShadow) legacyShadow.style.display = 'none';
    return;
  }
  Object.assign(video.style, { position: 'absolute', left: `${g.left}px`, top: `${g.top}px`, width: `${g.w}px`, height: `${g.h}px`, objectFit: 'fill', maxWidth: 'none', objectPosition: '' });
  // Rounded corners and the drop shadow apply to the visible part of the picture, as in the export.
  const vx0 = Math.max(0, g.left), vy0 = Math.max(0, g.top), vx1 = Math.min(g.fw, g.left + g.w), vy1 = Math.min(g.fh, g.top + g.h);
  const radiusPx = (f.radius || 0) / 100 * Math.min(vx1 - vx0, vy1 - vy0) / 2;
  video.style.clipPath = radiusPx > .5 ? `inset(${vy0 - g.top}px ${g.left + g.w - vx1}px ${g.top + g.h - vy1}px ${vx0 - g.left}px round ${radiusPx}px)` : '';
  let shadowEl = document.getElementById('preview-shadow');
  if (!shadowEl) { shadowEl = document.createElement('div'); shadowEl.id = 'preview-shadow'; shadowEl.className = 'preview-shadow'; frame.insertBefore(shadowEl, video); }
  if (f.shadow > 0) {
    const level = f.shadow / 100, sigma = g.fw * (.006 + .02 * level);
    Object.assign(shadowEl.style, { display: 'block', left: `${vx0}px`, top: `${vy0}px`, width: `${vx1 - vx0}px`, height: `${vy1 - vy0}px`, borderRadius: `${radiusPx}px`, boxShadow: `0 ${sigma * .6}px ${sigma * 2}px rgba(0,0,0,${(.2 + .5 * level).toFixed(2)})` });
  } else shadowEl.style.display = 'none';
  const uncovered = g.w < g.fw - 1 || g.h < g.fh - 1, showBlur = uncovered && f.background !== 'black';
  bg.style.display = showBlur ? 'block' : 'none';
  frame.style.background = uncovered ? '#000' : '';
  if (showBlur) {
    // Oversize the canvas by the blur radius so the soft edge stays outside the frame.
    const radius = framingBlurPx(f, g.fw), pad = Math.ceil(radius * 2);
    Object.assign(bg.style, { inset: `${-pad}px`, width: `${g.fw + pad * 2}px`, height: `${g.fh + pad * 2}px`, filter: radius > .2 ? `blur(${radius}px)` : 'none', opacity: f.opacity ?? FRAMING_DEFAULT.opacity });
    const ratio = g.fw / g.fh;
    if (Math.abs(bg.width / bg.height - ratio) > .01) { bg.width = 96; bg.height = Math.max(2, Math.round(96 / ratio)); }
    paintFramingBackground();
  }
}
// The background is the source itself, scaled to cover the whole frame; repainted as the video moves.
function paintFramingBackground() {
  const bg = document.getElementById('preview-bg'), video = document.getElementById('studio-video');
  if (!bg || bg.tagName !== 'CANVAS' || bg.style.display === 'none' || video.readyState < 2) return;
  const ctx = bg.getContext('2d'), vw = video.videoWidth, vh = video.videoHeight, cw = bg.width, ch = bg.height;
  if (!vw || !vh) return;
  const scale = Math.max(cw / vw, ch / vh), sw = cw / scale, sh = ch / scale;
  ctx.drawImage(video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, cw, ch);
}
function renderFramingControls() {
  const f = getFraming() || FRAMING_DEFAULT, g = framingGeometry(f);
  document.getElementById('framing-zoom').value = f.zoom;
  document.getElementById('framing-x').value = f.x;
  document.getElementById('framing-y').value = f.y;
  document.getElementById('framing-bg').value = f.background;
  document.getElementById('framing-zoom-label').textContent = !getFraming() ? 'Как в шаблоне' : f.zoom <= .001 ? 'Весь кадр' : Math.abs(f.zoom - 1) < .005 ? 'Заполнение' : g ? `${Math.round(g.scale / g.fit * 100)}%` : `${Math.round(f.zoom * 100)}%`;
  const blur = f.blur ?? FRAMING_DEFAULT.blur, opacity = f.opacity ?? FRAMING_DEFAULT.opacity;
  document.getElementById('framing-blur').value = blur;
  document.getElementById('framing-blur-label').textContent = blur ? `${Math.round(blur)}%` : 'Без размытия';
  document.getElementById('framing-opacity').value = opacity;
  document.getElementById('framing-opacity-label').textContent = `${Math.round(opacity * 100)}%`;
  document.getElementById('framing-blur-settings').hidden = f.background === 'black';
  const speed = f.speed ?? 1, radius = f.radius ?? 0, shadow = f.shadow ?? 0;
  document.getElementById('framing-speed').value = speed;
  document.getElementById('framing-speed-label').textContent = `${String(Math.round(speed * 100) / 100).replace('.', ',')}×`;
  const clip = state.segments[selectedClip];
  document.getElementById('framing-speed-note').textContent = Math.abs(speed - 1) < .001 ? 'Звук ускоряется без изменения тона. Длина клипов и время рекламы пересчитываются.'
    : `${speed > 1 ? 'Ускорение' : 'Замедление'}: ${clip ? `клип ${formatTime(clip.duration)} станет ${formatTime(clip.duration / speed)}` : 'длина клипов изменится'}. Звук без изменения тона, реклама — по новому времени.`;
  document.getElementById('framing-radius').value = radius;
  document.getElementById('framing-radius-label').textContent = radius ? `${Math.round(radius)}%` : 'Нет';
  document.getElementById('framing-shadow').value = shadow;
  document.getElementById('framing-shadow-label').textContent = shadow ? `${Math.round(shadow)}%` : 'Нет';
  document.querySelectorAll('.framing__preset[data-speed]').forEach(b => b.classList.toggle('active', Math.abs(Number(b.dataset.speed) - speed) < .001));
  // Pan only makes sense along an axis where the picture is larger than the frame.
  document.getElementById('framing-x').disabled = !g || g.w <= g.fw + 1;
  document.getElementById('framing-y').disabled = !g || g.h <= g.fh + 1;
  document.querySelectorAll('.framing__preset[data-zoom]').forEach(b => b.classList.toggle('active', !!getFraming() && Math.abs(Number(b.dataset.zoom) - f.zoom) < .005));
  document.getElementById('framing-panel').classList.toggle('disabled', !state.currentVideoId);
}
function setFraming(patch, persist = true) {
  if (!state.currentVideoId) return;
  const previousSpeed = framingSpeed();
  framingDraft = { ...FRAMING_DEFAULT, ...getFraming(), ...patch };
  // A new speed changes every clip's length: reschedule the ads and keep the playhead in range.
  if (Math.abs(framingSpeed() - previousSpeed) > .001) { saveFraming(); pauseStudioPlayback(); updateAdPlan(); syncStudioPreview(); seekStudio(Math.min(previewOutputTime, studioOutputDuration())); if (state.segments.length) renderSegmentsGrid(state.segments); refreshStudioSteps(); }
  applyPreviewFraming(); renderFramingControls(); paintPreview();
  if (persist) saveFraming();
}
function saveFraming() {
  if (!framingDraft || !state.currentVideoId) return;
  const store = framingStore(); store[state.currentVideoId] = framingDraft;
  localStorage.setItem(FRAMING_KEY, JSON.stringify(store));
  framingDraft = null;
}
function resetFraming() {
  if (!state.currentVideoId) return;
  framingDraft = null;
  const store = framingStore(); delete store[state.currentVideoId];
  localStorage.setItem(FRAMING_KEY, JSON.stringify(store));
  applyPreviewFraming(); renderFramingControls(); paintPreview();
}
// Drag the picture to pan and use the wheel to zoom, directly in the preview, on the framing step.
(() => {
  const frame = document.getElementById('preview-frame');
  let drag = null;
  frame.addEventListener('pointerdown', event => {
    if (studioStepNumber !== 2 || !state.currentVideoId || (typeof composedLayers === 'function' && composedLayers()) || event.button !== 0) return;
    const g = framingGeometry(); if (!g) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, g, start: { ...FRAMING_DEFAULT, ...getFraming() } };
    try { frame.setPointerCapture(event.pointerId); } catch { /* pointer already released */ }
    frame.classList.add('dragging');
  });
  frame.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    const { g, start } = drag, patch = {};
    if (g.w > g.fw) patch.x = Math.max(0, Math.min(1, start.x - (event.clientX - drag.x) / (g.w - g.fw)));
    if (g.h > g.fh) patch.y = Math.max(0, Math.min(1, start.y - (event.clientY - drag.y) / (g.h - g.fh)));
    if (Object.keys(patch).length) setFraming(patch, false);
  });
  const end = event => { if (!drag || event.pointerId !== drag.id) return; drag = null; frame.classList.remove('dragging'); saveFraming(); };
  frame.addEventListener('pointerup', end); frame.addEventListener('pointercancel', end);
  let wheelTimer = null;
  frame.addEventListener('wheel', event => {
    if (studioStepNumber !== 2 || !state.currentVideoId || (typeof composedLayers === 'function' && composedLayers())) return;
    event.preventDefault();
    const zoom = Math.max(0, Math.min(1.5, (getFraming() || FRAMING_DEFAULT).zoom - event.deltaY * .0015));
    setFraming({ zoom }, false);
    clearTimeout(wheelTimer); wheelTimer = setTimeout(saveFraming, 300);
  }, { passive: false });
  window.addEventListener('resize', () => { applyPreviewFraming(); renderFramingControls(); });
  // Keep the blurred background in step with the picture: playback frames, seeks and the first frame.
  const video = document.getElementById('studio-video');
  ['timeupdate', 'seeked', 'loadeddata'].forEach(name => video.addEventListener(name, paintFramingBackground));
  video.addEventListener('loadedmetadata', () => { applyPreviewFraming(); renderFramingControls(); });
})();
// Smooth repaint during playback (timeupdate fires only ~4 times a second).
const basePaintForFraming = paintPreview;
paintPreview = function (...args) { const result = basePaintForFraming.apply(this, args); if (previewPlaying) paintFramingBackground(); return result; };
const baseSyncForFraming = syncStudioPreview;
syncStudioPreview = function (...args) { framingDraft = null; const result = baseSyncForFraming.apply(this, args); renderFramingControls(); return result; };
renderFramingControls();

// Banner corners and shadow in the preview use the same proportions as the export.
function styleBannerPreview(el, w, h, radius = 0, shadow = 0, frameWidth) {
  el.style.borderRadius = radius > 0 ? `${radius / 100 * Math.min(w, h) / 2}px` : '';
  const level = shadow / 100, sigma = frameWidth * (.006 + .02 * level);
  el.style.boxShadow = shadow > 0 ? `0 ${sigma * .6}px ${sigma * 2}px rgba(0,0,0,${(.2 + .5 * level).toFixed(2)})` : '';
}
// While a slider is being dragged, show the look right away without rescheduling the ads.
function adPreviewStyle(patch) {
  const frame = document.getElementById('preview-frame');
  ['preview-ad-image', 'preview-ad-video'].forEach(id => {
    const el = document.getElementById(id);
    if (el.style.display === 'none') return;
    styleBannerPreview(el, el.offsetWidth, el.offsetHeight, patch.radius ?? adConfig.radius ?? 0, patch.shadow ?? adConfig.shadow ?? 0, frame.clientWidth);
  });
}

// Export frame rate: 30 by default (half the work for 60 fps recordings), 60 or the source rate on demand.
function getExportFps() { const v = localStorage.getItem('vidcreator.export.fps'); return v === null ? 30 : Number(v); }
function setExportFps(value) { localStorage.setItem('vidcreator.export.fps', String(Number(value) || 0)); }
const baseRenderAdEditorForFps = renderAdEditor;
renderAdEditor = function (...args) { const result = baseRenderAdEditorForFps.apply(this, args); const select = document.getElementById('export-fps'); if (select) select.value = String(getExportFps()); return result; };
