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
 *    verification and the Aave borrow screen, plus a console-error check.
 *
 *   APP=http://localhost:3000 MOCK=http://localhost:4010 OUT=./screenshots node scripts/e2e-ui.mjs
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
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
async function nimiqPayContext(opts, { nimKey, evmAccount, sentTxs }) {
  const ctx = await browser.newContext(opts);
  await ctx.exposeBinding("__nimSign", (_s, message) => nimSign(nimKey, message));
  await ctx.exposeBinding("__evmSign", (_s, message) => evmAccount.signMessage({ message }));
  await ctx.exposeBinding("__recordTx", (_s, tx) => {
    sentTxs.push(tx);
    return null;
  });
  const nimAddress = (await (await fetch(`${APP}/api/status`)).json()) && null; // warm-up
  void nimAddress;
  await ctx.addInitScript(
    ({ evmAddress, nimHash }) => {
      window.nimiqPay = { language: "en", userFiat: "USD", network: "testnet" };
      window.nimiq = {
        listAccounts: async () => ["NQ52 BBBB BBBB BBBB BBBB BBBB BBBB BBBB BBBB"],
        getBalance: async () => 250_000_000,
        isConsensusEstablished: async () => true,
        getBlockNumber: async () => 1000,
        sign: async (message) => window.__nimSign(message),
        sendBasicTransactionWithData: async (tx) => {
          await window.__recordTx({ kind: "nim", ...tx, hash: nimHash });
          return nimHash;
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
          if (method === "eth_sendTransaction") {
            const h = "0x" + Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
            await window.__recordTx({ kind: "evm", ...params[0], hash: h });
            return h;
          }
          throw Object.assign(new Error(`unsupported ${method}`), { code: 4200 });
        },
      };
    },
    { evmAddress: evmAccount.address, nimHash: randomBytes(32).toString("hex") },
  );
  return ctx;
}

// ---------------------------------------------------------------------------
console.log("\nLanding (signed out)");
for (const [label, opts] of [["mobile", MOBILE], ["desktop", DESKTOP]]) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  track(page, `landing-${label}`);
  await step(`${label}: landing renders with live markets`, async () => {
    await page.goto(APP + "/", { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: /Your money/ }).waitFor();
    await page.getByText("Live US markets").waitFor();
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
    await fetch(`${MOCK}/_test/evm-balance`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chainId: 8453, token: "0xb20000000000000000000078ee7ce2fE4908108C", owner: evmAccount.address, amount: "150000000" }) });
    await fetch(`${MOCK}/_test/aave-position`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ supplied: "100000000", debt: "40000000", collateral: true }) });
  }
  for (const [name, path, text] of [
    ["home", "/", "Total balance"],
    ["invest", "/invest", "Portfolio value"],
    ["stock", "/invest/NVDA", "About NVIDIA"],
    ["borrow", "/borrow", "You can borrow"],
    ["pay", "/pay", "Where are you sending to?"],
    ["activity", "/activity", "Every payment"],
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
    await step("borrow: Aave position and borrow sheet with health projection", async () => {
      await page.goto(APP + "/borrow", { waitUntil: "networkidle" });
      await page.getByRole("button", { name: "Borrow", exact: true }).click();
      await page.getByPlaceholder("0").fill("5");
      await page.getByText("Health factor after").waitFor();
      await page.screenshot({ path: `${OUT}/mobile-borrow-sheet.png` });
      await page.keyboard.press("Escape");
    });
    await step("buy sheet: tokenised stock details and funding choice", async () => {
      await page.goto(APP + "/invest/NVDA", { waitUntil: "networkidle" });
      await page.getByRole("button", { name: "Buy NVDA" }).click();
      await page.getByText(/You'll receive/).waitFor();
      await page.getByRole("radio", { name: /USDT · Polygon/ }).waitFor();
      await page.screenshot({ path: `${OUT}/mobile-buy-sheet.png` });
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
