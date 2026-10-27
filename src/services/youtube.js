/* Local YouTube import through yt-dlp: no API keys, no third-party server. The binary lives in
   runtime/yt-dlp (installed by scripts/setup-ytdlp.js) or is given by YTDLP_BIN. */
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { randomUUID } = require('crypto');
const { ROOT, ASSETS } = require('../../scripts/setup-ytdlp');
const login = require('./youtube-login');

const HOSTS = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'];
const QUALITIES = ['2160', '1440', '1080', '720', '480', '360'];
const jobs = new Map();
let installation = null, versionCache = null;

/* ---------- Signing in to YouTube ----------
   YouTube's "confirm you're not a bot" check (common behind VPNs) and age gates need a logged-in
   session. yt-dlp can read it from a local browser or from an exported cookies.txt file. The choice
   is stored in runtime/yt-dlp/settings.json; cookies never leave this computer. */
const SETTINGS = path.join(ROOT, 'settings.json'), COOKIES = path.join(ROOT, 'cookies.txt');
const BROWSERS = { edge: 'Microsoft Edge', chrome: 'Google Chrome', firefox: 'Firefox', brave: 'Brave', opera: 'Opera', vivaldi: 'Vivaldi' };
function browserDirs() {
  const local = process.env.LOCALAPPDATA || '', roaming = process.env.APPDATA || '', home = require('os').homedir();
  if (process.platform === 'win32') return { edge: path.join(local, 'Microsoft/Edge/User Data'), chrome: path.join(local, 'Google/Chrome/User Data'), firefox: path.join(roaming, 'Mozilla/Firefox/Profiles'), brave: path.join(local, 'BraveSoftware/Brave-Browser/User Data'), opera: path.join(roaming, 'Opera Software/Opera Stable'), vivaldi: path.join(local, 'Vivaldi/User Data') };
  if (process.platform === 'darwin') return { chrome: path.join(home, 'Library/Application Support/Google/Chrome'), firefox: path.join(home, 'Library/Application Support/Firefox/Profiles'), edge: path.join(home, 'Library/Application Support/Microsoft Edge'), brave: path.join(home, 'Library/Application Support/BraveSoftware/Brave-Browser') };
  return { chrome: path.join(home, '.config/google-chrome'), firefox: path.join(home, '.mozilla/firefox'), edge: path.join(home, '.config/microsoft-edge'), brave: path.join(home, '.config/BraveSoftware/Brave-Browser') };
}
function readSettings() { try { return { auth: 'none', ...JSON.parse(fs.readFileSync(SETTINGS, 'utf8')) }; } catch { return { auth: 'none' }; } }
function authStatus() {
  const settings = readSettings(), dirs = browserDirs();
  const cookies = fs.existsSync(COOKIES) ? fs.statSync(COOKIES) : null;
  return {
    mode: process.env.YTDLP_COOKIES_BROWSER ? 'env' : settings.auth,
    browser: process.env.YTDLP_COOKIES_BROWSER || settings.browser || null,
    // 'login' = cookies taken from VidCreator's own sign-in window, 'upload' = a cookies.txt the user chose
    source: settings.auth === 'file' ? settings.source || 'upload' : null,
    cookiesFile: cookies ? { updatedAt: cookies.mtime.toISOString() } : null,
    browsers: Object.entries(BROWSERS).filter(([id]) => dirs[id] && fs.existsSync(dirs[id])).map(([id, name]) => ({ id, name })),
    login: login.status(),
  };
}
function setAuth({ mode, browser, source } = {}) {
  if (!['none', 'browser', 'file'].includes(mode)) throw new Error('Неизвестный способ входа');
  if (mode === 'browser' && !BROWSERS[browser]) throw new Error('Выбери браузер');
  if (mode === 'file' && !fs.existsSync(COOKIES)) throw new Error('Сначала загрузи файл cookies.txt');
  fs.mkdirSync(ROOT, { recursive: true });
  const previous = readSettings();
  fs.writeFileSync(SETTINGS, JSON.stringify({ auth: mode, browser: mode === 'browser' ? browser : null, source: mode === 'file' ? source || previous.source || 'upload' : null }, null, 2));
  return authStatus();
}
/** Accepts a Netscape cookies.txt export (e.g. from the "Get cookies.txt LOCALLY" extension). */
function saveCookies(content, source = 'upload') {
  const text = String(content || '');
  const rows = text.split(/\r?\n/).filter(line => line.trim() && (!line.startsWith('#') || line.startsWith('#HttpOnly_')));
  if (!rows.length || rows.some(row => row.split('\t').length < 7)) throw new Error('Это не похоже на cookies.txt. Нужен файл в формате Netscape — его сохраняет расширение «Get cookies.txt LOCALLY».');
  if (!rows.some(row => /youtube\.com\t/.test(row))) throw new Error('В файле нет cookies youtube.com. Открой youtube.com со входом в аккаунт и экспортируй cookies с этой страницы.');
  if (!rows.some(row => /\t(SID|__Secure-3PSID|__Secure-1PSID|LOGIN_INFO)\t/.test(row))) throw new Error('В файле нет входа в аккаунт YouTube. Войди в YouTube в браузере и экспортируй cookies заново.');
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(COOKIES, text.endsWith('\n') ? text : text + '\n', { mode: 0o600 });
  return setAuth({ mode: 'file', source });
}
/* Sign-in window (src/services/youtube-login.js): the person signs in, cookies are stored here. */
function startLogin(browser) { return login.start(browser, text => saveCookies(text, 'login')).then(authStatus); }
function cancelLogin() { login.cancel(); return authStatus(); }
async function refreshLogin() { saveCookies(await login.refresh(), 'login'); return authStatus(); }
function forgetLogin() {
  login.forget();
  if (readSettings().source === 'login') { fs.rmSync(COOKIES, { force: true }); setAuth({ mode: 'none' }); }
  return authStatus();
}
function clearCookies() {
  fs.rmSync(COOKIES, { force: true });
  if (readSettings().auth === 'file') setAuth({ mode: 'none' });
  return authStatus();
}
function authArgs() {
  if (process.env.YTDLP_COOKIES_BROWSER) return ['--cookies-from-browser', process.env.YTDLP_COOKIES_BROWSER];
  const settings = readSettings();
  if (settings.auth === 'file' && fs.existsSync(COOKIES)) return ['--cookies', COOKIES];
  if (settings.auth === 'browser' && BROWSERS[settings.browser]) return ['--cookies-from-browser', settings.browser];
  return [];
}

