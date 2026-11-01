# AuraPay — integrations and architecture

AuraPay runs **real integrations only**. There are no simulators and no demo data; when a provider is unreachable or not configured, the feature says so (see `/status` or `GET /api/status`).

| Capability | How it works | Source of truth |
|---|---|---|
| Sign-in | Nimiq Pay signs a one-time challenge; server verifies the Ed25519 signature and derives the address | Signature |
| NIM payments | `sendBasicTransactionWithData` with an order-reference memo | Nimiq JSON-RPC (`getTransactionByHash`) |
| USDT payments | ERC-20 `transfer` on Polygon from a signature-verified EVM wallet | Polygon receipt + `Transfer` log |
| Airtime / data / electricity | Flutterwave Bills v3 (test keys labelled TEST); Reloadly as an alternative | Flutterwave / Reloadly API |
| Investing | Tokenised stocks bought through CoW Protocol (CoW Swap widget) by the user's wallet | CoW order book + on-chain balances |
| Borrowing | Aave V4 MAG7 spoke on Base: supply stock tokens, borrow USDC | Aave contracts + tx receipts |
| Prices | CoinGecko (NIM, USDT, tokenised stocks); optional Finnhub / Twelve Data for listed shares | — |

---

## 1. Sign in with Nimiq Pay (inside and outside the app)

**Signature format.** Taken from Nimiq Pay's own mini-app host (`nimiq/nimiq-pay-app`, `useMiniAppHost.ts → sign`):

```
payload   = utf8("\x16Nimiq Signed Message:\n" + byteLength(message)) ‖ utf8(message)
signature = Ed25519.sign(sha256(payload))          // returns hex publicKey + signature
address   = userFriendly(blake2b256(publicKey)[0..20])  // "NQ" + IBAN check digits + base32
```

`src/lib/server/auth/nimiq-signature.ts` implements this with `@noble/curves` / `@noble/hashes`. It was cross-checked against the official `@nimiq/core` package (keys generated and signed with `@nimiq/core`, including multi-byte UTF-8 messages): 150/150 checks matched, including address derivation and checksum validation.

**Inside Nimiq Pay** (`mode: "local"`): `POST /api/auth/challenge` → `nimiq.sign(message)` → `POST /api/auth/verify`. The challenge binds the domain, a random nonce and a 5-minute expiry, says explicitly that it authorises no payment, and is single-use.

**Outside Nimiq Pay** (`mode: "remote"`, any desktop or mobile browser):

1. The browser receives a code (`ABCD-EFGH`), a secret poll token, and a deep link `https://nimpay.app/miniapps/open/<host>/auth/approve?code=…` (Nimiq Pay keeps the path and query; see `nimiq-pay-app/src/lib/mini-app-deeplink.ts`). It shows a QR code of the link.
2. The user scans it (or types the code into AuraPay inside Nimiq Pay). The approval page shows the requesting device and warns against approving codes from others, then signs with `nimiq.sign`.
3. The waiting browser polls with its poll token and receives **its own** session exactly once.

**Sessions** are rows in `sessions`; the HttpOnly cookie holds a random token and only its SHA-256 is stored. Sign-out revokes the row.

**EVM wallet linking.** Nimiq Pay also injects an EVM wallet (`window.ethereum`). It is linked to the account only after `personal_sign` of a server challenge, verified with viem. USDT payments, stock orders and Aave actions are accepted only from verified addresses.

## 2. Utility payments (Flutterwave Bills, or Reloadly)

Bill providers don't accept crypto, so AuraPay is the merchant. Users pay AuraPay; AuraPay pays the provider from its prefunded balance.

The order engine (`src/lib/server/orders/utility.ts`) owns quotes, payment verification, the state machine and refunds. Providers sit behind one interface (`src/lib/server/utilities/provider.ts`): catalogue, pricing, submit, poll.

