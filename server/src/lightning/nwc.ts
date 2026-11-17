import { NWCClient } from "@getalby/sdk/nwc";
import {
  LightningError,
  type CreateHoldInvoiceParams,
  type HoldInvoiceProvider,
  type HoldInvoiceStatus,
  type HoldState,
} from "./types.ts";

/**
 * Hold invoices over Nostr Wallet Connect (NIP-47 hold-invoice extension:
 * make_hold_invoice / settle_hold_invoice / cancel_hold_invoice / lookup_invoice,
 * plus the hold_invoice_accepted notification).
 *
 * Least privilege: in production the merchant connection should be created in the
 * wallet (e.g. Alby Hub) WITHOUT pay_invoice permission, so this server can lock,
 * settle and cancel incoming payments but can never spend the merchant's funds.
 */
export class NwcHoldInvoiceProvider implements HoldInvoiceProvider {
  readonly kind = "nwc" as const;
  private readonly client: NWCClient;

  constructor(nwcUrl: string) {
    this.client = new NWCClient({ nostrWalletConnectUrl: nwcUrl });
  }

  async createHoldInvoice(p: CreateHoldInvoiceParams): Promise<{ invoice: string }> {
    try {
      const res = await this.client.makeHoldInvoice({
        amount: p.amountSats * 1000,
        description: p.memo,
        payment_hash: p.paymentHashHex,
        expiry: p.expirySec,
      });
      if (!res.invoice) throw new LightningError("wallet returned no invoice", "UNKNOWN");
      return { invoice: res.invoice };
    } catch (err) {
      throw toLightningError(err);
    }
  }

  async getStatus(paymentHashHex: string): Promise<HoldInvoiceStatus> {
    try {
      const tx = await this.client.lookupInvoice({ payment_hash: paymentHashHex });
      return { state: mapNwcState(tx.state), amountMsat: Number(tx.amount ?? 0) };
    } catch (err) {
      throw toLightningError(err);
    }
  }

  async settle(preimageHex: string): Promise<void> {
    try {
      await this.client.settleHoldInvoice({ preimage: preimageHex });
    } catch (err) {
      throw toLightningError(err);
    }
  }

  async cancel(paymentHashHex: string): Promise<void> {
    try {
      await this.client.cancelHoldInvoice({ payment_hash: paymentHashHex });
    } catch (err) {
      throw toLightningError(err);
    }
  }

  async subscribeAccepted(onAccepted: (paymentHashHex: string) => void): Promise<() => void> {
    return this.client.subscribeNotifications(
      (n) => {
        const hash = (n.notification as { payment_hash?: string } | undefined)?.payment_hash;
        if (n.notification_type === "hold_invoice_accepted" && hash) onAccepted(hash);
      },
      ["hold_invoice_accepted"],
    );
  }

  close(): void {
    this.client.close();
  }
}

/** NWC transaction states observed live: pending | accepted | settled | failed. */
export function mapNwcState(state: string | undefined): HoldState {
  switch (state) {
    case "accepted":
      return "accepted";
    case "settled":
      return "settled";
    case "failed":
    case "canceled":
    case "cancelled":
    case "expired":
      return "canceled";
    default:
      return "open";
  }
}

function toLightningError(err: unknown): LightningError {
  if (err instanceof LightningError) return err;
  const code = (err as { code?: string } | undefined)?.code;
  const message = err instanceof Error ? err.message : "lightning wallet error";
  if (code === "NOT_FOUND") return new LightningError(message, "NOT_FOUND");
  if (code === "RESTRICTED" || code === "UNAUTHORIZED" || code === "QUOTA_EXCEEDED") {
    return new LightningError(message, "REJECTED");
  }
  if (/timeout|timed out|reply timeout|publish/i.test(message)) return new LightningError(message, "UNAVAILABLE");
  return new LightningError(message, "UNKNOWN");
}
