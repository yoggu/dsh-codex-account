# dsh-codex-account

Connect one or more OpenAI Codex (ChatGPT subscription) accounts to DSH through OAuth. Each account gets a separate provider route in the model picker. Sign in, inspect account status, import a Codex CLI login or sign out through **Plugins → OpenAI Codex**, the `/codex` command or the local CLI.

## Install

Install the tagged GitHub release into your DSH Web profile:

```sh
dsh plugin --profile web add 'https://github.com/yoggu/dsh-codex-account.git#v0.1.2'
```

Or download the source and link the local checkout:

```sh
git clone --branch v0.1.2 --depth 1 https://github.com/yoggu/dsh-codex-account.git
cd dsh-codex-account
pnpm install
dsh plugin --profile web add "link:$(pwd)"
```

Keep a linked checkout in place while the plugin is installed. Use the profile you actually run if it is not `web`.

Restart DSH Web if necessary, then open **Plugins → OpenAI Codex** and sign in. Choose the intended ChatGPT account in the browser. The browser flow uses a localhost callback on port 1455; use the device flow if a browser callback is unavailable. To uninstall: `dsh plugin --profile web remove dsh-codex-account`.

For a local, headless login from a cloned package directory:

```sh
node lib/login-cli.mjs login personal --device
node lib/login-cli.mjs status
node lib/login-cli.mjs logout personal
```

You can also use `/codex login personal` in DSH Web. `import` adopts `~/.codex/auth.json` but shares a rotating refresh token with Codex CLI; separate browser sign-in avoids that coupling.

## Configuration

The default bundle creates a `personal` account route. To add another, override the `codex-account` entry in your web profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: codex-account
      name: dsh-codex-account
      config:
        accounts:
          - id: personal
            provider: codex-personal
            displayName: Codex (personal)
          - id: business
            provider: codex-business
            displayName: Codex (business)
```

An override replaces the entry's full `config`. Optional settings include `models` (omit for the catalog of the pi-ai version pinned by this plugin), `defaultEfforts`, `transport`, `readImages` and image-byte limits. Update pi-ai deliberately with this plugin and its tests; updating DSH alone does not update this catalog. The pi-ai catalog is not a guarantee that every model is available to your subscription; unsupported models return `UNSUPPORTED_MODEL`.

## Security

Credentials live in `$DSH_HOME/codex-accounts.json` and must remain private (`0600`). Do not commit or share that file, `~/.codex/auth.json`, authorization codes, access/refresh tokens or login URLs. The account-management route uses DSH's authenticated `/api` channel; tokens should never be returned to the browser. A localhost callback port must be free for browser login. Treat access to the Plugins page and DSH commands as sensitive account administration.

## Tests and license

`npm test` runs the local test suite when the Harness peer dependencies are available. MIT; see [LICENSE](LICENSE).
