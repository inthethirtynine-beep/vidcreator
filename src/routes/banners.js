const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { promisify } = require('util');
const execFile = promisify(require('child_process').execFile);
const { getVideoInfo } = require('../services/ffmpeg');
const router = express.Router();
const ROOT = path.resolve(__dirname, '../../uploads/banners');
fs.mkdirSync(ROOT, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({ destination: ROOT, filename: (req, file, cb) => cb(null, randomUUID() + path.extname(file.originalname).toLowerCase()) }),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /\.(png|jpg|jpeg|webp|gif|mp4|webm|mov)$/i.test(file.originalname)),
});
function getAsset(id) {
  if (!/^[a-f\d-]{36}$/.test(id || '')) return null;
  const file = path.join(ROOT, `${id}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}
async function preparePreview(asset) {
  if (/\.gif$/i.test(asset.filePath)) {
    const previewFile = path.join(ROOT, `${asset.id}.preview.webm`);
    if (!fs.existsSync(previewFile)) await execFile('ffmpeg', ['-hide_banner','-loglevel','error','-y','-ignore_loop','1','-i',asset.filePath,'-vf','scale=640:-2:flags=lanczos','-an','-c:v','libvpx-vp9','-pix_fmt','yuva420p','-auto-alt-ref','0','-crf','30','-b:v','0',previewFile], { windowsHide: true });
    asset.previewUrl = `/uploads/banners/${asset.id}.preview.webm`;
  }
  return asset;
}
router.get('/', async (req, res, next) => {
  try {
    const assets = await Promise.all(fs.readdirSync(ROOT).filter(f => f.endsWith('.json')).map(async f => {
      const { filePath, ...asset } = await preparePreview(JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')));
      return asset;
    }));
    res.json(assets);
  } catch (error) { next(error); }
});
router.post('/', upload.single('banner'), async (req, res, next) => {
  if (!req.file) return res.status(400).json({ error: 'Выбери PNG, JPG, WebP, GIF, MP4, WebM или MOV до 100 МБ' });
  try {
    const info = await getVideoInfo(req.file.path);
    if (!info.width || !info.height) throw new Error('В файле нет изображения');
    const id = path.basename(req.file.filename, path.extname(req.file.filename));
    const animated = /\.(gif|mp4|webm|mov)$/i.test(req.file.filename);
    if (animated && (!Number.isFinite(info.duration) || info.duration < .02)) throw new Error('Не удалось определить длительность рекламного файла');
    const asset = { id, name: req.file.originalname, filePath: req.file.path, url: `/uploads/banners/${req.file.filename}`, width: info.width, height: info.height, animated, duration: info.duration || 0 };
    await preparePreview(asset);
    fs.writeFileSync(path.join(ROOT, `${id}.json`), JSON.stringify(asset, null, 2));
    const { filePath, ...publicAsset } = asset;
    res.status(201).json(publicAsset);
  } catch (error) {
    fs.unlinkSync(req.file.path);
    error.status = 400;
    next(error);
  }
});
module.exports = router;
module.exports.getAsset = getAsset;
