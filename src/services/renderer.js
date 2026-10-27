const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { renderClip, getVideoInfo } = require('./ffmpeg');
const encoder = require('./encoder');
const { killTree } = require('./process');
const { createSegments } = require('./slicer');
const { plan, outputDuration } = require('../../public/js/ad-schedule');
const { getAsset } = require('../routes/banners');
const JOBS_DIR = path.resolve(__dirname, '../../renders');
let renderQueue = Promise.resolve();
function persist(job) {
  const target = path.join(job.outputDir, 'job.json');
  fs.writeFileSync(target + '.tmp', JSON.stringify(job, null, 2));
  fs.renameSync(target + '.tmp', target);
}

// Active render jobs; controls hold the running ffmpeg processes so a job can be cancelled
const jobs = new Map();
const controls = new Map();
for (const entry of fs.readdirSync(JOBS_DIR, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  try {
    const job = JSON.parse(fs.readFileSync(path.join(JOBS_DIR, entry.name, 'job.json'), 'utf8'));
    if (['queued', 'processing'].includes(job.status)) {
      job.status = 'error';
      job.errors.push({ error: 'Рендер прерван перезапуском сервера. Запусти задачу заново.' });
    }
    jobs.set(job.id, job);
  } catch { /* Ignore directories from older versions without a manifest. */ }
}

// SSE clients
const sseClients = new Map();

/**
 * Register an SSE client for a job
 */
function addSSEClient(jobId, res) {
  if (!sseClients.has(jobId)) {
    sseClients.set(jobId, []);
  }
  sseClients.get(jobId).push(res);
}

/**
 * Send SSE event to all clients watching a job
 */
function sendSSE(jobId, event, data) {
  const clients = sseClients.get(jobId) || [];
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach(res => {
    try {
      res.write(message);
    } catch (e) {
      // Client disconnected
    }
  });
}

/**
 * Remove disconnected SSE clients
 */
function removeSSEClient(jobId, res) {
  const clients = sseClients.get(jobId) || [];
  sseClients.set(jobId, clients.filter(c => c !== res));
}

/**
 * Start a render job
 */
async function startRenderJob(videoPath, template, sliceConfig, adConfig, options = {}) {
  const jobId = uuidv4();
  const videoInfo = await getVideoInfo(videoPath);

  // Create segments based on slice mode
  const segments = createSegments(videoInfo.duration, sliceConfig);
  // Ads are scheduled in output time: with a speed change a clip lasts duration / speed.
  const speed = Math.max(.25, Math.min(4, Number(template.framing?.speed) || 1));
  const adPlans = plan(adConfig, segments.map(segment => ({ ...segment, duration: segment.duration / speed })), getAsset).map(events => events.map(event => {
    const asset = getAsset(event.assetId);
    if (!asset || !fs.existsSync(asset.filePath)) throw new Error('Рекламный баннер не найден. Загрузи его заново.');
    return { ...event, asset };
  }));

  // Create output directory for this job
  const outputDir = path.join(__dirname, '../../renders', jobId);
  fs.mkdirSync(outputDir, { recursive: true });

  const job = {
    id: jobId,
    videoPath,
    template,
    segments,
    videoInfo,
    adPlans,
    join:!!options.join,
    name:options.name||null,
    outputDir,
    status: 'queued',
    currentSegment: 0,
    totalSegments: segments.length,
    overallProgress: 0,
    results: [],
    errors: [],
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
  };

  jobs.set(jobId, job);
  persist(job);

  // Start processing asynchronously
  renderQueue = renderQueue.then(() => processJob(jobId)).catch(err => {
    const j = jobs.get(jobId);
    if (j) {
      j.status = 'error';
      j.errors.push(err.message);
      persist(j);
      sendSSE(jobId, 'error', { message: err.message });
    }
  });

  return job;
}

/**
 * Process all segments in a render job
 */
async function processJob(jobId) {
  const job = jobs.get(jobId);
  if (!job || job.status === 'cancelled') return;
  const control = { procs: new Set(), cancelled: false };
  controls.set(jobId, control);

  job.status = 'processing';
  job.startedAt = new Date().toISOString();
  job.encoder = (await encoder.info()).label;
  persist(job);
  sendSSE(jobId, 'started', { jobId, totalSegments: job.totalSegments, encoder: job.encoder });

  // Several clips render at once (each ffmpeg keeps its own GPU/CPU busy); progress is the
  // average of all clips, and the remaining time is extrapolated from the elapsed time.
  const progress = new Array(job.segments.length).fill(0);
  let lastSent = 0, next = 0;
  const report = (force = false) => {
    const overall = progress.reduce((sum, p) => sum + p, 0) / job.segments.length;
    job.overallProgress = Math.min(99, Math.round(overall * (job.join ? .98 : 1)));
    const elapsed = (Date.now() - Date.parse(job.startedAt)) / 1000;
    job.etaSeconds = overall >= 2 ? Math.round(elapsed * (100 - overall) / overall) : null;
    job.doneSegments = job.results.length + job.errors.length;
    if (!force && Date.now() - lastSent < 500) return;
    lastSent = Date.now();
    sendSSE(jobId, 'progress', { overallProgress: job.overallProgress, etaSeconds: job.etaSeconds, doneSegments: job.doneSegments, totalSegments: job.totalSegments, active: progress.filter((p, i) => p > 0 && p < 100 && !job.results.some(r => r.segmentIndex === i)).length });
  };

  const worker = async ({ kind, threads, fast }) => {
    while (!control.cancelled && next < job.segments.length) {
      const i = next++, segment = job.segments[i];
      job.currentSegment = i;
      const outputFileName = `clip_${String(i + 1).padStart(3, '0')}.mp4`;
      const outputPath = path.join(job.outputDir, outputFileName);
      sendSSE(jobId, 'segment_start', { segmentIndex: i, totalSegments: job.totalSegments, start: segment.start, end: segment.end });
      try {
        await renderClip(job.videoPath, outputPath, segment.start, segment.duration, job.template,
          value => { progress[i] = value; report(); },
          job.adPlans?.[i] || [], { control, encoder: kind, threads, fast });
        progress[i] = 100;
        job.results.push({
          segmentIndex: i,
          outputPath,
          fileName: outputFileName,
          start: segment.start,
          end: segment.end,
          duration: segment.duration,
          outputDuration: outputDuration(segment.duration / (Number(job.template.framing?.speed) || 1), job.adPlans?.[i]),
          adEvents: (job.adPlans?.[i] || []).map(({ asset, ...event }) => event),
        });
        sendSSE(jobId, 'segment_complete', { segmentIndex: i, fileName: outputFileName });
      } catch (err) {
        if (err.cancelled || control.cancelled) { fs.rmSync(outputPath, { force: true }); return; }
        progress[i] = 100;
        job.errors.push({ segmentIndex: i, error: err.message });
        sendSSE(jobId, 'segment_error', { segmentIndex: i, error: err.message });
      }
      report(true);
      persist(job);
    }
  };
  // GPU and CPU workers run side by side; each takes the next clip when it is free.
  const plan = (await encoder.workerPlan()).slice(0, job.segments.length);
  await Promise.all(plan.map(worker));
  controls.delete(jobId);
  job.results.sort((x, y) => x.segmentIndex - y.segmentIndex);
  if (control.cancelled) {
    job.status = 'cancelled';
    job.etaSeconds = null;
    job.completedAt = new Date().toISOString();
    persist(job);
    sendSSE(jobId, 'status', { status: 'cancelled', overallProgress: job.overallProgress });
    return;
  }

  if(job.join&&!job.errors.length){
    try{
      const list=path.join(job.outputDir,'.concat.txt');
      fs.writeFileSync(list,job.results.map(r=>`file '${r.fileName}'`).join('\n'),'utf8');
      const filename='montage.mp4';
      await new Promise((resolve,reject)=>{
        const proc=require('child_process').spawn('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','concat','-safe','0','-i',list,'-c','copy','-movflags','+faststart',path.join(job.outputDir,filename)],{windowsHide:true});
        let error='';proc.stderr.on('data',data=>{error+=data;});proc.on('error',reject);proc.on('close',code=>code===0?resolve():reject(new Error(error.slice(-1000))));
      });
      fs.unlinkSync(list);
      job.results.unshift({segmentIndex:-1,kind:'sequence',fileName:filename,outputPath:path.join(job.outputDir,filename),start:0,end:job.segments.reduce((sum,c)=>sum+c.duration,0),duration:job.segments.reduce((sum,c)=>sum+c.duration,0),outputDuration:job.results.reduce((sum,c)=>sum+c.outputDuration,0)});
    }catch(error){job.errors.push({error:`Объединение: ${error.message}`});}
  }
  job.status = job.errors.length ? (job.results.length ? 'partial' : 'error') : 'completed';
  job.overallProgress = 100;
  job.etaSeconds = null;
  job.completedAt = new Date().toISOString();
  persist(job);

  sendSSE(jobId, 'completed', {
    jobId,
    results: job.results,
    errors: job.errors,
    duration: (new Date(job.completedAt) - new Date(job.startedAt)) / 1000,
  });
}

