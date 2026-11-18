import { LightningError, type HoldInvoiceProvider } from "../lightning/types.ts";
import type { BillProvider, ProviderRegistry, VendResult } from "../providers/types.ts";
import type { ReceiptSigner } from "../receipts/sign.ts";
import type { OrderStore } from "./store.ts";
import { ACTIVE_STATES, type Order, type ReleaseReason } from "./types.ts";

export interface Logger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface EngineConfig {
  vendDeadlineSec: number;
  tickMs: number;
  /** Seconds after invoice expiry before an unpaid order is closed. */
  expiryGraceSec?: number;
  requeryIntervalSec?: number;
  reconIntervalSec?: number;
  reconMaxAgeSec?: number;
}

export interface EngineDeps {
  store: OrderStore;
  ln: HoldInvoiceProvider;
  providers: ProviderRegistry;
  signer: ReceiptSigner;
  log: Logger;
  cfg: EngineConfig;
  now?: () => number;
}

/**
 * Drives every order through: lock -> buy -> (deliver -> settle) | (fail -> cancel).
 * Invariants:
 *  1. provider.purchase() is called at most once per order (guarded by the locked->vending CAS).
 *  2. purchase() is never called unless the customer's sats are locked (hold invoice ACCEPTED).
 *  3. The hold invoice is settled only after the provider confirms delivery.
 *  4. Anything unclear keeps the lock; at the deadline the lock is released (customer is never charged).
 */
export class OrderEngine {
  private readonly inflight = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly now: () => number;
  private readonly cfg: Required<EngineConfig>;

  constructor(private readonly deps: EngineDeps) {
    this.now = deps.now ?? Date.now;
    this.cfg = {
      expiryGraceSec: 30,
      requeryIntervalSec: 3,
      reconIntervalSec: 60,
      reconMaxAgeSec: 24 * 3600,
      ...deps.cfg,
    };
  }

