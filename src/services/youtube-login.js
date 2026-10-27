/* YouTube sign-in window. Opens Edge/Chrome with a dedicated profile in runtime/yt-login (never the
   user's everyday profile), lets the person sign in themselves, then reads the youtube.com cookies
   over the DevTools protocol on 127.0.0.1 and hands them over as a Netscape cookies.txt. The profile
   stays, so the session can later be refreshed in the background without signing in again. */
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const PROFILE_ROOT = path.resolve(__dirname, '../../runtime/yt-login');
// With a saved profile Google offers its account chooser instead of an empty form.
const SIGN_IN_URL = 'https://accounts.google.com/ServiceLogin?service=youtube&continue=' + encodeURIComponent('https://www.youtube.com/');
const LOGIN_COOKIES = ['LOGIN_INFO', '__Secure-3PSID', '__Secure-1PSID', 'SID'];
const TIMEOUT = 10 * 60 * 1000;

function candidates() {
  const pf = process.env.ProgramFiles || 'C:/Program Files', pf86 = process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', local = process.env.LOCALAPPDATA || '';
  if (process.platform === 'win32') return [
    ['edge', 'Microsoft Edge', [path.join(pf86, 'Microsoft/Edge/Application/msedge.exe'), path.join(pf, 'Microsoft/Edge/Application/msedge.exe')]],
    ['chrome', 'Google Chrome', [path.join(pf, 'Google/Chrome/Application/chrome.exe'), path.join(pf86, 'Google/Chrome/Application/chrome.exe'), path.join(local, 'Google/Chrome/Application/chrome.exe')]],
    ['brave', 'Brave', [path.join(pf, 'BraveSoftware/Brave-Browser/Application/brave.exe'), path.join(local, 'BraveSoftware/Brave-Browser/Application/brave.exe')]],
  ];
  if (process.platform === 'darwin') return [
    ['chrome', 'Google Chrome', ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']],
    ['edge', 'Microsoft Edge', ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']],
    ['brave', 'Brave', ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser']],
  ];
  return [['chrome', 'Google Chrome', ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']], ['edge', 'Microsoft Edge', ['/usr/bin/microsoft-edge']], ['brave', 'Brave', ['/usr/bin/brave-browser']]];
}
function browsers() {
  return candidates().map(([id, name, paths]) => ({ id, name, file: paths.find(p => p && fs.existsSync(p)) })).filter(b => b.file);
}
const profileDir = id => path.join(PROFILE_ROOT, id);
// A profile counts only after a completed sign-in, not merely because the window was opened once.
const marker = id => path.join(PROFILE_ROOT, `${id}.signed-in`);
function savedProfile() {
  return browsers().find(b => fs.existsSync(marker(b.id))) || null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}
async function cdp(port, method, params = {}) {
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(webSocketDebuggerUrl);
    const timer = setTimeout(() => { ws.close(); reject(new Error('DevTools не ответил')); }, 5000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
    ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id !== 1) return;
      clearTimeout(timer); ws.close();
      message.error ? reject(new Error(message.error.message)) : resolve(message.result);
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('Нет связи с окном браузера')); };
  });
}
const youtubeCookies = async port => (await cdp(port, 'Storage.getCookies')).cookies.filter(c => /(^|\.)youtube\.com$/.test(c.domain));
const signedIn = cookies => cookies.some(c => LOGIN_COOKIES.includes(c.name));
function toNetscape(cookies) {
  const lines = ['# Netscape HTTP Cookie File', '# Exported by VidCreator from its YouTube sign-in window'];
  for (const c of cookies) {
    const expires = c.session || !(c.expires > 0) ? 0 : Math.round(c.expires);
    lines.push(`${c.httpOnly ? '#HttpOnly_' : ''}${c.domain}\t${c.domain.startsWith('.') ? 'TRUE' : 'FALSE'}\t${c.path}\t${c.secure ? 'TRUE' : 'FALSE'}\t${expires}\t${c.name}\t${c.value}`);
  }
  return lines.join('\n') + '\n';
}
async function launch(browser, port, { headless = false, url }) {
  const dir = profileDir(browser.id);
  fs.mkdirSync(dir, { recursive: true });
  const args = [`--user-data-dir=${dir}`, `--remote-debugging-port=${port}`, '--no-first-run', '--no-default-browser-check', '--disable-sync', '--new-window'];
  if (headless) args.push('--headless=new', '--mute-audio');
  args.push(url);
  const proc = spawn(browser.file, args, { windowsHide: headless, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) {
    try { await fetch(`http://127.0.0.1:${port}/json/version`); return proc; } catch { await new Promise(r => setTimeout(r, 250)); }
  }
  proc.kill();
  throw new Error(`${browser.name} не запустился`);
}
async function closeBrowser(port, proc) {
  try { await cdp(port, 'Browser.close'); } catch {}
  setTimeout(() => { try { proc?.kill(); } catch {} }, 1500);
}

/* Which Google account is signed in: name, e-mail and photo, read from accounts.google.com inside the
   sign-in window (the same list Chrome uses for its account menu). Kept in runtime/yt-login/account.json
   so the sidebar can show it. */
const ACCOUNT_FILE = path.join(PROFILE_ROOT, 'account.json');
function readAccount() { try { return JSON.parse(fs.readFileSync(ACCOUNT_FILE, 'utf8')); } catch { return null; } }
async function fetchAccount(port) {
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = event => { const m = JSON.parse(event.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const msg = { id: ++id, method, params, ...(sessionId ? { sessionId } : {}) };
    const timer = setTimeout(() => { pending.delete(msg.id); reject(new Error('DevTools не ответил')); }, 8000);
    pending.set(msg.id, m => { clearTimeout(timer); m.error ? reject(new Error(m.error.message)) : resolve(m.result); });
    ws.send(JSON.stringify(msg));
  });
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('Нет связи с окном браузера')); });
  let targetId;
  try {
    // The account list answers a POST made from a Google page (a plain GET returns 400).
    ({ targetId } = await call('Target.createTarget', { url: 'https://accounts.google.com/', background: true }));
    const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
    const request = 'fetch("https://accounts.google.com/ListAccounts?gpsia=1&source=ChromiumBrowser&json=standard",{method:"POST",credentials:"include"}).then(r=>r.ok?r.text():"").catch(()=>"")';
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 700));
      const { result } = await call('Runtime.evaluate', { expression: `location.hostname.endsWith("google.com") ? ${request} : ""`, awaitPromise: true, returnByValue: true }, sessionId);
      const text = String(result?.value || '').trim();
      if (!text.startsWith('[')) continue;
      const first = JSON.parse(text)?.[1]?.[0];
      if (!first) return null;
      return { name: first[2] || null, email: first[3] || null, photo: String(first[4] || '').startsWith('https://') ? first[4] : null };
    }
    return null;
  } finally {
    if (targetId) call('Target.closeTarget', { targetId }).catch(() => {});
    setTimeout(() => ws.close(), 300);
  }
}
async function saveAccount(port) {
  try {
    const account = await fetchAccount(port);
    if (account?.email) fs.writeFileSync(ACCOUNT_FILE, JSON.stringify({ ...account, updatedAt: new Date().toISOString() }, null, 2));
  } catch (error) { console.warn('Google account info:', error.message); }
}

