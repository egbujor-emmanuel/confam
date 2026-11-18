import { DexpayApiError, WOYOFAL, type DexpayBillPayment, type DexpayBillStatus, type DexpayClient } from "../dexpay/client.ts";
import type { Order } from "../orders/types.ts";
import type { BillProvider, VendOutcome, VendResult } from "./types.ts";

/**
 * DEXPAY bill status -> engine outcome (https://docs.dexpay.africa/en/guides/bill-payments):
 *  completed            -> delivered (bill settled / Woyofal token issued) -> settle
 *  failed, refunded     -> failed (rejected, or debited and refunded)       -> release
 *  initiated, processing, anything else -> pending (keep the lock; the deadline releases it)
 */
export function mapDexpayStatus(status: DexpayBillStatus | null): VendOutcome {
  if (status === "completed") return "delivered";
  if (status === "failed" || status === "refunded") return "failed";
  return "pending";
}

/** 408 timeout, 409 replay, 425 too early, 429 rate limited: DEXPAY may still process it. */
const RETRYABLE_4XX = new Set([408, 409, 425, 429]);

/** Other 4xx replies mean DEXPAY refused the request: nothing was debited. */
function isRejection(err: unknown): err is DexpayApiError {
  return err instanceof DexpayApiError && err.httpStatus >= 400 && err.httpStatus < 500 && !RETRYABLE_4XX.has(err.httpStatus);
}

/** Recovery looks through at most this many pages of recent payments (50 per page). */
const MAX_RECOVERY_PAGES = 10;
const RECOVERY_PAGE_SIZE = 50;

/** Ties a DEXPAY payment to a Confam order, so a payment whose reply was lost can be found again. */
export const confamTag = (order: Pick<Order, "requestId">): string => JSON.stringify({ confam: order.requestId });

/** Senegal: Woyofal prepaid electricity (Senelec) via DEXPAY, paid in XOF from the DEXPAY balance. */
export class DexpayProvider implements BillProvider {
  readonly id = "dexpay" as const;

  constructor(private readonly client: Pick<DexpayClient, "pay" | "get" | "listSince">) {}

  async purchase(order: Order): Promise<VendResult> {
    if (order.category !== "electricity" || !order.billersCode) {
      return { outcome: "failed", code: null, status: null, reason: "order is not a Woyofal order with a meter number" };
    }
    try {
      const p = await this.client.pay({
        serviceCode: WOYOFAL,
        referenceClient: order.billersCode,
        amount: order.amountLocal,
        idempotencyKey: order.requestId,
        customData: confamTag(order),
      });
      return toResult(p);
    } catch (err) {
      if (err instanceof DexpayApiError && err.existing) {
        // Same Idempotency-Key already used: the original payment is returned, no new one was made.
        return { outcome: mapDexpayStatus(err.existing.status), code: "409", status: err.existing.status, reason: "existing payment", providerRef: err.existing.reference };
      }
      if (isRejection(err)) return { outcome: "failed", code: err.code, status: null, reason: `rejected: ${err.message}` };
      // Network error, 5xx or unreadable reply: DEXPAY may have processed it. Never retry blindly;
      // check() finds it by our order tag, or the deadline releases the customer's sats.
      return { outcome: "pending", code: null, status: null, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  async check(order: Order, secondsSincePurchase: number): Promise<VendResult> {
    try {
      let payment: DexpayBillPayment | null = null;
      if (order.providerRef) payment = await this.client.get(order.providerRef);
      if (!payment) payment = await this.findByTag(order);
      // "Not found" is not proof DEXPAY never received it (a lagging list can show it later): keep the
      // lock; the vend deadline releases it and reconciliation keeps looking.
      if (!payment) return { outcome: "pending", code: null, status: null, reason: `payment not visible at DEXPAY yet (${secondsSincePurchase}s)` };
      return toResult(payment);
    } catch (err) {
      return { outcome: "pending", code: null, status: null, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Finds the payment carrying our order tag among recent Woyofal payments, newest first. */
  private async findByTag(order: Order): Promise<DexpayBillPayment | null> {
    const since = new Date((order.vendStartedAt ?? order.createdAt) - 120_000).toISOString();
    const tag = confamTag(order);
    for (let page = 1; page <= MAX_RECOVERY_PAGES; page++) {
      const items = await this.client.listSince(WOYOFAL, since, page);
      const hit = items.find((p) => p.customData === tag);
      if (hit) return hit;
      if (items.length < RECOVERY_PAGE_SIZE) return null;
    }
    return null;
  }
}

function toResult(p: DexpayBillPayment): VendResult {
  const outcome = mapDexpayStatus(p.status);
  return {
    outcome,
    code: null,
    status: p.status,
    reason: outcome === "failed" ? (p.failureReason ?? p.status) : outcome === "pending" ? `DEXPAY status ${p.status || "unknown"}` : "token issued",
    providerRef: p.reference || null,
    txId: p.providerTxId ?? p.reference ?? null,
    token: p.token,
  };
}
