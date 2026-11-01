# AuraPay

**Your money. Without borders.**

AuraPay is a Nimiq Pay Mini App that connects African users to three things:

1. **Pay** — airtime, mobile data and electricity across Nigeria, Ghana, Kenya, Uganda, South Africa and Tanzania, paid with **NIM** or **USDT** through Nimiq Pay (Reloadly for fulfilment).
2. **Invest** — discover US stocks (NVIDIA, Apple, Microsoft, Tesla, …) with live prices, charts and a full purchase-review flow.
3. **Borrow** — see how much USDT your investments could unlock, with LTV, interest and liquidation shown up front.

Built for the Nimiq Mini Apps Hackathon.

> **What's real and what's simulated** is documented in [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md) and shown in-app at **/status**. In short: wallet connection, NIM/USDT payments, on-chain payment verification, Reloadly (sandbox or production), exchange rates and market data (with keys) are real. Stock execution and lending have no provider credentials yet, so they run as clearly labelled simulators — they never take payment and never claim you own shares or received USDT.

---

## Stack

* Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS 4
* `@nimiq/mini-app-sdk` (Nimiq provider) + EIP-1193 `window.ethereum` (USDT on Polygon) + `viem` for ABI encoding
* Postgres (Supabase) via `postgres`; embedded **PGlite** fallback for zero-config dev/demo — both run the same SQL migrations
* Zod validation, `libphonenumber-js`, hand-built SVG charts

```
src/
  app/                    pages (Home, Invest, Borrow, Pay, Activity, Status) and /api route handlers
  components/             design system (ui.tsx), charts, shell (nav), pay flow, receipts
  lib/client/             API client, wallet provider (Nimiq + EVM), hooks
  lib/server/             config/modes, db, sessions, rate limiting, Reloadly client & catalogue,
                          payment verification (nimiq.ts, polygon.ts), order orchestration,
                          market data, investing & lending simulators, ledger
  lib/shared/             types, formatting, target countries
supabase/migrations/      schema (RLS deny-by-default)
scripts/                  mock providers + end-to-end API and browser tests
docs/INTEGRATIONS.md      integration details, payment state machine, provider research
```

## Quick start (local)

```bash
npm install
cp .env.example .env.local      # fill in what you have; everything is optional in development
npm run dev                     # http://localhost:3000
```

With no configuration you get: the full UI, an embedded database (`.data/pglite`), demo market prices (labelled **DEMO DATA**), the investing and lending simulators, and the Pay screen reporting "provider offline". Add credentials to switch features on:

| To enable | Set |
|---|---|
| Utility payments (sandbox) | `RELOADLY_CLIENT_ID`, `RELOADLY_CLIENT_SECRET`, `RELOADLY_MODE=sandbox` |
| Pay with NIM | `NIMIQ_MERCHANT_ADDRESS`, `NIMIQ_NETWORK`, `NIMIQ_RPC_URL` |
| Pay with USDT | `POLYGON_MERCHANT_ADDRESS` (+ `POLYGON_RPC_URL`) |
| Live stock prices / charts | `FINNHUB_API_KEY`, `TWELVEDATA_API_KEY` |
| Persistent Postgres | `DATABASE_URL` (+ `DB_AUTO_MIGRATE=true` or `supabase db push`) |
| Admin reconciliation | `ADMIN_API_TOKEN` |

### Modes (`APP_MODE`)

| Mode | Simulators | Database | Use for |
|---|---|---|---|
| `development` | on | PGlite or Postgres | local work |
| `demo` | on | PGlite or Postgres | public browser demos; simulated payments allowed **only** with Reloadly sandbox |
| `sandbox` | off | Postgres required | real Nimiq Pay payments on **testnet NIM** + Reloadly sandbox |
| `production` | off | Postgres required | real money, Reloadly production; test overrides ignored |

AuraPay never silently falls back to fake behaviour: if an integration is missing, the feature says so.

## Testing inside Nimiq Pay

1. Run `npm run dev -- -H 0.0.0.0` and find your LAN IP.
2. In Nimiq Pay → Mini Apps, enter `http://<lan-ip>:3000` as a custom URL.
3. Switch Nimiq Pay to **testnet** (app menu → long-press settings for 10 s), tap **Get free NIM**.
4. Set `NIMIQ_NETWORK=testnet`, a testnet `NIMIQ_MERCHANT_ADDRESS` and a testnet `NIMIQ_RPC_URL`, plus Reloadly sandbox credentials.
5. Pay → Nigeria → Airtime → approve in Nimiq Pay. The order is fulfilled only after the server verifies the transaction on-chain.

