# AuraPay — integrations and architecture

AuraPay runs **real integrations only**. There are no simulators and no demo data; when a provider is unreachable or not configured, the feature says so (see `/status` or `GET /api/status`).

| Capability | How it works | Source of truth |
|---|---|---|
| Sign-in | Nimiq Pay signs a one-time challenge; server verifies the Ed25519 signature and derives the address | Signature |
| NIM payments | `sendBasicTransactionWithData` with an order-reference memo | Nimiq JSON-RPC (`getTransactionByHash`) |
| USDT payments | ERC-20 `transfer` on Polygon from a signature-verified EVM wallet | Polygon receipt + `Transfer` log |
| Airtime / data / electricity | Flutterwave Bills v3 (test keys labelled TEST); Reloadly as an alternative | Flutterwave / Reloadly API |
| Transfers | Wallet to wallet by @username (NIM on Nimiq, USDT on Polygon) | Nimiq / Polygon RPC (tx verified against the transfer intent) |
| Prices | CoinGecko (NIM, USDT) | — |

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

**EVM wallet linking.** Nimiq Pay also injects an EVM wallet (`window.ethereum`). It is linked to the account only after `personal_sign` of a server challenge, verified with viem. USDT payments and transfers are accepted only from verified addresses, and USDT sent to a @username goes to one of its owner's verified addresses.

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

## 3. Usernames & transfers

* **@username:** 3–20 lowercase letters, digits or `_`, starting with a letter (unique; a few names reserved). It points to the owner's **Nimiq address** (the one they signed in with) and, for USDT, one of their **signature-verified Polygon addresses**. Lookups (`GET /api/users/<name>`) are for signed-in users only and rate limited.
* **Non-custodial:** the sender's wallet pays the recipient's address directly. AuraPay charges nothing and never touches the funds.

```
created (intent: recipient address, exact amount, memo fixed) ─(tx hash)─▶ pending ─(verified)─▶ confirmed
                                                                                   └─(mismatch / not found in 1 h)─▶ failed
created ─(unused for 30 min)─▶ expired
```

* **NIM:** the transaction must pay the recipient's address at least the amount, with the memo `AuraPay <ref> [note]` (binds the tx to this transfer).
* **USDT:** the Polygon receipt must contain a `Transfer` of exactly the amount from the sender's verified wallet to the recipient's.
* A tx hash can be recorded once (`transfers unique (chain, tx_hash)`). On confirmation, the sender's ledger entry becomes successful and a "Received from @…" entry is added for the recipient.
* **Receive** shows a QR code / share link `https://nimpay.app/miniapps/open/<host>/send?to=<username>&currency=…&amount=…` that opens AuraPay's Send screen in Nimiq Pay, plus the raw addresses.

## 3b. Display currency

`users.display_currency` (USD, NGN, GHS, KES, UGX). `GET /api/rates?fiat=NGN` adds USD→local from the bill provider's own rate (Flutterwave `/v3/transfers/rates`, i.e. what bills are priced at), falling back to CoinGecko's USDT price in that currency. No invented rates: if neither answers, local amounts are hidden. Payments are always made in NIM/USDT.

## 3c. Recurring payments & bill reminders

A self-custodial wallet can't be charged automatically, so `recurring_items` are created from a real completed bill order or transfer (`POST /api/recurring {orderId|transferId, frequency, firstDueAt}`) and become **due** on schedule (Home "Due soon", Scheduled → Reminders). "Pay now" opens the prefilled flow (`/pay?recurring=<id>`, `/send?…&recurring=<id>`). An item advances only when a matching **verified** payment exists after its creation (same service + recipient, or a confirmed transfer to the same @username), whether paid from the reminder or normally. `GET /api/recurring/<id>/ics` returns an iCalendar event with the repeat rule and an alert. Bills that should pay themselves use prepaid Autopay (§2b).

## 3d. Thrift (rotating group savings)

`savings_circles` + `circle_members` (payout `position`). The organizer invites @usernames; members accept/decline (USDT circles require a verified wallet); the organizer starts it once everyone has replied. Round *k* goes to member *k* and is due at start + (k−1) periods. A contribution is an ordinary transfer intent with `circleId` + `round`: it must come from a member other than the round's recipient, go to that recipient, and be exactly the contribution amount and currency, once per member per round (`ALREADY_CONTRIBUTED`). Progress is derived from confirmed transfers; the circle completes when every round is fully paid. Members pay each other directly, so AuraPay never holds the pot (it can't force a member to pay; members should trust each other).

## 3e. Earn (Aave V3) and Swap (QuickSwap), Polygon only

Both run from the user's own wallet through injected `window.ethereum` (Nimiq Pay's Polygon wallet). The app always switches to Polygon (`0x89`) first, needs a little POL for gas, and never holds funds.

| Contract | Address |
|---|---|
| USDT | `0xc2132D05D31c914a87C6611C10748AEb04B58e8F` |
| Aave V3 Pool | `0x794a61358D6845594F94dc1DB02A252b5b4814aD` |
| aPolUSDT | `0x6ab707Aca953eDAeFBc4fD23bA73294241490620` |
| QuickSwap V2 Router | `0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff` |

