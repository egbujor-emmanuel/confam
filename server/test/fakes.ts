import { LightningError, type CreateHoldInvoiceParams, type HoldInvoiceProvider, type HoldInvoiceStatus, type HoldState } from "../src/lightning/types.ts";
import { hashOfPreimage, newPreimagePair } from "../src/lightning/crypto.ts";
import type { Logger } from "../src/orders/engine.ts";
import type { OrderStore } from "../src/orders/store.ts";
import type { NewOrder, Order } from "../src/orders/types.ts";
import type { PayParams } from "../src/vtpass/client.ts";

interface FakeInvoice {
  state: HoldState;
  amountMsat: number;
  sats: number;
}

/** In-memory hold-invoice wallet with the same semantics observed on live NWC wallets. */
export class FakeLn implements HoldInvoiceProvider {
  readonly kind = "nwc" as const;
  readonly invoices = new Map<string, FakeInvoice>();
  cancelCalls = 0;
  settleCalls = 0;
  failCancelTimes = 0;
  failSettleTimes = 0;
  statusUnavailable = false;

  async createHoldInvoice(p: CreateHoldInvoiceParams): Promise<{ invoice: string }> {
    this.invoices.set(p.paymentHashHex, { state: "open", amountMsat: 0, sats: p.amountSats });
    return { invoice: `lntbs${p.amountSats}fake${p.paymentHashHex.slice(0, 8)}` };
  }

  /** Simulates the payer paying: funds become locked (ACCEPTED). */
  payerPays(hash: string, amountMsat?: number): void {
    const inv = this.must(hash);
    inv.state = "accepted";
    inv.amountMsat = amountMsat ?? inv.sats * 1000;
  }

  async getStatus(hash: string): Promise<HoldInvoiceStatus> {
    if (this.statusUnavailable) throw new LightningError("relay timeout", "UNAVAILABLE");
    const inv = this.must(hash);
    return { state: inv.state, amountMsat: inv.amountMsat };
  }

  async settle(preimageHex: string): Promise<void> {
    this.settleCalls++;
    if (this.failSettleTimes > 0) {
      this.failSettleTimes--;
      throw new LightningError("relay timeout", "UNAVAILABLE");
    }
    const inv = this.must(hashOfPreimage(preimageHex));
    if (inv.state === "canceled") throw new LightningError("invoice canceled", "REJECTED");
    inv.state = "settled";
  }

  async cancel(hash: string): Promise<void> {
    this.cancelCalls++;
    if (this.failCancelTimes > 0) {
      this.failCancelTimes--;
      throw new LightningError("relay timeout", "UNAVAILABLE");
    }
    const inv = this.must(hash);
    if (inv.state === "settled") throw new LightningError("The transaction requested was not found", "NOT_FOUND");
    inv.state = "canceled";
    inv.amountMsat = 0; // payer's funds released
  }

  private must(hash: string): FakeInvoice {
    const inv = this.invoices.get(hash);
    if (!inv) throw new LightningError("not found", "NOT_FOUND");
    return inv;
  }
}

/** Scripted VTpass: each call shifts the next response (or throws if it is an Error). */
export class FakeVtpass {
  payCalls: PayParams[] = [];
  requeryCalls: string[] = [];
  constructor(
    public payResponses: unknown[] = [],
    public requeryResponses: unknown[] = [],
  ) {}

  async pay(p: PayParams): Promise<unknown> {
    this.payCalls.push(p);
    const next = this.payResponses.shift();
    if (next instanceof Error) throw next;
    return next ?? null;
  }

  async requery(requestId: string): Promise<unknown> {
    this.requeryCalls.push(requestId);
    const next = this.requeryResponses.shift();
    if (next instanceof Error) throw next;
    return next ?? null;
  }
}

export const silentLog: Logger = { info: () => {}, warn: () => {}, error: () => {} };

export const DELIVERED = { code: "000", content: { transactions: { status: "delivered", transactionId: "TX123" } } };
export const DELIVERED_TOKEN = {
  code: "000",
  content: { transactions: { status: "delivered", transactionId: "TX9" } },
  purchased_code: "Token : 26362054405982757802",
  units: "79.9 kWh",
};
export const FAILED = { code: "016", response_description: "TRANSACTION FAILED" };
export const PROCESSING = { code: "099" };

let seq = 0;
export async function seedOrder(
  store: OrderStore,
  ln: FakeLn,
  now: number,
  overrides: Partial<NewOrder> = {},
): Promise<Order> {
  const { preimageHex, paymentHashHex } = newPreimagePair();
  const sats = overrides.amountSats ?? 1334;
  const { invoice } = await ln.createHoldInvoice({ amountSats: sats, paymentHashHex, memo: "t", expirySec: 600 });
  seq++;
  return store.insert(
    {
      id: `order${String(seq).padStart(17, "0")}`,
      category: "airtime",
      provider: "vtpass",
      countryCode: "NG",
      currency: "NGN",
      serviceId: "mtn",
      operatorId: null,
      variationCode: null,
      productLabel: "₦2,000 MTN Airtime VTU",
      billersCode: null,
      phone: "08011111111",
      recipientMasked: "0801****111",
      meterType: null,
      customerName: null,
      amountLocal: 2000,
      amountSats: sats,
      ratePerBtc: 150_000_000,
      rateSource: "test",
      paymentHash: paymentHashHex,
      preimage: preimageHex,
      invoice,
      invoiceExpiresAt: now + 600_000,
      requestId: `20261117120${String(seq).padStart(4, "0")}abc`,
      ...overrides,
    },
    now,
  );
}
