# Changelog

All notable changes to this project are documented here.

## 0.1.17 - 2026-07-07

### Fixed

- Allow account list ids such as `01` and `02` to be used as account queries. This fixes `agy-authx switch 02` after copying an id from `agy-authx list`.

### Changed

- `@badaruddinl/agy-authx` now exposes only the `agy-authx` command. The legacy `agy-auth` command is reserved for the final bridge release of `@badaruddinl/agy-auth`.
- Shortened successful switch output to `switched to <account>`.
- Removed outdated wording from CLI output, errors, tests, and documentation.

### Added

- Added `agy-authx set alias <query> to <alias>` for setting or updating account aliases by list id, email, existing alias, or account key.

## 0.1.16 - 2026-07-07

### Changed

- Renamed the GitHub repository to `badaruddinl/agy-authx`.
- Published the primary package as `@badaruddinl/agy-authx`.
- Exposed both `agy-authx` and the legacy `agy-auth` command from the `@badaruddinl/agy-authx` package.
- Updated the legacy `@badaruddinl/agy-auth` package into a bridge package that installs `@badaruddinl/agy-authx`.

### Migration

- New installs should use:

  ```bash
  npm install -g @badaruddinl/agy-authx
  ```

- Existing users can still install the old package name:

  ```bash
  npm install -g @badaruddinl/agy-auth
  ```

  The old package now installs the authx implementation and keeps both commands available.

## 0.1.15 - 2026-07-07

### Changed

- Renamed the CLI command from `agy-auth` to `agy-authx`.
- Renamed the npm package metadata from `@badaruddinl/agy-auth` to `@badaruddinl/agy-authx`.
- Added a shorter npm-focused README that is swapped in during `npm pack`/`npm publish`.
- Expanded the GitHub README with install, migration, keyring, Linux, macOS, and development notes.

### Added

- Added `agy-authx login --activate` to keep the newly logged-in account active immediately after login.
- Added active-row highlighting in `agy-authx list` when terminal color output is available.
- Added tests for narrow terminal list rendering and active-row color output.

## 0.1.14 - 2026-07-07

### Changed

- Removed npm compiled runtime dependencies for lighter global installs.
- Replaced `keytar` usage with operating-system keyring tools:
  - Windows Credential Manager through PowerShell and WinCred.
  - macOS Keychain through the built-in `security` command.
  - Linux Secret Service through `secret-tool`.
- Replaced PTY dependency usage with Node child processes.
- Made `agy-auth list` adaptive for narrow terminals and kept each account on one row.

### Added

- Added compact quota columns for small terminal widths.
- Added local packaging verification for dependency-free installs.

### Notes

- Linux users need `secret-tool`, usually from `libsecret-tools`, plus a running Secret Service provider such as GNOME Keyring or KWallet.
- macOS normally needs no extra package because `/usr/bin/security` is built in.
