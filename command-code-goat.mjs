#!/usr/bin/env node
/**
 * `command-code-goat` balance: the Command Code GOAT plan's credit windows.
 *
 * `GET https://api.commandcode.ai/alpha/billing/credits` answers with three
 * enforced allowances, all in dollars: the monthly credit the plan grants, a
 * five-hour window, and a weekly window. The reading is what is left of the
 * **tightest** one, because that is the one that will refuse the next request —
 * with monthly credits still in hand a burst can still hit a window cap.
 *
 * Only the endpoint is documented by Command Code; the field names below follow
 * the response it answers with today (`credits.monthlyCredits`, and
 * `windowLimits.fiveHour`/`weekly` as `cap`/`used`), which is why `--raw` is
 * worth keeping: a provider that renames a field should be visible immediately
 * rather than as a silent `no reading`.
 *
 * @module dsh-balance/command-code-goat
 */

import { pathToFileURL } from 'node:url'
import { BalanceError, emitReading, getJson, readOptions, run } from './lib/contract.mjs'

const PROVIDER = 'command-code-goat'
const BASE_URL = 'https://api.commandcode.ai/alpha/billing'
const ENV_NAME = 'COMMAND_CODE_GOAT_API_KEY'

/** The rolling windows the endpoint reports, as (label, key) pairs. */
const WINDOWS = Object.freeze([
  ['five-hour', 'fiveHour'],
  ['weekly', 'weekly'],
])

/**
 * Round one dollar amount to cents, for a note a person reads.
 * @param value - the amount.
 * @returns the amount rounded to two decimals.
 */
function cents(value) {
  return Math.round(value * 100) / 100
}

/**
 * Read the least remaining allowance out of the credits response.
 * @param payload - the parsed response.
 * @returns the reading: dollars left of the tightest allowance, the instant that
 *   allowance resets, and a note naming each one.
 * @throws {BalanceError} when no allowance carries a usable amount.
 */
export function parse(payload) {
  const credits = payload?.credits
  const windows = payload?.windowLimits
  if (credits === null || typeof credits !== 'object' || windows === null || typeof windows !== 'object') {
    throw new BalanceError('the response carries no credits and windowLimits objects')
  }
  const limits = []
  const monthly = Number(credits.monthlyCredits)
  if (Number.isFinite(monthly)) limits.push({ name: 'monthly', left: Math.max(0, monthly) })
  for (const [label, key] of WINDOWS) {
    const window = windows[key]
    if (window === null || typeof window !== 'object') continue
    const cap = Number(window.cap)
    const used = Number(window.used)
    if (!Number.isFinite(cap) || !Number.isFinite(used)) continue
    const resetAt = Number(window.resetAt)
    limits.push({
      name: label,
      left: Math.max(0, cap - used),
      ...Number.isFinite(resetAt) && resetAt > 0 ? { resetAt } : {},
      exceeded: window.exceeded === true,
    })
  }
  if (limits.length === 0) throw new BalanceError('no credit or window allowance carries a usable amount')
  const tightest = limits.reduce((left, right) => (right.left < left.left ? right : left))
  const exhausted = limits.find(limit => limit.exceeded === true)
  const flagged = windows.exceeded !== null && windows.exceeded !== undefined
  return {
    remaining: exhausted === undefined && !flagged ? tightest.left : 0,
    ...tightest.resetAt === undefined ? {} : { resetsAt: new Date(tightest.resetAt).toISOString() },
    ...exhausted !== undefined
      ? { error: `the ${exhausted.name} window is exhausted` }
      : flagged
        ? { error: `the provider reports an exceeded window limit (${JSON.stringify(windows.exceeded)})` }
        : credits.belowThreshold === true
          ? { error: 'the account is below its credit threshold' }
          : {},
    detail: limits.map(limit => `${limit.name} ${cents(limit.left)} left`).join(', '),
  }
}

/**
 * Query the credits endpoint and return the reading.
 * @param options - resolved command options, plus an injectable fetch.
 * @returns the reading.
 */
export async function readBalance({ key, baseUrl, timeoutMs, fetch: fetchImpl }) {
  const payload = await getJson(`${baseUrl}/credits`, { key, timeoutMs, fetch: fetchImpl })
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
