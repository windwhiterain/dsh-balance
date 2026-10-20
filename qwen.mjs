#!/usr/bin/env node
/**
 * `qwen` balance: the Qwen Token Plan's monthly Credits.
 *
 * The plan has no key-based balance endpoint, and its own FAQ says so the only
 * way round it is the console. This script reads the same data gateway the
 * subscription page reads:
 *
 *   1. `GET {console}/tool/user/info.json`      → `data.secToken`, the CSRF token
 *   2. `POST {gateway}?action=BroadScopeAspnGateway` with `api=<inner>` for
 *      `…/tokenplan/personal/api/v2/usage`      → the current period's used ratio
 *      `…/tokenplan/personal/api/v2/quota-config` → each tier's Credit totals
 *      `…/tokenplan/personal/api/v2/subscription` → the subscribed tier
 *
 * The credential is therefore a **console session cookie**, not an API key: open
 * the subscription page, copy the whole `Cookie:` header of any request, and
 * store it under `QWEN_CONSOLE_COOKIE` (or pass it as `--key`). The gateway
 * rejects a custom `User-Agent` with `PostonlyOrTokenError`, so the request is
 * sent with the browser's.
 *
 * The reading is the **percentage left** of the period the account meters, which
 * is the unit a route pool compares against a percentage plan: the console
 * reports the ratio used (`per1MonthPercentage` since the 2026-09 billing change,
 * `per1WeekPercentage` for a subscription that still meters weekly), and this
 * script converts it. Credits are reported in `detail` only, because the tier's
 * total comes from a second call that times out on its own.
 *
 * This is an interface the provider does not publish and may change or refuse at
 * any time. Whichever way it is read, the traffic is the user's own console
 * session; nothing here is printed or forwarded anywhere but stdout.
 *
 * The gateway and field contract were recorded by reading the console's own
 * front end and measuring a real subscription, as
 * [`dsh-token-plan-quota`](https://github.com/xinghe-1018/dsh-token-plan-quota)
 * documents in its `docs/upstream-contracts.md` (MIT). Only the read path is
 * reproduced here.
 *
 * @module dsh-balance/qwen
 */

import { pathToFileURL } from 'node:url'
import { BalanceError, emitReading, postFormJson, readOptions, refusedReading, run, windowOf } from './lib/contract.mjs'

const PROVIDER = 'qwen'
const GATEWAY_URL = 'https://cs-data.qianwenai.com/data/api.json'
const CONSOLE_ORIGIN = 'https://platform-home.qianwenai.com'
const DASHBOARD_URL = `${CONSOLE_ORIGIN}/analytics/token-plan/individual`
const INFO_URL = `${CONSOLE_ORIGIN}/tool/user/info.json`
const ENV_NAME = 'QWEN_CONSOLE_COOKIE'
const FALLBACK_ENV_NAME = 'BAILIAN_CONSOLE_COOKIE'

/** The console's own gateway vocabulary, which its front end hardcodes. */
const GATEWAY_ACTION = 'BroadScopeAspnGateway'
const GATEWAY_PRODUCT = 'sfm_bailian'
const API_PREFIX = 'zeldaHttp.apikeyMgr./tokenplan/personal/api/v2'

/** A browser identity: the gateway's human check refuses anything else. */
const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/**
 * The metered periods, most binding first: (window name, used-ratio field,
 * reset field, `quota-config` total field). A period is reported only when the
 * console returns a ratio for it — the tier totals in `quota-config` are
 * configuration, and a tier that meters no five-hour window still carries one.
 */
const WINDOWS = Object.freeze([
  ['monthly', 'per1MonthPercentage', 'per1MonthResetTime', 'monthly'],
  ['weekly', 'per1WeekPercentage', 'per1WeekResetTime', 'weekly'],
  ['five-hour', 'per5HourPercentage', 'per5HourResetTime', 'fiveHour'],
])

/** The nested name the same five-hour total may appear under. */
const FIVE_HOUR_TOTAL_KEY = 'five_hour'

/**
 * Read one number out of a console value, which may be a string with separators.
 * @param value - the raw value.
 * @returns the number, or undefined when it is not one.
 */
function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string') return undefined
  const cleaned = value.replace(/[,\s]/g, '')
  if (cleaned === '') return undefined
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Read one instant out of a console value.
 * @param value - epoch seconds or milliseconds, or a parseable date string.
 * @returns epoch milliseconds, or undefined when the value names no instant.
 */
