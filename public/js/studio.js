/* Local creator workspace; 21st.dev sidebar adapted to the existing vanilla app. */
let adConfig;
try { adConfig = JSON.parse(localStorage.getItem('vidcreator.ads.v1')); } catch {}
adConfig = { enabled: false, freezeOnAd: true, assetIds: [], count: 2, duration: 6, firstStart: 26, minGap: 8, endPadding: 3, width: 90, x: 50, y: 48, opacity: 1, fade: .3, animation: 'fade', rotation: 'clip', clips: {}, ...adConfig };
let bannerAssets = [], adPlans = [], selectedClip = 0, studioStepNumber = 1, previewSourceId = null, previewAssetId = null;
let sliceRequestVersion = 0;
let previewOutputTime = 0, previewPlaying = false, previewTickTime = 0, previewAnimation = null;
const originalActivateStep = activateStep;
activateStep = function (n) {
  studioStepNumber = n;
  originalActivateStep(n);
  document.querySelectorAll('.studio-step').forEach((el, i) => el.classList.toggle('active', i === n - 1));
  document.getElementById('studio-panel-title').textContent = ['Добавь исходное видео', 'Задай стиль своим клипам', 'Собери свою серию', 'Реклама под твоим контролем'][n - 1];
  document.getElementById('studio-step-count').textContent = `ШАГ 0${n} / 04`;
  if (n === 4) { renderAdEditor(); updateAdPlan(); }
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
  if (state.sliceMode === 'auto') return { mode: 'auto', segmentDuration: Number(document.getElementById('segment-duration').value), overlap: Number(document.getElementById('segment-overlap').value) };
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
        if (templateResponse.ok) await selectTemplate(templateId);
      }
      let slice;
      try { slice = JSON.parse(localStorage.getItem('vidcreator.slice')); } catch {}
      if (slice) {
        document.getElementById('segment-duration').value = slice.segmentDuration ?? 120;
        document.getElementById('segment-overlap').value = slice.overlap ?? 0;
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
    <p class="ad-help">PNG с прозрачностью, JPG, WebP, GIF, MP4, WebM, MOV · до 100 МБ. Баннеры воспроизводятся без звука.</p>
    <div class="ad-library" id="ad-library"></div>
    <div class="ad-fields" ${adConfig.enabled ? '' : 'hidden'}>
    <label class="ad-toggle"><input id="ad-freeze" type="checkbox" ${adConfig.freezeOnAd ? 'checked' : ''} onchange="adSet('freezeOnAd',this.checked)">Стоп-кадр и пауза звука на время рекламы</label>
    <p class="ad-help">После баннера видео и звук продолжаются с того же места. Длительность клипа увеличивается на время рекламных показов.</p>
    <div class="form-row">${adNumber('ad-count','Показов в каждом клипе','count',0,20)}${adNumber('ad-duration','Показ PNG / JPG, сек','duration',.2,120,.1)}</div>
    <p class="ad-help">Видеобаннеры и GIF проигрываются один раз по длине файла. Стоп-кадр подстраивается под каждый баннер автоматически.</p>
    <div class="form-row">${adNumber('ad-first','Первый показ, сек','firstStart',0,86400,.1)}${adNumber('ad-gap','Минимальная пауза, сек','minGap',0,3600,.1)}</div>
    <div class="form-row">${adNumber('ad-end','Отступ от конца, сек','endPadding',0,3600,.1)}<div class="form-group"><label class="form-label" for="ad-rotation">Чередование баннеров</label><select id="ad-rotation" class="form-select" onchange="adSet('rotation',this.value)"><option value="clip">Один баннер на клип</option><option value="show">Каждый показ — следующий</option><option value="fixed">Первый баннер для всех</option></select></div></div>
    <div class="form-row"><div class="form-group"><label class="form-label" for="ad-animation">Появление и уход</label><select id="ad-animation" class="form-select" onchange="adSet('animation',this.value)"><option value="fade">Плавное затухание</option><option value="slide-up">Слайд снизу</option><option value="slide-left">Слайд справа</option><option value="zoom">Мягкое масштабирование</option><option value="none">Без анимации</option></select></div>${adNumber('ad-fade','Длительность входа / ухода, сек','fade',0,3,.05)}</div>
    <button class="btn btn--secondary" onclick="editBannerOnCanvas()">${uiIcon("cursor-fill")} Изменить баннер в кадре</button>
    <details class="ad-advanced"><summary class="ad-help">Точные параметры размера и позиции</summary>
    <div class="form-row">${adNumber('ad-width','Ширина, % кадра','width',10,100)}${adNumber('ad-opacity','Непрозрачность, 0–1','opacity',0,1,.05)}</div>
    <div class="form-row">${adNumber('ad-x','Центр по горизонтали, %','x',0,100)}${adNumber('ad-y','Центр по вертикали, %','y',0,100)}</div>
    </details>
    <p class="ad-help">Время показов задаётся по исходному содержимому каждой нарезки. При стоп-кадре дальнейшие моменты сдвигаются на время пауз; дорожка ниже показывает итоговое видео.</p></div>
    <div id="ad-validation" role="status" aria-live="polite"></div><div id="ad-clips"></div>
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
    adPlans = AdSchedule.plan(adConfig, state.segments, id => bannerAssets.find(a=>a.id===id));
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
    const resultDuration = AdSchedule.outputDuration(segment.duration, sourceEvents);
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
  const crop = state.selectedTemplate?.crop || {};
  video.style.objectPosition = `${crop.x && !/[a-z]/i.test(crop.x) ? '0%' : '50%'} ${crop.y && /[a-z]/i.test(crop.y) ? '50%' : '0%'}`;
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
function studioOutputDuration() { return AdSchedule.outputDuration(state.segments[selectedClip]?.duration || state.currentVideoInfo?.duration || 0, adPlans[selectedClip]); }
function pauseStudioPlayback() {
  previewPlaying = false;
  if (previewAnimation !== null) cancelAnimationFrame(previewAnimation);
  previewAnimation = null;
  document.getElementById('studio-video').pause();
  document.getElementById('preview-ad-video').pause();
}
function applyStudioPlayback() {
  const video = document.getElementById('studio-video');
  const source = AdSchedule.sourceAt(previewOutputTime, adPlans[selectedClip]);
  const target = (state.segments[selectedClip]?.start || 0) + source.time;
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
