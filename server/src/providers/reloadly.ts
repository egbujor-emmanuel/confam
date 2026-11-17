import type { Order } from "../orders/types.ts";
import { ReloadlyApiError, ReloadlyNetworkError, type ReloadlyClient } from "../reloadly/client.ts";
import type { BillProvider, VendOutcome, VendResult } from "./types.ts";

/**
 * Reloadly top-up status -> engine outcome, per the Reloadly API reference:
 *  SUCCESSFUL: top-up made                                  -> delivered (settle)
 *  PROCESSING: still being verified with the operator       -> pending (keep the lock)
 *  REFUNDED:   operator did not process it; funds refunded  -> failed (release)
 *  FAILED:     operator-side failure; funds not debited     -> failed (release)
 * Anything else is treated as pending.
 */
export function mapReloadlyStatus(status: string | null): VendOutcome {
  switch ((status ?? "").toUpperCase()) {
    case "SUCCESSFUL":
      return "delivered";
    case "REFUNDED":
    case "FAILED":
      return "failed";
    default:
      return "pending";
  }
}

/** HTTP 4xx from the purchase call means Reloadly rejected it before doing anything (nothing charged). */
const REJECTED_BEFORE_PROCESSING = new Set([400, 401, 403, 404, 422]);

/** Grace before "no transaction with our reference exists" is trusted to mean "never received". */
const NOT_FOUND_GRACE_SEC = 30;

/** Pan-African airtime & data via Reloadly (local-currency amounts). */
export class ReloadlyProvider implements BillProvider {
  readonly id = "reloadly" as const;

  constructor(private readonly client: Pick<ReloadlyClient, "topupAsync" | "topupStatus" | "findByCustomIdentifier">) {}

  async purchase(order: Order): Promise<VendResult> {
    if (!order.operatorId || !order.countryCode || !order.phone) {
      return { outcome: "failed", code: null, status: null, reason: "order is missing operator, country or phone" };
    }
    try {
      const transactionId = await this.client.topupAsync({
        operatorId: Number(order.operatorId),
        amountLocal: order.amountLocal,
        countryIso: order.countryCode,
        phoneE164Digits: order.phone,
        customIdentifier: order.requestId,
      });
      // Async top-up: accepted for processing, outcome comes from the status endpoint.
      return { outcome: "pending", code: null, status: "SUBMITTED", reason: "submitted to operator", providerRef: transactionId };
    } catch (err) {
      if (err instanceof ReloadlyApiError && REJECTED_BEFORE_PROCESSING.has(err.httpStatus)) {
        return { outcome: "failed", code: err.errorCode, status: null, reason: `rejected: ${err.message}` };
      }
      // Network error / 5xx: we do not know if Reloadly received it. Never retry; look it up later.
      const reason = err instanceof ReloadlyNetworkError ? `no response: ${err.message}` : err instanceof Error ? err.message : String(err);
      return { outcome: "pending", code: null, status: null, reason };
    }
  }

  async check(order: Order, secondsSincePurchase: number): Promise<VendResult> {
    try {
      let ref = order.providerRef;
      if (!ref) {
        const found = await this.client.findByCustomIdentifier(order.requestId);
        if (!found) {
          return secondsSincePurchase >= NOT_FOUND_GRACE_SEC
            ? { outcome: "failed", code: null, status: null, reason: "operator never received the top-up" }
            : { outcome: "pending", code: null, status: null, reason: "top-up not visible yet" };
        }
        ref = found.transactionId;
      }
      const s = await this.client.topupStatus(ref);
      const outcome = mapReloadlyStatus(s.status);
      return {
        outcome,
        code: null,
        status: s.status,
        reason: outcome === "pending" ? `operator status ${s.status ?? "unknown"}` : (s.status ?? "").toLowerCase(),
        providerRef: ref,
        txId: s.operatorTransactionId ?? s.transactionId,
        token: s.pinCode,
      };
    } catch (err) {
      return { outcome: "pending", code: null, status: null, reason: err instanceof Error ? err.message : String(err) };
    }
  }
}
