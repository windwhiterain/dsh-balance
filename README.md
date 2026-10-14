# dsh-balance

Balance scripts for [`dsh-llm-quota-retry`](https://github.com/windwhiterain/dsh-llm-quota-retry)
route pools: one file per provider, each printing the reading that plugin decides
with. No dependencies, no build, no state — a script reads one provider's
remaining allowance and prints it.

```sh
node opencode-go.mjs            # {"remaining":87.5,"resetsAt":"…","detail":"rolling 12.5% used"}
node minimax.mjs --model m3.1   # one model's own quota resource
node probe.mjs                  # parser checks, no network
node probe.mjs --live           # also query every provider whose credential is set
```

## What a script must do

`dsh-llm-quota-retry` runs a balance script through the harness's own subprocess
service and reads **one JSON object from stdout**:

```json
{
  "remaining": 2.94,
  "windows": [
    { "name": "five-hour", "remaining": 14, "capacity": 14 },
    { "name": "weekly", "remaining": 2.94, "capacity": 35 },
    { "name": "monthly", "remaining": 37.94 }
  ],
  "resetsAt": "2026-10-01T00:00:00Z", "error": "…", "detail": "…"
}
```

- `remaining` — the collapsed number every reader decides on: what the provider
  has left, in the unit the row's `unit` field names. Percentage left for a
  metered plan, an amount for a wallet, a count for a request quota.
- `windows` — optional; the usage windows `remaining` collapses. Each entry
  carries the window's own `name`, stable across runs, what that window has left
  in the script's own unit, and — when the provider states one — the window's
  full allowance as `capacity`, in the same unit as its `remaining`.
  `dsh-llm-quota-retry` ranks a route by its worst window,
  `min(remaining / capacity)`; a window without a `capacity` (a prepaid wallet,
  a limit the endpoint does not state) is context for a person and is never
  scored.
- `resetsAt` / `error` / `detail` — optional context for a person; none of them
  changes a ranking.
- Anything else on stdout, a non-zero exit, or a timeout is a **missing reading**
  for the plugin: it logs the first stderr line and treats the route as
  unreported, which `failOpen` decides the meaning of. A script never fails a
  model request, so these files are strict: exit `2` with one line on stderr.

The credential arrives in the environment under the name the row's `apiKeyEnv`
declares (the plugin resolves that reference through the harness's credential
service first, so an environment variable, a `.env`, and the credential store all
work). `--key` overrides it for a manual run. That reference is whatever the
script needs: an API key for most of them, and a console session cookie for
`qwen.mjs`, which reads the name the script documents. Nothing here reads or
writes any other file, and no script prints its credential.

## Wiring them up

```yaml
- id: llm-quota-retry
  name: "dsh-llm-quota-retry"
  config:
    balances:
      - provider: dsh-opencode-go
        script: [!!js process.execPath, "C:/resource/dsh-balance/opencode-go.mjs"]
        apiKeyEnv: OPENCODE_API_KEY
        unit: percent-left
        minimumRemaining: 5
      - provider: minimax-cn
        script: [!!js process.execPath, "C:/resource/dsh-balance/minimax.mjs"]
        apiKeyEnv: MINIMAX_CN_API_KEY
        unit: percent-left
        minimumRemaining: 5
      - provider: kimi-coding
        script: [!!js process.execPath, "C:/resource/dsh-balance/kimi-coding.mjs"]
        apiKeyEnv: KIMI_CODING_API_KEY
        minimumRemaining: 1
      - provider: command-code-goat
        script: [!!js process.execPath, "C:/resource/dsh-balance/command-code-goat.mjs"]
        apiKeyEnv: COMMAND_CODE_GOAT_API_KEY
        unit: usd-left
        minimumRemaining: 1
```

`!!js process.execPath` pins the interpreter to the one the host itself runs, so
the script needs nothing on `PATH`; a plain `"node"` works too when it is
installed system-wide.

Every `script` path above is **absolute, and it is this machine's checkout** —
nothing discovers these files for you. A profile that names a path you do not
have fails to read that balance, so replace each one with a path into your own
checkout of this repository.

A provider whose script reports a single number rather than a set of windows —
`deepseek.mjs` reports one CNY balance, so it needs `unit: cny-left` — is scored
against the row's `capacity`, and an unscored route never takes part in ranking.
Give it one, sized to your own top-up scale:

```yaml
      - provider: deepseek-official
        script: [!!js process.execPath, "C:/resource/dsh-balance/deepseek.mjs"]
        apiKeyEnv: DEEPSEEK_API_KEY
        unit: cny-left
        capacity: 300
        minimumRemaining: 1
```

A balance entry changes nothing on its own: readings only matter to a route
**pool**. A pool is what lets an exhausted provider hand a session to another
route, so combine these with `pools` — see that plugin's README.

## What each script reads

| Script | Provider id | Credential | Endpoint | `remaining` is | Documented? |
|---|---|---|---|---|---|
| `deepseek.mjs` | `deepseek-official` | `DEEPSEEK_API_KEY` | `GET api.deepseek.com/user/balance` | the CNY wallet's `total_balance` (the first wallet when there is no CNY one) | yes |
| `opencode-go.mjs` | `dsh-opencode-go` | `OPENCODE_API_KEY` | `GET opencode.ai/zen/go/v1/usage` | `100 − max(percent used)` over the rolling, weekly, and monthly windows; a window marked `rate-limited` reads `0` | no — the call `dsh-opencode-go` itself makes |
| `kimi-coding.mjs` | `kimi-coding` | `KIMI_CODING_API_KEY` | `GET api.kimi.com/coding/v1/usages` (404 falls back to `/v1/usage`) | the least remaining percentage across the limit rows, or the least remaining count when no row carries one | no — a community client's call |
| `minimax.mjs` | `minimax-cn` | `MINIMAX_CN_API_KEY` (or `MINIMAX_TOKEN_PLAN_KEY`) | `GET www.minimax.cn/v1/token_plan/remains` | the smaller of the language-model resources' current-interval and weekly windows; `--model` narrows to one resource | endpoint only — the fields follow the community client |
| `command-code-goat.mjs` | `command-code-goat` | `COMMAND_CODE_GOAT_API_KEY` | `GET api.commandcode.ai/alpha/billing/credits` | the **tightest** of the monthly credit and the five-hour and weekly windows, in dollars | endpoint only — the fields follow the response it answers with |
| `qwen.mjs` | `qwen` | `QWEN_CONSOLE_COOKIE` (or `BAILIAN_CONSOLE_COOKIE`) — a **console session cookie**, not an API key | the console data gateway (`POST cs-data.qianwenai.com/data/api.json`), `tokenplan/personal/api/v2` | percent left of the period the plan meters — the month since the 2026-09 billing change, a week for a subscription still metering weekly — with the tier's Credit total in `detail` | no — the console's own front end, see below |

Every script but `deepseek.mjs` also reports those allowances one window at a
time: `opencode-go.mjs` its `rolling`, `weekly`, and `monthly` windows as percent
left out of 100, `minimax.mjs` the `current` and `weekly` window of each selected
resource under that window's own label, `kimi-coding.mjs` one window per usage
row named `limit-1`, `limit-2`, … in row order, `qwen.mjs` the `monthly`,
`weekly`, or `five-hour` period the plan meters, whichever the console reports a
reading for, and `command-code-goat.mjs` its `monthly`, `five-hour`, and `weekly`
allowances, of which only the last two carry the endpoint's `cap`. A prepaid
wallet (`deepseek.mjs`) has no window: the pool row's own unit and threshold are
what measure it.

`minimax.mjs` is a port of a `minimax_quota.py` console report written earlier
for this deployment; both record the same reverse-engineered field names.

### The Qwen Token Plan has no balance API

The plan meters Credits per subscription month (Lite 11,500 … Pro 180,000), and
the platform publishes no key-based endpoint that reports what is left of them —
its own FAQ sends you to the console page. `qwen.mjs` therefore reads what that
page reads: the console's own data gateway, authenticated by the **browser
session cookie** rather than an API key.

```sh
# 1. sign in, open https://platform-home.qianwenai.com/analytics/token-plan/individual
# 2. DevTools → Network → any request → copy the whole `Cookie:` header
# 3. store that one line as a credential:
#      ~/.dsh/.credentials.yaml    QWEN_CONSOLE_COOKIE: <the copied line>
#    or export it for a manual run:
QWEN_CONSOLE_COOKIE='...' node qwen.mjs
```

The CSRF token the gateway's form body needs is fetched from the console
(`tool/user/info.json` → `data.secToken`) on every run, so nothing else is copied
by hand; a `sec_token` already inside the cookie is used when that call cannot
answer. The request carries the browser's `User-Agent` because the gateway
refuses any other one. A cookie that has expired is reported as a refused
session, not as a zero reading — copy a fresh line and the next run recovers.

Three things to weigh before wiring it up:

- **It is not a published interface.** The provider may change or refuse it, and
  it is the provider's console session being reused. Reading it is your call; if
  you would rather not, the `qwen` route still works without this script — the
  provider's own refusal marks it unusable and the pool moves on.
- **It is one number, not six.** This plan meters a single period, so the reading
  is one window rather than a month of them, and the tier's Credit total comes
  from a second call that sometimes times out; the percentage is reported either
  way and the Credits are dropped when it does.
- **A prepaid "加油包" is not folded in.** The console reports it separately and
  documents no relationship to the tier's Credits, so counting it would be an
  estimate rather than a reading.

### Two products, two keys

`kimi-coding.mjs` reads the **Kimi Code subscription** plan, whose key is the
`sk-kimi-…` one from the Kimi Code console and whose endpoint is
`/coding/v1/usages`. The **Kimi open platform** is a different product with its
own key and its own balance endpoint (`GET api.moonshot.cn/v1/users/me/balance`,
answering `available_balance`/`voucher_balance`/`cash_balance`); the two keys are
not interchangeable and mixing them answers `401`. This deployment uses the coding
plan, so only that script exists here.

### Providers left out

`tencent` and `xiaomi` publish no balance endpoint at all, and no console
interface this deployment knows of: they report an exhausted allowance only when
a request fails. They need no script — the failure itself marks the provider
unusable and the next route in the pool takes over — and a script for them would
have nothing to read. `qwen` was in this group until its console gateway was
recorded above; it keeps its failure mark as well, for a deployment that would
rather not hold a session cookie.

## Probe

`node probe.mjs` drives every parser over the payload shapes those endpoints are
known to answer with, including the failure shapes (an empty wallet list, a
non-numeric balance, a rate-limited window, an auth status code, a missing quota
resource). `qwen.mjs` is driven the same way through an injected `fetch`: its
checks assert the gateway's query, form body, CSRF token, and browser identity,
and the refusal and envelope failures. It needs no network and no credential.

`node probe.mjs --live` additionally queries each provider whose credential is
set in the environment, in-process. It prints the reading or the provider's own
refusal, never the credential — the check to run after changing a key or an
endpoint.

## License

MIT

