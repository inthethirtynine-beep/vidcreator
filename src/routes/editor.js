const express=require('express'),fs=require('fs'),path=require('path');
const {randomUUID}=require('crypto');
const Model=require('../../public/js/editor-model');
const {source}=require('../services/media');
const transcription=require('../services/transcription');
const {makeSrt,parseSrt}=require('../services/subtitles');
const {plan,outputDuration}=require('../../public/js/ad-schedule');
const {getAsset}=require('./banners');
const router=express.Router(),ROOT=path.resolve(__dirname,'../../data/projects');fs.mkdirSync(ROOT,{recursive:true});
function file(id){if(!/^[a-f\d-]{36}$/i.test(id||''))throw new Error('Некорректный проект');return path.join(ROOT,`${id}.json`);}
function read(id){const f=file(id);if(!fs.existsSync(f))throw new Error('Проект не найден');const p=JSON.parse(fs.readFileSync(f,'utf8'));p.source=source(p.source.videoId).public;return p;}
function save(project){const f=file(project.id);fs.writeFileSync(f+'.tmp',JSON.stringify(project,null,2));fs.renameSync(f+'.tmp',f);}
const route=fn=>async(req,res,next)=>{try{await fn(req,res);}catch(error){error.status ||= 400;next(error);}};
router.get('/projects',route((req,res)=>res.json(fs.readdirSync(ROOT).filter(f=>f.endsWith('.json')).map(f=>{const p=JSON.parse(fs.readFileSync(path.join(ROOT,f),'utf8'));return{id:p.id,name:p.name,updatedAt:p.updatedAt,source:p.source,revision:p.revision};}).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)))));
router.post('/projects',route((req,res)=>{const media=source(req.body.videoId);const p=Model.create(media.public);p.id=randomUUID();p.name=req.body.name||media.originalName.replace(/\.[^.]+$/,'');p.revision=1;save(p);res.status(201).json(p);}));
router.get('/projects/:id',route((req,res)=>res.json(read(req.params.id))));
router.put('/projects/:id',route((req,res)=>{
  const existing=read(req.params.id),body=req.body;
  if(body.baseRevision!==undefined&&body.baseRevision!==existing.revision)return res.status(409).json({error:'Проект изменён в другом окне. Открой сохранённую версию.',revision:existing.revision});
  const p=Model.normalize(body.project||body,existing.source);p.id=existing.id;p.revision=existing.revision+1;p.updatedAt=new Date().toISOString();save(p);res.json(p);
}));
router.get('/speech/status',route((req,res)=>res.json(transcription.status())));
router.post('/speech/install',route((req,res)=>res.json(transcription.install(req.body.model||'base',req.body.cuda===true))));
router.post('/speech/start',route((req,res)=>res.status(201).json(transcription.start(req.body.videoId,req.body.model,req.body.language))));
router.get('/speech/jobs/:id',route((req,res)=>{const job=transcription.getJob(req.params.id);if(!job)return res.status(404).json({error:'Распознавание не найдено'});res.json(job);}));
router.post('/speech/jobs/:id/cancel',route((req,res)=>res.json(transcription.cancel(req.params.id))));
router.post('/subtitles/import',route((req,res)=>res.json({cues:parseSrt(req.body.text)})));
router.get('/projects/:id/subtitles.srt',route((req,res)=>{
  const p=read(req.params.id);let cues=p.subtitles.cues;
  if(req.query.sequence==='true'){
    let offset=0;const mapped=[];
    const events=plan(p.adConfig,p.cuts.map(c=>({duration:c.end-c.start})),getAsset);
    p.cuts.forEach((cut,i)=>{
      const ads=events[i],mapTime=t=>t+ads.reduce((sum,e)=>sum+(e.freeze&&e.start<=t?e.duration:0),0);
      cues.filter(c=>c.end>cut.start&&c.start<cut.end).forEach(c=>mapped.push({...c,start:offset+mapTime(Math.max(c.start,cut.start)-cut.start),end:offset+mapTime(Math.min(c.end,cut.end)-cut.start)}));
      offset+=outputDuration(cut.end-cut.start,ads);
    });cues=mapped;
  }
  res.set('Content-Type','application/x-subrip; charset=utf-8').set('Content-Disposition','attachment; filename="subtitles.srt"').send(makeSrt(cues));
}));
router.post('/projects/:id/export',route(async(req,res)=>{
  const saved=read(req.params.id),p=Model.normalize(saved,saved.source),video=source(p.source.videoId);
  const {startRenderJob}=require('../services/renderer');
  const job=await startRenderJob(video.path,Model.compile(p),{mode:'manual',timecodes:p.cuts.map(c=>({start:c.start,end:c.end}))},p.adConfig,{join:req.body.mode==='sequence',name:p.name});
  res.status(201).json({jobId:job.id,totalSegments:job.totalSegments});
}));
module.exports=router;
