/* Editor workflow layer: filmstrip and waveform on the timeline, preview speed and loop,
   trim to playhead, frame export, timeline zoom and the shortcut sheet. */
const edOnce=(el,name)=>new Promise((resolve,reject)=>{
  const done=event=>{el.removeEventListener(name,done);el.removeEventListener('error',fail);resolve(event);};
  const fail=()=>{el.removeEventListener(name,done);el.removeEventListener('error',fail);reject(new Error('Видео не читается'));};
  el.addEventListener(name,done);el.addEventListener('error',fail);
});

/* ---------- Filmstrip: one sprite of frames per source, sampled once in the browser ---------- */
ed.strip=null;
ed.loadStrip=async source=>{
  if(ed.strip?.videoId===source.videoId)return;
  const ratio=source.width/source.height||16/9,tileW=Math.max(20,Math.min(60,Math.round(26*ratio)));
  const count=Math.max(12,Math.min(150,Math.ceil(source.duration/4)));
  const strip={videoId:source.videoId,tileW,count,step:source.duration/count,url:null};ed.strip=strip;
  const video=document.createElement('video');video.muted=true;video.preload='auto';video.src=source.videoUrl;
  try{
    await edOnce(video,'loadeddata');
    const frameW=tileW*2,frameH=52,canvas=document.createElement('canvas');canvas.width=frameW*count;canvas.height=frameH;
    const ctx=canvas.getContext('2d');
    for(let i=0;i<count;i++){
      if(ed.strip!==strip)return;// another project was opened meanwhile
      video.currentTime=Math.min(source.duration-.05,(i+.5)*strip.step);
      await edOnce(video,'seeked');
      ctx.drawImage(video,i*frameW,0,frameW,frameH);
      // Publish progressively so long sources fill in while sampling continues.
      if(i%20===19||i===count-1){strip.url=canvas.toDataURL('image/jpeg',.72);if(state.currentPage==='editor')ed.renderTimeline();}
    }
  }catch{/* the filmstrip is decoration; the timeline works without it */}
  finally{video.removeAttribute('src');video.load();}
};
ed.filmTiles=(r,from,to)=>{
  const s=ed.strip;if(!s?.url||s.videoId!==ed.project?.source.videoId)return'';
  const width=Math.max(8,r.duration*ed.zoom),first=Math.max(0,Math.floor((from-r.start)*ed.zoom/s.tileW)),last=Math.min(Math.ceil(width/s.tileW),Math.ceil((to-r.start)*ed.zoom/s.tileW));
  let html='';
  for(let k=first;k<last;k++){
    const x=k*s.tileW,local=Math.min(r.duration,(x+s.tileW/2)/ed.zoom),source=r.cut.start+AdSchedule.sourceAt(local,r.events).time;
    const frame=Math.max(0,Math.min(s.count-1,Math.floor(source/s.step)));
    html+=`<i class="ed-film" style="left:${x}px;width:${s.tileW}px;background-size:${s.count*s.tileW}px 100%;background-position:${-frame*s.tileW}px 0"></i>`;
  }
  return html;
};

