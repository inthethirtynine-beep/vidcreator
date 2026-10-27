const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

// Ensure directories exist
const dirs = ['uploads', 'renders', 'data/templates', 'public/assets/fonts'];
dirs.forEach(dir => {
  const fullPath = path.join(__dirname, dir);
  if (!fs.existsSync(fullPath)) {
    fs.mkdirSync(fullPath, { recursive: true });
  }
});

const app = express();
const PORT = process.env.PORT || 3847;

// Middleware
app.use(cors({ origin: [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`] }));
app.use((req, res, next) => {
  if (req.headers.origin && ![`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`].includes(req.headers.origin)) return res.status(403).json({ error: 'Доступ разрешён только из локальной студии' });
  next();
});
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/renders', express.static(path.join(__dirname, 'renders')));

// Routes
const templatesRouter = require('./src/routes/templates');
const videosRouter = require('./src/routes/videos');
const renderRouter = require('./src/routes/render');

app.use('/api/templates', templatesRouter);
app.use('/api/videos', videosRouter);
app.use('/api/render', renderRouter);
app.use('/api/banners', require('./src/routes/banners'));
app.get('/api/health', async (req, res) => {
  const { execFile } = require('child_process');
  const check = name => new Promise(resolve => execFile(name, ['-version'], { windowsHide: true }, error => resolve(!error)));
  const [ffmpeg, ffprobe] = await Promise.all([check('ffmpeg'), check('ffprobe')]);
  res.json({ ffmpeg, ffprobe });
});
app.use('/api', (req, res) => res.status(404).json({ error: 'API route not found' }));
app.use((err, req, res, next) => {
  res.status(err.status || (err.name === 'MulterError' ? 400 : 500)).json({ error: err.message });
});

// SPA fallback
app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  🎬 VidCreator running at http://localhost:${PORT}\n`);
});
