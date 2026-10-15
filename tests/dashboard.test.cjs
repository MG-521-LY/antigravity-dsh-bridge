'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const zlib = require('node:zlib');
const { Readable } = require('node:stream');
const { finished } = require('node:stream/promises');
const { setTimeout: delay } = require('node:timers/promises');
const { normalizeUsage, summarize } = require('../lib/usage.cjs');
const { createFold, readSession, listLogs } = require('../lib/dsh-reader.cjs');
const { Ledger, createExchange, createDashboard } = require('../lib/dashboard.cjs');

const now = Date.UTC(2026, 9, 15, 2);
const header = { type: 'session', version: 4, id: 'synthetic-session', createdAt: now, isSeeded: false };
const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, cacheWriteTokens: 0, totalTokens: 200 };
function message(turn = 1, step = 1, extra = {}) {
  return { type: 'assistant/message', time: now + step * 1000, data: { turn, step,
    message: { source: { provider: 'example', model: 'test-model' }, content: 'PRIVATE_BODY_SENTINEL' },
    usage, stream: [{ type: 'chunk', chunk: { type: 'usage', usage } }], ...extra } };
}
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dashboard-test-'));
  // Remove only this exact directory created by the test, using the same API.
  t.after(() => {
    const resolved = fs.realpathSync(dir), parent = fs.realpathSync(os.tmpdir());
    assert.equal(path.dirname(resolved).toLowerCase(), parent.toLowerCase());
    assert(path.basename(resolved).startsWith('dsh-dashboard-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return dir;
}

test('token buckets preserve DSH cache semantics and normalize OpenAI cached input', () => {
  assert.equal(normalizeUsage(usage).totalTokens, 200);
  assert.deepEqual(normalizeUsage({ prompt_tokens: 180, completion_tokens: 20,
    prompt_tokens_details: { cached_tokens: 80 } }), usage);
  assert.equal(normalizeUsage({ inputTokens: -1, outputTokens: 0 }), null);
  assert.equal(normalizeUsage({}), null);
});

test('last seed boundary excludes inherited steps; final and stream usage count once', () => {
  const fold = createFold();
  fold.accept({ ...header, isSeeded: true });
  fold.accept(message());
  fold.accept({ type: 'session/end-seed', data: {} });
  fold.accept(message(2));
  fold.accept({ type: 'session/end-seed', data: {} });
  fold.accept(message(3));
  const result = fold.finish();
  assert.equal(result.records.length, 1);
  assert.equal(result.inheritedSkipped, 2);
  assert.equal(result.records[0].totalTokens, 200);
  assert.equal(JSON.stringify(result).includes('PRIVATE_BODY_SENTINEL'), false);
});

test('missing seed boundary is excluded instead of double counting', () => {
  const fold = createFold(); fold.accept({ ...header, isSeeded: true }); fold.accept(message());
  assert.equal(fold.finish().skippedSeed, true);
  assert.equal(fold.finish().records.length, 0);
});

test('concatenated Zstandard frames include events, preserve torn prefix, and select latest generation', (t) => {
  const dir = temporary(t), session = path.join(dir, 'session'); fs.mkdirSync(session);
  const file = path.join(session, 'session.v4.jsonl.zstd');
  const encode = (value) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(value) + '\n'));
  fs.writeFileSync(file, Buffer.concat([encode(header), encode(message()), Buffer.from([0x28, 0xb5])]));
  fs.writeFileSync(path.join(session, 'session.v3.jsonl.zstd'), encode({ ...header, version: 3 }));
  const result = readSession(file);
  assert.equal(result.records.length, 1); assert.equal(result.partial, true);
  assert.equal(listLogs(dir).length, 1); assert.equal(listLogs(dir)[0].version, 4);
});

test('date filtering uses Shanghai day boundaries and missing usage remains unmeasured', () => {
  const records = [{ ...usage, time: Date.UTC(2026, 9, 14, 17), model: 'a', provider: 'p',
    usageKnown: true, status: 'completed' }, { time: Date.UTC(2026, 9, 14, 15), model: 'a', provider: 'p', status: 'failed' }];
  const today = summarize(records, '1', 'Asia/Shanghai', now);
  assert.equal(today.totals.calls, 1); assert.equal(today.totals.totalTokens, 200);
  const all = summarize(records, 'all', 'Asia/Shanghai', now);
  assert.equal(all.totals.coverage, .5); assert.equal(all.totals.failed, 1);
  assert.equal(all.totals.cacheHitRate, 80 / 180);
});

test('SSE observer forwards unchanged bytes and persists only numeric usage metadata', async (t) => {
  const dir = temporary(t), ledger = new Ledger(dir);
  t.after(() => ledger.close());
  let active = 0;
  const exchange = createExchange(ledger, (value) => { active += value; }, '/v1/chat/completions', 'POST');
  const requestBody = JSON.stringify({ model: 'test-model', messages: [{ content: 'PRIVATE_PROMPT_SENTINEL' }] });
  const input = []; exchange.input.on('data', (chunk) => input.push(chunk));
  exchange.input.end(requestBody); await finished(exchange.input);
  assert.equal(Buffer.concat(input).toString(), requestBody);
  exchange.setContentType('text/event-stream');
  const wire = 'data: ' + JSON.stringify({ model: 'test-model', choices: [{ delta: { content: 'PRIVATE_REPLY_SENTINEL' } }] })
    + '\r\n\r\ndata: ' + JSON.stringify({ usage: { prompt_tokens: 180, completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 80 } } }) + '\n\ndata: [DONE]\n\n';
  const output = []; exchange.output.on('data', (chunk) => output.push(chunk));
  for (const chunk of Buffer.from(wire)) exchange.output.write(Buffer.from([chunk]));
  exchange.output.end(); await finished(exchange.output);
  assert.equal(Buffer.concat(output).toString(), wire);
  exchange.finish(200); exchange.finish(200);
  assert.equal(active, 0); assert.equal(ledger.records.length, 1);
  assert.equal(ledger.records[0].totalTokens, 200);
  ledger.flush();
  const saved = fs.readFileSync(ledger.file, 'utf8');
  assert(!saved.includes('PRIVATE_')); assert.equal(new Ledger(dir).records.length, 1);
});

