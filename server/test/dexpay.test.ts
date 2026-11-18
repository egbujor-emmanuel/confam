import { describe, expect, it } from "vitest";
import { DexpayApiError, DexpayClient, DexpayNetworkError, type DexpayBillPayment } from "../src/dexpay/client.ts";
import type { Order } from "../src/orders/types.ts";
import { confamTag, DexpayProvider, mapDexpayStatus } from "../src/providers/dexpay.ts";

const order = (over: Partial<Order> = {}): Order =>
  ({
    id: "o1",
    category: "electricity",
    provider: "dexpay",
    countryCode: "SN",
    currency: "XOF",
    billersCode: "04520123456789",
    amountLocal: 5000,
    requestId: "202611181400abcdef",
    providerRef: null,
    createdAt: Date.parse("2026-11-18T13:00:00Z"),
    vendStartedAt: Date.parse("2026-11-18T13:01:00Z"),
    ...over,
  }) as Order;

// Shapes captured from the DEXPAY sandbox on 2026-11-18.
const completed: DexpayBillPayment = {
  reference: "BILL-010d92e2-4ea6-499a-91b3-fc630ecf9226",
  status: "completed",
  token: "00000000000000000000",
  amount: 5000,
  totalDebited: 5050,
  providerTxId: null,
  failureReason: null,
  customData: confamTag({ requestId: "202611181400abcdef" }),
};

type Client = ConstructorParameters<typeof DexpayProvider>[0];
const client = (over: Partial<Client> = {}): Client => ({
  pay: async () => completed,
  get: async () => completed,
  listSince: async () => [],
  ...over,
});

describe("mapDexpayStatus (per DEXPAY's bill payment lifecycle)", () => {
  it("settles only on completed, releases on failed/refunded, waits otherwise", () => {
    expect(mapDexpayStatus("completed")).toBe("delivered");
    expect(mapDexpayStatus("failed")).toBe("failed");
    expect(mapDexpayStatus("refunded")).toBe("failed");
    expect(mapDexpayStatus("processing")).toBe("pending");
    expect(mapDexpayStatus("initiated")).toBe("pending");
    expect(mapDexpayStatus(null)).toBe("pending");
  });
});

describe("DexpayProvider.purchase", () => {
  it("pays once with our order reference as the Idempotency-Key and tags the payment", async () => {
    const calls: unknown[] = [];
    const p = new DexpayProvider(client({ pay: async (a) => (calls.push(a), completed) }));
    const r = await p.purchase(order());
    expect(calls).toEqual([
      { serviceCode: "WOYOFAL_SN_BILL", referenceClient: "04520123456789", amount: 5000, idempotencyKey: "202611181400abcdef", customData: '{"confam":"202611181400abcdef"}' },
    ]);
    expect(r).toMatchObject({ outcome: "delivered", token: "00000000000000000000", providerRef: completed.reference });
  });

  it("keeps the lock while the Woyofal token is processing", async () => {
    const p = new DexpayProvider(client({ pay: async () => ({ ...completed, status: "processing", token: null }) }));
    expect((await p.purchase(order())).outcome).toBe("pending");
  });

  it("releases on a rejection such as INSUFFICIENT_BALANCE (nothing was debited)", async () => {
    const p = new DexpayProvider(client({ pay: async () => Promise.reject(new DexpayApiError(400, "INSUFFICIENT_BALANCE", "Solde DEXPAY insuffisant.")) }));
    expect(await p.purchase(order())).toMatchObject({ outcome: "failed", code: "INSUFFICIENT_BALANCE" });
  });

  it("treats a 409 replay as the existing payment, never a new one", async () => {
    const p = new DexpayProvider(
      client({ pay: async () => Promise.reject(new DexpayApiError(409, "IDEMPOTENT_REPLAY", "déjà utilisée", { reference: completed.reference, status: "completed" })) }),
    );
    expect(await p.purchase(order())).toMatchObject({ outcome: "delivered", providerRef: completed.reference });
  });

  it("stays pending on network errors and 5xx (DEXPAY may have processed it)", async () => {
    for (const err of [new DexpayNetworkError("timeout"), new DexpayApiError(502, null, "bad gateway"), new DexpayApiError(200, null, "non-JSON")]) {
      const p = new DexpayProvider(client({ pay: async () => Promise.reject(err) }));
      expect((await p.purchase(order())).outcome).toBe("pending");
    }
  });

  it("refuses orders that are not Woyofal orders with a meter", async () => {
    const p = new DexpayProvider(client());
    expect((await p.purchase(order({ category: "airtime" }))).outcome).toBe("failed");
    expect((await p.purchase(order({ billersCode: null }))).outcome).toBe("failed");
  });
});

