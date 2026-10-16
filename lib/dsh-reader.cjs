'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { StringDecoder } = require('node:string_decoder');
const { normalizeUsage, name, finite } = require('./usage.cjs');

// Read-only analytics for v2-v4 logs. Never opens DSH credentials or modifies sessions.
function createFold() {
  let header = null, title = '', route = {}, seededBoundary = false, inheritedSkipped = 0;
  const steps = new Map();
  function accept(row) {
    if (row.type === 'session') {
      if (![2, 3, 4].includes(row.version)) throw new Error('Unsupported session version');
      header = row; return;
    }
    if (!header) throw new Error('Missing session header');
    if (row.type === 'session/end-seed') {
      inheritedSkipped += steps.size;
      steps.clear(); seededBoundary = true; return;
    }
    if (typeof header.seedLength === 'number' && row.seq < header.seedLength) return;
    const data = row.data || {};
    if (row.type === 'session/title') title = name(data.title, '未命名会话');
    if (row.type === 'request/context' || row.type === 'model/selection') {
      route = { provider: name(data.provider, route.provider), model: name(data.model, route.model) };
    }
    if (!['step/start', 'step/end', 'assistant/message', 'assistant/attempt'].includes(row.type)) return;
    if (!Number.isInteger(data.turn) || !Number.isInteger(data.step)) return;
    const key = `${data.turn}:${data.step}`;
    if (!steps.has(key)) steps.set(key, { time: row.time, start: null, durationMs: null,
      provider: route.provider || 'unknown', model: route.model || 'unknown',
      usageKnown: false, status: 'unknown', turn: data.turn, step: data.step });
    const step = steps.get(key);
    if (row.type === 'step/start') { step.start = row.time; step.time = row.time; }
    if (row.type === 'step/end' && finite(step.start) && finite(row.time)) {
      step.durationMs = Math.max(0, row.time - step.start);
    }
    if (row.type === 'assistant/message' || row.type === 'assistant/attempt') {
      const source = data.message?.source || {};
      step.provider = name(source.provider, route.provider || step.provider);
      step.model = name(source.model, route.model || step.model);
      let usage = normalizeUsage(data.usage);
      if (!usage && Array.isArray(data.stream)) {
        for (const item of data.stream) {
          const candidate = normalizeUsage(item.chunk?.usage || item.usage);
          if (candidate) usage = candidate;
        }
      }
      // The final message is authoritative; repeated stream usage is not added twice.
      if (usage) Object.assign(step, usage, { usageKnown: true });
      if (row.type === 'assistant/message') step.status = 'completed';
      else if (step.status !== 'completed') step.status = 'failed';
    }
  }
  function finish() {
    if (!header) throw new Error('Missing session header');
    if (header.isSeeded && !seededBoundary && !Number.isInteger(header.seedLength)) {
      return { records: [], title, inheritedSkipped: steps.size, skippedSeed: true };
    }
    return { records: [...steps.values()].filter((step) => finite(step.time)).map(({ start, ...step }) => ({
      ...step, sessionId: name(header.id), sessionTitle: title || '未命名会话',
    })), title, inheritedSkipped, skippedSeed: false };
  }
  return { accept, finish };
}

function readSession(file) {
  const fold = createFold();
  const bytes = fs.readFileSync(file);
  const decoder = new StringDecoder('utf8');
  let offset = 0, tail = '', partial = false;
  function lines(text) {
    const chunks = (tail + text).split('\n');
    tail = chunks.pop();
    for (const line of chunks) if (line.trim()) fold.accept(JSON.parse(line));
  }
  if (file.endsWith('.zstd')) {
    if (typeof zlib.zstdDecompressSync !== 'function') throw new Error('Node.js lacks Zstandard support');
    while (offset < bytes.length) {
      try {
        const end = frameEnd(bytes, offset);
        if (end === null) { partial = true; break; }
        // Decode every complete frame separately; native one-shot decoding stops after one.
        const decoded = zlib.zstdDecompressSync(bytes.subarray(offset, end), { maxOutputLength: 64 * 1024 * 1024 });
        offset = end;
        lines(decoder.write(decoded));
      } catch {
        // A concurrently appended/torn tail is reported as partial, never repaired here.
        partial = true; break;
      }
    }
    lines(decoder.end());
  } else {
    lines(bytes.toString('utf8'));
  }
  if (tail.trim()) partial = true;
  return { ...fold.finish(), partial };
}