* **Flutterwave** (`utilities/flutterwave.ts`): catalogue from `GET /v3/bill-categories?country=XX&airtime|data_bundle|power=1`; phone/meter checked with `GET /v3/bill-items/{item}/validate` before quoting (meter customer name shown); USD cost from `GET /v3/transfers/rates` for the exact local amount + fee; `POST /v3/billers/{biller}/items/{item}/payment` with `reference` = order ref (Flutterwave rejects reused references); status and electricity tokens from `GET /v3/bills/{ref}`. Flutterwave cannot look up a number's network, so the user picks it.
* **Reloadly** (`utilities/reloadly.ts`): operator auto-detect, `/topups`, `/pay`, with `customIdentifier`/`referenceId` = order ref.

```
quote ──► wallet payment ──► POST tx hash ──► on-chain verification ──► paid
paid ──(conditional UPDATE, exactly once)──► fulfilling ──► successful | provider_pending | requires_review
requires_review ──(admin, refund tx verified on-chain)──► refunded
```

* Prices are recomputed server-side from fresh provider data; quotes expire after 10 minutes.
* NIM: recipient, amount (≥ quote), memo (`AuraPay <ref>`), execution result, timestamp and confirmations are checked.
* USDT: the receipt must succeed and carry a `Transfer` from the verified payer to the merchant for **exactly** the quoted amount. The last decimals tag the order, because ERC-20 transfers carry no memo.
* A tx hash can pay only one order (`payments (chain, tx_hash)` is unique). The provider reference is the order ref, so a retry can't buy twice.
* A verified payment whose delivery fails or is uncertain goes to `requires_review`, never silently to `failed`. Refunds are sent by an operator from the merchant wallet and recorded only after on-chain verification (`/api/admin/orders/*`).
* Safety rule: sandbox (test) top-ups are never funded with real money unless `ALLOW_REAL_PAYMENTS_FOR_SANDBOX=true`.

## 2b. Scheduled bills

Self-custodial wallets can't be charged later, so schedules are **prepaid**: the user pays all runs (1–12; once, weekly or monthly) in one NIM/USDT payment, verified exactly like an order (`payments` row with `order_kind = 'schedule'`, unique tx hash).

```
quoted ─(tx)─▶ payment_pending ─(verified)─▶ active ─(last run)─▶ completed
active ─(cancel)─▶ cancelled (refund_due_atomic) ─(admin, verified refund tx)─▶ refunded
```

* **Runner:** `GET /api/cron/schedules` with `Authorization: Bearer $CRON_SECRET`, called every few minutes (cron-job.org / Supabase pg_cron; daily Vercel Cron as a fallback). Due schedules also run when their owner opens the app, and a "start now" first run happens right after payment.
* **Exactly once:** a run is claimed by a conditional `UPDATE … where runs_done = n`, and the run's order has a unique `(schedule_id, schedule_run)`. Concurrent runners can't create a run twice.
* **Each run is a normal order**, created already `paid` and fulfilled through the same claim / submit / poll / review path, so receipts, activity, provider references and refunds work unchanged. The provider reference is the run order's own ref.
* Amounts are fixed in local currency at scheduling time; numbers, meters and smartcards are validated then.

## 3. Investing — tokenised stocks via CoW Protocol

**Assets.** `src/lib/shared/stock-tokens.ts` is generated from CoW Protocol's curated RWA registry (`cowprotocol/cowswap/apps/rwa-frontend/data/RWAs.json`, v0.1.9, 2026-10-28). AuraPay buys:

* **Coinbase tokenised stocks on Base** (AAPLc, AMZNc, GOOGLc, METAc, MSFTc, NVDAc, TSLAc, AMDc, NFLXc; 8 decimals), the same tokens Aave V4 accepts as collateral.
* **COINx (xStocks) on Arbitrum** for Coinbase Global, which has no Coinbase-issued token.

Holdings are also read for the xStocks deployments on Arbitrum and Ethereum.

