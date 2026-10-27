/* Non-destructive reaction editor. Project coordinates are normalized; exports use the same model. */
const ed={rate:1,loop:false,project:null,ready:false,tool:'media',selected:{type:'layer',index:1},selectedCut:0,head:0,playing:false,sound:true,zoom:8,undo:[],redo:[],ranges:[],assets:[],videos:[],projects:[],saving:false,dirty:false,saveTimer:null,animation:null,lastTick:0,captionPage:0,speechJob:null,mediaCache:new Map(),bounds:null};
const edEsc=value=>escapeHtml(String(value??'')).replace(/"/g,'&quot;').replace(/'/g,'&#39;');
const edTime=t=>{t=Math.max(0,Number(t)||0);return`${String(Math.floor(t/60)).padStart(2,'0')}:${(t%60).toFixed(2).padStart(5,'0')}`;};
const edPage=document.createElement('section');edPage.id='page-editor';edPage.className='page-view';
edPage.innerHTML=`<header class="ed-header"><span class="ed-brand">CUT / STUDIO</span><input class="ed-project-name" id="ed-project-name" aria-label="Название проекта" value="Новый монтаж" onchange="ed.change(p=>p.name=this.value)"><span class="ed-save" id="ed-save">Локальный проект</span><div class="ed-header-right"><button class="ed-button new" onclick="ed.newProject()">${uiIcon("plus-circle-fill")} Новый</button><button class="ed-button" onclick="ed.showShortcuts()" title="Горячие клавиши · ?">${uiIcon("dpad-fill")} Клавиши</button><button class="ed-button" onclick="ed.showProjects()">Проекты</button><button class="ed-button ed-top-inspector-toggle" onclick="ed.toggleInspector()">Настройки</button><button class="ed-button primary" id="ed-export" onclick="ed.openExport()">Экспорт ${uiIcon("arrow-up-right-circle-fill")}</button></div></header>
<div class="ed-body" id="ed-body"><nav class="ed-rail" aria-label="Инструменты редактора">${[['media','collection-play-fill','Медиа'],['layers','layers-fill','Слои'],['text','file-font-fill','Текст'],['captions','badge-cc-fill','Субтитры'],['ads','badge-ad-fill','Реклама']].map(([id,icon,label])=>`<button data-ed-tool="${id}" title="${label}" onclick="ed.setTool('${id}')"><b>${uiIcon(icon)}</b>${label}</button>`).join('')}<button onclick="navigate('home')" title="Вернуться в видеостудию" style="margin-top:auto"><b>${uiIcon("arrow-left-circle-fill")}</b>Студия</button></nav><section class="ed-left" id="ed-left"></section><section class="ed-player"><div class="ed-player-top"><span id="ed-player-title">Плеер / итоговая композиция</span><span id="ed-output-label">9:16 · 1080p</span></div><div class="ed-player-space" id="ed-player-space"><div class="ed-stage-box" id="ed-stage-box"><canvas id="ed-canvas" class="ed-canvas" aria-label="Предпросмотр монтажа"></canvas><div class="ed-selection" id="ed-selection" tabindex="0" role="group" aria-label="Выбранный элемент: перетащи или измени размер за угол"><span class="ed-selection-label" id="ed-selection-label"></span>${['nw','ne','sw','se'].map(c=>`<button class="ed-handle ${c}" data-ed-corner="${c}" aria-label="Изменить размер ${c}"></button>`).join('')}</div></div></div><div class="ed-player-controls"><div class="ed-control-group"><button class="ed-button icon" onclick="ed.seek(0)" aria-label="В начало" title="В начало · Home">${uiIcon('skip-start-fill')}</button><button class="ed-button icon" onclick="ed.stepFrame(-1)" aria-label="Предыдущий кадр" title="Предыдущий кадр · ←">${uiIcon("caret-left-fill")}</button><button class="ed-button icon ed-play" id="ed-play" onclick="ed.togglePlay()" aria-label="Воспроизвести монтаж" title="Воспроизведение · Пробел">${uiIcon('play-fill')}</button><button class="ed-button icon" onclick="ed.stepFrame(1)" aria-label="Следующий кадр" title="Следующий кадр · →">${uiIcon("caret-right-fill")}</button></div><button class="ed-time-button" id="ed-time" onclick="ed.openGoTo()" aria-label="Перейти ко времени">00:00.00 / 00:00.00</button><div class="ed-control-group"><button class="ed-button ed-toggle" id="ed-rate" onclick="ed.cycleRate()" title="Скорость предпросмотра, на экспорт не влияет">1×</button><button class="ed-button ed-toggle" id="ed-loop" onclick="ed.toggleLoop()" aria-pressed="false" title="Повторять выбранный фрагмент · L">Повтор</button><button class="ed-button icon" onclick="ed.saveFrame()" aria-label="Сохранить кадр в PNG" title="Сохранить текущий кадр в PNG — например, для обложки">${uiIcon("camera-video-fill")}</button><span class="ed-control-divider" aria-hidden="true"></span><button class="ed-button icon" id="ed-sound" onclick="ed.toggleSound()" aria-label="Звук предпросмотра">${uiIcon("volume-up-fill")}</button><button class="ed-button icon" id="ed-fullscreen" onclick="ed.fullscreen()" title="Полноэкранный просмотр">${uiIcon("aspect-ratio-fill")}</button></div></div><div class="ed-player-note" id="ed-player-note">Выбери исходник и собери свою историю.</div></section><aside class="ed-inspector" id="ed-inspector"></aside></div>
<section class="ed-timeline"><div class="ed-timeline-toolbar"><button class="ed-button" id="ed-undo" onclick="ed.undoChange()" title="Отменить · Ctrl+Z">${uiIcon("reply-fill")}</button><button class="ed-button" id="ed-redo" onclick="ed.redoChange()" title="Повторить · Ctrl+Shift+Z">${uiIcon("forward-fill")}</button><button class="ed-button" onclick="ed.split()" title="Разделить под курсором · Ctrl+B">${uiIcon("file-break-fill")} Разделить</button><button class="ed-button" onclick="ed.trimAtHead('start')" title="Убрать начало фрагмента до курсора · Q">${uiIcon("skip-start-fill")} Срезать начало</button><button class="ed-button" onclick="ed.trimAtHead('end')" title="Убрать конец фрагмента после курсора · W">${uiIcon("skip-end-fill")} Срезать конец</button><button class="ed-button" onclick="ed.duplicateCut()" title="Дублировать выбранный фрагмент">${uiIcon("stickies-fill")} Копия</button><button class="ed-button icon-only" onclick="ed.removeCut()" title="Удалить фрагмент">${uiIcon("trash3-fill")}</button><button class="ed-button icon-only" onclick="ed.moveCut(-1)" title="Переместить фрагмент раньше">${uiIcon("caret-left-fill")}</button><button class="ed-button icon-only" onclick="ed.moveCut(1)" title="Переместить фрагмент позже">${uiIcon("caret-right-fill")}</button><button class="ed-button" onclick="ed.openSlice()">Автонарезка</button><span id="ed-cut-count">0 фрагментов</span><label class="ed-timeline-zoom" title="Масштаб · Ctrl + колесо">${uiIcon("dash-circle-fill")}<input id="ed-zoom" type="range" min="0.2" max="50" step="0.1" value="8" aria-label="Масштаб таймлайна" oninput="ed.setZoom(Number(this.value))">${uiIcon("plus-circle-fill")}</label><button class="ed-button" onclick="ed.fitTimeline()" title="Показать весь монтаж">${uiIcon("aspect-ratio-fill")} Весь монтаж</button></div><div class="ed-timeline-scroll" id="ed-timeline-scroll"><div class="ed-timeline-inner" id="ed-timeline-inner"></div></div></section>`;
document.querySelector('.main-content').appendChild(edPage);
const editorNav=document.createElement('button');editorNav.className='nav-btn';editorNav.dataset.page='editor';editorNav.title='Редактор';editorNav.setAttribute('aria-label','Редактор');editorNav.onclick=()=>navigate('editor');editorNav.innerHTML=`<span class="nav-btn__icon">${uiIcon("grid-1x2-fill")}</span><span>Редактор</span>`;
document.querySelector('.navbar__nav').children[0].after(editorNav);
document.querySelectorAll('.nav-btn').forEach(b=>{b.title=b.textContent.trim();if(!b.getAttribute('aria-label'))b.setAttribute('aria-label',b.textContent.trim());});
const editorNavigateBase=navigate;
navigate=function(page){if(page!=='editor')ed.pause();editorNavigateBase(page);document.querySelector('.app').classList.toggle('editor-open',page==='editor');if(page==='editor'){window.scrollTo(0,0);document.getElementById('studio-breadcrumb').textContent='Редактор';ed.open();requestAnimationFrame(ed.fitStage);}};
ed.video=document.createElement('video');ed.video.preload='auto';ed.video.playsInline=true;ed.video.style.display='none';document.body.appendChild(ed.video);
ed.adVideo=document.createElement('video');ed.adVideo.muted=true;ed.adVideo.playsInline=true;ed.adVideo.style.display='none';document.body.appendChild(ed.adVideo);
ed.canvas=document.getElementById('ed-canvas');ed.ctx=ed.canvas.getContext('2d',{alpha:false});
ed.api=async(url,options)=>{const response=await fetch('/api/editor'+url,options);const data=await response.json();if(!response.ok)throw new Error(data.error||'Ошибка редактора');return data;};
ed.post=(url,body)=>ed.api(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
ed.open=async()=>{
  if(ed.ready){ed.fitStage();ed.paint();return;}
  try{
    document.getElementById('ed-save').textContent='Загрузка…';
    const [videos,projects,assets,speech]=await Promise.all([fetch('/api/videos').then(r=>r.json()),ed.api('/projects'),fetch('/api/banners').then(r=>r.json()),ed.api('/speech/status')]);
    ed.videos=videos;ed.projects=projects;ed.assets=assets;ed.speech=speech;ed.model=speech.models.some(m=>m.id==='small'&&m.installed)?'small':'base';ed.ready=true;
    const last=localStorage.getItem('vidcreator.editor.project');
    if(last&&projects.some(p=>p.id===last))await ed.loadProject(last);
    else if(state.currentVideoId||videos[0])await ed.useVideo(state.currentVideoId||videos[0].id);
    else{ed.renderPanels();document.getElementById('ed-save').textContent='Добавь видео';}
    ed.resumeSpeech();
  }catch(error){ed.error(error);ed.renderPanels();}
};
ed.error=error=>{showToast(error.message||String(error),'error');const el=document.getElementById('ed-save');el.textContent='Проверь настройки';el.classList.add('error');};
ed.useVideo=async id=>{try{await ed.flushSave();const p=await ed.post('/projects',{videoId:id});ed.projects.unshift(p);await ed.useProject(p);}catch(error){ed.error(error);}};
ed.loadProject=async id=>{try{await ed.flushSave();await ed.useProject(await ed.api(`/projects/${id}`));ed.closeModal();}catch(error){ed.error(error);}};
ed.useProject=async project=>{
  ed.pause();ed.project=EditorModel.normalize(project,project.source);ed.head=0;ed.selectedCut=0;ed.selected={type:'layer',index:Math.min(1,project.layers.length-1)};ed.undo=[];ed.redo=[];ed.dirty=false;ed.captionPage=0;
  localStorage.setItem('vidcreator.editor.project',project.id);document.getElementById('ed-project-name').value=project.name;
  ed.video.src=project.source.videoUrl;ed.video.load();ed.video.volume=Math.min(1,project.audio.volume);ed.video.muted=!ed.sound;
  ed.rebuild();ed.renderPanels();ed.fitStage();ed.renderTimeline();ed.updateSave('Сохранено локально');
};
ed.snapshot=()=>structuredClone(ed.project);
ed.remember=(snapshot=ed.snapshot())=>{ed.undo.push(snapshot);if(ed.undo.length>60)ed.undo.shift();ed.redo=[];};
ed.updateSave=text=>{const el=document.getElementById('ed-save');el.textContent=text;el.classList.remove('error');};
ed.change=(mutate,options={})=>{
  if(!ed.project)return;ed.pause();const before=ed.snapshot();
  try{mutate(ed.project);ed.project=EditorModel.normalize(ed.project,ed.project.source);}catch(error){ed.project=before;ed.error(error);ed.renderPanels();return;}
  if(options.history!==false)ed.remember(before);ed.dirty=true;ed.rebuild();ed.fitStage();ed.paint();ed.renderTimeline();if(options.panels!==false)ed.renderPanels();ed.scheduleSave();
};
ed.scheduleSave=()=>{ed.updateSave('Изменения…');clearTimeout(ed.saveTimer);ed.saveTimer=setTimeout(()=>ed.flushSave().catch(ed.error),500);};
ed.flushSave=async()=>{
  clearTimeout(ed.saveTimer);
  if(ed.saving){await ed.savePromise;if(ed.dirty)return ed.flushSave();return;}
  if(!ed.project||!ed.dirty)return;
  const copy=ed.snapshot(),id=copy.id;ed.dirty=false;ed.saving=true;ed.updateSave('Сохранение…');
  ed.savePromise=ed.api(`/projects/${id}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({baseRevision:copy.revision,project:copy})});
  try{const saved=await ed.savePromise;if(ed.project.id===id)ed.project.revision=saved.revision;ed.updateSave(ed.dirty?'Изменения…':'Сохранено локально');}
  catch(error){ed.dirty=true;ed.error(error);throw error;}finally{ed.saving=false;}
};
ed.undoChange=()=>{if(!ed.undo.length)return;ed.pause();ed.redo.push(ed.snapshot());const revision=ed.project.revision;ed.project=ed.undo.pop();ed.project.revision=revision;ed.afterHistory();};
ed.redoChange=()=>{if(!ed.redo.length)return;ed.pause();ed.undo.push(ed.snapshot());const revision=ed.project.revision;ed.project=ed.redo.pop();ed.project.revision=revision;ed.afterHistory();};
ed.afterHistory=()=>{ed.dirty=true;document.getElementById('ed-project-name').value=ed.project.name;ed.selectedCut=Math.min(ed.selectedCut,ed.project.cuts.length-1);ed.rebuild();ed.renderPanels();ed.renderTimeline();ed.fitStage();ed.syncMedia();ed.paint();ed.scheduleSave();};
ed.rebuild=()=>{
  if(!ed.project)return;const p=ed.project;let plans=[];ed.adError='';
  try{plans=AdSchedule.plan(p.adConfig,p.cuts.map(c=>({duration:c.end-c.start})),id=>ed.assets.find(a=>a.id===id));plans.flat().forEach(e=>{if(!ed.assets.some(a=>a.id===e.assetId))throw new Error('Выбери доступный рекламный баннер');});}catch(error){ed.adError=error.message;plans=p.cuts.map(()=>[]);}
  let offset=0;ed.ranges=p.cuts.map((cut,index)=>{const events=plans[index]||[],duration=AdSchedule.outputDuration(cut.end-cut.start,events);const range={cut,index,start:offset,duration,events,timed:AdSchedule.outputEvents(events)};offset+=duration;return range;});ed.duration=offset;ed.head=Math.min(ed.head,Math.max(0,offset-.001));
  document.getElementById('ed-cut-count').textContent=`Фрагментов: ${p.cuts.length}`;document.getElementById('ed-undo').disabled=!ed.undo.length;document.getElementById('ed-redo').disabled=!ed.redo.length;document.getElementById('ed-export').disabled=!!ed.adError;
};
ed.point=(time=ed.head)=>{
  const range=ed.ranges.find(r=>time<r.start+r.duration-.00001)||ed.ranges.at(-1);if(!range)return null;
  const local=Math.max(0,time-range.start),mapped=AdSchedule.sourceAt(local,range.events);
  return{range,local,source:Math.min(ed.project.source.duration-.001,range.cut.start+mapped.time),frozen:mapped.frozen,ad:range.timed.find(e=>local>=e.start&&local<e.start+e.duration)};
};
ed.pause=()=>{ed.playing=false;if(ed.animation)cancelAnimationFrame(ed.animation);ed.animation=null;ed.video.pause();ed.adVideo.pause();if(ed.project)ed.paint();};
ed.seek=time=>{if(!ed.project)return;ed.head=Math.max(0,Math.min(Number(time),Math.max(0,ed.duration-.001)));ed.lastTick=performance.now();const pt=ed.point();ed.selectedCut=pt.range.index;ed.syncMedia(true);ed.paint();ed.updatePlayhead();const scroll=document.getElementById('ed-timeline-scroll'),x=82+ed.head*ed.zoom;if(x<scroll.scrollLeft+82||x>scroll.scrollLeft+scroll.clientWidth-20)scroll.scrollLeft=Math.max(0,x-scroll.clientWidth*.45);document.querySelectorAll('[data-ed-cut]').forEach(el=>el.classList.toggle('active',Number(el.dataset.edCut)===ed.selectedCut));};
ed.syncMedia=(force=false)=>{
  const pt=ed.point();if(!pt)return;
  if(force||Math.abs(ed.video.currentTime-pt.source)>.18)ed.video.currentTime=pt.source;
  if(pt.frozen||!ed.playing)ed.video.pause();else if(ed.video.paused)ed.video.play().catch(error=>{ed.pause();ed.error(error);});
  const audio=ed.project.audio,local=pt.source-pt.range.cut.start,remaining=pt.range.cut.end-pt.source;
  const fade=Math.min(1,audio.fadeIn?local/audio.fadeIn:1,audio.fadeOut?remaining/audio.fadeOut:1);
  ed.video.muted=!ed.sound;ed.video.volume=EditorModel.clamp(audio.volume*fade,0,1);
  ed.adVideo.muted=!ed.sound||ed.project.adConfig?.adAudio===false;
  ed.video.playbackRate=ed.rate;ed.adVideo.playbackRate=ed.rate;
};
ed.tick=now=>{if(!ed.playing)return;const pt=ed.point();if(pt?.frozen||ed.video.readyState>=2&&!ed.video.seeking)ed.head+=Math.max(0,now-ed.lastTick)/1000*ed.rate;ed.lastTick=now;
  if(ed.loop&&pt&&ed.head>=pt.range.start+pt.range.duration-.02){ed.head=pt.range.start;ed.syncMedia(true);}
  if(ed.head>=ed.duration){ed.head=Math.max(0,ed.duration-.001);ed.pause();ed.syncMedia(true);return;}
  ed.syncMedia();ed.paint();ed.updatePlayhead();ed.followPlayhead();ed.animation=requestAnimationFrame(ed.tick);
};
ed.togglePlay=()=>{if(!ed.project)return;if(ed.playing){ed.pause();return;}if(ed.head>=ed.duration-.05)ed.seek(0);ed.playing=true;ed.lastTick=performance.now();ed.syncMedia();ed.animation=requestAnimationFrame(ed.tick);ed.paint();};
ed.toggleSound=()=>{ed.sound=!ed.sound;ed.video.muted=!ed.sound;ed.adVideo.muted=!ed.sound||ed.project?.adConfig?.adAudio===false;uiSetIcon('ed-sound',ed.sound?"volume-up-fill":"volume-mute-fill");document.getElementById('ed-sound').setAttribute('aria-pressed',String(ed.sound));};
ed.stepFrame=delta=>{ed.pause();ed.seek(ed.head+delta/30);};
ed.fullscreen=()=>{const el=document.querySelector('.ed-player');if(document.fullscreenElement)document.exitFullscreen();else el.requestFullscreen().catch(ed.error);};
ed.fitStage=()=>{
  if(!ed.project)return;const space=document.getElementById('ed-player-space'),box=document.getElementById('ed-stage-box');const p=ed.project,ratio=p.output.width/p.output.height;
  document.getElementById('ed-output-label').textContent=`${p.output.aspectRatio} · ${p.output.width} × ${p.output.height}`;
  const height=Math.max(100,Math.min(space.clientHeight-34,(space.clientWidth-34)/ratio)),width=height*ratio;box.style.width=`${width}px`;box.style.height=`${height}px`;
  const scale=Math.min(1,640/p.output.width);ed.canvas.width=Math.round(p.output.width*scale);ed.canvas.height=Math.round(p.output.height*scale);ed.paint();
};
ed.wrap=(text,maxWidth,font)=>{ed.ctx.font=font;const lines=[];for(const line of String(text).split('\n')){let current='';for(const word of line.split(/\s+/)){const next=current?current+' '+word:word;if(current&&ed.ctx.measureText(next).width>maxWidth){lines.push(current);current=word;}else current=next;}lines.push(current);}return lines;};
ed.drawText=(text,style)=>{
  const ctx=ed.ctx,p=ed.project,W=p.output.width,H=p.output.height,size=style.fontSize*W/1080,font=`${style.bold===false?'400':'700'} ${size}px Arial`;
  const lines=ed.wrap(text,W*.88,font),lineHeight=size*1.18,height=lines.length*lineHeight,x=style.x*W,y=style.y*H;ctx.font=font;ctx.textAlign='center';ctx.textBaseline='middle';
  const width=Math.max(...lines.map(line=>ctx.measureText(line).width),size)+size*.5;
  if(style.box){ctx.fillStyle='#101411cc';ctx.beginPath();ctx.roundRect(x-width/2,y-height/2-size*.2,width,height+size*.4,size*.14);ctx.fill();}
  lines.forEach((line,i)=>{const yy=y+(i-(lines.length-1)/2)*lineHeight;ctx.lineJoin='round';ctx.lineWidth=(style.outline??3)*W/1080*2;ctx.strokeStyle='#111712';if(ctx.lineWidth)ctx.strokeText(line,x,yy);ctx.fillStyle=style.color||'#ffffff';ctx.fillText(line,x,yy);});
  return{x:(x-width/2)/W,y:(y-height/2)/H,w:width/W,h:height/H};
};
ed.currentCue=time=>{const cues=ed.project.subtitles.cues;let a=0,b=cues.length;while(a<b){const mid=(a+b)>>1;if(cues[mid].start<=time)a=mid+1;else b=mid;}const cue=cues[a-1];return cue&&time<cue.end?cue:null;};
ed.paint=()=>{
  const p=ed.project;if(!p||!ed.canvas.width)return;const ctx=ed.ctx,W=p.output.width,H=p.output.height,pt=ed.point();if(!pt)return;
  ctx.setTransform(ed.canvas.width/W,0,0,ed.canvas.height/H,0,0);ctx.fillStyle=p.background;ctx.fillRect(0,0,W,H);ed.bounds=null;
  const correction=p.colorCorrection;ctx.filter=`brightness(${1+correction.brightness}) contrast(${correction.contrast}) saturate(${correction.saturation})`;
  p.layers.forEach((layer,index)=>{
    if(!layer.enabled)return;const r=layer.rect,c=layer.crop,dx=r.x*W,dy=r.y*H,dw=r.w*W,dh=r.h*H;
    if(ed.selected.type==='layer'&&ed.selected.index===index)ed.bounds={...r,label:layer.name,locked:layer.locked};
    if(ed.video.readyState<2)return;
    ctx.save();ctx.globalAlpha=layer.opacity;ctx.beginPath();if(layer.mask==='circle')ctx.ellipse(dx+dw/2,dy+dh/2,dw/2,dh/2,0,0,Math.PI*2);else if(layer.mask==='rounded')ctx.roundRect(dx,dy,dw,dh,Math.min(dw,dh)*.08);else ctx.rect(dx,dy,dw,dh);ctx.clip();
    let sx=c.x*p.source.width,sy=c.y*p.source.height,sw=c.w*p.source.width,sh=c.h*p.source.height;
    let tx=dx,ty=dy,tw=dw,th=dh;
    if(layer.fit==='cover'){const ratio=dw/dh;if(sw/sh>ratio){const newW=sh*ratio;sx+=(sw-newW)/2;sw=newW;}else{const newH=sw/ratio;sy+=(sh-newH)/2;sh=newH;}}
    else{const scale=Math.min(dw/sw,dh/sh);tw=sw*scale;th=sh*scale;tx+=(dw-tw)/2;ty+=(dh-th)/2;ctx.fillStyle=p.background;ctx.fillRect(dx,dy,dw,dh);}
    if(layer.flip){ctx.translate(dx*2+dw,0);ctx.scale(-1,1);}
    ctx.drawImage(ed.video,sx,sy,sw,sh,tx,ty,tw,th);ctx.restore();
  });ctx.filter='none';
  p.texts.forEach((text,index)=>{if(pt.source<text.start||pt.source>=text.end)return;const bounds=ed.drawText(text.text,{...text,outline:3});if(ed.selected.type==='text'&&ed.selected.index===index)ed.bounds={...bounds,label:'Текст'};});
  const sub=p.subtitles,cue=sub.enabled?ed.currentCue(pt.source):null;
  if(cue){const bounds=ed.drawText(cue.text,{...sub,bold:sub.preset!=='classic',box:sub.preset==='box'});if(sub.preset==='karaoke'&&cue.words?.length){
      const current=cue.words.find(w=>pt.source>=w.start&&pt.source<w.end);if(current){const ctx=ed.ctx;ctx.font=`700 ${sub.fontSize*W/1080}px Arial`;const phrase=cue.text;const prefix=phrase.indexOf(current.text.trim());if(prefix>=0&&ctx.measureText(phrase).width<W*.88){const left=sub.x*W-ctx.measureText(phrase).width/2+ctx.measureText(phrase.slice(0,prefix)).width;ctx.textAlign='left';ctx.fillStyle=sub.highlight;ctx.fillText(current.text.trim(),left,sub.y*H);ctx.textAlign='center';}}
    }if(ed.selected.type==='subtitles')ed.bounds={...bounds,label:'Субтитры'};
  }
  const transitions=p.transitions||{},contentTime=pt.source-pt.range.cut.start,remaining=pt.range.cut.end-pt.source;
  const visibility=Math.max(0,Math.min(1,transitions.fadeIn?contentTime/transitions.fadeIn:1,transitions.fadeOut?remaining/transitions.fadeOut:1));
  if(visibility<1){ctx.save();ctx.globalAlpha=1-visibility;ctx.fillStyle='#000000';ctx.fillRect(0,0,W,H);ctx.restore();}
  ed.paintAd(pt);
  ed.syncSelection();document.getElementById('ed-time').textContent=`${edTime(ed.head)} / ${edTime(ed.duration)}`;uiSetIcon('ed-play',ed.playing?'pause-fill':'play-fill');document.getElementById('ed-play').setAttribute('aria-label',ed.playing?'Пауза монтажа':'Воспроизвести монтаж');
  document.getElementById('ed-player-note').textContent=ed.adError|| (pt.frozen?'Стоп-кадр · рекламный баннер · звук исходника на паузе':`${p.source.name} · фрагмент ${pt.range.index+1}/${p.cuts.length} · исходник ${edTime(pt.source)}`);
};
ed.paintAd=pt=>{
  const event=pt.ad;if(!event){ed.adVideo.pause();ed.activeAdKey=null;return;}const asset=ed.assets.find(a=>a.id===event.assetId);if(!asset)return;
  const p=ed.project,W=p.output.width,H=p.output.height,w=Math.min(W*event.width/100,H*asset.width/asset.height),h=w*asset.height/asset.width,left=Math.max(0,Math.min(W-w,W*event.x/100-w/2)),top=Math.max(0,Math.min(H-h,H*event.y/100-h/2));
  let media;if(asset.animated){media=ed.adVideo;const src=asset.previewUrl||asset.url,key=`${pt.range.index}:${event.start}:${asset.id}`;if(ed.activeAdKey!==key){ed.activeAdKey=key;if(media.getAttribute('src')!==src)media.src=src;media.currentTime=0;}
    const t=Math.min(pt.local-event.start,asset.duration-.001);if(Math.abs(media.currentTime-t)>(ed.playing?.25:.015))media.currentTime=Math.max(0,t);if(ed.playing&&media.paused&&!media.ended)media.play().catch(()=>{});if(!ed.playing)media.pause();
  }else{if(!ed.mediaCache.has(asset.id)){const image=new Image();image.onload=ed.paint;image.src=asset.url;ed.mediaCache.set(asset.id,image);}media=ed.mediaCache.get(asset.id);}
  if(ed.selected.type==='ad')ed.bounds={x:left/W,y:top/H,w:w/W,h:h/H,label:'Рекламный баннер'};
  if(asset.animated&&media.readyState<2||!asset.animated&&!media.complete)return;
  const progress=event.fade?Math.max(0,Math.min(1,(pt.local-event.start)/event.fade,(event.start+event.duration-pt.local)/event.fade)):1,ease=progress*progress*(3-2*progress),ctx=ed.ctx;
  ctx.save();ctx.globalAlpha=event.opacity*progress;let x=left,y=top,scale=1;if(event.animation==='slide-up')y+=H*.08*(1-ease);if(event.animation==='slide-left')x+=W*.1*(1-ease);if(event.animation==='zoom')scale=.88+.12*ease;ctx.translate(x+w/2,y+h/2);ctx.scale(scale,scale);ctx.drawImage(media,-w/2,-h/2,w,h);ctx.restore();
};
ed.syncSelection=()=>{
  const el=document.getElementById('ed-selection'),b=ed.bounds,box=document.getElementById('ed-stage-box');
  if(!b||ed.playing||b.locked){el.style.display='none';return;}
  Object.assign(el.style,{display:'block',width:`${b.w*box.clientWidth}px`,height:`${b.h*box.clientHeight}px`,transform:`translate3d(${b.x*box.clientWidth}px,${b.y*box.clientHeight}px,0)`});document.getElementById('ed-selection-label').textContent=b.label;
};
ed.updatePlayhead=()=>{const el=document.getElementById('ed-playhead');if(el)el.style.left=`${82+ed.head*ed.zoom}px`;};
ed.renderTimeline=()=>{
  const inner=document.getElementById('ed-timeline-inner');if(!ed.project){inner.innerHTML='<div class="ed-empty">Импортируй видео, чтобы начать монтаж</div>';return;}
  const width=Math.max(document.getElementById('ed-timeline-scroll').clientWidth-82,ed.duration*ed.zoom);inner.style.width=`${width+82}px`;
  const interval=[1,2,5,10,15,30,60,120,300,600,1200].find(step=>step*ed.zoom>=70)||1800;let marks='';for(let t=0;t<=ed.duration;t+=interval)marks+=`<span class="ed-ruler-mark" style="left:${t*ed.zoom}px">${edTime(t).slice(0,-3)}</span>`;
  const cuts=(type)=>ed.ranges.map(r=>`<div class="ed-cut ${type==='camera'?'camera':''} ${r.index===ed.selectedCut?'active':''}" data-ed-cut="${r.index}" style="left:${r.start*ed.zoom}px;width:${Math.max(8,r.duration*ed.zoom)}px" role="button" tabindex="0" aria-label="Фрагмент ${r.index+1}, ${edTime(r.cut.start)} — ${edTime(r.cut.end)}">${type==='video'?ed.filmTiles(r,visibleFrom,visibleTo):''}<button class="ed-trim start" data-ed-trim="start" aria-label="Изменить начало фрагмента"></button><span class="ed-cut-label">${r.index+1} · ${edTime(r.cut.start)}</span><button class="ed-trim end" data-ed-trim="end" aria-label="Изменить конец фрагмента"></button></div>`).join('');
  const scroll=document.getElementById('ed-timeline-scroll'),visibleFrom=Math.max(0,(scroll.scrollLeft-150)/ed.zoom),visibleTo=(scroll.scrollLeft+scroll.clientWidth+150)/ed.zoom;let captions='',ads='';
  for(const r of ed.ranges){
    if(r.start+r.duration<visibleFrom||r.start>visibleTo)continue;
    ed.project.subtitles.cues.forEach((cue,i)=>{if(cue.end<=r.cut.start||cue.start>=r.cut.end)return;const map=t=>t+r.events.reduce((sum,e)=>sum+(e.freeze&&e.start<=t?e.duration:0),0);const start=r.start+map(Math.max(r.cut.start,cue.start)-r.cut.start),end=r.start+map(Math.min(r.cut.end,cue.end)-r.cut.start);if(end<visibleFrom||start>visibleTo)return;captions+=`<button class="ed-timeline-caption" data-ed-cue="${i}" data-ed-time="${start}" style="left:${start*ed.zoom}px;width:${Math.max(8,(end-start)*ed.zoom)}px" title="${edEsc(cue.text)}">${edEsc(cue.text)}</button>`;});
    r.timed.forEach((event,i)=>{ads+=`<div class="ed-timeline-ad" data-ed-ad="${i}" data-ed-range="${r.index}" style="left:${(r.start+event.start)*ed.zoom}px;width:${Math.max(8,event.duration*ed.zoom)}px" title="Рекламный показ ${i+1} · ${event.duration}с">${uiIcon("badge-ad-fill")} ${event.duration}с${!ed.assets.find(a=>a.id===event.assetId)?.animated?'<button class="ed-trim end" data-ed-ad-resize="true" aria-label="Изменить длительность PNG"></button>':''}</div>`;});
  }
  inner.innerHTML=`<div class="ed-ruler" data-ed-seek="true" style="width:${width}px">${marks}</div><div class="ed-track" data-ed-seek="true" style="width:${width}px"><div class="ed-track-label">${uiIcon("collection-play-fill")} Видео</div>${cuts('video')}</div><div class="ed-track ed-track-audio" data-ed-seek="true" style="width:${width}px"><div class="ed-track-label">${uiIcon("volume-up-fill")} Звук</div><canvas class="ed-wave" id="ed-wave" aria-hidden="true"></canvas></div><div class="ed-track" data-ed-seek="true" style="width:${width}px"><div class="ed-track-label">${uiIcon("camera-video-fill")} Камера</div>${cuts('camera')}</div><div class="ed-track" data-ed-seek="true" style="width:${width}px"><div class="ed-track-label">${uiIcon("badge-cc-fill")} Субтитры</div>${captions}</div><div class="ed-track" data-ed-seek="true" style="width:${width}px"><div class="ed-track-label">${uiIcon("badge-ad-fill")} Реклама</div>${ads}</div><div class="ed-playhead" id="ed-playhead" style="left:${82+ed.head*ed.zoom}px"></div>`;
  inner.style.setProperty('--film',ed.strip?.url?`url(${ed.strip.url})`:'none');ed.drawWave();
};
ed.split=()=>{if(!ed.project)return;const pt=ed.point(),c=pt.range.cut,t=pt.source;if(t-c.start<.2||c.end-t<.2)return showToast('Выбери точку внутри фрагмента, дальше от края','info');ed.change(p=>{p.cuts.splice(pt.range.index,1,{id:EditorModel.uid(),start:c.start,end:t},{id:EditorModel.uid(),start:t,end:c.end});p.adConfig.clips={};});};
ed.duplicateCut=()=>{if(!ed.project)return;ed.change(p=>{p.cuts.splice(ed.selectedCut+1,0,{...p.cuts[ed.selectedCut],id:EditorModel.uid()});p.adConfig.clips={};});};
ed.removeCut=()=>{if(!ed.project)return;if(ed.project.cuts.length===1)return showToast('В монтаже должен остаться хотя бы один фрагмент','info');ed.change(p=>{p.cuts.splice(ed.selectedCut,1);p.adConfig.clips={};});ed.selectedCut=Math.min(ed.selectedCut,ed.project.cuts.length-1);ed.seek(ed.ranges[ed.selectedCut].start);};
ed.moveCut=delta=>{if(!ed.project)return;const next=ed.selectedCut+delta;if(next<0||next>=ed.project.cuts.length)return;ed.change(p=>{const [cut]=p.cuts.splice(ed.selectedCut,1);p.cuts.splice(next,0,cut);p.adConfig.clips={};});ed.selectedCut=next;ed.seek(ed.ranges[next].start);};
ed.setTool=tool=>{const body=document.getElementById('ed-body'),close=window.innerWidth<700&&ed.tool===tool&&body.classList.contains('left-open');ed.tool=tool;body.classList.toggle('left-open',!close);if(window.innerWidth<780)body.classList.remove('inspector-open');ed.renderLeft();document.querySelectorAll('[data-ed-tool]').forEach(el=>el.classList.toggle('active',el.dataset.edTool===tool));};
ed.toggleInspector=()=>document.getElementById('ed-body').classList.toggle('inspector-open');
ed.select=(type,index=0)=>{ed.inspectorTab='layer';ed.selected={type,index};if(type==='ad'){const pt=ed.point(),event=pt?.range.timed[0];if(event)ed.seek(pt.range.start+event.start+Math.min(event.fade+.1,event.duration/2));}
  ed.renderInspector();ed.paint();if(window.innerWidth<780){const body=document.getElementById('ed-body');body.classList.remove('left-open');body.classList.add('inspector-open');}};
ed.renderPanels=()=>{ed.renderLeft();ed.renderInspector();document.querySelectorAll('[data-ed-tool]').forEach(el=>el.classList.toggle('active',el.dataset.edTool===ed.tool));};
ed.modal=html=>{ed.closeModal();const modal=document.createElement('div');modal.className='ed-modal';modal.id='ed-modal';modal.innerHTML=html;modal.onclick=e=>{if(e.target===modal)ed.closeModal();};document.body.appendChild(modal);modal.querySelector('button,input,select,textarea')?.focus();};
ed.closeModal=()=>{document.getElementById('ed-modal')?.remove();ed.cropDraft=null;};
ed.showProjects=async()=>{try{ed.projects=await ed.api('/projects');ed.modal(`<div class="ed-dialog narrow"><div class="ed-dialog-head"><h2>Мои проекты</h2><button class="ed-button icon" onclick="ed.closeModal()" aria-label="Закрыть">${uiIcon("x-circle-fill")}</button></div>${ed.projects.length?ed.projects.map((p,i)=>`<button class="ed-list-item" onclick="ed.loadProject(ed.projects[${i}].id)">${edEsc(p.name)}<small>${new Date(p.updatedAt).toLocaleString('ru')} · ${edEsc(p.source.name)}</small></button>`).join(''):'<p class="ed-small">Импортируй видео, чтобы создать первый проект.</p>'}</div>`);}catch(error){ed.error(error);}};
ed.newProject=()=>{if(ed.project)ed.useVideo(ed.project.source.videoId);else ed.setTool('media');};
ed.video.addEventListener('loadedmetadata',()=>{ed.syncMedia(true);ed.paint();});ed.video.addEventListener('seeked',()=>{ed.paint();if(ed.cropDraft)ed.drawCrop();});ed.video.addEventListener('loadeddata',ed.paint);ed.adVideo.addEventListener('seeked',ed.paint);ed.adVideo.addEventListener('loadeddata',ed.paint);
new ResizeObserver(()=>{if(state.currentPage==='editor')ed.fitStage();}).observe(document.getElementById('ed-player-space'));
let edScrollFrame;document.getElementById('ed-timeline-scroll').addEventListener('scroll',()=>{if(!edScrollFrame)edScrollFrame=requestAnimationFrame(()=>{edScrollFrame=null;ed.renderTimeline();});});
window.addEventListener('beforeunload',event=>{if(ed.dirty||ed.saving){event.preventDefault();event.returnValue='';}});
