/* Reaction templates in the studio ("webcam on top, video below"). The template holds a composition of
   source regions; for each video the person marks where the streamer's webcam and the video are on the
   recording. Stored per video in localStorage and sent with the render (src/routes/render.js). */
const REACTION_KEY = 'vidcreator.reaction.v1';
let reactionDraft = null;

function reactionTemplate() { const t = state.selectedTemplate; return t?.composition && t.reaction ? t : null; }
function reactionStore() { try { return JSON.parse(localStorage.getItem(REACTION_KEY)) || {}; } catch { return {}; } }
function reactionDefaults(t = reactionTemplate()) {
  const layer = id => t?.composition.layers.find(l => l.id === id);
  return { camera: { ...(layer('camera')?.crop || { x: .727, y: .725, w: .263, h: .272 }) }, content: { ...(layer('content')?.crop || { x: 0, y: 0, w: 1, h: 1 }) }, split: layer('camera')?.rect?.h ?? .4 };
}
function getReaction() {
  if (!reactionTemplate()) return null;
  return reactionDraft || (state.currentVideoId && reactionStore()[state.currentVideoId]) || reactionDefaults();
}
function getReactionForRender() { return reactionTemplate() ? getReaction() : undefined; }

const clampRect = r => {
  const w = Math.max(.04, Math.min(1, r.w)), h = Math.max(.04, Math.min(1, r.h));
  return { w, h, x: Math.max(0, Math.min(1 - w, r.x)), y: Math.max(0, Math.min(1 - h, r.y)) };
};
function setReaction(patch, persist = true) {
  if (!reactionTemplate() || !state.currentVideoId) return;
  const next = { ...getReaction(), ...patch };
  next.camera = clampRect(next.camera); next.content = clampRect(next.content);
  reactionDraft = next;
  renderReactionPanel(); paintComposition();
  if (persist) saveReaction();
}
function saveReaction() {
  if (!reactionDraft || !state.currentVideoId) return;
  const store = reactionStore(); store[state.currentVideoId] = reactionDraft;
  localStorage.setItem(REACTION_KEY, JSON.stringify(store));
  reactionDraft = null;
}
function resetReaction() {
  if (!state.currentVideoId) return;
  const store = reactionStore(); delete store[state.currentVideoId];
  localStorage.setItem(REACTION_KEY, JSON.stringify(store));
  reactionDraft = null;
  renderReactionPanel(); paintComposition();
}
// Typical webcam spots: keep the current size, move to the chosen corner.
function placeReactionCamera(corner) {
  const c = getReaction()?.camera; if (!c) return;
  const m = .008;
  setReaction({ camera: { w: c.w, h: c.h, x: corner.includes('r') ? 1 - c.w - m : m, y: corner.includes('b') ? 1 - c.h - m : m } });
}

/** Template layers with this video's regions applied (same mapping as the server). */
function composedLayers() {
  const t = state.selectedTemplate;
  if (!t?.composition) return null;
  const r = getReaction();
  return t.composition.layers.map(layer => {
    if (!r) return layer;
    if (layer.id === 'camera') return { ...layer, crop: r.camera, rect: { x: 0, y: 0, w: 1, h: r.split } };
    if (layer.id === 'content') return { ...layer, crop: r.content, rect: { x: 0, y: r.split, w: 1, h: 1 - r.split } };
    return layer;
  });
}

/* ---------- Preview: draw the composed 9:16 frame on a canvas over the (hidden) source video ---------- */
function paintComposition() {
  const frame = document.getElementById('preview-frame'), video = document.getElementById('studio-video');
  let canvas = document.getElementById('preview-compose');
  if (!canvas) { canvas = document.createElement('canvas'); canvas.id = 'preview-compose'; canvas.className = 'preview-compose'; video.after(canvas); }
  const layers = state.currentVideoId ? composedLayers() : null;
  if (!layers) { canvas.style.display = 'none'; video.style.opacity = ''; return; }
  canvas.style.display = 'block'; video.style.opacity = '0';
  const fw = frame.clientWidth, fh = frame.clientHeight, dpr = Math.min(2, window.devicePixelRatio || 1);
  if (canvas.width !== Math.round(fw * dpr) || canvas.height !== Math.round(fh * dpr)) { canvas.width = Math.round(fw * dpr); canvas.height = Math.round(fh * dpr); }
  const ctx = canvas.getContext('2d'), W = canvas.width, H = canvas.height;
  ctx.filter = 'none';
  ctx.fillStyle = state.selectedTemplate.composition.background || '#000'; ctx.fillRect(0, 0, W, H);
  if (video.readyState < 2 || !video.videoWidth) return;
  const vw = video.videoWidth, vh = video.videoHeight, color = state.selectedTemplate.colorCorrection || {};
  ctx.filter = `brightness(${1 + (color.brightness || 0)}) contrast(${color.contrast ?? 1}) saturate(${color.saturation ?? 1})`;
  layers.forEach(layer => {
    if (!layer.enabled) return;
    const c = layer.crop, r = layer.rect, dx = r.x * W, dy = r.y * H, dw = r.w * W, dh = r.h * H;
    let sx = c.x * vw, sy = c.y * vh, sw = c.w * vw, sh = c.h * vh, tx = dx, ty = dy, tw = dw, th = dh;
    if (layer.fit === 'contain') { const s = Math.min(dw / sw, dh / sh); tw = sw * s; th = sh * s; tx += (dw - tw) / 2; ty += (dh - th) / 2; }
    else if (sw / sh > dw / dh) { const nw = sh * dw / dh; sx += (sw - nw) / 2; sw = nw; }
    else { const nh = sw * dh / dw; sy += (sh - nh) / 2; sh = nh; }
    ctx.save(); ctx.globalAlpha = layer.opacity ?? 1;
    ctx.beginPath();
    if (layer.mask === 'circle') ctx.ellipse(dx + dw / 2, dy + dh / 2, dw / 2, dh / 2, 0, 0, Math.PI * 2);
    else if (layer.mask === 'rounded') ctx.roundRect(dx, dy, dw, dh, Math.min(dw, dh) * .08);
    else ctx.rect(dx, dy, dw, dh);
    ctx.clip();
    if (layer.flip) { ctx.translate(dx * 2 + dw, 0); ctx.scale(-1, 1); }
    ctx.drawImage(video, sx, sy, sw, sh, tx, ty, tw, th);
    ctx.restore();
  });
}

