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