function toEpochMs(value) {
  if (value === undefined || value === null) return undefined
  const text = String(value).trim()
  if (text === '') return undefined
  if (/^\d{10}$/.test(text)) return Number(text) * 1000
  if (/^\d{13}$/.test(text)) return Number(text)
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Read one cookie's value out of a `Cookie:` header line.
 * @param cookie - the whole header line.
 * @param name - the cookie to read.
 * @returns its value, or undefined when the line carries no such cookie.
 */
export function cookieValue(cookie, name) {
  const match = new RegExp(String.raw`(?:^|;\s*)${name}=([^;]*)`).exec(String(cookie))
  return match === null ? undefined : match[1].trim()
}

/**
 * Read the CSRF token the gateway's form body has to carry.
 *
 * The console publishes it to a signed-in session, so this is one extra call the
 * user never has to repeat by hand. A cookie that already carries `sec_token`,
 * or a `--sec-token` argument, is used when this call cannot answer — a token
 * expired by a page refresh is the far more likely failure than a changed URL.
 *
 * @param cookie - the console session cookie line.
 * @param options - the timeout, the info URL, and an injectable fetch.
 * @returns the token, or undefined when neither source has one.
 */
export async function readSecToken(cookie, { timeoutMs, infoUrl = INFO_URL, fetch: fetchImpl = fetch }) {
  try {
    const response = await fetchImpl(infoUrl, {
      headers: { accept: 'application/json', cookie: String(cookie), 'user-agent': BROWSER_USER_AGENT },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return undefined
    const payload = JSON.parse(await response.text())
    const token = payload?.data?.secToken ?? payload?.secToken
    return typeof token === 'string' && token !== '' ? token : undefined
  } catch {
    return undefined
  }
}

/**
 * Call one inner API through the console data gateway.
 * @param inner - the inner API name (`usage`, `quota-config`, or `subscription`).
 * @param options - the session cookie, the CSRF token, the endpoint, the
 *   timeout, and an injectable fetch.
 * @returns the gateway's data body.
 * @throws {BalanceError} on a transport failure, a refusal, or a body the
 *   gateway's contract does not describe.
 */
export async function callGateway(inner, { cookie, secToken, baseUrl = GATEWAY_URL, timeoutMs, fetch: fetchImpl = fetch }) {
  const api = `${API_PREFIX}/${inner}`
  const query = new URLSearchParams({ action: GATEWAY_ACTION, product: GATEWAY_PRODUCT, api, _v: 'undefined' })
  const params = {
    Api: api,
    V: '1.0',
    Data: {
      cornerstoneParam: {
        feTraceId: crypto.randomUUID(),
        feURL: DASHBOARD_URL,
        protocol: 'V2',
        console: 'ONE_CONSOLE',
        productCode: 'p_efm',
        switchUserType: 3,
        domain: new URL(CONSOLE_ORIGIN).host,
        consoleSite: 'QIANWENAI',
        userNickName: '',
        userPrincipalName: '',
        xsp_lang: 'zh-CN',
      },
    },
  }
  const anonymous = cookieValue(cookie, 'cna')
  if (anonymous !== undefined && anonymous !== '') params.Data.cornerstoneParam['X-Anonymous-Id'] = anonymous
  const form = new URLSearchParams({
    product: GATEWAY_PRODUCT,
    action: GATEWAY_ACTION,
    region: 'cn-beijing',
    language: 'zh-CN',
    params: JSON.stringify(params),
    ...secToken === undefined || secToken === '' ? {} : { sec_token: secToken },
  })
  const payload = await postFormJson(`${baseUrl}?${query.toString()}`, {
    form,
    timeoutMs,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: String(cookie),
      origin: CONSOLE_ORIGIN,
      referer: DASHBOARD_URL,
      'user-agent': BROWSER_USER_AGENT,
    },
    fetch: fetchImpl,
  })
  const refused = /NotAuthorised|NotLogined/i.exec(JSON.stringify(payload).slice(0, 500))
  if (refused !== null) {
    throw new BalanceError(
      `${payload?.data?.errorCode ?? payload?.errorCode ?? refused[0]}: the console session was refused; `
      + 'copy a fresh Cookie line from the subscription page',
    )
  }
  const envelope = payload?.data?.DataV2?.data
  if (envelope === undefined || envelope === null || typeof envelope !== 'object') {
    throw new BalanceError(`the gateway answered no data body for "${inner}": ${JSON.stringify(payload).slice(0, 200)}`)
  }
  if (envelope.success === false) {
    throw new BalanceError(`the gateway refused "${inner}": ${JSON.stringify(envelope).slice(0, 200)}`)
  }
  const data = envelope.data !== null && typeof envelope.data === 'object' ? envelope.data : envelope
  return data
}

/**
 * Read the Qwen Token Plan's remaining allowance.
 *
 * The two side calls are each allowed to fail: a tier total this script cannot
 * read costs the Credits in `detail`, not the ratio the plan is scored by, which
 * is the fact the subscription page itself shows.
 *
 * @param options - the session cookie as `key`, plus the endpoint, timeout,
 *   optional CSRF token, and an injectable fetch.
 * @returns the reading and every body it was read from.
 * @throws {BalanceError} when no period is metered.
 */
export async function readBalance({ key, baseUrl, timeoutMs, secToken, fetch: fetchImpl = fetch }) {
  try {
    const token = secToken ?? cookieValue(key, 'sec_token')
      ?? await readSecToken(key, { timeoutMs, fetch: fetchImpl })
    const usage = await callGateway('usage', { cookie: key, secToken: token, baseUrl, timeoutMs, fetch: fetchImpl })
    const quota = await optionalGateway('quota-config', { cookie: key, secToken: token, baseUrl, timeoutMs, fetch: fetchImpl })
    const subscription = await optionalGateway('subscription', { cookie: key, secToken: token, baseUrl, timeoutMs, fetch: fetchImpl })
    return { reading: parse(usage, quota, subscription), payload: { usage, quota, subscription } }
  } catch (error) {
    const refused = refusedReading(error)
    if (refused === undefined) throw error
    return { reading: refused }
  }
}

/**
 * Call one inner API whose failure costs context rather than the reading.
 * @param inner - the inner API name.
 * @param options - as {@link callGateway}.
 * @returns the body, or undefined when this call did not answer.
 */
async function optionalGateway(inner, options) {
  try {
    return await callGateway(inner, options)
  } catch {
    // The ratio in `usage` is the reading; a tier total or an expiry date that
    // does not come back is context this script reports without.
    return undefined
  }
}

/**
 * Read the plan's remaining allowance out of the console's three bodies.
 * @param usage - the `usage` body: the metered period's used ratio and reset.
 * @param quota - the `quota-config` body: each tier's Credit totals, or absent.
 * @param subscription - the `subscription` body: the tier and its expiry, or absent.
 * @returns the reading: the percentage left of the period that binds the account,
 *   one window per metered period, and a note naming the tier and its Credits.
 * @throws {BalanceError} when no period carries a ratio.
 */
export function parse(usage, quota, subscription) {
  const specCode = typeof subscription?.specCode === 'string' && subscription.specCode !== ''
    ? subscription.specCode
    : typeof subscription?.SpecCode === 'string' && subscription.SpecCode !== ''
      ? subscription.SpecCode
      : ''
  const scoped = quota !== null && typeof quota === 'object' && specCode !== ''
    && quota[specCode] !== null && typeof quota[specCode] === 'object'
    ? quota[specCode]
    : quota
  const windows = []
  const totals = new Map()
  for (const [name, ratioKey, resetKey, totalKey] of WINDOWS) {
    const ratio = toNumber(usage?.[ratioKey])
    if (ratio === undefined) continue
    const window = windowOf(name, Math.round(Math.max(0, 1 - Math.min(1, ratio)) * 1000) / 10, 100)
    if (window === undefined) continue
    windows.push({ ...window, ...resetOf(usage, resetKey) })
    const total = toNumber(scoped?.[totalKey] ?? scoped?.[FIVE_HOUR_TOTAL_KEY])
    if (total !== undefined) totals.set(name, total)
  }
  if (windows.length === 0) {
    throw new BalanceError(
      'the console meters no per1Month/per1Week/per5Hour period for this account '
      + '(a non-Token-Plan key, or a field set that changed)',
    )
  }
  const primary = windows[0]
  const total = totals.get(primary.name)
  const endsAt = toEpochMs(subscription?.endTime)
  const pieces = [
    ...specCode === '' ? [] : [`${specCode} plan`],
    `${primary.remaining}% left`,
    ...total === undefined ? [] : [`of ${total} Credits`],
    ...primary.resetsAt === undefined ? [] : [`resets ${primary.resetsAt}`],
    ...endsAt === undefined ? [] : [`subscription ends ${new Date(endsAt).toISOString()}`],
  ]
  return {
    remaining: primary.remaining,
    windows: windows.map(({ name, remaining, capacity }) => ({ name, remaining, capacity })),
    ...primary.resetsAt === undefined ? {} : { resetsAt: primary.resetsAt },
    ...primary.remaining <= 0 ? { error: `the ${primary.name} allowance is spent` } : {},
    detail: pieces.join(', '),
  }
}

/**
 * The reset instant one period's field names, when it names one.
 * @param usage - the `usage` body.
 * @param key - the reset field.
 * @returns an object carrying `resetsAt`, or an empty one.
 */
function resetOf(usage, key) {
  const at = toEpochMs(usage?.[key])
  return at === undefined ? {} : { resetsAt: new Date(at).toISOString() }
}

async function main() {
  const options = readOptions({
    argv: process.argv.slice(2),
    env: process.env,
    envName: ENV_NAME,
    fallbackEnvName: FALLBACK_ENV_NAME,
    baseUrl: GATEWAY_URL,
    provider: PROVIDER,
  })
  if (options === undefined) return
  const { reading, payload } = await readBalance(options)
  emitReading(reading, { raw: options.raw, payload })
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await run(main)