/**
 * Get job status
 */
function getJob(jobId) {
  return jobs.get(jobId) || null;
}

/**
 * Get all jobs
 */
// Size of a job's folder on disk, shown in the queue so old exports can be cleaned up knowingly.
function folderSize(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).reduce((sum, e) => sum + (e.isFile() ? fs.statSync(path.join(dir, e.name)).size : 0), 0); } catch { return 0; }
}

function getAllJobs() {
  return Array.from(jobs.values()).map(j => ({
    sizeBytes: folderSize(j.outputDir),
    id: j.id,
    name:j.name,
    status: j.status,
    totalSegments: j.totalSegments,
    currentSegment: j.currentSegment,
    overallProgress: j.overallProgress,
    etaSeconds: j.etaSeconds ?? null,
    doneSegments: j.doneSegments ?? j.results.length,
    encoder: j.encoder || null,
    createdAt: j.createdAt,
    startedAt: j.startedAt,
    completedAt: j.completedAt,
    resultsCount: j.results.length,
    errorsCount: j.errors.length,
  }));
}

/** Remove a finished job and its files. Running or queued jobs must be cancelled first. */
function deleteJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return null;
  if (['queued', 'processing'].includes(job.status)) throw new Error('Сначала отмени рендер');
  fs.rmSync(job.outputDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  jobs.delete(jobId);
  return { id: jobId, deleted: true };
}
/** Remove every finished, failed or cancelled job; returns how many and how much space was freed. */
function deleteFinishedJobs() {
  let count = 0, bytes = 0;
  for (const job of [...jobs.values()]) {
    if (['queued', 'processing'].includes(job.status)) continue;
    bytes += folderSize(job.outputDir);
    deleteJob(job.id); count++;
  }
  return { count, bytes };
}

/** Stop a queued or running job; finished clips stay, the half-rendered ones are removed. */
function cancelJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return null;
  if (job.status === 'queued') {
    job.status = 'cancelled'; job.completedAt = new Date().toISOString(); persist(job);
    sendSSE(jobId, 'status', { status: 'cancelled', overallProgress: job.overallProgress });
  } else if (job.status === 'processing') {
    const control = controls.get(jobId);
    if (control) { control.cancelled = true; control.procs.forEach(killTree); }
  }
  return job;
}

module.exports = {
  startRenderJob,
  cancelJob,
  deleteJob,
  deleteFinishedJobs,
  getJob,
  getAllJobs,
  addSSEClient,
  removeSSEClient,
  isVideoBusy: videoPath => Array.from(jobs.values()).some(job => job.videoPath === videoPath && ['queued','processing'].includes(job.status)),
};
