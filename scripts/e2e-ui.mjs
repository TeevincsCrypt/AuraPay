#!/usr/bin/env node
/**
 * Browser tests (Playwright) against a running AuraPay wired to scripts/mock-providers.mjs.
 *
 *  - Landing page (signed out) at mobile + desktop widths.
 *  - Remote sign-in from a plain browser: QR + code shown, approved via the API with a real
 *    Nimiq-format signature, then the browser lands on the dashboard.
 *  - A simulated Nimiq Pay host: window.nimiq / window.ethereum stand-ins whose sign(),
 *    personal_sign and payments are performed by this test process (Ed25519 / secp256k1),
 *    so the server's cryptographic verification runs for real.
 *  - Every section screenshotted, airtime purchase with slide-to-pay, EVM wallet
 *    verification, scheduled bills, @username claim, Receive and Send by username,
 *    plus a console-error check.
 *
 *   APP=http://localhost:3000 MOCK=http://localhost:4010 OUT=./screenshots node scripts/e2e-ui.mjs
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const { chromium } = createRequire(import.meta.url)("playwright");

const APP = process.env.APP ?? "http://localhost:3000";
const MOCK = process.env.MOCK ?? "http://localhost:4010";
const OUT = process.env.OUT ?? "screenshots";
mkdirSync(OUT, { recursive: true });

const hex = (b) => Buffer.from(b).toString("hex");
function nimSign(privKey, message) {
  const msg = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(`\x16Nimiq Signed Message:\n${msg.length}`);
  const payload = new Uint8Array(prefix.length + msg.length);
  payload.set(prefix);
  payload.set(msg, prefix.length);
  return { publicKey: hex(ed25519.getPublicKey(privKey)), signature: hex(ed25519.sign(sha256(payload), privKey)) };
}

let failures = 0;
const consoleErrors = [];
const step = async (name, fn) => {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures++;
    console.log(`  ✗ ${name}\n      ${e.message.split("\n")[0]}`);
  }
};
const browser = await chromium.launch();
const MOBILE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 };
const DESKTOP = { viewport: { width: 1366, height: 900 }, deviceScaleFactor: 1 };

function track(page, label) {
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(`[${label}] ${m.text()}`));
  page.on("pageerror", (e) => consoleErrors.push(`[${label}] pageerror: ${e.message}`));
}
async function noOverflow(page) {
  const o = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (o > 1) throw new Error(`horizontal overflow ${o}px`);
}

/** A browser context that behaves like Nimiq Pay's WebView (providers injected before page scripts). */
// ---------------------------------------------------------------------------
// A tiny Polygon simulator for the fake wallet: every Aave / QuickSwap transaction the app sends
// is decoded, its effect applied to the mock chain state, and a matching receipt registered, so
// the server's receipt verification runs exactly as on mainnet.
const DEFI = { VAULT: "0x5a7e5a7e00000000000000000000000000000001", USDT: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", AUSDT: "0x6ab707aca953edaefbc4fd23ba73294241490620", POOL: "0x794a61358d6845594f94dc1db02a252b5b4814ad", ROUTER: "0xa5e0829caced8ffdd4de3c43696c57f7d7a678ff", NIM: "0x4e494d0000000000000000000000000000000001", PAIR: "0x4e494d0000000000000000000000000000000002" };
const TX_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)",
  "function withdraw(address asset, uint256 amount, address to) returns (uint256)",
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
  "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
  "function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)",
  "function lock(address token, uint256 amount, uint64 unlockAt) returns (uint256 id)",
  "function release(uint256 id)",
]);
const VAULT_EVENTS = parseAbi([
  "event Locked(uint256 indexed id, address indexed owner, address indexed token, uint256 amount, uint64 unlockAt)",
  "event Released(uint256 indexed id, address indexed owner, address indexed token, uint256 amount, address caller)",
]);
const vaultLocks = new Map();
let nextLockId = 1;
const chain = { usdt: 25_500_000n, ausdt: 0n, nim: 1_000_000_000n, pol: 2n * 10n ** 18n, reserves: { nim: 5_000_000_000_000n, usdt: 60_000_000_000n }, polReserves: { pol: 2_000_000n * 10n ** 18n, usdt: 400_000_000_000n } };
const WPOL = "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270", POLPAIR = "0x604229c960e5cacf2aaeac8be68ac07ba9df81c3";
const cp = (amountIn, rin, rout) => (amountIn * 997n * rout) / (rin * 1000n + amountIn * 997n);
const wpolLog = (topic, who, wad) => ({ address: WPOL, topics: [topic, pad32(who)], data: pad32(wad.toString(16)) });
const DEPOSIT = "0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c", WITHDRAWAL = "0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65";
const pad32 = (a) => `0x${a.replace(/^0x/, "").padStart(64, "0")}`;
const xfer = (token, from, to, units) => ({ address: token, topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", pad32(from), pad32(to)], data: pad32(units.toString(16)) });
const post = (path, body) => fetch(`${MOCK}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
async function simulatePolygonTx(tx, owner) {
  const to = String(tx.to).toLowerCase();
  if (![DEFI.USDT, DEFI.NIM, DEFI.POOL, DEFI.ROUTER, DEFI.VAULT].includes(to)) return; // e.g. USDT bill payments are registered by the test itself
  const { functionName: fn, args } = decodeFunctionData({ abi: TX_ABI, data: tx.data });
  let logs = [];
  if (fn === "approve") await post("/_test/defi", { allowances: [{ token: to, owner, spender: String(args[0]), units: args[1].toString() }] });
  // An exact approval is consumed by the transferFrom inside supply / swap.
  const spend = (token, spender, units) => post("/_test/defi", { allowances: [{ token, owner, spender, units: "0" }] }).then(() => units);
  if (fn === "supply") await spend(DEFI.USDT, DEFI.POOL, args[1]);
  if (fn === "swapExactTokensForTokens") await spend(String(args[2][0]).toLowerCase(), DEFI.ROUTER, args[0]);
  if (fn === "supply") { chain.usdt -= args[1]; chain.ausdt += args[1]; logs = [xfer(DEFI.USDT, owner, DEFI.AUSDT, args[1])]; }
  if (fn === "withdraw") { const amt = args[1] > chain.ausdt ? chain.ausdt : args[1]; chain.ausdt -= amt; chain.usdt += amt; logs = [xfer(DEFI.USDT, DEFI.AUSDT, owner, amt)]; }
  if (fn === "lock") {
    const [token, amount, unlockAt] = args;
    const id = nextLockId++;
    vaultLocks.set(id, { owner, amount, unlockAt: Number(unlockAt) });
    chain.usdt -= amount;
    await post("/_test/vault", { locks: [{ id, owner, token: String(token), amount: amount.toString(), unlockAt: Number(unlockAt), released: false }] });
    logs = [xfer(DEFI.USDT, owner, DEFI.VAULT, amount), { address: DEFI.VAULT, topics: encodeEventTopics({ abi: VAULT_EVENTS, eventName: "Locked", args: { id: BigInt(id), owner, token: String(token) } }), data: encodeAbiParameters([{ type: "uint256" }, { type: "uint64" }], [amount, unlockAt]) }];
  }
  if (fn === "release") {
    const id = Number(args[0]);
    const l = vaultLocks.get(id);
    if (!l || l.released || Date.now() / 1000 < l.unlockAt) {
      await post("/_test/polygon-tx", { hash: tx.hash, timestamp: Date.now(), receipt: { status: "0x0", blockNumber: "0x3938700", from: owner, to, logs: [] } });
      return;
    }
    l.released = true;
    chain.usdt += l.amount;
    await post("/_test/vault", { locks: [{ id, released: true }] });
    logs = [xfer(DEFI.USDT, DEFI.VAULT, l.owner, l.amount), { address: DEFI.VAULT, topics: encodeEventTopics({ abi: VAULT_EVENTS, eventName: "Released", args: { id: BigInt(id), owner: l.owner, token: DEFI.USDT } }), data: encodeAbiParameters([{ type: "uint256" }, { type: "address" }], [l.amount, owner]) }];
  }
  if (fn === "swapExactTokensForETH") {
    const [amountIn] = args;
    const out = cp(amountIn, chain.polReserves.usdt, chain.polReserves.pol);
    chain.usdt -= amountIn;
    chain.pol += out;
    logs = [xfer(DEFI.USDT, owner, POLPAIR, amountIn), xfer(WPOL, POLPAIR, DEFI.ROUTER, out), wpolLog(WITHDRAWAL, DEFI.ROUTER, out)];
  }
  if (fn === "swapExactETHForTokens") {
    const value = BigInt(tx.value ?? "0x0");
    const out = cp(value, chain.polReserves.pol, chain.polReserves.usdt);
    chain.pol -= value;
    chain.usdt += out;
    logs = [wpolLog(DEPOSIT, DEFI.ROUTER, value), xfer(WPOL, DEFI.ROUTER, POLPAIR, value), xfer(DEFI.USDT, POLPAIR, owner, out)];
  }
  if (fn === "swapExactTokensForTokens") {
    const [amountIn, , path] = args; const nimIn = String(path[0]).toLowerCase() === DEFI.NIM;
    const rin = nimIn ? chain.reserves.nim : chain.reserves.usdt, rout = nimIn ? chain.reserves.usdt : chain.reserves.nim, f = amountIn * 997n;
    const out = (f * rout) / (rin * 1000n + f);
    if (nimIn) { chain.nim -= amountIn; chain.usdt += out; } else { chain.usdt -= amountIn; chain.nim += out; }
    logs = [xfer(String(path[0]).toLowerCase(), owner, DEFI.PAIR, amountIn), xfer(String(path[1]).toLowerCase(), DEFI.PAIR, owner, out)];
  }
  await post("/_test/defi", { pol: chain.pol.toString(), balances: [{ token: DEFI.USDT, owner, units: chain.usdt.toString() }, { token: DEFI.AUSDT, owner, units: chain.ausdt.toString() }, { token: DEFI.NIM, owner, units: chain.nim.toString() }] });
  await post("/_test/polygon-tx", { hash: tx.hash, timestamp: Date.now(), receipt: { status: "0x1", blockNumber: "0x3938700", from: owner, to, logs }, tx: { input: tx.data, value: tx.value ?? "0x0" } });
}

async function nimiqPayContext(opts, { nimKey, evmAccount, sentTxs }) {
  const ctx = await browser.newContext(opts);
  await ctx.exposeBinding("__nimSign", (_s, message) => nimSign(nimKey, message));
  await ctx.exposeBinding("__evmSign", (_s, message) => evmAccount.signMessage({ message }));
  await ctx.exposeBinding("__recordTx", async (_s, tx) => {
    sentTxs.push(tx);
    if (tx.kind === "evm") await simulatePolygonTx(tx, evmAccount.address.toLowerCase());
    return null;
  });
  const nimAddress = (await (await fetch(`${APP}/api/status`)).json()) && null; // warm-up
  void nimAddress;
  await ctx.addInitScript(
    ({ evmAddress }) => {
      window.nimiqPay = { language: "en", userFiat: "USD", network: "testnet" };
      window.nimiq = {
        listAccounts: async () => ["NQ52 BBBB BBBB BBBB BBBB BBBB BBBB BBBB BBBB"],
        // Like Nimiq Pay while its light client syncs: reports 0. AuraPay must read the real balance from its node.
        getBalance: async () => 0,
        isConsensusEstablished: async () => true,
        getBlockNumber: async () => 1000,
        sign: async (message) => window.__nimSign(message),
        sendBasicTransactionWithData: async (tx) => {
          // A fresh hash per transaction (AuraPay rejects a reused tx hash).
          const hash = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
          await window.__recordTx({ kind: "nim", ...tx, hash });
          return hash;
        },
        disconnect: () => {},
      };
      window.ethereum = {
        on: () => {},
        removeListener: () => {},
        request: async ({ method, params }) => {
          if (method === "eth_requestAccounts" || method === "eth_accounts") return [evmAddress];
          if (method === "eth_chainId") return "0x89";
          if (method === "wallet_switchEthereumChain") return null;
          if (method === "personal_sign") return window.__evmSign(params[0]);
          if (method === "eth_getTransactionReceipt") return { status: "0x1", transactionHash: params[0] };
          if (method === "eth_sendTransaction") {
            const h = "0x" + Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
            await window.__recordTx({ kind: "evm", ...params[0], hash: h });
            return h;
          }
          throw Object.assign(new Error(`unsupported ${method}`), { code: 4200 });
        },
      };
    },
    { evmAddress: evmAccount.address},
  );
  return ctx;
}

// ---------------------------------------------------------------------------
console.log("\nLanding (signed out)");
for (const [label, opts] of [["mobile", MOBILE], ["desktop", DESKTOP]]) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  track(page, `landing-${label}`);
  await step(`${label}: landing renders with live rates`, async () => {
    await page.goto(APP + "/", { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: /Your money/ }).waitFor();
    await page.getByText("Live rates").waitFor();
    await page.getByText("1 NIM").waitFor();
    await noOverflow(page);
    await page.screenshot({ path: `${OUT}/${label}-landing.png`, fullPage: true });
  });
  await ctx.close();
}

// ---------------------------------------------------------------------------
console.log("\nRemote sign-in from a plain browser (QR / code → approve in Nimiq Pay)");
{
  const ctx = await browser.newContext(DESKTOP);
  const page = await ctx.newPage();
  track(page, "remote");
  await step("QR and code shown; approval signs this browser in", async () => {
    await page.goto(APP + "/", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByAltText(/QR code/).waitFor();
    const code = (await page.locator("button.font-mono").first().innerText()).trim();
    if (!/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code)) throw new Error(`code ${code}`);
    await page.screenshot({ path: `${OUT}/desktop-signin-qr.png` });
    // The phone (Nimiq Pay) approves:
    const key = ed25519.utils.randomPrivateKey();
    const look = await (await fetch(`${APP}/api/auth/remote?code=${code}`)).json();
    const ap = await fetch(`${APP}/api/auth/remote/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, ...nimSign(key, look.message) }) });
    if (!ap.ok) throw new Error(`approve ${ap.status}`);
    await page.getByText("Total balance").waitFor({ timeout: 15_000 });
  });
  await ctx.close();
}

