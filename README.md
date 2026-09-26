# dsh-codex-account

OpenAI Codex accounts (ChatGPT subscription) via OAuth in the DeepSeek Harness—with
explicit account selection.

## Why this plugin exists

The shipped Composition does not mount `ctx.authorization`, the seam for
credential flows, and the web interface has no page that starts a login.
`dsh-llm-pi-ai` therefore never registers its login flow—and the Codex provider
is the only provider in pi-ai's catalog that is authenticated exclusively via
OAuth. This plugin closes exactly that gap without touching `settings.yaml`
and without changing a single line in the Harness.

## What it does

| Part | Effect |
| --- | --- |
| `AccountStore` | `$DSH_HOME/codex-accounts.json` (`0600`, atomic, file-locked) holds one credential **per account ID**—a personal and a business account do not interfere with each other. |
| `login` / `import` / `status` / `logout` | The OAuth flow comes from `@earendil-works/pi-ai` (PKCE, callback on `localhost:1455`, device code). None of it is reimplemented. |
| `CodexAccountAdapter` | Registers one route per account as an `LlmAdapter` on `ctx.llm`: Codex models, context sizes, reasoning levels, and image input. |
| `/codex` | Human command in the web GUI: `login`, `import`, `status`, `logout`. |
| `lib/login-cli.mjs` | The same code without a running Harness—headless and usable for login without a restart. |
| `client.js` + `lib/control.js` | Dedicated **Settings → OpenAI Codex** page: account ID, plan, token expiration, and the Sign in, Import from Codex CLI, and Sign out buttons. |

## The settings page

`client.js` is handwritten in the `window.__ModuleLoader__.load` format,
without JSX or a bundler, and registers itself in `settings.section` with
`order: 11`—directly after “Models”.

Why a dedicated page rather than a card in the model list: the slot
`settings.models.provider-card` is delivered with `entryKey = settingsNs` **per
directory entry**, so it can only extend routes managed by `settings.yaml`.
This route is registered by the Composition; it appears in the model picker,
not in the model list.

The browser communicates with the host through a JSON route—
`/api/codex-account/control` (GET reads the state, POST triggers actions).
It is attached to `connection.fetch.register`, **not** directly to the
`webServer`: according to the contract, a fetch route on the shared `/api`
channel is called only *after* the host's trust and authentication checks. A
directly registered route would be reachable without a session and would expose
the account ID and plan. Verified: without a session cookie, the route responds
`401`.

Login runs asynchronously: the POST returns immediately, the card polls the
state every two seconds, and displays the authorization URL as a link in the
meantime. A token is never sent to the browser.

### Why the GUI does not open a system browser

`login()` opens the desktop browser only when the caller sets
`openBrowser: true`—the CLI is the only caller that does so. The control route
does **not** set it.

The reason is a real bug in the first version: `xdg-open` launched browser
windows with a fresh profile on the user's desktop from the web GUI. Anyone
clicking in the web GUI is already in a browser; instead, the card displays the
URL as a link with `target="_blank"`.

### Port 1455 belongs to the login

The OAuth callback binds `127.0.0.1:1455`. If a second Harness instance is
already running, it holds the port and a login fails with
“Address already in use”—therefore, a test instance on another `--port` is **not**
a sufficient isolation method for this flow.

### Theme tokens—the first version's mistake

The CSS uses only `--dsw-alias-*`, the Harness's alias layer. The first version
used its own hex values with `var(--text-primary, #202124)` as a fallback: the
token name does not exist, so the fallback was always used and the page rendered
with the colors of a light layout in the dark theme.

The actual names are provided by `Theme.listTokens`; the ones used here are:

| Purpose | Token |
| --- | --- |
| Text | `--dsw-alias-label-primary` / `-secondary` / `-tertiary` / `-caption` |
| Surfaces | `--dsw-alias-bg-layer-1` (card), `-2` (button) |
| Borders | `--dsw-alias-border-l1` / `-l2` |
| State | `--dsw-alias-state-success-primary`, `-error-primary`, `-warn-primary` |
| Button | `--dsw-alias-button-primary-fill`, `-hover`, `--dsw-alias-label-primary-foreground` |

An invented token name does **not** fail—it silently falls back to a browser
default. Therefore, every name used was checked against the theme package and
not written from memory.

## Which models a ChatGPT account actually serves

The route offers the **complete** Codex catalog of the installed pi-ai version—with
no filter. This is intentional because pi-ai does not fetch its catalog from
OpenAI at runtime: `openaiCodexProvider()` calls `createProvider({ models })`
**without** `fetchModels`, so it has no `refreshModels`, and `Models.refresh()`
skips exactly those providers. The catalog is therefore static for each pi-ai
version. A maintained filter would consequently be a second, silently aging
list: it would hide every new model until someone added its ID.

Tested with a personal Plus account:

| Model | Result |
| --- | --- |
| `gpt-6-astra`, `gpt-5.6-terra`, `gpt-5.6-sol`, `gpt-5.6-luna`, `gpt-5.5` | served |
| `gpt-5.3-codex-spark`, `gpt-5.4`, `gpt-5.4-mini` | rejected: “is not supported when using Codex with a ChatGPT account” |

A rejected model returns `UNSUPPORTED_MODEL`, not a generic 400—the picker offers
it, and the first call explains the reason. If you do not want this, set
`models` explicitly to the verified subset; an empty list means “no filter”.