/* ---------- Waveform: peaks from the server, drawn only for the visible window ---------- */
ed.wave=null;
ed.loadWave=async source=>{
  const id=source.videoId;if(ed.wave?.videoId===id)return;
  ed.wave={videoId:id,rate:50,peaks:[],max:1};
  try{
    const response=await fetch(`/api/videos/${id}/waveform`),data=await response.json();
    if(!response.ok)throw new Error(data.error);
    if(ed.wave.videoId!==id)return;
    ed.wave={videoId:id,rate:data.rate,peaks:data.peaks,max:Math.max(1,data.peaks.reduce((a,b)=>a>b?a:b,0))};ed.drawWave();
  }catch{/* no waveform: the audio track stays empty */}
};
ed.drawWave=()=>{
  const canvas=document.getElementById('ed-wave'),scroll=document.getElementById('ed-timeline-scroll');if(!canvas||!ed.project)return;
  const left=Math.max(0,scroll.scrollLeft-82),width=Math.max(1,Math.min(scroll.clientWidth,ed.duration*ed.zoom-left)),height=24,dpr=window.devicePixelRatio||1;
  canvas.style.left=`${left}px`;canvas.style.width=`${width}px`;canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);
  const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,width,height);
  const w=ed.wave;if(!w?.peaks.length||w.videoId!==ed.project.source.videoId)return;
  const gain=Math.min(1,ed.project.audio.volume),mid=height/2,styles=getComputedStyle(canvas);
  const sound=styles.getPropertyValue('--wave').trim()||'#b5c98c',freeze=styles.getPropertyValue('--wave-freeze').trim()||'#8fd3ff';
  let index=0;
  for(let x=0;x<width;x+=2){
    const t0=(left+x)/ed.zoom;if(t0>=ed.duration)break;
    while(index<ed.ranges.length-1&&t0>=ed.ranges[index].start+ed.ranges[index].duration)index++;
    const r=ed.ranges[index],mapped=AdSchedule.sourceAt(t0-r.start,r.events);
    // During a freeze the source is silent: show a thin marker instead of a waveform.
    if(mapped.frozen){ctx.fillStyle=freeze;ctx.globalAlpha=.55;ctx.fillRect(x,mid-.5,2,1);ctx.globalAlpha=1;continue;}
    const s0=r.cut.start+mapped.time,s1=s0+2/ed.zoom;let peak=0;
    for(let i=Math.floor(s0*w.rate),end=Math.min(w.peaks.length,Math.max(i+1,Math.ceil(s1*w.rate)));i<end;i++)if(w.peaks[i]>peak)peak=w.peaks[i];
    const h=Math.max(1,Math.sqrt(peak/w.max)*gain*(height-2));
    ctx.fillStyle=sound;ctx.fillRect(x,mid-h/2,1.5,h);
  }
};

/* ---------- Playback helpers ---------- */
ed.cycleRate=()=>{
  const rates=[.5,1,1.5,2];ed.rate=rates[(rates.indexOf(ed.rate)+1)%rates.length];
  ed.video.playbackRate=ed.rate;ed.adVideo.playbackRate=ed.rate;
  const button=document.getElementById('ed-rate');button.textContent=`${String(ed.rate).replace('.',',')}×`;button.classList.toggle('on',ed.rate!==1);
};
ed.toggleLoop=()=>{
  ed.loop=!ed.loop;const button=document.getElementById('ed-loop');
  button.setAttribute('aria-pressed',String(ed.loop));button.classList.toggle('on',ed.loop);
};
ed.followPlayhead=()=>{
  const scroll=document.getElementById('ed-timeline-scroll'),x=82+ed.head*ed.zoom;
  if(x>scroll.scrollLeft+scroll.clientWidth-40||x<scroll.scrollLeft+82)scroll.scrollLeft=Math.max(0,x-82-scroll.clientWidth*.15);
};
ed.jumpBoundary=direction=>{
  if(!ed.project)return;ed.pause();
  const marks=[...ed.ranges.map(r=>r.start),ed.duration];
  const target=direction>0?marks.find(t=>t>ed.head+.01):[...marks].reverse().find(t=>t<ed.head-.01);
  if(target!==undefined)ed.seek(target);
};
// Q / W: drop everything before or after the playhead inside the current fragment.
ed.trimAtHead=side=>{
  if(!ed.project)return;const pt=ed.point();if(!pt)return;
  if(pt.frozen)return showToast('Курсор на рекламной паузе: передвинь его на видео','info');
  const index=pt.range.index,cut=pt.range.cut,t=pt.source;
  if(side==='start'?cut.end-t<.2:t-cut.start<.2)return showToast('Слишком близко к краю фрагмента','info');
  ed.change(p=>{p.cuts[index][side]=t;p.adConfig.clips={};});
  ed.selectedCut=index;ed.seek(side==='start'?ed.ranges[index].start:ed.ranges[index].start+ed.ranges[index].duration-.04);
};

