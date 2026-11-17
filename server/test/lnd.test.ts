import { describe, expect, it } from "vitest";
import { LndHoldInvoiceProvider, mapLndState } from "../src/lightning/lnd.ts";
import { LightningError } from "../src/lightning/types.ts";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(responses: { status?: number; body: unknown }[]) {
  const calls: Call[] = [];
  const impl = (async (input: URL | string, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: init?.headers as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const r = responses.shift() ?? { body: {} };
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { calls, impl };
}

const HASH = "ab".repeat(32);
const PRE = "cd".repeat(32);

describe("LndHoldInvoiceProvider (REST wire format)", () => {
  it("creates a hold invoice with a base64 hash and the macaroon header", async () => {
    const f = fakeFetch([{ body: { payment_request: "lntbs1..." } }]);
    const lnd = new LndHoldInvoiceProvider("https://node.example:8080", "0201abcd", f.impl);
    const res = await lnd.createHoldInvoice({ amountSats: 1500, paymentHashHex: HASH, memo: "m", expirySec: 600 });
    expect(res.invoice).toBe("lntbs1...");
    expect(f.calls[0]).toMatchObject({ url: "https://node.example:8080/v2/invoices/hodl", method: "POST" });
    expect(f.calls[0]?.headers["Grpc-Metadata-macaroon"]).toBe("0201abcd");
    expect(f.calls[0]?.body).toEqual({ hash: Buffer.from(HASH, "hex").toString("base64"), value: "1500", memo: "m", expiry: "600" });
  });

  it("looks up by hex hash and maps state + amount", async () => {
    const f = fakeFetch([{ body: { state: "ACCEPTED", amt_paid_msat: "1500000" } }]);
    const lnd = new LndHoldInvoiceProvider("https://node.example:8080", "00", f.impl);
    expect(await lnd.getStatus(HASH)).toEqual({ state: "accepted", amountMsat: 1_500_000 });
    expect(f.calls[0]?.url).toBe(`https://node.example:8080/v1/invoice/${HASH}`);
  });

  it("settles with a base64 preimage and cancels with a base64 payment hash", async () => {
    const f = fakeFetch([{ body: {} }, { body: {} }]);
    const lnd = new LndHoldInvoiceProvider("https://node.example:8080", "00", f.impl);
    await lnd.settle(PRE);
    await lnd.cancel(HASH);
    expect(f.calls[0]).toMatchObject({ url: "https://node.example:8080/v2/invoices/settle", body: { preimage: Buffer.from(PRE, "hex").toString("base64") } });
    expect(f.calls[1]).toMatchObject({ url: "https://node.example:8080/v2/invoices/cancel", body: { payment_hash: Buffer.from(HASH, "hex").toString("base64") } });
  });

  it("maps errors to typed LightningErrors", async () => {
    const f = fakeFetch([
      { status: 404, body: { message: "unable to locate invoice" } },
      { status: 500, body: "boom" },
    ]);
    const lnd = new LndHoldInvoiceProvider("https://node.example:8080", "00", f.impl);
    await expect(lnd.getStatus(HASH)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(lnd.cancel(HASH)).rejects.toBeInstanceOf(LightningError);
  });

  it("maps every LND invoice state", () => {
    expect(mapLndState("OPEN")).toBe("open");
    expect(mapLndState("ACCEPTED")).toBe("accepted");
    expect(mapLndState("SETTLED")).toBe("settled");
    expect(mapLndState("PENDING_SETTLE")).toBe("settled");
    expect(mapLndState("CANCELED")).toBe("canceled");
    expect(mapLndState(undefined)).toBe("open");
  });
});
