const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { renderClip, getVideoInfo } = require('./ffmpeg');
const { autoSlice, manualSlice } = require('./slicer');

// Active render jobs
const jobs = new Map();

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
async function startRenderJob(videoPath, template, sliceConfig) {
  const jobId = uuidv4();
  const videoInfo = await getVideoInfo(videoPath);

  // Create segments based on slice mode
  let segments;
  if (sliceConfig.mode === 'auto') {
    segments = autoSlice(
      videoInfo.duration,
      sliceConfig.segmentDuration || 120,
      sliceConfig.overlap || 0
    );
  } else if (sliceConfig.mode === 'manual') {
    segments = manualSlice(sliceConfig.timecodes || []);
  } else {
    segments = autoSlice(videoInfo.duration, sliceConfig.segmentDuration || 120);
  }

  // Create output directory for this job
  const outputDir = path.join(__dirname, '../../renders', jobId);
  fs.mkdirSync(outputDir, { recursive: true });

  const job = {
    id: jobId,
    videoPath,
    template,
    segments,
    videoInfo,
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

  // Start processing asynchronously
  processJob(jobId).catch(err => {
    const j = jobs.get(jobId);
    if (j) {
      j.status = 'error';
      j.errors.push(err.message);
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
          job.overallProgress = Math.round((i / job.totalSegments) * 100 + segmentContribution);
          sendSSE(jobId, 'progress', {
            segmentIndex: i,
            segmentProgress: Math.round(progress),
            overallProgress: job.overallProgress,
          });
        }
      );

      job.results.push({
        segmentIndex: i,
        outputPath,
        fileName: outputFileName,
        start: segment.start,
        end: segment.end,
        duration: segment.duration,
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
  }

  job.status = 'completed';
  job.overallProgress = 100;
  job.completedAt = new Date().toISOString();

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
};
