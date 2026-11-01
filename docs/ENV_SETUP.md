# AuraPay — environment variables setup

Add these in **Vercel → your project → Settings → Environment Variables** (environment: *Production*, and *Preview* if you use preview links). Vercel only applies new variables to new deployments, so after adding them go to **Deployments → ⋯ → Redeploy**.

After redeploying, open `https://<your-domain>/status`. It shows which integrations are connected and why anything is off.

---

## 1. Required: the app won't work without these

### `DATABASE_URL`

AuraPay stores accounts, orders and activity in Postgres. Supabase's free tier is enough.

1. Go to <https://supabase.com> → **New project**. Pick a region close to your Vercel region (for example US East, to match Vercel's `iad1`) and set a database password. Save the password.
2. When the project is ready, click **Connect** (top of the project page).
3. Choose **Transaction pooler** (port **6543**). Vercel serverless functions need the pooler.
4. Copy the URI. It looks like:
   `postgresql://postgres.abcdefghijkl:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres`
5. Replace `[YOUR-PASSWORD]` with your database password. If the password has special characters (`@ # / ? %`), URL-encode them, or reset the password to letters and digits only.

```
DATABASE_URL=postgresql://postgres.abcdefghijkl:yourpassword@aws-0-us-east-1.pooler.supabase.com:6543/postgres
```

AuraPay creates its tables on first use (each migration runs once). Set `DB_AUTO_MIGRATE=false` only if you apply migrations yourself with `supabase db push`.

If you connected Supabase through Vercel's **Supabase integration** instead, you don't need to add anything: AuraPay also reads the `POSTGRES_URL` it creates.

**If the app still says "the database (DATABASE_URL) is not set":**

* In Vercel → **Settings → Environment Variables**, check that the variable is ticked for **Production** (not only Preview/Development) and that the name is exactly `DATABASE_URL`.
* Paste the value without quotes or spaces.
* **Redeploy.** Vercel only applies new variables to new deployments: **Deployments** → latest → **⋯** → **Redeploy**.
* Open the production domain, not an older deployment URL.

### `APP_URL`

The public address of your deployment, without a trailing slash. It goes into sign-in messages and into the Nimiq Pay deep links behind the sign-in QR codes.

```
APP_URL=https://your-project.vercel.app
```

Find it in Vercel → your project → **Domains**. Use your custom domain if you add one later.

---

## 2. Pay: airtime, data and electricity

### `FLUTTERWAVE_SECRET_KEY`

Flutterwave Bills delivers airtime, data bundles and electricity (prepaid/postpaid meters).

1. Sign up at <https://dashboard.flutterwave.com/signup> and log in.
2. Switch the dashboard to **Test mode** (toggle at the top).
3. Open **Settings → API Keys** and copy the **Secret key**. Test keys start with `FLWSECK_TEST-`.
4. For real top-ups: complete Flutterwave's business verification (KYC), switch to **Live mode**, copy the live secret key (`FLWSECK-…`), and fund your Flutterwave balance in the local currency of the countries you serve (e.g. NGN). Bills are paid from that balance.

```
FLUTTERWAVE_SECRET_KEY=FLWSECK_TEST-xxxxxxxxxxxxxxxxxxxx-X
```

AuraPay detects test vs live from the key: a `FLWSECK_TEST-` key runs in test mode (orders labelled TEST, nothing delivered). Only the secret key is needed; it is used server-side only. The public and encryption keys are not used.

Prices: Flutterwave charges bills in local currency. AuraPay converts the exact amount (plus any biller fee) to USD with Flutterwave's own rate (`/v3/transfers/rates`), then adds the AuraPay fee.

*Alternative:* AuraPay still supports Reloadly (`RELOADLY_CLIENT_ID`, `RELOADLY_CLIENT_SECRET`, `RELOADLY_MODE`). If both are set, Flutterwave is used unless `UTILITY_PROVIDER=reloadly`.

### `NIMIQ_MERCHANT_ADDRESS`, `NIMIQ_NETWORK`, `NIMIQ_RPC_URL`: receive NIM

The address where customers' NIM payments arrive. It's your own wallet: AuraPay never holds keys.

