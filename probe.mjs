#!/usr/bin/env node
/**
 * Offline probe for the balance scripts: drives each provider's response parser
 * over the payload shapes their endpoints are known to answer with, and checks
 * the reading `dsh-llm-quota-retry` would decide on.
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
import { parse as parseDeepSeek, readBalance as readDeepSeek } from './deepseek.mjs'
import { parse as parseOpenCode, readBalance as readOpenCode } from './opencode-go.mjs'
import { parse as parseKimi, readBalance as readKimi } from './kimi-coding.mjs'
import { parse as parseMiniMax, readBalance as readMiniMax } from './minimax.mjs'

const checks = []
/** Register one probe check. */
function check(name, body) {
  checks.push([name, body])
}

/** A response shape's `assert.throws` message matcher, for the failure cases. */
const throws = /./

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

  const limited = parseOpenCode({
    usage: { rolling: { status: 'rate-limited', percent: 3, resetsAt: '2026-10-01T00:00:00Z' } },
  })
  assert.equal(limited.remaining, 0, 'a stale low percentage cannot outrank the provider\'s refusal')
  assert.match(limited.error, /rolling window is rate limited/)

  assert.throws(() => parseOpenCode({}), throws)
  assert.throws(() => parseOpenCode({ usage: { rolling: { status: 'ok' } } }), throws)
})

check('kimi-coding: percentages outrank counts, and limit/used is subtracted', () => {
  const counts = parseKimi({ limits: [{ detail: { limit: 100, used: 30, remaining: 70 } }, { detail: { limit: 50, used: 20 } }] })
  assert.equal(counts.remaining, 30, 'the least remaining of the two rows')
  assert.match(counts.detail, /least remaining 30/)

  const percents = parseKimi({ data: [{ remaining_percent: 12.5 }, { limit: 10, used: 1 }] })
  assert.equal(percents.remaining, 12.5, 'a percentage is the only unit that compares across limits')
  assert.match(percents.detail, /12\.5%/)

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

  const narrowed = parseMiniMax({
    base_resp: { status_code: 0 },
    model_remains: [
      { model_name: 'MiniMax-M3.1-Flash-Preview', current_interval_remaining_percent: 90 },
      { model_name: 'MiniMax-M2.7', current_interval_remaining_percent: 20, remains_time: 1000 },
    ],
  }, { model: 'm2.7' })
  assert.equal(narrowed.remaining, 20)

  assert.throws(() => parseMiniMax({ base_resp: { status_code: 0 }, model_remains: [] }), throws)
  assert.throws(() => parseMiniMax({ base_resp: { status_code: 0 }, model_remains: [{ model_name: 'hailuo-video-01', current_interval_remaining_percent: 5 }] }), /no language-model quota/)
  assert.throws(
    () => parseMiniMax({ base_resp: { status_code: 1004, status_msg: 'invalid api key' }, model_remains: [] }),
    /Token Plan subscription key/,
  )
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
