'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Worker } = require('node:worker_threads');
const { Transform } = require('node:stream');
const { StringDecoder } = require('node:string_decoder');
const { normalizeUsage, summarize, name, finite } = require('./usage.cjs');

class Ledger {
  constructor(runtimeDir) {
    this.file = path.join(runtimeDir, 'bridge-usage.json');
    this.records = []; this.timer = null; this.writeError = false;
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(saved.records)) this.records = saved.records.filter((r) => finite(r.time)).slice(-10000).map((r) => ({
        time: r.time, model: name(r.model), provider: name(r.provider),
        status: ['completed', 'failed', 'aborted'].includes(r.status) ? r.status : 'unknown',
        statusCode: finite(r.statusCode) ? r.statusCode : null,
        durationMs: finite(r.durationMs) ? r.durationMs : null,
        usageKnown: r.usageKnown === true && normalizeUsage(r) !== null,
        ...(r.usageKnown === true ? normalizeUsage(r) : {}),
      }));
    } catch { /* A new install has no ledger yet. */ }
  }
  add(record) {
    this.records.push(record);
    if (this.records.length > 10000) this.records.shift();
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 250);
      this.timer.unref();
    }
  }
  flush() {
    try {
      const temporary = this.file + '.tmp';
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, records: this.records }));
      fs.renameSync(temporary, this.file);
      this.writeError = false;
    } catch { this.writeError = true; }
  }
  close() { if (this.timer) clearTimeout(this.timer); this.flush(); }
}

function createExchange(ledger, onActive, url, method) {
  if (method !== 'POST' || !/^\/v1\/(chat\/completions|responses|messages)(?:\?|$)/.test(url)) return null;
  onActive(1);
  const start = Date.now();
  let done = false, prefix = '', responseText = '', pending = '', eventLines = [];
  let model = 'unknown', usage = null, streamError = false, contentType = '';
  const decoder = new StringDecoder('utf8');
  function sample(text) {
    if (!text || text === '[DONE]') return;
    try {
      const item = JSON.parse(text);
      if (typeof item.model === 'string') model = name(item.model);
      const parsed = normalizeUsage(item.usage || item.response?.usage);
      if (parsed) usage = parsed;
      if (item.error || item.type === 'error') streamError = true;
    } catch { /* Not every response is JSON; unknown usage stays unknown. */ }
  }
  const input = new Transform({ transform(chunk, _encoding, callback) {
    if (prefix.length < 65536) {
      prefix += chunk.toString('utf8').slice(0, 65536 - prefix.length);
      const match = /"model"\s*:\s*"((?:\\.|[^"\\]){1,180})"/.exec(prefix);
      if (match) { try { model = name(JSON.parse('"' + match[1] + '"')); } catch {} }
    }
    callback(null, chunk);
  } });
  const output = new Transform({ transform(chunk, _encoding, callback) {
    const text = decoder.write(chunk);
    if (contentType.includes('text/event-stream')) {
      pending += text;
      let end;
      while ((end = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, end).replace(/\r$/, ''); pending = pending.slice(end + 1);
        if (!line) { sample(eventLines.join('\n')); eventLines = []; }
        else if (line.startsWith('data:') && eventLines.join('').length < 2 * 1024 * 1024) {
          eventLines.push(line.slice(5).trimStart());
        }
      }
      if (pending.length > 2 * 1024 * 1024) pending = '';
    } else if (responseText.length <= 2 * 1024 * 1024) responseText += text;
    callback(null, chunk);
  }, flush(callback) {
    const last = decoder.end();
    if (!contentType.includes('text/event-stream')) sample(responseText + last);
    else if (eventLines.length) sample(eventLines.join('\n'));
    callback();
  } });
  return { input, output, setContentType(value) { contentType = String(value || ''); },
    finish(statusCode, aborted = false) {
      if (done) return;
      done = true; prefix = ''; responseText = ''; pending = ''; eventLines = [];
      onActive(-1);
      ledger.add({ time: start, provider: 'antigravity', model,
        status: aborted ? 'aborted' : statusCode >= 200 && statusCode < 300 && !streamError ? 'completed' : 'failed',
        statusCode, durationMs: Date.now() - start, usageKnown: usage !== null, ...(usage || {}) });
    } };
}

