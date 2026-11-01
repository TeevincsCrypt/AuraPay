#!/usr/bin/env node
/**
 * Browser tests (Playwright) against a running AuraPay wired to scripts/mock-providers.mjs.
 *  - visits every section at mobile + desktop widths, captures screenshots and console errors
 *  - completes an airtime purchase in a plain browser with a simulated payment
 *  - completes a NIM purchase inside a *simulated* Nimiq Pay host: window.nimiq is a stand-in
 *    that implements the SDK's documented methods (listAccounts, getBalance,
 *    sendBasicTransactionWithData). The mock chain is then credited with that transaction
 *    so the server-side verification path runs for real.
 *
 *   APP=http://localhost:3000 MOCK=http://localhost:4010 OUT=./screenshots node scripts/e2e-ui.mjs
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";

// Resolved via require so a globally installed Playwright works too.
const { chromium } = createRequire(import.meta.url)("playwright");

const APP = process.env.APP ?? "http://localhost:3000";
const MOCK = process.env.MOCK ?? "http://localhost:4010";
const OUT = process.env.OUT ?? "screenshots";
mkdirSync(OUT, { recursive: true });

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

function track(page, label) {
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(`[${label}] ${m.text()}`);
  });
  page.on("pageerror", (e) => consoleErrors.push(`[${label}] pageerror: ${e.message}`));
}

// ---------------------------------------------------------------------------
console.log("\nNavigation & layout");
for (const [label, viewport] of [
  ["mobile", { width: 390, height: 844 }],
  ["desktop", { width: 1366, height: 900 }],
]) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  track(page, label);
  for (const [name, path, text] of [
    ["home", "/", "Total portfolio value"],
    ["invest", "/invest", "Discover"],
    ["stock", "/invest/NVDA", "About NVIDIA"],
    ["borrow", "/borrow", "Lending simulator"],
    ["pay", "/pay", "Where are you sending to?"],
    ["activity", "/activity", "Activity"],
    ["status", "/status", "Integrations"],
  ]) {
    await step(`${label}: ${name}`, async () => {
      await page.goto(APP + path, { waitUntil: "networkidle" });
      await page.locator(`:is(h1,h2,p,span,button):visible`, { hasText: text }).first().waitFor({ timeout: 10_000 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 1) throw new Error(`horizontal overflow ${overflow}px`);
      await page.screenshot({ path: `${OUT}/${label}-${name}.png`, fullPage: label === "mobile" });
    });
  }
  await ctx.close();
}

// ---------------------------------------------------------------------------
console.log("\nAirtime purchase in a browser (simulated payment)");
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  track(page, "pay-demo");
  await step("choose Nigeria → Airtime", async () => {
    await page.goto(APP + "/pay", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /Nigeria/ }).click();
    await page.getByRole("button", { name: /Airtime/ }).click();
  });
  await step("enter number, operator auto-detected, enter amount", async () => {
    await page.getByLabel("Recipient phone number").fill("08031234567");
    await page.getByText("MTN Nigeria", { exact: false }).first().waitFor();
    await page.getByText(/✓ .*MTN Nigeria/).waitFor({ timeout: 8000 });
    await page.getByLabel(/Amount \(NGN\)/).fill("1500");
    await page.getByRole("radio", { name: /Simulated payment/ }).click();
    await page.screenshot({ path: `${OUT}/flow-1-details.png`, fullPage: true });
  });
  await step("review shows breakdown + TEST label", async () => {
    await page.getByRole("button", { name: "Review payment" }).click();
    await page.getByText("You're paying").waitFor();
    await page.getByText("Test · Sandbox").first().waitFor();
    await page.screenshot({ path: `${OUT}/flow-2-review.png`, fullPage: true });
  });
  await step("confirm → receipt", async () => {
    await page.getByRole("button", { name: "Confirm simulated payment" }).click();
    await page.getByText("New payment").waitFor({ timeout: 20_000 });
    await page.getByText("Payment was simulated").waitFor();
    await page.screenshot({ path: `${OUT}/flow-3-receipt.png`, fullPage: true });
  });
  await step("activity shows the order and its detail", async () => {
    await page.goto(APP + "/activity", { waitUntil: "networkidle" });
    await page.getByText("Airtime · MTN Nigeria").first().click();
    await page.getByText("Reference").first().waitFor();
    await page.screenshot({ path: `${OUT}/flow-4-activity-detail.png`, fullPage: true });
  });
  await ctx.close();
}

// ---------------------------------------------------------------------------
console.log("\nNIM purchase inside a simulated Nimiq Pay host");
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const hash = randomBytes(32).toString("hex");
  await ctx.addInitScript(
    ({ hash }) => {
      const sent = [];
      window.__sentTxs = sent;
      window.nimiqPay = { language: "en", userFiat: "USD", network: "testnet" };
      window.nimiq = {
        listAccounts: async () => ["NQ52 BBBB BBBB BBBB BBBB BBBB BBBB BBBB BBBB"],
        getBalance: async () => 250_000_000, // 2,500 NIM in luna
        isConsensusEstablished: async () => true,
        getBlockNumber: async () => 1000,
        sendBasicTransactionWithData: async (tx) => {
          sent.push(tx);
          return hash;
        },
        disconnect: () => {},
      };
    },
    { hash },
  );
  const page = await ctx.newPage();
  track(page, "pay-nim");
  await step("wallet connects and shows balance", async () => {
    await page.goto(APP + "/", { waitUntil: "networkidle" });
    await page.locator("button:visible", { hasText: "Connect" }).first().click();
    await page.getByRole("button", { name: "Connect Nimiq Pay" }).click();
    await page.getByText("2,500.00 NIM").first().waitFor({ timeout: 8000 });
    await page.screenshot({ path: `${OUT}/nim-1-wallet.png` });
    await page.keyboard.press("Escape");
  });
  await step("pay airtime with NIM; server verifies on-chain before fulfilment", async () => {
    await page.goto(APP + "/pay?service=airtime", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /Nigeria/ }).click();
    await page.getByLabel("Recipient phone number").fill("08031234567");
    await page.getByText(/✓ .*MTN Nigeria/).waitFor({ timeout: 8000 });
    await page.getByLabel(/Amount \(NGN\)/).fill("2000");
    await page.getByRole("radio", { name: /Pay with NIM/ }).click();
    await page.getByRole("button", { name: "Review payment" }).click();
    await page.getByRole("button", { name: /^Pay .* NIM$/ }).click();
    // The wallet stand-in has "sent" the tx; the server can't see it on-chain yet.
    await page.getByText("Confirming your payment").waitFor({ timeout: 10_000 });
    await page.screenshot({ path: `${OUT}/nim-2-confirming.png` });
    const [tx] = await page.evaluate(() => window.__sentTxs);
    if (!/^AuraPay AP-/.test(tx.data)) throw new Error(`unexpected memo ${tx.data}`);
    // Now the mock chain includes the tx with enough confirmations.
    await fetch(`${MOCK}/_test/nimiq-tx`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hash, from: "NQ52 BBBB BBBB BBBB BBBB BBBB BBBB BBBB BBBB", to: tx.recipient, value: tx.value,
        recipientData: Buffer.from(tx.data).toString("hex"), blockNumber: 1001, confirmations: 3, timestamp: Date.now(), executionResult: true,
      }),
    });
    await page.getByText("New payment").waitFor({ timeout: 20_000 });
    await page.getByText("Successful").first().waitFor();
    await page.screenshot({ path: `${OUT}/nim-3-receipt.png`, fullPage: true });
  });
  await ctx.close();
}

// ---------------------------------------------------------------------------
console.log("\nInvest → Borrow (simulators)");
{
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  track(page, "invest");
  await step("simulated buy with explicit acknowledgement", async () => {
    await page.goto(APP + "/invest/AAPL", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Buy AAPL" }).first().click();
    await page.getByText("Estimated shares").first().waitFor();
    await page.screenshot({ path: `${OUT}/invest-1-buy.png` });
    await page.getByRole("button", { name: "Review order" }).click();
    const place = page.getByRole("button", { name: "Place simulated order" });
    if (await place.isEnabled()) throw new Error("must require acknowledgement");
    await page.getByLabel(/I understand this is a simulation/).check();
    await place.click();
    await page.getByText("Simulated order placed").waitFor();
  });
  await step("borrow against the simulated position", async () => {
    await page.goto(APP + "/borrow", { waitUntil: "networkidle" });
    await page.locator("label").filter({ hasText: "AAPL" }).locator("input[type=checkbox]").check();
    await page.getByLabel("Borrow amount").fill("20");
    await page.screenshot({ path: `${OUT}/borrow-1-calculator.png`, fullPage: true });
    await page.getByRole("button", { name: "Review loan" }).click();
    await page.getByRole("button", { name: "Open simulated loan" }).click();
    await page.getByText(/LN-/).first().waitFor({ timeout: 8000 });
    await page.screenshot({ path: `${OUT}/borrow-2-loan.png`, fullPage: true });
  });
  await ctx.close();
}

await browser.close();

const relevant = consoleErrors.filter((e) => !/Failed to load resource: the server responded with a status of 4\d\d/.test(e));
console.log(`\nConsole errors: ${relevant.length}`);
relevant.slice(0, 20).forEach((e) => console.log("   " + e));
console.log(failures ? `\n${failures} step(s) failed\n` : "\nAll UI steps passed\n");
process.exit(failures || relevant.length ? 1 : 0);
