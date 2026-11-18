import { describe, expect, it } from "vitest";
import { AtApiError, AtClient, AtNetworkError } from "../src/africastalking/client.ts";
import { AT_AIRTIME, atAirtimeLimits } from "../src/africastalking/coverage.ts";
import { COUNTRIES } from "../src/countries.ts";
import type { Order } from "../src/orders/types.ts";
import { AfricasTalkingProvider, AtStatusInbox, mapAtStatus } from "../src/providers/africastalking.ts";

const order = (over: Partial<Order> = {}): Order =>
  ({
    id: "o1",
    category: "airtime",
    provider: "africastalking",
    countryCode: "SN",
    currency: "XOF",
    operatorId: null,
    phone: "221771234567",
    amountLocal: 1000,
    requestId: "202611181200abcdef",
    providerRef: null,
    ...over,
  }) as Order;

type Captured = { url: string; init: RequestInit };
function fakeFetch(status: number, body: unknown, captured: Captured[] = []): typeof fetch {
  return (async (url: URL | string, init?: RequestInit) => {
    captured.push({ url: String(url), init: init ?? {} });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
}

describe("mapAtStatus (per AT airtime status definitions)", () => {
  it("settles only on Success, releases on Failed, waits on anything else", () => {
    expect(mapAtStatus("Success")).toBe("delivered");
    expect(mapAtStatus("Failed")).toBe("failed");
    expect(mapAtStatus("Sent")).toBe("pending");
    expect(mapAtStatus("Queued")).toBe("pending");
    expect(mapAtStatus(null)).toBe("pending");
  });
});

describe("AtClient", () => {
  it("uses the sandbox host for username 'sandbox' and sends the SDK's form-encoded body with an idempotency key", async () => {
    const captured: Captured[] = [];
    const c = new AtClient(
      { username: "sandbox", apiKey: "k" },
      fakeFetch(201, { responses: [{ status: "Sent", requestId: "ATQid_1", errorMessage: "None" }], errorMessage: "None" }, captured),
    );
    const r = await c.sendAirtime({ phoneE164: "+221771234567", currency: "XOF", amount: 1000, idempotencyKey: "ref-1" });
    expect(r).toEqual({ status: "Sent", requestId: "ATQid_1", errorMessage: null });
    const call = captured[0];
    expect(call?.url).toBe("https://api.sandbox.africastalking.com/version1/airtime/send");
    const headers = call?.init.headers as Record<string, string>;
    expect(headers.apiKey).toBe("k");
    expect(headers["Idempotency-Key"]).toBe("ref-1");
    expect(headers["content-type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(String(call?.init.body));
    expect(form.get("username")).toBe("sandbox");
    expect(JSON.parse(form.get("recipients") ?? "[]")).toEqual([{ phoneNumber: "+221771234567", amount: "XOF 1000" }]);
  });

  it("uses the live host for a real username", async () => {
    const captured: Captured[] = [];
    const c = new AtClient({ username: "confam", apiKey: "k" }, fakeFetch(200, { status: "Success" }, captured));
    expect(c.isSandbox).toBe(false);
    expect(await c.airtimeStatus("ATQid_1")).toBe("Success");
    expect(captured[0]?.url).toBe("https://api.africastalking.com/query/transaction/find?username=confam&transactionId=ATQid_1");
  });

  it("reads status from data.status as the SDK typings describe", async () => {
    const c = new AtClient({ username: "sandbox", apiKey: "k" }, fakeFetch(200, { data: { status: "Failed" } }));
    expect(await c.airtimeStatus("ATQid_1")).toBe("Failed");
  });

  it("reports a whole-request rejection (no responses) as Failed", async () => {
    const c = new AtClient({ username: "sandbox", apiKey: "k" }, fakeFetch(201, { errorMessage: "Insufficient balance", responses: [] }));
    const r = await c.sendAirtime({ phoneE164: "+221771234567", currency: "XOF", amount: 1000, idempotencyKey: "x" });
    expect(r).toEqual({ status: "Failed", requestId: null, errorMessage: "Insufficient balance" });
  });

  it("raises AtApiError on HTTP errors and AtNetworkError when unreachable", async () => {
    const bad = new AtClient({ username: "sandbox", apiKey: "k" }, fakeFetch(401, "The supplied authentication is invalid"));
    await expect(bad.airtimeStatus("x")).rejects.toBeInstanceOf(AtApiError);
    const down = new AtClient({ username: "sandbox", apiKey: "k" }, (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch);
    await expect(down.airtimeStatus("x")).rejects.toBeInstanceOf(AtNetworkError);
  });
});

describe("AfricasTalkingProvider", () => {
  const status = (s: string | null) => async () => s;

  it("sends once in local currency and keeps the lock with AT's requestId", async () => {
    const calls: unknown[] = [];
    const p = new AfricasTalkingProvider(
      { sendAirtime: async (a) => (calls.push(a), { status: "Sent", requestId: "ATQid_9", errorMessage: null }), airtimeStatus: status(null) },
      new AtStatusInbox(),
    );
    const r = await p.purchase(order());
    expect(calls).toEqual([{ phoneE164: "+221771234567", currency: "XOF", amount: 1000, idempotencyKey: "202611181200abcdef" }]);
    expect(r.outcome).toBe("pending");
    expect(r.providerRef).toBe("ATQid_9");
  });

  it("releases when AT rejects the send (nothing was charged)", async () => {
    const p = new AfricasTalkingProvider(
      { sendAirtime: async () => ({ status: "Failed", requestId: null, errorMessage: "Invalid phone number" }), airtimeStatus: status(null) },
      new AtStatusInbox(),
    );
    expect((await p.purchase(order())).outcome).toBe("failed");
  });

  it("releases on a 4xx rejection but stays pending on network errors and 5xx (never retries a maybe-sent top-up)", async () => {
    const mk = (err: Error) =>
      new AfricasTalkingProvider({ sendAirtime: async () => Promise.reject(err), airtimeStatus: status(null) }, new AtStatusInbox());
    expect((await mk(new AtApiError(401, "bad key")).purchase(order())).outcome).toBe("failed");
    expect((await mk(new AtApiError(502, "bad gateway")).purchase(order())).outcome).toBe("pending");
    expect((await mk(new AtNetworkError("timeout")).purchase(order())).outcome).toBe("pending");
  });

  it("refuses non-airtime orders", async () => {
    const p = new AfricasTalkingProvider({ sendAirtime: async () => ({ status: "Sent", requestId: "x", errorMessage: null }), airtimeStatus: status(null) }, new AtStatusInbox());
    expect((await p.purchase(order({ category: "data" }))).outcome).toBe("failed");
  });

  it("settles on Success and releases on Failed from the status query", async () => {
    const ok = new AfricasTalkingProvider({ sendAirtime: async () => ({ status: "Sent", requestId: "x", errorMessage: null }), airtimeStatus: status("Success") }, new AtStatusInbox());
    expect((await ok.check(order({ providerRef: "ATQid_1" }))).outcome).toBe("delivered");
    const no = new AfricasTalkingProvider({ sendAirtime: async () => ({ status: "Sent", requestId: "x", errorMessage: null }), airtimeStatus: status("Failed") }, new AtStatusInbox());
    expect((await no.check(order({ providerRef: "ATQid_1" }))).outcome).toBe("failed");
  });

  it("stays pending without a reference", async () => {
    const p = new AfricasTalkingProvider({ sendAirtime: async () => ({ status: "Sent", requestId: "x", errorMessage: null }), airtimeStatus: status("Success") }, new AtStatusInbox());
    expect((await p.check(order())).outcome).toBe("pending");
  });

  it("uses a callback-reported final status when the query is still Sent or unavailable", async () => {
    const inbox = new AtStatusInbox();
    inbox.record("ATQid_1", "Success");
    const sent = new AfricasTalkingProvider({ sendAirtime: async () => ({ status: "Sent", requestId: "x", errorMessage: null }), airtimeStatus: status("Sent") }, inbox);
    expect((await sent.check(order({ providerRef: "ATQid_1" }))).outcome).toBe("delivered");
    const down = new AfricasTalkingProvider(
      { sendAirtime: async () => ({ status: "Sent", requestId: "x", errorMessage: null }), airtimeStatus: async () => Promise.reject(new AtNetworkError("down")) },
      inbox,
    );
    expect((await down.check(order({ providerRef: "ATQid_1" }))).outcome).toBe("delivered");
  });

  it("never lets a callback override a final status from the query", async () => {
    const inbox = new AtStatusInbox();
    inbox.record("ATQid_1", "Success");
    const p = new AfricasTalkingProvider({ sendAirtime: async () => ({ status: "Sent", requestId: "x", errorMessage: null }), airtimeStatus: status("Failed") }, inbox);
    expect((await p.check(order({ providerRef: "ATQid_1" }))).outcome).toBe("failed");
  });
});

describe("AtStatusInbox", () => {
  it("expires entries after the TTL", () => {
    let t = 0;
    const inbox = new AtStatusInbox(1000, () => t);
    inbox.record("a", "Success");
    expect(inbox.get("a")).toBe("Success");
    t = 1001;
    expect(inbox.get("a")).toBeNull();
  });
});

describe("AT coverage table", () => {
  it("every covered country is a Confam country with the same currency and sane limits", () => {
    for (const [iso, l] of Object.entries(AT_AIRTIME)) {
      const c = COUNTRIES.find((x) => x.iso === iso);
      expect(c, iso).toBeDefined();
      expect(l.currency, iso).toBe(c?.currency);
      expect(l.min, iso).toBeLessThan(l.max);
      for (const s of l.suggested) expect(s >= l.min && s <= l.max, `${iso} ${s}`).toBe(true);
    }
    expect(atAirtimeLimits("sn")?.currency).toBe("XOF");
    expect(atAirtimeLimits("ML")).toBeNull();
  });
});
