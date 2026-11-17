import { createHash } from "node:crypto";
import { nip19 } from "nostr-tools";
import { finalizeEvent, getPublicKey, verifyEvent, type NostrEvent } from "nostr-tools/pure";
import type { Order } from "../orders/types.ts";

/** NIP-78 "arbitrary custom app data" kind: a signed, verifiable, unpublished receipt. */
export const RECEIPT_KIND = 30078;

export interface ReceiptContent {
  v: 1;
  app: "confam";
  order: string;
  product: string;
  recipient: string;
  amount_ngn: number;
  amount_sats: number;
  payment_hash: string;
  provider_ref: string | null;
  token_sha256: string | null;
  delivered_at: number;
}

export class ReceiptSigner {
  private readonly secret: Uint8Array;
  readonly pubkeyHex: string;
  readonly npub: string;

  constructor(secretKeyHex: string) {
    this.secret = Uint8Array.from(Buffer.from(secretKeyHex, "hex"));
    this.pubkeyHex = getPublicKey(this.secret);
    this.npub = nip19.npubEncode(this.pubkeyHex);
  }

  /** Receipts carry only masked recipient data and a hash of the token: safe to share as proof. */
  sign(order: Order, deliveredAtSec: number): NostrEvent {
    const content: ReceiptContent = {
      v: 1,
      app: "confam",
      order: order.id,
      product: order.productLabel,
      recipient: order.recipientMasked,
      amount_ngn: order.amountNgn,
      amount_sats: order.amountSats,
      payment_hash: order.paymentHash,
      provider_ref: order.providerTxId,
      token_sha256: order.token ? createHash("sha256").update(order.token.replace(/\s/g, "")).digest("hex") : null,
      delivered_at: deliveredAtSec,
    };
    return finalizeEvent(
      {
        kind: RECEIPT_KIND,
        created_at: deliveredAtSec,
        tags: [
          ["d", `confam:${order.id}`],
          ["t", "confam-receipt"],
          ["x", order.paymentHash],
        ],
        content: JSON.stringify(content),
      },
      this.secret,
    );
  }
}

export function verifyReceipt(event: NostrEvent, expectedPubkeyHex: string): boolean {
  return event.pubkey === expectedPubkeyHex && event.kind === RECEIPT_KIND && verifyEvent(event);
}
