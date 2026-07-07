# agy-authx

Standalone local session manager for Google Antigravity `agy` CLI/App.

Install package `@badaruddinl/agy-authx`, then run the `agy-authx` command. `agy-authx` saves multiple local AGY sessions in your operating-system keyring, lets you switch between them, and keeps a small registry at `~/.gemini/antigravity-cli/accounts/registry.json`.

## Install

```bash
npm install -g @badaruddinl/agy-authx
```

The package has no npm runtime dependencies and no compiled addon install step.

Installing `@badaruddinl/agy-authx` exposes the new command:

```bash
agy-authx --version
```

Use one runtime consistently:

- Windows AGY/App: run `agy-authx.cmd` from PowerShell or CMD.
- WSL/Linux AGY: install Node and `agy-authx` inside WSL/Linux.
- Do not install with Windows Node and execute the Windows shim as a Linux command from WSL.

## Commands

```bash
agy-authx status
agy-authx login --alias main
agy-authx login --oauth --alias main
agy-authx login --activate --alias main
agy-authx list
agy-authx list --refresh
agy-authx usage
agy-authx switch 02
agy-authx switch main
agy-authx set alias 02 to work
agy-authx legacy status
agy-authx legacy disabled
agy-authx legacy enabled
agy-authx verify
agy-authx remove main
```

`agy-authx login` uses the Google OAuth browser flow by default, saves the newly logged-in account, and preserves the previously active AGY session when one exists. Use `agy-authx login --activate` when you want the newly logged-in account to become active immediately.

`agy-authx login --cloud-project` is intentionally not routed through the AGY interactive menu. It will fail fast until the Google Cloud project credential format can be handled directly.

`agy-authx list` adapts to narrow terminals, keeps each account on one row, and highlights the selected active account when color output is available.

The first column in `agy-authx list` is a selectable id. You can use it anywhere a query is accepted:

```bash
agy-authx switch 02
agy-authx set alias 02 to backup
```

`switch` prints one concise success line:

```text
switched to account@example.com
```

## How It Works

Antigravity stores the local CLI credential in the operating-system keyring. On the tested Windows install, the active AGY entry is:

```text
service: gemini:antigravity
account: antigravity
```

`agy-authx login` temporarily clears the active AGY credential, opens the Google OAuth browser flow, writes the resulting AGY credential, and stores a snapshot under the `agy-auth` service.

The registry stores metadata only: email, alias, timestamps, and cached usage. Secrets stay in the OS keyring.

## Multi-Account Flow

1. Run `agy-authx login --alias main` and complete AGY sign-in for account A.
2. Run `agy-authx login --alias backup` and complete AGY sign-in for account B. Account A stays active after this save.
3. Switch with `agy-authx switch main`, `agy-authx switch backup`, or the row id from `agy-authx list`.

If you want account B active immediately, run:

```bash
agy-authx login --activate --alias backup
```

Set or update an alias with:

```bash
agy-authx set alias 02 to backup
agy-authx set alias account@example.com to main
```

For Antigravity App, the selected account is guaranteed at the shared credential layer. If the app was already open before switching, restart or reload the app session so it reads the newly selected credential.

## Legacy Command

`agy-auth` is provided by the deprecated `@badaruddinl/agy-auth` bridge package. That bridge installs `@badaruddinl/agy-authx` and exposes only the `agy-auth` command, so `agy-auth --version` reports the `agy-authx` version it runs. To manage the bridge package safely:

```bash
agy-authx legacy status
agy-authx legacy disabled
agy-authx legacy enabled
```

`legacy disabled` only uninstalls `@badaruddinl/agy-auth` after verifying that the installed version is less than or equal to `0.1.17`. `legacy enabled` removes that verified bridge package when present, then installs `@badaruddinl/agy-auth` so the `agy-auth` command comes from the bridge package and runs `agy-authx` behind the scenes. `enable` and `disable` are accepted as aliases.

## Keyring Requirements

This package stores credentials through the operating-system keyring without npm compiled addons:

- Windows: Credential Manager, accessed through PowerShell and the WinCred API.
- macOS: Keychain, accessed through the built-in `security` command.
- Linux: Secret Service / libsecret, accessed through `secret-tool`.

On Linux, `secret-tool` usually comes from the `libsecret-tools` package:

```bash
sudo apt install libsecret-tools
```

`secret-tool` is only the command-line client. A Secret Service provider must also be running, such as GNOME Keyring or KWallet. Desktop Linux sessions usually already have one. Headless servers often need extra setup for a keyring daemon.

On macOS, no extra package is normally required because `/usr/bin/security` is built in. macOS may still ask for Keychain access permission the first time credentials are read or written.

If a future AGY release changes the active credential names, override them with:

```bash
AGY_AUTH_TARGET_SERVICE="gemini:antigravity"
AGY_AUTH_TARGET_ACCOUNT="antigravity"
agy-authx status
```

## Npm README

The npm package intentionally uses a shorter install-focused README. The GitHub README stays more complete and includes development notes. During `npm pack`/`npm publish`, `scripts/pack-readme.js` temporarily swaps in `scripts/npm-readme.md` for the package tarball and restores this README afterward.

## Development

```bash
npm install
npm test
npm run lint
npm run pack:dry
```

Before release, verify:

```bash
npm test
npm run lint
npm pack --dry-run
```

Release checklist:

- Update `CHANGELOG.md` for the version being released.
- Ensure GitHub release notes summarize the same version.
- Ensure the npm README remains install-focused.

## License

MIT
