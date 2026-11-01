# AuraPay — integrations, architecture and what is real

This document is the source of truth for **what is live, what runs against a sandbox, and what is simulated**. The app surfaces the same information at runtime on `/status` (and `GET /api/status`).

| Capability | State | Notes |
|---|---|---|
| Nimiq Pay wallet (NIM) | **Real** | Official `@nimiq/mini-app-sdk` (`init`, `listAccounts`, `getBalance`, `sendBasicTransactionWithData`). |
| USDT payments (Polygon) | **Real** | EIP-1193 `window.ethereum` injected by Nimiq Pay; ERC-20 `transfer` on Polygon, per Nimiq's "EVM tokens" guide. |
| Payment verification | **Real** | Server-side, on-chain (Nimiq JSON-RPC / Polygon JSON-RPC). |
| Reloadly airtime & data | **Real API, sandbox by default** | Sandbox transactions are labelled TEST; nothing is delivered. Production = `RELOADLY_MODE=production`. |
| Reloadly electricity | **Real API, sandbox by default** | Billers, pay, transaction status + token. |
| Exchange rates | **Real** | CoinGecko `nimiq-2` and `tether`; no hard-coded fallback price. |
| Market data | **Real with keys** | Finnhub (quotes, logos, market status) + Twelve Data (history). Without keys, dev/demo show a labelled DEMO snapshot; production shows "unavailable". |
| Stock execution | **Not integrated** | No brokerage credentials. Simulated orders only (dev/demo), labelled everywhere. |
| Lending | **Not integrated** | Simulator only (dev/demo), on simulated collateral; never moves funds. |
| Simulated utility payment | **Simulated** | Only in dev/demo **and** only when Reloadly is in sandbox. Lets a browser demo exercise the real sandbox provider without a wallet. |

---

## 1. Nimiq Mini App integration

Sources used: the published SDK package (`@nimiq/mini-app-sdk@0.2.4`, its type definitions and README) and the official docs in `nimiq/developer-center` (`content/mini-apps/**`).

* **Detection.** Nimiq Pay injects `window.nimiq` / `window.nimiqPay` before page scripts run. AuraPay calls `init()`; if nothing is injected it reports "browser" and keeps working in read-only/demo mode with a deep link (`https://nimpay.app/miniapps/open/<host>`).
* **Accounts.** `listAccounts()` (user approval). Addresses are *shared*, not proven — ownership is proven per payment on-chain. Nimiq Pay selects the signer.
* **Balances.** `getBalance(address)` (luna) when the host supports it; otherwise "update Nimiq Pay". USDT balance is read server-side via Polygon `eth_call` so the wallet does not need to switch chains just to display it.
* **Host context.** `window.nimiqPay.network` is compared with `NIMIQ_NETWORK`; a mismatch blocks NIM payment with a clear message.
* **NIM payment.** `sendBasicTransactionWithData({ recipient, value, data })` where `data` is `AuraPay <order-ref>` (≤ 64 bytes). Errors are mapped from `NimiqProviderError.type` (`PERMISSION_DENIED`, `NETWORK_ERROR`, …). A `NETWORK_ERROR` is treated as *outcome unknown*: the UI tells the user to check their wallet history instead of offering an immediate retry.
* **USDT payment.** `eth_requestAccounts` → `wallet_switchEthereumChain(0x89)` → `eth_sendTransaction` with `transfer(merchant, units)` on the USDT contract `0xc2132D05D31c914a87C6611C10748AEb04B58e8F`. User needs POL for gas (shown in UI).
* **No custody.** AuraPay never requests or stores keys or recovery phrases; every payment is approved in the wallet's native dialog.

## 2. Payment orchestration (utilities)

Reloadly does not accept NIM or USDT, so AuraPay is the merchant: users pay AuraPay in crypto, AuraPay pays Reloadly from its prefunded USD wallet.

```
quote (server-priced, 10 min TTL) ──► wallet payment ──► POST tx hash
        │                                                     │
        ▼                                                     ▼
   utility_orders.status = quoted                payments(chain, tx_hash UNIQUE) = submitted
                                                              │ on-chain verification
                                                              ▼
                                   payment_pending ──► paid ──► fulfilling ──► successful
                                                                    │             ▲
                                                                    ├─► provider_pending ─┘
                                                                    └─► requires_review ──► refunded (verified refund tx)
```

1. **Price** — always recomputed server-side from a fresh `GET /operators/{id}` or `GET /billers?id=` call. Client prices are never trusted. Sender currency must be USD.
2. **Convert** — `total_usd → NIM` (rounded up to the luna, with `NIM_SLIPPAGE_BPS` buffer) or `→ USDT` (rounded up to the cent plus a 0.0001–0.0099 per-order tag so an ERC-20 transfer, which has no memo, maps to exactly one order).
3. **Reference** — `AP-XXXXXXXXXX`; used as the NIM memo and as Reloadly's `customIdentifier` / `referenceId` (which Reloadly rejects if reused).
4. **Pay** — via Nimiq Pay (see above). The tx hash is saved locally *before* it is sent to the server so a dropped connection can be resumed.
5. **Verify server-side** —
   * NIM: `getTransactionByHash` → recipient = merchant, value ≥ quote, memo = order ref, `executionResult` not false, timestamp after order creation, confirmations ≥ `NIMIQ_MIN_CONFIRMATIONS`.
   * USDT: `eth_getTransactionReceipt` → status `0x1`, `Transfer` log from the USDT contract, `from` = payer address bound at quote time, `to` = merchant, amount **exactly** the tagged quote, block after order creation, confirmations ≥ `POLYGON_MIN_CONFIRMATIONS`.
