(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.EditorModel=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
  const clamp=(v,min,max)=>Math.max(min,Math.min(max,v));
  const n=(v,fallback=0)=>Number.isFinite(Number(v))?Number(v):fallback;
  const uid=()=>typeof crypto!=='undefined'&&crypto.randomUUID?crypto.randomUUID():`layer-${Date.now()}-${Math.random().toString(36).slice(2,9)}`;
  function crop(r={}){const w=clamp(n(r.w,1),.01,1),h=clamp(n(r.h,1),.01,1);return{x:clamp(n(r.x),0,1-w),y:clamp(n(r.y),0,1-h),w,h};}
  function rect(r={}){const w=clamp(n(r.w,1),.05,1),h=clamp(n(r.h,1),.05,1);return{x:clamp(n(r.x),0,1-w),y:clamp(n(r.y),0,1-h),w,h};}
  const color=(v,fallback)=>/^#[a-f\d]{6}$/i.test(v||'')?v:fallback;
  function layersFor(layout='reaction'){
    const full={x:0,y:0,w:1,h:1};
    const content={id:'content',name:'Основное видео',enabled:true,locked:false,crop:full,rect:full,fit:'cover',mask:'rect',opacity:1,flip:false};
    const camera={id:'camera',name:'Камера / реакция',enabled:true,locked:false,crop:{x:0,y:0,w:.25,h:.29},rect:{x:0,y:0,w:1,h:.4},fit:'cover',mask:'rect',opacity:1,flip:false};
    if(layout==='reaction'){content.rect={x:0,y:.4,w:1,h:.6};}
    if(layout==='pip'){camera.rect={x:.61,y:.64,w:.36,h:.32};camera.mask='rounded';}
    if(layout==='side'){content.rect={x:0,y:0,w:.5,h:1};camera.rect={x:.5,y:0,w:.5,h:1};}
    if(layout==='single')camera.enabled=false;
    return[content,camera];
  }
  function create(source){return{schemaVersion:1,id:null,name:null,revision:0,source,output:{aspectRatio:'9:16',width:1080,height:1920,preset:'fast',crf:22},layout:'reaction',background:'#101214',layers:layersFor(),texts:[],cuts:[{id:uid(),start:0,end:source.duration}],colorCorrection:{brightness:0,contrast:1,saturation:1},audio:{volume:1,fadeIn:0,fadeOut:0},transitions:{fadeIn:0,fadeOut:0},subtitles:{enabled:true,preset:'bold',fontSize:54,x:.5,y:.76,color:'#ffffff',highlight:'#d9fa75',outline:3,cues:[],language:'ru'},adConfig:{enabled:false,freezeOnAd:true,count:2,duration:6,firstStart:26,minGap:8,endPadding:3,width:90,x:50,y:48,opacity:1,fade:.3,animation:'fade',rotation:'clip',assetIds:[],clips:{}},updatedAt:new Date().toISOString()};}
  function normalize(raw,source){
    const d=create(source),p={...d,...raw,source};
    p.name=String(p.name||'Новый монтаж').slice(0,160);
    p.adConfig={...d.adConfig,...p.adConfig,clips:p.adConfig?.clips||{}};
    p.adConfig.assetIds=Array.isArray(p.adConfig.assetIds)?p.adConfig.assetIds.slice(0,100):[];
    const ratios={'9:16':[1080,1920],'16:9':[1920,1080],'1:1':[1080,1080],'4:5':[1080,1350]};
    const aspect=ratios[p.output?.aspectRatio]?p.output.aspectRatio:'9:16';
    const factor=p.output?.quality==='720'?2/3:p.output?.quality==='540'?.5:1;
    p.output={...d.output,...p.output,aspectRatio:aspect,width:Math.round(ratios[aspect][0]*factor/2)*2,height:Math.round(ratios[aspect][1]*factor/2)*2,crf:clamp(n(p.output?.crf,22),15,35)};
    p.output.preset=['ultrafast','fast','medium','slow'].includes(p.output.preset)?p.output.preset:'fast';
    p.background=color(p.background,d.background);
    p.layers=(Array.isArray(p.layers)?p.layers:d.layers).slice(0,8).map((l,i)=>({id:String(l.id||uid()),name:String(l.name||`Слой ${i+1}`).slice(0,80),enabled:l.enabled!==false,locked:!!l.locked,crop:crop(l.crop),rect:rect(l.rect),fit:l.fit==='contain'?'contain':'cover',mask:['circle','rounded'].includes(l.mask)?l.mask:'rect',opacity:clamp(n(l.opacity,1),0,1),flip:!!l.flip}));
    if(!p.layers.length)throw new Error('Добавь хотя бы один видеослой');
    p.cuts=(Array.isArray(p.cuts)?p.cuts:d.cuts).slice(0,1000).map(c=>({id:String(c.id||uid()),start:n(c.start,-1),end:n(c.end,-1)}));
    if(!p.cuts.length||p.cuts.some(c=>c.start<0||c.end<=c.start||c.end>source.duration+.001))throw new Error('Проверь границы фрагментов');
    p.colorCorrection={brightness:clamp(n(p.colorCorrection?.brightness),-.5,.5),contrast:clamp(n(p.colorCorrection?.contrast,1),0,2),saturation:clamp(n(p.colorCorrection?.saturation,1),0,3)};
    p.audio={volume:clamp(n(p.audio?.volume,1),0,3),fadeIn:clamp(n(p.audio?.fadeIn),0,5),fadeOut:clamp(n(p.audio?.fadeOut),0,5)};
    p.transitions={fadeIn:clamp(n(p.transitions?.fadeIn),0,3),fadeOut:clamp(n(p.transitions?.fadeOut),0,3)};
    p.texts=(Array.isArray(p.texts)?p.texts:[]).slice(0,20).map(t=>({id:String(t.id||uid()),text:String(t.text||'').slice(0,2000),x:clamp(n(t.x,.5),0,1),y:clamp(n(t.y,.5),0,1),fontSize:clamp(n(t.fontSize,60),16,160),color:color(t.color,'#ffffff'),start:clamp(n(t.start),0,source.duration),end:clamp(n(t.end,source.duration),0,source.duration)}));
    if(p.texts.some(t=>t.end<=t.start))throw new Error('Конец показа текста должен быть позже начала');
    p.subtitles={...d.subtitles,...p.subtitles};
    p.subtitles.fontSize=clamp(n(p.subtitles.fontSize,54),16,140);p.subtitles.x=clamp(n(p.subtitles.x,.5),.05,.95);p.subtitles.y=clamp(n(p.subtitles.y,.76),.05,.95);
    p.subtitles.color=color(p.subtitles.color,'#ffffff');p.subtitles.highlight=color(p.subtitles.highlight,'#d9fa75');p.subtitles.outline=clamp(n(p.subtitles.outline,3),0,8);
    p.subtitles.preset=['classic','bold','box','karaoke'].includes(p.subtitles.preset)?p.subtitles.preset:'bold';
    p.subtitles.cues=(Array.isArray(p.subtitles.cues)?p.subtitles.cues:[]).slice(0,10000).map(c=>({id:String(c.id||uid()),start:n(c.start,-1),end:n(c.end,-1),text:String(c.text||'').slice(0,2000),words:(Array.isArray(c.words)?c.words:[]).slice(0,200).map(w=>({text:String(w.text||''),start:n(w.start),end:n(w.end)}))}));
    if(p.subtitles.cues.some(c=>c.start<0||c.end<=c.start||c.end>source.duration+.1))throw new Error('Проверь таймкоды субтитров');
    p.subtitles.cues.sort((a,b)=>a.start-b.start);
    return p;
  }
  function compile(p){return{output:p.output,composition:{layers:p.layers,background:p.background},colorCorrection:p.colorCorrection,audio:p.audio,transitions:p.transitions,sourceTimed:true,subtitles:p.subtitles,textOverlays:p.texts.map(t=>({content:t.text,fontSize:t.fontSize*p.output.width/1080,fontColor:t.color,x:`w*${t.x}-text_w/2`,y:`h*${t.y}-text_h/2`,borderWidth:2,showFrom:t.start,showTo:t.end}))};}
  function groupWords(words,maxWords=5){
    const cues=[];let group=[];
    function flush(){if(!group.length)return;cues.push({id:uid(),start:group[0].start,end:Math.max(group[0].start+.1,group.at(-1).end),text:group.map(w=>w.text.trim()).join(' '),words:group});group=[];}
    for(const word of words){if(!word.text.trim()||word.end<=word.start)continue;if(group.length&&(word.start-group.at(-1).end>.7||group.length>=maxWords))flush();group.push(word);if(/[.!?…]$/.test(word.text.trim()))flush();}flush();return cues;
  }
  return{clamp,uid,crop,rect,create,normalize,compile,layersFor,groupWords};
});
