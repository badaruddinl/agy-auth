# agy-auth

Standalone local account switcher for Google Antigravity `agy` CLI.

`agy-auth` captures the currently logged-in Antigravity credential from the OS keyring, stores account snapshots back into the OS keyring, and restores one snapshot when you run `agy-auth switch`.

## Install

```bash
npm install -g @badaruddinl/agy-auth
```

Then run:

```bash
agy-auth status
agy-auth login --alias main
agy-auth import --alias main
agy-auth usage
agy-auth list --refresh
agy-auth list
agy-auth switch main
```

## How It Works

Antigravity stores the local CLI credential in the operating-system keyring. On the tested Windows install, the native entry is:

```text
service: gemini:antigravity
account: antigravity
```

`agy-auth import` reads that credential and saves a copy under:

```text
service: agy-auth
account: <captured-email>
```

The registry at `~/.gemini/antigravity-cli/accounts/registry.json` stores only metadata such as email, alias, and timestamps. The secret remains in the OS keyring.

## Commands

```bash
agy-auth status
agy-auth login --alias main
agy-auth import --alias main
agy-auth list             # list stored auth snapshots
agy-auth list --refresh   # refresh active quota, then list
agy-auth usage            # read active quota from AGY /usage
agy-auth switch           # choose from the list interactively
agy-auth switch main      # switch by alias/email/key
agy-auth remove main
agy-auth native
agy-auth config
```

`agy-auth login` opens the installed `agy` CLI. Complete the provider login if prompted, then exit `agy`; the command captures the active account automatically.

`agy-auth login --device-auth` is supported only when the installed `agy` build exposes a device-auth login mode. Current tested AGY builds do not list `login` or `--device-auth` in `agy --help`, so the command returns a clear unsupported message instead of passing an invalid flag.

## Multi-Account Flow

1. Login to account A in Google Antigravity or `agy`.
2. Run `agy-auth import --alias main`.
3. Login to account B in Google Antigravity or `agy`.
4. Run `agy-auth import --alias backup`.
5. Switch with `agy-auth switch main` or `agy-auth switch backup`.

Restart running AGY CLI/App sessions after switching so they reload the credential.

## Cross-Platform Notes

This package uses [`keytar`](https://www.npmjs.com/package/keytar), which supports:

- Windows Credential Manager
- macOS Keychain
- Linux Secret Service / libsecret

AGY must use the same OS keyring service/account names for switching to work. If a future AGY release changes those names, override them with:

```bash
AGY_AUTH_TARGET_SERVICE="gemini:antigravity"
AGY_AUTH_TARGET_ACCOUNT="antigravity"
agy-auth status
```

On Linux, make sure Secret Service is available. On headless servers this usually requires a keyring daemon such as GNOME Keyring or KWallet.

## Scope

This tool is for local desktop or self-host workflows. It is not a public SaaS multi-user auth layer. For public multi-user systems, isolate each AGY runtime/profile or use a local agent per user/device.

## Development

```bash
npm install
npm test
npm run lint
npm run pack:dry
```

## License

MIT