function findBinary() {
  if (process.env.YTDLP_BIN) return process.env.YTDLP_BIN;
  const local = path.join(ROOT, ASSETS[process.platform] || 'yt-dlp');
  return fs.existsSync(local) ? local : null;
}

function version(binary) {
  if (versionCache?.binary === binary) return versionCache.promise;
  const promise = new Promise(resolve => execFile(binary, ['--version'], { windowsHide: true, timeout: 15000 }, (error, stdout) => resolve(error ? null : stdout.trim())));
  versionCache = { binary, promise };
  return promise;
}

async function status() {
  const binary = findBinary();
  return {
    engine: 'yt-dlp',
    ready: !!binary,
    version: binary ? await version(binary) : null,
    installation: installation ? { ...installation, proc: undefined } : null,
  };
}

/** Download (or, with force, update) yt-dlp in the background; progress is read through status(). */
function install(force = false) {
  if (installation?.status === 'processing') return;
  installation = { status: 'processing', phase: 'Подготовка', progress: 0 };
  const proc = spawn(process.execPath, [path.resolve(__dirname, '../../scripts/setup-ytdlp.js'), ...(force ? ['--force'] : [])], { windowsHide: true });
  let buffer = '', logs = '';
  proc.stdout.on('data', chunk => {
    buffer += chunk;
    let line;
    while ((line = buffer.indexOf('\n')) >= 0) {
      const text = buffer.slice(0, line); buffer = buffer.slice(line + 1);
      try { Object.assign(installation, JSON.parse(text)); } catch {}
    }
  });
  proc.stderr.on('data', chunk => { logs = (logs + chunk).slice(-600); });
  proc.on('error', error => { installation.status = 'error'; installation.error = error.message; });
  proc.on('close', code => {
    installation.status = code === 0 ? 'completed' : 'error';
    if (code !== 0) installation.error ||= logs.trim() || 'Не удалось установить yt-dlp';
    versionCache = null;
  });
}

function validateUrl(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { throw new Error('Вставь ссылку на видео YouTube'); }
  if (!['https:', 'http:'].includes(url.protocol) || !HOSTS.includes(url.hostname)) throw new Error('Нужна ссылка youtube.com или youtu.be');
  return url.toString();
}

