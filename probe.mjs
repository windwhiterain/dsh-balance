#!/usr/bin/env node
/**
 * Offline probe for the balance scripts: drives each provider's response parser
 * over the payload shapes their endpoints are known to answer with, and checks
 * the reading `dsh-llm-quota-retry` would decide on, down to the usage windows
 * it reports alongside the one number.
 *
 *   node probe.mjs          # parsers only: no network, no credentials
 *   node probe.mjs --live   # also query every provider whose credential is set
 *
 * `--live` calls each script's own `readBalance` in-process — no child process,
 * no pipes — and prints the reading or the provider's refusal, never the
 * credential.
 *
 * @module dsh-balance/probe
 */

import assert from 'node:assert/strict'
import { windowOf } from './lib/contract.mjs'
import { parse as parseDeepSeek, readBalance as readDeepSeek } from './deepseek.mjs'
import { parse as parseOpenCode, readBalance as readOpenCode } from './opencode-go.mjs'
import { parse as parseKimi, readBalance as readKimi } from './kimi-coding.mjs'
import { parse as parseMiniMax, readBalance as readMiniMax } from './minimax.mjs'
import { parse as parseGoat, readBalance as readGoat } from './command-code-goat.mjs'

const checks = []
/** Register one probe check. */
function check(name, body) {
  checks.push([name, body])
}

/** A response shape's `assert.throws` message matcher, for the failure cases. */
const throws = /./

check('contract: a window needs a stable name and a finite amount', () => {
  assert.deepEqual(windowOf('weekly', 2.94, 35), { name: 'weekly', remaining: 2.94, capacity: 35 })
  assert.deepEqual(windowOf('wallet', 12), { name: 'wallet', remaining: 12 }, 'a provider stating no capacity leaves the window unscored')
  assert.deepEqual(windowOf('wallet', 12, 0), { name: 'wallet', remaining: 12 }, 'a non-positive capacity is not a capacity')
  assert.deepEqual(windowOf('wallet', 12, Number.NaN), { name: 'wallet', remaining: 12 })

  assert.equal(windowOf('', 1), undefined, 'an empty name is not a window name')
  assert.equal(windowOf(undefined, 1), undefined)
  assert.equal(windowOf('weekly', Number.NaN), undefined)
  assert.equal(windowOf('weekly', Number.POSITIVE_INFINITY), undefined)
})

check('deepseek: the CNY wallet is the reading, and an unavailable account says so', () => {
  const payload = {
    is_available: true,
    balance_infos: [
      { currency: 'USD', total_balance: '6.78', granted_balance: '0.00', topped_up_balance: '6.78' },
      { currency: 'CNY', total_balance: '123.45', granted_balance: '10.00', topped_up_balance: '113.45' },
    ],
  }
  assert.equal(parseDeepSeek(payload).remaining, 123.45)
  assert.match(parseDeepSeek(payload).detail, /CNY/)
  assert.equal(parseDeepSeek({ is_available: true, balance_infos: [{ currency: 'EUR', total_balance: '1' }] }).remaining, 1)
  assert.equal('windows' in parseDeepSeek(payload), false, 'a prepaid wallet has no usage window to report')

  const unavailable = parseDeepSeek({ is_available: false, balance_infos: [{ currency: 'CNY', total_balance: '0.00' }] })
  assert.equal(unavailable.remaining, 0)
  assert.match(unavailable.error, /unavailable/)

  assert.throws(() => parseDeepSeek({ balance_infos: [] }), throws)
  assert.throws(() => parseDeepSeek({ balance_infos: [{ currency: 'CNY', total_balance: 'not a number' }] }), throws)
})

check('opencode-go: percent used becomes percent left, and rate limiting wins', () => {
  const payload = {
    usage: {
      rolling: { status: 'ok', percent: 12, resetsAt: '2026-10-01T00:00:00Z' },
      weekly: { status: 'ok', percent: 87.5, resetsAt: '2026-10-05T00:00:00Z' },
      monthly: { status: 'ok', percent: 40, resetsAt: '2026-11-01T00:00:00Z' },
    },
  }
  const reading = parseOpenCode(payload)
  assert.equal(reading.remaining, 12.5)
  assert.equal(reading.resetsAt, '2026-10-05T00:00:00Z', 'the reset of the window the reading comes from')
  assert.equal(reading.error, undefined)
  assert.match(reading.detail, /rolling 12% used/)
  assert.deepEqual(reading.windows, [
    { name: 'rolling', remaining: 88, capacity: 100 },
    { name: 'weekly', remaining: 12.5, capacity: 100 },
    { name: 'monthly', remaining: 60, capacity: 100 },
  ], 'every window is reported as percent left out of the full 100')

  const limited = parseOpenCode({
    usage: { rolling: { status: 'rate-limited', percent: 3, resetsAt: '2026-10-01T00:00:00Z' } },
  })
  assert.equal(limited.remaining, 0, 'a stale low percentage cannot outrank the provider\'s refusal')
  assert.match(limited.error, /rolling window is rate limited/)
  assert.deepEqual(limited.windows, [{ name: 'rolling', remaining: 0, capacity: 100 }], 'a rate-limited window reads zero')

  assert.throws(() => parseOpenCode({}), throws)
  assert.throws(() => parseOpenCode({ usage: { rolling: { status: 'ok' } } }), throws)
})

