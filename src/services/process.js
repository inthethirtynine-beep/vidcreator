/* Stopping child processes for real. On Windows ffmpeg is often a launcher shim (Chocolatey, Scoop)
   that starts the actual ffmpeg.exe as its own child, and proc.kill() only ends the shim, leaving the
   encoder running. Kill the whole tree instead. */
const { spawn } = require('child_process');

function killTree(proc) {
  if (!proc || proc.exitCode !== null || proc.killed && process.platform !== 'win32') return;
  if (process.platform === 'win32' && proc.pid) {
    const killer = spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => { try { proc.kill(); } catch {} });
    return;
  }
  try { proc.kill('SIGKILL'); } catch {}
}

// Processes this server started that must not outlive it (renders keep going otherwise).
const tracked = new Set();
function track(proc) {
  tracked.add(proc);
  proc.once('close', () => tracked.delete(proc));
  return proc;
}
function killAll() { tracked.forEach(killTree); }
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.once(signal, () => { killAll(); setTimeout(() => process.exit(0), 300); });
}
process.once('exit', killAll);

module.exports = { killTree, track, killAll };