describe("DexpayProvider.check", () => {
  it("reads the payment by reference", async () => {
    const p = new DexpayProvider(client({ get: async () => ({ ...completed, status: "failed", failureReason: "meter blocked", token: null }) }));
    expect(await p.check(order({ providerRef: completed.reference }), 10)).toMatchObject({ outcome: "failed", reason: "meter blocked" });
  });

  it("recovers a payment whose reply was lost by finding our order tag", async () => {
    let since = "";
    const other = { ...completed, reference: "BILL-other", customData: '{"confam":"someone-else"}' };
    const p = new DexpayProvider(client({ listSince: async (_code, from) => ((since = from), [other, completed]) }));
    const r = await p.check(order(), 10);
    expect(r).toMatchObject({ outcome: "delivered", providerRef: completed.reference });
    expect(since).toBe("2026-11-18T12:59:00.000Z"); // 2 minutes before the purchase started
  });

  it("waits briefly, then releases if DEXPAY never received the payment", async () => {
    const p = new DexpayProvider(client());
    expect((await p.check(order(), 5)).outcome).toBe("pending");
    expect((await p.check(order(), 31)).outcome).toBe("failed");
  });

  it("stays pending when DEXPAY can't be reached", async () => {
    const p = new DexpayProvider(client({ listSince: async () => Promise.reject(new DexpayNetworkError("down")) }));
    expect((await p.check(order(), 300)).outcome).toBe("pending");
  });
});

describe("DexpayClient", () => {
  type Captured = { url: string; init: RequestInit };
  const fake = (status: number, body: unknown, captured: Captured[] = []) =>
    (async (url: URL | string, init?: RequestInit) => {
      captured.push({ url: String(url), init: init ?? {} });
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
    }) as typeof fetch;

  it("sends the secret key and Idempotency-Key, and parses the sandbox reply", async () => {
    const captured: Captured[] = [];
    const c = new DexpayClient("https://api-sandbox.dexpay.africa/api/v1", "sk_test_x", fake(201, {
      reference: "BILL-1", status: "completed", token: "00000000000000000000", amount: 5000, fee_amount: 50, total_debited: 5050, provider_tx_id: null, message: "Recharge effectuée.",
    }, captured));
    const p = await c.pay({ serviceCode: "WOYOFAL_SN_BILL", referenceClient: "0452", amount: 5000, idempotencyKey: "k1", customData: "{}" });
    expect(p).toMatchObject({ reference: "BILL-1", status: "completed", token: "00000000000000000000", totalDebited: 5050 });
    expect(captured[0]?.url).toBe("https://api-sandbox.dexpay.africa/api/v1/bill-payments/pay");
    const h = captured[0]?.init.headers as Record<string, string>;
    expect(h["x-api-secret"]).toBe("sk_test_x");
    expect(h["Idempotency-Key"]).toBe("k1");
    expect(JSON.parse(String(captured[0]?.init.body))).toEqual({ service_code: "WOYOFAL_SN_BILL", reference_client: "0452", amount: 5000, customData: "{}" });
    expect(c.isSandbox).toBe(true);
  });

  it("surfaces a 409 replay with the existing payment", async () => {
    const c = new DexpayClient("https://api-sandbox.dexpay.africa/api/v1", "sk_test_x", fake(409, {
      statusCode: 409, code: "IDEMPOTENT_REPLAY", message: "déjà utilisée", reference: "BILL-1", status: "completed",
    }));
    await expect(c.pay({ serviceCode: "W", referenceClient: "1", amount: 1, idempotencyKey: "k", customData: "{}" })).rejects.toMatchObject({
      httpStatus: 409, code: "IDEMPOTENT_REPLAY", existing: { reference: "BILL-1", status: "completed" },
    });
  });

  it("returns null for an unknown payment and reads meter info", async () => {
    const c404 = new DexpayClient("https://x/api/v1", "sk_test_x", fake(404, { code: "BILL_PAYMENT_NOT_FOUND" }));
    expect(await c404.get("BILL-0")).toBeNull();
    const cm = new DexpayClient("https://x/api/v1", "sk_test_x", fake(200, {
      reference_client: "0452", bills: [{ customer_name: "Marie Fall", address: "HLM Grand Yoff, Dakar", meter_status: "ACTIVE" }],
    }));
    expect(await cm.inquiry("WOYOFAL_SN_BILL", "0452")).toEqual({ referenceClient: "0452", customerName: "Marie Fall", address: "HLM Grand Yoff, Dakar", meterStatus: "ACTIVE" });
  });
});
