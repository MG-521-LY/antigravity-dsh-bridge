'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { createDashboard } = require('./lib/dashboard.cjs');

function createBridge(options = {}) {
const root = __dirname;
const runtimeDir = options.runtimeDir || root;
const configPath = options.configPath || path.join(root, 'config.yaml');
const backendExecutable = options.backendExecutable || path.join(root, 'bin', 'cli-proxy-api.exe');
fs.mkdirSync(runtimeDir, { recursive: true });
const frontPort = options.frontPort ?? 8317;
const backendPort = options.backendPort ?? 8318;
const statePath = path.join(runtimeDir, 'bridge-state.json');
const logPath = path.join(runtimeDir, 'bridge.log');
let backend = null;
let starting = null;
let shuttingDown = false;
const bootedAt = Date.now();
const dashboard = createDashboard({ root, runtimeDir, port: frontPort, dshHome: options.dshHome,
  status: () => ({ backendRunning: backend !== null, starting: starting !== null,
    uptimeMs: Date.now() - bootedAt, frontPort, backendPort }) });

function log(message) {
  try {
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > 1024 * 1024) {
      fs.writeFileSync(logPath, '');
    }
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
  } catch { /* Logging must not interrupt a request. */ }
}

function saveState() {
  fs.writeFileSync(statePath, JSON.stringify({
    app: 'antigravity-dsh-lazy-api',
    pid: process.pid,
    backendPid: backend?.pid ?? null,
    frontPort,
    backendPort,
    updatedAt: new Date().toISOString(),
  }, null, 2));
}

function backendReady() {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port: backendPort,
      path: '/v1/models', timeout: 500 }, (response) => {
      response.resume();
      response.on('error', () => resolve(false));
      // A 401 proves that the backend has installed its authenticated API routes.
      resolve(response.statusCode === 401);
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

function modelCatalogReady(headers) {
  return new Promise((resolve) => {
    const authHeaders = {};
    for (const name of ['authorization', 'x-api-key', 'x-goog-api-key']) {
      if (headers[name]) authHeaders[name] = headers[name];
    }
    const request = http.get({ host: '127.0.0.1', port: backendPort,
      path: '/v1/models', headers: authHeaders, timeout: 1000 }, (response) => {
      // Invalid credentials should get the backend's own 401 without delay.
      if (response.statusCode === 401 || response.statusCode === 403) {
        response.resume();
        return resolve(true);
      }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
        if (body.length > 1024 * 1024) response.destroy();
      });
      response.on('error', () => resolve(false));
      response.on('aborted', () => resolve(false));
      response.on('end', () => {
        try {
          const catalog = JSON.parse(body);
          resolve(response.statusCode === 200 && Array.isArray(catalog.data)
            && catalog.data.length > 0);
        } catch { resolve(false); }
      });
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

async function waitForCatalog(request, response) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (request.destroyed || response.destroyed) return;
    if (await modelCatalogReady(request.headers)) return;
    if (!backend) throw new Error('Backend exited while loading model catalog');
    await delay(100);
  }
  throw new Error('No models became available within 20 seconds; check the Google authorization');
}

function prepareBackendConfig() {
  const source = fs.readFileSync(configPath, 'utf8');
  const lines = source.split(/\r?\n/);
  const serverStart = lines.findIndex((line) => line === 'server:');
  if (serverStart < 0) throw new Error('config.yaml has no server section');
  let portIndex = -1;
  for (let i = serverStart + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) break;
    if (/^  port:\s*8317\s*$/.test(lines[i])) portIndex = i;
  }
  if (portIndex < 0) throw new Error('config.yaml server.port must remain 8317');
  lines[portIndex] = `  port: ${backendPort}`;
  const logsIndex = lines.findIndex((line) => line === '  logs:');
  if (logsIndex >= 0) {
    let existing = -1;
    for (let i = logsIndex + 1; i < lines.length; i++) {
      if (/^\S|^  \S/.test(lines[i])) break;
      if (/^    logging-to-file:/.test(lines[i])) existing = i;
    }
    if (existing >= 0) lines[existing] = '    logging-to-file: true';
    else lines.splice(logsIndex + 1, 0, '    logging-to-file: true');
  }
  const target = path.join(runtimeDir, 'config.backend.yaml');
  fs.writeFileSync(target, lines.join('\n'));
  return target;
}

async function ensureBackend() {
  if (starting) return starting;
  if (backend && backend.exitCode === null && await backendReady()) return;
  if (shuttingDown) throw new Error('API entry is shutting down');
  starting = (async () => {
    // Never reuse or stop a process belonging to another program on this port.
    if (backend) throw new Error('Backend is running but not responding; retry shortly');
    if (await backendReady()) throw new Error(`Port ${backendPort} is already occupied`);
    const config = prepareBackendConfig();
    const child = spawn(backendExecutable,
      ['-config', config, '-local-model'], {
        cwd: runtimeDir, windowsHide: true, stdio: 'ignore',
      });
    backend = child;
    let startError = null;
    child.on('error', (error) => {
      startError = error;
      if (backend === child) backend = null;
      saveState();
      log(`Backend launch error: ${error.message}`);
    });
    child.on('exit', (code, signal) => {
      if (backend === child) backend = null;
      saveState();
      log(`Backend exited: code=${code}, signal=${signal}`);
    });
    saveState();
    log(`Backend starting, pid=${child.pid}`);
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (startError) throw startError;
      if (backend !== child) throw new Error('Backend exited before becoming ready');
      if (await backendReady()) {
        log('Backend ready');
        return;
      }
      await delay(100);
    }
    child.kill();
    throw new Error('Backend did not become ready within 20 seconds');
  })();
  try { await starting; } finally { starting = null; }
}

