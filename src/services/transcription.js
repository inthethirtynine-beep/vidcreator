const fs=require('fs'),path=require('path'),os=require('os');
const {spawn}=require('child_process');
const {randomUUID}=require('crypto');
const {ROOT,findBinary}=require('../../scripts/setup-whisper');
const {source}=require('./media');
const {fromWhisper}=require('./subtitles');
const jobs=new Map();let queue=Promise.resolve(),installation=null;
const JOBS_DIR=path.resolve(__dirname,'../../data/transcriptions');fs.mkdirSync(JOBS_DIR,{recursive:true});
function persist(job){const target=path.join(JOBS_DIR,`${job.id}.json`);fs.writeFileSync(target+'.tmp',JSON.stringify(publicJob(job)), 'utf8');fs.renameSync(target+'.tmp',target);}
for(const entry of fs.readdirSync(JOBS_DIR).filter(f=>f.endsWith('.json'))){try{const job=JSON.parse(fs.readFileSync(path.join(JOBS_DIR,entry),'utf8'));if(['queued','processing'].includes(job.status)){job.status='error';job.phase='Сервер был перезапущен';job.error='Запусти распознавание снова. Сохранённый проект и готовые субтитры доступны.';}jobs.set(job.id,job);}catch{}}
const modelPath=model=>path.join(process.env.WHISPER_MODEL_DIR||path.join(ROOT,'models'),`ggml-${model}.bin`);
function status(){const binary=findBinary();return{engine:'whisper.cpp',binaryReady:!!binary,device:binary?.includes('bin-cuda')&&process.env.WHISPER_DEVICE!=='cpu'?'NVIDIA CUDA':'CPU',models:['tiny','base','small'].map(id=>({id,installed:fs.existsSync(modelPath(id)),sizeMB:{tiny:75,base:142,small:466}[id]})),installation:installation?{...installation,proc:undefined}:null};}
function install(model,cuda=false){
  if(!['tiny','base','small'].includes(model))throw new Error('Неизвестная модель');
  if(installation?.status==='processing')return status();
  installation={id:randomUUID(),status:'processing',model,phase:'Загрузка движка и модели',progress:0};
  const proc=spawn(process.execPath,[path.resolve(__dirname,'../../scripts/setup-whisper.js'),model,...(cuda?['--cuda']:[])],{windowsHide:true});installation.proc=proc;
  let buffer='',logs='';
  proc.stdout.on('data',chunk=>{buffer+=chunk;let line;while((line=buffer.indexOf('\n'))>=0){const text=buffer.slice(0,line);buffer=buffer.slice(line+1);try{const update=JSON.parse(text);Object.assign(installation,update);}catch{}}});
  proc.stderr.on('data',chunk=>{logs=(logs+chunk).slice(-2000);});
  proc.on('error',error=>{installation.status='error';installation.error=error.message;});
  proc.on('close',code=>{installation.status=code===0?'completed':'error';if(code!==0)installation.error ||= logs||'Не удалось установить распознавание';installation.proc=null;});
  return status();
}
function publicJob(job){const{proc,sourcePath,...data}=job;return data;}
function getJob(id){const job=jobs.get(id);return job?publicJob(job):null;}
function cancel(id){const job=jobs.get(id);if(!job)return null;if(['queued','processing'].includes(job.status)){job.status='cancelled';job.phase='Отменено';job.proc?.kill();persist(job);}return publicJob(job);}
function execute(job,command,args,onStderr){return new Promise((resolve,reject)=>{
  if(job.status==='cancelled')return reject(new Error('Отменено'));
  const proc=spawn(command,args,{windowsHide:true});job.proc=proc;let error='';
  proc.stdout.resume();proc.stderr.on('data',chunk=>{error=(error+chunk).slice(-4000);onStderr?.(String(chunk));});
  proc.on('error',reject);proc.on('close',code=>{job.proc=null;code===0?resolve():reject(new Error(error.slice(-1000)||`Процесс завершён: ${code}`));});
});}
function start(videoId,model='base',language='ru'){
  if(!['tiny','base','small'].includes(model)||!['ru','en','auto'].includes(language))throw new Error('Проверь модель и язык');
  const binary=findBinary();if(!binary||!fs.existsSync(modelPath(model)))throw new Error('Сначала установи выбранную модель распознавания');
  const useCuda=binary.includes('bin-cuda')&&process.env.WHISPER_DEVICE!=='cpu';
  const video=source(videoId);if(!video.info.audioCodec)throw new Error('У этого видео нет звуковой дорожки');
  const active=Array.from(jobs.values()).find(j=>j.videoId===videoId&&j.model===model&&j.language===language&&['queued','processing'].includes(j.status));if(active)return publicJob(active);
  const dir=path.join(path.dirname(video.path),'subtitles');fs.mkdirSync(dir,{recursive:true});
  const prefix=path.join(dir,`${model}-${language}-v2`),raw=prefix+'.json';
  if(fs.existsSync(raw)){try{JSON.parse(fs.readFileSync(raw,'utf8'));}catch{fs.unlinkSync(raw);}}
  const job={id:randomUUID(),videoId,model,language,device:useCuda?'NVIDIA CUDA':'CPU',status:'queued',phase:'В очереди',progress:0,cues:[],createdAt:new Date().toISOString()};jobs.set(job.id,job);
  persist(job);
  queue=queue.then(async()=>{
    if(job.status==='cancelled')return;
    job.status='processing';persist(job);
    try{
      if(!fs.existsSync(raw)){
        job.phase='Подготовка звука';
        const wav=path.join(dir,'speech-16k.wav');
        await execute(job,'ffmpeg',['-hide_banner','-loglevel','error','-y','-i',video.path,'-vn','-ar','16000','-ac','1','-c:a','pcm_s16le',wav]);
        job.phase='Распознавание речи';job.progress=2;
        await execute(job,binary,['-m',modelPath(model),'-f',wav,'-l',language,'-ojf','-of',prefix,'-ml','1','-sow','-pp',...(useCuda?[]:['-ng']),'-sns','-mc','0','-t',String(Math.min(8,Math.max(2,os.availableParallelism()-2)))],chunk=>{
          const matches=[...chunk.matchAll(/progress\s*=\s*(\d+)%/g)];if(matches.length){job.progress=Math.min(99,+matches.at(-1)[1]);persist(job);}
        });
      }
      if(job.status==='cancelled')return;
      const data=JSON.parse(fs.readFileSync(raw,'utf8'));job.cues=fromWhisper(data,video.info.duration);job.status='completed';job.phase=job.cues.length?'Субтитры готовы':'Речь не обнаружена';job.progress=100;job.completedAt=new Date().toISOString();
    }catch(error){if(job.status!=='cancelled'){job.status='error';job.error=error.message;job.phase='Ошибка распознавания';}}finally{persist(job);}
  });
  return publicJob(job);
}
module.exports={status,install,start,getJob,cancel,isVideoBusy:id=>Array.from(jobs.values()).some(job=>job.videoId===id&&['queued','processing'].includes(job.status))};
