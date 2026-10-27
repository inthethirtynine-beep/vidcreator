const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const {execFileSync}=require('child_process');
const Model=require('../public/js/editor-model');
const {renderClip,getVideoInfo}=require('../src/services/ffmpeg');
const {parseSrt,makeSrt,makeAss,fromWhisper}=require('../src/services/subtitles');
const ffmpeg=args=>execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-y',...args],{windowsHide:true,maxBuffer:20*1024*1024});
const source={videoId:'test',name:'test.mp4',width:640,height:360,duration:10,videoUrl:'/test.mp4'};
test('editor model preserves masks, independent source crops, formats and valid cuts',()=>{
  const p=Model.create(source);p.layers[1].mask='circle';p.layers[1].crop={x:0,y:0,w:.25,h:.25};p.output.aspectRatio='1:1';p.output.quality='720';
  const normalized=Model.normalize(p,source);assert.equal(normalized.output.width,720);assert.equal(normalized.output.height,720);assert.equal(normalized.layers[1].mask,'circle');assert.equal(Model.compile(normalized).composition.layers.length,2);
  assert.throws(()=>Model.normalize({...p,cuts:[{start:9,end:11}]},source));
  assert.throws(()=>Model.normalize({...p,cuts:[]},source));
  assert.throws(()=>Model.normalize({...p,subtitles:{cues:[{start:2,end:1,text:'x'}]}},source));
});
test('SRT round-trip and safe ASS generation support Russian text and clipping',()=>{
  const cues=[{start:1.25,end:3.5,text:'Привет, мир!'}];const parsed=parseSrt(makeSrt(cues));assert.equal(parsed[0].start,1.25);assert.equal(parsed[0].text,cues[0].text);
  const sub={...Model.create(source).subtitles,cues:[{...cues[0],text:'{\\pos(0,0)} Привет'}]};const ass=makeAss(sub,1080,1920,2,2);
  assert.match(ass,/0:00:00.00,0:00:01.50/);assert.ok(!ass.includes('{\\pos(0,0)}'));
  assert.throws(()=>parseSrt('not subtitles'));
});
test('Whisper token fragments merge across alignment gaps and punctuation stays with words',()=>{
  const d={transcription:[{tokens:[{text:' При',offsets:{from:100,to:200}},{text:'вет',offsets:{from:400,to:600}},{text:'!',offsets:{from:800,to:900}},{text:'[_TT_100]',offsets:{from:900,to:900}}]}]};
  const cues=fromWhisper(d,10);assert.equal(cues[0].text,'Привет!');assert.equal(cues[0].words.length,1);assert.equal(cues[0].end,.9);
});
test('reaction compositor crops the same source into independent upper and lower layers with a transparent circle',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vidcreator-reaction-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const input=path.join(dir,'source.mp4'),out=path.join(dir,'out.mp4');
  ffmpeg(['-f','lavfi','-i','color=blue:s=640x360:r=20:d=2','-vf','drawbox=x=0:y=0:w=160:h=90:c=red:t=fill','-c:v','libx264','-preset','ultrafast',input]);
  const p=Model.create({...source,duration:2});p.output={width:320,height:568,preset:'ultrafast',crf:18};p.layers[0].crop={x:.3,y:.3,w:.7,h:.7};p.layers[1].crop={x:0,y:0,w:.25,h:.25};p.layers[1].mask='circle';p.subtitles.enabled=false;
  await renderClip(input,out,0,2,Model.compile(p),null);
  const pixel=(x,y)=>[...ffmpeg(['-ss','0.8','-i',out,'-vf',`crop=2:2:${x}:${y}`,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1']).subarray(0,3)];
  const top=pixel(160,90),bottom=pixel(160,450),corner=pixel(4,4);
  assert.ok(top[0]>180&&top[2]<40,`camera crop: ${top}`);assert.ok(bottom[2]>180&&bottom[0]<40,`content crop: ${bottom}`);assert.ok(corner.every(c=>c<50),`transparent mask corner: ${corner}`);
});
test('Russian subtitles are burned at source-relative times after trimming; rounded mask and text remain renderable',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vidcreator-editor-subs-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const input=path.join(dir,'source.mp4'),out=path.join(dir,'out.mp4');ffmpeg(['-f','lavfi','-i','color=black:s=640x360:r=20:d=5','-c:v','libx264','-preset','ultrafast',input]);
  const p=Model.create({...source,duration:5});p.output={width:320,height:568,preset:'ultrafast',crf:18};p.layers[1].mask='rounded';p.subtitles={...p.subtitles,fontSize:75,y:.7,preset:'box',cues:[{id:'one',start:3,end:4,text:'Проверка субтитров',words:[]}]};p.texts=[{text:"Текст: 'тест' 50%",fontSize:50,x:.5,y:.1,start:3,end:5}];
  await renderClip(input,out,3,2,Model.compile(p),null);
  const bright=time=>{const b=ffmpeg(['-ss',String(time),'-i',out,'-vf','crop=320:100:0:340','-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1']);return b.reduce((count,v)=>count+(v>150?1:0),0);};
  assert.ok(bright(.5)>bright(1.5)+100,'captions show only inside the clipped source interval');assert.equal((await getVideoInfo(out)).duration,2);assert.ok(!fs.readdirSync(dir).some(f=>f.endsWith('.ass')||f.endsWith('.txt')));
});
