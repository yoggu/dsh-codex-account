# dsh-codex-account

Connect one or more OpenAI Codex (ChatGPT subscription) accounts to DSH through OAuth. Each account gets a separate provider route in the model picker. Sign in, inspect account status, import a Codex CLI login or sign out through **Plugins → OpenAI Codex**, the `/codex` command or the local CLI.

## Install from GitHub

```sh
dsh plugin --profile web add https://github.com/yoggu/dsh-codex-account.git
```

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

An override replaces the entry's full `config`. Optional settings include `models` (omit for the installed pi-ai catalog), `defaultEfforts`, `transport`, `readImages` and image-byte limits. The pi-ai catalog is not a guarantee that every model is available to your subscription; unsupported models return `UNSUPPORTED_MODEL`.

## Security

Credentials live in `$DSH_HOME/codex-accounts.json` and must remain private (`0600`). Do not commit or share that file, `~/.codex/auth.json`, authorization codes, access/refresh tokens or login URLs. The account-management route uses DSH's authenticated `/api` channel; tokens should never be returned to the browser. A localhost callback port must be free for browser login. Treat access to the Plugins page and DSH commands as sensitive account administration.

## Tests and license

`npm test` runs the local test suite when the Harness peer dependencies are available. MIT; see [LICENSE](LICENSE).
