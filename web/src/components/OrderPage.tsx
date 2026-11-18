import { useEffect, useRef, useState } from "react";
import { api, ApiError, type AppConfig, type Order, type OrderState } from "../api.ts";
import { displayProduct, displayRecipient, money, sats, satsToLocal } from "../format.ts";
import { navigate, useReducedMotion, useWalletBalance } from "../hooks.ts";
import { useT } from "../i18n.ts";
import { walletPay } from "../wallet.ts";
import type { LockVisual } from "./lock3d/scene.ts";
import { LockCoin } from "./lock3d/LockCoin.tsx";
import { Qr } from "./Qr.tsx";
import { Timeline } from "./Timeline.tsx";

type Props = {
  orderId: string;
  config: AppConfig | null;
  onOpenWallet: () => void;
};

const TERMINAL = new Set<OrderState>(["completed", "released", "expired"]);
const WALLET_APP_WAIT_MS = 1500;
const VISUAL: Record<OrderState, LockVisual> = {
  awaiting_payment: "awaiting",
  locked: "locked",
  vending: "vending",
  delivered: "vending",
  completed: "completed",
  released: "released",
  expired: "expired",
};

export function OrderPage({ orderId, config, onOpenWallet }: Props) {
  const { lang, t } = useT();
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isNotFound, setIsNotFound] = useState(false);
  const stateRef = useRef<OrderState | null>(null);
  const [isPaying, setIsPaying] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"invoice" | "token" | null>(null);
  const [receiptValid, setReceiptValid] = useState<boolean | null>(null);
  const startBalance = useRef<number | null>(null);
  const stampRef = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const wallet = useWalletBalance(2500);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async (): Promise<void> => {
      try {
        const o = await api.order(orderId);
        if (!alive) return;
        stateRef.current = o.state;
        setOrder(o);
        setError(null);
        if (!TERMINAL.has(o.state)) timer = setTimeout(load, 1500);
      } catch (e) {
        if (!alive) return;
        if (e instanceof ApiError && e.status === 404) {
          setIsNotFound(true); // a wrong or old link: polling cannot fix that
          return;
        }
        setError(e instanceof ApiError ? e.message : t.couldNotLoad);
        timer = setTimeout(load, 4000);
      }
    };
    void load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [orderId, t.couldNotLoad]);

  useEffect(() => {
    if (startBalance.current === null && wallet.balance !== null && order?.state === "awaiting_payment") {
      startBalance.current = wallet.balance;
    }
  }, [wallet.balance, order?.state]);

  // Verify the signed receipt in the browser: no need to trust our server.
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

  const finalState = order && (order.state === "completed" || order.state === "released") ? order.state : null;
  useEffect(() => {
    if (!finalState || reduced || !stampRef.current) return;
    const el = stampRef.current;
    let tween: { revert: () => unknown } | null = null;
    let isCancelled = false;
    void import("gsap").then(({ gsap }) => {
      if (isCancelled) return; // unmounted (or React re-ran the effect) before GSAP loaded
      tween = gsap.fromTo(el, { scale: 1.6, opacity: 0, rotate: -16 }, { scale: 1, opacity: 0.92, rotate: -6, duration: 0.45, ease: "back.out(2)", delay: 0.5 });
    });
    return () => {
      isCancelled = true;
      tween?.revert(); // back to the stylesheet's resting stamp, never stuck half-animated
    };
  }, [finalState, reduced]);

  function handleWalletPay(invoice: string): void {
    setPayError(null);
    setIsPaying(true);
    // A hold-invoice payment only resolves after delivery (paid) or release (rejected), so the UI
    // follows the order status. A wallet error matters only while the order still awaits payment;
    // once it is locked, a rejection just means the lock was released later.
    walletPay(invoice)
      .catch((e: unknown) => {
        if (stateRef.current === "awaiting_payment") setPayError(e instanceof Error ? e.message : t.walletCouldNotPay);
      })
      .finally(() => setIsPaying(false));
  }

  // A lightning: link with no wallet app installed does nothing at all. If the page is still in front
  // after a moment, no app took over: say so instead of leaving a dead button.
  function handleOpenWalletApp(): void {
    setPayError(null);
    let isLeft = false;
    const onHide = (): void => {
      isLeft = true;
    };
    window.addEventListener("blur", onHide, { once: true });
    document.addEventListener("visibilitychange", onHide, { once: true });
    window.setTimeout(() => {
      window.removeEventListener("blur", onHide);
      document.removeEventListener("visibilitychange", onHide);
      if (!isLeft && document.visibilityState === "visible") setPayError(t.noWalletApp);
    }, WALLET_APP_WAIT_MS);
  }

  async function handleCopy(text: string, what: "invoice" | "token"): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 1800);
    } catch {
      setCopied(null);
    }
  }

  if (isNotFound) {
    return (
      <section className="receipt">
        <p className="notice error" role="alert">
          {t.orderNotFound}
        </p>
        <div className="btn-row">
          <button type="button" className="btn paper" onClick={() => navigate("#/")}>
            {t.buyAnother}
          </button>
        </div>
      </section>
    );
  }

  if (!order) {
    return (
      <section className="receipt" aria-busy="true">
        {error ? <p className="notice error">{error}</p> : <p className="muted">{t.loadingOrder}</p>}
      </section>
    );
  }

  const [headline, detail] = order.deliveredAfterRelease ? t.lateDelivered : (t.headline[order.state] ?? ["", ""]);
  const stamp = order.state === "completed" ? { cls: "ok", text: t.stampOk } : order.state === "released" ? { cls: "stop", text: t.stampStop } : null;
  const expiresInMin = Math.max(1, Math.ceil((order.invoiceExpiresAt - Date.now()) / 60000));
  const balanceClass = order.state === "locked" || order.state === "vending" ? "lock" : order.state === "released" ? "ok" : "";
  const balanceNote =
    order.state === "locked" || order.state === "vending" ? t.lockedNotSent : order.state === "released" ? t.backWhereStarted : "";

  return (
    <>
      <LockCoin state={VISUAL[order.state]} label={t.lockLabel(headline)} className="order__lock" />

      <section className="receipt" aria-labelledby="order-headline" aria-live="polite">
        <div className="receipt__head">
          <p className="eyebrow">
            {t.order} {order.id.slice(0, 8)}
          </p>
          {stamp && (
            <div ref={stampRef} className={`stamp ${stamp.cls}`} aria-hidden="true">
              {stamp.text}
            </div>
          )}
        </div>
        <h2 id="order-headline">{headline}</h2>
        <p className="muted">{detail}</p>
        {(order.state === "locked" || order.state === "vending" || order.state === "delivered") && (
          <p className="hint">{t.waitHint(config?.limits.vendDeadlineSec ?? 90)}</p>
        )}
        {error && <p className="hint">{t.reconnecting}</p>}
        <hr className="dash" />
        <dl className="rows">
          <div>
            <dt>{t.item}</dt>
            <dd>{displayProduct(order.product, lang)}</dd>
          </div>
          <div>
            <dt>{t.for}</dt>
            <dd>
              {displayRecipient(order.recipient, lang)}
              {order.customerName ? ` · ${order.customerName}` : ""}
            </dd>
          </div>
          <div>
            <dt>{t.total}</dt>
            <dd className="money">
              {money(order.amountLocal, order.currency, lang)} · {sats(order.amountSats, lang)}
            </dd>
          </div>
        </dl>

        {order.token && (
          <>
            <div className="token-box" role="group" aria-label="Token">
              <div className="token">{order.token}</div>
              {order.units && <div className="units">{order.units}</div>}
            </div>
            <button type="button" className="btn ghost" onClick={() => handleCopy(order.token!.replace(/\s/g, ""), "token")}>
              {copied === "token" ? t.copied : t.copyToken}
            </button>
          </>
        )}

        {wallet.connected && wallet.balance !== null && (
          <>
            <hr className="dash" />
            <div className={`balance-line ${balanceClass}`}>
              <span>
                {t.yourWallet} {balanceNote}
              </span>
              <span className="money">{sats(wallet.balance, lang)}</span>
            </div>
            {startBalance.current !== null && (
              <p className="hint">
                {t.startedAt} {sats(startBalance.current, lang)} ≈ {money(satsToLocal(startBalance.current, order.ratePerBtc), order.currency, lang)}
              </p>
            )}
          </>
        )}
      </section>

      {order.state === "awaiting_payment" && order.invoice && (
        <section className="receipt" aria-labelledby="pay-title">
          <p className="eyebrow" id="pay-title">
            {t.pay(sats(order.amountSats, lang))}
          </p>
          <Qr value={order.invoice} label="Lightning invoice QR code" />
          <p className="invoice-text">{order.invoice}</p>
          <div className="btn-row">
            {wallet.connected ? (
              <button type="button" className="btn lime" onClick={() => handleWalletPay(order.invoice!)} disabled={isPaying}>
                {isPaying ? <span className="spinner" aria-hidden="true" /> : null}
                {isPaying ? t.locking : t.payWithWallet}
              </button>
            ) : config?.testWallet.enabled ? (
              <button type="button" className="btn lime" onClick={onOpenWallet}>
                {t.getTestWallet}
              </button>
            ) : null}
            {/* Test-network invoices can't be paid by wallets on the public Lightning network, so the
                hand-off to a wallet app is offered only when the merchant wallet is a real one. */}
            {config && !config.testWallet.enabled && (
              <a className="btn ghost" href={`lightning:${order.invoice}`} onClick={handleOpenWalletApp}>
                {t.openWallet}
              </a>
            )}
            <button type="button" className="btn ghost" onClick={() => handleCopy(order.invoice!, "invoice")}>
              {copied === "invoice" ? t.copied : t.copyInvoice}
            </button>
          </div>
          {payError && (
            <p className="notice error" role="alert">
              {payError}
            </p>
          )}
          <p className="hint">{t.expiresIn(expiresInMin)}</p>
        </section>
      )}

      <section className="receipt" aria-labelledby="progress-title">
        <p className="eyebrow" id="progress-title">
          {t.progress}
        </p>
        <Timeline order={order} />
      </section>

      {order.state === "completed" && (
        <section className="receipt" aria-labelledby="proof-title">
          <p className="eyebrow" id="proof-title">
            {t.signedReceipt}
          </p>
          {order.receipt ? (
            <>
              <p>{receiptValid === null ? t.checkingSig : receiptValid ? t.sigOk : t.sigBad}</p>
              <p className="hint breakall">
                {t.signedBy} {config?.receipts.npub}
              </p>
            </>
          ) : (
            <p className="muted">{t.receiptUnavailable}</p>
          )}
        </section>
      )}

      <div className="btn-row">
        <button type="button" className="btn paper" onClick={() => navigate("#/")}>
          {t.buyAnother}
        </button>
      </div>
    </>
  );
}