/* ---------- Panel: the whole source frame with the two draggable regions ---------- */
function drawReactionStage() {
  const canvas = document.getElementById('reaction-canvas'), video = document.getElementById('studio-video');
  if (document.getElementById('reaction-panel').hidden || video.readyState < 2 || !video.videoWidth) return;
  const w = 640, h = Math.round(640 * video.videoHeight / video.videoWidth);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  canvas.getContext('2d').drawImage(video, 0, 0, w, h);
}
function renderReactionPanel() {
  const panel = document.getElementById('reaction-panel'), active = !!reactionTemplate() && !!state.currentVideoId;
  panel.hidden = !active;
  // The reaction layout replaces zoom/pan/background; only the speed stays from "Кадрирование".
  const framing = document.getElementById('framing-panel');
  framing.classList.toggle('speed-only', active);
  document.getElementById('framing-title').textContent = active ? 'Скорость видео' : 'Кадрирование';
  if (!active) return;
  const r = getReaction(), info = state.currentVideoInfo;
  if (info?.width && info?.height) document.getElementById('reaction-stage').style.aspectRatio = `${info.width} / ${info.height}`;
  panel.querySelectorAll('.reaction__box').forEach(box => {
    const rect = r[box.dataset.box];
    Object.assign(box.style, { left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` });
  });
  document.getElementById('reaction-split').value = r.split;
  document.getElementById('reaction-split-label').textContent = `${Math.round(r.split * 100)}%`;
  drawReactionStage();
}
(() => {
  const stage = document.getElementById('reaction-stage');
  let drag = null;
  stage.addEventListener('pointerdown', event => {
    const box = event.target.closest('.reaction__box'); if (!box || event.button !== 0) return;
    event.preventDefault();
    drag = { id: event.pointerId, box: box.dataset.box, corner: event.target.dataset.corner || null, x: event.clientX, y: event.clientY, start: { ...getReaction()[box.dataset.box] } };
    try { stage.setPointerCapture(event.pointerId); } catch {}
    box.classList.add('dragging');
  });
  stage.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = (event.clientX - drag.x) / stage.clientWidth, dy = (event.clientY - drag.y) / stage.clientHeight, s = drag.start;
    let rect = { ...s };
    if (!drag.corner) rect = { ...s, x: s.x + dx, y: s.y + dy };
    else {
      if (drag.corner.includes('w')) { rect.x = Math.min(s.x + s.w - .04, s.x + dx); rect.w = s.w + (s.x - rect.x); }
      if (drag.corner.includes('e')) rect.w = s.w + dx;
      if (drag.corner.includes('n')) { rect.y = Math.min(s.y + s.h - .04, s.y + dy); rect.h = s.h + (s.y - rect.y); }
      if (drag.corner.includes('s')) rect.h = s.h + dy;
    }
    setReaction({ [drag.box]: rect }, false);
  });
  const end = event => {
    if (!drag || event.pointerId !== drag.id) return;
    stage.querySelectorAll('.reaction__box').forEach(b => b.classList.remove('dragging'));
    drag = null; saveReaction();
  };
  stage.addEventListener('pointerup', end); stage.addEventListener('pointercancel', end);
  // Arrow keys nudge the focused region (Shift for bigger steps).
  stage.addEventListener('keydown', event => {
    const box = event.target.closest('.reaction__box'); if (!box || !event.key.startsWith('Arrow')) return;
    event.preventDefault();
    const step = event.shiftKey ? .02 : .004, rect = { ...getReaction()[box.dataset.box] };
    if (event.key === 'ArrowLeft') rect.x -= step; if (event.key === 'ArrowRight') rect.x += step;
    if (event.key === 'ArrowUp') rect.y -= step; if (event.key === 'ArrowDown') rect.y += step;
    setReaction({ [box.dataset.box]: rect });
  });

  const video = document.getElementById('studio-video');
  ['seeked', 'loadeddata', 'timeupdate'].forEach(name => video.addEventListener(name, () => { paintComposition(); if (!previewPlaying) drawReactionStage(); }));
  window.addEventListener('resize', paintComposition);
})();

// Keep the composed preview in step with every repaint and source/template change.
const basePaintForReaction = paintPreview;
paintPreview = function (...args) { const result = basePaintForReaction.apply(this, args); paintComposition(); return result; };
const baseSyncForReaction = syncStudioPreview;
syncStudioPreview = function (...args) {
  reactionDraft = null;
  const result = baseSyncForReaction.apply(this, args);
  renderReactionPanel(); paintComposition();
  return result;
};
renderReactionPanel();
