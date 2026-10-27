const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { getVideoInfo, generateThumbnail, generateTimelineThumbnails } = require('../services/ffmpeg');
const { createSegments } = require('../services/slicer');
const { startYouTubeJob, getJobStatus, downloadFile, DEFAULT_API_KEY } = require('../services/youtube');

const UPLOADS_DIR = path.join(__dirname, '../../uploads');

// Active YouTube download jobs
const ytJobs = new Map();

function sanitizeFileName(title) {
  return (title || 'youtube_video').replace(/[<>:"/\\|?*]+/g, '_').trim();
}

// Multer storage config
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const videoId = uuidv4();
    const videoDir = path.join(UPLOADS_DIR, videoId);
    fs.mkdirSync(videoDir, { recursive: true });
    req.videoId = videoId;
    cb(null, videoDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `source${ext}`);
  },
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowed = ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.flv', '.wmv'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported format: ${ext}. Supported: ${allowed.join(', ')}`));
    }
  },
  limits: {
    fileSize: 5 * 1024 * 1024 * 1024, // 5GB max
  },
});

// In-memory video registry
const videos = new Map();
const setVideo = videos.set.bind(videos);
videos.set = (id, video) => {
  fs.writeFileSync(path.join(UPLOADS_DIR, id, 'video.json'), JSON.stringify(video, null, 2));
  return setVideo(id, video);
};
const ready = Promise.all(fs.readdirSync(UPLOADS_DIR, { withFileTypes: true }).filter(e => e.isDirectory() && e.name !== 'banners').map(async entry => {
  try {
    const dir = path.join(UPLOADS_DIR, entry.name);
    const manifest = path.join(dir, 'video.json');
    if (fs.existsSync(manifest)) {
      const video = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      if (fs.existsSync(video.path)) setVideo(video.id, video);
    } else {
      const source = fs.readdirSync(dir).find(f => /^source\.(mp4|mkv|avi|mov|webm|flv|wmv)$/i.test(f));
      if (source) videos.set(entry.name, { id: entry.name, originalName: source, path: path.join(dir, source), thumbnailUrl: `/uploads/${entry.name}/thumbnail.jpg`, info: await getVideoInfo(path.join(dir, source)), uploadedAt: fs.statSync(dir).birthtime.toISOString() });
    }
  } catch (error) { console.warn('Video recovery:', error.message); }
}));
router.use(async (req, res, next) => { await ready; next(); });