function cleanHeaders(headers) {
  const result = { ...headers };
  const connectionTokens = String(result.connection || '').split(',');
  for (const token of connectionTokens) delete result[token.trim().toLowerCase()];
  for (const name of ['connection', 'proxy-connection', 'keep-alive', 'upgrade',
    'transfer-encoding', 'te', 'trailer']) delete result[name];
  return result;
}

function json(response, status, body) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

const server = http.createServer(async (request, response) => {
  if (dashboard.handle(request, response)) return;
  // Local readiness checks must not launch the backend.
  if (request.method === 'GET' && request.url === '/__bridge/health') {
    return json(response, 200, { app: 'antigravity-dsh-lazy-api',
      backendRunning: backend !== null });
  }
  const exchange = dashboard.begin(request.url, request.method);
  if (exchange) {
    response.once('finish', () => exchange.finish(response.statusCode));
    response.once('close', () => { if (!response.writableEnded) exchange.finish(response.statusCode, true); });
  }
  try {
    await ensureBackend();
    await waitForCatalog(request, response);
    if (request.destroyed || response.destroyed) return;
    const headers = cleanHeaders(request.headers);
    headers.host = `127.0.0.1:${backendPort}`;
    const upstream = http.request({ host: '127.0.0.1', port: backendPort,
      path: request.url, method: request.method, headers }, (reply) => {
      response.writeHead(reply.statusCode, cleanHeaders(reply.headers));
      reply.on('error', () => response.destroy());
      if (exchange) {
        exchange.setContentType(reply.headers['content-type']);
        exchange.output.on('error', () => response.destroy());
        reply.pipe(exchange.output).pipe(response);
      } else reply.pipe(response);
    });
    upstream.on('error', (error) => {
      log(`Upstream connection error: ${error.code || error.message}`);
      if (response.headersSent) response.destroy();
      else json(response, 502, { error: { type: 'backend_connection_error',
        message: 'Local API connection failed. Retry to restart it if necessary.' } });
    });
    request.on('aborted', () => upstream.destroy());
    request.on('error', () => upstream.destroy());
    response.on('close', () => {
      if (!response.writableEnded) upstream.destroy();
    });
    if (exchange) {
      exchange.input.on('error', () => upstream.destroy());
      request.pipe(exchange.input).pipe(upstream);
    } else request.pipe(upstream);
  } catch (error) {
    log(`Request could not start backend: ${error.message}`);
    json(response, 503, { error: { type: 'backend_start_error',
      message: error.message } });
  }
});

// Generation streams may legitimately last several minutes.
server.requestTimeout = 0;
server.headersTimeout = 60000;
server.on('clientError', (_error, socket) => socket.destroy());
server.on('error', (error) => {
  // Repeated launcher invocations do not create another backend.
  if (error.code !== 'EADDRINUSE') log(`Listener error: ${error.message}`);
});
server.listen(frontPort, '127.0.0.1', () => {
  saveState();
  log(`Local API entry ready on 127.0.0.1:${frontPort}, pid=${process.pid}`);
});

async function close() {
  if (shuttingDown) return;
  shuttingDown = true;
  const closed = new Promise((resolve) => server.close(resolve));
  const child = backend;
  if (child) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await exited;
  }
  await closed;
  await dashboard.close();
}
return { server, close };
}

if (require.main === module) {
  const bridge = createBridge();
  bridge.server.on('error', (error) => process.exit(error.code === 'EADDRINUSE' ? 0 : 1));
  const shutdown = () => bridge.close().catch(() => { process.exitCode = 1; });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('uncaughtException', (error) => {
    console.error(error.message);
    shutdown();
  });
}
module.exports = { createBridge };
