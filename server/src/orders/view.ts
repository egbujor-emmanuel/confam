import type { Order, OrderEvent, OrderState } from "./types.ts";

export interface PublicOrder {
  id: string;
  state: OrderState;
  category: Order["category"];
  countryCode: string;
  currency: string;
  product: string;
  recipient: string;
  customerName: string | null;
  amountLocal: number;
  amountSats: number;
  ratePerBtc: number;
  invoice: string | null;
  invoiceExpiresAt: number;
  token: string | null;
  units: string | null;
  releaseReason: Order["releaseReason"];
  deliveredAfterRelease: boolean;
  receipt: unknown;
  timeline: { at: number; state: OrderState; note: string }[];
}

/** Safe, PII-minimised projection. Never exposes the preimage, request id, provider ref, or raw phone/meter number. */
export function toPublicOrder(order: Order, events: OrderEvent[]): PublicOrder {
  const showProduct = order.state === "completed" || order.reconState === "delivered_after_release";
  return {
    id: order.id,
    state: order.state,
    category: order.category,
    countryCode: order.countryCode,
    currency: order.currency,
    product: order.productLabel,
    recipient: order.recipientMasked,
    customerName: order.customerName,
    amountLocal: order.amountLocal,
    amountSats: order.amountSats,
    ratePerBtc: order.ratePerBtc,
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
