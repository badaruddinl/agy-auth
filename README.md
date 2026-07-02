# agy-auth

Standalone local session manager for Google Antigravity `agy` CLI/App.

`agy-auth` manages local AGY sessions. It can run the AGY sign-in flow, capture the resulting Antigravity credential from the OS keyring, store session snapshots back into the OS keyring, and restore one snapshot when you run `agy-auth switch`.

## Install

```bash
npm install -g @badaruddinl/agy-auth
```

Then run:

```bash
agy-auth status
agy-auth login --alias main
agy-auth login --oauth --alias main
agy-auth login --cloud-project --alias work
agy-auth usage
agy-auth verify
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

`agy-auth login` temporarily clears the active AGY credential, runs `agy`, lets AGY complete sign-in, then reads the resulting active session credential and saves a copy under:

```text
service: agy-auth
account: <captured-email>
```

The registry at `~/.gemini/antigravity-cli/accounts/registry.json` stores only metadata such as email, alias, and timestamps. The secret remains in the OS keyring.

## Commands

```bash
agy-auth status
agy-auth login --alias main   # run AGY sign-in with Google OAuth, then save the session
agy-auth login --oauth --alias main # same as login
agy-auth login --cloud-project --alias work # use AGY login method option 2
agy-auth capture --alias main # save the currently active AGY session
agy-auth import --alias main  # same as capture
agy-auth list             # list stored auth snapshots
agy-auth list --refresh   # refresh quota for all snapshots, then list
agy-auth usage            # read active quota from AGY /usage
agy-auth switch main      # switch by alias/email/key
agy-auth verify           # prove agy-auth active account matches native agy
agy-auth remove main
agy-auth native
agy-auth config
```

`agy-auth login` is the primary command for first login or adding another account. It runs the native AGY login flow behind the agy-auth command and parses AGY's login output. By default it selects AGY login method 1, Google OAuth. Use `agy-auth login --cloud-project` for AGY login method 2, Google Cloud project. When OAuth is used, agy-auth shows the authorization URL and asks for the authorization code in its own prompt.

This does not replace existing `agy-auth` snapshots. Existing saved sessions remain in `agy-auth list` and can still be selected with `agy-auth switch <alias|email|key>`. If an account was active before `agy-auth login`, that active session is restored after the new login is captured. The newly logged-in account is saved to the list but is not made active until you run `agy-auth switch`.

Current tested AGY builds do not expose a native `login` or `--device-auth` subcommand in `agy --help`, so `agy-auth login` runs plain `agy` and captures the session after AGY exits.

`agy-auth list` shows reset times as actual local date/time values, for example `18:23` or `15:12 on 7 Jul`, instead of raw relative durations such as `118h 40m`.

`agy-auth list --refresh` temporarily loads each saved snapshot, reads AGY `/usage`, stores the quota data for that account, and then restores the previously active AGY credential.

`agy-auth verify` checks the active account end to end:

1. The selected `agy-auth` registry account.
2. The active OS keyring credential at `gemini:antigravity / antigravity`.
3. The email shown by a fresh native `agy` process.

The command fails if the selected snapshot and active AGY credential differ, or if native `agy` loads a different email.

## Multi-Account Flow

1. Run `agy-auth login --alias main` and complete AGY sign-in for account A.
2. Run `agy-auth login --alias backup` and complete AGY sign-in for account B. Account A stays active after this capture.
3. Switch with `agy-auth switch main` or `agy-auth switch backup`.

After `agy-auth switch <alias|email|key>`, the active AGY credential in the OS keyring is replaced with the selected snapshot. AGY CLI/App loads the selected account from that active credential.

For Antigravity App, the selected account is guaranteed at the shared credential layer. If the app was already open before switching, restart or reload the app session so it reads the newly selected credential.

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
