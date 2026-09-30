#!/usr/bin/env node
/**
 * `opencode-go` balance: the OpenCode Go plan's rolling usage windows.
 *
 * `GET https://opencode.ai/zen/go/v1/usage` answers with `rolling`, `weekly`, and
 * `monthly` windows, each carrying **percent used** (the console's own
 * "used percentage") plus a reset instant. The reading is what is left of the
 * window that is furthest spent: `100 - max(percent used)`, so a route is
 * skipped exactly when the provider would refuse it.
 *
 * The endpoint is not documented by OpenCode — it is the call the installed
 * `dsh-opencode-go` plugin itself makes — so `--base-url` is the escape hatch if
 * an account is served elsewhere.
 *
 * @module dsh-balance/opencode-go
 */

import { pathToFileURL } from 'node:url'
import { BalanceError, emitReading, getJson, readOptions, run } from './lib/contract.mjs'

const PROVIDER = 'opencode-go'
const BASE_URL = 'https://opencode.ai/zen/go/v1'
const ENV_NAME = 'OPENCODE_API_KEY'

/** The usage windows the endpoint reports, most binding first for a human reading it. */
const WINDOWS = Object.freeze(['rolling', 'weekly', 'monthly'])

/**
 * Read the least remaining allowance out of the usage response.
 *
 * A window the provider itself marks `rate-limited` decides alone: its percent
 * may lag the refusal, and the provider does not serve a request just because a
 * stale percentage looks low. Otherwise the reading is what is left of the
 * furthest-spent window.
 *
 * @param payload - the parsed response.
 * @returns the reading: percent left, the instant the deciding window resets, and
 *   a note naming every window.
 * @throws {BalanceError} when no window carries a numeric percent.
 */
export function parse(payload) {
  const usage = payload?.usage
  if (usage === null || typeof usage !== 'object') throw new BalanceError('the response carries no usage object')
  const windows = WINDOWS.flatMap((name) => {
    const window = usage[name]
    if (window === null || typeof window !== 'object') return []
    const percent = Number(window.percent)
    if (!Number.isFinite(percent)) return []
    return [{ name, percent, status: window.status, resetsAt: window.resetsAt }]
  })
  if (windows.length === 0) throw new BalanceError('no usage window carries a numeric percent')
  const detail = windows.map(window => `${window.name} ${window.percent}% used`).join(', ')
  const limited = windows.find(window => window.status === 'rate-limited')
  if (limited !== undefined) {
    return {
      remaining: 0,
      ...typeof limited.resetsAt === 'string' && limited.resetsAt !== '' ? { resetsAt: limited.resetsAt } : {},
      error: `the ${limited.name} window is rate limited`,
      detail,
    }
  }
  const worst = windows.reduce((left, right) => (right.percent > left.percent ? right : left))
  return {
    remaining: Math.max(0, 100 - worst.percent),
    ...typeof worst.resetsAt === 'string' && worst.resetsAt !== '' ? { resetsAt: worst.resetsAt } : {},
    detail,
  }
}

/**
 * Query the usage endpoint and return the reading.
 * @param options - resolved command options, plus an injectable fetch.
 * @returns the reading.
 */
export async function readBalance({ key, baseUrl, timeoutMs, fetch: fetchImpl }) {
  const payload = await getJson(`${baseUrl}/usage`, { key, timeoutMs, fetch: fetchImpl })
  return { reading: parse(payload), payload }
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