6. **No double use** — `payments (chain, tx_hash)` is unique across all order types; a hash that pays one order can never pay another.
7. **Fulfil exactly once** — the `paid → fulfilling` transition is a conditional `UPDATE … WHERE status = 'paid'`; concurrent requests cannot both submit (covered by a test that fires 8 parallel requests).
8. **Provider call** — `POST /topups` (airtime/data) or `POST /pay` (electricity). Money-moving POSTs are never retried automatically.
9. **Status** — `GET /topups/{id}/status`, `GET /transactions/{id}` (electricity token when supplied).
10. **Failure** — verified payment + provider failure / uncertain outcome / payment mismatch ⇒ `requires_review` (never silently `failed`). Operators list these at `GET /api/admin/orders`, send the refund from the merchant wallet, and record it with `POST /api/admin/orders/{id}/refund`, which **verifies the refund transfer on-chain** before marking the order `refunded` and adding a `refund` ledger entry. `POST /api/admin/orders/{id}/resolve` closes an order after manual checks with the provider.

**Sandbox safety rule.** Sandbox (test) top-ups are never funded with real money: NIM must be on testnet, USDT (Polygon has no Nimiq Pay testnet) is disabled for sandbox unless `ALLOW_REAL_PAYMENTS_FOR_SANDBOX=true`.

### Reloadly client

Built against Reloadly's published OpenAPI specs (`Reloadly/reloadly-airtime-documentation`, `Reloadly/reloadly-utility-payments-documentation`):

* OAuth2 client credentials per product audience (`topups[-sandbox]`, `utilities[-sandbox]`), cached until shortly before `expires_in`, single-flight refresh, automatic re-auth on 401.
* Reads retry on 429 (honouring `Retry-After`) and 5xx with backoff; catalogue reads cached 10 minutes.
* Error codes mapped to user-safe messages (`INVALID_RECIPIENT_PHONE`, `INSUFFICIENT_BALANCE`, `PHONE_RECENTLY_RECHARGED`, `COUNTRY_NOT_SUPPORTED`, …).
* Services per country are discovered live (operators split into airtime vs data/bundle operators; electricity via `ELECTRICITY_BILL_PAYMENT` billers). Nothing is hard-coded as available.
* Phone numbers are validated and normalised with `libphonenumber-js`, then operator auto-detected via `/operators/auto-detect/phone/{phone}/countries/{iso}`. Reloadly has no general meter-validation endpoint, so meter numbers are format-checked and the user is warned to double-check; the provider validates at payment time.

## 3. Investing — what a real integration needs

Market data and ownership are separate systems. AuraPay stores **positions** separately from **orders** and from **prices**, and flags every position as `is_simulated` or provider-`verified_at`.

A production stock provider must offer: API order placement, fractional/notional orders, onboarding (KYC) for the target African jurisdictions, verifiable holdings (account positions or on-chain token balances), and a settlement path from NIM/USDT.

Candidates to evaluate (not integrated, no credentials — each needs commercial and legal confirmation):

* **Broker-dealer APIs** (e.g. Alpaca Broker API, DriveWealth): API trading with notional/fractional orders and per-user brokerage accounts. Settlement is in USD, so an intermediary step is needed: AuraPay (or a licensed partner) converts received NIM/USDT to USD and funds the user's account; supported countries and KYC must be confirmed per market.
* **Tokenised-equity issuers** (e.g. Dinari dShares, Backed/xStocks): tokens tracking a share, which could settle in stablecoins on-chain and make holdings verifiable as token balances. Jurisdiction restrictions, redemption rights and whether a token conveys shareholder rights must be confirmed.

Adapter seam: `src/lib/server/investing.ts` (`brokerageStatus`, `estimateOrder`, `placeSimulatedOrder`). A real adapter would add `placeOrder` that only creates a `stock_positions` row with `is_simulated = false` once the provider confirms the fill and sets `verified_at` from provider holdings.

## 4. Lending — what a real integration needs

A real asset-backed loan needs: custody or on-chain locking of *verifiable* collateral (simulated positions and market data never qualify), real USDT liquidity, transparent interest, liquidation execution and repayment rails. Options to evaluate: a regulated securities-based-lending partner of the chosen broker (collateral stays at the broker), or, if equities are tokenised, an on-chain money market that accepts those tokens as collateral. Until then AuraPay runs a clearly labelled simulator: advance rates per asset (25–40%), 40% max LTV, 60% liquidation LTV, simple interest at `SIM_LOAN_APR`.

## 5. Data model

See `supabase/migrations/20261031000000_init.sql`. Tables: `users`, `wallet_connections`, `exchange_rates`, `utility_orders`, `payments`, `transactions` (unified activity ledger), `saved_beneficiaries`, `stocks`, `stock_orders`, `stock_positions`, `loans`, `loan_collateral`.

* RLS is enabled on every table with **no policies**, and privileges are revoked from Supabase's `anon` / `authenticated` roles: browser clients can't touch data; only the server (DATABASE_URL) can.
* Real vs simulated is explicit: `is_simulated`, `is_simulated_payment`, `environment` (`production`/`sandbox`/`simulated`).
* Identity is an anonymous, HMAC-signed HttpOnly session cookie (only its SHA-256 is stored). All order/position/loan reads are scoped to that user.

## 6. Security checklist

* Secrets only in server env vars; nothing `NEXT_PUBLIC_`. Logger redacts secret-looking keys.
* Zod validation on every API input; phone and address formats validated server-side.
* Per-client rate limits on every route (in-memory per instance — add an edge limiter for multi-region).
* Idempotency: `clientRequestId` on quotes and simulated orders; unique tx hashes; conditional state transitions; Reloadly `customIdentifier`.
* Admin endpoints require `ADMIN_API_TOKEN`; refunds require on-chain proof.
* Test-only provider URL overrides are ignored in production mode.