**Execution.** The stock page embeds the **CoW Swap widget** (`@cowprotocol/widget-lib`), the same integration CoW's own RWA app uses. It is driven by the user's Nimiq Pay EVM provider and handles quotes, token approval, EIP-712 order signing, settlement and the issuers' eligibility/geoblocking rules. By default it sells **USDT on Polygon** (where Nimiq Pay keeps USDT) with `targetChainId` set to the token's chain (CoW cross-chain swap); USDC on the destination chain is also offered. An optional CoW partner fee can be configured.

**Verification.** The widget's `ON_POSTED_ORDER` event is sent to `POST /api/invest/trades`. The owner must be a verified wallet, and the output token must match the stock. The order's status and fills are then read from CoW's public order book (`api.cow.fi/<network>/api/v1/orders/<uid>`), and the activity ledger is updated from there.

**Portfolio.** `GET /api/portfolio` reads ERC-20 balances of every registry token for the user's verified wallets on Base, Arbitrum and Ethereum, plus tokens supplied to Aave. Holdings are valued at each token's live CoinGecko price. Cost basis comes only from fulfilled, stablecoin-funded orders AuraPay recorded.

**Caveats shown to users.** Tokenised stocks are issued by third parties, may not confer shareholder rights, and are not available in every jurisdiction. Network fees apply.

## 4. Borrowing — Aave V4 (MAG7 spoke on Base)

Addresses come from Aave's official address book (`bgd-labs/aave-address-book`, `AaveV4Base.sol`):

| Contract | Address |
|---|---|
| MAG7 Spoke | `0x17905Db0e4A3514467539956c084180616AE7B8D` |
| MAG7 Spoke oracle | `0xaBaf048fD7675Ea34a84332371ffd5D55E322A47` |
| Equities Hub | `0xa4d5947Eb727A052bae69C593FfC84247EC9864E` |

ABI fragments are transcribed from `aave/aave-v4` (`ISpoke.sol`, `IAaveOracle.sol`, `IHub.sol`). Units (`SpokeUtils`): Value = 1e26 per USD; debt value additionally RAY-scaled; health factor WAD; collateral factor in BPS; oracle prices have 8 decimals; drawn rate is RAY per year.

* **Reads** (`src/lib/server/lending.ts`): reserves (`getReserveCount`, `getReserve`, `getReserveConfig`, `getDynamicReserveConfig`), prices (`getReservesPrices`), borrow rate (`Hub.getAssetDrawnRate`), and the user's `getUserAccountData`, supplied assets, debt and collateral status. Stock reserves are identified by matching the underlying address against the registry, never by symbol.
* **Writes** are sent by the user's wallet on Base: `approve` → `supply` → `setUsingAsCollateral`; `borrow` USDC; `approve` → `repay`; `withdraw`. The UI projects the health factor and blocks actions that would drop it below 1.25.
* **Verification.** Each tx hash is posted to `/api/borrow/actions`. Its receipt must succeed and come from the verified wallet to the expected contract before the activity ledger shows it as completed.
* Users need ETH on Base for gas. The borrow rate is variable, plus a risk premium Aave may charge.

## 5. Data model

Migrations: `supabase/migrations/20261031000000_init.sql`, `20261101000000_auth_and_real.sql`.

The second migration adds `sessions`, `auth_challenges`, `stock_trades` and `lending_actions`, makes users identified by `nimiq_address`, and requires verified EVM wallets. It also **deletes all records created by the former simulators** and narrows constraints, so `DEMO` payments can no longer exist. RLS is enabled with no policies everywhere, and `anon`/`authenticated` privileges are revoked: only the server connection can access data.

## 6. Security checklist

* No keys or seed phrases are ever requested or stored. Every payment and transaction is approved in Nimiq Pay.
* Secrets are server-only; the logger redacts secret-like keys.
* Zod validation on all inputs; per-client rate limits; idempotency keys; unique tx hashes; conditional state transitions.
* Admin endpoints require `ADMIN_API_TOKEN`; refunds require on-chain proof.
* Mock-provider overrides work only with `AURAPAY_TEST_MODE=true`, which is refused on Vercel production deployments.
