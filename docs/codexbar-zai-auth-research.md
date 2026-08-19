# CodexBar z.ai/GLM authentication

## Finding

CodexBar does **not** authenticate z.ai/GLM through Safari cookies or browser
LocalStorage. Its z.ai provider is API-token-only.

## Primary-source evidence

- `codexbar/Sources/CodexBarCore/Providers/Zai/ZaiProviderDescriptor.swift`
  defines the provider with `fetchPlan: .apiToken(...)` and resolves the token
  through `ProviderTokenResolver.zaiToken(...)`.
- `codexbar/Sources/CodexBarCore/Providers/Zai/ZaiSettingsReader.swift`
  defines `Z_AI_API_KEY` as the token key. It has no browser-cookie or Safari
  storage reader.
- `codexbar/Sources/CodexBarCore/Providers/Zai/ZaiUsageStats.swift`
  sends `Authorization: Bearer <apiKey>` and `accept: application/json` to
  `/api/monitor/usage/quota/limit`. It does not send a `Cookie` header.
- `codexbar/Sources/CodexBarCore/TokenAccountSupportCatalog+Data.swift`
  labels z.ai credentials as “API tokens”, with no cookie source.
- In contrast,
  `codexbar/Sources/CodexBarCore/Providers/Kimi/KimiCookieImporter.swift`
  imports `kimi-auth` from browser stores through SweetCookieKit. This is the
  browser-cookie behavior that applies to Kimi, not z.ai/GLM.

### onWatch comparison

The current public onWatch source uses the same API-token model, but its
details differ from CodexBar:

- `onwatch/internal/config/config.go` reads `ZAI_API_KEY`, not
  `Z_AI_API_KEY`.
- `onwatch/internal/api/zai_client.go` sends the raw key in
  `Authorization: <apiKey>` without the `Bearer ` prefix.
- `onwatch/README.md` documents `ZAI_API_KEY` for both the global and CN
  z.ai provider.

## Consequence for planofplan

The previous attempt to treat BigModel's `TDC_itoken` as a browser bearer
token was not compatible with either CodexBar or onWatch and has been removed.
Safari login can still be valid for the BigModel web UI while no API key is
available for the quota API. planofplan now accepts both projects' API-key
names and tries both `Bearer <key>` and raw `<key>` Authorization formats.
