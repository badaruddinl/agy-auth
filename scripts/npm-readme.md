# agy-authx

Local multi-account session manager for Google Antigravity `agy` CLI/App.

Install package `@badaruddinl/agy-authx`, then run the `agy-authx` command.

## Install

```bash
npm install -g @badaruddinl/agy-authx
```

This package is lightweight: no npm runtime dependencies and no compiled addon install step.

`agy-authx` manages sessions for the Google Antigravity `agy` CLI, so the `agy` binary must be available on `PATH` for login, quota refresh, and verification commands.

Installing `@badaruddinl/agy-authx` exposes the new command:

```bash
agy-authx --version
```

Check whether AGY is available:

```bash
agy-authx doctor
```

If `agy` is not installed, install it explicitly with the official Google Antigravity installer:

```bash
agy-authx setup-agy
```

or:

```bash
agy-authx agy install
```

The npm install step intentionally does not auto-install AGY. The setup commands are opt-in so global npm installs stay clean and predictable.

## Quick Start

```bash
agy-authx status
agy-authx doctor
agy-authx setup-agy
agy-authx login --alias main
agy-authx list
agy-authx switch 02
agy-authx switch main
agy-authx verify
agy-authx legacy status
```

Use `--activate` when the newly logged-in account should become active immediately:

```bash
agy-authx login --activate --alias main
```

By default, `agy-authx login` saves the new account and preserves the previously active AGY session when one exists.

## Common Commands

```bash
agy-authx doctor                      # check AGY path/version/setup
agy-authx setup-agy                   # install AGY with the official installer
agy-authx agy install                 # alias for setup-agy
agy-authx login --alias main          # Google OAuth login
agy-authx login --cloud-project       # Google Cloud project login
agy-authx login --activate --alias x  # save and activate the new session
agy-authx list                        # compact account table
agy-authx list --refresh              # refresh quota data first
agy-authx usage                       # show active account quota
agy-authx switch 02                   # switch by list id
agy-authx switch main                 # switch by alias/email/key
agy-authx set alias 02 to backup      # set or update alias
agy-authx legacy disabled             # remove the managed agy-auth bridge
agy-authx legacy enabled              # enable agy-auth through the bridge package
agy-authx remove main                 # remove one saved session
```

`agy-authx list --refresh` reads quota from the local AGY backend. If AGY prints a backend port that is not detected automatically, rerun with `AGY_AUTHX_AGY_GRPC_PORT=<port>`.

The active account is highlighted in `agy-authx list` when your terminal supports color.

## Platform Notes

- Windows: use PowerShell/CMD with `agy-authx.cmd` when AGY is installed on Windows.
- WSL/Linux: install Node and `agy-authx` inside WSL/Linux when AGY runs there.
- macOS: uses the built-in Keychain `security` command for exact AGY/agy-authx credential items only; it does not enumerate the full Keychain.
- Linux: requires `secret-tool` from libsecret, plus a running Secret Service provider such as GNOME Keyring or KWallet.

Ubuntu/Debian:

```bash
sudo apt install libsecret-tools
```

For full documentation, see the GitHub repository:

https://github.com/badaruddinl/agy-authx
