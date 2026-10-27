const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { renderClip, getVideoInfo } = require('../src/services/ffmpeg');
const { plan } = require('../public/js/ad-schedule');
const ffmpeg = args => execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-y',...args],{windowsHide:true,maxBuffer:10*1024*1024});
function pixel(file,time) {
  return [...ffmpeg(['-ss',String(time),'-i',file,'-vf','crop=2:2:160:280','-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1']).subarray(0,3)];
}
test('real MP4 has precisely timed static and single-play animated banners, preserving source audio', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vidcreator-render-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const source=path.join(dir,'source.mp4'), red=path.join(dir,'red.png'), green=path.join(dir,'green.mp4'), out=path.join(dir,'result.mp4');
  ffmpeg(['-f','lavfi','-i','color=black:s=320x568:r=20:d=8','-f','lavfi','-i','sine=frequency=440:duration=8','-c:v','libx264','-preset','ultrafast','-c:a','aac','-shortest',source]);
  ffmpeg(['-f','lavfi','-i','color=red:s=200x80','-frames:v','1',red]);
  ffmpeg(['-f','lavfi','-i','color=lime:s=200x80:r=20:d=1','-c:v','libx264','-preset','ultrafast',green]);
  const events=plan({enabled:true,assetIds:['red','green'],count:2,duration:1,firstStart:1,minGap:1,endPadding:1,fade:.1,width:80,y:50,rotation:'show'},[{duration:8}])[0].map((e,i)=>({...e,asset:{filePath:i?green:red,animated:!!i}}));
  await renderClip(source,out,0,8,{output:{width:320,height:568,preset:'ultrafast',crf:18},crop:{width:'iw',height:'ih'}},null,events);
  const info=await getVideoInfo(out);
  assert.ok(Math.abs(info.duration-8)<.15);
  assert.equal(info.audioCodec,'aac');
  assert.equal(info.width,320);
  const before=pixel(out,.5), first=pixel(out,1.5), between=pixel(out,3), second=pixel(out,6.7), after=pixel(out,7.5);
  assert.ok(before.every(c=>c<20),`Before: ${before}`);
  assert.ok(first[0]>180 && first[1]<50,`Red: ${first}`);
  assert.ok(between.every(c=>c<20),`Between: ${between}`);
  assert.ok(second[1]>180 && second[0]<50,`Green: ${second}`);
  assert.ok(after.every(c=>c<20),`After: ${after}`);
});
test('portrait source renders to landscape without invalid crop; silent source stays valid', async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vidcreator-crop-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const source=path.join(dir,'source.mp4'), out=path.join(dir,'out.mp4');
  ffmpeg(['-f','lavfi','-i','color=blue:s=160x284:r=20:d=1','-c:v','libx264','-preset','ultrafast',source]);
  await renderClip(source,out,0,1,{output:{width:320,height:180,preset:'ultrafast'},crop:{width:'ih*16/9',height:'ih'},colorCorrection:{saturation:0},transitions:{fadeIn:.1,fadeOut:.1}},null);
  const info=await getVideoInfo(out); assert.equal(info.width,320); assert.equal(info.height,180); assert.equal(info.audioCodec,null);
});

test('Cyrillic text, quotes, colons and percent signs survive FFmpeg drawtext', async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vidcreator-text-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const source=path.join(dir,'source.mp4'), out=path.join(dir,'out.mp4');
  ffmpeg(['-f','lavfi','-i','color=black:s=320x180:r=20:d=1','-c:v','libx264','-preset','ultrafast',source]);
  await renderClip(source,out,0,1,{output:{width:320,height:180,preset:'ultrafast'},textOverlays:[{content:"Скидка: 50% — 'Твой бренд'",fontSize:20,y:'20'}]},null);
  assert.equal((await getVideoInfo(out)).width,320);
  assert.ok(!fs.readdirSync(dir).some(file=>file.endsWith('.txt')));
});

