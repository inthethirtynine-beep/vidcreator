const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { startRenderJob, getJob, getAllJobs, addSSEClient, removeSSEClient, cancelJob, deleteJob, deleteFinishedJobs } = require('../services/renderer');

const UPLOADS_DIR = path.join(__dirname, '../../uploads');
const TEMPLATES_DIR = path.join(__dirname, '../../data/templates');

// POST /api/render/start — start a render job
router.post('/start', async (req, res) => {
  try {
    const { videoId, templateId, sliceConfig, adConfig, framing, reaction, fps } = req.body;

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
    // Output frame rate from the studio (0 = keep the source rate).
    if (fps !== undefined) template.output = { ...template.output, fps: [0, 24, 25, 30, 50, 60].includes(Number(fps)) ? Number(fps) : 30 };
    // Reaction templates: the webcam and video regions chosen for this source, and how tall the top part is.
    if (template.composition && reaction && typeof reaction === 'object') {
      const { crop, clamp } = require('../../public/js/editor-model');
      const split = clamp(Number(reaction.split) || .4, .15, .7);
      template.composition = { ...template.composition, layers: template.composition.layers.map(layer => {
        if (layer.id === 'camera') return { ...layer, crop: crop(reaction.camera || layer.crop), rect: { x: 0, y: 0, w: 1, h: split } };
        if (layer.id === 'content') return { ...layer, crop: crop(reaction.content || layer.crop), rect: { x: 0, y: split, w: 1, h: 1 - split } };
        return layer;
      }) };
    }
    // Studio framing (zoom / pan / background) for this source overrides the template's crop.
    if (framing && typeof framing === 'object') {
      const n = (v, min, max, d) => Number.isFinite(Number(v)) ? Math.max(min, Math.min(max, Number(v))) : d;
      template.framing = { zoom: n(framing.zoom, 0, 1.5, 1), x: n(framing.x, 0, 1, .5), y: n(framing.y, 0, 1, .5), background: framing.background === 'black' ? 'black' : 'blur', blur: n(framing.blur, 0, 100, 50), opacity: n(framing.opacity, 0, 1, .8), radius: n(framing.radius, 0, 100, 0), shadow: n(framing.shadow, 0, 100, 0), speed: n(framing.speed, .25, 4, 1) };
    }

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
// GET /api/render/engine — which encoder renders and how many clips run at once
router.get('/engine', async (req, res) => res.json(await require('../services/encoder').info()));

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

// DELETE /api/render/jobs — remove all finished exports and their files (running ones stay)
router.delete('/jobs', (req, res) => res.json(deleteFinishedJobs()));

// DELETE /api/render/jobs/:id — remove one finished export and its files
router.delete('/jobs/:id', (req, res) => {
  try {
    const result = deleteJob(req.params.id);
    if (!result) return res.status(404).json({ error: 'Job not found' });
    res.json(result);
  } catch (err) { res.status(409).json({ error: err.message }); }
});

// POST /api/render/jobs/:id/cancel — stop a queued or running render
router.post('/jobs/:id/cancel', (req, res) => {
  const job = cancelJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ id: job.id, status: job.status });
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
    etaSeconds: job.etaSeconds ?? null,
    doneSegments: job.doneSegments ?? job.results.length,
    encoder: job.encoder || null,
  })}\n\n`);

  addSSEClient(req.params.id, res);

  req.on('close', () => {
    removeSSEClient(req.params.id, res);
  });
});

// GET /api/render/jobs/:id/download-all — every finished clip of the job in one ZIP
router.get('/jobs/:id/download-all', async (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (['queued', 'processing'].includes(job.status)) return res.status(409).json({ error: 'Дождись окончания рендера' });
  try {
    const { streamZip, fileCrc32 } = require('../services/zip');
    const entries = [];
    for (const result of job.results) {
      const filePath = path.join(job.outputDir, result.fileName);
      if (!fs.existsSync(filePath)) continue;
      const stat = fs.statSync(filePath);
      // CRC is computed once per file and kept with the job for later downloads.
      if (result.zipCrc === undefined || result.zipSize !== stat.size) { result.zipCrc = await fileCrc32(filePath); result.zipSize = stat.size; }
      entries.push({ name: result.fileName, path: filePath, size: stat.size, crc: result.zipCrc, mtime: stat.mtime });
    }
    if (!entries.length) return res.status(404).json({ error: 'В задаче нет готовых клипов' });
    const base = String(job.name || `клипы-${job.id.slice(0, 8)}`).replace(/[\\/:*?"<>|]+/g, '_');
    await streamZip(res, entries, `${base}.zip`);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.destroy(err);
  }
});

// GET /api/render/jobs/:id/files — list rendered clips
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
