const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const TEMPLATES_DIR = path.join(__dirname, '../../data/templates');
router.param('id', (req, res, next, id) => {
  if (!/^[a-zA-Z0-9-]+$/.test(id)) return res.status(400).json({ error: 'Некорректный идентификатор шаблона' });
  next();
});

// Default template structure
function createDefaultTemplate() {
  return {
    id: uuidv4(),
    name: 'Новый шаблон',
    description: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),

    // Output format
    output: {
      width: 1080,
      height: 1920,
      aspectRatio: '9:16',
      preset: 'medium',
      crf: 23,
      audioBitrate: '192k',
    },

    // Crop/zoom settings (from source to output)
    crop: {
      x: 'iw/2-ow/2',
      y: '0',
      width: 'ih*9/16',
      height: 'ih',
    },

    // Color correction
    colorCorrection: {
      brightness: 0,
      contrast: 1,
      saturation: 1,
    },

    // Text overlays
    textOverlays: [],

    // Watermark
    watermark: {
      enabled: false,
      path: '',
      x: 'W-w-20',
      y: '20',
      opacity: 0.7,
    },

    // Transitions
    transitions: {
      fadeIn: 0,
      fadeOut: 0,
    },

    // Audio
    audio: {
      volume: 1,
      fadeIn: 0,
      fadeOut: 0,
    },
  };
}

// GET /api/templates — list all templates
router.get('/', (req, res) => {
  try {
    if (!fs.existsSync(TEMPLATES_DIR)) {
      fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
    }

    const files = fs.readdirSync(TEMPLATES_DIR).filter(f => f.endsWith('.json'));
    const templates = files.map(f => {
      const data = JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, f), 'utf-8'));
      return {
        id: data.id,
        name: data.name,
        description: data.description,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
        aspectRatio: data.output?.aspectRatio || '9:16',
      };
    });

    res.json(templates);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Template ids become file names, so only plain ids are accepted (no "../").
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const templatePath = id => {
  if (!SAFE_ID.test(String(id))) throw Object.assign(new Error('Invalid template id'), { status: 400 });
  return path.join(TEMPLATES_DIR, `${id}.json`);
};

// GET /api/templates/:id — get full template
router.get('/:id', (req, res) => {
  try {
    const filePath = templatePath(req.params.id);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Template not found' });
    }
    const template = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    res.json(template);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /api/templates — create new template
router.post('/', (req, res) => {
  try {
    const template = { ...createDefaultTemplate(), ...req.body };
    template.id = SAFE_ID.test(String(template.id || '')) ? template.id : uuidv4();
    template.createdAt = new Date().toISOString();
    template.updatedAt = new Date().toISOString();

    const filePath = path.join(TEMPLATES_DIR, `${template.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(template, null, 2));

    res.status(201).json(template);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// PUT /api/templates/:id — update template
router.put('/:id', (req, res) => {
  try {
    const filePath = templatePath(req.params.id);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Template not found' });
    }

    const existing = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const updated = { ...existing, ...req.body };
    updated.id = req.params.id;
    updated.updatedAt = new Date().toISOString();

    fs.writeFileSync(filePath, JSON.stringify(updated, null, 2));
    res.json(updated);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// DELETE /api/templates/:id — delete template
router.delete('/:id', (req, res) => {
  try {
    const filePath = templatePath(req.params.id);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Template not found' });
    }

    fs.unlinkSync(filePath);
    res.json({ success: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /api/templates/:id/duplicate — duplicate template
router.post('/:id/duplicate', (req, res) => {
  try {
    const filePath = templatePath(req.params.id);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Template not found' });
    }

    const original = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const duplicate = {
      ...original,
      id: uuidv4(),
      name: `${original.name} (копия)`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const newPath = path.join(TEMPLATES_DIR, `${duplicate.id}.json`);
    fs.writeFileSync(newPath, JSON.stringify(duplicate, null, 2));

    res.status(201).json(duplicate);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
