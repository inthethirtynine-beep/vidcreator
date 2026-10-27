/* Pointer gestures commit once on release; no network, storage or list rebuilds while dragging. */
let canvasScope = 'all', canvasData = null, canvasGesture = null, canvasPointerFrame = null;
let timelineGesture = null, timelinePointerFrame = null, suppressTimelineClickUntil = 0;
const adUndo = [], adRedo = [];
const previewFrame = document.getElementById('preview-frame');
const selection = document.createElement('div');
selection.id = 'banner-selection'; selection.className = 'banner-selection'; selection.tabIndex = 0;
selection.setAttribute('role','group'); selection.setAttribute('aria-label','Баннер: перетащи для перемещения, стрелки для точной настройки');
selection.innerHTML = `<div class="selection-caption">БАННЕР <span id="selection-size"></span></div>${['nw','ne','sw','se'].map(c=>`<button class="selection-handle selection-handle--${c}" data-corner="${c}" aria-label="Изменить размер баннера: ${c}" title="Потяни за угол, чтобы изменить размер"></button>`).join('')}`;
previewFrame.appendChild(selection);
const guideX = document.createElement('div'), guideY = document.createElement('div');
guideX.className='canvas-guide canvas-guide--x'; guideY.className='canvas-guide canvas-guide--y';
previewFrame.append(guideX,guideY);
const toolbar = document.createElement('div'); toolbar.className='canvas-toolbar';
toolbar.innerHTML = `<button id="canvas-edit" class="canvas-tool" title="Выбрать баннер в кадре" onclick="editBannerOnCanvas()">${uiIcon("cursor-fill")}</button><select id="canvas-scope" aria-label="Применить положение баннера" onchange="canvasScope=this.value;syncCanvasInspector()"><option value="all">Все клипы</option><option value="clip">Этот клип</option></select><span class="canvas-tool-divider"></span><button id="canvas-undo" class="canvas-tool" onclick="undoAdEdit()" title="Отменить · Ctrl+Z" aria-label="Отменить изменение">${uiIcon("reply-fill")}</button><button id="canvas-redo" class="canvas-tool" onclick="redoAdEdit()" title="Повторить · Ctrl+Shift+Z" aria-label="Повторить изменение">${uiIcon("forward-fill")}</button><button class="canvas-tool" onclick="replayBannerAnimation()" title="Проиграть появление и уход баннера" aria-label="Показать анимацию баннера">${uiIcon("clock-fill")}</button>`;
document.querySelector('.preview-panel .panel-heading').after(toolbar);
const tools = document.createElement('div'); tools.className='canvas-bottom-tools';
tools.innerHTML=`<span>Перетащи баннер · размер за углы</span><div><button class="canvas-tool" onclick="resizeSelectedBanner(-5)" aria-label="Уменьшить баннер">${uiIcon("dash-circle-fill")}</button><button class="canvas-tool" onclick="centerSelectedBanner()" title="Выровнять баннер по центру">Центр</button><button class="canvas-tool" onclick="resizeSelectedBanner(5)" aria-label="Увеличить баннер">${uiIcon("plus-circle-fill")}</button></div>`;
document.querySelector('.preview-panel .preview-controls').before(tools);
function copyAdState() { return structuredClone(adConfig); }
function recordAdChange(snapshot = copyAdState()) {
  adUndo.push(snapshot); if(adUndo.length>50) adUndo.shift(); adRedo.length=0; updateUndoButtons();
}
function updateUndoButtons() {
  document.getElementById('canvas-undo').disabled=!adUndo.length;
  document.getElementById('canvas-redo').disabled=!adRedo.length;
}
function restoreAdEdit(snapshot) {
  pauseStudioPlayback(); adConfig=structuredClone(snapshot); saveAds(); renderAdEditor(); updateAdPlan(); syncCanvasInspector();
}
function undoAdEdit() { if(!adUndo.length) return; adRedo.push(copyAdState()); restoreAdEdit(adUndo.pop()); updateUndoButtons(); }
function redoAdEdit() { if(!adRedo.length) return; adUndo.push(copyAdState()); restoreAdEdit(adRedo.pop()); updateUndoButtons(); }
function setScopedAdValue(key,value) {
  if(canvasScope==='clip') (adConfig.clips[selectedClip] ||= {})[key]=value;
  else {
    adConfig[key]=value;
    for(const clip of Object.values(adConfig.clips)) delete clip[key];
  }
}
function syncCanvasInspector() {
  const effective=canvasScope==='clip'?{...adConfig,...adConfig.clips[selectedClip]}:adConfig;
  for(const key of ['x','y','width','opacity','animation','fade']) {
    const el=document.getElementById(`ad-${key}`); if(el) el.value=effective[key];
  }
}
function canvasPlacement(event) { return canvasGesture?.placement || event; }
function syncCanvasEditor(data) {
  canvasData=data;
  const editable=!!data && !previewPlaying && studioStepNumber===4 && state.currentPage==='home';
  selection.style.display=editable?'block':'none';
  toolbar.style.display=studioStepNumber===4?'flex':'none';
  tools.style.display=studioStepNumber===4?'flex':'none';
  if(!editable) { guideX.style.display='none'; guideY.style.display='none'; return; }
  Object.assign(selection.style,{width:`${data.width}px`,height:`${data.height}px`,transform:`translate3d(${data.left}px,${data.top}px,0)`});
  document.getElementById('selection-size').textContent=`${Math.round(data.width/data.frameWidth*100)}%`;
}
function editBannerOnCanvas() {
  if(!adConfig.enabled) return showToast('Сначала включи рекламу и выбери баннер','info');
  const events=AdSchedule.outputEvents(adPlans[selectedClip]);
  const event=events.find(e=>previewOutputTime>=e.start&&previewOutputTime<e.start+e.duration)||events[0];
  if(!event) return showToast('Выбери баннер и проверь расписание','info');
  pauseStudioPlayback(); seekStudio(event.start+Math.min(event.fade+.1,event.duration/2));
  selection.focus({preventScroll:true}); syncCanvasInspector();
}
function replayBannerAnimation() {
  const events=AdSchedule.outputEvents(adPlans[selectedClip]);
  const event=events.find(e=>previewOutputTime>=e.start&&previewOutputTime<e.start+e.duration)||events[0];
  if(!event) return;
  pauseStudioPlayback(); seekStudio(event.start); toggleStudioPlayback();
}
function commitBannerPlacement(placement, snapshot) {
  recordAdChange(snapshot);
  for(const key of ['x','y','width']) setScopedAdValue(key,Math.round(placement[key]*100)/100);
  saveAds(); updateAdPlan(); syncCanvasInspector();
}
function centerSelectedBanner() {
  editBannerOnCanvas(); if(!canvasData) return;
  commitBannerPlacement({...canvasData.event,x:50,y:50},copyAdState());
}
function resizeSelectedBanner(delta) {
  editBannerOnCanvas(); if(!canvasData) return;
  commitBannerPlacement({...canvasData.event,width:Math.max(10,Math.min(100,canvasData.event.width+delta))},copyAdState());
}
selection.addEventListener('pointerdown',event=>{
  if(event.button!==0 || !canvasData) return;
  event.preventDefault(); event.stopPropagation(); pauseStudioPlayback();
  selection.setPointerCapture(event.pointerId);
  canvasGesture={pointerId:event.pointerId,startX:event.clientX,startY:event.clientY,corner:event.target.dataset.corner,base:{...canvasData},snapshot:copyAdState(),placement:{...canvasData.event},moved:false};
  selection.classList.add('is-dragging'); selection.focus({preventScroll:true});
});
function updateCanvasGesture(event) {
  const g=canvasGesture; if(!g) return;
  const dx=event.clientX-g.startX,dy=event.clientY-g.startY,b=g.base;
  g.moved ||= Math.abs(dx)+Math.abs(dy)>1;
  let left=b.left,top=b.top,width=b.width,height=b.height;
  if(g.corner) {
    const sx=g.corner.includes('w')?-1:1,sy=g.corner.includes('n')?-1:1;
    const aspect=b.asset.width/b.asset.height;
    width=Math.max(b.frameWidth*.1,Math.min(b.frameWidth,b.frameHeight*aspect,b.width+(sx*dx+sy*dy*aspect)/2)); height=width/aspect;
    if(sx<0) left=b.left+b.width-width;
    if(sy<0) top=b.top+b.height-height;
  } else { left+=dx;top+=dy; }
  left=Math.max(0,Math.min(b.frameWidth-width,left)); top=Math.max(0,Math.min(b.frameHeight-height,top));
  let x=(left+width/2)/b.frameWidth*100,y=(top+height/2)/b.frameHeight*100;
  const snapX=Math.abs(x-50)*b.frameWidth/100<5, snapY=Math.abs(y-50)*b.frameHeight/100<5;
  if(!event.altKey && snapX) x=50;
  if(!event.altKey && snapY) y=50;
  guideX.style.display=!event.altKey&&snapX?'block':'none'; guideY.style.display=!event.altKey&&snapY?'block':'none';
  g.placement={...b.event,x,y,width:width/b.frameWidth*100}; paintPreview();
}
selection.addEventListener('pointermove',event=>{
  if(!canvasGesture) return;
  canvasGesture.pending={clientX:event.clientX,clientY:event.clientY,altKey:event.altKey};
  if(canvasPointerFrame===null) canvasPointerFrame=requestAnimationFrame(()=>{canvasPointerFrame=null;if(canvasGesture) updateCanvasGesture(canvasGesture.pending);});
});
function finishCanvasGesture(cancel=false,event) {
  const g=canvasGesture;if(!g)return;
  if(event && !cancel) updateCanvasGesture(event);
  if(canvasPointerFrame!==null) cancelAnimationFrame(canvasPointerFrame);canvasPointerFrame=null;
  canvasGesture=null;selection.classList.remove('is-dragging');guideX.style.display='none';guideY.style.display='none';
  if(selection.hasPointerCapture(g.pointerId)) selection.releasePointerCapture(g.pointerId);
  if(!cancel&&g.moved) commitBannerPlacement(g.placement,g.snapshot); else paintPreview();
}
selection.addEventListener('pointerup',event=>finishCanvasGesture(false,event));
selection.addEventListener('pointercancel',()=>finishCanvasGesture(true));
selection.addEventListener('keydown',event=>{
  if(!canvasData || !['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','=','-'].includes(event.key))return;
  event.preventDefault(); const p={...canvasData.event},step=event.shiftKey?5:1;
  if(event.target.dataset.corner && event.key.startsWith('Arrow')) p.width=Math.max(10,Math.min(100,p.width+(['ArrowRight','ArrowDown'].includes(event.key)?step:-step)));
  else {
    if(event.key==='ArrowLeft')p.x=Math.max(0,p.x-step);
    if(event.key==='ArrowRight')p.x=Math.min(100,p.x+step);
    if(event.key==='ArrowUp')p.y=Math.max(0,p.y-step);
    if(event.key==='ArrowDown')p.y=Math.min(100,p.y+step);
  }
  if(['+','=','-'].includes(event.key))p.width=Math.max(10,Math.min(100,p.width+(event.key==='-'?-step:step)));
  commitBannerPlacement(p,copyAdState());
});
selection.addEventListener('wheel',event=>{if(!event.altKey)return;event.preventDefault();resizeSelectedBanner(event.deltaY>0?-2:2);},{passive:false});
function timelineClickSuppressed(){return performance.now()<suppressTimelineClickUntil;}
document.addEventListener('pointerdown',event=>{
  const marker=event.target.closest?.('.ad-event'); if(!marker || event.button!==0)return;
  const clip=Number(marker.dataset.clip),index=Number(marker.dataset.event),events=adPlans[clip];if(!events?.[index])return;
  event.preventDefault();pauseStudioPlayback();marker.setPointerCapture(event.pointerId);
  timelineGesture={marker,pointerId:event.pointerId,startX:event.clientX,clip,index,event:{...events[index]},events:structuredClone(events),snapshot:copyAdState(),resize:event.target.dataset.resize==='end',trackWidth:marker.parentElement.clientWidth,resultDuration:AdSchedule.outputDuration(state.segments[clip].duration,events),moved:false};
  marker.classList.add('is-dragging');
});
function updateTimelineGesture(event) {
  const g=timelineGesture;if(!g||event.pointerId!==g.pointerId)return;
  const delta=(event.clientX-g.startX)/g.trackWidth*g.resultDuration;
  g.moved ||= Math.abs(event.clientX-g.startX)>2;
  const c={...adConfig,...adConfig.clips[g.clip]},e=g.event;
  if(g.resize) {
    const max=e.freeze?120:Math.min(120,(g.events[g.index+1]?.start??clipContentDuration(state.segments[g.clip])-c.endPadding)-e.start-(g.index<g.events.length-1?c.minGap:0));
    g.nextDuration=Math.round(Math.max(.2,Math.min(max,e.duration+delta))*100)/100;
    g.marker.style.width=`${g.nextDuration/g.resultDuration*100}%`;
    g.marker.title=`Длительность: ${g.nextDuration} сек`;
  } else {
    const previous=g.events[g.index-1],next=g.events[g.index+1];
    const min=previous?previous.start+(e.freeze?0:previous.duration)+c.minGap:0;
    const max=Math.min(clipContentDuration(state.segments[g.clip])-c.endPadding-(e.freeze?0:e.duration),next?next.start-(e.freeze?0:e.duration)-c.minGap:Infinity);
    g.nextStart=Math.round(Math.max(min,Math.min(max,e.start+delta))*100)/100;
    const inserted=g.events.slice(0,g.index).reduce((sum,item)=>sum+(item.freeze?item.duration:0),0);
    g.marker.style.left=`${(g.nextStart+inserted)/g.resultDuration*100}%`;
    g.marker.title=`Начало по исходнику: ${g.nextStart} сек`;
  }
}
document.addEventListener('pointermove',event=>{
  if(!timelineGesture||event.pointerId!==timelineGesture.pointerId)return;
  timelineGesture.pending={clientX:event.clientX,pointerId:event.pointerId};
  if(timelinePointerFrame===null)timelinePointerFrame=requestAnimationFrame(()=>{timelinePointerFrame=null;if(timelineGesture)updateTimelineGesture(timelineGesture.pending);});
});
function finishTimelineGesture(cancel=false) {
  const g=timelineGesture;if(!g)return;
  if(!cancel&&g.pending)updateTimelineGesture(g.pending);
  if(timelinePointerFrame!==null)cancelAnimationFrame(timelinePointerFrame);timelinePointerFrame=null;timelineGesture=null;
  if(g.marker.hasPointerCapture(g.pointerId))g.marker.releasePointerCapture(g.pointerId);
  g.marker.classList.remove('is-dragging');
  if(g.moved&&!cancel) {
    suppressTimelineClickUntil=performance.now()+300;recordAdChange(g.snapshot);
    const clip=adConfig.clips[g.clip] ||= {};
    if(g.resize) (clip.staticDurations ||= {})[g.index]=g.nextDuration;
    else {clip.starts=g.events.map(e=>e.start);clip.starts[g.index]=g.nextStart;}
    saveAds();selectedClip=g.clip;updateAdPlan();syncStudioPreview();
    const event=AdSchedule.outputEvents(adPlans[g.clip])[g.index];if(event)seekStudio(event.start+Math.min(event.fade+.1,event.duration/2));
  } else if(cancel) updateAdPlan();
}
document.addEventListener('pointerup',()=>finishTimelineGesture());
document.addEventListener('pointercancel',()=>finishTimelineGesture(true));
document.addEventListener('keydown',event=>{
  if(event.key==='Escape'){finishCanvasGesture(true);finishTimelineGesture(true);return;}
  if(event.target.matches('input,textarea,select,[contenteditable=true]'))return;
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'&&state.currentPage==='home') {event.preventDefault();event.shiftKey?redoAdEdit():undoAdEdit();}
});
updateUndoButtons(); syncCanvasEditor(null);