Image input is handled natively by the route. Harness content carries only a
durable attachment reference; for each request, the adapter retrieves the bytes
through the attachment service, places them in the Context as pi-ai
`ImageContent`, and pi-ai serializes them through the shared Responses path as
`input_image`. Which models accept images is determined by the pi-ai catalog
**per model**—a text-only route exists only when `readImages: false` is set or
the model has no `image` entry in the catalog (`gpt-5.3-codex-spark`, for
example). Images in tool results are handled in the same way as user images.

An aggregate byte budget (`maxRequestImageBytes`, default 20 MiB) shortens very
long image histories: the oldest images are replaced with a stable placeholder
that names the attachment instead of causing the request to fail.
`requestImagePixelBudget` and `requestImageMaxBytes` control normalization per
image.

## Installation

```sh
dsh plugin --profile web add /path/to/dsh-codex-account
```

The package includes its own `cordis.patch.yml`; `dsh` composes it as its own
layer through `dsh.bundle.patch`. Restarting the profile loads the entry.

## Logging in

Without a restart, using the same store read by the route:

```sh
node lib/login-cli.mjs login personal            # browser flow
node lib/login-cli.mjs login personal --device   # headless
node lib/login-cli.mjs status
node lib/login-cli.mjs logout personal
```

In the running Harness: `/codex login personal`.

**Important with two subscriptions:** choose the correct account in the
browser. The login then displays the account ID and plan from the token—so you
can verify which account was connected.

`import` adopts an existing Codex CLI login (`~/.codex/auth.json`) without a
browser. The refresh token is then shared between the CLI and this plugin; the
CLI rotates it the next time it refreshes. For a separate, independent token
store, browser login is the right choice.

## Configuration

The entry can be overridden through a later patch layer (the profile's
`cordis.patch.yml`); a patch entry replaces `config` in its entirety.

```yaml
- insert:
    - id: codex-account
      name: 'dsh-codex-account'
      config:
        accounts:
          - id: personal
            provider: codex-personal
            displayName: 'Codex (personal)'
          - id: business
            provider: codex-business
            displayName: 'Codex (business)'
        transport: sse          # sse | websocket | websocket-cached | auto
        cacheRetention: long    # none | short | long
        readImages: true        # image input for this route
        models:                 # empty/omitted = entire pi-ai catalog
          - gpt-6-astra         # optional: restrict to verified models
          - gpt-5.6-sol
        defaultEfforts:         # starting level per model; without an entry, the
          gpt-5.6-luna: xhigh   # provider's default applies ("Default" in picker)
          gpt-5.6-sol: high
          gpt-6-astra: medium
        streamIdleTimeoutMs: 300000
```

`defaultEfforts` sets the reasoning level with which a model starts in a new
session. It is a property of the deployment, not of the plugin, and is advertised
as `defaultEffort` in the model metadata: the model picker shows it as the
current level, and a session without its own selection sends it. If a level is
not supported by the model, the mount reports it in the log and then ignores it—
the route remains usable.

Each account needs its own `provider` route: the Harness addresses a model call
via `provider`/`model`, making the route the selection surface in the model
picker.

## Error cases

| Message | Meaning |
| --- | --- |
| `INVALID_CREDENTIAL` with “Could not parse your authentication token” | The access token is invalid or expired and could not be refreshed—log in again. |
| `INVALID_CREDENTIAL` with “provider is not configured” | No credential for this account exists in the store. |
| `UNKNOWN_MODEL` | The model is not in this installation's pi-ai catalog **or** has been filtered out by `models`. |
| `UNSUPPORTED_MODEL` | The catalog knows the model, but the Codex backend does not serve it for this account. |
| `UNSUPPORTED_CONTENT` | The history contains image blocks, but `readImages: false`—or the attachment service is missing from this Composition. |
| `TIMEOUT` | No provider event occurred within `streamIdleTimeoutMs`. |
| “Credential file is readable by other users” | `chmod 600` on `$DSH_HOME/codex-accounts.json`. |

## Dependencies

All runtime dependencies are `peerDependencies` and are provided by the
Harness tree: `@deepseek-ai/{cordis,dsh-attachment,dsh-llm,dsh-timeout,dsh-home-paths,dsh-atomic-write,dsh-commands,schemastery}`
and `@earendil-works/pi-ai`. `dsh-commands` is optional—without the command
layer, the plugin still loads and only logs a missing login. `@deepseek-ai/dsh-client-connection`
is also optional: without that service, the plugin mounts, just without a
settings page.

### Development

Because all dependencies are peers, Node does not resolve them when invoked
directly from this directory. For local tests, symlinks to the Harness tree are
sufficient:

```sh
DSH_NM=~/.local/share/mise/installs/node/24.16.0/lib/node_modules/@deepseek-ai/dsh/node_modules
for p in @earendil-works/pi-ai @deepseek-ai/dsh-attachment @deepseek-ai/dsh-llm \
         @deepseek-ai/dsh-timeout @deepseek-ai/dsh-home-paths \
         @deepseek-ai/dsh-atomic-write @deepseek-ai/schemastery \
         @deepseek-ai/cordis @deepseek-ai/dsh-commands \
         @deepseek-ai/dsh-client-connection; do
  mkdir -p "node_modules/$(dirname "$p")"
  ln -sfn "$DSH_NM/$p" "node_modules/$p"
done
```

`node_modules/` is in `.gitignore`; after a Harness update, the symlinks must be
recreated.

## License

MIT. The conversion between Harness and pi-ai vocabulary
(`lib/convert.js`) follows the structure of `@deepseek-ai/dsh-llm-pi-ai`
(MIT, © DeepSeek AI).
