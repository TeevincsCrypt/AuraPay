# Going live

AuraPay switches to live fulfilment automatically when `FLUTTERWAVE_SECRET_KEY` is a live key (`FLWSECK-…`, not `FLWSECK_TEST-…`). Live mode means real airtime, data and electricity are delivered and real crypto is accepted. Use this checklist.

## 1. Flutterwave

- [ ] Business verification (KYC) approved and **Live mode** enabled in the dashboard.
- [ ] **Bills** enabled on the account. Ask Flutterwave support if bill payments return "not enabled".
- [ ] **Fund the balance in local currency** (e.g. NGN for Nigeria): Dashboard → Balances. Bills are debited from it, not from USD.
- [ ] **IP whitelisting off** (Settings → Whitelisted IP addresses). Vercel has no fixed IPs, so a whitelist blocks every request.
- [ ] Copy the live **Secret key** (Settings → API Keys).

## 2. Vercel → Settings → Environment Variables (Production)

| Variable | Live value |
|---|---|
| `FLUTTERWAVE_SECRET_KEY` | `FLWSECK-…` (live) |
| `NIMIQ_NETWORK` | `mainnet` |
| `NIMIQ_MERCHANT_ADDRESS` | your **mainnet** NIM address that receives payments |
| `NIMIQ_RPC_URL` | empty (uses `rpc.nimiqwatch.com`) or your own node |
| `POLYGON_MERCHANT_ADDRESS` | your `0x…` address that receives USDT |
| `ADMIN_API_TOKEN` | a long random value (for refunds) |
| `CRON_SECRET` | a long random value; set up the 5-minute runner call (see ENV_SETUP) |
| `ALLOW_REAL_PAYMENTS_FOR_SANDBOX` | **delete it** |
| `AURAPAY_TEST_MODE` | **delete it** if present |
| `AURAPAY_SERVICE_FEE_BPS` | optional, default `150` (1.5%) |
| `AURAPAY_MIN_SERVICE_FEE_USD` | optional, default `0.10` |

Then **Redeploy**.

Safety rules enforced by the code: live top-ups can't be paid with testnet NIM, and NIM only works when `NIMIQ_NETWORK=mainnet`.

## 3. Verify

1. Open `/status`. Utilities should read **Flutterwave · Live**, and NIM and USDT should both be available.
2. Switch Nimiq Pay back to **mainnet**.
3. Make one small real purchase, e.g. ₦100 airtime to your own number, paid with NIM. Check the receipt and that the airtime arrived.

## 4. Operating it

- **Scheduled bills are prepaid.** Customers pay every run up front; AuraPay pays the provider at each run time from your Flutterwave balance, at the local amount fixed when they scheduled. You carry the crypto/local-currency price movement in between. If a customer cancels, their unrun payments are owed back: list them with `GET /api/admin/schedules`, send the refund from the merchant wallet, then record it with `POST /api/admin/schedules/<id>/refund` (`{"refundTxHash":"<hash>"}`, verified on-chain).

- Customer payments arrive in your merchant wallets. Bills are paid from your Flutterwave balance, so keep it topped up and convert crypto to local currency as needed.
- If Flutterwave fails after a verified payment (e.g. low balance), the order goes to **requires review** and the customer sees that. To resolve:

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