/* ---------- Frame export: paint the output frame at full resolution, then restore ---------- */
ed.saveFrame=()=>{
  if(!ed.project)return;ed.pause();
  const canvas=ed.canvas,previous=[canvas.width,canvas.height],p=ed.project;
  canvas.width=p.output.width;canvas.height=p.output.height;ed.paint();
  canvas.toBlob(blob=>{
    [canvas.width,canvas.height]=previous;ed.paint();
    if(!blob)return ed.error(new Error('Не удалось сохранить кадр'));
    const link=document.createElement('a');link.href=URL.createObjectURL(blob);
    link.download=`${(p.name||'кадр').replace(/[\\/:*?"<>|]+/g,'_')} ${edTime(ed.head).replace(/[:.]/g,'-')}.png`;
    link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);
    showToast('Кадр сохранён в загрузки','success');
  },'image/png');
};

/* ---------- Timeline zoom ---------- */
ed.setZoom=(value,anchorTime=ed.head,anchorX=null)=>{
  const scroll=document.getElementById('ed-timeline-scroll'),screenX=anchorX??(82+anchorTime*ed.zoom-scroll.scrollLeft);
  ed.zoom=EditorModel.clamp(Number(value)||8,.2,50);document.getElementById('ed-zoom').value=ed.zoom;
  ed.renderTimeline();scroll.scrollLeft=Math.max(0,82+anchorTime*ed.zoom-screenX);ed.renderTimeline();
};
ed.fitTimeline=()=>{
  if(!ed.project)return;const scroll=document.getElementById('ed-timeline-scroll');
  ed.setZoom((scroll.clientWidth-82-24)/Math.max(1,ed.duration),0,82);
};
document.getElementById('ed-timeline-scroll').addEventListener('wheel',event=>{
  if(!(event.ctrlKey||event.metaKey)||!ed.project)return;event.preventDefault();
  const scroll=event.currentTarget,x=event.clientX-scroll.getBoundingClientRect().left,time=Math.max(0,(scroll.scrollLeft+x-82)/ed.zoom);
  ed.setZoom(ed.zoom*(event.deltaY<0?1.15:1/1.15),time,x);
},{passive:false});

/* ---------- Shortcut sheet ---------- */
ed.showShortcuts=()=>{
  const groups=[
    ['Воспроизведение',[['Пробел / K','Пуск и пауза'],['← →','Кадр назад / вперёд'],['Shift + ← →','На секунду'],['↑ ↓','К предыдущей / следующей склейке'],['Home / End','В начало / в конец'],['L','Повтор фрагмента'],['M','Звук']]],
    ['Монтаж',[['Ctrl + B','Разделить под курсором'],['Q','Срезать начало до курсора'],['W','Срезать конец после курсора'],['Ctrl + D','Дублировать фрагмент'],['Delete','Удалить выбранное'],['Ctrl + Z / Ctrl + Shift + Z','Отменить / повторить']]],
    ['Таймлайн и проект',[['Ctrl + колесо / + / −','Масштаб'],['\\','Весь монтаж в окне'],['Ctrl + S','Сохранить'],['Esc','Закрыть панель или окно'],['?','Эта подсказка']]],
  ];
  ed.modal(`<div class="ed-dialog narrow ed-shortcuts"><div class="ed-dialog-head"><h2>Горячие клавиши</h2><button class="ed-button icon" onclick="ed.closeModal()" aria-label="Закрыть">${uiIcon("x-circle-fill")}</button></div><p class="ed-small">Работают в любой раскладке, когда курсор не стоит в поле ввода.</p>${groups.map(([title,rows])=>`<h3>${title}</h3><dl>${rows.map(([keys,action])=>`<dt>${keys.split(' / ').map(k=>`<kbd>${edEsc(k)}</kbd>`).join(' ')}</dt><dd>${action}</dd>`).join('')}</dl>`).join('')}</div>`);
};

/* ---------- Load media helpers with each project ---------- */
const edUseProjectBase=ed.useProject;
ed.useProject=async project=>{
  await edUseProjectBase(project);
  if(!ed.project)return;
  ed.loadWave(ed.project.source);ed.loadStrip(ed.project.source);
};
