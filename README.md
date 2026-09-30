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
{ "remaining": 42.5, "resetsAt": "2026-10-01T00:00:00Z", "error": "…", "detail": "…" }
```

- `remaining` — what the provider has left, in the unit the row's `unit` field
  names. Percentage left for a metered plan, an amount for a wallet, a count for a
  request quota.
- `resetsAt` / `error` / `detail` — optional context; only `remaining` decides.
- Anything else on stdout, a non-zero exit, or a timeout is a **missing reading**
  for the plugin: it logs the first stderr line and treats the route as
  unreported, which `failOpen` decides the meaning of. A script never fails a
  model request, so these files are strict: exit `2` with one line on stderr.

The credential arrives in the environment under the name the row's `apiKeyEnv`
declares (the plugin resolves that reference through the harness's credential
service first, so an environment variable, a `.env`, and the credential store all
work). `--key` overrides it for a manual run. Nothing here reads or writes any
other file, and no script prints its credential.

## Wiring them up

```yaml
- id: llm-quota-retry
  name: "dsh-llm-quota-retry"
  config:
    balances:
      - provider: opencode-go
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

A balance entry changes nothing on its own: readings only matter to a route
**pool**. A pool is what lets an exhausted provider hand a session to another
route, so combine these with `pools` — see that plugin's README.

## What each script reads

| Script | Provider id | Credential | Endpoint | `remaining` is | Documented? |
|---|---|---|---|---|---|
| `deepseek.mjs` | `deepseek-official` | `DEEPSEEK_API_KEY` | `GET api.deepseek.com/user/balance` | the CNY wallet's `total_balance` (the first wallet when there is no CNY one) | yes |
| `opencode-go.mjs` | `opencode-go` | `OPENCODE_API_KEY` | `GET opencode.ai/zen/go/v1/usage` | `100 − max(percent used)` over the rolling, weekly, and monthly windows; a window marked `rate-limited` reads `0` | no — the call `dsh-opencode-go` itself makes |
| `kimi-coding.mjs` | `kimi-coding` | `KIMI_CODING_API_KEY` | `GET api.kimi.com/coding/v1/usages` (404 falls back to `/v1/usage`) | the least remaining percentage across the limit rows, or the least remaining count when no row carries one | no — a community client's call |
| `minimax.mjs` | `minimax-cn` | `MINIMAX_CN_API_KEY` (or `MINIMAX_TOKEN_PLAN_KEY`) | `GET www.minimax.cn/v1/token_plan/remains` | the smaller of the language-model resources' current-interval and weekly windows; `--model` narrows to one resource | endpoint only — the fields follow the community client |
| `command-code-goat.mjs` | `command-code-goat` | `COMMAND_CODE_GOAT_API_KEY` | `GET api.commandcode.ai/alpha/billing/credits` | the **tightest** of the monthly credit and the five-hour and weekly windows, in dollars | endpoint only — the fields follow the response it answers with |

`minimax.mjs` is a port of a `minimax_quota.py` console report written earlier
for this deployment; both record the same reverse-engineered field names.

### Two products, two keys

`kimi-coding.mjs` reads the **Kimi Code subscription** plan, whose key is the
`sk-kimi-…` one from the Kimi Code console and whose endpoint is
`/coding/v1/usages`. The **Kimi open platform** is a different product with its
own key and its own balance endpoint (`GET api.moonshot.cn/v1/users/me/balance`,
answering `available_balance`/`voucher_balance`/`cash_balance`); the two keys are
not interchangeable and mixing them answers `401`. This deployment uses the coding
plan, so only that script exists here.

### Providers left out

`qwen`, `tencent`, and `xiaomi` publish no balance endpoint at all: they report an
exhausted allowance only when a request fails. They need no script — the failure
itself marks the provider unusable and the next route in the pool takes over — and
a script for them would have nothing to read.

## Probe

`node probe.mjs` drives every parser over the payload shapes those endpoints are
known to answer with, including the failure shapes (an empty wallet list, a
non-numeric balance, a rate-limited window, an auth status code, a missing quota
resource). It needs no network and no credential.

`node probe.mjs --live` additionally queries each provider whose credential is
set in the environment, in-process. It prints the reading or the provider's own
refusal, never the credential — the check to run after changing a key or an
endpoint.

## License

MIT