1. In Nimiq Pay, open your account and copy your address (`NQ.. .... ....`). A dedicated business account is best.
2. Pick the network:
   * **Testing (with a `FLWSECK_TEST-` key):** use `testnet`. Test top-ups can only be paid with free testnet NIM. In Nimiq Pay, long-press Settings for 10 seconds to switch to testnet and tap **Get free NIM**. Your testnet address is what goes in `NIMIQ_MERCHANT_ADDRESS`.
   * **Live (with a live `FLWSECK-` key):** use `mainnet`.
3. `NIMIQ_RPC_URL` is a Nimiq node that AuraPay uses to check payments on-chain.
   * Mainnet: you can leave it empty; AuraPay then uses the open server `https://rpc.nimiqwatch.com` (fine for a hackathon, rate-limited).
   * Testnet: there's no default. Pick a testnet server from <https://www.nimiq.dev/rpc/open-servers> or run your own node (<https://www.nimiq.dev/rpc/rpc-node-setup>).

```
NIMIQ_MERCHANT_ADDRESS=NQ12 3456 7890 ABCD EFGH JKLM NPQR STUV
NIMIQ_NETWORK=testnet          # or mainnet
NIMIQ_RPC_URL=https://...      # required for testnet
```

### `POLYGON_MERCHANT_ADDRESS`: receive USDT

The `0x…` address that receives USDT on Polygon. Your Nimiq Pay EVM (USDT) address works.

```
POLYGON_MERCHANT_ADDRESS=0x...
```

USDT exists only on Polygon *mainnet*, so it is disabled while the utility provider is in test mode. That stops real money from paying for test top-ups.

---

## 3. Recommended

### `ADMIN_API_TOKEN`

Protects the admin endpoints used to review failed orders and record refunds. Generate a random value:

```bash
openssl rand -hex 32
```

```
ADMIN_API_TOKEN=<the random value>
```

### `COINGECKO_API_KEY`

NIM/USDT exchange rates and tokenised-stock prices come from CoinGecko. The keyless API is heavily rate-limited, and Vercel's IPs are shared, so add a free **Demo** key:

1. Sign up at <https://www.coingecko.com/en/api/pricing> and choose the free **Demo** plan.
2. In the developer dashboard, create an API key.

```
COINGECKO_API_KEY=CG-...
COINGECKO_PRO=false
```

---

## 4. Optional

| Variable | What it adds | Where to get it |
|---|---|---|
| `FINNHUB_API_KEY` | Listed share prices, company logos, US market open/closed | <https://finnhub.io/register> (free) |
| `TWELVEDATA_API_KEY` | Listed share price history for charts | <https://twelvedata.com/register> (free) |
| `BASE_RPC_URL`, `POLYGON_RPC_URL`, `ARBITRUM_RPC_URL`, `ETHEREUM_RPC_URL` | Your own RPC endpoints instead of the rate-limited public ones | Alchemy, Infura, QuickNode, etc. (free tiers) |
| `COW_PARTNER_FEE_BPS` + `COW_PARTNER_FEE_RECIPIENT` | Earn a fee on stock purchases (e.g. `25` = 0.25%) paid to your `0x…` address | CoW Protocol partner fee; no sign-up needed |
| `AURAPAY_SERVICE_FEE_BPS` | AuraPay's fee on utility payments (default `150` = 1.5%) | — |

Without Finnhub/Twelve Data, prices and charts use the live market price of the tokenised stocks (CoinGecko), labelled as such.

---

## Minimum to get running for the hackathon

```
APP_URL=https://your-project.vercel.app
DATABASE_URL=postgresql://...:6543/postgres
FLUTTERWAVE_SECRET_KEY=FLWSECK_TEST-...
NIMIQ_NETWORK=testnet
NIMIQ_MERCHANT_ADDRESS=NQ.. (testnet)
NIMIQ_RPC_URL=https://... (testnet RPC)
COINGECKO_API_KEY=CG-...
ADMIN_API_TOKEN=...
```

Then redeploy, check `/status`, and open `https://nimpay.app/miniapps/open/<your-domain>` on your phone.