Share a deployed build with `https://nimpay.app/miniapps/open/<your-domain>`.

## Database (Supabase)

```bash
# Option A — Supabase CLI
supabase link --project-ref <ref>
supabase db push                     # applies supabase/migrations

# Option B — let AuraPay migrate on first connection
DATABASE_URL=postgres://...  DB_AUTO_MIGRATE=true
```

All tables have RLS enabled with no policies and `anon`/`authenticated` privileges revoked; only the server connection can read or write.

## Deploying to Vercel

1. Import the repository in Vercel (framework preset: Next.js; build `next build`).
2. Create a Supabase project and copy the **transaction pooler** connection string (port `6543`) into `DATABASE_URL`. Apply migrations (above).
3. Add environment variables from `.env.example`. Minimum for a hackathon demo:
   `APP_MODE=demo`, `SESSION_SECRET`, `DATABASE_URL`, `RELOADLY_CLIENT_ID`, `RELOADLY_CLIENT_SECRET`, `RELOADLY_MODE=sandbox`, `FINNHUB_API_KEY`, `TWELVEDATA_API_KEY`, and for wallet payments `NIMIQ_NETWORK=testnet`, `NIMIQ_MERCHANT_ADDRESS`, `NIMIQ_RPC_URL`.
4. Deploy, open `/status` to confirm each integration, then open the app in Nimiq Pay.

Without `DATABASE_URL`, a `demo` deployment on Vercel uses in-memory PGlite (data resets on cold starts — fine for a quick look, not for judging persistence).

## Tests

Everything external can be exercised offline against `scripts/mock-providers.mjs`, a local stand-in shaped after Reloadly's OpenAPI specs and the Nimiq / Polygon JSON-RPC APIs.

```bash
npm run build
npm run mock &                                   # mock providers on :4010
# start the app with the TEST ONLY overrides from .env.example, plus e.g.:
#   RELOADLY_CLIENT_ID=mock-client RELOADLY_CLIENT_SECRET=mock-secret
#   NIMIQ_MERCHANT_ADDRESS="NQ07 0000 0000 0000 0000 0000 0000 0000 0000" NIMIQ_RPC_URL=http://localhost:4010/nimiq
#   POLYGON_MERCHANT_ADDRESS=0x1111111111111111111111111111111111111111 POLYGON_RPC_URL=http://localhost:4010/polygon
#   ALLOW_REAL_PAYMENTS_FOR_SANDBOX=true ADMIN_API_TOKEN=test-admin-token-123 RATE_LIMIT_MULTIPLIER=10 PGLITE_DIR=memory
npm start &
npm run test:api     # 32 API tests: pricing, idempotency, NIM/USDT verification, tx reuse,
                     # memo/amount mismatch, pending→confirmed, concurrent fulfilment,
                     # provider failure → review → verified refund, session isolation, simulators
npm run test:ui      # Playwright: every section at mobile + desktop, demo and NIM purchase flows,
                     # simulated Nimiq Pay host, console-error check
```

`npm run typecheck` and `npm run lint` must be clean.

## Admin API

```bash
curl -H "Authorization: Bearer $ADMIN_API_TOKEN" https://<host>/api/admin/orders
curl -X POST -H "Authorization: Bearer $ADMIN_API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"refundTxHash":"<hash>"}' https://<host>/api/admin/orders/<id>/refund      # verified on-chain
curl -X POST -H "Authorization: Bearer $ADMIN_API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"status":"successful","note":"Confirmed with Reloadly support"}' https://<host>/api/admin/orders/<id>/resolve
```

## Known limitations

* No brokerage or lending provider is integrated (see the research notes in `docs/INTEGRATIONS.md`); those features are simulators in development/demo modes and unavailable in sandbox/production.
* Sessions are anonymous device sessions. Signature-based login (`nimiq.sign` + server verification) is the next step for multi-device accounts.
* Rate limiting is per server instance.
* Refunds are executed by an operator from the merchant wallet (AuraPay holds no signing keys server-side) and then verified on-chain.
