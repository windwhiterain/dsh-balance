/**
 * The shared half of every balance script: the argument and credential
 * conventions, one bounded HTTP request, and the one-line JSON reading
 * `dsh-llm-quota-retry` parses.
 *
 * A balance script is a *plain command*: the plugin runs it through the
 * harness's subprocess service with the credential its `apiKeyEnv` names in the
 * environment, and reads one JSON object from stdout:
 *
 *   {
 *     "remaining": <number>,
 *     "windows"?: [{ "name": "...", "remaining": <number>, "capacity"?: <number> }, …],
 *     "resetsAt"?: "<iso>", "error"?: "...", "detail"?: "..."
 *   }
 *
 * `remaining` is what the provider has left, in the unit the row's `unit` field
 * names. `windows` reports the usage windows behind that one number, each in
 * the script's own unit; the plugin ranks a route by its worst window —
 * `min(remaining / capacity)` — so a window whose provider states no `capacity`
 * is context for a person and is never scored.
 *
 * Anything else on stdout, or a non-zero exit, is a *missing reading* for the
 * plugin — it never fails the request — so a script is free to be strict: exit 2
 * with one line on stderr and the plugin will log exactly that line.
 *
 * @module dsh-balance/lib/contract
 */

import { basename } from 'node:path'

/** A diagnostic a script reports as a failed reading rather than a crash. */
export class BalanceError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BalanceError'
  }
}

/** One line of usage help for every script, so `--help` never needs its own copy. */
const USAGE = Object.freeze([
  '--key <credential>        use this credential instead of the environment variable',
  '--base-url <url>          query another origin (a region, a gateway, a proxy)',
  '--timeout <seconds>       request timeout, default 10',
  '--raw                     include the provider payload in the output',
  '--help                    print this help',
])

/**
 * Read one script's command line.
 * @param options - the environment variable the credential normally comes from,
 *   the default origin, and whether this provider takes a `--model` selector.
 * @param options.argv - the process arguments after the script name.
 * @param options.env - the environment to read the credential from.
 * @param options.envName - the variable `apiKeyEnv` forwards the credential as.
 * @param options.fallbackEnvName - another accepted variable, for a credential a
 *   deployment may already publish under a different name.
 * @param options.baseUrl - the origin used when `--base-url` is absent.
 * @param options.model - whether `--model <name>` is accepted.
 * @param options.provider - the provider id, quoted in help and diagnostics.
 * @returns the resolved options, or `undefined` when `--help` was asked for.
 * @throws {BalanceError} when an argument is unknown or unusable.
 */
export function readOptions({ argv, env, envName, fallbackEnvName, baseUrl, model = false, provider }) {
  const options = { key: '', baseUrl, timeoutMs: 10_000, raw: false, model: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const valueOf = (flag) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new BalanceError(`${flag} needs a value`)
      index += 1
      return value
    }
    switch (argument) {
      case '--key': options.key = valueOf('--key'); break
      case '--base-url': options.baseUrl = valueOf('--base-url').replace(/\/+$/, ''); break
      case '--timeout': {
        const seconds = Number(valueOf('--timeout'))
        if (!Number.isFinite(seconds) || seconds <= 0) throw new BalanceError('--timeout must be a positive number of seconds')
        options.timeoutMs = Math.round(seconds * 1000)
        break
      }
      case '--model':
        if (!model) throw new BalanceError(`${provider} does not take --model`)
        options.model = valueOf('--model')
        break
      case '--raw': options.raw = true; break
      case '--help':
        printHelp(provider, envName, baseUrl, model)
        return undefined
      default:
        throw new BalanceError(`unknown argument "${argument}"; try --help`)
    }
  }
  if (options.key === '') options.key = env[envName] ?? (fallbackEnvName === undefined ? '' : env[fallbackEnvName]) ?? ''
  if (options.key === '') {
    throw new BalanceError(`no credential: set ${envName}${fallbackEnvName === undefined ? '' : ` (or ${fallbackEnvName})`}, or pass --key`)
  }
  return options
}

/**
 * Print one script's usage.
 * @param provider - the provider id.
 * @param envName - the credential variable.
 * @param baseUrl - the default origin.
 * @param model - whether `--model` is accepted.
 */
function printHelp(provider, envName, baseUrl, model) {
  const lines = [
    `usage: node ${basename(process.argv[1] ?? `${provider}.mjs`)} [options]`,
    '',
    `Reads ${provider}'s remaining allowance and prints one JSON reading, for`,
    'dsh-llm-quota-retry route pools.',
    '',
    `credential: ${envName}`,
    `origin:     ${baseUrl}`,
    '',
  ]
  for (const text of USAGE) lines.push(`  ${text}`)
  if (model) lines.push('  --model <name>            read one model\'s quota instead of the provider-wide one')
  process.stdout.write(`${lines.join('\n')}\n`)
}

/**
 * Request one JSON document.
 * @param url - the absolute URL.
 * @param options - the credential, timeout, extra headers, and fetch to use.
 * @returns the parsed body.
 * @throws {BalanceError} on a transport failure, a non-2xx status, or a body
 *   that is not JSON.
 */
export async function getJson(url, { key, timeoutMs, headers = {}, fetch: fetchImpl = fetch }) {
  let response
  try {
    response = await fetchImpl(url, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${key}`,
        ...headers,
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new BalanceError(`cannot reach ${url}: ${reason}`)
  }
  const body = await response.text()
  if (!response.ok) {
    throw new BalanceError(`HTTP ${response.status} from ${url}: ${compact(body)}`)
  }
  try {
    return JSON.parse(body)
  } catch {
    throw new BalanceError(`non-JSON response from ${url}: ${compact(body)}`)
  }
}

/**
 * Print one reading and end the script successfully.
 * @param reading - `remaining` plus any optional fields.
 * @param options - `raw` includes the provider payload under `payload`.
 */
export function emitReading(reading, { raw = false, payload } = {}) {
  const value = raw && payload !== undefined ? { ...reading, payload } : reading
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

/**
 * Build one usage window of a reading.
 * @param name - the window's own label, which a script keeps stable across runs.
 * @param remaining - what that window has left, in the script's own unit.
 * @param capacity - the window's full allowance in the same unit, when the
 *   provider states one.
 * @returns the window, or `undefined` when the name is not a non-empty string or
 *   `remaining` is not a finite number. A `capacity` that is not a finite
 *   positive number is dropped, leaving the window unscored.
 */
export function windowOf(name, remaining, capacity) {
  if (typeof name !== 'string' || name === '' || !Number.isFinite(remaining)) return undefined
  return Number.isFinite(capacity) && capacity > 0 ? { name, remaining, capacity } : { name, remaining }
}

/**
 * Report one failed reading the way the plugin expects: one line on stderr, exit 2.
 * @param error - the failure.
 */
export function reportFailure(error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exitCode = 2
}

/**
 * Run one script's main, reporting a `BalanceError` as a failed reading.
 * @param main - the script's entry point.
 */
export async function run(main) {
  try {
    await main()
  } catch (error) {
    reportFailure(error)
  }
}

/**
 * Shorten one response body for a diagnostic line.
 * @param body - the raw body.
 * @returns the body's first 200 characters, newlines folded.
 */
function compact(body) {
  return body.replace(/\s+/g, ' ').trim().slice(0, 200)
}
