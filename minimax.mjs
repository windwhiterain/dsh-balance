#!/usr/bin/env node
/**
 * `minimax-cn` balance: the China-region Token Plan's per-resource quota.
 *
 * `GET https://www.minimax.cn/v1/token_plan/remains` answers with one entry per
 * quota resource (`model_remains[]`), each carrying a current-interval and a
 * weekly window whose `*_remaining_percent` is the literal percentage left. Only
 * the endpoint is documented by MiniMax; the response fields follow the
 * community client, and this file's field handling is a port of
 * `minimax_quota.py`, which recorded the same knowledge for a console report.
 *
 * A route pool needs *one* number, so this reads the language-model resources
 * (`minimax-m*`, `general`) — the ones a model request actually spends — and
 * takes the smaller of its two windows. `--model <name>` narrows that to one
 * model's own resource instead, which is what a provider whose quota is
 * per-model wants when a pool holds more than one of them. Every selected window
 * is also reported on its own, under that window's label.
 *
 * @module dsh-balance/minimax
 */

import { pathToFileURL } from 'node:url'
import { BalanceError, emitReading, getJson, readOptions, run, windowOf } from './lib/contract.mjs'

const PROVIDER = 'minimax-cn'
const BASE_URL = 'https://www.minimax.cn'
const ENV_NAME = 'MINIMAX_CN_API_KEY'

/** Another name this deployment's console tooling already publishes the key under. */
const FALLBACK_ENV_NAME = 'MINIMAX_TOKEN_PLAN_KEY'

/** Status codes that mean "this is not a Token Plan subscription key". */
const AUTH_STATUS_CODES = Object.freeze([1004, 2049])

/** `model_name` keywords that mark the resources a model request spends. */
const LANGUAGE_KEYWORDS = Object.freeze(['minimax-m', 'general'])

/** (label, total key, remaining-percent key, remaining-time key) per window. */
const WINDOWS = Object.freeze([
  ['current', 'current_interval_total_count', 'current_interval_remaining_percent', 'remains_time'],
  ['weekly', 'current_weekly_total_count', 'current_weekly_remaining_percent', 'weekly_remains_time'],
])

/**
 * Whether one resource is a language-model resource.
 * @param modelName - the entry's `model_name`.
 * @returns whether a model request spends it.
 */
function isLanguage(modelName) {
  const lowered = String(modelName).toLowerCase()
  return LANGUAGE_KEYWORDS.some(keyword => lowered.includes(keyword))
}

/**
 * One entry's windows, as measurements.
 * @param entry - one `model_remains[]` entry.
 * @returns the windows that carry a percentage, each with its reset estimate.
 */
function reportedWindowsOf(entry) {
  return WINDOWS.flatMap(([label, totalKey, percentKey, remainsKey]) => {
    const percent = Number(entry?.[percentKey])
    if (!Number.isFinite(percent)) return []
    const remains = Number(entry?.[remainsKey])
    return [{
      label,
      percent,
      total: entry?.[totalKey],
      // Only the endpoint's own millisecond countdown is trusted for a reset
      // instant; a window with no countdown simply reports none.
      resetsAt: Number.isFinite(remains) && remains >= 0 ? new Date(Date.now() + remains).toISOString() : undefined,
    }]
  })
}

/**
 * Read the least remaining quota out of the Token Plan response.
 * @param payload - the parsed response.
 * @param options - `model` narrows the resources to one model name.
 * @returns the reading: the smaller remaining percentage of the selected
 *   resources' windows, the reset instant of that window, and a note naming what
 *   was measured.
 * @throws {BalanceError} when the endpoint refused, or no selected resource
 *   carries a percentage.
 */
export function parse(payload, { model } = {}) {
  const status = Number(payload?.base_resp?.status_code ?? 0)
  if (status !== 0) {
    const hint = AUTH_STATUS_CODES.includes(status)
      ? '; check that this is the China-region Token Plan subscription key, not a pay-as-you-go API key'
      : ''
    throw new BalanceError(`Token Plan endpoint error ${status}: ${payload?.base_resp?.status_msg ?? 'unknown'}${hint}`)
  }
  const entries = Array.isArray(payload?.model_remains) ? payload.model_remains : []
  if (entries.length === 0) throw new BalanceError('the response carries no model_remains')
  const selected = model === undefined
    ? entries.filter(entry => isLanguage(entry?.model_name))
    : entries.filter(entry => String(entry?.model_name ?? '').toLowerCase().includes(model.toLowerCase()))
  if (selected.length === 0) {
    throw new BalanceError(model === undefined
      ? 'no language-model quota resource is reported'
      : `no quota resource matches model "${model}"`)
  }
  const reported = selected.flatMap((entry) => {
    const windows = reportedWindowsOf(entry)
    return windows.map(window => ({ ...window, model: String(entry.model_name ?? '') }))
  })
  if (reported.length === 0) throw new BalanceError('the selected resources carry no remaining-percent window')
  const worst = reported.reduce((left, right) => (right.percent < left.percent ? right : left))
  const windows = reported.flatMap((window) => {
    const entry = windowOf(window.label, Math.max(0, window.percent), 100)
    return entry === undefined ? [] : [entry]
  })
  return {
    remaining: Math.max(0, worst.percent),
    windows,
    ...worst.resetsAt === undefined ? {} : { resetsAt: worst.resetsAt },
    detail: reported.map(window => `${window.model} ${window.label} ${window.percent}%`).join(', '),
  }
}

/**
 * Query the Token Plan endpoint and return the reading.
 * @param options - resolved command options, plus an injectable fetch.
 * @returns the reading.
 */
export async function readBalance({ key, baseUrl, timeoutMs, model, fetch: fetchImpl }) {
  const payload = await getJson(`${baseUrl}/v1/token_plan/remains`, { key, timeoutMs, fetch: fetchImpl })
  return { reading: parse(payload, { model }), payload }
}

async function main() {
  const options = readOptions({
    argv: process.argv.slice(2),
    env: process.env,
    envName: ENV_NAME,
    fallbackEnvName: FALLBACK_ENV_NAME,
    baseUrl: BASE_URL,
    model: true,
    provider: PROVIDER,
  })
  if (options === undefined) return
  const { reading, payload } = await readBalance(options)
  emitReading(reading, { raw: options.raw, payload })
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await run(main)
