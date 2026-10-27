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
app.use(cors());
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

// SPA fallback
app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n  🎬 VidCreator running at http://localhost:${PORT}\n`);
});