function topFrame(file,time) {
  return ffmpeg(['-ss',String(time),'-i',file,'-vf','crop=320:80:0:0','-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1']);
}
function frameDiff(a,b) { assert.equal(a.length,b.length); return a.reduce((sum,n,i)=>sum+Math.abs(n-b[i]),0)/a.length; }
function audioRms(file,start,duration) {
  const raw=ffmpeg(['-ss',String(start),'-t',String(duration),'-i',file,'-vn','-ac','1','-f','f32le','pipe:1']);
  let power=0; for(let i=0;i<raw.length;i+=4) power+=raw.readFloatLE(i)**2;
  return Math.sqrt(power/(raw.length/4));
}
test('ad holds freeze a moving video, insert silence and resume all source content', async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vidcreator-freeze-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const source=path.join(dir,'source.mp4'), banner=path.join(dir,'banner.png'), out=path.join(dir,'out.mp4');
  ffmpeg(['-f','lavfi','-i','testsrc2=s=320x568:r=20:d=8','-f','lavfi','-i','sine=frequency=440:duration=8','-c:v','libx264','-crf','18','-preset','ultrafast','-c:a','aac','-shortest',source]);
  ffmpeg(['-f','lavfi','-i','color=red:s=200x80','-frames:v','1',banner]);
  const events=plan({enabled:true,assetIds:['a'],count:2,starts:[2,5],duration:1,minGap:1,endPadding:1,fade:.1,width:80,y:50,freezeOnAd:true},[{duration:8}])[0].map(e=>({...e,asset:{filePath:banner,animated:false}}));
  await renderClip(source,out,0,8,{output:{width:320,height:568,preset:'ultrafast',crf:18}},null,events);
  assert.ok(Math.abs((await getVideoInfo(out)).duration-10)<.15);
  assert.ok(frameDiff(topFrame(out,2.25),topFrame(out,2.75))<.5,'first hold is static');
  assert.ok(frameDiff(topFrame(out,6.25),topFrame(out,6.75))<.5,'second hold is static');
  assert.ok(frameDiff(topFrame(source,2.5),topFrame(out,3.5))<5,'content resumes at the paused point');
  assert.ok(frameDiff(topFrame(source,7.5),topFrame(out,9.5))<5,'tail of original source survives both holds');
  assert.ok(audioRms(out,2.2,.5)<.005,'first hold is silent');
  assert.ok(audioRms(out,6.2,.5)<.005,'second hold is silent');
  assert.ok(audioRms(out,3.2,.5)>.05,'source audio resumes');
  assert.ok(audioRms(out,9.2,.5)>.05,'audio tail survives');
});
test('video banner sound plays during the freeze and can be switched off', async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vidcreator-ad-audio-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const source=path.join(dir,'source.mp4'), banner=path.join(dir,'banner.mp4'), out=path.join(dir,'out.mp4'), muted=path.join(dir,'muted.mp4');
  ffmpeg(['-f','lavfi','-i','testsrc2=s=320x568:r=20:d=6','-f','lavfi','-i','sine=frequency=440:duration=6','-c:v','libx264','-preset','ultrafast','-c:a','aac','-shortest',source]);
  ffmpeg(['-f','lavfi','-i','color=red:s=200x80:r=20:d=2','-f','lavfi','-i','sine=frequency=880:duration=2','-c:v','libx264','-preset','ultrafast','-c:a','aac','-shortest',banner]);
  const make=adAudio=>plan({enabled:true,assetIds:['a'],count:1,firstStart:2,endPadding:1,fade:.1,width:80,y:50,freezeOnAd:true,adAudio},[{duration:6}],()=>({animated:true,duration:2}))[0].map(e=>({...e,asset:{filePath:banner,animated:true}}));
  await renderClip(source,out,0,6,{output:{width:320,height:568,preset:'ultrafast'}},null,make(true));
  assert.ok(Math.abs((await getVideoInfo(out)).duration-8)<.15);
  assert.ok(audioRms(out,1.2,.5)>.05,'source audio before the ad');
  assert.ok(audioRms(out,2.6,.8)>.05,'banner sound is heard during the freeze');
  assert.ok(audioRms(out,4.6,.5)>.05,'source audio resumes after the ad');
  await renderClip(source,muted,0,6,{output:{width:320,height:568,preset:'ultrafast'}},null,make(false));
  assert.ok(audioRms(muted,2.6,.8)<.005,'muted banner leaves the freeze silent');
});
test('freeze at the first frame works for a source without audio', async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vidcreator-first-frame-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const source=path.join(dir,'source.mp4'), banner=path.join(dir,'banner.png'), out=path.join(dir,'out.mp4');
  ffmpeg(['-f','lavfi','-i','testsrc2=s=320x568:r=20:d=2','-c:v','libx264','-preset','ultrafast',source]);
  ffmpeg(['-f','lavfi','-i','color=red:s=200x80','-frames:v','1',banner]);
  const events=plan({enabled:true,assetIds:['a'],count:1,firstStart:0,duration:1,endPadding:0,freezeOnAd:true},[{duration:2}])[0].map(e=>({...e,asset:{filePath:banner,animated:false}}));
  await renderClip(source,out,0,2,{output:{width:320,height:568,preset:'ultrafast'}},null,events);
  const info=await getVideoInfo(out); assert.equal(info.audioCodec,null); assert.ok(Math.abs(info.duration-3)<.15);
  assert.ok(frameDiff(topFrame(out,.2),topFrame(out,.7))<.5);
});

