/* Official yt-dlp standalone build from github.com/yt-dlp/yt-dlp releases, checked against the
   release's SHA2-256SUMS. Usage: node scripts/setup-ytdlp.js [--force] */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '../runtime/yt-dlp');
const ASSETS = { win32: 'yt-dlp.exe', darwin: 'yt-dlp_macos', linux: process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux' };
const report = data => process.stdout.write(JSON.stringify(data) + '\n');

async function setup(force = false) {
  const name = ASSETS[process.platform];
  if (!name) throw new Error('Автоустановка yt-dlp доступна для Windows, macOS и Linux. Укажи YTDLP_BIN вручную.');
  const target = path.join(ROOT, name);
  if (fs.existsSync(target) && !force) { report({ phase: 'yt-dlp уже установлен', progress: 100, file: target }); return target; }
  fs.mkdirSync(ROOT, { recursive: true });
  report({ phase: 'Поиск последней версии', progress: 0 });
  const release = await (await fetch('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest', { headers: { 'User-Agent': 'vidcreator' } })).json();
  const asset = release.assets?.find(a => a.name === name), sums = release.assets?.find(a => a.name === 'SHA2-256SUMS');
  if (!asset || !sums) throw new Error('Не найден официальный релиз yt-dlp');
  const expected = (await (await fetch(sums.browser_download_url)).text()).split('\n').map(line => line.trim().split(/\s+/)).find(([, file]) => file === name)?.[0];
  if (!expected) throw new Error('В релизе нет контрольной суммы для ' + name);

  const res = await fetch(asset.browser_download_url);
  if (!res.ok) throw new Error(`Не удалось скачать yt-dlp: ${res.status}`);
  const total = Number(res.headers.get('content-length')) || asset.size || 0, part = target + '.part', out = fs.createWriteStream(part), hash = crypto.createHash('sha256');
  let bytes = 0, last = 0;
  try {
    for await (const chunk of res.body) {
      hash.update(chunk); bytes += chunk.length;
      if (!out.write(chunk)) await new Promise(resolve => out.once('drain', resolve));
      if (Date.now() - last > 400) { report({ phase: `Загрузка yt-dlp ${release.tag_name}`, bytes, total, progress: total ? Math.round(bytes / total * 100) : null }); last = Date.now(); }
    }
    await new Promise((resolve, reject) => { out.once('error', reject); out.end(resolve); });
    if (hash.digest('hex') !== expected.toLowerCase()) throw new Error('Контрольная сумма yt-dlp не совпала, файл удалён');
    fs.renameSync(part, target);
    if (process.platform !== 'win32') fs.chmodSync(target, 0o755);
  } catch (error) { out.destroy(); try { fs.unlinkSync(part); } catch {} throw error; }
  report({ phase: `yt-dlp ${release.tag_name} установлен`, progress: 100, version: release.tag_name, file: target });
  return target;
}

if (require.main === module) setup(process.argv.includes('--force')).catch(error => { console.error(error.message); process.exit(1); });
module.exports = { setup, ROOT, ASSETS };
