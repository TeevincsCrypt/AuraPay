"use client";

import { useEffect, useRef, useState } from "react";
import { createCowSwapWidget, TradeType, type CowSwapWidgetHandler, type CowSwapWidgetParams } from "@cowprotocol/widget-lib";
import { CowWidgetEvents } from "@cowprotocol/events";
import { CheckCircle2, ExternalLink, Wallet } from "lucide-react";
import { api } from "@/lib/client/api";
import { useSession } from "@/lib/client/session";
import { useWallet, WalletActionError } from "@/lib/client/wallet";
import { CHAIN_NAMES, ISSUER_LEGAL_URL, STOCK_TOKENS } from "@/lib/shared/stock-tokens";
import type { StockQuote } from "@/lib/shared/types";
import { Button, Notice, Segmented, Sheet, Spinner } from "../ui";

/**
 * Buying a tokenised stock = a real swap executed by the user's wallet through CoW Protocol.
 * The CoW Swap widget handles quotes, token approval, order signing (EIP-712), settlement,
 * cross-chain delivery and the issuers' eligibility/geoblocking rules. AuraPay records the
 * posted order and verifies it against CoW's order book; holdings are read on-chain.
 */

type Funding = "polygon-usdt" | "same-chain";

const PALETTE = {
  baseTheme: "light" as const,
  primary: "#e8622c",
  background: "#f6f4f2",
  paper: "#ffffff",
  text: "#111111",
  danger: "#e0352b",
  warning: "#b7791f",
  alert: "#b7791f",
  info: "#2a78d6",
  success: "#13a05b",
};

