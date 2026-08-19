# Kimi Web Cookie Support: CodexBar vs onWatch

Research snapshot: 2026-08-18. Sources are pinned to the repository commits cited below.

## Conclusion

- **CodexBar supports Kimi web-cookie import on macOS.** Its Kimi importer searches the
  `kimi-auth` cookie in every candidate returned by `SweetCookieKit`, then uses that token
  for the Kimi web path. It also checks Kimi Desktop before browser stores.
  [CodexBar KimiCookieImporter](https://github.com/steipete/CodexBar/blob/f844f9882458b41c1dc919b48776cfc4957d0009/Sources/CodexBarCore/Providers/Kimi/KimiCookieImporter.swift#L6-L15)
  [CodexBar Kimi provider](https://github.com/steipete/CodexBar/blob/f844f9882458b41c1dc919b48776cfc4957d0009/Sources/CodexBarCore/Providers/Kimi/KimiProviderDescriptor.swift#L238-L253)
- **onWatch does not support browser cookies for Kimi.** Its Kimi client sends a bearer
  token to `/coding/v1/usages`; its documented sources are environment/static tokens and
  the Kimi Code credentials file, with OAuth refresh. There is no browser-cookie
  importer, macOS Keychain cookie decryption, Firefox reader, Safari reader, Comet
  path, or Dia path in the Kimi implementation.
  [onWatch Kimi client](https://github.com/onllm-dev/onWatch/blob/32fc35d7a096b9fc67b761607467617f4774cc45/internal/api/kimi_client.go#L149-L217)
  [onWatch Kimi setup](https://github.com/onllm-dev/onWatch/blob/32fc35d7a096b9fc67b761607467617f4774cc45/docs/KIMI_SETUP.md#L12-L35)

## CodexBar browser coverage

CodexBar's locked `SweetCookieKit` revision `d5ea6d92298779ec0c3ddf7d3d99da186a305e14`
defines these macOS roots under `~/Library/Application Support`:

| Browser | Root / store | Keychain Safe Storage |
|---|---|---|
| Chrome | `Google/Chrome` | `Chrome Safe Storage` / `Chrome` |
| Edge | `Microsoft Edge` | `Microsoft Edge Safe Storage` / `Microsoft Edge` |
| Brave | `BraveSoftware/Brave-Browser` | `Brave Safe Storage` / `Brave` |
| Arc | `Arc/User Data` | `Arc Safe Storage` / `Arc` |
| **Dia** | **`Dia/User Data`** | **`Dia Safe Storage` / `Dia`** |
| Chromium | `Chromium` | `Chromium Safe Storage` / `Chromium` |
| Vivaldi | `Vivaldi` | `Vivaldi Safe Storage` / `Vivaldi` |
| **Comet** | **`Comet`** | **`Comet Safe Storage` / `Comet`** |
| Firefox | `Firefox/Profiles` | none |
| Zen | `zen` | none |
| Safari | WebKit cookie stores, not an AppSupport Chromium root | none |

The same catalog also includes Chrome/Arc/Brave/Edge beta or canary channels, Firefox
Beta/Developer/Nightly, Yandex, Helium, and ChatGPT Atlas. The catalog is the source of
truth for exact names, roots, and Safe Storage labels:
[BrowserCatalog.swift](https://github.com/steipete/SweetCookieKit/blob/d5ea6d92298779ec0c3ddf7d3d99da186a305e14/Sources/SweetCookieKit/BrowserCatalog.swift#L57-L129)
[BrowserCatalog.swift, remaining channels](https://github.com/steipete/SweetCookieKit/blob/d5ea6d92298779ec0c3ddf7d3d99da186a305e14/Sources/SweetCookieKit/BrowserCatalog.swift#L230-L279)

For Chromium roots, the importer enumerates `Default`, `Profile *`, and `user-*`
directories and accepts both `<profile>/Cookies` and
`<profile>/Network/Cookies`:
[ChromeCookieImporter.swift](https://github.com/steipete/SweetCookieKit/blob/d5ea6d92298779ec0c3ddf7d3d99da186a305e14/Sources/SweetCookieKit/ChromeCookieImporter.swift#L463-L520)

## Encrypted Chromium cookies on macOS

CodexBar's dependency does handle encrypted Chromium cookie values, but the support is
not generic browser-cookie magic:

1. It reads the SQLite `cookies` table and considers both `value` and `encrypted_value`.
   [ChromeCookieImporter.swift](https://github.com/steipete/SweetCookieKit/blob/d5ea6d92298779ec0c3ddf7d3d99da186a305e14/Sources/SweetCookieKit/ChromeCookieImporter.swift#L120-L185)
2. It reads the browser-specific Safe Storage password from macOS Keychain. It first
   attempts a no-UI lookup, then may retry interactively; the package exposes a gate
   for background imports that must not show Keychain UI.
   [ChromeCookieImporter.swift](https://github.com/steipete/SweetCookieKit/blob/d5ea6d92298779ec0c3ddf7d3d99da186a305e14/Sources/SweetCookieKit/ChromeCookieImporter.swift#L230-L268)
   [BrowserCookieKeychainAccessGate.swift](https://github.com/steipete/SweetCookieKit/blob/d5ea6d92298779ec0c3ddf7d3d99da186a305e14/Sources/SweetCookieKit/BrowserCookieKeychainAccessGate.swift#L1-L22)
3. It derives a 128-bit AES key with PBKDF2-HMAC-SHA1, salt `saltysalt`, 1003
   iterations, then decrypts `v10` values with AES-CBC, an all-`0x20` IV, and PKCS#7.
   [ChromeCookieImporter.swift](https://github.com/steipete/SweetCookieKit/blob/d5ea6d92298779ec0c3ddf7d3d99da186a305e14/Sources/SweetCookieKit/ChromeCookieImporter.swift#L270-L331)
4. For cookie database schema version 24+, it verifies and removes the
   SHA-256(host key) prefix before returning the value.
   [ChromeCookieImporter.swift](https://github.com/steipete/SweetCookieKit/blob/d5ea6d92298779ec0c3ddf7d3d99da186a305e14/Sources/SweetCookieKit/ChromeCookieImporter.swift#L322-L331)
5. It copies the SQLite DB and available `-wal`/`-shm` files to a temporary,
   read-only working copy before parsing, so a live browser DB is not modified.
   [ChromeCookieImporter.swift](https://github.com/steipete/SweetCookieKit/blob/d5ea6d92298779ec0c3ddf7d3d99da186a305e14/Sources/SweetCookieKit/ChromeCookieImporter.swift#L86-L116)

Important limitation: this pinned implementation explicitly accepts only the `v10`
prefix. It does **not** implement `v11` or `v20` in `decryptChromiumValue`; the existing
project note saying “v10/v11” should not be treated as evidence that CodexBar handles
both. [SweetCookieKit ChromeCookieImporter.swift](https://github.com/steipete/SweetCookieKit/blob/d5ea6d92298779ec0c3ddf7d3d99da186a305e14/Sources/SweetCookieKit/ChromeCookieImporter.swift#L305-L320)

## Firefox and Safari

- **Firefox/Gecko:** CodexBar uses `~/Library/Application Support/Firefox/Profiles`,
  finds profile directories and `cookies.sqlite`, copies `cookies.sqlite` plus WAL/SHM,
  and reads `moz_cookies(host, name, path, value, expiry, isSecure, isHttpOnly)`.
  No Keychain decryption is involved.
  [GeckoCookieImporter.swift](https://github.com/steipete/SweetCookieKit/blob/d5ea6d92298779ec0c3ddf7d3d99da186a305e14/Sources/SweetCookieKit/GeckoCookieImporter.swift#L35-L66)
  [GeckoCookieImporter.swift](https://github.com/steipete/SweetCookieKit/blob/d5ea6d92298779ec0c3ddf7d3d99da186a305e14/Sources/SweetCookieKit/GeckoCookieImporter.swift#L89-L159)
- **Safari/WebKit:** CodexBar parses `Cookies.binarycookies`, checking the legacy
  `~/Library/Cookies/Cookies.binarycookies`, the Safari container path, and
  `Library/WebKit/WebsiteDataStore` descendants. Access may require Full Disk Access;
  there is no Chromium Safe Storage step.
  [SafariCookieImporter.swift](https://github.com/steipete/SweetCookieKit/blob/d5ea6d92298779ec0c3ddf7d3d99da186a305e14/Sources/SweetCookieKit/SafariCookieImporter.swift#L4-L18)
  [SafariCookieImporter.swift](https://github.com/steipete/SweetCookieKit/blob/d5ea6d92298779ec0c3ddf7d3d99da186a305e14/Sources/SweetCookieKit/SafariCookieImporter.swift#L85-L124)
  [SafariCookieImporter.swift](https://github.com/steipete/SweetCookieKit/blob/d5ea6d92298779ec0c3ddf7d3d99da186a305e14/Sources/SweetCookieKit/SafariCookieImporter.swift#L282-L330)

## Concrete gaps in this repository

`src/adapters/kimi.ts` currently:

1. Has a fixed Chromium app list at
   [`kimi.ts#L257-L269`](../src/adapters/kimi.ts#L257-L269): it omits **Dia** and
   **Comet**, and does not model the beta/canary or arbitrary Chromium profile roots.
2. Checks only `Default/Network/Cookies`, `Default/Cookies`, and `Cookies`
   ([`kimi.ts#L271-L290`](../src/adapters/kimi.ts#L271-L290)); it does not enumerate
   `Profile *`/`user-*` profiles or copy active DB WAL/SHM files.
3. Applies the Chromium SQL schema (`cookies`, `host_key`, `encrypted_value`) to
   every candidate DB ([`kimi.ts#L293-L303`](../src/adapters/kimi.ts#L293-L303)).
   The Firefox path is therefore not a working Firefox reader: Firefox uses
   `moz_cookies` with `host`, `expiry`, and `isSecure`/`isHttpOnly`.
4. Explicitly discards any row whose `encrypted_value` is non-empty
   ([`kimi.ts#L306-L320`](../src/adapters/kimi.ts#L306-L320)). It has no macOS Keychain
   lookup, PBKDF2, AES-CBC, schema-v24 hash handling, or v10/v11/v20 handling.
5. Has no Safari `Cookies.binarycookies` parser or WebKit WebsiteDataStore scan.

The current project documentation describes this as an intentional M3/M4 gap:
[coding-plan-usage-trackers.md#L354-L370](./coding-plan-usage-trackers.md#L354-L370),
and the design still lists the cookie layer as optional:
[planofplan-design.md#L122-L126](./planofplan-design.md#L122-L126).
The remaining implementation decision is therefore clear: keep the Kimi browser
fallback as “plain Chromium/Kimi Desktop only,” or add a real macOS cookie layer
with separate Chromium/Gecko/WebKit readers and explicit Keychain/Full Disk Access
handling. Copying CodexBar's current behavior would cover more browsers, but would
still be v10-specific rather than a complete answer for every encrypted Chromium
format.