// ---------------------------------------------------------------------------
console.log("\nInside a simulated Nimiq Pay host");
const evmAccount = privateKeyToAccount(`0x${"33".repeat(32)}`);
const sentTxs = [];
const nimKey = ed25519.utils.randomPrivateKey();
const MY_NAME = `ui_${randomBytes(3).toString("hex")}`;
const FRIEND_NAME = `friend_${randomBytes(3).toString("hex")}`;

/** Signs a second user in through the API (real Nimiq signature) and claims a username. */
async function apiUserWithName(username) {
  const key = ed25519.utils.randomPrivateKey();
  let cookie = "";
  const call = async (method, path, body) => {
    const r = await fetch(APP + path, { method, headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = r.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    return r.json();
  };
  const ch = await call("POST", "/api/auth/challenge", { mode: "local" });
  const v = await call("POST", "/api/auth/verify", { challengeId: ch.id, ...nimSign(key, ch.message) });
  await call("POST", "/api/me/username", { username });
  return { address: v.user.address };
}

for (const [label, opts] of [["mobile", MOBILE], ["desktop", DESKTOP]]) {
  const ctx = await nimiqPayContext(opts, { nimKey, evmAccount, sentTxs });
  const page = await ctx.newPage();
  track(page, `app-${label}`);
  await step(`${label}: one-tap sign-in with Nimiq Pay`, async () => {
    await page.goto(APP + "/", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /Sign in with Nimiq Pay/ }).first().click();
    await page.getByRole("button", { name: "Sign in with Nimiq Pay" }).last().click();
    await page.getByText("Total balance").waitFor({ timeout: 15_000 });
  });
  if (label === "mobile") {
    await step("verify EVM wallet (personal_sign)", async () => {
      await page.locator("button", { hasText: "Hello" }).first().click();
      await page.getByRole("button", { name: /Verify EVM wallet/ }).click();
      await page.getByText("Verified").first().waitFor({ timeout: 10_000 });
      await page.screenshot({ path: `${OUT}/mobile-account.png` });
      await page.keyboard.press("Escape");
    });
    await step("NIM balance comes from AuraPay's node even when Nimiq Pay reports 0", async () => {
      await page.goto(APP + "/", { waitUntil: "networkidle" });
      await page.getByText(/NIM 2,500/).first().waitFor({ timeout: 15_000 });
    });
    await step("claim a @username from Home", async () => {
      await page.goto(APP + "/", { waitUntil: "networkidle" });
      await page.getByText("Claim your @username").waitFor();
      await page.getByLabel("Username").first().fill(MY_NAME);
      await page.getByText(`@${MY_NAME} is available`).waitFor({ timeout: 8000 });
      await page.getByRole("button", { name: "Claim" }).first().click();
      await page.getByText(`Hello, @${MY_NAME}`).waitFor({ timeout: 8000 });
    });
  }
  for (const [name, path, text] of [
    ["home", "/", "Total balance"],
    ["send", "/send", "NIM or USDT to any AuraPay @username"],
    ["receive", "/receive", `@${MY_NAME}`],
    ["pay", "/pay", "Where are you sending to?"],
    ["schedules", "/schedules", "Reminders for recurring payments"],
    ["earn", "/earn", "Put idle USDT to work"],
    ["savings", "/savings", "Lock USDT until a date you choose"],
    ["thrift", "/thrift", "Save together as a group"],
    ["activity", "/activity", "Every bill"],
    ["status", "/status", "Integrations"],
  ]) {
    await step(`${label}: ${name}`, async () => {
      await page.goto(APP + path, { waitUntil: "networkidle" });
      await page.locator(":is(h1,h2,p,span):visible", { hasText: text }).first().waitFor({ timeout: 12_000 });
      await noOverflow(page);
      await page.screenshot({ path: `${OUT}/${label}-${name}.png`, fullPage: label === "mobile" });
    });
  }
  if (label === "mobile") {
    await step("airtime with NIM: keypad, slide to pay, verified on-chain", async () => {
      await page.goto(APP + "/pay?service=airtime", { waitUntil: "networkidle" });
      await page.getByRole("button", { name: /Nigeria/ }).click();
      await page.getByLabel("Recipient phone number").fill("08031234567");
      const provider = (await (await fetch(APP + "/api/status")).json()).utilities.provider;
      await page.getByText(provider === "flutterwave" ? /✓ .*MTN/ : /✓ .*MTN Nigeria/).waitFor({ timeout: 8000 });
      for (const k of ["2", "0", "0", "0"]) await page.getByRole("button", { name: `Key ${k}` }).click();
      await page.getByRole("radio", { name: /Pay with NIM/ }).click();
      await page.screenshot({ path: `${OUT}/flow-1-details.png`, fullPage: true });
      await page.getByRole("button", { name: "Review payment" }).click();
      await page.getByText("You're paying").waitFor();
      await page.screenshot({ path: `${OUT}/flow-2-review.png`, fullPage: true });
      const knob = page.getByRole("button", { name: /Slide to pay/ });
      const box = await knob.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + 330, box.y + box.height / 2, { steps: 12 });
      await page.mouse.up();
      await page.getByText("Confirming your payment").waitFor({ timeout: 10_000 });
      const tx = sentTxs.find((t) => t.kind === "nim");
      await fetch(`${MOCK}/_test/nimiq-tx`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hash: tx.hash, from: "NQ52 BBBB BBBB BBBB BBBB BBBB BBBB BBBB BBBB", to: tx.recipient, value: tx.value, recipientData: Buffer.from(tx.data).toString("hex"), blockNumber: 1001, confirmations: 3, timestamp: Date.now(), executionResult: true }),
      });
      await page.getByText("New payment").waitFor({ timeout: 20_000 });
      await page.screenshot({ path: `${OUT}/flow-3-receipt.png`, fullPage: true });
    });
    await step("repeat a bill as a monthly reminder; it shows on Scheduled", async () => {
      await page.getByRole("button", { name: /Repeat this payment/ }).click();
      await page.getByRole("button", { name: /Set reminder/ }).click();
      await page.getByText("Reminder set").waitFor({ timeout: 8000 });
      await page.screenshot({ path: `${OUT}/reminder-set.png` });
      await page.goto(APP + "/schedules", { waitUntil: "networkidle" });
      await page.getByText(/every month · next/).first().waitFor();
      await page.screenshot({ path: `${OUT}/mobile-reminders.png`, fullPage: true });
    });
    await step("show amounts in naira", async () => {
      await page.goto(APP + "/", { waitUntil: "networkidle" });
      await page.getByRole("button", { name: /Display currency: USD/ }).click();
      await page.getByRole("button", { name: /NGN/ }).click();
      await page.getByRole("button", { name: /Display currency: NGN/ }).waitFor({ timeout: 8000 });
      await page.locator("p.num", { hasText: "₦" }).first().waitFor({ timeout: 8000 });
      await page.screenshot({ path: `${OUT}/mobile-home-ngn.png`, fullPage: true });
    });
    await step("start a thrift with a friend", async () => {
      const friend2 = `pal_${randomBytes(3).toString("hex")}`;
      await apiUserWithName(friend2);
      await page.goto(APP + "/thrift/new", { waitUntil: "networkidle" });
      await page.getByLabel("Name").fill("Family thrift");
      await page.getByLabel("Contribution per member, per period").fill("10");
      await page.getByLabel("Add member").fill(friend2);
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await page.getByText(`@${friend2}`).waitFor();
      await page.screenshot({ path: `${OUT}/thrift-new.png`, fullPage: true });
      await page.getByRole("button", { name: "Create & invite" }).click();
      await page.getByText("Members & payout order").waitFor({ timeout: 10_000 });
      await page.getByText("Invited").waitFor();
      await noOverflow(page);
      await page.screenshot({ path: `${OUT}/thrift-group.png`, fullPage: true });
    });
    await step("schedule a monthly airtime bill: prepay, verified, listed", async () => {
      await page.goto(APP + "/pay?service=airtime", { waitUntil: "networkidle" });
      await page.getByRole("button", { name: /Nigeria/ }).click();
      await page.getByLabel("Recipient phone number").fill("08031234567");
      await page.getByText(/✓ .*MTN/).waitFor({ timeout: 8000 });
      for (const k of ["1", "0", "0", "0"]) await page.getByRole("button", { name: `Key ${k}` }).click();
      await page.getByRole("radio", { name: "Schedule" }).click();
      await page.getByLabel("First payment").waitFor();
      await page.getByRole("radio", { name: "Monthly" }).click();
      await page.getByRole("radio", { name: /Pay with NIM/ }).click();
      await page.screenshot({ path: `${OUT}/schedule-1-details.png`, fullPage: true });
      await page.getByRole("button", { name: "Review schedule" }).click();
      await page.getByText("You're prepaying 3 payments").waitFor();
      await page.screenshot({ path: `${OUT}/schedule-2-review.png`, fullPage: true });
      const before = sentTxs.length;
      const knob = page.getByRole("button", { name: /Slide to prepay/ });
      // Scroll to the bottom so the slider sits above the floating tab bar, not under it.
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(300);
      const box = await knob.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + 330, box.y + box.height / 2, { steps: 12 });
      await page.mouse.up();
      await page.getByText("Confirming your payment").waitFor({ timeout: 10_000 }).catch(async (e) => {
        await page.screenshot({ path: `${OUT}/schedule-debug.png`, fullPage: false });
        throw e;
      });
      const tx = sentTxs.slice(before).find((t) => t.kind === "nim");
      await fetch(`${MOCK}/_test/nimiq-tx`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hash: tx.hash, from: "NQ52 BBBB BBBB BBBB BBBB BBBB BBBB BBBB BBBB", to: tx.recipient, value: tx.value, recipientData: Buffer.from(tx.data).toString("hex"), blockNumber: 1001, confirmations: 3, timestamp: Date.now(), executionResult: true }),
      });
      await page.getByText("Bill scheduled").waitFor({ timeout: 20_000 });
      await page.screenshot({ path: `${OUT}/schedule-3-done.png`, fullPage: true });
      await page.goto(APP + "/schedules", { waitUntil: "networkidle" });
      await page.getByRole("radio", { name: "Autopay" }).click();
      await page.getByText("Next payment").first().waitFor();
      await noOverflow(page);
      await page.screenshot({ path: `${OUT}/mobile-schedules.png`, fullPage: true });
    });
    await step("cable TV: provider packages and smartcard field", async () => {
      const st = await (await fetch(APP + "/api/status")).json();
      if (st.utilities?.provider !== "flutterwave") return; // cable TV is a Flutterwave-only catalogue
      await page.goto(APP + "/pay?service=cable", { waitUntil: "networkidle" });
      await page.getByRole("button", { name: /Nigeria/ }).click();
      await page.getByRole("button", { name: /DSTV/ }).click();
      await page.getByText("DStv Padi").waitFor();
      await page.getByLabel("Smartcard / IUC number").waitFor();
      await noOverflow(page);
      await page.screenshot({ path: `${OUT}/mobile-cable.png`, fullPage: true });
    });
    await step("set a profile picture from the account sheet", async () => {
      await page.goto(APP + "/", { waitUntil: "networkidle" });
      await page.getByRole("button", { name: /Hello/ }).click();
      // A real 64×48 PNG: the app crops it square and re-encodes it at 320px before uploading.
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAAZElEQVR4nO3PUQkAIBTAwBfMJCY2liH8OITBAtzm7PV1wwUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY8dgHaT2jxPSfGUQAAAABJRU5ErkJggg==", "base64");
      await page.getByLabel("Profile photo file").setInputFiles({ name: "me.png", mimeType: "image/png", buffer: png });
      try {
        await page.locator('img[src^="/api/avatars/"]:visible').first().waitFor({ timeout: 10_000 });
      } catch (e) {
        await page.screenshot({ path: `${OUT}/avatar-fail.png`, fullPage: true });
        throw e;
      }
      await page.getByRole("button", { name: /Change photo/ }).waitFor();
      await page.screenshot({ path: `${OUT}/avatar-set.png` });
      await page.keyboard.press("Escape");
    });
    await step("USDT bill with no POL: free, explained up front, slider locked", async () => {
      await post("/_test/defi", { pol: "0" });
      try {
        await page.goto(APP + "/pay?service=airtime", { waitUntil: "networkidle" });
        await page.getByRole("button", { name: /Nigeria/ }).click();
        await page.getByLabel("Recipient phone number").fill("08031234567");
        await page.getByText(/✓ .*MTN/).waitFor({ timeout: 8000 });
        for (const k of ["1", "0", "0"]) await page.getByRole("button", { name: `Key ${k}` }).click();
        await page.getByRole("radio", { name: /Pay with USDT/ }).click();
        await page.getByText(/needs POL for gas/).waitFor();
        await page.getByRole("button", { name: "Review payment" }).click();
        await page.getByText("You're paying").waitFor();
        await page.getByText("Add a little POL for the network fee").waitFor();
        await page.getByText("Free", { exact: true }).first().waitFor();
        if (!(await page.getByRole("button", { name: /Slide to pay/ }).isDisabled())) throw new Error("slider should be disabled without POL");
        await page.screenshot({ path: `${OUT}/no-gas.png`, fullPage: true });
      } catch (e) {
        await page.screenshot({ path: `${OUT}/no-gas-fail.png`, fullPage: true });
        throw e;
      } finally {
        await post("/_test/defi", { pol: (2n * 10n ** 18n).toString() });
      }
    });
    await step("earn: approve + deposit USDT to Aave, verified on Polygon", async () => {
      await page.goto(APP + "/earn", { waitUntil: "networkidle" });
      await page.getByText("Supplied on Aave").waitFor();
      await page.getByText(/3\.7\d%/).waitFor({ timeout: 10_000 });
      await page.getByLabel("Amount to deposit").fill("10");
      await page.screenshot({ path: `${OUT}/earn-1.png`, fullPage: true });
      const before = sentTxs.length;
      await page.getByRole("button", { name: /Deposit to Earn/ }).click();
      await page.getByText("Deposited 10.00 USDT").waitFor({ timeout: 30_000 });
      const evm = sentTxs.slice(before).filter((t) => t.kind === "evm").map((t) => t.data.slice(0, 10));
      if (evm.join() !== "0x095ea7b3,0x617ba037") throw new Error(`expected approve then supply, got ${evm.join()}`);
      await page.getByText("10.00 USDT").first().waitFor();
      await page.screenshot({ path: `${OUT}/earn-2-deposited.png`, fullPage: true });
    });
    await step("earn: withdraw max, then hand the USDT to Pay", async () => {
      await page.getByRole("radio", { name: "Withdraw" }).click();
      await page.getByRole("button", { name: "Max" }).click();
      await page.getByRole("button", { name: /Withdraw everything/ }).click();
      await page.getByText(/Withdrew 10\.00 USDT/).waitFor({ timeout: 30_000 });
      await page.getByRole("button", { name: /Add to thrift|Pay your thrift/ }).waitFor();
      await page.screenshot({ path: `${OUT}/earn-3-withdrawn.png`, fullPage: true });
      await page.getByRole("button", { name: /Pay a bill/ }).click();
      await page.getByRole("button", { name: /Nigeria/ }).click();
      await page.getByRole("button", { name: /Airtime/ }).first().click();
      await page.getByText(/Paying with the USDT you just withdrew from Earn/).waitFor({ timeout: 10_000 });
      const usdt = page.getByRole("radio", { name: /Pay with USDT/ });
      if ((await usdt.getAttribute("aria-checked")) !== "true") throw new Error("USDT not preselected");
    });
    await step("swap: top up POL with USDT (approve + swapExactTokensForETH), verified", async () => {
      await page.goto(APP + "/swap", { waitUntil: "networkidle" });
      await page.getByRole("radio", { name: "USDT ↔ POL" }).waitFor();
      await page.getByLabel(/You pay \(USDT\)/).fill("2");
      await page.getByText(/Minimum received/).waitFor({ timeout: 10_000 });
      await page.screenshot({ path: `${OUT}/swap-1-quote.png`, fullPage: true });
      const before = sentTxs.length;
      await page.getByRole("button", { name: /Swap USDT → POL/ }).click();
      await page.getByText(/Swapped 2(\.0+)? USDT → [\d.,]+ POL/).waitFor({ timeout: 30_000 });
      const evm = sentTxs.slice(before).filter((t) => t.kind === "evm").map((t) => t.data.slice(0, 10));
      if (evm.at(-1) !== "0x18cbafe5") throw new Error(`expected swapExactTokensForETH last, got ${evm.join()}`);
      await page.screenshot({ path: `${OUT}/swap-2-done.png`, fullPage: true });
    });
    await step("swap: POL → USDT sends POL as value, no approval", async () => {
      await page.getByRole("button", { name: "Switch direction" }).click();
      await page.getByLabel(/You pay \(POL\)/).fill("1");
      await page.getByText(/Minimum received/).waitFor({ timeout: 10_000 });
      const before = sentTxs.length;
      await page.getByRole("button", { name: /Swap POL → USDT/ }).click();
      await page.getByText(/Swapped 1(\.0+)? POL →/).waitFor({ timeout: 30_000 });
      const evm = sentTxs.slice(before).filter((t) => t.kind === "evm");
      if (evm.length !== 1 || evm[0].data.slice(0, 10) !== "0x7ff36ab5" || BigInt(evm[0].value) !== 10n ** 18n) throw new Error("expected one payable swapExactETHForTokens");
    });
    await step("swap: NIM ↔ USDT tab is honest about NIM on Polygon", async () => {
      await page.getByRole("radio", { name: "NIM ↔ USDT" }).click();
      const cfg = await (await fetch(APP + "/api/swap/config")).json();
      if (!cfg.swap?.pairs?.NIM?.enabled) {
        await page.getByText(/NIM isn't on Polygon yet/).waitFor();
        await page.getByText("Earn on USDT").waitFor();
        await page.screenshot({ path: `${OUT}/swap-unavailable.png`, fullPage: true });
        return;
      }
      await page.getByLabel(/You pay \(USDT\)/).fill("5");
      await page.getByText(/Minimum received/).waitFor({ timeout: 10_000 });
      await page.getByRole("button", { name: /Swap USDT → NIM/ }).click();
      await page.getByText(/Swapped 5(\.0+)? USDT →/).waitFor({ timeout: 30_000 });
    });
    await step("savings: lock USDT until a date (approve + lock), verified, counting down", async () => {
      await page.goto(APP + "/savings", { waitUntil: "networkidle" });
      const cfg = await (await page.request.get(APP + "/api/savings")).json();
      if (!cfg.savings.enabled) {
        await page.getByText("Locked savings is coming").waitFor();
        await page.getByText("Thrift", { exact: true }).waitFor();
        await page.screenshot({ path: `${OUT}/savings-off.png`, fullPage: true });
        return;
      }
      await page.getByLabel("Amount to lock").fill("3");
      await page.getByRole("button", { name: "1 week" }).click();
      await page.getByLabel("Goal (optional)").fill("School fees");
      const lockBtn = page.getByRole("button", { name: /Lock 3\.00 USDT/ });
      if (!(await lockBtn.isDisabled())) throw new Error("must confirm the lock period first");
      await page.getByText(/I understand this USDT can't be withdrawn before/).click();
      await page.screenshot({ path: `${OUT}/savings-1-form.png`, fullPage: true });
      const before = sentTxs.length;
      await lockBtn.click();
      await page.getByText("Locked 3.00 USDT").waitFor({ timeout: 30_000 });
      const evm = sentTxs.slice(before).filter((t) => t.kind === "evm").map((t) => t.data.slice(0, 10));
      if (evm.at(-1) !== "0xd94e0fd4" && !evm.length) throw new Error("no lock tx");
      await page.getByText(/Unlocks in 6d 23h|Unlocks in 7d/).waitFor();
      await page.getByText("School fees").waitFor();
      await page.screenshot({ path: `${OUT}/savings-2-locked.png`, fullPage: true });
    });
    await step("savings: withdraw a matured lock to the wallet", async () => {
      const cfg = await (await page.request.get(APP + "/api/savings")).json();
      if (!cfg.savings.enabled) return;
      // A lock whose time has come (made on-chain by this wallet; the simulator accepts a past unlock time).
      const owner = evmAccount.address.toLowerCase();
      const id = nextLockId++;
      const unlockAt = Math.floor(Date.now() / 1000) - 60;
      vaultLocks.set(id, { owner, amount: 2_000_000n, unlockAt });
      await post("/_test/vault", { locks: [{ id, owner, token: DEFI.USDT, amount: "2000000", unlockAt, released: false }] });
      const hash = `0x${randomBytes(32).toString("hex")}`;
      await post("/_test/polygon-tx", { hash, timestamp: Date.now(), receipt: { status: "0x1", blockNumber: "0x3938700", from: owner, to: DEFI.VAULT, logs: [xfer(DEFI.USDT, owner, DEFI.VAULT, 2_000_000n), { address: DEFI.VAULT, topics: encodeEventTopics({ abi: VAULT_EVENTS, eventName: "Locked", args: { id: BigInt(id), owner, token: DEFI.USDT } }), data: encodeAbiParameters([{ type: "uint256" }, { type: "uint64" }], [2_000_000n, BigInt(unlockAt)]) }] } });
      const r = await page.request.post(APP + "/api/savings/locks", { data: { txHash: hash, from: owner, label: "Matured" } });
      if (r.status() !== 201) throw new Error(`record lock ${r.status()}`);
      await page.reload({ waitUntil: "networkidle" });
      await page.getByText("Unlocked: ready to withdraw").waitFor();
      await page.getByRole("button", { name: /Withdraw to wallet/ }).click();
      await page.getByText(/^Unlocked · /).waitFor({ timeout: 30_000 });
      await page.screenshot({ path: `${OUT}/savings-3-withdrawn.png`, fullPage: true });
    });
    await step("send NIM to another @username: review, slide, verified on-chain", async () => {
      const friend = await apiUserWithName(FRIEND_NAME);
      await page.goto(APP + `/send?to=${FRIEND_NAME}`, { waitUntil: "networkidle" });
      await page.getByText(`✓ @${FRIEND_NAME}`).waitFor({ timeout: 8000 });
      for (const k of ["2", "5"]) await page.getByRole("button", { name: `Key ${k}` }).click();
      await page.getByLabel("Note (optional)").fill("Lunch");
      await page.screenshot({ path: `${OUT}/send-1-form.png`, fullPage: true });
      await page.getByRole("button", { name: "Review" }).click();
      await page.getByText("You're sending to").waitFor();
      await page.screenshot({ path: `${OUT}/send-2-review.png`, fullPage: true });
      const before = sentTxs.length;
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(300);
      const knob = page.getByRole("button", { name: /Slide to send/ });
      const box = await knob.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + 330, box.y + box.height / 2, { steps: 12 });
      await page.mouse.up();
      await page.waitForFunction((n) => window.__sentCount?.() > n, before).catch(() => {});
      for (let i = 0; i < 20 && sentTxs.length <= before; i++) await page.waitForTimeout(250);
      const tx = sentTxs.slice(before).find((t) => t.kind === "nim");
      if (!tx) throw new Error("wallet was not asked to send");
      if (tx.recipient.replace(/\s/g, "") !== friend.address.replace(/\s/g, "")) throw new Error(`sent to ${tx.recipient}, expected ${friend.address}`);
      await fetch(`${MOCK}/_test/nimiq-tx`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hash: tx.hash, from: "NQ52 BBBB BBBB BBBB BBBB BBBB BBBB BBBB BBBB", to: tx.recipient, value: tx.value, recipientData: Buffer.from(tx.data).toString("hex"), blockNumber: 1001, confirmations: 3, timestamp: Date.now(), executionResult: true }),
      });
      await page.getByText(`Sent to @${FRIEND_NAME}`).waitFor({ timeout: 20_000 });
      await page.screenshot({ path: `${OUT}/send-3-done.png`, fullPage: true });
    });
  }
  await ctx.close();
}

await browser.close();
// The CoW widget iframe loads from swap.cow.fi, which this sandbox cannot reach; ignore its network noise.
const relevant = consoleErrors.filter((e) => !/Failed to load resource|swap\.cow\.fi|ERR_|net::/.test(e));
console.log(`\nConsole errors: ${relevant.length}`);
relevant.slice(0, 20).forEach((e) => console.log("   " + e));
console.log(failures ? `\n${failures} step(s) failed\n` : "\nAll UI steps passed\n");
process.exit(failures || relevant.length ? 1 : 0);
