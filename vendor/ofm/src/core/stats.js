import { MIN_DECODE_MS } from '../store.js'
import { describeSavingsTotal, emptySavings, savingsPercent } from '../token-saver/index.js'

export function buildStats(stats, catalog, ids) {
  // `ids`, when given, is the set of models this instance actually serves. The panel shows one
  // row per model id found in the records, and this service's records predate a scope: without
  // this filter a stripped lane (Kilo, the anonymous pool) still appears in 按模型 统计 as a
  // historical row and inflates the daily trend and the grand counters with it. Everything
  // below is derived from the filtered row sets, so the trend, the table and the totals agree.
  const allowed = ids === undefined ? null : new Set(ids)
  const keep = model => allowed === null || allowed.has(model)

  const rawDays = stats.days ?? {}
  const days = {}
  for (const [day, bucket] of Object.entries(rawDays)) {
    if (allowed === null) { days[day] = bucket; continue }
    const models = Object.fromEntries(Object.entries(bucket.models ?? {}).filter(([model]) => keep(model)))
    // Upstream's bucket total is `Σ(input + output)` over its own rows; recomputed here over
    // the rows that survive, so a filtered trend never sums to more than the table under it.
    days[day] = {
      ...bucket, models,
      total: Object.values(models).reduce((sum, row) => sum + (row.input ?? 0) + (row.output ?? 0), 0),
    }
  }
  const series = Object.keys(days).sort().map(day => ({
    day,
    total: days[day].total ?? 0,
    models: Object.entries(days[day].models ?? {}).map(([model, value]) => ({ model, ...value })),
  }))
  const totals = {}
  for (const entry of series) for (const row of entry.models) {
    const previous = totals[row.model] ?? {
      model: row.model, input: 0, output: 0, reasoning: 0, calls: 0, failed: 0,
      ttftMs: 0, ttftSamples: 0, decodeMs: 0, decodeTokens: 0,
    }
    totals[row.model] = {
      ...previous,
      input: previous.input + row.input,
      output: previous.output + row.output,
      reasoning: previous.reasoning + row.reasoning,
      calls: previous.calls + row.calls,
      failed: previous.failed + row.failed,
      ttftMs: previous.ttftMs + (row.ttftMs ?? 0),
      ttftSamples: previous.ttftSamples + (row.ttftSamples ?? 0),
      decodeMs: previous.decodeMs + (row.decodeMs ?? 0),
      decodeTokens: previous.decodeTokens + (row.decodeTokens ?? 0),
    }
  }
  const logical = stats.logical ?? {}
  const logicalModels = logical.models ?? {}
  const logicalReady = Number.isSafeInteger(logical.turns)
  const lifetimeModels = stats.models ?? {}
  const scopedLogical = logicalReady && allowed !== null
    ? Object.fromEntries(Object.entries(logicalModels).filter(([model]) => keep(model)))
    : logicalModels
  const scopedLifetime = allowed === null
    ? lifetimeModels
    : Object.fromEntries(Object.entries(lifetimeModels).filter(([model]) => keep(model)))
  const empty = model => ({
    model, input: 0, output: 0, reasoning: 0, cacheRead: 0, calls: 0, failed: 0,
    ttftMs: 0, ttftSamples: 0, decodeMs: 0, decodeTokens: 0,
  })
  // The logical map is part of the row set, not just a lookup table: a combo
  // records its turn under the chain's own id and its physical calls under each
  // link's, so a chain that never appears here would show its links in the panel
  // and be invisible itself — the one row a user configuring a chain looks for.
  const modelIds = new Set([...Object.keys(totals), ...Object.keys(scopedLifetime), ...Object.keys(scopedLogical)])
  const named = [...modelIds].map(model => {
    const row = totals[model] ?? empty(model)
    const lifetime = scopedLifetime[model] ?? {}
    const physical = {
      ...row,
      input: Number.isSafeInteger(lifetime.input) ? lifetime.input : row.input,
      output: Number.isSafeInteger(lifetime.output) ? lifetime.output : row.output,
      reasoning: Number.isSafeInteger(lifetime.reasoning) ? lifetime.reasoning : row.reasoning,
      cacheRead: Number.isSafeInteger(lifetime.cacheRead) ? lifetime.cacheRead : row.cacheRead,
      calls: Number.isSafeInteger(lifetime.calls) ? lifetime.calls : row.calls,
      failed: Number.isSafeInteger(lifetime.failed) ? lifetime.failed : row.failed,
    }
    return {
      ...physical,
      turns: scopedLogical[model]?.turns ?? (logicalReady ? 0 : row.calls),
      failedTurns: scopedLogical[model]?.failed ?? (logicalReady ? 0 : row.failed),
      recoveredTurns: scopedLogical[model]?.recovered ?? 0,
      name: catalog.find(entry => entry.id === model)?.name ?? model,
      // A rate over too few measurable calls is a rounding error with a unit on it.
      tps: row.decodeMs >= MIN_DECODE_MS ? Math.round(row.decodeTokens / (row.decodeMs / 1000)) : null,
      avgTtftMs: row.ttftSamples > 0 ? Math.round(row.ttftMs / row.ttftSamples) : null,
    }
  })
  // The lifetime counters below are the whole file's, not a row's, so a scope has to recompute
  // them from the surviving rows: reading `stats.failedRequests` / `logical.turns` straight
  // would put a stripped lane's calls back into the KPI tiles the panel shows at the top.
  const scoped = allowed !== null
  const physicalFailed = named.reduce((sum, row) => sum + row.failed, 0)
  const turns = scoped
    ? named.reduce((sum, row) => sum + row.turns, 0)
    : logicalReady ? logical.turns : named.reduce((sum, row) => sum + row.turns, 0)
  const failedTurns = scoped
    ? named.reduce((sum, row) => sum + row.failedTurns, 0)
    : Number.isSafeInteger(logical.failed) ? logical.failed : named.reduce((sum, row) => sum + row.failedTurns, 0)
  const recoveredTurns = scoped
    ? named.reduce((sum, row) => sum + row.recoveredTurns, 0)
    : Number.isSafeInteger(logical.recovered) ? logical.recovered : named.reduce((sum, row) => sum + row.recoveredTurns, 0)
  const hasLifetimeFailures = scoped ? true : Number.isSafeInteger(stats.failedRequests)
  const savings = { ...emptySavings(), ...(stats.savings ?? {}) }
  return {
    requests: scoped ? named.reduce((sum, row) => sum + row.calls, 0) : stats.requests ?? 0,
    requestFailures: hasLifetimeFailures ? (scoped ? physicalFailed : stats.failedRequests) : physicalFailed,
    requestFailuresEstimated: stats.failedRequestsEstimated === true || !hasLifetimeFailures,
    logicalEstimated: scoped ? true : logical.estimated === true,
    turns,
    failedTurns,
    recoveredTurns,
    days: series,
    models: named,
    samples: (stats.samples ?? []).filter(sample => allowed === null || keep(sample?.model)).slice(-200),
    // What the token savers measured. The percentage is computed here, from the
    // same bytes the rows above counted, so the panel never has to derive a rate
    // from two numbers that were rounded separately.
    savings: { ...savings, percent: savingsPercent(savings), summary: describeSavingsTotal(savings) },
    grand: {
      input: named.reduce((sum, row) => sum + row.input, 0),
      output: named.reduce((sum, row) => sum + row.output, 0),
      reasoning: named.reduce((sum, row) => sum + row.reasoning, 0),
      calls: named.reduce((sum, row) => sum + row.calls, 0),
      failed: hasLifetimeFailures ? (scoped ? physicalFailed : stats.failedRequests) : physicalFailed,
      turns,
      failedTurns,
      recoveredTurns,
    },
  }
}
