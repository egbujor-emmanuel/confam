import { AtApiError, type AtAirtimeStatus, type AtClient } from "../africastalking/client.ts";
import type { Order } from "../orders/types.ts";
import type { BillProvider, VendOutcome, VendResult } from "./types.ts";

/**
 * Africa's Talking airtime status -> engine outcome:
 *  Success -> delivered (settle)   Failed -> failed (release)
 *  Queued / Sent / anything else -> pending (keep the lock; the engine releases at the deadline)
 */
export function mapAtStatus(status: AtAirtimeStatus | null): VendOutcome {
  if (status === "Success") return "delivered";
  if (status === "Failed") return "failed";
  return "pending";
}

/** HTTP 4xx on the send call means AT rejected the request before sending anything. */
const REJECTED_BEFORE_PROCESSING = new Set([400, 401, 403, 404, 422]);

/**
 * Final statuses pushed by AT to our airtime status callback, keyed by AT requestId.
 * Used only when the status query endpoint cannot answer (e.g. unavailable), never to override it.
 */
export class AtStatusInbox {
  private readonly byRequestId = new Map<string, { status: AtAirtimeStatus; at: number }>();

  constructor(
    private readonly ttlMs = 24 * 3_600_000,
    private readonly now: () => number = Date.now,
  ) {}

  record(requestId: string, status: AtAirtimeStatus): void {
    this.prune();
    this.byRequestId.set(requestId, { status, at: this.now() });
  }

  get(requestId: string): AtAirtimeStatus | null {
    const hit = this.byRequestId.get(requestId);
    return hit && this.now() - hit.at < this.ttlMs ? hit.status : null;
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [k, v] of this.byRequestId) if (v.at < cutoff) this.byRequestId.delete(k);
  }
}

/** Pan-African airtime via Africa's Talking, priced in the recipient's local currency. */
export class AfricasTalkingProvider implements BillProvider {
  readonly id = "africastalking" as const;

  constructor(
    private readonly client: Pick<AtClient, "sendAirtime" | "airtimeStatus">,
    private readonly inbox: AtStatusInbox,
  ) {}

  async purchase(order: Order): Promise<VendResult> {
    if (order.category !== "airtime" || !order.phone) {
      return { outcome: "failed", code: null, status: null, reason: "order is not an airtime order with a phone number" };
    }
    try {
      const r = await this.client.sendAirtime({
        phoneE164: `+${order.phone}`,
        currency: order.currency,
        amount: order.amountLocal,
        idempotencyKey: order.requestId,
      });
      if (r.status === "Failed" || !r.requestId) {
        return { outcome: "failed", code: null, status: r.status, reason: `rejected: ${r.errorMessage ?? "airtime not sent"}` };
      }
      return { outcome: "pending", code: null, status: r.status, reason: "sent to the mobile network", providerRef: r.requestId, txId: r.requestId };
    } catch (err) {
      if (err instanceof AtApiError && REJECTED_BEFORE_PROCESSING.has(err.httpStatus)) {
        return { outcome: "failed", code: String(err.httpStatus), status: null, reason: `rejected: ${err.message}` };
      }
      // Network error, 5xx or an unreadable reply: AT may have sent it. Never retry; the lock stays until
      // a status arrives or the deadline releases the customer's sats.
      return { outcome: "pending", code: null, status: null, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  async check(order: Order): Promise<VendResult> {
    const ref = order.providerRef;
    if (!ref) return { outcome: "pending", code: null, status: null, reason: "no Africa's Talking reference yet" };
    let status: AtAirtimeStatus | null = null;
    let reason = "";
    try {
      status = await this.client.airtimeStatus(ref);
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err);
    }
    if (status === null || mapAtStatus(status) === "pending") status = this.inbox.get(ref) ?? status;
    const outcome = mapAtStatus(status);
    return {
      outcome,
      code: null,
      status,
      reason: outcome === "pending" ? `network status ${status ?? "unknown"}${reason ? ` (${reason})` : ""}` : (status ?? "").toLowerCase(),
      providerRef: ref,
      txId: ref,
    };
  }
}
