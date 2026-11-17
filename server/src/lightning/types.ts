/**
 * A hold invoice is a Lightning invoice whose payment is LOCKED, not completed,
 * until the receiver either settles it (reveals the preimage) or cancels it
 * (the payer's funds are released back to them). Confam only settles after the
 * bill provider confirms delivery.
 */
export type HoldState = "open" | "accepted" | "settled" | "canceled";

export interface HoldInvoiceStatus {
  state: HoldState;
  /** Amount locked/received in millisatoshis (0 while open). */
  amountMsat: number;
}

export interface CreateHoldInvoiceParams {
  amountSats: number;
  paymentHashHex: string;
  memo: string;
  expirySec: number;
}

export interface HoldInvoiceProvider {
  readonly kind: "nwc" | "lnd";
  createHoldInvoice(params: CreateHoldInvoiceParams): Promise<{ invoice: string }>;
  getStatus(paymentHashHex: string): Promise<HoldInvoiceStatus>;
  settle(preimageHex: string): Promise<void>;
  cancel(paymentHashHex: string): Promise<void>;
  /** Optional push notification when a payment gets locked. Polling remains the source of truth. */
  subscribeAccepted?(onAccepted: (paymentHashHex: string) => void): Promise<() => void>;
  close?(): void;
}

export class LightningError extends Error {
  constructor(
    message: string,
    readonly code: "NOT_FOUND" | "UNAVAILABLE" | "REJECTED" | "UNKNOWN",
  ) {
    super(message);
    this.name = "LightningError";
  }
}
