#!/usr/bin/env node
/**
 * `deepseek-official` balance: the DeepSeek platform's own wallet.
 *
 * `GET https://api.deepseek.com/user/balance` answers with every wallet the
 * account holds; the reading is the CNY one (the currency this deployment is
 * billed in), or the first wallet when there is no CNY wallet. `is_available`
 * false becomes an `error` note rather than a zero: the number the API reports
 * is still the number it reports.
 *
 * https://api-docs.deepseek.com/api/get-user-balance/
 *
 * @module dsh-balance/deepseek
 */

import { pathToFileURL } from 'node:url'
import { BalanceError, emitReading, getJson, readOptions, refusedReading, run } from './lib/contract.mjs'

const PROVIDER = 'deepseek-official'
const BASE_URL = 'https://api.deepseek.com'
const ENV_NAME = 'DEEPSEEK_API_KEY'

/**
 * Read one wallet out of the balance response.
 * @param payload - the parsed response.
 * @returns the reading: the amount left, when the provider says it resets, and a
 *   human-readable note.
 * @throws {BalanceError} when no wallet carries a usable amount.
 */
export function parse(payload) {
  const wallets = Array.isArray(payload?.balance_infos) ? payload.balance_infos : []
  if (wallets.length === 0) throw new BalanceError('the response carries no balance_infos')
  const wallet = wallets.find(entry => entry?.currency === 'CNY') ?? wallets[0]
  const remaining = Number(wallet?.total_balance)
  if (!Number.isFinite(remaining)) {
    throw new BalanceError(`total_balance is not a number: ${JSON.stringify(wallet?.total_balance)}`)
  }
  return {
    remaining,
    detail: `${remaining} ${wallet.currency ?? '?'}`
      + `${wallet.granted_balance === undefined ? '' : ` (granted ${wallet.granted_balance})`}`
      + `${wallet.topped_up_balance === undefined ? '' : `, topped up ${wallet.topped_up_balance})`}`,
    ...payload?.is_available === false ? { error: 'the provider reports the account as unavailable' } : {},
  }
}

/**
 * Query the balance endpoint and return the reading.
 * @param options - resolved command options, plus an injectable fetch.
 * @returns the reading.
 */
export async function readBalance({ key, baseUrl, timeoutMs, fetch: fetchImpl }) {
  try {
    const payload = await getJson(`${baseUrl}/user/balance`, { key, timeoutMs, fetch: fetchImpl })
    return { reading: parse(payload), payload }
  } catch (error) {
    const refused = refusedReading(error)
    if (refused === undefined) throw error
    return { reading: refused }
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