check('kimi-coding: percentages outrank counts, and limit/used is subtracted', () => {
  const counts = parseKimi({ limits: [{ detail: { limit: 100, used: 30, remaining: 70 } }, { detail: { limit: 50, used: 20 } }] })
  assert.equal(counts.remaining, 30, 'the least remaining of the two rows')
  assert.match(counts.detail, /least remaining 30/)
  assert.deepEqual(counts.windows, [
    { name: 'limit-1', remaining: 70, capacity: 100 },
    { name: 'limit-2', remaining: 30, capacity: 50 },
  ], 'each row names its own window, and a count row carries its limit as the capacity')

  const percents = parseKimi({ data: [{ remaining_percent: 12.5 }, { limit: 10, used: 1 }] })
  assert.equal(percents.remaining, 12.5, 'a percentage is the only unit that compares across limits')
  assert.match(percents.detail, /12\.5%/)
  assert.deepEqual(percents.windows, [
    { name: 'limit-1', remaining: 12.5, capacity: 100 },
    { name: 'limit-2', remaining: 9, capacity: 10 },
  ], 'a percentage row is out of 100 even when the row states a limit')

  const bare = parseKimi({ data: [{ remaining: 7 }] })
  assert.deepEqual(bare.windows, [{ name: 'limit-1', remaining: 7 }], 'a row stating no limit leaves its window unscored')

  assert.throws(() => parseKimi({ limits: [] }), throws)
  assert.throws(() => parseKimi({ limits: [{ detail: {} }] }), throws)
})

check('minimax: the language resources decide, per window, with a reset estimate', () => {
  const before = Date.now()
  const payload = {
    base_resp: { status_code: 0, status_msg: 'success' },
    model_remains: [
      {
        model_name: 'MiniMax-M3.1-Flash-Preview',
        current_interval_total_count: 1000,
        current_interval_remaining_percent: 64.5,
        remains_time: 3_600_000,
        current_weekly_total_count: 10_000,
        current_weekly_remaining_percent: 81,
        weekly_remains_time: 86_400_000,
      },
      { model_name: 'hailuo-video-01', current_interval_total_count: 10, current_interval_remaining_percent: 0, remains_time: 60_000 },
    ],
  }
  const reading = parseMiniMax(payload)
  assert.equal(reading.remaining, 64.5, 'the video resource is not what a model request spends')
  assert.ok(Date.parse(reading.resetsAt) >= before + 3_500_000, 'the reset estimate is the deciding window\'s countdown in the future')
  assert.match(reading.detail, /MiniMax-M3\.1-Flash-Preview current 64\.5%/)
  assert.deepEqual(reading.windows, [
    { name: 'current', remaining: 64.5, capacity: 100 },
    { name: 'weekly', remaining: 81, capacity: 100 },
  ], 'one window per selected resource window, under that window\'s own label')

  const twoModels = {
    base_resp: { status_code: 0 },
    model_remains: [
      { model_name: 'MiniMax-M3.1-Flash-Preview', current_interval_remaining_percent: 90 },
      { model_name: 'MiniMax-M2.7', current_interval_remaining_percent: 20, remains_time: 1000 },
    ],
  }
  const narrowed = parseMiniMax(twoModels, { model: 'm2.7' })
  assert.equal(narrowed.remaining, 20)
  assert.deepEqual(parseMiniMax(twoModels, { model: 'minimax' }).windows, [
    { name: 'current', remaining: 90, capacity: 100 },
    { name: 'current', remaining: 20, capacity: 100 },
  ], 'two resources report two windows, and a repeated label is still a distinct window')

  assert.throws(() => parseMiniMax({ base_resp: { status_code: 0 }, model_remains: [] }), throws)
  assert.throws(() => parseMiniMax({ base_resp: { status_code: 0 }, model_remains: [{ model_name: 'hailuo-video-01', current_interval_remaining_percent: 5 }] }), /no language-model quota/)
  assert.throws(
    () => parseMiniMax({ base_resp: { status_code: 1004, status_msg: 'invalid api key' }, model_remains: [] }),
    /Token Plan subscription key/,
  )
})

