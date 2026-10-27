const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { getVideoInfo, generateThumbnail, generateTimelineThumbnails, audioPeaks } = require('../services/ffmpeg');
const { createSegments } = require('../services/slicer');
const youtube = require('../services/youtube');

const UPLOADS_DIR = path.join(__dirname, '../../uploads');


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

// YouTube import runs locally through yt-dlp (see src/services/youtube.js).
router.get('/youtube/engine', async (req, res) => res.json(await youtube.status()));
router.post('/youtube/engine/install', async (req, res) => {
  youtube.install(req.body?.force === true);
  res.json(await youtube.status());
});

// Signing in to YouTube for the bot check / age gates: a local browser or an uploaded cookies.txt.
const authRoute = fn => (req, res) => { try { res.json(fn(req)); } catch (err) { res.status(400).json({ error: err.message }); } };
router.get('/youtube/auth', authRoute(() => youtube.authStatus()));
router.put('/youtube/auth', authRoute(req => youtube.setAuth(req.body)));
router.post('/youtube/auth/cookies', authRoute(req => youtube.saveCookies(req.body?.content)));
router.delete('/youtube/auth/cookies', authRoute(() => youtube.clearCookies()));
// Sign-in window: open it, watch it, renew the saved session, or forget it.
const loginRoute = fn => async (req, res) => { try { res.json(await fn(req)); } catch (err) { res.status(400).json({ error: err.message }); } };
router.post('/youtube/login/start', loginRoute(req => youtube.startLogin(req.body?.browser)));
router.post('/youtube/login/cancel', loginRoute(() => youtube.cancelLogin()));
router.post('/youtube/login/refresh', loginRoute(() => youtube.refreshLogin()));
router.delete('/youtube/login', loginRoute(() => youtube.forgetLogin()));

// POST /api/videos/youtube/start — download a video by link into the library
router.post('/youtube/start', (req, res) => {
  try {
    const videoId = uuidv4(), videoDir = path.join(UPLOADS_DIR, videoId);
    const job = youtube.start(req.body?.url, req.body?.format, videoDir, async (filePath, title) => {
      const info = await getVideoInfo(filePath);
      if (!info.width || !info.height || !(info.duration > 0)) throw new Error('В скачанном файле нет видеодорожки');
      const thumbPath = path.join(videoDir, 'thumbnail.jpg');
      await generateThumbnail(filePath, thumbPath, Math.min(1, info.duration / 2));
      const video = {
        id: videoId,
        originalName: sanitizeFileName(title) + path.extname(filePath),
        path: filePath,
        thumbnailPath: thumbPath,
        thumbnailUrl: `/uploads/${videoId}/thumbnail.jpg`,
        info,
        uploadedAt: new Date().toISOString(),
        sourceUrl: req.body.url,
      };
      videos.set(videoId, video);
      return { id: video.id, originalName: video.originalName, thumbnailUrl: video.thumbnailUrl, info, uploadedAt: video.uploadedAt };
    });
    res.status(201).json({ jobId: job.id, ...job });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/videos/youtube/status/:jobId — poll download progress
router.get('/youtube/status/:jobId', (req, res) => {
  const job = youtube.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Загрузка не найдена. Возможно, сервер перезапускался — начни заново.' });
  res.json(job);
});

// POST /api/videos/youtube/cancel/:jobId — stop a running download and remove partial files
router.post('/youtube/cancel/:jobId', (req, res) => {
  const job = youtube.cancel(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Загрузка не найдена' });
  res.json(job);
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

// GET /api/videos/:id/waveform — loudness envelope for the editor's audio track, cached next to the source
router.get('/:id/waveform', async (req, res) => {
  const video = videos.get(req.params.id);
  if (!video) return res.status(404).json({ error: 'Video not found' });
  const cacheFile = path.join(UPLOADS_DIR, video.id, 'waveform.json');
  try {
    if (fs.existsSync(cacheFile)) return res.json(JSON.parse(fs.readFileSync(cacheFile, 'utf8')));
    const waveform = await audioPeaks(video.path);
    fs.writeFileSync(cacheFile, JSON.stringify(waveform));
    res.json(waveform);
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
  if (require('../services/transcription').isVideoBusy(video.id)) return res.status(409).json({error:'Видео используется для распознавания речи. Дождись завершения или отмени распознавание.'});
  fs.rmSync(videoDir, { recursive: true, force: true });
  videos.delete(video.id);

  res.json({ success: true });
});

module.exports = router;