// POST /api/videos/upload — upload a video
router.post('/upload', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No video file provided' });
    }

    const videoPath = req.file.path;
    const videoId = req.videoId;

    // Get video info
    const info = await getVideoInfo(videoPath);
    if (!info.width || !info.height || !Number.isFinite(info.duration) || info.duration <= 0) throw new Error('Не удалось прочитать видеодорожку или длительность файла');

    // Generate thumbnail
    const thumbDir = path.join(UPLOADS_DIR, videoId);
    const thumbPath = path.join(thumbDir, 'thumbnail.jpg');
    await generateThumbnail(videoPath, thumbPath, Math.min(1, info.duration / 2));

    const video = {
      id: videoId,
      originalName: req.file.originalname,
      path: videoPath,
      thumbnailPath: thumbPath,
      thumbnailUrl: `/uploads/${videoId}/thumbnail.jpg`,
      info,
      uploadedAt: new Date().toISOString(),
    };

    videos.set(videoId, video);

    res.status(201).json({
      id: video.id,
      originalName: video.originalName,
      thumbnailUrl: video.thumbnailUrl,
      info: video.info,
      uploadedAt: video.uploadedAt,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/videos/youtube/start — start a download from YouTube
router.post('/youtube/start', async (req, res) => {
  try {
    const { url, format, apiKey } = req.body;
    if (!url || !url.trim()) {
      return res.status(400).json({ error: 'Укажи ссылку на YouTube видео' });
    }

    const jobData = await startYouTubeJob(url.trim(), format || '1080', apiKey);
    const videoId = uuidv4();

    ytJobs.set(jobData.jobId, {
      ytJobId: jobData.jobId,
      videoId,
      url: url.trim(),
      apiKey: apiKey || DEFAULT_API_KEY,
      title: jobData.title || 'YouTube Video',
      duration: jobData.duration || 0,
      status: jobData.status || 'IN_QUEUE',
      progress: null,
      serverDownloadProgress: 0,
      downloadPromise: null,
      video: null,
      error: null,
      createdAt: new Date().toISOString(),
    });

    res.status(200).json({
      jobId: jobData.jobId,
      videoId,
      title: jobData.title,
      duration: jobData.duration,
      status: jobData.status,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/videos/youtube/status/:jobId — poll YouTube download progress
router.get('/youtube/status/:jobId', async (req, res) => {
  const job = ytJobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Задача YouTube не найдена' });
  }

  // If already completed and registered
  if (job.status === 'COMPLETED' && job.video) {
    return res.json({
      status: 'COMPLETED',
      video: job.video,
    });
  }

  if (job.status === 'FAILED') {
    return res.json({
      status: 'FAILED',
      error: job.error || 'Ошибка загрузки с YouTube',
    });
  }

  try {
    const vkStatus = await getJobStatus(job.ytJobId, job.apiKey);
    job.progress = vkStatus.progress;
    if (vkStatus.title) job.title = vkStatus.title;

    if (vkStatus.status === 'COMPLETED' && vkStatus.downloadUrl) {
      if (!job.downloadPromise) {
        job.status = 'DOWNLOADING_TO_SERVER';
        const videoDir = path.join(UPLOADS_DIR, job.videoId);
        fs.mkdirSync(videoDir, { recursive: true });
        const filePath = path.join(videoDir, 'source.mp4');

        job.downloadPromise = (async () => {
          try {
            await downloadFile(vkStatus.downloadUrl, filePath, (prog) => {
              job.serverDownloadProgress = prog.percent;
            });

            const info = await getVideoInfo(filePath);
            const thumbPath = path.join(videoDir, 'thumbnail.jpg');
            await generateThumbnail(filePath, thumbPath, Math.min(1, (info.duration || 2) / 2));

            const cleanTitle = sanitizeFileName(vkStatus.title || job.title) + '.mp4';
            const video = {
              id: job.videoId,
              originalName: cleanTitle,
              path: filePath,
              thumbnailPath: thumbPath,
              thumbnailUrl: `/uploads/${job.videoId}/thumbnail.jpg`,
              info,
              uploadedAt: new Date().toISOString(),
              sourceUrl: job.url,
            };

            videos.set(job.videoId, video);
            job.video = {
              id: video.id,
              originalName: video.originalName,
              thumbnailUrl: video.thumbnailUrl,
              info: video.info,
              uploadedAt: video.uploadedAt,
            };
            job.status = 'COMPLETED';
          } catch (err) {
            job.status = 'FAILED';
            job.error = err.message;
          }
        })();
      }

      if (job.status === 'DOWNLOADING_TO_SERVER') {
        return res.json({
          status: 'DOWNLOADING_TO_SERVER',
          title: job.title,
          percent: job.serverDownloadProgress || 0,
        });
      }

      if (job.status === 'COMPLETED') {
        return res.json({
          status: 'COMPLETED',
          video: job.video,
        });
      }

      if (job.status === 'FAILED') {
        return res.json({
          status: 'FAILED',
          error: job.error,
        });
      }
    }

    if (vkStatus.status === 'FAILED' || vkStatus.status === 'ERROR') {
      job.status = 'FAILED';
      job.error = vkStatus.error || vkStatus.message || 'Ошибка обработки на сервере VidKraken';
      return res.json({ status: 'FAILED', error: job.error });
    }

    res.json({
      status: vkStatus.status,
      title: job.title,
      progress: vkStatus.progress,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/videos — list all uploaded videos
router.get('/', (req, res) => {
  const list = Array.from(videos.values()).map(v => ({
    id: v.id,
    originalName: v.originalName,
    thumbnailUrl: v.thumbnailUrl,
    duration: v.info.duration,
    resolution: `${v.info.width}x${v.info.height}`,
    uploadedAt: v.uploadedAt,
  }));
  res.json(list);
});

// GET /api/videos/:id — get video details
router.get('/:id', (req, res) => {
  const video = videos.get(req.params.id);
  if (!video) {
    return res.status(404).json({ error: 'Video not found' });
  }
  res.json({
    id: video.id,
    originalName: video.originalName,
    thumbnailUrl: video.thumbnailUrl,
    videoUrl: `/uploads/${video.id}/${path.basename(video.path)}`,
    info: video.info,
    uploadedAt: video.uploadedAt,
  });
});

// POST /api/videos/:id/slice-preview — preview how video will be sliced
router.post('/:id/slice-preview', (req, res) => {
  try {
  const video = videos.get(req.params.id);
  if (!video) {
    return res.status(404).json({ error: 'Video not found' });
  }

  const segments = createSegments(video.info.duration, req.body);

  res.json({
    totalDuration: video.info.duration,
    segments,
    totalSegments: segments.length,
  });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

// GET /api/videos/:id/thumbnails — generate timeline thumbnails
router.get('/:id/thumbnails', async (req, res) => {
  const video = videos.get(req.params.id);
  if (!video) {
    return res.status(404).json({ error: 'Video not found' });
  }

  try {
    const count = Math.max(1, Math.min(50, parseInt(req.query.count) || 20));
    const thumbDir = path.join(UPLOADS_DIR, video.id, 'timeline');
    fs.mkdirSync(thumbDir, { recursive: true });

    const thumbnails = await generateTimelineThumbnails(video.path, thumbDir, count);
    const urls = thumbnails.map((t, i) => ({
      time: t.time,
      url: `/uploads/${video.id}/timeline/thumb_${String(i).padStart(4, '0')}.jpg`,
    }));

    res.json(urls);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/videos/:id — delete uploaded video
router.delete('/:id', (req, res) => {
  const video = videos.get(req.params.id);
  if (!video) {
    return res.status(404).json({ error: 'Video not found' });
  }

  const videoDir = path.join(UPLOADS_DIR, video.id);
  if (require('../services/renderer').isVideoBusy(video.path)) return res.status(409).json({ error: 'Видео используется в рендере. Дождись завершения задачи.' });
  fs.rmSync(videoDir, { recursive: true, force: true });
  videos.delete(video.id);

  res.json({ success: true });
});

module.exports = router;
