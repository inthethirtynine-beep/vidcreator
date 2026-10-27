/* Picks the fastest working H.264 encoder once per server start: NVIDIA NVENC, Intel Quick Sync,
   AMD AMF, else x264 on the CPU. Each candidate is proven with a tiny real encode using the exact
   quality settings, so a listed-but-unusable GPU never breaks a render.
   VIDCREATOR_ENCODER=cpu|nvenc|qsv|amf forces a choice. */
const { spawn } = require('child_process');
const os = require('os');

// Template presets/CRF are x264 terms; map them to each encoder's equivalent.
const NVENC_PRESET = { ultrafast: 'p2', fast: 'p4', medium: 'p5', slow: 'p6' };

/**
 * opts.threads: x264 threads for this process; opts.fast: CPU worker in a mixed GPU+CPU render uses a
 * quicker x264 preset (still good at the same CRF) so it keeps pace with the GPU workers.
 */
function videoArgs(kind, template = {}, opts = {}) {
  const crf = Math.max(15, Math.min(35, Number(template.output?.crf) || 23));
  const preset = template.output?.preset || 'medium';
  if (kind === 'nvenc') {
    // VBR with a constant-quality target: GPU speed at x264-like quality. Spatial AQ keeps detail in flat areas.
    return ['-c:v', 'h264_nvenc', '-preset', NVENC_PRESET[preset] || 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', String(crf - 1), '-b:v', '0', '-maxrate', '16M', '-bufsize', '32M', '-spatial-aq', '1', '-aq-strength', '8', '-profile:v', 'high'];
  }
  if (kind === 'qsv') return ['-c:v', 'h264_qsv', '-preset', preset === 'ultrafast' ? 'veryfast' : preset, '-global_quality', String(crf), '-look_ahead', '1'];
  if (kind === 'amf') return ['-c:v', 'h264_amf', '-quality', preset === 'slow' ? 'quality' : 'balanced', '-rc', 'cqp', '-qp_i', String(crf - 2), '-qp_p', String(crf)];
  const x264Preset = opts.fast ? (['ultrafast', 'superfast', 'veryfast'].includes(preset) ? preset : 'veryfast') : preset;
  return ['-c:v', 'libx264', '-preset', x264Preset, '-crf', String(crf), '-threads', String(opts.threads || 0)];
}

/** Source decoding stays on the CPU: the filters run there, and copying GPU-decoded frames back to
    memory measured slower than plain CPU decoding (1080p60 H.264: 2.3 s vs 1.5 s for 20 s). */
const inputArgs = () => [];

function probe(kind) {
  return new Promise(resolve => {
    const proc = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=0.3', ...videoArgs(kind, { output: { preset: 'medium', crf: 23 } }), '-pix_fmt', 'yuv420p', '-f', 'null', '-'], { windowsHide: true });
    const timer = setTimeout(() => { require('./process').killTree(proc); resolve(false); }, 15000);
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

/**
 * Which encoder each parallel worker uses. The processor always does the decoding and every filter
 * (framing, blur, layouts, overlays); the encoder is the GPU when there is one. Measured on a 1080p60
 * stream (6 × 20 s, reaction layout, 12 threads + GTX 1650): GPU×3 27.5 s, GPU×2 31.2 s, GPU×4 29.4 s,
 * GPU×3 + x264×1 31.0 s, GPU×2 + x264×1 37.1 s — extra x264 workers compete with the filters for the
 * same cores, so by default a GPU machine uses three GPU workers only. Each worker takes the next clip
 * as soon as it is free. Overrides: VIDCREATOR_GPU_WORKERS, VIDCREATOR_CPU_WORKERS (mixed mode), or
 * VIDCREATOR_PARALLEL on a CPU-only machine.
 */
async function workerPlan() {
  const cores = os.cpus().length, kind = await detect();
  const env = name => (Number.isFinite(Number(process.env[name])) && process.env[name] !== '' ? Math.max(0, Math.min(8, Math.floor(Number(process.env[name])))) : null);
  let gpu = kind === 'cpu' ? 0 : env('VIDCREATOR_GPU_WORKERS') ?? 3;
  let cpu = env('VIDCREATOR_CPU_WORKERS') ?? (kind === 'cpu' ? env('VIDCREATOR_PARALLEL') ?? Math.max(1, Math.min(3, Math.floor(cores / 4))) : 0);
  if (gpu + cpu === 0) cpu = 1;
  const workers = [...Array(gpu).fill(kind), ...Array(cpu).fill('cpu')];
  // Split the cores between the processes: filters and x264 each get a fair share instead of fighting.
  const share = Math.max(2, Math.floor(cores / workers.length));
  return workers.map(k => ({ kind: k, threads: share, fast: k === 'cpu' && gpu > 0 }));
}
async function parallelism() { return (await workerPlan()).length; }

const LABELS = { nvenc: 'Видеокарта NVIDIA (NVENC)', qsv: 'Видеоядро Intel (Quick Sync)', amf: 'Видеокарта AMD (AMF)', cpu: 'Процессор (x264)' };
async function info() {
  const kind = await detect(), plan = await workerPlan();
  const gpu = plan.filter(w => w.kind !== 'cpu').length, cpu = plan.length - gpu;
  const label = gpu && cpu ? `${LABELS[kind]} ×${gpu} + процессор ×${cpu}` : gpu ? `${LABELS[kind]} ×${gpu}` : `Процессор (x264) ×${cpu}`;
  return { kind, label, parallel: plan.length, workers: plan };
}

module.exports = { detect, disable, videoArgs, inputArgs, parallelism, workerPlan, info };
