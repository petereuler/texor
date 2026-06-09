# Desktop Release For macOS

This runbook covers TEXOR desktop packaging, signing, notarization, and final verification for macOS release candidates.

## Required Credentials

For signing:

- `APPLE_SIGN_IDENTITY`
  Example: `Developer ID Application: Your Name (TEAMID)`

For notarization, use one of these modes:

1. Keychain profile
   - `APPLE_NOTARY_KEYCHAIN_PROFILE`
2. Raw credentials
   - `APPLE_NOTARY_APPLE_ID`
   - `APPLE_NOTARY_TEAM_ID`
   - `APPLE_NOTARY_PASSWORD`

## Release Flow

From the repo root:

```bash
npm run typecheck
npm run package:desktop:mac
npm run sign:desktop:mac
npm run package:desktop:dmg:mac
npm run notarize:desktop:mac
npm run smoke:desktop:package
```

If you only want one architecture:

```bash
npm run sign:desktop:mac -- arm64
npm run notarize:desktop:mac -- arm64
```

## What The Scripts Do

- `package:desktop:mac`
  Builds the runtime bundle and creates unsigned `.app` and `.zip` artifacts.
- `sign:desktop:mac`
  Signs Electron frameworks, helper apps, and the top-level app with hardened runtime, then repacks the `zip`.
- `package:desktop:dmg:mac`
  Builds `.dmg` artifacts from the packaged `.app`.
- `notarize:desktop:mac`
  Submits the signed `zip` and `dmg`, waits for Apple notarization, then staples the `app` and `dmg`.
- `smoke:desktop:package`
  Verifies packaged layout, freshness, and artifact hashes.

## Notes

- Run signing and notarization on macOS with Xcode command line tools installed.
- If `sign:desktop:mac` changes the app bundle, rerun `package:desktop:dmg:mac` before notarizing so the `dmg` contains the signed app.
- The hardened runtime entitlements live in `scripts/entitlements.mac.plist`.
- Record the final smoke-test hashes and whether notarization succeeded in the release handoff.