test('a video creative plays once to its native duration, ignoring the static-image duration', async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vidcreator-native-ad-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const source=path.join(dir,'source.mp4'),banner=path.join(dir,'ad.mp4'),out=path.join(dir,'out.mp4');
  ffmpeg(['-f','lavfi','-i','color=black:s=320x568:r=20:d=4','-c:v','libx264','-preset','ultrafast',source]);
  ffmpeg(['-f','lavfi','-i','color=red:s=200x80:r=20:d=0.5','-f','lavfi','-i','color=lime:s=200x80:r=20:d=0.5','-filter_complex','[0:v][1:v]concat=n=2:v=1:a=0[v]','-map','[v]','-c:v','libx264','-preset','ultrafast',banner]);
  const asset={id:'ad',filePath:banner,animated:true,duration:1};
  const events=plan({enabled:true,assetIds:['ad'],count:1,firstStart:1,duration:6,freezeOnAd:true,endPadding:0,fade:.1,y:50},[{duration:4}],()=>asset)[0].map(e=>({...e,asset}));
  assert.equal(events[0].duration,1);
  await renderClip(source,out,0,4,{output:{width:320,height:568,preset:'ultrafast'}},null,events);
  assert.ok(Math.abs((await getVideoInfo(out)).duration-5)<.15);
  assert.ok(pixel(out,1.3)[0]>180,'creative begins red');
  assert.ok(pixel(out,1.8)[1]>180,'creative reaches its green ending');
  assert.ok(pixel(out,2.2).every(c=>c<20),'creative is gone, without restarting');
});
test('all entrance/exit animation variants render successfully', async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vidcreator-animation-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const source=path.join(dir,'source.mp4'),banner=path.join(dir,'ad.png');
  ffmpeg(['-f','lavfi','-i','color=black:s=320x568:r=20:d=2','-c:v','libx264','-preset','ultrafast',source]);
  ffmpeg(['-f','lavfi','-i','color=red:s=200x80','-frames:v','1',banner]);
  for(const animation of ['fade','slide-up','slide-left','zoom','none']) {
    const out=path.join(dir,`${animation}.mp4`);
    const events=plan({enabled:true,assetIds:['a'],count:1,firstStart:.5,duration:1,endPadding:0,animation,fade:.2,y:50},[{duration:2}])[0].map(e=>({...e,asset:{filePath:banner,animated:false}}));
    await renderClip(source,out,0,2,{output:{width:320,height:568,preset:'ultrafast'}},null,events);
    assert.ok(pixel(out,1)[0]>180,`${animation}: banner is visible`);
    assert.ok(pixel(out,1.7).every(c=>c<20),`${animation}: exit finishes`);
  }
});

