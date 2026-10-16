'use strict';
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
function assessMemory(sample) {
  const valid = Number.isFinite(sample?.freePhysicalKB) && Number.isFinite(sample?.freeVirtualKB);
  return { available: valid,
    paused: !valid || sample.freePhysicalKB < 1024 * 1024 || sample.freeVirtualKB < 1536 * 1024,
    freePhysicalMB: valid ? Math.floor(sample.freePhysicalKB / 1024) : null,
    freeVirtualMB: valid ? Math.floor(sample.freeVirtualKB / 1024) : null };
}
function readMemory(root) {
  if (process.platform !== 'win32') return Promise.resolve(assessMemory({freePhysicalKB:os.freemem()/1024,freeVirtualKB:os.freemem()/1024}));
  return new Promise(resolve => {
    const program = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cscript.exe');
    execFile(program, ['//B', '//Nologo', path.join(root, 'memory-status.vbs')],
      { windowsHide: true, timeout: 4000, maxBuffer: 4096 }, (error, stdout) => {
        try { resolve(assessMemory(error ? null : JSON.parse(stdout.trim()))); }
        catch { resolve(assessMemory(null)); }
      });
  });
}
module.exports = { assessMemory, readMemory };
