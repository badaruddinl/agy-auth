# Changelog

All notable changes to this project are documented here.

## 0.1.24 - 2026-07-07

### Fixed

- Fixed AGY OAuth client secret extraction when multiple `GOCSPX-` secrets and the token URL are embedded without separators in the AGY binary.

## 0.1.23 - 2026-07-07

### Fixed

- Fixed Google OAuth token exchange by using the full AGY client secret from the installed AGY binary instead of truncating it.

## 0.1.22 - 2026-07-07

### Fixed

- Corrected `agy-authx login --cloud-project` to match AGY's GCP OAuth flow, storing `auth_method: "gcp"` and saving the selected project/location in AGY settings.

## 0.1.21 - 2026-07-07

### Fixed

- `agy-authx login --cloud-project` now follows AGY's Application Default Credentials flow instead of using the consumer OAuth browser flow.
- Cloud Project login now reads ADC from `GOOGLE_APPLICATION_CREDENTIALS` or the gcloud ADC file, refreshes the ADC token, and saves the quota project in the AGY credential.

## 0.1.20 - 2026-07-07

### Fixed

- Updated the npm README legacy command wording so `legacy disabled` no longer advertises the old `<= 0.1.17` bridge limit.
- Allow `agy-authx legacy disabled` and `agy-authx legacy enabled` to manage current `@badaruddinl/agy-auth` bridge releases through `0.1.20`.

## 0.1.19 - 2026-07-07

### Added

- Added `agy-authx legacy status`, `agy-authx legacy disabled`, and `agy-authx legacy enabled`.
- `legacy disabled` only uninstalls `@badaruddinl/agy-auth` after verifying the installed version is less than or equal to `0.1.17`.
- `legacy enabled` removes that verified bridge package when present, then installs `@badaruddinl/agy-auth` so the `agy-auth` command is provided by the bridge package.

### Changed

- Prefer `agy-authx legacy enabled` and `agy-authx legacy disabled` for legacy command management.
- Keep `enable` and `disable` as aliases for the state-based commands.
- Manage only `@badaruddinl/agy-auth` versions less than or equal to `0.1.17`; newer versions are refused.
- `@badaruddinl/agy-authx` owns only the `agy-authx` command; `@badaruddinl/agy-auth` owns only the `agy-auth` bridge command and runs the `agy-authx` implementation.
- Removed the bridge package postinstall notice so `npm install -g @badaruddinl/agy-auth` installs without extra npm warnings.

### Fixed

- `list --refresh` now reads quota from the AGY local backend instead of falling back to cached usage when AGY's interactive `/usage` command is not available through pipes.
- `agy-auth login`, `agy-authx login`, and `agy-authx login --oauth` now use a direct Google OAuth browser flow instead of opening the AGY login menu.
- The OAuth login prompt now always prints the full Google URL as plain text, so Git Bash/MINGW terminals that do not support terminal hyperlinks can still open it manually.
- `agy-authx login` now polls recent AGY logs while waiting, so OAuth URLs and authorization-code prompts written to AGY log files are surfaced instead of leaving the terminal stuck after startup.
- `agy-authx login` starts credential polling immediately, allowing silent AGY auth success from keyring refresh to be captured.
- `agy-authx login --cloud-project` now uses a direct browser authorization flow and writes an AGY Google Cloud project credential with `auth_method: "adc"` and the selected quota project.

## 0.1.18 - 2026-07-07

### Changed

- Restored the `agy-auth` command as a compatibility alias for `agy-authx`.
- Both `agy-auth` and `agy-authx` now run the same `agy-authx` entrypoint.

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