check('command-code-goat: the tightest allowance decides, and an exceeded window reads zero', () => {
  // The shape this endpoint answered with in this deployment, verbatim.
  const payload = {
    credits: { belowThreshold: false, creditThreshold: 0, monthlyCredits: 37.941019347, purchasedCredits: 0, freeCredits: 0 },
    windowLimits: {
      limited: true,
      exceeded: null,
      fiveHour: { used: 0, cap: 14, exceeded: false, resetAt: 0 },
      weekly: { used: 32.058980653, cap: 35, exceeded: false, resetAt: 1_791_025_644_936 },
    },
    sandboxAccess: false,
    sandboxMinutes: null,
  }
  const reading = parseGoat(payload)
  assert.equal(Math.round(reading.remaining * 100) / 100, 2.94, 'the weekly window is the tightest')
  assert.equal(reading.resetsAt, new Date(1_791_025_644_936).toISOString())
  assert.equal(reading.error, undefined)
  assert.match(reading.detail, /monthly 37\.94 left, five-hour 14 left, weekly 2\.94 left/)
  assert.deepEqual(reading.windows, [
    { name: 'monthly', remaining: 37.941019347 },
    { name: 'five-hour', remaining: 14, capacity: 14 },
    { name: 'weekly', remaining: 35 - 32.058980653, capacity: 35 },
  ], 'the endpoint states a cap for the five-hour and weekly windows only, so the monthly credit is unscored')

  const exhausted = parseGoat({
    ...payload,
    windowLimits: { ...payload.windowLimits, fiveHour: { used: 14, cap: 14, exceeded: true, resetAt: 1_791_000_000_000 } },
  })
  assert.equal(exhausted.remaining, 0)
  assert.match(exhausted.error, /five-hour window is exhausted/)
  assert.equal(exhausted.resetsAt, new Date(1_791_000_000_000).toISOString(), 'the exhausted window names the reset')
  assert.deepEqual(exhausted.windows[1], { name: 'five-hour', remaining: 0, capacity: 14 }, 'the window still reports its own truth')

  const flagged = parseGoat({ credits: { monthlyCredits: 5 }, windowLimits: { exceeded: { weekly: true } } })
  assert.equal(flagged.remaining, 0)
  assert.match(flagged.error, /exceeded window limit/)

  const low = parseGoat({ credits: { monthlyCredits: 3, belowThreshold: true }, windowLimits: {} })
  assert.equal(low.remaining, 3)
  assert.match(low.error, /below its credit threshold/)
  assert.deepEqual(low.windows, [{ name: 'monthly', remaining: 3 }], 'a response with no window limits reports the credit alone')

  assert.throws(() => parseGoat({}), throws)
  assert.throws(() => parseGoat({ credits: { monthlyCredits: 'none' }, windowLimits: {} }), throws)
})

let failed = 0
for (const [name, body] of checks) {
  try {
    await body()
    process.stdout.write(`ok   ${name}\n`)
  } catch (error) {
    failed += 1
    process.stdout.write(`FAIL ${name}\n     ${error?.message?.split('\n').join('\n     ')}\n`)
  }
}

/** provider id, module entry, credential variable, and base URL override per script. */
const PROVIDERS = [
  ['deepseek-official', readDeepSeek, 'DEEPSEEK_API_KEY', 'https://api.deepseek.com'],
  ['opencode-go', readOpenCode, 'OPENCODE_API_KEY', 'https://opencode.ai/zen/go/v1'],
  ['kimi-coding', readKimi, 'KIMI_CODING_API_KEY', 'https://api.kimi.com/coding/v1'],
  ['minimax-cn', readMiniMax, 'MINIMAX_CN_API_KEY', 'https://www.minimax.cn'],
  ['command-code-goat', readGoat, 'COMMAND_CODE_GOAT_API_KEY', 'https://api.commandcode.ai/alpha/billing'],
]

if (process.argv.includes('--live')) {
  process.stdout.write('\nlive reads (credentials come from this process\'s environment)\n')
  for (const [provider, readBalance, envName, baseUrl] of PROVIDERS) {
    const key = process.env[envName] ?? ''
    if (key === '') {
      process.stdout.write(`skip ${provider}: ${envName} is not set\n`)
      continue
    }
    try {
      const { reading } = await readBalance({ key, baseUrl, timeoutMs: 10_000 })
      process.stdout.write(`ok   ${provider}: ${JSON.stringify(reading)}\n`)
    } catch (error) {
      failed += 1
      process.stdout.write(`FAIL ${provider}: ${error?.message ?? error}\n`)
    }
  }
}

process.stdout.write(`\n${checks.length - failed}/${checks.length} parser checks passed\n`)
process.exitCode = failed === 0 ? 0 : 1
