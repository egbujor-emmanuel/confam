import type { Order } from "../orders/types.ts";

export type ProviderId = "vtpass" | "reloadly";
export type VendOutcome = "delivered" | "failed" | "pending";

/** What a bill provider said about a purchase, normalised for the order engine. */
export interface VendResult {
  outcome: VendOutcome;
  code: string | null;
  status: string | null;
  reason: string;
  /** Provider-side transaction reference needed for later status checks (e.g. Reloadly transactionId). */
  providerRef?: string | null;
  /** Provider transaction id shown on the receipt. */
  txId?: string | null;
  /** Prepaid electricity token, when the product has one. */
  token?: string | null;
  units?: string | null;
}

/**
 * A bill provider that can buy airtime/data/electricity.
 * Contract relied on by the engine:
 *  - purchase() is called AT MOST ONCE per order (the engine guarantees this).
 *  - check() may be called many times and must never buy anything.
 *  - Anything not clearly delivered or clearly failed must come back as "pending".
 */
export interface BillProvider {
  readonly id: ProviderId;
  purchase(order: Order): Promise<VendResult>;
  check(order: Order, secondsSincePurchase: number): Promise<VendResult>;
}

export type ProviderRegistry = Partial<Record<ProviderId, BillProvider>>;
