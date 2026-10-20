#!/usr/bin/env node
/**
 * `kimi-coding` balance: the Kimi coding plan's usage rows.
 *
 * `GET https://api.kimi.com/coding/v1/usages` (falling back to `/v1/usage` on a
 * 404) answers with exactly four top-level keys — `booster_wallet`, `limits`,
 * `usage`, and `usages` — and no others. `limits` carries one entry per rate-limit
 * window with the window's own `window.duration`/`window.timeUnit` beside the
 * amounts; `usage` is the current window's summary; `usages` carries the 5-hour
 * and 7-day shares already spent as `used_ratio` in 0–1. Every one of those is an
 * allowance that can refuse a request, so a reading that leaves any of them out
 * reports more headroom than the account has. A window one source already
 * reported is not reported again, which is what keeps the two overlapping sources
 * from counting the same window twice.
 *
 * A row may report `remaining` outright, or `limit` and `used` for the reading to
 * subtract, or a remaining percentage. Percentages win when any row carries one,
 * because they are the only unit that compares across limits; otherwise the
 * reading is the least remaining count. Each row is also reported as its own
 * window, named by the length it states where it states one and by its position
 * where it does not.
 *
 * `booster_wallet` reports the extra-usage wallet's monthly spend in CNY, a
 * different unit from the percentages above; mixing the two in one reading would
 * make its least-value meaningless, so it is left out rather than converted.
 *
 * The endpoint is not documented — the community client
 * https://github.com/Golden0Voyager/kimi-code-usage calls it, and its
 * `docs/superpowers/plans/2026-10-19-kimi-usages-payload-shape.md` records the
 * measured shape — and it needs the **coding plan** key (`sk-kimi-…`), not an
 * open-platform key, which is why a `User-Agent` is sent as well.
 *
 * @module dsh-balance/kimi-coding
 */

import { pathToFileURL } from 'node:url'
import { BalanceError, emitReading, getJson, readOptions, refusedReading, run, windowOf } from './lib/contract.mjs'

const PROVIDER = 'kimi-coding'
const BASE_URL = 'https://api.kimi.com/coding/v1'
const ENV_NAME = 'KIMI_CODING_API_KEY'

/** The client this endpoint's reverse-engineered call is known to answer. */
const HEADERS = Object.freeze({ 'user-agent': 'KimiCLI/1.6' })

/** The rate-limit window each length of minutes names, so one window is not reported twice. */
const WINDOW_NAMES = new Map([[300, 'five-hour'], [10_080, 'weekly']])

/**
 * The length of one rate-limit window in minutes.
 *
 * @param window - the window the payload states beside the amounts.
 * @returns the minutes, or undefined when the payload states no window.
 */
function minutesOf(window) {
  const duration = Number(window?.duration)
  if (!Number.isFinite(duration)) return undefined
  const unit = String(window?.timeUnit ?? '')
  if (unit.includes('MINUTE')) return duration
  if (unit.includes('HOUR')) return duration * 60
  if (unit.includes('DAY')) return duration * 1440
  if (unit.includes('MONTH')) return duration * 43200
  return duration / 60
}

/**
 * Collect every usage row a response shape may carry, each with the length of its
 * window when the payload states one.
 *
 * `limits` is the shape the endpoint answers with today; `data` is the older
 * array form. The window sits beside the amounts rather than inside them, so it
 * is carried along here — a window is recognized by its length, which is what lets
 * one already reported from `limits` be left alone when `usages` names it again.
 *
 * @param payload - the parsed response.
 * @returns the rows, each `{ detail, minutes }`.
 */
function rowsOf(payload) {
  const rows = []
  if (Array.isArray(payload?.limits)) {
    for (const limit of payload.limits) {
      if (limit?.detail !== null && typeof limit?.detail === 'object') {
        rows.push({ detail: limit.detail, minutes: minutesOf(limit.window) })
      }
    }
  }
  if (Array.isArray(payload?.data)) for (const row of payload.data) rows.push({ detail: row, minutes: undefined })
  return rows
}

/**
 * Read the least remaining allowance out of the usage response.
 *
 * Every window is also reported on its own: one the payload names by its length is
 * reported under that name, one it does not under the position that reached it,
 * because a row otherwise carries no label a provider keeps stable. A percentage
 * row is out of 100; a count row is out of its own `limit`, when the row states
 * one.
 *
 * @param payload - the parsed response.
 * @returns the reading: the least remaining percent, or the least remaining
 *   count when no row carries a percentage, plus one window per usable row.
 * @throws {BalanceError} when no row carries a usable amount.
 */
