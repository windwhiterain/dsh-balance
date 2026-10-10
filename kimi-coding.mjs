#!/usr/bin/env node
/**
 * `kimi-coding` balance: the Kimi coding plan's usage rows.
 *
 * `GET https://api.kimi.com/coding/v1/usages` (falling back to `/v1/usage` on a
 * 404) answers with one row per limit. A row may report `remaining` outright, or
 * `limit` and `used` for the reading to subtract, or a remaining percentage.
 * Percentages win when any row carries one, because they are the only unit that
 * compares across limits; otherwise the reading is the least remaining count.
 * Each row is also reported as its own window, named by its position, because a
 * row carries no label of its own.
 *
 * The endpoint is not documented — the community client
 * https://github.com/Golden0Voyager/kimi-code-usage calls it — and it needs the
 * **coding plan** key (`sk-kimi-…`), not an open-platform key, which is why a
 * `User-Agent` is sent as well.
 *
 * @module dsh-balance/kimi-coding
 */

import { pathToFileURL } from 'node:url'
import { BalanceError, emitReading, getJson, readOptions, run, windowOf } from './lib/contract.mjs'

const PROVIDER = 'kimi-coding'
const BASE_URL = 'https://api.kimi.com/coding/v1'
const ENV_NAME = 'KIMI_CODING_API_KEY'

/** The client this endpoint's reverse-engineered call is known to answer. */
const HEADERS = Object.freeze({ 'user-agent': 'KimiCLI/1.6' })

/**
 * Collect every usage row a response shape may carry.
 * @param payload - the parsed response.
 * @returns the rows.
 */
function rowsOf(payload) {
  const rows = []
  if (Array.isArray(payload?.limits)) {
    for (const limit of payload.limits) if (limit?.detail !== null && typeof limit?.detail === 'object') rows.push(limit.detail)
  }
  if (Array.isArray(payload?.data)) rows.push(...payload.data)
  return rows
}

/**
 * Read the least remaining allowance out of the usage response.
 *
 * Every row is also reported on its own, in row order, under the position that
 * names it: the rows carry no label a provider keeps stable. A percentage row is
 * out of 100; a count row is out of its own `limit`, when the row states one.
 *
 * @param payload - the parsed response.
 * @returns the reading: the least remaining percent, or the least remaining
 *   count when no row carries a percentage, plus one window per usable row.
 * @throws {BalanceError} when no row carries a usable amount.
 */
export function parse(payload) {
  const rows = rowsOf(payload)
  if (rows.length === 0) throw new BalanceError('the response carries no usage rows')
  const percentages = []
  const counts = []
  const windows = []
  rows.forEach((row, index) => {
    const name = `limit-${index + 1}`
    const percent = Number(row?.remaining_percent ?? row?.remainingPercent)
    if (Number.isFinite(percent)) {
      percentages.push(percent)
      const window = windowOf(name, percent, 100)
      if (window !== undefined) windows.push(window)
      return
    }
    const limit = Number(row?.limit)
    const used = Number(row?.used)
    const reported = Number(row?.remaining)
    const remaining = Number.isFinite(reported)
      ? reported
      : Number.isFinite(limit) && Number.isFinite(used) ? limit - used : undefined
    if (remaining === undefined) return
    counts.push(remaining)
    const window = windowOf(name, remaining, limit)
    if (window !== undefined) windows.push(window)
  })
  if (percentages.length > 0) {
    const remaining = Math.min(...percentages)
    return { remaining, windows, detail: `${rows.length} limit(s), least remaining ${remaining}%` }
  }
  if (counts.length > 0) {
    const remaining = Math.min(...counts)
    return { remaining, windows, detail: `${rows.length} limit(s), least remaining ${remaining}` }
  }
  throw new BalanceError('no usage row carries a remaining percentage, a remaining count, or limit and used')
}

/**
 * Query the usage endpoint and return the reading.
 * @param options - resolved command options, plus an injectable fetch.
 * @returns the reading.
 */
export async function readBalance({ key, baseUrl, timeoutMs, fetch: fetchImpl }) {
  try {
    const payload = await getJson(`${baseUrl}/usages`, { key, timeoutMs, headers: HEADERS, fetch: fetchImpl })
    return { reading: parse(payload), payload }
  } catch (error) {
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
