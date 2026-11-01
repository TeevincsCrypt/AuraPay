# AuraPay

**Your money. Without borders.**

AuraPay is a Nimiq Pay Mini App for African users:

1. **Pay**: airtime, mobile data and electricity in Nigeria, Ghana, Kenya, Uganda, South Africa and Tanzania, paid with **NIM** or **USDT** (fulfilled by Reloadly).
2. **Invest**: tokenised US stocks (NVIDIA, Apple, Microsoft, Tesla, Amazon, Alphabet, Meta, AMD, Netflix, Coinbase), bought through CoW Protocol and held in your own wallet.
3. **Borrow**: USDC against your stock tokens through Aave V4 on Base, without selling them.

Everything is real: there is no demo mode and no simulated data. Users sign in with a **Nimiq Pay wallet signature**, inside the app with one tap, or from any other browser by approving a QR code / code in Nimiq Pay. Details: [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md). Live integration state: **/status**.

---

## Stack

* Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS 4
* `@nimiq/mini-app-sdk` (NIM, signatures) + EIP-1193 `window.ethereum` (USDT, stocks, Aave) + `viem`
* `@cowprotocol/widget-lib` (stock purchases), Aave V4 contracts on Base
* Postgres / Supabase (`postgres`), embedded PGlite for local development only
* `@noble/curves` + `@noble/hashes` (Nimiq signature verification), Zod, `libphonenumber-js`, `qrcode`

```
src/app/                pages: landing/home, invest, borrow, pay, activity, status, auth/approve; /api routes
src/components/         design system (ui.tsx), charts, shell (floating nav), landing, auth, pay, invest
src/lib/client/         wallet provider (Nimiq + EVM), session (sign-in), API client, hooks
src/lib/server/auth/    Nimiq signature verification, challenges (local/remote/EVM link)
src/lib/server/         config, db, sessions, Reloadly, payment verification, orders, market data,
                        investing (CoW + on-chain holdings), lending (Aave V4), EVM RPC, ledger
src/lib/shared/         types, stock-token registry, Aave constants/ABI, countries, formatting
supabase/migrations/    schema + auth/real-mode migration (RLS deny-by-default)
scripts/                mock providers, API tests, Playwright UI tests
```

## Run locally

```bash
npm install
cp .env.example .env.local     # set at least SESSION_SECRET; add provider credentials as you have them
npm run dev -- -H 0.0.0.0      # http://localhost:3000
```

Without `DATABASE_URL`, development uses embedded PGlite (`.data/pglite`). Open the app inside Nimiq Pay (Mini Apps → custom URL `http://<lan-ip>:3000`), or in a desktop browser and sign in with the QR code.

| Feature | Needs |
|---|---|
| Sign-in | `SESSION_SECRET` (and `APP_URL` in production) |
| Utilities | `RELOADLY_CLIENT_ID`, `RELOADLY_CLIENT_SECRET` (`RELOADLY_MODE=sandbox` for testing) |
| Pay with NIM | `NIMIQ_MERCHANT_ADDRESS`, `NIMIQ_NETWORK`, `NIMIQ_RPC_URL` |
| Pay with USDT | `POLYGON_MERCHANT_ADDRESS` |
| Prices, investing, borrowing | nothing extra (public CoinGecko + public RPCs; set your own RPCs/keys for volume) |
| Listed share prices | optional `FINNHUB_API_KEY`, `TWELVEDATA_API_KEY` |

To test payments without real money, use Reloadly **sandbox** with Nimiq **testnet** (`RELOADLY_MODE=sandbox`, `NIMIQ_NETWORK=testnet`). Get free testnet NIM in Nimiq Pay's testnet mode (long-press settings for 10 s). Sandbox orders are labelled TEST. USDT (Polygon mainnet) is disabled for sandbox top-ups.

## Deploy (Vercel + Supabase)

1. Create a Supabase project. Apply migrations with `supabase db push` (or set `DB_AUTO_MIGRATE=true`).
2. Import the repo in Vercel and set the variables from `.env.example`: at minimum `APP_URL`, `SESSION_SECRET`, `DATABASE_URL` (transaction pooler, port 6543), the Reloadly credentials, and the NIM/USDT merchant settings.
3. Deploy, check `/status`, then open `https://nimpay.app/miniapps/open/<your-domain>` on a phone.

For production, use your own Nimiq node or RPC provider (`NIMIQ_RPC_URL`) and dedicated EVM RPCs (`BASE_RPC_URL`, `ARBITRUM_RPC_URL`, `ETHEREUM_RPC_URL`, `POLYGON_RPC_URL`). The open defaults are rate-limited.

## Tests

All external services are mocked locally by `scripts/mock-providers.mjs` (shaped after Reloadly's OpenAPI specs, Nimiq/EVM JSON-RPC, CoW's order book and Aave V4's ABI). The suites enable them with `AURAPAY_TEST_MODE=true` plus the override URLs listed in `.env.example`.

```bash
npm run build
npm run mock &
AURAPAY_TEST_MODE=true RELOADLY_CLIENT_ID=mock-client RELOADLY_CLIENT_SECRET=mock-secret RELOADLY_MODE=sandbox \
  NIMIQ_NETWORK=testnet NIMIQ_MERCHANT_ADDRESS="NQ07 0000 0000 0000 0000 0000 0000 0000 0000" NIMIQ_RPC_URL=http://localhost:4010/nimiq \
  POLYGON_MERCHANT_ADDRESS=0x1111111111111111111111111111111111111111 POLYGON_RPC_URL=http://localhost:4010/polygon \
  ALLOW_REAL_PAYMENTS_FOR_SANDBOX=true ADMIN_API_TOKEN=test-admin-token-123 RATE_LIMIT_MULTIPLIER=10 PGLITE_DIR=memory \
  RELOADLY_AUTH_URL_OVERRIDE=http://localhost:4010/auth/oauth/token RELOADLY_AIRTIME_URL_OVERRIDE=http://localhost:4010/airtime \
  RELOADLY_UTILITIES_URL_OVERRIDE=http://localhost:4010/utilities COINGECKO_URL_OVERRIDE=http://localhost:4010/coingecko \
  EVM_RPC_URL_OVERRIDE=http://localhost:4010/evm COW_API_URL_OVERRIDE=http://localhost:4010/cow npm start &
npm run test:api   # 34 tests: sign-in (local, remote, tampering, replay), EVM linking, NIM/USDT verification,
                   # idempotency, exactly-once fulfilment, refunds, isolation, holdings, CoW orders, Aave
npm run test:ui    # Playwright: landing, QR sign-in, simulated Nimiq Pay host with real signatures,
                   # every page at mobile + desktop, keypad + slide-to-pay purchase, borrow, buy sheet
```

`npm run typecheck` and `npm run lint` are clean.

## Admin API

```bash
curl -H "Authorization: Bearer $ADMIN_API_TOKEN" https://<host>/api/admin/orders
curl -X POST -H "Authorization: Bearer $ADMIN_API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"refundTxHash":"<hash>"}' https://<host>/api/admin/orders/<id>/refund     # verified on-chain
```

## Known limitations

* Tokenised stocks are subject to issuer eligibility rules (enforced by the CoW widget), and cross-chain buys depend on CoW's bridge routes being available.
* Aave V4's MAG7 market lends **USDC** (not USDT). Users need ETH on Base for gas.
* Rate limiting is per server instance.
