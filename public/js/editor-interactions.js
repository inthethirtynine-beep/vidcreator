ed.gesture=null;ed.pointerFrame=null;ed.focusArea='canvas';
function edGestureCommit(before){ed.remember(before);try{ed.project=EditorModel.normalize(ed.project,ed.project.source);ed.dirty=true;ed.rebuild();ed.renderPanels();ed.renderTimeline();ed.syncMedia(true);ed.paint();ed.scheduleSave();}catch(error){ed.project=before;ed.rebuild();ed.renderPanels();ed.paint();ed.error(error);}}
ed.openCrop=()=>{
  if(ed.selected.type!=='layer')return;
  const index=ed.selected.index,layer=ed.project.layers[index];ed.pause();
  ed.modal(`<div class="ed-dialog"><div class="ed-dialog-head"><h2>Область исходника · ${edEsc(layer.name)}</h2><button class="ed-button icon" onclick="ed.closeModal();ed.syncMedia(true)" aria-label="Закрыть выделение">${uiIcon("x-circle-fill")}</button></div><p class="ed-small" style="margin-bottom:12px">Потяни за углы рамки или нарисуй новую область за её пределами. Выделение синхронно во всём ролике.</p><div class="ed-crop-stage" id="ed-crop-stage"><canvas id="ed-crop-canvas"></canvas><div class="ed-crop-box" id="ed-crop-box">${['nw','ne','sw','se'].map(c=>`<button class="ed-handle ${c}" data-ed-crop-corner="${c}" aria-label="Угол выделения ${c}"></button>`).join('')}</div></div><label class="ed-label" for="ed-crop-time">Кадр исходника</label><input id="ed-crop-time" class="ed-input" type="range" min="0" max="${ed.project.source.duration}" value="${ed.point().source}" step=".1" oninput="ed.video.currentTime=Number(this.value)"><div class="ed-micro-toolbar"><button class="ed-button" onclick="ed.cropPreset('full')">Весь кадр</button><button class="ed-button" onclick="ed.cropPreset('tl')">Камера слева сверху</button><button class="ed-button" onclick="ed.cropPreset('br')">Камера справа снизу</button></div><div class="ed-dialog-actions"><button class="ed-button" onclick="ed.closeModal();ed.syncMedia(true)">Отмена</button><button class="ed-button primary" onclick="ed.applyCrop()">Применить область</button></div></div>`);
  ed.cropDraft={index,rect:{...layer.crop}};ed.drawCrop();
};
ed.drawCrop=()=>{
  if(!ed.cropDraft)return;const p=ed.project,stage=document.getElementById('ed-crop-stage'),canvas=document.getElementById('ed-crop-canvas');if(!canvas)return;
  const scale=Math.min(720/p.source.width,Math.min(460,window.innerHeight*.5)/p.source.height,(window.innerWidth-68)/p.source.width);const width=p.source.width*scale,height=p.source.height*scale;
  stage.style.width=`${width}px`;stage.style.height=`${height}px`;canvas.width=Math.round(width);canvas.height=Math.round(height);if(ed.video.readyState>=2)canvas.getContext('2d').drawImage(ed.video,0,0,canvas.width,canvas.height);
  const r=ed.cropDraft.rect;Object.assign(document.getElementById('ed-crop-box').style,{left:`${r.x*100}%`,top:`${r.y*100}%`,width:`${r.w*100}%`,height:`${r.h*100}%`});
};
ed.cropPreset=name=>{if(!ed.cropDraft)return;ed.cropDraft.rect=name==='full'?{x:0,y:0,w:1,h:1}:name==='tl'?{x:0,y:0,w:.25,h:.29}:{x:.7,y:.6,w:.3,h:.4};ed.drawCrop();};
ed.applyCrop=()=>{const {index,rect}=ed.cropDraft;ed.change(p=>p.layers[index].crop=rect);ed.closeModal();ed.syncMedia(true);};
function canvasPoint(event){const r=ed.canvas.getBoundingClientRect();return{x:(event.clientX-r.left)/r.width,y:(event.clientY-r.top)/r.height,width:r.width,height:r.height};}
document.getElementById('ed-selection').addEventListener('pointerdown',event=>{
  if(event.button!==0||!ed.bounds||!ed.project)return;event.preventDefault();event.stopPropagation();ed.pause();ed.focusArea='canvas';
  const el=event.currentTarget;el.setPointerCapture(event.pointerId);el.classList.add('dragging');
  ed.gesture={kind:'canvas',element:el,id:event.pointerId,corner:event.target.dataset.edCorner,start:canvasPoint(event),base:{...ed.bounds},before:ed.snapshot(),selected:{...ed.selected},moved:false};
  el.focus({preventScroll:true});
});
ed.canvas.addEventListener('pointerdown',event=>{
  if(!ed.project)return;const pt=canvasPoint(event);ed.focusArea='canvas';
  for(let i=ed.project.layers.length-1;i>=0;i--){const l=ed.project.layers[i],r=l.rect;if(l.enabled&&pt.x>=r.x&&pt.x<=r.x+r.w&&pt.y>=r.y&&pt.y<=r.y+r.h){ed.inspectorTab='layer';ed.select('layer',i);return;}}
});
function updateCanvas(event){
  const g=ed.gesture,now=canvasPoint(event),dx=now.x-g.start.x,dy=now.y-g.start.y,b=g.base;let r={x:b.x,y:b.y,w:b.w,h:b.h};g.moved ||= Math.abs(dx)+Math.abs(dy)>.001;
  if(g.corner){
    if(g.corner.includes('w')){r.x=Math.min(b.x+b.w-.03,Math.max(0,b.x+dx));r.w=b.x+b.w-r.x;}else r.w=Math.max(.03,Math.min(1-b.x,b.w+dx));
    if(g.corner.includes('n')){r.y=Math.min(b.y+b.h-.03,Math.max(0,b.y+dy));r.h=b.y+b.h-r.y;}else r.h=Math.max(.03,Math.min(1-b.y,b.h+dy));
    if(event.shiftKey){r.h=r.w*b.h/b.w;r.y=g.corner.includes('n')?b.y+b.h-r.h:b.y;}
  }else{r.x=Math.max(0,Math.min(1-r.w,b.x+dx));r.y=Math.max(0,Math.min(1-r.h,b.y+dy));
    if(!event.altKey&&Math.abs(r.x+r.w/2-.5)*now.width<5)r.x=.5-r.w/2;
    if(!event.altKey&&Math.abs(r.y+r.h/2-.5)*now.height<5)r.y=.5-r.h/2;
  }
  const s=g.selected,p=ed.project;
  if(s.type==='layer')p.layers[s.index].rect=EditorModel.rect(r);
  else if(s.type==='text'||s.type==='subtitles'){
    const item=s.type==='text'?p.texts[s.index]:p.subtitles;item.x=EditorModel.clamp(r.x+r.w/2,.02,.98);item.y=EditorModel.clamp(r.y+r.h/2,.02,.98);
    if(g.corner){const original=s.type==='text'?g.before.texts[s.index]:g.before.subtitles;item.fontSize=EditorModel.clamp(original.fontSize*r.w/b.w,16,s.type==='text'?160:140);}
  }else if(s.type==='ad'){
    const pt=ed.point(),asset=ed.assets.find(a=>a.id===pt.ad?.assetId);if(!asset)return;
    const ratio=asset.height/asset.width*ed.project.output.width/ed.project.output.height;if(g.corner)r.h=r.w*ratio;
    p.adConfig.width=EditorModel.clamp(r.w*100,10,100);p.adConfig.x=EditorModel.clamp((r.x+r.w/2)*100,0,100);p.adConfig.y=EditorModel.clamp((r.y+r.h/2)*100,0,100);ed.rebuild();
  }ed.paint();
}
document.addEventListener('pointerdown',event=>{
  if(event.button!==0)return;
  const crop=event.target.closest?.('#ed-crop-stage');
  if(crop&&ed.cropDraft){
    event.preventDefault();crop.setPointerCapture(event.pointerId);const box=crop.getBoundingClientRect();const start={x:(event.clientX-box.left)/box.width,y:(event.clientY-box.top)/box.height};
    const inBox=!!event.target.closest('#ed-crop-box');ed.gesture={kind:'crop',element:crop,id:event.pointerId,box,start,base:{...ed.cropDraft.rect},corner:event.target.dataset.edCropCorner,draw:!inBox,moved:false};return;
  }
  const timeline=event.target.closest?.('#ed-timeline-inner');if(!timeline||!ed.project)return;ed.pause();ed.focusArea='timeline';event.preventDefault();timeline.setPointerCapture(event.pointerId);
  const cut=event.target.closest('[data-ed-cut]'),ad=event.target.closest('[data-ed-ad]'),cue=event.target.closest('[data-ed-cue]');
  const base={element:timeline,id:event.pointerId,startX:event.clientX,before:ed.snapshot(),moved:false};
  if(ad){const range=ed.ranges[+ad.dataset.edRange],index=+ad.dataset.edAd;ed.gesture={...base,kind:'ad',range,index,event:range.events[index],resize:!!event.target.dataset.edAdResize,marker:ad};ed.selected={type:'ad',index:0};ed.seek(range.start+range.timed[index].start+.35);ed.renderInspector();}
  else if(cue){ed.gesture={...base,kind:'cue',index:+cue.dataset.edCue,marker:cue,cue:{...ed.project.subtitles.cues[+cue.dataset.edCue]}};ed.seek(+cue.dataset.edTime+.01);ed.select('subtitles');}
  else if(cut){const index=+cut.dataset.edCut;ed.selectedCut=index;ed.gesture={...base,kind:event.target.dataset.edTrim?'trim':'cut',edge:event.target.dataset.edTrim,index,cut:{...ed.project.cuts[index]},rangeAdsDuration:ed.ranges[index].events.reduce((sum,event)=>sum+(event.freeze?event.duration:0),0),marker:cut};ed.seek(ed.ranges[index].start);ed.renderInspector();}
  else{ed.gesture={...base,kind:'seek'};ed.seek(ed.timeFromPointer(event.clientX));}
});
ed.timeFromPointer=x=>(x-document.getElementById('ed-timeline-inner').getBoundingClientRect().left-82)/ed.zoom;
function updateCrop(event){const g=ed.gesture,point={x:EditorModel.clamp((event.clientX-g.box.left)/g.box.width,0,1),y:EditorModel.clamp((event.clientY-g.box.top)/g.box.height,0,1)},dx=point.x-g.start.x,dy=point.y-g.start.y,b=g.base;let r={...b};
  if(g.draw)r={x:Math.min(g.start.x,point.x),y:Math.min(g.start.y,point.y),w:Math.max(.01,Math.abs(dx)),h:Math.max(.01,Math.abs(dy))};
  else if(g.corner){if(g.corner.includes('w')){r.x=Math.max(0,Math.min(b.x+b.w-.01,b.x+dx));r.w=b.x+b.w-r.x;}else r.w=Math.max(.01,Math.min(1-b.x,b.w+dx));if(g.corner.includes('n')){r.y=Math.max(0,Math.min(b.y+b.h-.01,b.y+dy));r.h=b.y+b.h-r.y;}else r.h=Math.max(.01,Math.min(1-b.y,b.h+dy));}
  else{r.x=EditorModel.clamp(b.x+dx,0,1-b.w);r.y=EditorModel.clamp(b.y+dy,0,1-b.h);}
  ed.cropDraft.rect=EditorModel.crop(r);ed.drawCrop();
}
function updateTimeline(event){const g=ed.gesture,dx=event.clientX-g.startX,delta=dx/ed.zoom;g.moved ||= Math.abs(dx)>3;
  if(g.kind==='seek'){ed.seek(ed.timeFromPointer(event.clientX));return;}
  if(g.kind==='trim'){
    if(g.edge==='start')g.value=EditorModel.clamp(g.cut.start+delta,0,g.cut.end-.2);else g.value=EditorModel.clamp(g.cut.end+delta,g.cut.start+.2,ed.project.source.duration);
    const newDuration=g.edge==='start'?g.cut.end-g.value:g.value-g.cut.start;g.marker.style.width=`${Math.max(8,(newDuration+g.rangeAdsDuration)*ed.zoom)}px`;g.marker.title=`${g.edge==='start'?'Начало':'Конец'}: ${edTime(g.value)}`;
  }else if(g.kind==='cut'){if(g.moved){g.marker.style.transform=`translateX(${dx}px)`;g.marker.style.opacity='.6';g.target=ed.ranges.findIndex(r=>ed.timeFromPointer(event.clientX)<r.start+r.duration/2);if(g.target<0)g.target=ed.project.cuts.length-1;}}
  else if(g.kind==='cue'){const length=g.cue.end-g.cue.start;g.value=EditorModel.clamp(g.cue.start+delta,0,ed.project.source.duration-length);g.marker.style.transform=`translateX(${(g.value-g.cue.start)*ed.zoom}px)`;}
  else if(g.kind==='ad'){
    const p=ed.project,c={...p.adConfig,...p.adConfig.clips[g.range.index]},e=g.event;
    if(g.resize){const next=g.range.events[g.index+1],max=e.freeze?120:Math.min(120,(next?.start??g.range.cut.end-g.range.cut.start-c.endPadding)-e.start-(next?c.minGap:0));g.value=EditorModel.clamp(e.duration+delta,.2,max);g.marker.style.width=`${g.value*ed.zoom}px`;}
    else{const previous=g.range.events[g.index-1],next=g.range.events[g.index+1],min=previous?previous.start+(e.freeze?0:previous.duration)+c.minGap:0,max=Math.min(g.range.cut.end-g.range.cut.start-c.endPadding-(e.freeze?0:e.duration),next?next.start-(e.freeze?0:e.duration)-c.minGap:Infinity);g.value=EditorModel.clamp(e.start+delta,min,max);g.marker.style.transform=`translateX(${(g.value-e.start)*ed.zoom}px)`;}
  }
}
document.addEventListener('pointermove',event=>{
  const g=ed.gesture;if(!g||g.id!==event.pointerId)return;g.pending={clientX:event.clientX,clientY:event.clientY,shiftKey:event.shiftKey,altKey:event.altKey};
  if(!ed.pointerFrame)ed.pointerFrame=requestAnimationFrame(()=>{ed.pointerFrame=null;const current=ed.gesture;if(!current)return;current.kind==='canvas'?updateCanvas(current.pending):current.kind==='crop'?updateCrop(current.pending):updateTimeline(current.pending);});
});
function finishEditorGesture(cancel=false){
  const g=ed.gesture;if(!g)return;
  if(ed.pointerFrame)cancelAnimationFrame(ed.pointerFrame);ed.pointerFrame=null;
  if(!cancel&&g.pending){g.kind==='canvas'?updateCanvas(g.pending):g.kind==='crop'?updateCrop(g.pending):updateTimeline(g.pending);}
  ed.gesture=null;if(g.element.hasPointerCapture(g.id))g.element.releasePointerCapture(g.id);g.element.classList.remove('dragging');
  if(g.kind==='crop'){if(cancel){ed.cropDraft.rect=g.base;ed.drawCrop();}return;}
  if(cancel){ed.project=g.before;ed.rebuild();ed.renderTimeline();ed.paint();return;}
  if(g.kind==='seek')return;
  if(g.moved){
    if(g.kind==='trim'){ed.project.cuts[g.index][g.edge]=g.value;ed.project.adConfig.clips={};}
    if(g.kind==='cut'&&g.target!==undefined){const [cut]=ed.project.cuts.splice(g.index,1);ed.project.cuts.splice(g.target,0,cut);ed.selectedCut=g.target;ed.project.adConfig.clips={};}
    if(g.kind==='cue'){const cue=ed.project.subtitles.cues[g.index],delta=g.value-cue.start;cue.start=g.value;cue.end+=delta;cue.words=cue.words.map(w=>({...w,start:w.start+delta,end:w.end+delta}));}
    if(g.kind==='ad'){const clip=ed.project.adConfig.clips[g.range.index] ||= {};if(g.resize)(clip.staticDurations ||= {})[g.index]=g.value;else{clip.starts=g.range.events.map(e=>e.start);clip.starts[g.index]=g.value;}}
    edGestureCommit(g.before);
  }else{ed.renderTimeline();ed.paint();}
}
document.addEventListener('pointerup',()=>finishEditorGesture());document.addEventListener('pointercancel',()=>finishEditorGesture(true));
document.getElementById('ed-selection').addEventListener('keydown',event=>{
  if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)||!ed.bounds)return;event.preventDefault();const step=event.shiftKey?.02:.002,b=ed.bounds,s=ed.selected;
  ed.change(p=>{const dx=event.key==='ArrowLeft'?-step:event.key==='ArrowRight'?step:0,dy=event.key==='ArrowUp'?-step:event.key==='ArrowDown'?step:0;if(s.type==='layer'){const r=p.layers[s.index].rect;r.x+=dx;r.y+=dy;}else if(s.type==='text'){p.texts[s.index].x+=dx;p.texts[s.index].y+=dy;}else if(s.type==='subtitles'){p.subtitles.x+=dx;p.subtitles.y+=dy;}else{p.adConfig.x+=dx*100;p.adConfig.y+=dy*100;}});
});
document.addEventListener('keydown',event=>{
  if(state.currentPage!=='editor')return;
  if(event.key==='Escape'){finishEditorGesture(true);if(document.getElementById('ed-modal')){ed.closeModal();ed.syncMedia(true);}else document.getElementById('ed-body').classList.remove('inspector-open','left-open');return;}
  if(event.target.matches('input,textarea,select,[contenteditable=true]'))return;
  if(event.code==='Space'){event.preventDefault();ed.togglePlay();return;}
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'){event.preventDefault();event.shiftKey?ed.redoChange():ed.undoChange();}
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'){event.preventDefault();ed.flushSave().catch(ed.error);}
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='b'){event.preventDefault();ed.split();}
  if(event.key==='Delete'||event.key==='Backspace'){event.preventDefault();ed.focusArea==='timeline'?ed.removeCut():ed.deleteSelection();}
});
document.addEventListener('fullscreenchange',()=>{ed.fitStage();uiSetIcon('ed-fullscreen',document.fullscreenElement?"pip-fill":"aspect-ratio-fill");document.getElementById('ed-fullscreen').setAttribute('aria-label',document.fullscreenElement?'Выйти из полноэкранного просмотра':'Полноэкранный просмотр');});
