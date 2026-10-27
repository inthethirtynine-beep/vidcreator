const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { startRenderJob, getJob, getAllJobs, addSSEClient, removeSSEClient } = require('../services/renderer');

const UPLOADS_DIR = path.join(__dirname, '../../uploads');
const TEMPLATES_DIR = path.join(__dirname, '../../data/templates');

// POST /api/render/start — start a render job
router.post('/start', async (req, res) => {
  try {
    const { videoId, templateId, sliceConfig, adConfig } = req.body;

    if (!videoId || !templateId) {
      return res.status(400).json({ error: 'videoId and templateId are required' });
    }
    if (![videoId, templateId].every(id => /^[a-zA-Z0-9-]+$/.test(id))) return res.status(400).json({ error: 'Некорректный идентификатор' });

    // Find the video file
    const videoDir = path.join(UPLOADS_DIR, videoId);
    if (!fs.existsSync(videoDir)) {
      return res.status(404).json({ error: 'Video not found' });
    }

    // Find actual video file in the directory
    const files = fs.readdirSync(videoDir);
    const videoFile = files.find(f => /\.(mp4|mkv|avi|mov|webm|flv|wmv)$/i.test(f));
    if (!videoFile) {
      return res.status(404).json({ error: 'Video file not found in upload directory' });
    }
    const videoPath = path.join(videoDir, videoFile);

    // Load template
    const templatePath = path.join(TEMPLATES_DIR, `${templateId}.json`);
    if (!fs.existsSync(templatePath)) {
      return res.status(404).json({ error: 'Template not found' });
    }
    const template = JSON.parse(fs.readFileSync(templatePath, 'utf-8'));

    // Start render job
    const job = await startRenderJob(videoPath, template, sliceConfig || { mode: 'auto', segmentDuration: 120 }, adConfig);

    res.status(201).json({
      jobId: job.id,
      status: job.status,
      totalSegments: job.totalSegments,
      segments: job.segments,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/render/jobs — list all render jobs
router.get('/jobs', (req, res) => {
  res.json(getAllJobs());
});

// GET /api/render/jobs/:id — get job details
router.get('/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  res.json({
    id: job.id,
    status: job.status,
    totalSegments: job.totalSegments,
    currentSegment: job.currentSegment,
    overallProgress: job.overallProgress,
    results: job.results.map(r => ({
      ...r,
      downloadUrl: `/renders/${job.id}/${r.fileName}`,
    })),
    errors: job.errors,
    adPlans: job.adPlans?.map(events => events.map(({ asset, ...event }) => event)),
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
  });
});

// GET /api/render/jobs/:id/progress — SSE progress stream
router.get('/jobs/:id/progress', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // Send current status
  res.write(`event: status\ndata: ${JSON.stringify({
    status: job.status,
    overallProgress: job.overallProgress,
    currentSegment: job.currentSegment,
    totalSegments: job.totalSegments,
  })}\n\n`);

  addSSEClient(req.params.id, res);

  req.on('close', () => {
    removeSSEClient(req.params.id, res);
  });
});

// GET /api/render/jobs/:id/download-all — download all rendered clips as zip info
router.get('/jobs/:id/files', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  if (!['completed', 'partial', 'error'].includes(job.status)) {
    return res.status(400).json({ error: 'Job not completed yet' });
  }

  const files = job.results.map(r => ({
    fileName: r.fileName,
    downloadUrl: `/renders/${job.id}/${r.fileName}`,
    start: r.start,
    end: r.end,
    duration: r.duration,
    outputDuration: r.outputDuration || r.duration,
  }));

  res.json(files);
});

module.exports = router;
