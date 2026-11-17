import { LightningError, type HoldInvoiceProvider } from "../lightning/types.ts";
import type { ReceiptSigner } from "../receipts/sign.ts";
import {
  classifyVtpass,
  extractToken,
  extractTransactionId,
  extractUnits,
  type Classification,
} from "../vtpass/classify.ts";
import { VtpassNetworkError, type PayParams, type VtpassClient } from "../vtpass/client.ts";
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
  vtpass: Pick<VtpassClient, "pay" | "requery"> | null;
  signer: ReceiptSigner;
  log: Logger;
  cfg: EngineConfig;
  now?: () => number;
}

/**
 * Drives every order through: lock -> buy -> (deliver -> settle) | (fail -> cancel).
 * Invariants:
 *  1. VTpass /pay is called at most once per order (guarded by the locked->vending CAS).
 *  2. /pay is never called unless the customer's sats are locked (hold invoice ACCEPTED).
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
    // Orders run in parallel so one slow provider call never delays another customer's lock/release.
    await Promise.allSettled([
      ...this.deps.store.listByStates(ACTIVE_STATES).map((o) => this.process(o.id)),
      ...this.deps.store.listWatchingRecon().map((o) => this.reconcile(o)),
    ]);
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
    if (!this.deps.vtpass) {
      return this.release(order, "delivery_failed", "bill provider not configured");
    }

    const startedAt = this.now();
    // lastRequeryAt = startedAt: the /pay call counts as the latest provider contact, so the first
    // requery waits a full interval (VTpass code 089 asks clients not to fire back-to-back requests).
    const claimed = this.deps.store.transition(
      order.id,
      "locked",
      "vending",
      { vendStartedAt: startedAt, lastRequeryAt: startedAt },
      "buying from provider",
      startedAt,
    );
    if (!claimed) return this.deps.store.get(order.id); // another worker owns the purchase

    let body: unknown = null;
    let cls: Classification;
    try {
      body = await this.deps.vtpass.pay(buildPayParams(claimed));
      cls = classifyVtpass(body, { secondsSincePay: 0 });
    } catch (err) {
      const reason = err instanceof VtpassNetworkError ? `no response: ${err.message}` : errMsg(err);
      cls = { outcome: "pending", code: null, status: null, reason };
    }
    this.deps.log.info({ orderId: order.id, outcome: cls.outcome, code: cls.code, status: cls.status }, "provider responded");
    return this.applyOutcome(claimed, cls, body);
  }

  private async onVending(order: Order): Promise<Order | null> {
    const nowMs = this.now();
    if (order.lastRequeryAt && nowMs - order.lastRequeryAt < this.cfg.requeryIntervalSec * 1000) {
      return this.checkDeadline(order);
    }
    if (!this.deps.vtpass) return this.release(order, "delivery_unconfirmed", "bill provider not configured");
    const secondsSincePay = Math.floor((nowMs - (order.vendStartedAt ?? nowMs)) / 1000);
    let body: unknown = null;
    let cls: Classification;
    try {
      body = await this.deps.vtpass.requery(order.requestId);
      cls = classifyVtpass(body, { secondsSincePay });
    } catch (err) {
      cls = { outcome: "pending", code: null, status: null, reason: errMsg(err) };
    }
    this.deps.store.patch(order.id, { lastRequeryAt: nowMs }, nowMs);
    return this.applyOutcome({ ...order, lastRequeryAt: nowMs }, cls, body);
  }

  private async applyOutcome(order: Order, cls: Classification, body: unknown): Promise<Order | null> {
    const nowMs = this.now();
    if (cls.outcome === "delivered") {
      return this.deps.store.transition(
        order.id,
        "vending",
        "delivered",
        {
          deliveredAt: nowMs,
          providerCode: cls.code,
          providerStatus: cls.status,
          providerTxId: extractTransactionId(body),
          token: extractToken(body),
          units: extractUnits(body),
        },
        "provider confirmed delivery",
        nowMs,
      );
    }
    if (cls.outcome === "failed") {
      this.deps.store.patch(order.id, { providerCode: cls.code, providerStatus: cls.status }, nowMs);
      return this.release(order, "delivery_failed", cls.reason);
    }
    this.deps.store.patch(order.id, { providerCode: cls.code, providerStatus: cls.status, failureDetail: cls.reason }, nowMs);
    return this.checkDeadline(order);
  }

  private async checkDeadline(order: Order): Promise<Order | null> {
    const started = order.vendStartedAt ?? order.lockedAt ?? order.createdAt;
    if (this.now() - started <= this.cfg.vendDeadlineSec * 1000) return order;
    return this.release(order, "delivery_unconfirmed", "provider could not confirm delivery in time");
  }

  private async onDelivered(order: Order): Promise<void> {
    const deliveredAtSec = Math.floor((order.deliveredAt ?? this.now()) / 1000);
    const receipt = order.receiptJson ?? JSON.stringify(this.deps.signer.sign(order, deliveredAtSec));
    try {
      await this.deps.ln.settle(order.preimage);
    } catch (err) {
      const status = await this.lnStatus(order);
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

  private async reconcile(order: Order): Promise<void> {
    if (!this.deps.vtpass || this.inflight.has(order.id)) return;
    const nowMs = this.now();
    if (order.lastRequeryAt && nowMs - order.lastRequeryAt < this.cfg.reconIntervalSec * 1000) return;
    if (nowMs - order.createdAt > this.cfg.reconMaxAgeSec * 1000) return;
    this.inflight.add(order.id);
    try {
      const body = await this.deps.vtpass.requery(order.requestId);
      const cls = classifyVtpass(body, { secondsSincePay: 3600 });
      const patch =
        cls.outcome === "delivered"
          ? { reconState: "delivered_after_release" as const, token: extractToken(body), units: extractUnits(body) }
          : cls.outcome === "failed"
            ? { reconState: "confirmed_not_delivered" as const }
            : {};
      this.deps.store.patch(order.id, { ...patch, lastRequeryAt: nowMs }, nowMs);
      if (cls.outcome === "delivered") this.deps.log.warn({ orderId: order.id }, "delivered after release (operator absorbs cost)");
    } catch (err) {
      this.deps.store.patch(order.id, { lastRequeryAt: nowMs }, nowMs);
      this.deps.log.warn({ orderId: order.id, err: errMsg(err) }, "reconciliation requery failed");
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

export function buildPayParams(order: Order): PayParams {
  const phone = order.phone ?? "";
  switch (order.category) {
    case "airtime":
      return { requestId: order.requestId, serviceID: order.serviceId, amount: order.amountNgn, phone };
    case "data":
      return {
        requestId: order.requestId,
        serviceID: order.serviceId,
        billersCode: order.billersCode ?? phone,
        variationCode: order.variationCode ?? "",
        amount: order.amountNgn,
        phone,
      };
    case "electricity":
      return {
        requestId: order.requestId,
        serviceID: order.serviceId,
        billersCode: order.billersCode ?? "",
        variationCode: order.meterType ?? "prepaid",
        amount: order.amountNgn,
        phone,
      };
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