/** Human-readable reason from yt-dlp's last ERROR line. */
function explain(stderr) {
  const line = stderr.split('\n').reverse().find(l => l.includes('ERROR:')) || stderr.trim().split('\n').pop() || '';
  const text = line.replace(/^.*?ERROR:\s*(\[[^\]]+\]\s*[\w-]+:\s*)?/, '');
  if (/could not copy .*cookie database|database is locked/i.test(stderr)) return 'Браузер держит cookies открытыми. Полностью закрой его (и фоновые процессы в трее) и повтори — или загрузи файл cookies.txt.';
  if (/DPAPI|app.?bound|decrypt/i.test(stderr)) return 'Этот браузер шифрует cookies так, что их нельзя прочитать со стороны. Выбери другой браузер или загрузи файл cookies.txt.';
  if (/could not find .*cookies|no such file.*Cookies|failed to load cookies/i.test(stderr)) return 'В этом браузере не нашлось cookies. Войди в YouTube в нём или загрузи файл cookies.txt.';
  if (/confirm you.?re not a bot|Sign in to confirm/i.test(text)) return 'YouTube просит подтвердить, что ты не бот (так бывает с VPN). Нужен вход в YouTube: выбери браузер или загрузи cookies.txt во вкладке «По ссылке YouTube» → «Вход в YouTube» и повтори.';
  if (/age|inappropriate/i.test(text)) return 'Видео с возрастным ограничением. Нужен вход в YouTube: выбери браузер или загрузи cookies.txt во вкладке «По ссылке YouTube» → «Вход в YouTube».';
  if (/Private video/i.test(text)) return 'Это приватное видео, скачать его нельзя.';
  if (/Video unavailable|not available/i.test(text)) return 'Видео недоступно: удалено, скрыто или закрыто для твоей страны.';
  if (/live event|is live|premieres/i.test(text)) return 'Трансляции и премьеры можно скачать только после окончания.';
  if (/ffmpeg/i.test(text)) return 'yt-dlp не нашёл FFmpeg для склейки видео и звука.';
  if (/Unsupported URL/i.test(text)) return 'Ссылка не похожа на видео YouTube.';
  return text.trim() || 'yt-dlp завершился с ошибкой. Попробуй обновить его кнопкой «Обновить yt-dlp».';
}

function publicJob(job) {
  const { proc, register, dir, ...rest } = job;
  return rest;
}

/**
 * Start a download. `register(filePath, title)` turns the finished file into a library video.
 * Streams are fetched separately and merged into MP4; H.264 + AAC is preferred so the result
 * plays in the browser preview and renders without transcoding surprises.
 */
function start(rawUrl, quality, targetDir, register) {
  const binary = findBinary();
  if (!binary) throw new Error('Сначала установи yt-dlp: кнопка «Установить» в импорте с YouTube или npm run setup:youtube');
  const url = validateUrl(rawUrl), height = QUALITIES.includes(String(quality)) ? String(quality) : '1080';
  fs.mkdirSync(targetDir, { recursive: true });
  const job = { id: randomUUID(), url, quality: height, status: 'starting', stage: 'Получение информации о видео', title: null, duration: null, percent: 0, speed: null, eta: null, error: null, video: null, dir: targetDir, register, createdAt: new Date().toISOString() };
  jobs.set(job.id, job);

  const args = [
    url, '--no-playlist', '--newline', '--no-colors', '--no-mtime', '--progress', '--no-simulate',
    '-f', 'bv*+ba/b', '-S', `res:${height},vcodec:h264,acodec:m4a`, '--merge-output-format', 'mp4',
    '-o', path.join(targetDir, 'source.%(ext)s'),
    '--print', 'before_dl:INFO\t%(title)s\t%(duration)s',
    '--print', 'after_move:FILE\t%(filepath)s',
    '--progress-template', 'download:PROGRESS\t%(progress.status)s\t%(progress.downloaded_bytes)s\t%(progress.total_bytes)s\t%(progress.total_bytes_estimate)s\t%(progress.speed)s\t%(progress.eta)s',
    // YouTube now needs a JavaScript runtime for signatures; reuse the Node that runs this server.
    '--js-runtimes', `node:${process.execPath}`,
  ];
  // Sign in once: a sign-in made through the window is renewed silently when it gets old, so
  // YouTube keeps seeing a fresh session and the bot check rarely appears at all.
  const settings = readSettings(), cookieAge = fs.existsSync(COOKIES) ? Date.now() - fs.statSync(COOKIES).mtimeMs : Infinity;
  if (settings.auth === 'file' && settings.source === 'login' && cookieAge > 6 * 3600 * 1000 && login.savedProfile()) {
    job.stage = 'Обновление входа в YouTube';
    refreshLogin().catch(error => console.warn('YouTube sign-in refresh:', error.message)).finally(() => { if (job.status !== 'cancelled') run(job, binary, args, register); });
  } else run(job, binary, args, register);
  return publicJob(job);
}

