'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const cp = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
async function waitFor(check, timeout = 5000) { const end=Date.now()+timeout; while(Date.now()<end) { if(await check()) return; await delay(30); } throw Error('Condition timed out'); }
function temporary(t) { const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-lifecycle-')); t.context={cleanup:async()=>{}}; t.after(async()=>{ await t.context.cleanup(); const real=fs.realpathSync(dir); assert.equal(path.dirname(real).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase()); assert(path.basename(real).startsWith('dsh-lifecycle-')); fs.rmSync(real,{recursive:true,force:true}); }); return dir; }
async function port() { const s=http.createServer(); s.listen(0,'127.0.0.1'); await once(s,'listening'); const p=s.address().port; await new Promise(r=>s.close(r)); return p; }

test('supervisor restarts a crashed entry, prevents duplicates, and persists memory failure classification', async t=>{
  const dir=temporary(t), fixture=path.join(dir,'entry.cjs');
  fs.writeFileSync(fixture,"setTimeout(()=>{process.stderr.write('FATAL ERROR: Allocation failed - JavaScript heap out of memory\\n');process.exit(7)},100)");
  const {supervise}=require('../bridge-supervisor.cjs');
  const supervisor=supervise({root:dir,entry:fixture}); t.context.cleanup=async()=>{supervisor.stop();await waitFor(()=>!fs.existsSync(path.join(dir,'supervisor-lock.json')));};
  assert.equal(supervise({root:dir,entry:fixture}),null);
  await waitFor(()=>fs.existsSync(path.join(dir,'lifecycle.log')) && fs.readFileSync(path.join(dir,'lifecycle.log'),'utf8').split('\n').filter(x=>x.includes('"entry-start"')).length>=2);
  const entries=fs.readFileSync(path.join(dir,'lifecycle.log'),'utf8').trim().split('\n').map(JSON.parse);
  assert(entries.some(x=>x.event==='entry-exit'&&x.code===7&&x.memoryFailure));
  supervisor.stop();
  await waitFor(()=>!fs.existsSync(path.join(dir,'supervisor-lock.json')));
});

test('persistent health failure protects active streams, then restarts the owned backend when idle', async t=>{
  const dir=temporary(t), front=await port(), back=await port();
  fs.writeFileSync(path.join(dir,'config.yaml'),'server:\n  port: 8317\n');
  const original=cp.spawn; let lastChild;
  const code="const http=require('node:http');let hang=false;http.createServer((q,s)=>{if(q.url==='/hold'){s.writeHead(200,{'content-type':'text/event-stream'});s.write(': hold\\n\\n');return;}if(q.url==='/hang'){hang=true;s.end();return;}if(hang)return;if(!q.headers.authorization){s.writeHead(401);s.end();return;}s.end(JSON.stringify({data:[{id:'synthetic'}]}));}).listen(Number(process.argv[1]),'127.0.0.1');";
  cp.spawn=(exe,args,options)=>{assert.equal(exe,'SYNTHETIC_BACKEND');return lastChild=original(process.execPath,['--max-old-space-size=32','-e',code,String(back)],options);};
  delete require.cache[require.resolve('../lazy-api.cjs')];
  const bridge=require('../lazy-api.cjs').createBridge({frontPort:front,backendPort:back,runtimeDir:dir,configPath:path.join(dir,'config.yaml'),backendExecutable:'SYNTHETIC_BACKEND'});
  t.context.cleanup=async()=>{await bridge.close();cp.spawn=original;delete require.cache[require.resolve('../lazy-api.cjs')];};
  await once(bridge.server,'listening');
  const request=()=>fetch(`http://127.0.0.1:${front}/v1/models`,{headers:{authorization:'Bearer synthetic'},signal:AbortSignal.timeout(5000)});
  let response=await request(); assert.equal(response.status,200); await response.text();
  const oldPid=lastChild.pid;
  const heldController=new AbortController();
  const held=await fetch(`http://127.0.0.1:${front}/hold`,{headers:{authorization:'Bearer synthetic'},signal:heldController.signal});
  assert.equal(held.status,200);
  await (await fetch(`http://127.0.0.1:${back}/hang`)).text();
  for(let n=0;n<3;n++){response=await request();assert.equal(response.status,503);await response.text();assert.equal(lastChild.pid,oldPid);}
  heldController.abort();await delay(60);
  response=await request();assert.equal(response.status,200);await response.text();
  assert.notEqual(lastChild.pid,oldPid);
  assert(fs.readFileSync(path.join(dir,'lifecycle.log'),'utf8').includes('backend-unresponsive'));
});

test('fatal error diagnostics omit messages which may contain request content',()=>{
  const {errorInfo}=require('../lib/lifecycle.cjs');
  const info=errorInfo(new Error('PRIVATE_PROMPT_SENTINEL'));
  assert.equal(info.name,'Error'); assert(!JSON.stringify(info).includes('PRIVATE_PROMPT_SENTINEL'));
});

test('statistics process failure leaves the API entry healthy and reports stale data', async t=>{
  const dir=temporary(t), front=await port(), originalFork=cp.fork;
  const fixture=path.join(dir,'crash-reader.cjs');
  fs.writeFileSync(fixture,"process.once('message',()=>process.exit(17))");
  let reader;
  cp.fork=(file,args,options)=>{reader=originalFork(fixture,args,options);return reader;};
  delete require.cache[require.resolve('../lib/dashboard.cjs')];
  delete require.cache[require.resolve('../lazy-api.cjs')];
  const bridge=require('../lazy-api.cjs').createBridge({frontPort:front,backendPort:await port(),runtimeDir:dir,dshHome:dir,memoryProbe:async()=>({available:true,paused:false})});
  t.context.cleanup=async()=>{await bridge.close();cp.fork=originalFork;delete require.cache[require.resolve('../lib/dashboard.cjs')];delete require.cache[require.resolve('../lazy-api.cjs')];};
  await once(bridge.server,'listening');
  const stats=async()=>await (await fetch(`http://127.0.0.1:${front}/dashboard/api/stats`)).json();
  await stats(); await waitFor(()=>Boolean(reader?.pid));
  await waitFor(async()=>(await stats()).dsh.scan.scanError);
  const health=await fetch(`http://127.0.0.1:${front}/__bridge/health`);
  assert.equal(health.status,200);assert.equal((await health.json()).backendRunning,false);
  assert(fs.readFileSync(path.join(dir,'lifecycle.log'),'utf8').includes('statistics-exit'));
});

test('low physical memory, low commit headroom, and failed checks pause optional scanning', async t=>{
  const {assessMemory}=require('../lib/memory.cjs');
  assert.equal(assessMemory({freePhysicalKB:3*1024*1024,freeVirtualKB:256*1024}).paused,true);
  assert.equal(assessMemory({freePhysicalKB:500*1024,freeVirtualKB:8*1024*1024}).paused,true);
  assert.equal(assessMemory(null).paused,true);
  assert.equal(assessMemory({freePhysicalKB:3*1024*1024,freeVirtualKB:8*1024*1024}).paused,false);
  const dir=temporary(t), front=await port();
  const bridge=require('../lazy-api.cjs').createBridge({frontPort:front,backendPort:await port(),runtimeDir:dir,dshHome:dir,
    memoryProbe:async()=>assessMemory({freePhysicalKB:3*1024*1024,freeVirtualKB:256*1024})});
  t.context.cleanup=()=>bridge.close();await once(bridge.server,'listening');
  const stats=async()=>await (await fetch(`http://127.0.0.1:${front}/dashboard/api/stats`)).json();
  await stats();await waitFor(async()=>(await stats()).dsh.scan.memoryPaused);
  assert.equal((await stats()).dsh.scan.scanning,false);
  assert.equal((await fetch(`http://127.0.0.1:${front}/__bridge/health`)).status,200);
});

test('a successful statistics scan releases its process and keeps the completed result', async t=>{
  const dir=temporary(t), front=await port(), originalFork=cp.fork;
  let reader;
  cp.fork=(...args)=>{reader=originalFork(...args);return reader;};
  delete require.cache[require.resolve('../lib/dashboard.cjs')];delete require.cache[require.resolve('../lazy-api.cjs')];
  const bridge=require('../lazy-api.cjs').createBridge({frontPort:front,backendPort:await port(),runtimeDir:dir,dshHome:dir,
    memoryProbe:async()=>({available:true,paused:false})});
  t.context.cleanup=async()=>{await bridge.close();cp.fork=originalFork;delete require.cache[require.resolve('../lib/dashboard.cjs')];delete require.cache[require.resolve('../lazy-api.cjs')];};
  await once(bridge.server,'listening');
  const stats=async()=>await (await fetch(`http://127.0.0.1:${front}/dashboard/api/stats`)).json();
  await stats();await waitFor(()=>reader?.exitCode===0);
  const result=await stats();assert(result.dsh.scan.completedAt);assert.equal(result.dsh.scan.scanError,false);
  assert.equal(result.dsh.scan.scanning,false);
});
