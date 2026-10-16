'use strict';
const fs = require('node:fs');
const path = require('node:path');
function logEvent(root, event, fields = {}) {
  try {
    const file = path.join(root, 'lifecycle.log');
    if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) fs.renameSync(file, file + '.1');
    fs.appendFileSync(file, JSON.stringify({ time: new Date().toISOString(), event, ...fields }) + '\n');
  } catch { /* Recovery must still work when the disk is unavailable. */ }
}
function errorInfo(error) {
  return { name: error?.name || 'Error', code: /^[A-Z0-9_]{1,50}$/.test(error?.code) ? error.code : null,
    frames: String(error?.stack || '').split('\n').slice(1, 9).filter(line => /^\s+at /.test(line)) };
}
function claimLock(root) {
  const file = path.join(root, 'supervisor-lock.json');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid })); fs.closeSync(fd);
      return () => { try { if (JSON.parse(fs.readFileSync(file)).pid === process.pid) fs.unlinkSync(file); } catch {} };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let pid;
      try { pid = JSON.parse(fs.readFileSync(file)).pid; } catch { return null; }
      if (!Number.isInteger(pid) || pid <= 0) return null;
      try { process.kill(pid, 0); return null; }
      catch (probe) { if (probe.code !== 'ESRCH') return null; }
      try { fs.unlinkSync(file); } catch { return null; }
    }
  }
  return null;
}
module.exports = { logEvent, errorInfo, claimLock };
