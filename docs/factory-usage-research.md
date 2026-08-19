# Factory usage research

Research date: 2026-08-18

## Executive finding

`https://app.factory.ai/settings/usage` is a signed-in Factory App page, not a
documented public API endpoint. Fetching it without a session returned only the
login/sign-up shell (`WELCOME TO FACTORY`); no page assets or network calls
containing a personal usage endpoint were available to inspect. Do not infer an
internal endpoint from this URL or scrape it as the initial implementation.

Factory does publish an official **organization Analytics API**:

```text
Base: https://api.factory.ai/api/v1/analytics
GET /tokens
GET /tools
GET /activity
GET /productivity
GET /users
```

This is organization-level historical analytics, not necessarily the
subscription-cap/remaining-balance view rendered by the personal Usage page.

## Official API contract

Source: [Factory Analytics API](https://docs.factory.ai/reference/analytics-api)
(duplicate official reference:
[api-reference/analytics](https://docs.factory.ai/api-reference/analytics)).

- Authentication is an API key in `Authorization: Bearer fk-...`.
- Keys are generated at
  [Factory API keys settings](https://app.factory.ai/settings/api-keys).
- Only organization `Manager` and `Owner` roles may call it; `User` receives
  HTTP 403.
- Every endpoint requires `startDate` and `endDate` query parameters in
  `YYYY-MM-DD` format. Dates are UTC; data is available through yesterday, and
  requesting today returns HTTP 400. Published history starts at 2026-01-14.
- Response envelope:

  ```json
  {
    "data": [],
    "meta": {
      "org_id": "org_...",
      "start_date": "YYYY-MM-DD",
      "end_date": "YYYY-MM-DD"
    }
  }
  ```

- `/tokens` rows include `date`, `billable_tokens`, `input_tokens`,
  `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, and optional
  `by_model`/`by_user` breakdowns. `billable_tokens` is Factory Standard
  Credits consumption, not a remaining quota.
- `/activity` includes daily/weekly/monthly active users, sessions, messages,
  and client breakdowns (`terminal-ui`, `web`, `non-interactive-cli`).
- `/users` is paginated (`limit` 1–100, `cursor`) and includes user email and
  per-user metrics. Avoid it unless the user explicitly requests org/user
  analytics because it exposes more identifying data.
- Documented errors are 400 (bad dates/today), 401 (missing/invalid key), 403
  (role), and 500. Rate limits vary by plan.

Example request shape (never log the key):

```text
GET https://api.factory.ai/api/v1/analytics/tokens?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
Authorization: Bearer <Factory API key>
```

## Authentication and local-repo fit

Official settings documentation says personal CLI configuration is stored at
`~/.factory/settings.json` on macOS/Linux, but it documents preferences rather
than an Analytics API credential. It also says the Factory App's usage-alert
preference (`disableUsageLimitAlerts`) is stored in the user's App profile and
is not in `settings.json`.

Source: [Factory CLI settings](https://docs.factory.ai/cli/configuration/settings)
and [Factory App settings](https://docs.factory.ai/docs/factory-app/settings).

Relevant existing repo conventions:

- `src/auth.ts` and `server.ts` use per-plan credentials in
  `~/.planofplan/credentials.json` with mode 0600 and support explicit manual
  API-key entry.
- Existing adapters read provider-owned local OAuth/config stores or
  environment variables; they do not print token values.
- `src/types.ts` already models `credits` and `tokens` units.

No Factory-specific credential file or environment variable was found in the
repo. There is no basis in first-party docs for automatically reading a
Factory browser cookie, OAuth token, or `~/.factory` secret.

## Implementation decision

The app now follows the mature CodexBar provider path for the personal Usage
page, rather than the documented organization Analytics API:

1. Resolve `FACTORY_API_KEY`, `~/.factory/.env`, or an explicit per-plan key.
2. Use `GET https://api.factory.ai/api/billing/limits` when the account exposes
   token-rate-limit billing.
3. Fall back to `/api/app/auth/me` and
   `/api/organization/subscription/usage` across Factory's API/app/auth hosts
   for legacy Standard/Premium accounts.
4. On macOS, the native menubar imports Factory session cookies from the
   selected browser and passes only recognized cookie names to the daemon's
   memory. It does not persist browser cookies.

The implementation intentionally does not claim parity with the documented
organization Analytics API, which reports historical token consumption rather
than personal remaining quota. WorkOS local-storage token minting remains a
future fallback for accounts that do not expose a usable Factory session
cookie.

## Caveats

- The public page fetch was unauthenticated, so this research cannot establish
  the internal endpoint used by the signed-in personal page.
- The Analytics API documentation establishes organization metrics and
  credits consumed; it does **not** promise subscription remaining balance,
  reset windows, or parity with `/settings/usage`.
- API keys are documented for Manager/Owner analytics access, so this may not
  work for a regular personal Factory account.
- The docs contain examples with dates in 2026; the implementation should use
  runtime UTC dates and the API's “through yesterday” rule rather than
  hard-code example dates.
