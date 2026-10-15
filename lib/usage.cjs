'use strict';

const finite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const number = (value) => finite(value) ? value : 0;
const name = (value, fallback = 'unknown') => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f]/g, '').slice(0, 180) || fallback : fallback;
const formatters = new Map();

// DSH inputTokens excludes cache reads/writes. OpenAI prompt_tokens includes them.
function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  if (finite(usage.inputTokens) && finite(usage.outputTokens)) {
    const result = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
      cacheReadTokens: number(usage.cacheReadTokens), cacheWriteTokens: number(usage.cacheWriteTokens) };
    result.totalTokens = Object.values(result).reduce((sum, value) => sum + value, 0);
    return result;
  }
  if (finite(usage.prompt_tokens) && finite(usage.completion_tokens)) {
    const cached = Math.min(usage.prompt_tokens, number(usage.prompt_tokens_details?.cached_tokens));
    return { inputTokens: usage.prompt_tokens - cached, outputTokens: usage.completion_tokens,
      cacheReadTokens: cached, cacheWriteTokens: 0,
      totalTokens: usage.prompt_tokens + usage.completion_tokens };
  }
  return null;
}

function dateKey(time, timeZone) {
  if (!formatters.has(timeZone)) formatters.set(timeZone, new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }));
  const parts = formatters.get(timeZone).formatToParts(time);
  return ['year', 'month', 'day'].map((type) => parts.find((part) => part.type === type).value).join('-');
}

function emptyTotals() {
  return { calls: 0, measuredCalls: 0, inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0,
    completed: 0, failed: 0, aborted: 0, unknown: 0, durationMs: 0, timedCalls: 0 };
}

function add(totals, record) {
  totals.calls++;
  if (record.usageKnown) totals.measuredCalls++;
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens']) {
    totals[key] += number(record[key]);
  }
  totals[['completed', 'failed', 'aborted'].includes(record.status) ? record.status : 'unknown']++;
  if (finite(record.durationMs)) { totals.durationMs += record.durationMs; totals.timedCalls++; }
}

function summarize(records, range = '7', timeZone = 'Asia/Shanghai', now = Date.now()) {
  const today = dateKey(now, timeZone);
  const days = ['1', '7', '30'].includes(String(range)) ? Number(range) : null;
  const first = days ? new Date(Date.parse(today + 'T00:00:00Z') - (days - 1) * 86400000)
    .toISOString().slice(0, 10) : '';
  const selected = records.filter((row) => finite(row.time) && dateKey(row.time, timeZone) >= first);
  const totals = emptyTotals(), models = new Map(), dates = new Map(), sessions = new Set();
  for (const row of selected) {
    add(totals, row);
    if (row.sessionId) sessions.add(row.sessionId);
    const key = JSON.stringify([row.provider, row.model]);
    if (!models.has(key)) models.set(key, { provider: row.provider, model: row.model, ...emptyTotals() });
    add(models.get(key), row);
    const day = dateKey(row.time, timeZone);
    if (!dates.has(day)) dates.set(day, { day, ...emptyTotals() });
    add(dates.get(day), row);
  }
  const chartDays = days || 14;
  const trend = Array.from({ length: chartDays }, (_, index) => {
    const day = new Date(Date.parse(today + 'T00:00:00Z') - (chartDays - index - 1) * 86400000)
      .toISOString().slice(0, 10);
    return dates.get(day) || { day, ...emptyTotals() };
  });
  const prompt = totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
  return { totals: { ...totals, sessions: sessions.size,
    cacheHitRate: prompt ? totals.cacheReadTokens / prompt : null,
    averageMs: totals.timedCalls ? totals.durationMs / totals.timedCalls : null,
    coverage: totals.calls ? totals.measuredCalls / totals.calls : null },
    models: [...models.values()].sort((a, b) => b.totalTokens - a.totalTokens || b.calls - a.calls),
    trend, recent: selected.slice().sort((a, b) => b.time - a.time).slice(0, 80),
    availableFrom: records.length ? records.reduce((min, row) => Math.min(min, row.time), Infinity) : null };
}

module.exports = { normalizeUsage, summarize, finite, number, name };