test('studio framing fits a landscape source into a vertical frame over blur or black, and zoom fills it', async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vidcreator-framing-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const source=path.join(dir,'source.mp4');
  // Red landscape picture with a white middle stripe, so "fit" and "fill" are easy to tell apart.
  ffmpeg(['-f','lavfi','-i','color=red:s=640x360:r=10:d=1','-vf','drawbox=x=0:y=150:w=640:h=60:color=white:t=fill','-c:v','libx264','-preset','ultrafast',source]);
  const at=(file,x,y)=>[...ffmpeg(['-i',file,'-vf',`crop=2:2:${x}:${y}`,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1']).subarray(0,3)];
  const render=async(name,framing)=>{const out=path.join(dir,name);await renderClip(source,out,0,1,{output:{width:180,height:320,preset:'ultrafast'},framing},null);return out;};
  const black=await render('black.mp4',{zoom:0,background:'black'});
  const info=await getVideoInfo(black);assert.equal(info.width,180);assert.equal(info.height,320);
  assert.ok(at(black,90,20).every(c=>c<30),'whole frame visible: black bars above the picture');
  assert.ok(at(black,90,170)[0]>200,'picture sits in the middle');
  const blur=await render('blur.mp4',{zoom:0,background:'blur'});
  assert.ok(at(blur,90,20)[0]>80,'bars are filled with the blurred source');
  const dim=await render('dim.mp4',{zoom:0,background:'blur',blur:80,opacity:.3});
  assert.ok(at(dim,90,20)[0]<at(blur,90,20)[0]-60,'lower opacity darkens the blurred background');
  const sharp=await render('sharp.mp4',{zoom:0,background:'blur',blur:0,opacity:1});
  assert.ok(at(sharp,90,20)[0]>200,'no blur and full opacity show the source colour as is');
  const fill=await render('fill.mp4',{zoom:1});
  assert.ok(at(fill,90,20)[0]>200&&at(fill,90,20)[1]<80,'zoom 1 fills the frame edge to edge');
});

test('speed retimes picture and sound; rounded corners and shadow decorate the framed video and banners', async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vidcreator-speed-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const source=path.join(dir,'source.mp4'), banner=path.join(dir,'banner.png');
  ffmpeg(['-f','lavfi','-i','color=red:s=640x360:r=30:d=4','-f','lavfi','-i','sine=frequency=440:duration=4','-c:v','libx264','-preset','ultrafast','-c:a','aac','-shortest',source]);
  ffmpeg(['-f','lavfi','-i','color=lime:s=200x200','-frames:v','1',banner]);
  const at=(file,x,y,time=.5)=>[...ffmpeg(['-ss',String(time),'-i',file,'-vf',`crop=2:2:${x}:${y}`,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1']).subarray(0,3)];
  const fast=path.join(dir,'fast.mp4');
  await renderClip(source,fast,0,4,{output:{width:180,height:320,preset:'ultrafast'},framing:{zoom:1,speed:2}},null);
  const info=await getVideoInfo(fast);
  assert.ok(Math.abs(info.duration-2)<.15,`2× speed halves the length: ${info.duration}`);
  assert.equal(info.audioCodec,'aac');
  assert.ok(audioRms(fast,.5,.5)>.05,'sound survives the tempo change');
  // Whole frame visible over black: the picture band is 180×102 in the middle (y≈109..211).
  const round=path.join(dir,'round.mp4');
  await renderClip(source,round,0,1,{output:{width:180,height:320,preset:'ultrafast'},framing:{zoom:0,background:'black',radius:100,shadow:0}},null);
  assert.ok(at(round,90,160)[0]>200,'centre of the picture stays');
  assert.ok(at(round,0,110).every(c=>c<60),'the corner is rounded away to the background');
  const shade=path.join(dir,'shade.mp4');
  await renderClip(source,shade,0,1,{output:{width:180,height:320,preset:'ultrafast'},framing:{zoom:0,background:'blur',blur:0,opacity:1,radius:0,shadow:100}},null);
  const plain=path.join(dir,'plain.mp4');
  await renderClip(source,plain,0,1,{output:{width:180,height:320,preset:'ultrafast'},framing:{zoom:0,background:'blur',blur:0,opacity:1,radius:0,shadow:0}},null);
  // The background is the same red picture, so the only thing that can darken it is the shadow.
  assert.ok(at(shade,90,214)[0]<at(plain,90,214)[0]-10,`a shadow darkens the area just below the picture: ${at(shade,90,214)} vs ${at(plain,90,214)}`);
  const events=plan({enabled:true,assetIds:['b'],count:1,firstStart:.2,duration:.6,endPadding:.1,fade:0,width:60,y:50,freezeOnAd:false,radius:100,shadow:60},[{duration:1}],()=>({animated:false}))[0].map(e=>({...e,asset:{filePath:banner,animated:false,width:200,height:200}}));
  const ad=path.join(dir,'ad.mp4');
  await renderClip(source,ad,0,1,{output:{width:180,height:320,preset:'ultrafast'}},null,events);
  assert.ok(at(ad,90,160,.5)[1]>180,'banner centre is drawn');
  assert.ok(at(ad,38,108,.5)[1]<150,'banner corner is rounded off');
});

test('a render job applies the chosen speed to every clip, not just the first', async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vidcreator-speed-job-'));
  const source=path.join(dir,'source.mp4');
  // A colour per 2 s block, so each clip's first frame tells which part of the source it starts from.
  ffmpeg(['-f','lavfi','-i','color=red:s=320x180:r=20:d=2','-f','lavfi','-i','color=lime:s=320x180:r=20:d=2','-f','lavfi','-i','color=blue:s=320x180:r=20:d=2','-filter_complex','[0][1][2]concat=n=3:v=1','-c:v','libx264','-preset','ultrafast',source]);
  const { startRenderJob, getJob } = require('../src/services/renderer');
  const job = await startRenderJob(source,{output:{width:180,height:320,preset:'ultrafast'},framing:{zoom:1,speed:2}},{mode:'count',clipCount:3},{enabled:false});
  t.after(()=>{fs.rmSync(dir,{recursive:true,force:true});fs.rmSync(job.outputDir,{recursive:true,force:true});});
  for (let i=0;i<200&&!['completed','partial','error'].includes(getJob(job.id).status);i++) await new Promise(r=>setTimeout(r,100));
  const done=getJob(job.id);
  assert.equal(done.status,'completed',JSON.stringify(done.errors));
  assert.equal(done.results.length,3);
  const colours=[];
  for (const result of done.results) {
    const info=await getVideoInfo(result.outputPath);
    assert.ok(Math.abs(info.duration-1)<.15,`clip ${result.segmentIndex+1} lasts 1 s at 2× (got ${info.duration})`);
    assert.ok(Math.abs(result.outputDuration-1)<.01,'reported length accounts for speed');
    colours.push([...ffmpeg(['-ss','0.1','-i',result.outputPath,'-vf','crop=2:2:90:160','-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1']).subarray(0,3)]);
  }
  assert.ok(colours[0][0]>180&&colours[1][1]>180&&colours[2][2]>180,`clips start at red, green, blue: ${JSON.stringify(colours)}`);
});

test('reaction template puts the webcam region on top and the video below, also with a speed change', async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vidcreator-reaction-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const source=path.join(dir,'stream.mp4'), out=path.join(dir,'out.mp4');
  // A blue "stream" with a red "webcam" in the bottom-right corner.
  ffmpeg(['-f','lavfi','-i','color=blue:s=640x360:r=20:d=2','-vf','drawbox=x=466:y=262:w=168:h=94:color=red:t=fill','-c:v','libx264','-preset','ultrafast',source]);
  const template=JSON.parse(fs.readFileSync(path.join(__dirname,'../data/templates/tpl-stream-reaction-916.json'),'utf8'));
  template.output={...template.output,width:180,height:320,preset:'ultrafast'};
  template.framing={speed:2};
  await renderClip(source,out,0,2,template,null);
  const info=await getVideoInfo(out);
  assert.ok(Math.abs(info.duration-1)<.15,`speed applies to the reaction layout: ${info.duration}`);
  // Square pixels: a 9:16 frame must play as 9:16, not stretched by a leftover sample aspect ratio.
  const sar=execFileSync('ffprobe',['-v','error','-select_streams','v:0','-show_entries','stream=width,height,sample_aspect_ratio','-of','csv=p=0',out],{windowsHide:true}).toString().trim();
  assert.ok(/^180,320(,1:1|,N\/A)?$/.test(sar),`square pixels at 180x320: ${sar}`);
  const at=(x,y)=>[...ffmpeg(['-ss','0.3','-i',out,'-vf',`crop=2:2:${x}:${y}`,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1']).subarray(0,3)];
  assert.ok(at(90,60)[0]>180,`top shows the webcam: ${at(90,60)}`);
  assert.ok(at(90,230)[2]>180,`bottom shows the stream: ${at(90,230)}`);
});

test('export frame-rate cap turns a 60 fps recording into 30 fps clips', async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vidcreator-fps-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const source=path.join(dir,'source.mp4'), out=path.join(dir,'out.mp4'), keep=path.join(dir,'keep.mp4');
  ffmpeg(['-f','lavfi','-i','testsrc2=s=320x180:r=60:d=1','-c:v','libx264','-preset','ultrafast',source]);
  await renderClip(source,out,0,1,{output:{width:180,height:320,preset:'ultrafast',fps:30},framing:{zoom:1}},null);
  assert.equal(Math.round((await getVideoInfo(out)).fps),30);
  await renderClip(source,keep,0,1,{output:{width:180,height:320,preset:'ultrafast',fps:0},framing:{zoom:1}},null);
  assert.equal(Math.round((await getVideoInfo(keep)).fps),60,'0 keeps the source rate');
});