* **Position** (`GET /api/earn/position?address=`): wallet USDT, aPolUSDT (= supplied + interest), POL, Pool allowance and the APY from `getReserveData(USDT).currentLiquidityRate` (RAY, compounded per second). Not hardcoded.
* **Deposit**: `approve(Pool, exact amount)` (reset to 0 first if a smaller allowance exists, as USDT requires), then `supply(USDT, amount, user, 0)`. **Withdraw**: `withdraw(USDT, amount | MAX_UINT256, user)`. No borrowing anywhere.
* **Swap** (`GET /api/swap/config` → `pairs.POL`, `pairs.NIM`): each pair is on when `router.factory().getPair(token, USDT)` exists with ≥ 1 USDT of liquidity. **POL** uses WPOL (`0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270`): USDT → POL is `swapExactTokensForETH` after an exact USDT approval; POL → USDT is payable `swapExactETHForTokens` (the app keeps 0.05 POL for gas). **NIM** additionally needs `NIM_POLYGON_TOKEN`, and uses `swapExactTokensForTokens`. Quotes use `getAmountsOut`; minOut is −0.5%, deadline now + 10 min.
* **Verification**: every tx is recorded (`POST /api/defi/actions {kind, txHash, from, …}` → `defi_actions` + an Activity row) and confirmed only from its Polygon **receipt**: status success, sent by the user's verified wallet to the Pool/Router, and a USDT `Transfer` user → aPolUSDT (supply), aPolUSDT → user (withdraw; actual amount incl. "max"), or tokenIn from / tokenOut to the user (token swaps). Native POL never appears as a Transfer, so POL legs are checked from the calldata (recipient = the user, path, `value`) plus the router's WPOL `Withdrawal` (USDT → POL, amount out) or `Deposit` (POL → USDT, = tx value). A hash can be recorded once (`TX_ALREADY_USED`). Unconfirmed after 30 min → failed.
* **Hand-off**: after a withdrawal or a swap into USDT, "Pay a bill" opens `/pay?payWith=USDT&from=earn|swap` (USDT preselected) and "Add to thrift" opens your due USDT thrift contribution.

## 3f. Savings: time-locked USDT (AuraPay Savings Vault)

[`contracts/src/AuraPaySavingsVault.sol`](../contracts/src/AuraPaySavingsVault.sol): `lock(token, amount, unlockAt)` pulls the tokens and records a lock for `msg.sender` (amount = what actually arrived; unlock between now and 10 years). `release(id)` works only once `block.timestamp >= unlockAt`, only once, and always transfers to the lock's owner, whoever calls it. No owner, admin, fee or upgrade path; re-entrancy guarded. Tests: `cd contracts && npm i && npm test` (Hardhat, solc 0.8.24).

* **Lock** (app): exact USDT approval to the vault → `lock(USDT, units, unlockAt)` from the user's wallet → `POST /api/savings/locks {txHash, from, label}`. Confirmed only from the receipt: success, sent by the user's verified wallet to the vault, with the vault's `Locked` event for that owner and USDT; amount, on-chain id and unlock time come from the event.
* **Release**: the cron runner (`/api/cron/schedules`) finds matured locks and, if `SAVINGS_RELAYER_PRIVATE_KEY` is set, sends `release(id)` from that gas-only key (it can't receive anything). Owners can also tap **Withdraw to wallet** (`POST /api/savings/locks/<id>/release {txHash}`, verified from the `Released` event). Releases by anyone else are picked up from `getLock(id).released`.
* Locks don't earn interest (Earn does). NIM can't be locked: Nimiq Pay mini apps can't create Nimiq's native time-locked contracts.

## 3g. Profile pictures

The browser center-crops and re-encodes the photo at 320 px (WebP, else JPEG) and `PUT /api/me/avatar {image: dataURL}`. The server accepts only JPEG/PNG/WebP identified by their magic bytes (never SVG), ≤ 256 KB, stores it in `user_avatars`, and serves `GET /api/avatars/<userId>?v=<n>` (immutable, `nosniff`, `default-src 'none'; sandbox`). `avatarUrl` is on the session and on `GET /api/users/<username>`.

## 4. Data model

Migrations: `supabase/migrations/` (applied in order on first use). `stock_trades` and `lending_actions` remain from the removed Invest/Borrow features but are unused.

The second migration adds `sessions`, `auth_challenges`, `stock_trades` and `lending_actions`, makes users identified by `nimiq_address`, and requires verified EVM wallets. It also **deletes all records created by the former simulators** and narrows constraints, so `DEMO` payments can no longer exist. RLS is enabled with no policies everywhere, and `anon`/`authenticated` privileges are revoked: only the server connection can access data.

## 5. Security checklist

* No keys or seed phrases are ever requested or stored. Every payment and transaction is approved in Nimiq Pay.
* Secrets are server-only; the logger redacts secret-like keys.
* Zod validation on all inputs; per-client rate limits; idempotency keys; unique tx hashes; conditional state transitions.
* Admin endpoints require `ADMIN_API_TOKEN`; refunds require on-chain proof.
* Mock-provider overrides work only with `AURAPAY_TEST_MODE=true`, which is refused on Vercel production deployments.
