# dsh-codex-account

Manage the **shipped OpenAI Codex / ChatGPT sign-in** in DeepSeek Harness from **Plugins → Codex Account**. Sign in, cancel an authorization attempt, sign out, and make the `openai-codex` provider available in Models — without installing another LLM adapter or keeping a separate credential store.

The styled account card and Codex icon appear **only on the Plugins page**, not in the Settings modal. English and German UI text are supported.

## Requirements and installation

- Node.js **22.19.0 or newer**.
- DSH **0.2.x**, with its shipped `@deepseek-ai/dsh-llm-pi-ai` adapter enabled and the authorization, credentials, configuration editor, and authenticated connection services available.
- Access to the ChatGPT account you want to authorize. Model access depends on that account and the shipped adapter's catalog.

Install the current implementation from the existing GitHub repository:

```sh
dsh plugin --profile web add 'https://github.com/yoggu/dsh-codex-account.git#main'
```

Or clone it and link the local checkout:

```sh
git clone https://github.com/yoggu/dsh-codex-account.git
cd dsh-codex-account
dsh plugin --profile web add "link:$(pwd)"
```

Use the profile you actually run if it is not `web`. Keep a linked checkout in place while installed. The package ships its client bundle directly; there is no build step or private pi-ai dependency to install. Restart DSH after replacing an installed package version, then refresh the browser.

To uninstall the account UI:

```sh
dsh plugin --profile web remove dsh-codex-account
```

Uninstalling this plugin does **not** sign out, remove the model provider, or delete legacy account data. Use **Sign out** first if you want to remove the saved ChatGPT sign-in on this host.

## Using the account card

1. Open **Plugins → Codex Account** and click **Sign in with ChatGPT**.
2. Follow the OpenAI authorization page and any notices or prompts shown by the shipped adapter. The card updates while authorization is pending; **Cancel sign-in** stops a pending attempt.
3. After successful authorization, the plugin adds `llm-pi-ai.providers.openai-codex: {}` **only if absent**, preserving other provider settings. Existing provider configuration is left untouched.
4. Select an `openai-codex` model in DSH when you want to use it. The plugin does not change a running session's selected model or send a model request.

If a sign-in is already saved but `openai-codex` is missing, the card shows **Add to Models**. If the post-sign-in configuration update fails, the saved sign-in is kept and the card offers that repair action without repeating OAuth. Enabling the plugin alone does not start authorization or edit provider configuration.

**Sign out** removes only the saved `llm-pi-ai/openai-codex` grant on this host. Model configuration and other credentials are preserved; this is not a global ChatGPT logout. Account mutations are blocked during an active authorization or provider-configuration operation.

## Credential ownership and security

The shipped `llm-pi-ai` adapter owns the OAuth flow and its credential record. This plugin uses the harness authorization service and checks credential **presence only**; it never reads, copies, imports, or returns the saved grant payload. Sign-out uses the credential service's `deleteRecord` operation for the fixed adapter-owned key.

The account card communicates through DSH's authenticated `/api/dsh-codex-account` channel. Provider links are restricted to HTTPS OpenAI/ChatGPT domains, and upstream failures are reduced to safe error codes. Treat access to DSH and the Plugins page as sensitive account administration. Do not share authorization codes, access/refresh tokens, login URLs, credential files, or legacy account stores.

## Migration from earlier plugins

### From `dsh-codex-sign-in`

This is the renamed successor to that plugin, with the same sign-in, sign-out, provider-repair behavior, card, and icon. The credential key remains **`llm-pi-ai/openai-codex`**, so an existing shipped-adapter sign-in does **not** need to be repeated.

Install `dsh-codex-account`, verify its card, then remove the previous package:

```sh
dsh plugin --profile web remove dsh-codex-sign-in
```

Refresh the browser after the switch. The package/module name is now `dsh-codex-account`, its bundle entry ID is `codex-account`, and the API route is `/api/dsh-codex-account`.

### From `dsh-codex-account` 0.1.x

**Version 0.2.0 replaces the old custom multi-account LLM adapter.** It manages the single ChatGPT sign-in owned by the shipped `llm-pi-ai` adapter instead. The old `accounts` configuration, custom `codex-personal` / `codex-business` request routes, `/codex` commands, local login CLI, Codex CLI import, and account/token-detail readouts are no longer provided.

- Remove old `id: codex-account` configuration overrides containing `accounts`, `models`, `transport`, or other custom-adapter options. The new bundle requires no account configuration.
- Choose the shipped `openai-codex` route for future requests; old custom-route sessions may require changing their selected model.
- An old 0.1.x login is **not** automatically imported into the shipped adapter. Sign in through the new card if the shipped credential is absent.
- The legacy `$DSH_HOME/codex-accounts.json` store and `~/.codex/auth.json` are **not read or deleted**. Removing old source code does not remove those credentials. Keep them private if retained.
- Older releases and their source remain available in this repository's Git history and existing `v0.1.x` tags.

## Development and tests

```sh
npm test
npm pack --dry-run
```

The offline tests cover renamed package/client/route identity, authorization notices and prompts, automatic provider addition and repair, sign-out isolation and idempotency, busy-operation guards, safe failure handling, and the Plugins-only card. They do not contact OpenAI or modify real credentials.

MIT; see [LICENSE](<LICENSE>).
