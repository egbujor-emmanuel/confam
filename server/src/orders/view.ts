import type { Order, OrderEvent, OrderState } from "./types.ts";

export interface PublicOrder {
  id: string;
  state: OrderState;
  headline: string;
  detail: string;
  category: Order["category"];
  product: string;
  recipient: string;
  customerName: string | null;
  amountNgn: number;
  amountSats: number;
  rateNgnPerBtc: number;
  invoice: string | null;
  invoiceExpiresAt: number;
  token: string | null;
  units: string | null;
  releaseReason: Order["releaseReason"];
  deliveredAfterRelease: boolean;
  receipt: unknown;
  timeline: { at: number; state: OrderState; note: string }[];
}

const COPY: Record<OrderState, { headline: string; detail: string }> = {
  awaiting_payment: { headline: "Waiting for your payment", detail: "Pay the invoice. Your sats get locked, not sent." },
  locked: { headline: "Payment locked, not sent", detail: "Your sats are held safely while we buy it for you." },
  vending: { headline: "Buying it for you…", detail: "Waiting for the provider to confirm delivery." },
  delivered: { headline: "Delivered!", detail: "Completing your payment now that delivery is confirmed." },
  completed: { headline: "Done: delivered, then paid", detail: "Your payment completed only after delivery was confirmed." },
  released: {
    headline: "It didn't go through. You were not charged.",
    detail: "We released the lock on your payment, so your sats never left your wallet.",
  },
  expired: { headline: "Invoice expired", detail: "Nothing was paid and nothing was charged." },
};

/** Safe, PII-minimised projection. Never exposes the preimage, request id, or raw phone/meter number. */
export function toPublicOrder(order: Order, events: OrderEvent[]): PublicOrder {
  const showProduct = order.state === "completed" || order.reconState === "delivered_after_release";
  const copy = COPY[order.state];
  return {
    id: order.id,
    state: order.state,
    headline: order.reconState === "delivered_after_release" ? "Delivered after all, and it's free" : copy.headline,
    detail:
      order.reconState === "delivered_after_release"
        ? "The provider confirmed late, after we had already released your payment. Enjoy it on us."
        : copy.detail,
    category: order.category,
    product: order.productLabel,
    recipient: order.recipientMasked,
    customerName: order.customerName,
    amountNgn: order.amountNgn,
    amountSats: order.amountSats,
    rateNgnPerBtc: order.rateNgnPerBtc,
    invoice: order.state === "awaiting_payment" ? order.invoice : null,
    invoiceExpiresAt: order.invoiceExpiresAt,
    token: showProduct ? order.token : null,
    units: showProduct ? order.units : null,
    releaseReason: order.releaseReason,
    deliveredAfterRelease: order.reconState === "delivered_after_release",
    receipt: order.state === "completed" && order.receiptJson ? (JSON.parse(order.receiptJson) as unknown) : null,
    timeline: events.map((e) => ({ at: e.at, state: e.to, note: e.note })),
  };
}