export function BuySheet({ open, onClose, quote }: { open: boolean; onClose: () => void; quote: StockQuote }) {
  const w = useWallet();
  const session = useSession();
  const reg = STOCK_TOKENS[quote.symbol];
  const token = reg?.primary;
  const [funding, setFunding] = useState<Funding>("polygon-usdt");
  const [linking, setLinking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [posted, setPosted] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [cfg, setCfg] = useState<{ appCode: string; partnerFee: { bps: number; recipient: string } | null } | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const handler = useRef<CowSwapWidgetHandler | null>(null);

  const verified = session.user?.evmAddresses ?? [];
  const canTrade = w.evm.available && verified.length > 0 && Boolean(token);

  useEffect(() => {
    if (!open || cfg) return;
    let alive = true;
    api<{ appCode: string; partnerFee: { bps: number; recipient: string } | null }>("/api/invest/config")
      .then((c) => alive && setCfg(c))
      .catch(() => alive && setCfg({ appCode: "AuraPay", partnerFee: null }));
    return () => {
      alive = false;
    };
  }, [open, cfg]);

  useEffect(() => {
    if (!open || !canTrade || !cfg || !container.current || !token || !window.ethereum) return;
    const eth = window.ethereum;
    const provider = {
      on: (event: string, cb: unknown) => eth.on?.(event, cb as (...a: unknown[]) => void),
      request: <T,>(p: { method: string; params?: unknown[] }) => eth.request(p) as Promise<T>,
    };
    const sameChain = funding === "same-chain";
    const params: CowSwapWidgetParams = {
      appCode: cfg.appCode,
      chainId: (sameChain ? token.chainId : 137) as CowSwapWidgetParams["chainId"],
      ...(sameChain ? {} : { targetChainId: token.chainId }),
      tradeType: TradeType.SWAP,
      enabledTradeTypes: [TradeType.SWAP],
      sell: { asset: sameChain ? "USDC" : "USDT", amount: "25" },
      buy: { asset: token.address },
      customTokens: reg.all.map((t) => ({ chainId: t.chainId, address: t.address, name: `${quote.name} (${t.issuer})`, decimals: t.decimals, symbol: t.symbol })),
      standaloneMode: false,
      disableCustomRecipient: true,
      disableTokenImport: true,
      hideRecentTokens: true,
      theme: PALETTE,
      rootStyle: { width: "100%", height: "620px", borderRadius: "20px" },
      ...(cfg.partnerFee ? { partnerFee: cfg.partnerFee } : {}),
    } as CowSwapWidgetParams;

    handler.current = createCowSwapWidget(container.current, {
      params,
      provider,
      onReady: () => setReady(true),
      onLoadingError: () => setErr("The trading widget couldn't load. Check your connection and try again."),
      listeners: [
        {
          event: CowWidgetEvents.ON_POSTED_ORDER,
          handler: (p) => {
            setPosted(p.orderUid);
            void api("/api/invest/trades", {
              method: "POST",
              json: {
                symbol: quote.symbol,
                orderUid: p.orderUid,
                chainId: p.chainId,
                destinationChainId: p.destinationChainId ?? null,
                owner: p.owner,
                inputToken: { address: p.inputToken.address, symbol: p.inputToken.symbol, decimals: p.inputToken.decimals },
                inputAmount: String(p.inputAmount),
                outputToken: { address: p.outputToken.address },
                outputAmount: String(p.outputAmount),
              },
            }).catch((e) => setErr(`Your order was placed, but AuraPay couldn't record it: ${(e as Error).message}`));
          },
        },
      ],
    });
    return () => {
      handler.current?.destroy();
      handler.current = null;
      setReady(false);
    };
  }, [open, canTrade, cfg, funding, token, reg, quote.symbol, quote.name]);

  return (
    <Sheet open={open} onClose={onClose} title={`Buy ${quote.name}`} wide>
      {!token ? (
        <Notice tone="warn">{quote.symbol} isn&apos;t available as a tokenised stock yet.</Notice>
      ) : (
        <div className="space-y-4">
          <div className="rounded-[20px] bg-surface-2 p-4 text-[13px] leading-relaxed text-fg-2">
            You&apos;ll receive <strong className="text-fg">{token.symbol}</strong>, {token.issuer === "Coinbase" ? "Coinbase's" : "Backed's xStocks"} tokenised {quote.name} on{" "}
            <strong className="text-fg">{CHAIN_NAMES[token.chainId]}</strong>, held in your own wallet.{" "}
            <a className="inline-flex items-center gap-0.5 text-accent" href={ISSUER_LEGAL_URL[token.issuer]} target="_blank" rel="noreferrer">
              Issuer terms <ExternalLink className="size-3" />
            </a>
          </div>

          {!w.evm.available ? (
            <Notice tone="warn" title="Open AuraPay in Nimiq Pay">
              Buying uses your Nimiq Pay EVM wallet to pay and sign.
            </Notice>
          ) : verified.length === 0 ? (
            <div className="space-y-3">
              <Notice tone="info">Verify your EVM wallet once so AuraPay can show your holdings and record your orders.</Notice>
              {err ? <Notice tone="error">{err}</Notice> : null}
              <Button
                size="lg"
                loading={linking}
                onClick={async () => {
                  setErr(null);
                  setLinking(true);
                  try {
                    await w.linkEvm();
                    await session.refresh();
                  } catch (e) {
                    if (!(e instanceof WalletActionError && e.kind === "rejected")) setErr((e as Error).message);
                  } finally {
                    setLinking(false);
                  }
                }}
              >
                <Wallet className="size-4" /> Verify wallet
              </Button>
            </div>
          ) : (
            <>
              <div>
                <p className="mb-2 text-[13px] font-medium text-fg-2">Pay with</p>
                <Segmented<Funding>
                  className="w-full"
                  value={funding}
                  onChange={(v) => {
                    setReady(false);
                    setFunding(v);
                  }}
                  options={[
                    { value: "polygon-usdt", label: "USDT · Polygon" },
                    { value: "same-chain", label: `USDC · ${CHAIN_NAMES[token.chainId]}` },
                  ]}
                />
                <p className="mt-2 text-xs text-fg-3">
                  {funding === "polygon-usdt"
                    ? `Uses the USDT in your Nimiq Pay wallet. The stock token is delivered to ${CHAIN_NAMES[token.chainId]} via CoW Protocol's cross-chain swap.`
                    : `Uses USDC you already hold on ${CHAIN_NAMES[token.chainId]}.`}{" "}
                  Network fees apply.
                </p>
              </div>
              {posted ? (
                <Notice tone="success" title="Order placed">
                  We&apos;ll confirm it against CoW Protocol&apos;s order book. It appears in Activity, and the tokens in your portfolio once settled.
                </Notice>
              ) : null}
              {err ? <Notice tone="error">{err}</Notice> : null}
              <div className="relative min-h-[620px] overflow-hidden rounded-[20px] bg-surface-2">
                {!ready ? (
                  <div className="absolute inset-0 grid place-items-center">
                    <Spinner />
                  </div>
                ) : null}
                <div ref={container} />
              </div>
              <p className="flex items-start gap-1.5 text-[11.5px] leading-relaxed text-fg-3">
                <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
                Tokenised stocks are issued by third parties, may not confer shareholder rights and aren&apos;t available in every country. Prices move; you can lose money.
              </p>
            </>
          )}
        </div>
      )}
    </Sheet>
  );
}
