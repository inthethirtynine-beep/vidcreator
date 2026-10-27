/* Official whisper.cpp Windows CPU distribution + multilingual GGML models. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const run = promisify(execFile);
const ROOT = path.resolve(__dirname, '../runtime/whisper');
const RELEASE = 'b5454';
function findBinary() {
  if(process.env.WHISPER_BIN)return process.env.WHISPER_BIN;
  for(const folder of ['bin-cuda','bin']){
    const bin=path.join(ROOT,folder);if(!fs.existsSync(bin))continue;
    const name=fs.readdirSync(bin,{recursive:true}).find(f=>String(f).endsWith('whisper-cli.exe'));
    if(name)return path.join(bin,String(name));
  }return null;
}
function report(data) { process.stdout.write(JSON.stringify(data) + '\n'); }
async function download(url, file, expected, label) {
  if (fs.existsSync(file)) return;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${label}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const out = fs.createWriteStream(file + '.part');
  const hash = crypto.createHash('sha256');
  let bytes = 0, last = 0;
  try {
    for await (const chunk of res.body) {
      hash.update(chunk); bytes += chunk.length;
      if (!out.write(chunk)) await new Promise(resolve => out.once('drain', resolve));
      if (Date.now() - last > 500) { report({phase:label,bytes,total,progress:total?Math.round(bytes/total*100):null}); last=Date.now(); }
    }
    await new Promise((resolve,reject)=>{out.once('error',reject);out.end(resolve);});
    if (expected && hash.digest('hex') !== expected.replace(/^sha256:/,'')) throw new Error('Downloaded file checksum mismatch');
    fs.renameSync(file + '.part', file);
  } catch(error) { out.destroy(); try {fs.unlinkSync(file+'.part');}catch{} throw error; }
}
async function setup(model='base',cuda=false) {
  if (!['tiny','base','small'].includes(model)) throw new Error('Supported models: tiny, base, small');
  fs.mkdirSync(ROOT,{recursive:true});
  if (process.platform !== 'win32') throw new Error('Укажи WHISPER_BIN для установленного whisper-cli и WHISPER_MODEL_DIR для моделей. Автоустановка доступна в Windows x64.');
  const binDir=path.join(ROOT,cuda?'bin-cuda':'bin');
  if (!fs.existsSync(binDir)||!fs.readdirSync(binDir,{recursive:true}).some(f=>String(f).endsWith('whisper-cli.exe'))) {
    const release=await(await fetch(`https://api.github.com/repos/ggml-org/whisper.cpp/releases/tags/${RELEASE}`)).json();
    const asset=release.assets?.find(a=>a.name===(cuda?'whisper-bin-win-cuda-12.4.0-x64.zip':'whisper-bin-x64.zip'));
    if(!asset)throw new Error('Official whisper.cpp Windows release not found');
    const zip=path.join(ROOT,asset.name);
    await download(asset.browser_download_url,zip,asset.digest,'Движок whisper.cpp');
    const quote=value=>"'"+value.replace(/'/g,"''")+"'";
    await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',`Expand-Archive -LiteralPath ${quote(zip)} -DestinationPath ${quote(binDir)} -Force`],{windowsHide:true});
  }
  const modelDir=path.join(ROOT,'models');fs.mkdirSync(modelDir,{recursive:true});
  const filename=`ggml-${model}.bin`;
  if(!fs.existsSync(path.join(modelDir,filename))) {
    const info=await(await fetch('https://huggingface.co/api/models/ggerganov/whisper.cpp')).json();
    const revision=info.sha;
    const tree=await(await fetch(`https://huggingface.co/api/models/ggerganov/whisper.cpp/tree/${revision}?limit=1000`)).json();
    const entry=Array.isArray(tree)?tree.find(e=>e.path===filename):null;
    await download(`https://huggingface.co/ggerganov/whisper.cpp/resolve/${revision}/${filename}`,path.join(modelDir,filename),entry?.lfs?.oid,`Модель ${model}`);
  }
  fs.writeFileSync(path.join(ROOT,'installation.json'),JSON.stringify({release:RELEASE,model,installedAt:new Date().toISOString(),source:'https://github.com/ggml-org/whisper.cpp'},null,2));
  report({phase:'Готово',progress:100,model});
}
if(require.main===module)setup(process.argv[2],process.argv.includes('--cuda')).catch(error=>{report({error:error.message});process.exitCode=1;});
module.exports={setup,ROOT,findBinary};