export function parse(payload) {
  const percentages = []
  const counts = []
  const windows = []
  const reported = new Set()
  let considered = 0

  /**
   * Take one row's amounts as a window of the reading.
   * @param row - the row's amounts.
   * @param name - the window's name.
   * @returns whether the row carried a usable amount.
   */
  function take(row, name) {
    const percent = Number(row?.remaining_percent ?? row?.remainingPercent)
    if (Number.isFinite(percent)) {
      percentages.push(percent)
      const window = windowOf(name, percent, 100)
      if (window !== undefined) windows.push(window)
      return true
    }
    const limit = Number(row?.limit)
    const used = Number(row?.used)
    const stated = Number(row?.remaining)
    const remaining = Number.isFinite(stated)
      ? stated
      : Number.isFinite(limit) && Number.isFinite(used) ? limit - used : undefined
    if (remaining === undefined) return false
    counts.push(remaining)
    const window = windowOf(name, remaining, limit)
    if (window !== undefined) windows.push(window)
    return true
  }

  for (const row of rowsOf(payload)) {
    const name = row.minutes === undefined ? undefined : WINDOW_NAMES.get(row.minutes)
    if (name !== undefined) reported.add(name)
    considered += 1
    take(row.detail, name ?? `limit-${considered}`)
  }

  // `usage` is the current window's own summary and `usages` states the 5-hour
  // and 7-day shares already spent. The endpoint answers with both, so a window
  // one of them already reported is left alone rather than counted twice.
  if (payload?.usage !== null && typeof payload?.usage === 'object' && !reported.has('weekly')) {
    considered += 1
    if (take(payload.usage, 'weekly')) reported.add('weekly')
  }
  const usages = payload?.usages !== null && typeof payload?.usages === 'object' ? payload.usages : undefined
  for (const [name, key] of [['five-hour', 'limit_5h'], ['weekly', 'limit_7d']]) {
    if (usages === undefined || reported.has(name)) continue
    const ratio = Number(usages[key]?.used_ratio)
    if (!Number.isFinite(ratio)) continue
    // The share is already spent, so what is left is its complement; a share past
    // the whole window clamps rather than reporting more than full, and a share of
    // the period is not more precise than a hundredth of a percent.
    const remaining = Math.round(Math.min(100, Math.max(0, ratio * 100)) * 100) / 100
    considered += 1
    reported.add(name)
    percentages.push(remaining)
    const window = windowOf(name, remaining, 100)
    if (window !== undefined) windows.push(window)
  }

  if (percentages.length > 0) {
    const remaining = Math.min(...percentages)
    return { remaining, windows, detail: `${considered} limit(s), least remaining ${remaining}%` }
  }
  if (counts.length > 0) {
    const remaining = Math.min(...counts)
    return { remaining, windows, detail: `${considered} limit(s), least remaining ${remaining}` }
  }
  throw new BalanceError('no usage row carries a remaining percentage, a remaining count, or limit and used')
}

/**
 * Query the usage endpoint and return the reading.
 *
 * A refused credential is the shared contract's answer; the 404 that sends this
 * script to the older endpoint is the only shape here that is not.
 *
 * @param options - resolved command options, plus an injectable fetch.
 * @returns the reading.
 */
export async function readBalance({ key, baseUrl, timeoutMs, fetch: fetchImpl }) {
  try {
    const payload = await getJson(`${baseUrl}/usages`, { key, timeoutMs, headers: HEADERS, fetch: fetchImpl })
    return { reading: parse(payload), payload }
  } catch (error) {
    const refused = refusedReading(error)
    if (refused !== undefined) return { reading: refused }
    if (!(error instanceof BalanceError) || !/HTTP 404/.test(error.message)) throw error
    const payload = await getJson(`${baseUrl}/usage`, { key, timeoutMs, headers: HEADERS, fetch: fetchImpl })
    return { reading: parse(payload), payload }
  }
}

async function main() {
  const options = readOptions({
    argv: process.argv.slice(2),
    env: process.env,
    envName: ENV_NAME,
    baseUrl: BASE_URL,
    provider: PROVIDER,
  })
  if (options === undefined) return
  const { reading, payload } = await readBalance(options)
  emitReading(reading, { raw: options.raw, payload })
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await run(main)