  async start(): Promise<void> {
    if (this.deps.ln.subscribeAccepted) {
      try {
        this.unsubscribe = await this.deps.ln.subscribeAccepted((hash) => {
          const order = this.deps.store.getByPaymentHash(hash);
          if (order) void this.process(order.id);
        });
      } catch (err) {
        this.deps.log.warn({ err: errMsg(err) }, "lock notifications unavailable; relying on polling");
      }
    }
    this.timer = setInterval(() => void this.tick(), this.cfg.tickMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  async tick(): Promise<void> {
    try {
      // Orders run in parallel so one slow provider call never delays another customer's lock/release.
      await Promise.allSettled([
        ...this.deps.store.listByStates(ACTIVE_STATES).map((o) => this.process(o.id)),
        ...this.deps.store.listWatchingRecon().map((o) => this.reconcile(o)),
      ]);
    } catch (err) {
      // Runs from setInterval: a throw here would be an unhandled rejection and stop the server.
      this.deps.log.error({ err: errMsg(err) }, "engine tick failed; retrying next tick");
    }
  }

  /** Safe to call concurrently and repeatedly for the same order. */
  async process(orderId: string): Promise<void> {
    if (this.inflight.has(orderId)) return;
    this.inflight.add(orderId);
    try {
      await this.step(orderId);
    } catch (err) {
      this.deps.log.error({ orderId, err: errMsg(err) }, "order step failed; will retry");
    } finally {
      this.inflight.delete(orderId);
    }
  }

  private provider(order: Order): BillProvider | null {
    return this.deps.providers[order.provider] ?? null;
  }

  private async step(orderId: string): Promise<void> {
    let order = this.deps.store.get(orderId);
    if (!order) return;
    if (order.state === "awaiting_payment") order = await this.onAwaitingPayment(order);
    if (order?.state === "locked") order = await this.onLocked(order);
    if (order?.state === "vending") order = await this.onVending(order);
    if (order?.state === "delivered") await this.onDelivered(order);
  }

  private async onAwaitingPayment(order: Order): Promise<Order | null> {
    const status = await this.lnStatus(order);
    if (!status) return null;
    const nowMs = this.now();

    if (status.state === "accepted") {
      if (status.amountMsat > 0 && status.amountMsat < order.amountSats * 1000) {
        return this.release(order, "amount_mismatch", `locked ${status.amountMsat} msat, expected ${order.amountSats * 1000}`);
      }
      return this.deps.store.transition(order.id, "awaiting_payment", "locked", { lockedAt: nowMs }, "payment locked (not sent)", nowMs);
    }
    if (status.state === "canceled") {
      return this.deps.store.transition(order.id, "awaiting_payment", "expired", {}, "invoice expired unpaid", nowMs);
    }
    if (status.state === "settled") {
      // Only this server knows the preimage, so this should be impossible. Never vend twice; flag for ops.
      this.deps.log.error({ orderId: order.id }, "invoice settled before delivery: anomaly");
      return null;
    }
    if (nowMs > order.invoiceExpiresAt + this.cfg.expiryGraceSec * 1000) {
      await this.safeCancel(order);
      return this.deps.store.transition(order.id, "awaiting_payment", "expired", {}, "invoice expired unpaid", nowMs);
    }
    return order;
  }

  private async onLocked(order: Order): Promise<Order | null> {
    // Re-verify the lock is still held right before spending real money with the provider.
    const status = await this.lnStatus(order);
    if (!status) return null;
    if (status.state !== "accepted") {
      if (status.state === "canceled") return this.release(order, "lock_lost", "payment lock disappeared before purchase");
      this.deps.log.error({ orderId: order.id, state: status.state }, "unexpected invoice state while locked");
      return null;
    }
    const provider = this.provider(order);
    if (!provider) return this.release(order, "delivery_failed", `bill provider ${order.provider} not configured`);

    const startedAt = this.now();
    // lastRequeryAt = startedAt: the purchase call counts as the latest provider contact, so the first
    // status check waits a full interval (providers ask clients not to fire back-to-back requests).
    const claimed = this.deps.store.transition(
      order.id,
      "locked",
      "vending",
      { vendStartedAt: startedAt, lastRequeryAt: startedAt },
      "buying from provider",
      startedAt,
    );
    if (!claimed) return this.deps.store.get(order.id); // another worker owns the purchase

    let result: VendResult;
    try {
      result = await provider.purchase(claimed);
    } catch (err) {
      result = { outcome: "pending", code: null, status: null, reason: errMsg(err) };
    }
    if (result.providerRef) this.deps.store.patch(order.id, { providerRef: result.providerRef }, this.now());
    this.deps.log.info({ orderId: order.id, provider: provider.id, outcome: result.outcome, code: result.code, status: result.status }, "provider responded");
    return this.applyOutcome({ ...claimed, providerRef: result.providerRef ?? claimed.providerRef }, result);
  }

  private async onVending(order: Order): Promise<Order | null> {
    const nowMs = this.now();
    if (order.lastRequeryAt && nowMs - order.lastRequeryAt < this.cfg.requeryIntervalSec * 1000) {
      return this.checkDeadline(order);
    }
    const provider = this.provider(order);
    if (!provider) return this.release(order, "delivery_unconfirmed", `bill provider ${order.provider} not configured`);
    const secondsSincePurchase = Math.floor((nowMs - (order.vendStartedAt ?? nowMs)) / 1000);
    let result: VendResult;
    try {
      result = await provider.check(order, secondsSincePurchase);
    } catch (err) {
      result = { outcome: "pending", code: null, status: null, reason: errMsg(err) };
    }
    const patch = { lastRequeryAt: nowMs, ...(result.providerRef && !order.providerRef ? { providerRef: result.providerRef } : {}) };
    this.deps.store.patch(order.id, patch, nowMs);
    return this.applyOutcome({ ...order, ...patch }, result);
  }

  private async applyOutcome(order: Order, result: VendResult): Promise<Order | null> {
    const nowMs = this.now();
    if (result.outcome === "delivered") {
      return this.deps.store.transition(
        order.id,
        "vending",
        "delivered",
        {
          deliveredAt: nowMs,
          providerCode: result.code,
          providerStatus: result.status,
          providerTxId: result.txId ?? null,
          token: result.token ?? null,
          units: result.units ?? null,
        },
        "provider confirmed delivery",
        nowMs,
      );
    }
    if (result.outcome === "failed") {
      if (result.code && PROVIDER_ACCOUNT_CODES.has(result.code)) {
        // Not the customer's fault: Confam's provider account needs attention (float, keys, whitelist).
        this.deps.log.error({ orderId: order.id, alert: "provider_account", provider: order.provider, code: result.code }, `provider account problem: ${result.reason}`);
      }
      this.deps.store.patch(order.id, { providerCode: result.code, providerStatus: result.status }, nowMs);
      return this.release(order, "delivery_failed", result.reason);
    }
    this.deps.store.patch(order.id, { providerCode: result.code, providerStatus: result.status, failureDetail: result.reason }, nowMs);
    return this.checkDeadline({ ...order, failureDetail: result.reason });
  }

  private async checkDeadline(order: Order): Promise<Order | null> {
    const started = order.vendStartedAt ?? order.lockedAt ?? order.createdAt;
    if (this.now() - started <= this.cfg.vendDeadlineSec * 1000) return order;
    const last = order.failureDetail ? ` (last provider reply: ${order.failureDetail})` : "";
    return this.release(order, "delivery_unconfirmed", `provider could not confirm delivery in time${last}`);
  }

  private async onDelivered(order: Order): Promise<void> {
    const deliveredAtSec = Math.floor((order.deliveredAt ?? this.now()) / 1000);
    const receipt = order.receiptJson ?? JSON.stringify(this.deps.signer.sign(order, deliveredAtSec));
    try {
      await this.deps.ln.settle(order.preimage);
    } catch (err) {
      const status = await this.lnStatus(order);
      if (status?.state === "canceled") {
        // The lock is gone (e.g. it expired at its time limit) after the provider delivered: the
        // customer can never be charged now. Close it as delivered-after-release instead of retrying.
        this.deps.log.error({ orderId: order.id, alert: "delivered_lock_lost" }, "lock canceled before settlement; delivered free");
        const nowMs = this.now();
        this.deps.store.transition(
          order.id,
          "delivered",
          "released",
          { releasedAt: nowMs, releaseReason: "lock_lost", failureDetail: "lock canceled before settlement", reconState: "delivered_after_release", billersCode: null, phone: null },
          "delivered, but the lock was gone before payment: customer not charged",
          nowMs,
        );
        return;
      }
      if (status?.state !== "settled") {
        this.deps.log.error({ orderId: order.id, err: errMsg(err) }, "settle failed; retrying next tick");
        this.deps.store.patch(order.id, { receiptJson: receipt }, this.now());
        return;
      }
    }
    const nowMs = this.now();
    this.deps.store.transition(
      order.id,
      "delivered",
      "completed",
      { completedAt: nowMs, receiptJson: receipt, billersCode: null, phone: null },
      "payment completed (delivery confirmed first)",
      nowMs,
    );
  }

  /** Cancels the hold invoice (customer's sats are released) and marks the order released. */
  private async release(order: Order, reason: ReleaseReason, detail: string): Promise<Order | null> {
    const ok = await this.safeCancel(order);
    if (!ok) return null; // could not confirm the lock was released; retry next tick, never mark released falsely
    const nowMs = this.now();
    return this.deps.store.transition(
      order.id,
      order.state,
      "released",
      {
        releasedAt: nowMs,
        releaseReason: reason,
        failureDetail: detail,
        reconState: reason === "delivery_unconfirmed" ? "watching" : null,
        billersCode: null,
        phone: null,
      },
      `lock released, customer not charged: ${detail}`,
      nowMs,
    );
  }

  /** True once the invoice is confirmed canceled (or was never paid). */
  private async safeCancel(order: Order): Promise<boolean> {
    try {
      await this.deps.ln.cancel(order.paymentHash);
      return true;
    } catch (err) {
      const status = await this.lnStatus(order);
      if (status?.state === "canceled" || status?.state === "open") return true;
      if (err instanceof LightningError && err.code === "NOT_FOUND" && !status) return true;
      this.deps.log.error({ orderId: order.id, err: errMsg(err), state: status?.state }, "cancel failed; retrying");
      return false;
    }
  }

  /** After a release on an unconfirmed outcome, keep asking the provider so ops can reconcile. */
  private async reconcile(order: Order): Promise<void> {
    const provider = this.provider(order);
    if (!provider || this.inflight.has(order.id)) return;
    const nowMs = this.now();
    if (order.lastRequeryAt && nowMs - order.lastRequeryAt < this.cfg.reconIntervalSec * 1000) return;
    if (nowMs - order.createdAt > this.cfg.reconMaxAgeSec * 1000) return;
    this.inflight.add(order.id);
    try {
      const result = await provider.check(order, 3600);
      // Only an explicit provider status closes reconciliation; "not visible yet" keeps watching.
      const patch =
        result.outcome === "delivered"
          ? { reconState: "delivered_after_release" as const, token: result.token ?? null, units: result.units ?? null }
          : result.outcome === "failed" && (result.status || result.code)
            ? { reconState: "confirmed_not_delivered" as const }
            : {};
      this.deps.store.patch(order.id, { ...patch, lastRequeryAt: nowMs }, nowMs);
      if (result.outcome === "delivered") this.deps.log.warn({ orderId: order.id }, "delivered after release (operator absorbs cost)");
    } catch (err) {
      this.deps.store.patch(order.id, { lastRequeryAt: nowMs }, nowMs);
      this.deps.log.warn({ orderId: order.id, err: errMsg(err) }, "reconciliation check failed");
    } finally {
      this.inflight.delete(order.id);
    }
  }

  private async lnStatus(order: Order): Promise<{ state: string; amountMsat: number } | null> {
    try {
      return await this.deps.ln.getStatus(order.paymentHash);
    } catch (err) {
      this.deps.log.warn({ orderId: order.id, err: errMsg(err) }, "lightning status unavailable");
      return null;
    }
  }
}

/**
 * Failure codes about Confam's own provider account rather than the order: VTpass wallet balance,
 * account locked/suspended/inactive, API access, IP or product whitelist, credentials; DEXPAY balance.
 */
const PROVIDER_ACCOUNT_CODES = new Set(["018", "021", "022", "023", "024", "027", "028", "087", "INSUFFICIENT_BALANCE"]);

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