let session = { state: 'idle' };
const publicSession = () => ({ state: session.state, browser: session.browser?.name || null, message: session.message || null, startedAt: session.startedAt || null });
function status() {
  const profile = savedProfile();
  return { ...publicSession(), browsers: browsers().map(({ id, name }) => ({ id, name })), profile: profile ? { id: profile.id, name: profile.name } : null, account: profile ? readAccount() : null };
}

/** Open the sign-in window; `onCookies(text)` stores the result (and throws if it is not usable). */
async function start(browserId, onCookies) {
  if (session.state === 'waiting') return status();
  const list = browsers(), browser = list.find(b => b.id === browserId) || list[0];
  if (!browser) throw new Error('Не нашёл Edge, Chrome или Brave. Установи один из них или загрузи cookies.txt вручную.');
  const port = await freePort();
  const proc = await launch(browser, port, { url: SIGN_IN_URL });
  const current = session = { state: 'waiting', browser, port, proc, startedAt: new Date().toISOString(), message: `Войди в аккаунт в открывшемся окне ${browser.name}` };
  const finish = (state, message) => { if (session !== current) return; clearInterval(current.timer); session = { state, browser, message }; };
  current.timer = setInterval(async () => {
    if (Date.now() - Date.parse(current.startedAt) > TIMEOUT) { finish('error', 'Время ожидания входа вышло. Нажми «Войти в аккаунт» ещё раз.'); return closeBrowser(port, proc); }
    try {
      let cookies = await youtubeCookies(port);
      if (!signedIn(cookies)) return;
      clearInterval(current.timer);
      current.message = 'Сохраняю вход…';
      await new Promise(r => setTimeout(r, 2000)); // let YouTube finish setting its session cookies
      cookies = await youtubeCookies(port);
      await onCookies(toNetscape(cookies));
      await saveAccount(port);
      browsers().forEach(b => fs.rmSync(marker(b.id), { force: true }));
      fs.writeFileSync(marker(browser.id), new Date().toISOString());
      finish('saved', 'Аккаунт подключён');
      closeBrowser(port, proc);
    } catch (error) {
      // The window was closed before the sign-in finished.
      if (/fetch failed|ECONNREFUSED|Нет связи/.test(error.message)) finish('error', 'Окно закрыли до входа в аккаунт.');
      else if (!/DevTools не ответил/.test(error.message)) { finish('error', error.message); closeBrowser(port, proc); }
    }
  }, 2000);
  return status();
}

function cancel() {
  if (session.state === 'waiting') { clearInterval(session.timer); closeBrowser(session.port, session.proc); session = { state: 'idle' }; }
  return status();
}

/** Re-read the cookies from the saved profile in a hidden window (no sign-in needed). */
async function refresh() {
  if (session.state === 'waiting') throw new Error('Сначала заверши вход в открытом окне');
  const browser = savedProfile();
  if (!browser) throw new Error('Нет сохранённого входа. Нажми «Войти в аккаунт» слева внизу.');
  const port = await freePort(), proc = await launch(browser, port, { headless: true, url: 'https://www.youtube.com/' });
  try {
    await new Promise(r => setTimeout(r, 4000)); // YouTube rotates part of its session cookies on load
    const cookies = await youtubeCookies(port);
    if (!signedIn(cookies)) throw new Error('Сохранённый вход устарел. Нажми «Войти в аккаунт» слева внизу и войди заново.');
    if (!readAccount()) await saveAccount(port);
    return toNetscape(cookies);
  } finally { await closeBrowser(port, proc); }
}

function forget() {
  cancel();
  // The window may still be releasing its files for a moment after closing.
  fs.rmSync(PROFILE_ROOT, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });
  session = { state: 'idle' };
  return status();
}

module.exports = { status, start, cancel, refresh, forget, toNetscape, browsers, savedProfile };