test('unknown token usage and HTTP errors retain request counts without fabricated tokens', async (t) => {
  const ledger = new Ledger(temporary(t)); t.after(() => ledger.close());
  const exchange = createExchange(ledger, () => {}, '/v1/chat/completions', 'POST');
  exchange.finish(502);
  assert.equal(ledger.records[0].status, 'failed'); assert.equal(ledger.records[0].usageKnown, false);
  const totals = summarize(ledger.records, 'all').totals;
  assert.equal(totals.calls, 1); assert.equal(totals.measuredCalls, 0);
});

test('requested high alias and returned internal model are recorded separately without changing SSE bytes', async (t) => {
  const dir = temporary(t), ledger = new Ledger(dir); t.after(() => ledger.close());
  const exchange = createExchange(ledger, () => {}, '/v1/chat/completions', 'POST');
  const body = JSON.stringify({ model: 'gemini-3.8-flash-high', messages: [{ role: 'user', content: 'PRIVATE_PROMPT_SENTINEL' }] });
  const sent = []; exchange.input.on('data', chunk => sent.push(chunk));
  for (const byte of Buffer.from(body)) exchange.input.write(Buffer.from([byte]));
  exchange.input.end(); await finished(exchange.input);
  exchange.setContentType('text/event-stream');
  const wire = 'data: ' + JSON.stringify({ model: 'gemini-3.8-flash-n', choices: [], usage: { prompt_tokens: 20, completion_tokens: 3 } }) + '\n\ndata: [DONE]\n\n';
  const received = []; exchange.output.on('data', chunk => received.push(chunk));
  exchange.output.end(wire); await finished(exchange.output); exchange.finish(200);
  assert.equal(Buffer.concat(sent).toString(), body); assert.equal(Buffer.concat(received).toString(), wire);
  const record = ledger.records[0];
  assert.equal(record.model, 'gemini-3.8-flash-high');
  assert.equal(record.requestedModel, 'gemini-3.8-flash-high');
  assert.equal(record.responseModel, 'gemini-3.8-flash-n');
  ledger.flush();
  const restored = new Ledger(dir); t.after(() => restored.close());
  assert.equal(restored.records[0].requestedModel, record.requestedModel);
  assert.equal(restored.records[0].responseModel, record.responseModel);
  assert(!fs.readFileSync(ledger.file, 'utf8').includes('PRIVATE_PROMPT_SENTINEL'));
});