function run(job, binary, baseArgs, register) {
  const targetDir = job.dir;
  // Auth is read on every attempt, so a refreshed sign-in applies to the retry.
  const proc = spawn(binary, [...baseArgs, ...authArgs()], { windowsHide: true, cwd: targetDir });
  job.proc = proc;

  let buffer = '', stderr = '', stream = 0, lastPercent = 0, file = null;
  const num = value => (value === 'NA' || value === 'None' || value === '' ? null : Number(value));
  proc.stdout.on('data', chunk => {
    buffer += chunk;
    let line;
    while ((line = buffer.indexOf('\n')) >= 0) {
      const text = buffer.slice(0, line).trim(); buffer = buffer.slice(line + 1);
      const [kind, ...fields] = text.split('\t');
      if (kind === 'INFO') {
        job.title = fields[0] || job.title; job.duration = num(fields[1]);
      } else if (kind === 'FILE') {
        file = fields[0];
      } else if (kind === 'PROGRESS') {
        const [state, done, total, estimate, speed, eta] = fields;
        const size = num(total) ?? num(estimate), percent = size ? Math.min(100, num(done) / size * 100) : 0;
        // Video comes first, then the (much smaller) audio stream: a reset to ~0% marks the switch.
        if (percent + 30 < lastPercent) stream = 1;
        lastPercent = percent;
        job.status = 'downloading';
        job.stage = stream ? 'Скачивание звука' : 'Скачивание видео';
        job.percent = Math.round(stream ? 88 + percent * 0.07 : percent * 0.88);
        job.speed = num(speed); job.eta = num(eta);
        if (state === 'finished' && stream) { job.stage = 'Склейка видео и звука'; job.percent = 96; }
      }
    }
  });
  proc.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  proc.on('error', error => { job.status = 'failed'; job.error = error.message; });
  proc.on('close', async code => {
    job.proc = null;
    if (job.status === 'cancelled') return;
    if (code !== 0) {
      const needsAuth = /not a bot|Sign in to confirm|age-restricted|confirm your age|inappropriate|cookies/i.test(stderr) && !/Private video/i.test(stderr);
      // A saved sign-in window profile can renew the session silently: refresh it once and retry.
      if (needsAuth && !job.retried && login.savedProfile()) {
        job.retried = true; job.status = 'starting'; job.stage = 'Обновление входа в YouTube'; job.percent = 0;
        try { await refreshLogin(); return run(job, binary, baseArgs, register); } catch (error) { job.loginError = error.message; }
      }
      job.status = 'failed'; job.error = job.loginError && needsAuth ? job.loginError : explain(stderr);
      job.needsAuth = needsAuth;
      job.details = stderr.trim().split('\n').filter(line => /ERROR|WARNING/.test(line)).slice(-4).join('\n');
      return;
    }
    try {
      job.status = 'processing'; job.stage = 'Подготовка превью'; job.percent = 98;
      file ||= fs.readdirSync(targetDir).map(f => path.join(targetDir, f)).find(f => /source\.(mp4|mkv|webm|mov)$/i.test(f));
      if (!file || !fs.existsSync(file)) throw new Error('yt-dlp не сохранил файл');
      job.video = await register(file, job.title || 'YouTube video');
      job.status = 'completed'; job.stage = 'Готово'; job.percent = 100;
    } catch (error) { job.status = 'failed'; job.error = error.message; }
  });
}

function get(id) { const job = jobs.get(id); return job && publicJob(job); }

function cancel(id) {
  const job = jobs.get(id);
  if (!job) return null;
  if (['starting', 'downloading'].includes(job.status)) {
    job.status = 'cancelled'; job.stage = 'Отменено';
    require('./process').killTree(job.proc);
    // Partial streams are useless; remove the half-filled folder once the process lets go of it.
    setTimeout(() => fs.rm(job.dir, { recursive: true, force: true }, () => {}), 1500);
  }
  return publicJob(job);
}

module.exports = { status, install, start, get, cancel, validateUrl, explain, QUALITIES, authStatus, setAuth, saveCookies, clearCookies, startLogin, cancelLogin, refreshLogin, forgetLogin };
