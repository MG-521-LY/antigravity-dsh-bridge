'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const root = __dirname;
const testModel = process.env.AG_DSH_TEST_MODEL || 'gemini-3-flash';
const isolated = process.argv.includes('--isolated');
const runtimeDir = isolated ? path.join(root, 'validation') : root;
const base = isolated ? 'http://127.0.0.1:8327' : 'http://127.0.0.1:8317';
let bridge;
const configPath = process.env.AG_DSH_CONFIG || path.join(root, 'config.yaml');
const config = fs.readFileSync(configPath, 'utf8');
const key = config.match(/ag-dsh-[0-9a-f]{48}/)?.[0];
assert(key, 'Expected local API key missing');
const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
const results = [];

async function request(url, options = {}) {
  return fetch(base + url, { signal: AbortSignal.timeout(60000), ...options });
}

async function chat(extra) {
  const reply = await request('/v1/chat/completions', { method: 'POST', headers,
    body: JSON.stringify({ model: testModel, max_tokens: 1024,
      messages: [{ role: 'user', content: 'Reply with the single word OK.' }], ...extra }) });
  assert.equal(reply.status, 200, await reply.clone().text());
  return reply;
}

(async () => {
  if (isolated) {
    bridge = require('./lazy-api.cjs').createBridge({
      frontPort: 8327, backendPort: 8328, runtimeDir,
      configPath,
      backendExecutable: process.env.AG_DSH_BACKEND,
    });
    await new Promise((resolve, reject) => {
      bridge.server.once('listening', resolve);
      bridge.server.once('error', reject);
    });
  }
  const health = await (await request('/__bridge/health')).json();
  assert.equal(health.app, 'antigravity-dsh-lazy-api');
  assert.equal(health.backendRunning, false, 'Expected backend to be stopped before this test');
  results.push('Lightweight entry active with backend stopped');
  const startsBefore = (fs.readFileSync(path.join(runtimeDir, 'bridge.log'), 'utf8')
    .match(/Backend starting,/g) || []).length;
  const catalogs = await Promise.all(Array.from({ length: 4 }, async () => {
    const reply = await request('/v1/models', { headers });
    assert.equal(reply.status, 200);
    const body = await reply.json();
    assert(body.data.some((model) => model.id === testModel));
    return body;
  }));
  const startsAfter = (fs.readFileSync(path.join(runtimeDir, 'bridge.log'), 'utf8')
    .match(/Backend starting,/g) || []).length;
  assert.equal(startsAfter - startsBefore, 1, 'Concurrent requests started multiple backends');
  results.push(`4 simultaneous requests received ${catalogs[0].data.length} models; exactly 1 backend started`);

  if (!process.argv.includes('--recovery-only')) {
    const unauthorized = await request('/v1/models');
    assert.equal(unauthorized.status, 401);
    await unauthorized.text();
    results.push('Missing API key rejected with HTTP 401');

    const normal = await (await chat({ stream: false })).json();
    assert.match(normal.choices[0].message.content, /\bOK\b/);
    results.push('Normal chat returned OK');

    const stream = await chat({ stream: true });
    assert.match(stream.headers.get('content-type'), /text\/event-stream/);
    const sse = await stream.text();
    assert(sse.includes('[DONE]'), 'Streaming reply never completed');
    let content = '';
    for (const line of sse.split(/\r?\n/)) {
      if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
      const item = JSON.parse(line.slice(6));
      assert(!item.error, JSON.stringify(item.error));
      content += item.choices?.[0]?.delta?.content || '';
    }
    assert.match(content, /\bOK\b/);
    results.push('SSE streaming returned OK and [DONE]');

    const toolReply = await (await chat({ stream: false,
      messages: [{ role: 'user', content: 'Call connection_probe with value ping.' }],
      tools: [{ type: 'function', function: { name: 'connection_probe',
        description: 'Harmless connectivity test.', parameters: { type: 'object',
          properties: { value: { type: 'string' } }, required: ['value'] } } }],
      tool_choice: { type: 'function', function: { name: 'connection_probe' } },
    })).json();
    const call = toolReply.choices[0].message.tool_calls[0];
    assert.equal(call.function.name, 'connection_probe');
    assert.equal(JSON.parse(call.function.arguments).value, 'ping');
    results.push('Tool call returned connection_probe(value=ping)');
    const statsReply = await request('/dashboard/api/stats?range=all');
    assert.equal(statsReply.status, 200);
    const statistics = await statsReply.json();
    assert(statistics.bridge.totals.calls >= 3);
    assert(statistics.bridge.totals.measuredCalls >= 2);
    assert.equal(statistics.quota.available, false);
    results.push('Dashboard reports real bridge calls and measured tokens; quota stays explicitly unavailable');
  }
  if (isolated) {
    // This PID belongs to the real backend spawned by this isolated bridge.
    const beforeCrash = JSON.parse(fs.readFileSync(path.join(runtimeDir, 'bridge-state.json'), 'utf8'));
    process.kill(beforeCrash.backendPid);
    const deadline = Date.now() + 5000;
    let stopped = false;
    while (Date.now() < deadline) {
      const health = await (await request('/__bridge/health')).json();
      if (!health.backendRunning) { stopped = true; break; }
      await delay(50);
    }
    assert(stopped, 'Backend exit was not observed');
    const recovery = await request('/v1/models', { headers });
    assert.equal(recovery.status, 200);
    assert((await recovery.json()).data.length > 0);
    const afterCrash = JSON.parse(fs.readFileSync(path.join(runtimeDir, 'bridge-state.json'), 'utf8'));
    assert(afterCrash.backendPid && afterCrash.backendPid !== beforeCrash.backendPid);
    results.push('Next API request restarted an unexpectedly stopped backend and returned models');
  }
  const report = { verifiedAt: new Date().toISOString(), results };
  const reportPath = process.env.AG_DSH_TEST_REPORT || path.join(root,
    process.argv.includes('--recovery-only') ? 'verification-recovery.json' : 'verification.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
})().catch((error) => { console.error(error.message); process.exitCode = 1; })
  .finally(async () => { if (bridge) await bridge.close(); });