test('only the top-level request model is used; legacy records retain their original identity', async (t) => {
  const dir = temporary(t), file = path.join(dir, 'bridge-usage.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, records: [{ time: now, model: 'gemini-3.8-flash-n', provider: 'antigravity', status: 'completed', usageKnown: false }] }));
  const ledger = new Ledger(dir); t.after(() => ledger.close());
  assert.equal(ledger.records[0].model, 'gemini-3.8-flash-n');
  assert.equal(ledger.records[0].requestedModel, null);
  assert.equal(ledger.records[0].responseModel, null);
  assert.equal(ledger.records[0].modelIdentityVersion, 0);
  const exchange = createExchange(ledger, () => {}, '/v1/chat/completions', 'POST');
  exchange.input.resume();
  exchange.input.end(JSON.stringify({ metadata: { model: 'decoy' }, messages: [{ content: 'PRIVATE_BODY_SENTINEL' }], model: 'gemini-3.8-flash-high' }));
  await finished(exchange.input);
  exchange.output.resume(); exchange.setContentType('application/json');
  exchange.output.end(JSON.stringify({ model: 'gemini-3.8-flash-n', usage: { prompt_tokens: 10, completion_tokens: 2 } }));
  await finished(exchange.output); exchange.finish(200);
  assert.equal(ledger.records[1].model, 'gemini-3.8-flash-high');
  assert.equal(ledger.records[1].responseModel, 'gemini-3.8-flash-n');
});

test('dashboard serves real history asynchronously, rejects cross-origin access, and cannot start backend', async (t) => {
  const dir = temporary(t), home = path.join(dir, 'home'), session = path.join(home, 'sessions', 'project', 'one');
  fs.mkdirSync(session, { recursive: true });
  fs.writeFileSync(path.join(session, 'session.v4.jsonl'), [header, message()].map(JSON.stringify).join('\n') + '\n');
  let dashboard, backendStarts = 0;
  const server = http.createServer((request, response) => {
    if (!dashboard.handle(request, response)) { backendStarts++; response.writeHead(404); response.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port, base = `http://127.0.0.1:${port}`;
  dashboard = createDashboard({ root: path.join(__dirname, '..'), runtimeDir: dir, port,
    dshHome: home, status: () => ({ backendRunning: false }) });
  t.after(async () => { await dashboard.close(); await new Promise((resolve) => server.close(resolve)); });
  const page = await fetch(base + '/dashboard/'); assert.equal(page.status, 200);
  assert((await page.text()).includes('模型用量总览'));
  assert.equal((await fetch(base + '/favicon.ico')).status, 204);
  const forbidden = await fetch(base + '/dashboard/api/stats', { headers: { Origin: 'https://example.com' } });
  assert.equal(forbidden.status, 403);
  const navigation = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
  // Node fetch overwrites Sec-Fetch-Mode; use HTTP to represent browser metadata.
  const navigationStatus = (route, headers) => new Promise((resolve, reject) => {
    http.get(base + route, { headers }, (response) => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    }).on('error', reject);
  });
  assert.equal(await navigationStatus('/dashboard/', navigation), 200);
  assert.equal(await navigationStatus('/dashboard/api/stats', navigation), 403);
  assert.equal(await navigationStatus('/dashboard/', { ...navigation, 'Sec-Fetch-Dest': 'iframe' }), 403);
  assert.equal(await navigationStatus('/dashboard/', { ...navigation, 'Sec-Fetch-Mode': 'cors' }), 403);
  assert.equal(await navigationStatus('/dashboard/api/stats', { ...navigation, Origin: 'https://example.com' }), 403);
  let stats;
  for (let i = 0; i < 100; i++) {
    stats = await (await fetch(base + '/dashboard/api/stats?range=all')).json();
    if (stats.dsh.scan.completedAt) break;
    await delay(25);
  }
  assert.equal(stats.dsh.totals.totalTokens, 200);
  assert.equal(stats.quota.available, false); assert.equal(backendStarts, 0);
  assert(!JSON.stringify(stats).includes('PRIVATE_BODY_SENTINEL'));
});
