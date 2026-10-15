'use strict';

const $ = (id) => document.getElementById(id);
const state = { source: 'dsh', range: '7', data: null, rows: 20, loading: false };
const colors = ['#81a7f5', '#6cc5b1', '#e5bd79', '#ae9fd3', '#e79393', '#738496'];
const exact = (value) => Number(value || 0).toLocaleString('zh-CN');
const compact = (value) => value >= 1e9 ? (value / 1e9).toFixed(2) + 'B' : value >= 1e6
  ? (value / 1e6).toFixed(2) + 'M' : value >= 1e3 ? (value / 1e3).toFixed(1) + 'K' : exact(value);
const percent = (value) => value === null || value === undefined ? '—' : (value * 100).toFixed(1) + '%';
const sharePercent = (value) => value > 0 && value < .001 ? '＜0.1%' : percent(value);
const duration = (value) => value === null || value === undefined ? '—' : value < 1000
  ? Math.round(value) + ' ms' : value < 60000 ? (value / 1000).toFixed(1) + ' s' : (value / 60000).toFixed(1) + ' min';
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const text = (id, value) => { $(id).textContent = value; };

function renderTrend(data) {
  const width = Math.max(280, $('trend-chart').clientWidth);
  const height = Math.max(220, $('trend-chart').clientHeight), left = 64, right = 20, top = 20, bottom = 40;
  const chartHeight = height - top - bottom, chartWidth = width - left - right;
  const max = Math.max(1, ...data.map((row) => row.totalTokens));
  const scale = 10 ** Math.floor(Math.log10(max));
  const ceiling = Math.ceil(max / scale) * scale;
  const slot = chartWidth / data.length, barWidth = Math.min(31, slot * .52);
  let svg = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="每日输入、缓存与输出 Token 使用量">`;
  for (let index = 0; index <= 4; index++) {
    const y = top + index * chartHeight / 4;
    svg += `<line x1="${left}" x2="${width - right}" y1="${y}" y2="${y}" stroke="#354254" stroke-dasharray="3 5"/><text x="${left - 10}" y="${y + 5}" text-anchor="end" fill="#b9c5d4" font-size="13">${compact(ceiling * (4 - index) / 4)}</text>`;
  }
  data.forEach((row, index) => {
    const x = left + slot * index + (slot - barWidth) / 2;
    let y = top + chartHeight;
    const buckets = [[row.inputTokens, colors[0], '新输入'], [row.cacheReadTokens + row.cacheWriteTokens, colors[1], '缓存'], [row.outputTokens, colors[2], '输出']];
    for (const [tokens, color, label] of buckets) {
      const h = tokens / ceiling * chartHeight; y -= h;
      if (h) svg += `<rect x="${x}" y="${y}" width="${barWidth}" height="${h}" fill="${color}" rx="1"><title>${row.day} · ${label} ${exact(tokens)} Token</title></rect>`;
    }
    if (!row.totalTokens) svg += `<rect x="${x}" y="${y - 2}" width="${barWidth}" height="2" fill="#283444" rx="1"/>`;
    const labelEvery = Math.max(1, Math.ceil(data.length / (width < 450 ? 4 : 7)));
    const showLast = index === data.length - 1 && index % labelEvery > labelEvery / 2;
    if (index % labelEvery === 0 || showLast) {
      svg += `<text x="${left + slot * (index + .5)}" y="${height - 10}" text-anchor="middle" fill="#b9c5d4" font-size="13">${row.day.slice(5).replace('-', '/')}</text>`;
    }
  });
  svg += '</svg>';
  $('trend-chart').innerHTML = svg;
}

function renderDistribution(models) {
  const useTokens = models.some((row) => row.totalTokens);
  const field = useTokens ? 'totalTokens' : 'calls';
  const ranked = [...models].sort((a, b) => b[field] - a[field]);
  const shown = ranked.slice(0, 4).map((row) => ({ label: row.model, value: row[field] }));
  if (ranked.length > 4) shown.push({ label: '其他模型', value: ranked.slice(4).reduce((sum, row) => sum + row[field], 0) });
  const total = shown.reduce((sum, row) => sum + row.value, 0), circumference = 2 * Math.PI * 52;
  let offset = 0;
  let svg = '<svg viewBox="0 0 180 145" role="img" aria-label="各模型用量占比"><circle cx="90" cy="72" r="52" fill="none" stroke="#25313e" stroke-width="11"/>';
  shown.forEach((row, index) => {
    const arc = total ? row.value / total * circumference : 0;
    if (arc) svg += `<circle cx="90" cy="72" r="52" fill="none" stroke="${colors[index]}" stroke-width="11" stroke-dasharray="${Math.max(0, arc - 3)} ${circumference}" stroke-dashoffset="${-offset}" transform="rotate(-90 90 72)"><title>${escape(row.label)} · ${percent(row.value / total)}</title></circle>`;
    offset += arc;
  });
  svg += `<text x="90" y="72" text-anchor="middle" fill="#f2f5f9" font-size="28" font-family="Segoe UI,sans-serif">${models.length}</text><text x="90" y="94" text-anchor="middle" fill="#b9c5d4" font-size="12">活跃模型</text></svg>`;
  $('model-chart').innerHTML = svg;
  text('distribution-unit', useTokens ? '按 Token' : '按调用次数');
  $('model-legend').innerHTML = shown.length ? shown.map((row, index) => `<div class="legend-row"><svg width="6" height="6" aria-hidden="true"><rect width="6" height="6" rx="2" fill="${colors[index]}"/></svg><span class="legend-name" title="${escape(row.label)}">${escape(row.label)}</span><b>${compact(row.value)}</b><span class="legend-percent">${total ? sharePercent(row.value / total) : '—'}</span></div>`).join('') : '<div class="empty">此时间范围内暂无模型调用</div>';
}

function renderModels(data) {
  const query = $('model-search').value.trim().toLowerCase();
  const rows = data.models.filter((row) => `${row.model} ${row.provider}`.toLowerCase().includes(query));
  text('model-count', data.models.length);
  $('model-rows').innerHTML = rows.length ? rows.map((row) => {
    const share = data.totals.totalTokens ? row.totalTokens / data.totals.totalTokens : 0;
    const measured = row.measuredCalls > 0;
    const value = (key) => measured ? `<span title="${exact(row[key])}">${compact(row[key])}</span>` : '<span class="unreported">未上报</span>';
    return `<tr><td class="model-cell"><span class="model-name" title="${escape(row.model)}">${escape(row.model)}</span><span class="model-provider">${escape(row.provider)}</span></td><td>${exact(row.calls)}</td><td>${value('inputTokens')}</td><td class="cache-number">${value('cacheReadTokens')}</td><td class="output-number">${value('outputTokens')}</td><td class="number-accent">${value('totalTokens')}</td><td><div class="share"><progress value="${share}" max="1" aria-label="用量占比 ${sharePercent(share)}"></progress><span>${measured ? sharePercent(share) : '—'}</span></div></td></tr>`;
  }).join('') : '<tr><td colspan="7" class="table-empty">没有符合条件的模型记录</td></tr>';
}

function renderRecent(data) {
  const filter = $('request-filter').value;
  const records = data.recent.filter((row) => filter === 'failed' ? ['failed', 'aborted'].includes(row.status)
    : filter === 'unmeasured' ? !row.usageKnown : true);
  const rows = records.slice(0, state.rows);
  const labels = { completed: '已完成', failed: '失败', aborted: '中断', unknown: '未确认' };
  $('request-rows').innerHTML = rows.length ? rows.map((row) => {
    const time = new Date(row.time);
    const date = time.toLocaleDateString('zh-CN', { timeZone: state.data.timeZone, month: '2-digit', day: '2-digit' });
    const clock = time.toLocaleTimeString('zh-CN', { timeZone: state.data.timeZone, hour12: false });
    const input = row.usageKnown ? compact((row.inputTokens || 0) + (row.cacheReadTokens || 0) + (row.cacheWriteTokens || 0)) : '未上报';
    const label = row.sessionTitle || (row.statusCode ? `HTTP ${row.statusCode} · ${row.provider}` : row.provider);
    const identity = state.source !== 'bridge' ? '' : row.modelIdentityVersion === 1
      ? `返回：${row.responseModel || '未返回模型名'}${row.requestedModel ? '' : ' · 请求名未采集'}`
      : '旧记录：请求名与返回名未分开保存';
    return `<tr><td class="time-cell">${clock}<small>${date}</small></td><td class="model-cell"><span class="model-name" title="${escape(row.model)}">${escape(row.model)}</span>${identity ? `<span class="model-provider" title="${escape(identity)}">${escape(identity)}</span>` : ''}<span class="model-provider" title="${escape(label)}">${escape(label)}</span></td><td><span class="status ${escape(row.status)}">${labels[row.status] || '未确认'}</span></td><td${row.usageKnown ? '' : ' class="unreported"'}>${input}</td><td class="${row.usageKnown ? 'output-number' : 'unreported'}">${row.usageKnown ? compact(row.outputTokens) : '未上报'}</td><td class="time-cell">${duration(row.durationMs)}</td></tr>`;
  }).join('') : '<tr><td colspan="6" class="table-empty">暂无符合条件的调用记录</td></tr>';
  $('more-button').hidden = records.length <= state.rows;
  text('recent-note', `当前显示 ${rows.length} 条 · 近期记录最多保留 80 条供查看`);
}

function render() {
  if (!state.data) return;
  const data = state.data[state.source], totals = data.totals;
  const isDsh = state.source === 'dsh';
  text('model-table-note', isDsh ? '未上报 Token 的调用仍计入调用次数。' : '新记录按请求模型统计；旧记录未分别保存请求名与返回名。');
  text('recent-model-heading', isDsh ? '模型 / 会话' : '请求模型 / 接口返回');
  text('scope-name', isDsh ? 'DSH 全部模型' : '反重力接口');
  text('scope-description', isDsh ? '从本机会话记录读取，覆盖不同提供商' : '只统计经过此本机入口的 API 调用，独立计数');
  text('scope-icon', isDsh ? '▦' : '◈');
  text('total-tokens', totals.measuredCalls ? compact(totals.totalTokens) : '—');
  $('total-tokens').title = totals.measuredCalls ? exact(totals.totalTokens) + ' Token' : '暂无已上报的 Token';
  text('total-calls', exact(totals.calls));
  $('calls-label').innerHTML = (isDsh ? '模型步骤' : 'API 请求') + '<span>≋</span>';
  text('calls-detail', isDsh ? `${data.models.length} 个模型 · ${totals.sessions} 个会话` : `${data.models.length} 个模型 · 最近 ${exact(data.retention)} 条容量`);
  text('token-detail', totals.calls ? `${exact(totals.measuredCalls)} / ${exact(totals.calls)} 次已上报 Token` : '暂无用量数据');
  text('cache-rate', percent(totals.cacheHitRate));
  text('average-time', duration(totals.averageMs));
  text('latency-detail', isDsh ? '完整步骤耗时，可能包含工具执行' : '请求总耗时，包含首次服务启动');
  text('session-count', `${state.data.dsh.scan.scanned} / ${state.data.dsh.scan.files} 份已读取`);
  text('coverage', percent(totals.coverage));
  const status = state.data.bridge.status;
  text('service-status', status.starting ? '正在启动' : status.backendRunning ? `运行中 · ${status.activeRequests} 个处理中` : '按需待命');
  text('trend-caption', `${state.data.timeZone} · ${state.range === 'all' ? '最近 14 天趋势 / 全部历史汇总' : state.range === '1' ? '今日汇总' : `最近 ${state.range} 天`}`);
  const scan = state.data.dsh.scan;
  let notice = isDsh ? `只读分析 ${scan.files} 份本机会话 · 已排除 ${exact(scan.inheritedSkipped)} 条继承步骤` : '从安装监控功能后开始记录 · 与 DSH 历史用量分别统计';
  let warning = false;
  if (isDsh && scan.scanning) { notice = `正在扫描本机会话${scan.progress ? ` ${scan.progress.scanned} / ${scan.progress.files}` : ''}，完成后自动更新…`; }
  else if (isDsh && !scan.exists) { notice = '未找到 DSH 会话目录，请确认 DSH_HOME 或默认 ~/.dsh 是否正确。'; warning = true; }
  else if (isDsh && (scan.errors || scan.partial || scan.unsupported || scan.skippedSeeds || scan.scanError)) {
    notice += ` · ${scan.errors} 份读取失败 / ${scan.partial} 份不完整 / ${scan.unsupported} 份格式未支持 / ${scan.skippedSeeds} 份继承边界缺失`; warning = true;
  }
  if (!isDsh && data.persistenceError) { notice = '接口统计暂时无法保存到磁盘，当前显示内存中的记录。'; warning = true; }
  text('notice-text', notice);
  $('notice').className = 'notice' + (warning ? ' warning' : '');
  text('updated-at', `更新于 ${new Date(state.data.generatedAt).toLocaleTimeString('zh-CN', { timeZone: state.data.timeZone, hour12: false })} · 每 5 秒刷新`);
  renderTrend(data.trend); renderDistribution(data.models); renderModels(data); renderRecent(data);
  $('export-button').disabled = false;
}

async function refresh() {
  if (state.loading) return;
  state.loading = true; $('refresh-button').classList.add('busy');
  const range = state.range;
  try {
    const response = await fetch('/dashboard/api/stats?range=' + range, { cache: 'no-store', signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error('统计服务返回 HTTP ' + response.status);
    const data = await response.json();
    if (range === state.range) { state.data = data; render(); }
  } catch {
    $('notice').className = 'notice error';
    text('notice-text', '暂时无法连接本机统计服务。请确认后台入口运行中，稍后会自动重试。');
  } finally {
    state.loading = false; $('refresh-button').classList.remove('busy');
    if (range !== state.range) refresh();
  }
}

function setSource(source) {
  state.source = source; state.rows = 20;
  document.querySelectorAll('[data-source]').forEach((item) => item.classList.toggle('active', item.dataset.source === source));
  $('model-search').value = ''; $('request-filter').value = 'all'; render();
}
document.querySelectorAll('[data-source]').forEach((button) => button.addEventListener('click', () => setSource(button.dataset.source)));
$('scope-toggle').addEventListener('click', () => setSource(state.source === 'dsh' ? 'bridge' : 'dsh'));
document.querySelectorAll('[data-range]').forEach((button) => button.addEventListener('click', () => {
  state.range = button.dataset.range; state.rows = 20;
  document.querySelectorAll('[data-range]').forEach((item) => item.classList.toggle('active', item === button));
  refresh();
}));
document.querySelectorAll('.nav-item').forEach((link) => link.addEventListener('click', () => {
  document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('selected', item === link));
}));
$('model-search').addEventListener('input', () => { if (state.data) renderModels(state.data[state.source]); });
$('request-filter').addEventListener('change', () => { state.rows = 20; if (state.data) renderRecent(state.data[state.source]); });
$('more-button').addEventListener('click', () => { state.rows += 20; if (state.data) renderRecent(state.data[state.source]); });
$('refresh-button').addEventListener('click', refresh);
$('export-button').addEventListener('click', () => {
  if (!state.data) return;
  const payload = { generatedAt: state.data.generatedAt, timeZone: state.data.timeZone,
    source: state.source, range: state.range, statistics: state.data[state.source] };
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url;
  link.download = `dsh-usage-${state.source}-${new Date().toISOString().slice(0, 10)}.json`;
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  text('toast', '当前统计已导出，仅保存在你的电脑上'); $('toast').hidden = false;
  setTimeout(() => { $('toast').hidden = true; }, 3500);
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
new ResizeObserver(() => { if (state.data) renderTrend(state.data[state.source].trend); }).observe($('trend-chart'));
refresh(); setInterval(() => { if (!document.hidden) refresh(); }, 5000);
