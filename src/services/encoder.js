/* Picks the fastest working H.264 encoder once per server start: NVIDIA NVENC, Intel Quick Sync,
   AMD AMF, else x264 on the CPU. Each candidate is proven with a tiny real encode using the exact
   quality settings, so a listed-but-unusable GPU never breaks a render.
   VIDCREATOR_ENCODER=cpu|nvenc|qsv|amf forces a choice. */
const { spawn } = require('child_process');
const os = require('os');

// Template presets/CRF are x264 terms; map them to each encoder's equivalent.
const NVENC_PRESET = { ultrafast: 'p2', fast: 'p4', medium: 'p5', slow: 'p6' };

function videoArgs(kind, template = {}) {
  const crf = Math.max(15, Math.min(35, Number(template.output?.crf) || 23));
  const preset = template.output?.preset || 'medium';
  if (kind === 'nvenc') {
    // VBR with a constant-quality target: GPU speed at x264-like quality. Spatial AQ keeps detail in flat areas.
    return ['-c:v', 'h264_nvenc', '-preset', NVENC_PRESET[preset] || 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', String(crf - 1), '-b:v', '0', '-maxrate', '16M', '-bufsize', '32M', '-spatial-aq', '1', '-aq-strength', '8', '-profile:v', 'high'];
  }
  if (kind === 'qsv') return ['-c:v', 'h264_qsv', '-preset', preset === 'ultrafast' ? 'veryfast' : preset, '-global_quality', String(crf), '-look_ahead', '1'];
  if (kind === 'amf') return ['-c:v', 'h264_amf', '-quality', preset === 'slow' ? 'quality' : 'balanced', '-rc', 'cqp', '-qp_i', String(crf - 2), '-qp_p', String(crf)];
  return ['-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-threads', '0'];
}

/** Hardware decode for the source; frames come back to system memory for the CPU filters. */
const inputArgs = kind => (kind === 'nvenc' ? ['-hwaccel', 'cuda'] : kind === 'qsv' ? ['-hwaccel', 'qsv'] : []);

function probe(kind) {
  return new Promise(resolve => {
    const proc = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=0.3', ...videoArgs(kind, { output: { preset: 'medium', crf: 23 } }), '-pix_fmt', 'yuv420p', '-f', 'null', '-'], { windowsHide: true });
    const timer = setTimeout(() => { proc.kill(); resolve(false); }, 15000);
    proc.on('error', () => { clearTimeout(timer); resolve(false); });
    proc.on('close', code => { clearTimeout(timer); resolve(code === 0); });
  });
}

let detected = null;
function detect() {
  if (detected) return detected;
  detected = (async () => {
    const forced = (process.env.VIDCREATOR_ENCODER || '').toLowerCase();
    if (forced === 'cpu') return 'cpu';
    for (const kind of forced ? [forced] : ['nvenc', 'qsv', 'amf']) if (await probe(kind)) return kind;
    return 'cpu';
  })();
  return detected;
}
/** After a GPU failure mid-render, stop using it for the rest of this server run. */
function disable(kind) { if (kind !== 'cpu') detected = Promise.resolve('cpu'); }

/** How many clips to render at once: GPU encoders leave the CPU free for filters and decoding. */
async function parallelism() {
  const forced = Number(process.env.VIDCREATOR_PARALLEL);
  if (forced >= 1) return Math.min(8, Math.floor(forced));
  const cores = os.cpus().length;
  return (await detect()) === 'cpu' ? Math.max(1, Math.min(2, Math.floor(cores / 6))) : Math.max(2, Math.min(3, Math.floor(cores / 4)));
}

const LABELS = { nvenc: 'Видеокарта NVIDIA (NVENC)', qsv: 'Видеоядро Intel (Quick Sync)', amf: 'Видеокарта AMD (AMF)', cpu: 'Процессор (x264)' };
async function info() { const kind = await detect(); return { kind, label: LABELS[kind], parallel: await parallelism() }; }

module.exports = { detect, disable, videoArgs, inputArgs, parallelism, info };
