import { hexToBase64 } from "./crypto.ts";
import {
  LightningError,
  type CreateHoldInvoiceParams,
  type HoldInvoiceProvider,
  type HoldInvoiceStatus,
  type HoldState,
} from "./types.ts";

type FetchLike = typeof fetch;

/**
 * Hold invoices over LND's REST API (invoicesrpc). Uses an *invoice macaroon*
 * (invoices read/write only), so a leaked credential cannot send funds.
 * Endpoints per https://lightning.engineering/api-docs/api/lnd/invoices/
 */
export class LndHoldInvoiceProvider implements HoldInvoiceProvider {
  readonly kind = "lnd" as const;

  constructor(
    private readonly baseUrl: string,
    private readonly macaroonHex: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = 15_000,
  ) {}

  async createHoldInvoice(p: CreateHoldInvoiceParams): Promise<{ invoice: string }> {
    const body = await this.request<{ payment_request?: string }>("POST", "/v2/invoices/hodl", {
      hash: hexToBase64(p.paymentHashHex),
      value: String(p.amountSats),
      memo: p.memo,
      expiry: String(p.expirySec),
    });
    if (!body.payment_request) throw new LightningError("LND returned no payment_request", "UNKNOWN");
    return { invoice: body.payment_request };
  }

  async getStatus(paymentHashHex: string): Promise<HoldInvoiceStatus> {
    // v1 lookup takes the hash as hex in the path, avoiding base64-in-query encoding issues.
    const body = await this.request<{ state?: string; amt_paid_msat?: string }>(
      "GET",
      `/v1/invoice/${paymentHashHex}`,
    );
    return { state: mapLndState(body.state), amountMsat: Number(body.amt_paid_msat ?? 0) };
  }

  async settle(preimageHex: string): Promise<void> {
    await this.request("POST", "/v2/invoices/settle", { preimage: hexToBase64(preimageHex) });
  }

  async cancel(paymentHashHex: string): Promise<void> {
    await this.request("POST", "/v2/invoices/cancel", { payment_hash: hexToBase64(paymentHashHex) });
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(new URL(path, this.baseUrl), {
        method,
        headers: { "Grpc-Metadata-macaroon": this.macaroonHex, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new LightningError(err instanceof Error ? err.message : "LND unreachable", "UNAVAILABLE");
    }
    const text = await res.text();
    if (!res.ok) {
      const lower = text.toLowerCase();
      if (res.status === 404 || lower.includes("unable to locate invoice") || lower.includes("not found")) {
        throw new LightningError("invoice not found", "NOT_FOUND");
      }
      throw new LightningError(`LND ${res.status}: ${text.slice(0, 200)}`, res.status >= 500 ? "UNAVAILABLE" : "REJECTED");
    }
    return (text ? JSON.parse(text) : {}) as T;
  }
}

/**
 * LND InvoiceState: OPEN | SETTLED | CANCELED | ACCEPTED | PENDING_SETTLE.
 * PENDING_SETTLE means the preimage was released and HTLCs are finalising: the payer has paid.
 */
export function mapLndState(state: string | undefined): HoldState {
  switch (state) {
    case "ACCEPTED":
      return "accepted";
    case "SETTLED":
    case "PENDING_SETTLE":
      return "settled";
    case "CANCELED":
      return "canceled";
    default:
      return "open";
  }
}
