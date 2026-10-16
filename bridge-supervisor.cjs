'use strict';
const path = require('node:path');
const { fork, execFile } = require('node:child_process');
const { logEvent, claimLock } = require('./lib/lifecycle.cjs');

function supervise(options = {}) {
  const root = options.root || __dirname;
  const release = claimLock(root);
  if (!release) return null;
  let child = null, timer = null, stopping = false, failures = 0, backendPid = null;
  const entry = options.entry || path.join(root, 'lazy-api.cjs');
  function cleanupBackend(parentPid) {
    if (process.platform !== 'win32' || !backendPid) return Promise.resolve();
    const pid = backendPid; backendPid = null;
    return new Promise(resolve => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-File',
      path.join(root, 'cleanup-backend.ps1'), '-BackendPid', String(pid), '-ParentPid', String(parentPid),
      '-InstallDir', root], { windowsHide: true, timeout: 10000 }, error => {
        logEvent(root, 'backend-cleanup', { pid, success: !error }); resolve();
      }));
  }
  function launch() {
    if (stopping) return;
    const started = Date.now();
    let memoryFailure = false;
    try { child = fork(entry, [], { cwd: root, windowsHide: true,
      execArgv: ['--max-old-space-size=192', '--max-semi-space-size=4'],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...process.env, ...options.env } });
    } catch (error) {
      logEvent(root, 'entry-spawn-error', { code: error.code || null });
      timer = setTimeout(launch, Math.min(30000, 1000 * 2 ** Math.min(failures++, 5)));
      return;
    }
    const current = child;
    logEvent(root, 'entry-start', { pid: current.pid });
    current.on('message', message => {
      if (message?.type === 'backend-started' && Number.isInteger(message.pid)) backendPid = message.pid;
      if (message?.type === 'backend-stopped') backendPid = null;
    });
    // Keep only an error classification, never arbitrary upstream stderr text.
    current.stderr?.on('data', chunk => { if (/out of memory|Allocation failed|Committing.*failed/i.test(chunk.toString())) memoryFailure = true; });
    current.on('error', error => logEvent(root, 'entry-spawn-error', { code: error.code || null }));
    current.once('close', async (code, signal) => {
      child = null;
      logEvent(root, 'entry-exit', { pid: current.pid, code, signal, memoryFailure });
      await cleanupBackend(current.pid);
      if (stopping) { release(); return; }
      if (Date.now() - started > 60000) failures = 0;
      const delayMs = Math.min(30000, 1000 * 2 ** Math.min(failures++, 5));
      logEvent(root, 'entry-restart-scheduled', { delayMs });
      timer = setTimeout(launch, delayMs);
    });
  }
  function stop() {
    if (stopping) return;
    stopping = true; clearTimeout(timer);
    if (child) child.kill(); else release();
  }
  launch();
  return { stop, get child() { return child; } };
}
if (require.main === module) {
  const supervisor = supervise();
  if (supervisor) {
    process.on('SIGINT', () => supervisor.stop());
    process.on('SIGTERM', () => supervisor.stop());
  }
}
module.exports = { supervise };