function createDashboard({ root, runtimeDir, port, dshHome, status }) {
  const ledger = new Ledger(runtimeDir);
  const home = dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  let timeZone = process.env.AG_DSH_TIMEZONE || 'Asia/Shanghai';
  try { new Intl.DateTimeFormat('en', { timeZone }).format(); }
  catch { timeZone = 'Asia/Shanghai'; }
  let worker, interval, active = 0, scanning = false, closed = false;
  let history = { records: [], files: 0, scanned: 0, errors: 0, unsupported: 0,
    partial: 0, skippedSeeds: 0, inheritedSkipped: 0, exists: fs.existsSync(path.join(home, 'sessions')) };
  let completedAt = null, progress = null, scanError = false;
  function startScan() {
    if (closed || scanning) return;
    if (!worker) {
      worker = new Worker(path.join(__dirname, 'dsh-reader.cjs'), { workerData: { root: path.join(home, 'sessions') } });
      worker.on('message', (message) => {
        if (message.type === 'progress') { progress = message; return; }
        scanning = false;
        if (message.type === 'result') {
          const { type, completedAt: time, ...snapshot } = message;
          history = snapshot; completedAt = time; scanError = false;
        } else scanError = true;
      });
      worker.on('error', () => { scanning = false; scanError = true; });
      worker.on('exit', () => { worker = null; scanning = false; });
      worker.unref();
    }
    scanning = true; progress = null; worker.postMessage('scan');
  }
  function allowed(request, pathname) {
    const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    if (!hosts.has(String(request.headers.host || '').toLowerCase())) return false;
    // A user may open the HTML page from a saved external launcher. Cross-site
    // fetches, frames, and direct requests for statistics remain forbidden.
    if (request.headers['sec-fetch-site'] === 'cross-site') {
      const topLevelPage = request.method === 'GET'
        && request.headers['sec-fetch-mode'] === 'navigate'
        && request.headers['sec-fetch-dest'] === 'document'
        && ['/', '/dashboard', '/dashboard/'].includes(pathname);
      if (!topLevelPage) return false;
    }
    if (request.headers.origin && ![...hosts].some((host) => request.headers.origin === `http://${host}`)) return false;
    return true;
  }
  function send(response, code, body, type = 'application/json; charset=utf-8') {
    response.writeHead(code, { 'content-type': type, 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'" });
    response.end(Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body));
  }
  function handle(request, response) {
    let url;
    try { url = new URL(request.url, `http://127.0.0.1:${port}`); } catch { return false; }
    if (url.pathname !== '/' && url.pathname !== '/favicon.ico' && !url.pathname.startsWith('/dashboard')) return false;
    if (!allowed(request, url.pathname)) { send(response, 403, { error: 'Local same-origin access only' }); return true; }
    if (request.method !== 'GET') { send(response, 405, { error: 'Read-only dashboard' }); return true; }
    if (url.pathname === '/favicon.ico') { send(response, 204, ''); return true; }
    if (url.pathname === '/' || url.pathname === '/dashboard') {
      response.writeHead(302, { location: '/dashboard/' }); response.end(); return true;
    }
    if (url.pathname === '/dashboard/api/stats') {
      if (!interval) { startScan(); interval = setInterval(startScan, 30000); interval.unref(); }
      const range = ['1', '7', '30', 'all'].includes(url.searchParams.get('range')) ? url.searchParams.get('range') : '7';
      const { records, ...scan } = history;
      send(response, 200, { generatedAt: Date.now(), timeZone, range,
        dsh: { ...summarize(records, range, timeZone), scan: { ...scan, scanning, completedAt,
          progress: progress ? { scanned: progress.scanned, files: progress.files } : null, scanError } },
        bridge: { ...summarize(ledger.records, range, timeZone), status: { ...status(), activeRequests: active },
          retention: 10000, persistenceError: ledger.writeError },
        quota: { available: false, note: '官方剩余额度未接入；本页 Token 是本机记录的消耗，不代表套餐余额。' } });
      return true;
    }
    const assets = { '/dashboard/': ['index.html', 'text/html; charset=utf-8'],
      '/dashboard/app.js': ['app.js', 'text/javascript; charset=utf-8'],
      '/dashboard/style.css': ['style.css', 'text/css; charset=utf-8'] };
    const asset = assets[url.pathname];
    if (!asset) { send(response, 404, { error: 'Not found' }); return true; }
    try { send(response, 200, fs.readFileSync(path.join(root, 'web', asset[0])), asset[1]); }
    catch { send(response, 503, { error: 'Dashboard assets are missing' }); }
    return true;
  }
  return { handle,
    begin(url, method) { return createExchange(ledger, (change) => { active += change; }, url, method); },
    async close() { closed = true; if (interval) clearInterval(interval); if (worker) await worker.terminate(); ledger.close(); } };
}

module.exports = { createDashboard, createExchange, Ledger };
