import { useEffect, useRef, useState } from "react";
import { api, ApiError, type AppConfig, type Order } from "../api.ts";
import { naira, sats, satsToNaira } from "../format.ts";
import { navigate, useReducedMotion, useWalletBalance } from "../hooks.ts";
import { walletPay } from "../wallet.ts";
import { Qr } from "./Qr.tsx";
import { Timeline } from "./Timeline.tsx";

type Props = {
  orderId: string;
  config: AppConfig | null;
  onOpenWallet: () => void;
};

const TERMINAL = new Set(["completed", "released", "expired"]);

export function OrderPage({ orderId, config, onOpenWallet }: Props) {
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPaying, setIsPaying] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [receiptValid, setReceiptValid] = useState<boolean | null>(null);
  const startBalance = useRef<number | null>(null);
  const stampRef = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const wallet = useWalletBalance(2500);

  // Poll the order until it reaches a final state.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async (): Promise<void> => {
      try {
        const o = await api.order(orderId);
        if (!alive) return;
        setOrder(o);
        setError(null);
        if (!TERMINAL.has(o.state)) timer = setTimeout(load, 1500);
      } catch (e) {
        if (!alive) return;
        setError(e instanceof ApiError ? e.message : "Could not load your order.");
        timer = setTimeout(load, 4000);
      }
    };
    void load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [orderId]);

  useEffect(() => {
    if (startBalance.current === null && wallet.balance !== null && order?.state === "awaiting_payment") {
      startBalance.current = wallet.balance;
    }
  }, [wallet.balance, order?.state]);

  // Verify the signed receipt in the browser (no trust in our own server needed).
  useEffect(() => {
    if (!order?.receipt || !config) return;
    let alive = true;
    import("nostr-tools/pure")
      .then(({ verifyEvent }) => {
        const r = order.receipt!;
        if (alive) setReceiptValid(r.pubkey === config.receipts.pubkey && verifyEvent(r as Parameters<typeof verifyEvent>[0]));
      })
      .catch(() => alive && setReceiptValid(false));
    return () => {
      alive = false;
    };
  }, [order?.receipt, config]);

  // Stamp animation on a final state (GSAP loaded lazily; skipped for reduced motion).
  const finalState = order && (order.state === "completed" || order.state === "released") ? order.state : null;
  useEffect(() => {
    if (!finalState || reduced || !stampRef.current) return;
    const el = stampRef.current;
    let tween: { kill: () => void } | null = null;
    void import("gsap").then(({ gsap }) => {
      tween = gsap.fromTo(el, { scale: 2.2, opacity: 0, rotate: -24 }, { scale: 1, opacity: 0.9, rotate: -12, duration: 0.45, ease: "back.out(2)" });
    });
    return () => tween?.kill();
  }, [finalState, reduced]);

  async function handleWalletPay(invoice: string): Promise<void> {
    setPayError(null);
    setIsPaying(true);
    const startedAt = Date.now();
    // With a hold invoice this promise only settles after delivery (paid) or release (rejected),
    // so the UI follows the order status instead of waiting on it.
    walletPay(invoice)
      .catch((e: unknown) => {
        if (Date.now() - startedAt < 8000) setPayError(e instanceof Error ? e.message : "Your wallet could not pay.");
      })
      .finally(() => setIsPaying(false));
  }

  async function handleCopy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  if (!order) {
    return (
      <section className="receipt" aria-busy="true">
        {error ? <p className="notice error">{error}</p> : <p className="muted">Loading your order…</p>}
      </section>
    );
  }

  const stamp = order.state === "completed" ? { cls: "ok", text: "Confam" } : order.state === "released" ? { cls: "stop", text: "Not charged" } : null;
  const expiresInSec = Math.max(0, Math.round((order.invoiceExpiresAt - Date.now()) / 1000));
  const balanceClass = order.state === "locked" || order.state === "vending" ? "lock" : order.state === "released" ? "ok" : "";

  return (
    <>
      <section className="receipt stamp-host" aria-labelledby="order-headline" aria-live="polite">
        {stamp && (
          <div ref={stampRef} className={`stamp ${stamp.cls}`} aria-hidden="true">
            {stamp.text}
          </div>
        )}
        <p className="eyebrow">Order {order.id.slice(0, 8)}</p>
        <h2 id="order-headline">{order.headline}</h2>
        <p className="muted">{order.detail}</p>
        <hr className="dash" />
        <dl className="rows">
          <div>
            <dt>Item</dt>
            <dd>{order.product}</dd>
          </div>
          <div>
            <dt>For</dt>
            <dd>
              {order.recipient}
              {order.customerName ? ` · ${order.customerName}` : ""}
            </dd>
          </div>
          <div>
            <dt>Amount</dt>
            <dd className="money">
              {naira(order.amountNgn)} · {sats(order.amountSats)}
            </dd>
          </div>
        </dl>

        {order.token && (
          <div className="token-box" role="group" aria-label="Your electricity token">
            <div className="token">{order.token}</div>
            {order.units && <div className="units">{order.units}</div>}
          </div>
        )}
        {order.token && (
          <button type="button" className="btn ghost" onClick={() => handleCopy(order.token!.replace(/\s/g, ""))}>
            {copied ? "Copied ✓" : "Copy token"}
          </button>
        )}

        {wallet.connected && wallet.balance !== null && (
          <>
            <hr className="dash" />
            <div className={`balance-line ${balanceClass}`}>
              <span>
                Your wallet{" "}
                {order.state === "locked" || order.state === "vending"
                  ? "(sats locked, not sent)"
                  : order.state === "released"
                    ? "(back where it started)"
                    : ""}
              </span>
              <span className="money">{sats(wallet.balance)}</span>
            </div>
            {startBalance.current !== null && (
              <p className="hint">
                Started at {sats(startBalance.current)} ≈ {naira(satsToNaira(startBalance.current, order.rateNgnPerBtc))}
              </p>
            )}
          </>
        )}
      </section>

      {order.state === "awaiting_payment" && order.invoice && (
        <section className="receipt" aria-labelledby="pay-title">
          <p className="eyebrow" id="pay-title">
            Pay {sats(order.amountSats)}
          </p>
          <Qr value={order.invoice} label="Lightning invoice QR code" />
          <p className="invoice-text">{order.invoice}</p>
          <div className="btn-row">
            {wallet.connected ? (
              <button type="button" className="btn lime" onClick={() => handleWalletPay(order.invoice!)} disabled={isPaying}>
                {isPaying ? <span className="spinner" aria-hidden="true" /> : null}
                {isPaying ? "Locking your sats…" : "Pay with my Confam wallet"}
              </button>
            ) : config?.testWallet.enabled ? (
              <button type="button" className="btn lime" onClick={onOpenWallet}>
                Get a free test wallet to pay
              </button>
            ) : null}
            <a className="btn ghost" href={`lightning:${order.invoice}`}>
              Open in my Lightning wallet
            </a>
            <button type="button" className="btn ghost" onClick={() => handleCopy(order.invoice!)}>
              {copied ? "Copied ✓" : "Copy invoice"}
            </button>
          </div>
          {payError && (
            <p className="notice error" role="alert">
              {payError}
            </p>
          )}
          <p className="hint">Invoice expires in about {Math.ceil(expiresInSec / 60)} min. Paying only locks your sats.</p>
        </section>
      )}

      <section className="receipt" aria-labelledby="progress-title">
        <p className="eyebrow" id="progress-title">
          Progress
        </p>
        <Timeline order={order} />
      </section>

      {order.receipt && (
        <section className="receipt" aria-labelledby="proof-title">
          <p className="eyebrow" id="proof-title">
            Signed receipt
          </p>
          <p>
            {receiptValid === null ? "Checking signature…" : receiptValid ? "✓ Signature verified in your browser" : "✕ Signature could not be verified"}
          </p>
          <p className="hint" style={{ wordBreak: "break-all" }}>
            Signed by {config?.receipts.npub} · payment hash {(order.receipt.tags.find((t) => t[0] === "x")?.[1] ?? "").slice(0, 16)}…
          </p>
        </section>
      )}

      <div className="btn-row">
        <button type="button" className="btn ghost" style={{ background: "var(--paper)" }} onClick={() => navigate("#/")}>
          Buy something else
        </button>
      </div>
    </>
  );
}
