# Going live

AuraPay switches to live fulfilment automatically when `FLUTTERWAVE_SECRET_KEY` is a live key (`FLWSECK-…`, not `FLWSECK_TEST-…`). Live mode means real airtime, data and electricity are delivered and real crypto is accepted. Use this checklist.

## 1. Flutterwave

- [ ] Business verification (KYC) approved and **Live mode** enabled in the dashboard.
- [ ] **Bills** enabled on the account. Ask Flutterwave support if bill payments return "not enabled".
- [ ] **Fund the balance in local currency** (e.g. NGN for Nigeria): Dashboard → Balances. Bills are debited from it, not from USD.
- [ ] **IP whitelisting on, with a static IP.** Live Bills refuses payments unless IP whitelisting is enabled ("Please enable IP Whitelisting to access this service"), and Vercel's outgoing IPs change. So send Flutterwave traffic through a static-IP proxy:
  1. Get a static outbound proxy: **QuotaGuard Static** (quotaguard.com) or **Fixie** (usefixie.com); both have free/cheap plans. They give you a proxy URL like `http://user:pass@host:port` and **two fixed IPs**.
  2. In Vercel, set `FLUTTERWAVE_PROXY_URL` to that URL (`QUOTAGUARDSTATIC_URL` / `FIXIE_URL` from their Vercel integrations also work). Only Flutterwave calls use it.
  3. In Flutterwave → Settings → **Whitelisted IP addresses**: enable it and add both IPs.
  4. Redeploy, then `/status` → Utilities shows `staticIpProxy: <proxy host>`.
- [ ] Copy the live **Secret key** (Settings → API Keys).

## 2. Vercel → Settings → Environment Variables (Production)

| Variable | Live value |
|---|---|
| `FLUTTERWAVE_SECRET_KEY` | `FLWSECK-…` (live) |
| `FLUTTERWAVE_PROXY_URL` | your static-IP proxy URL (QuotaGuard Static / Fixie); whitelist its IPs in Flutterwave |
| `NIMIQ_NETWORK` | `mainnet` |
| `NIMIQ_MERCHANT_ADDRESS` | your **mainnet** NIM address that receives payments |
| `NIMIQ_RPC_URL` | empty (uses `rpc.nimiqwatch.com`) or your own node |
| `POLYGON_MERCHANT_ADDRESS` | your `0x…` address that receives USDT |
| `ADMIN_API_TOKEN` | a long random value (for refunds) |
| `CRON_SECRET` | a long random value; set up the 5-minute runner call (see ENV_SETUP) |
| `SAVINGS_VAULT_ADDRESS` | your deployed Savings Vault (see ENV_SETUP); Savings is off without it |
| `SAVINGS_RELAYER_PRIVATE_KEY` | optional: a gas-only wallet's key for automatic release at unlock time |
| `NIM_POLYGON_TOKEN` | optional: NIM's Polygon contract, once bridged (enables Swap) |
| `ALLOW_REAL_PAYMENTS_FOR_SANDBOX` | **delete it** |
| `AURAPAY_TEST_MODE` | **delete it** if present |
| `AURAPAY_SERVICE_FEE_BPS` | **leave unset** (AuraPay is free; default `0`) |
| `AURAPAY_MIN_SERVICE_FEE_USD` | **leave unset** (default `0`) |

Then **Redeploy**.

Safety rules enforced by the code: live top-ups can't be paid with testnet NIM, and NIM only works when `NIMIQ_NETWORK=mainnet`.

## 3. Verify

1. Open `/status`. Utilities should read **Flutterwave · Live**, and NIM and USDT should both be available.
2. Switch Nimiq Pay back to **mainnet**.
3. Make one small real purchase, e.g. ₦100 airtime to your own number, paid with NIM. Check the receipt and that the airtime arrived.

## 4. Operating it

- **Dashboard:** open `/admin` and unlock it with your `ADMIN_API_TOKEN` to see users (total, with a @username, with a verified Polygon wallet, with a photo), active users over 24 h / 7 days / 30 days, new users per day, bills, transfers, swaps, Earn, Savings and Thrift, plus the newest users (addresses shortened). The token stays in that browser tab only; **Lock** forgets it.

- **Scheduled bills are prepaid.** Customers pay every run up front; AuraPay pays the provider at each run time from your Flutterwave balance, at the local amount fixed when they scheduled. You carry the crypto/local-currency price movement in between. If a customer cancels, their unrun payments are owed back: list them with `GET /api/admin/schedules`, send the refund from the merchant wallet, then record it with `POST /api/admin/schedules/<id>/refund` (`{"refundTxHash":"<hash>"}`, verified on-chain).

- **Earn and Swap** run entirely from the user's wallet on Polygon; users need a little **POL** for gas (the screens warn below 0.01 POL). AuraPay only records and verifies the transactions.

- Customer payments arrive in your merchant wallets. Bills are paid from your Flutterwave balance, so keep it topped up and convert crypto to local currency as needed.
- If Flutterwave fails after a verified payment (e.g. low balance, IP whitelisting), the order goes to **requires review** and the customer sees that. If the provider **clearly rejected** it (nothing delivered), fix the cause and **retry**: it's sent once more under a new reference (`<ref>-R1`):

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_API_TOKEN" https://<host>/api/admin/orders/<id>/retry
```

  Otherwise (or if you'd rather not deliver it) refund or resolve it:

```bash
# list orders needing attention
curl -H "Authorization: Bearer $ADMIN_API_TOKEN" https://<host>/api/admin/orders

# refund: send the payment back from the merchant wallet, then record it (verified on-chain)
curl -X POST -H "Authorization: Bearer $ADMIN_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"refundTxHash":"<hash>"}' https://<host>/api/admin/orders/<id>/refund

# or, if you confirmed delivery with Flutterwave, mark the outcome
curl -X POST -H "Authorization: Bearer $ADMIN_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"status":"successful","note":"Confirmed in Flutterwave dashboard"}' https://<host>/api/admin/orders/<id>/resolve
```
