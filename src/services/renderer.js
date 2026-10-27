const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { renderClip, getVideoInfo } = require('./ffmpeg');
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

// Active render jobs
const jobs = new Map();
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
  const adPlans = plan(adConfig, segments, getAsset).map(events => events.map(event => {
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
  if (!job) return;

  job.status = 'processing';
  job.startedAt = new Date().toISOString();
  persist(job);
  sendSSE(jobId, 'started', { jobId, totalSegments: job.totalSegments });

  for (let i = 0; i < job.segments.length; i++) {
    const segment = job.segments[i];
    job.currentSegment = i;

    const outputFileName = `clip_${String(i + 1).padStart(3, '0')}.mp4`;
    const outputPath = path.join(job.outputDir, outputFileName);

    sendSSE(jobId, 'segment_start', {
      segmentIndex: i,
      totalSegments: job.totalSegments,
      start: segment.start,
      end: segment.end,
    });

    try {
      await renderClip(
        job.videoPath,
        outputPath,
        segment.start,
        segment.duration,
        job.template,
        (progress) => {
          const segmentContribution = progress / job.totalSegments;
          job.overallProgress = Math.round(((i / job.totalSegments) * 100 + segmentContribution)*(job.join?.98:1));
          sendSSE(jobId, 'progress', {
            segmentIndex: i,
            segmentProgress: Math.round(progress),
            overallProgress: job.overallProgress,
          });
        },
        job.adPlans?.[i] || []
      );

      job.results.push({
        segmentIndex: i,
        outputPath,
        fileName: outputFileName,
        start: segment.start,
        end: segment.end,
        duration: segment.duration,
        outputDuration: outputDuration(segment.duration, job.adPlans?.[i]),
        adEvents: (job.adPlans?.[i] || []).map(({ asset, ...event }) => event),
      });

      sendSSE(jobId, 'segment_complete', {
        segmentIndex: i,
        fileName: outputFileName,
      });
    } catch (err) {
      job.errors.push({ segmentIndex: i, error: err.message });
      sendSSE(jobId, 'segment_error', {
        segmentIndex: i,
        error: err.message,
      });
    }
    persist(job);
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
function getAllJobs() {
  return Array.from(jobs.values()).map(j => ({
    id: j.id,
    name:j.name,
    status: j.status,
    totalSegments: j.totalSegments,
    currentSegment: j.currentSegment,
    overallProgress: j.overallProgress,
    createdAt: j.createdAt,
    completedAt: j.completedAt,
    resultsCount: j.results.length,
    errorsCount: j.errors.length,
  }));
}

module.exports = {
  startRenderJob,
  getJob,
  getAllJobs,
  addSSEClient,
  removeSSEClient,
  isVideoBusy: videoPath => Array.from(jobs.values()).some(job => job.videoPath === videoPath && ['queued','processing'].includes(job.status)),
};