// Zstandard frame/block sizes, as defined by RFC 8878, section 3.1.1.
// A null result denotes an unfinished append; neither bytes nor logs are repaired.
function frameEnd(buffer, start) {
  if (start + 5 > buffer.length) return null;
  if (buffer.readUInt32LE(start) !== 0xfd2fb528) throw new Error('Invalid Zstandard magic');
  const flags = buffer[start + 4];
  if (flags & 0x18) throw new Error('Reserved Zstandard header flag');
  const single = Boolean(flags & 32), sizeMode = flags >>> 6;
  const dictionarySizes = [0, 1, 2, 4];
  const contentSizes = [single ? 1 : 0, 2, 4, 8];
  let cursor = start + 5 + (single ? 0 : 1) + dictionarySizes[flags & 3] + contentSizes[sizeMode];
  while (true) {
    if (cursor + 3 > buffer.length) return null;
    const block = buffer.readUIntLE(cursor, 3), kind = (block >> 1) & 3;
    if (kind === 3) throw new Error('Reserved Zstandard block type');
    cursor += 3 + (kind === 1 ? 1 : block >>> 3);
    if (cursor > buffer.length) return null;
    if (block & 1) break;
  }
  if (flags & 4) cursor += 4;
  return cursor <= buffer.length ? cursor : null;
}

function listLogs(root) {
  const selected = new Map();
  function walk(dir, depth = 0) {
    if (depth > 6) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(file, depth + 1);
      else {
        const match = /^session(?:\.v([1-9]\d*))?\.jsonl(?:\.zstd)?$/.exec(entry.name);
        if (!match) continue;
        const version = Number(match[1] || 0);
        const old = selected.get(dir);
        if (!old || version > old.version) selected.set(dir, { file, version });
      }
    }
  }
  if (fs.existsSync(root)) walk(root);
  return [...selected.values()];
}

function scan(root, cache = new Map(), onProgress = () => {}) {
  const selected = listLogs(root), active = new Set(), records = [];
  const result = { files: selected.length, scanned: 0, errors: 0, unsupported: 0,
    partial: 0, skippedSeeds: 0, inheritedSkipped: 0, exists: fs.existsSync(root), records };
  for (const item of selected) {
    active.add(item.file);
    if (item.version < 2 || item.version > 4) { result.unsupported++; continue; }
    try {
      const stat = fs.statSync(item.file);
      if (stat.size > 512 * 1024 * 1024) throw new Error('Session exceeds reader size limit');
      const revision = `${stat.size}:${stat.mtimeMs}`;
      let saved = cache.get(item.file);
      if (!saved || saved.revision !== revision) {
        saved = { revision, ...readSession(item.file) }; cache.set(item.file, saved);
      }
      records.push(...saved.records);
      result.partial += Number(saved.partial);
      result.skippedSeeds += Number(saved.skippedSeed);
      result.inheritedSkipped += saved.inheritedSkipped;
      result.scanned++;
    } catch { result.errors++; }
    if (result.scanned % 5 === 0) onProgress({ scanned: result.scanned, files: selected.length });
  }
  for (const key of cache.keys()) if (!active.has(key)) cache.delete(key);
  return result;
}

if (process.env.AG_DSH_READER_CHILD === '1' && process.send) {
  const cache = new Map();
  process.on('disconnect', () => process.exit(0));
  process.on('message', (message) => {
    if (message !== 'scan') return;
    try {
      const result = scan(process.env.AG_DSH_LOG_ROOT, cache,
        (progress) => { if (process.connected) process.send({ type: 'progress', ...progress }); });
      if (process.connected) process.send({ type: 'result', ...result, completedAt: Date.now() });
      // Do not retain a decoded session cache between scans on a memory-constrained PC.
      process.disconnect();
    } catch {
      if (process.connected) process.send({ type: 'scan-error', completedAt: Date.now() });
      process.disconnect();
    }
  });
}
module.exports = { createFold, readSession, listLogs, scan };
