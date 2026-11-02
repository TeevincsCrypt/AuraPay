# AuraPay

**Your money. Without borders.**

AuraPay is a Nimiq Pay Mini App for African users:

1. **Pay**: airtime, mobile data and electricity in Nigeria, Ghana, Kenya and Uganda, paid with **NIM** or **USDT** (fulfilled by Flutterwave Bills; Reloadly also supported). Also **cable TV** (DStv, GOtv, StarTimes) and **internet** plans, and **scheduled bills**: prepay once, and AuraPay pays the bill automatically at the date and time you set, once or every week or month.
2. **Send & receive by @username**: claim a username and send **NIM** or **USDT (Polygon)** to anyone else's, directly from wallet to wallet. AuraPay never holds the funds; it fixes the recipient, amount and memo, then verifies the transaction on-chain so both sides see it in Activity. Receive with a QR code / request link that opens AuraPay's Send screen in Nimiq Pay.

3. **Savings circles** (ajo / esusu / chama): a group contributes a fixed NIM/USDT amount every week or month and each member takes the pot once, in a set order. Contributions go straight to that round's recipient as verified transfers; AuraPay never holds the pot.
4. **Recurring payments & bill reminders**: repeat any bill or transfer weekly/monthly; it shows as due on Home and pays in one tap (prefilled), with a calendar file for phone alerts. Bills can also run on prepaid **Autopay**.
5. **Earn on idle USDT**: supply USDT to **Aave V3 on Polygon** from your own wallet (approve → `Pool.supply`) and withdraw any time (`Pool.withdraw`, including "max"). Shows your aPolUSDT balance and the live supply APY read from Aave. A withdrawal hands straight off to **Pay a bill** or your **savings circle**.
6. **Swap NIM ↔ USDT** on **QuickSwap (Polygon)**: live router quotes, 0.5% slippage guard, exact approvals. It switches on automatically once NIM exists on Polygon (Nimiq's announced bridge) with a QuickSwap pool; until then the screen says so and points to Pay with NIM / Earn.
7. **Your currency**: amounts are shown in NIM/USDT and in your chosen currency (USD, NGN, GHS, KES, UGX) at live rates.

AuraPay runs only on **Nimiq** and **Polygon**.

Everything is real: there is no demo mode and no simulated data. Users sign in with a **Nimiq Pay wallet signature**, inside the app with one tap, or from any other browser by approving a QR code / code in Nimiq Pay. Details: [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md). Live integration state: **/status**.

---

## Stack

* Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS 4
* `@nimiq/mini-app-sdk` (NIM, signatures) + EIP-1193 `window.ethereum` (USDT on Polygon) + `viem`
* Postgres / Supabase (`postgres`), embedded PGlite for local development only
* `@noble/curves` + `@noble/hashes` (Nimiq signature verification), Zod, `libphonenumber-js`, `qrcode`

```
src/app/                pages: landing/home, send, receive, pay, schedules, activity, status, auth/approve; /api routes
src/components/         design system (ui.tsx), shell (floating nav), landing, auth, pay, transfers
src/lib/client/         wallet provider (Nimiq + EVM), session (sign-in), API client, hooks
src/lib/server/auth/    Nimiq signature verification, challenges (local/remote/EVM link)
src/lib/server/         config, db, sessions, utility providers (Flutterwave, Reloadly), payment verification, orders, market data,
                        transfers & usernames, scheduled bills, ledger
src/lib/shared/         types, countries, formatting
supabase/migrations/    schema + auth/real-mode migration (RLS deny-by-default)
scripts/                mock providers, API tests, Playwright UI tests
```

## Run locally

```bash
npm install
cp .env.example .env.local     # add provider credentials as you have them
npm run dev -- -H 0.0.0.0      # http://localhost:3000
```

Without `DATABASE_URL`, development uses embedded PGlite (`.data/pglite`). Open the app inside Nimiq Pay (Mini Apps → custom URL `http://<lan-ip>:3000`), or in a desktop browser and sign in with the QR code.

| Feature | Needs |
|---|---|
| Sign-in | a database (`DATABASE_URL` in production) and `APP_URL` |
| Utilities | `FLUTTERWAVE_SECRET_KEY` (a `FLWSECK_TEST-…` key for testing), or Reloadly credentials |
| Pay with NIM | `NIMIQ_MERCHANT_ADDRESS`, `NIMIQ_NETWORK`, `NIMIQ_RPC_URL` |
| Pay with USDT | `POLYGON_MERCHANT_ADDRESS` |
| Exchange rates | nothing extra (public CoinGecko; add `COINGECKO_API_KEY` for volume) |

To test payments without real money, use a Flutterwave **test** key (`FLWSECK_TEST-…`) with Nimiq **testnet** (`NIMIQ_NETWORK=testnet`). Get free testnet NIM in Nimiq Pay's testnet mode (long-press settings for 10 s). Test orders are labelled TEST. USDT (Polygon mainnet) is disabled for test top-ups.

## Deploy (Vercel + Supabase)

1. Create a Supabase project. Migrations apply automatically on first use (or run `supabase db push` and set `DB_AUTO_MIGRATE=false`).
2. Import the repo in Vercel and set the variables — step-by-step guide in [`docs/ENV_SETUP.md`](docs/ENV_SETUP.md). Going live with real payments: [`docs/GO_LIVE.md`](docs/GO_LIVE.md). At minimum `APP_URL`, `DATABASE_URL` (transaction pooler, port 6543; or the Supabase integration's `POSTGRES_URL`), `FLUTTERWAVE_SECRET_KEY`, and the NIM/USDT merchant settings.
3. Deploy, check `/status`, then open `https://nimpay.app/miniapps/open/<your-domain>` on a phone.

For production, use your own Nimiq node or RPC provider (`NIMIQ_RPC_URL`) and a dedicated Polygon RPC (`POLYGON_RPC_URL`). The open defaults are rate-limited.

## Tests

All external services are mocked locally by `scripts/mock-providers.mjs` (shaped after Flutterwave's v3 Bills API, Reloadly's OpenAPI specs, Nimiq and Polygon JSON-RPC). The suites enable them with `AURAPAY_TEST_MODE=true` plus the override URLs listed in `.env.example`.

```bash
npm run build
npm run mock &
AURAPAY_TEST_MODE=true RELOADLY_CLIENT_ID=mock-client RELOADLY_CLIENT_SECRET=mock-secret RELOADLY_MODE=sandbox \
  NIMIQ_NETWORK=testnet NIMIQ_MERCHANT_ADDRESS="NQ07 0000 0000 0000 0000 0000 0000 0000 0000" NIMIQ_RPC_URL=http://localhost:4010/nimiq \
  POLYGON_MERCHANT_ADDRESS=0x1111111111111111111111111111111111111111 POLYGON_RPC_URL=http://localhost:4010/polygon \
  ALLOW_REAL_PAYMENTS_FOR_SANDBOX=true ADMIN_API_TOKEN=test-admin-token-123 RATE_LIMIT_MULTIPLIER=10 PGLITE_DIR=memory \
  RELOADLY_AUTH_URL_OVERRIDE=http://localhost:4010/auth/oauth/token RELOADLY_AIRTIME_URL_OVERRIDE=http://localhost:4010/airtime \
  RELOADLY_UTILITIES_URL_OVERRIDE=http://localhost:4010/utilities COINGECKO_URL_OVERRIDE=http://localhost:4010/coingecko npm start &
# Runs against whichever utility provider is configured. For Flutterwave, replace the RELOADLY_* vars with
#   FLUTTERWAVE_SECRET_KEY=FLWSECK_TEST-mock-X FLUTTERWAVE_URL_OVERRIDE=http://localhost:4010/flw
npm run test:api   # 52 tests: sign-in (local, remote, tampering, replay), EVM linking, NIM/USDT verification,
                   # idempotency, exactly-once fulfilment, scheduled bills, refunds, isolation, usernames & transfers
npm run test:ui    # Playwright: landing, QR sign-in, simulated Nimiq Pay host with real signatures,
                   # every page at mobile + desktop, slide-to-pay purchase, scheduled bill, @username claim, send by username
```

`npm run typecheck` and `npm run lint` are clean.

## Admin API

```bash
curl -H "Authorization: Bearer $ADMIN_API_TOKEN" https://<host>/api/admin/orders
curl -X POST -H "Authorization: Bearer $ADMIN_API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"refundTxHash":"<hash>"}' https://<host>/api/admin/orders/<id>/refund     # verified on-chain
```

## Known limitations

* Sending USDT needs a little POL for Polygon gas in the sender's wallet. Transfers are final: AuraPay can't reverse them.
* Rate limiting is per server instance.
