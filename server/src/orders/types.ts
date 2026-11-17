export type Category = "airtime" | "data" | "electricity";

/**
 * awaiting_payment -> locked -> vending -> delivered -> completed   (customer pays only here)
 *                       \          \
 *                        \          -> released  (delivery failed or unconfirmed: lock cancelled, sats return)
 *                         -> released            (e.g. amount mismatch)
 * awaiting_payment -> expired                    (never paid)
 */
export type OrderState = "awaiting_payment" | "locked" | "vending" | "delivered" | "completed" | "released" | "expired";

export const TERMINAL_STATES: ReadonlySet<OrderState> = new Set(["completed", "released", "expired"]);
export const ACTIVE_STATES: readonly OrderState[] = ["awaiting_payment", "locked", "vending", "delivered"];

export type ReleaseReason = "delivery_failed" | "delivery_unconfirmed" | "amount_mismatch" | "lock_lost";

export interface Order {
  id: string;
  createdAt: number;
  updatedAt: number;
  state: OrderState;
  category: Category;
  provider: "vtpass" | "reloadly";
  countryCode: string;
  currency: string;
  /** Provider service id (VTpass serviceID) or a label for Reloadly operators. */
  serviceId: string;
  /** Reloadly operator id (null for VTpass). */
  operatorId: string | null;
  variationCode: string | null;
  productLabel: string;
  /** Raw recipient identifiers: deleted (set null) once the order is terminal. */
  billersCode: string | null;
  phone: string | null;
  recipientMasked: string;
  meterType: "prepaid" | "postpaid" | null;
  customerName: string | null;
  /** Amount in the local currency (NGN, XOF, GHS, KES...). */
  amountLocal: number;
  amountSats: number;
  /** Local currency units per BTC at quote time. */
  ratePerBtc: number;
  rateSource: string;
  paymentHash: string;
  preimage: string;
  invoice: string;
  invoiceExpiresAt: number;
  requestId: string;
  lockedAt: number | null;
  vendStartedAt: number | null;
  lastRequeryAt: number | null;
  deliveredAt: number | null;
  completedAt: number | null;
  releasedAt: number | null;
  releaseReason: ReleaseReason | null;
  providerCode: string | null;
  providerStatus: string | null;
  /** Provider-side reference needed for status checks (Reloadly transactionId). */
  providerRef: string | null;
  providerTxId: string | null;
  token: string | null;
  units: string | null;
  failureDetail: string | null;
  receiptJson: string | null;
  /** For orders released while the provider outcome was still unknown: keep checking for reconciliation. */
  reconState: "watching" | "delivered_after_release" | "confirmed_not_delivered" | null;
}

export interface OrderEvent {
  orderId: string;
  at: number;
  from: OrderState | null;
  to: OrderState;
  note: string;
}

export type NewOrder = Omit<
  Order,
  | "createdAt"
  | "updatedAt"
  | "state"
  | "lockedAt"
  | "vendStartedAt"
  | "lastRequeryAt"
  | "deliveredAt"
  | "completedAt"
  | "releasedAt"
  | "releaseReason"
  | "providerCode"
  | "providerStatus"
  | "providerRef"
  | "providerTxId"
  | "token"
  | "units"
  | "failureDetail"
  | "receiptJson"
  | "reconState"
>;
