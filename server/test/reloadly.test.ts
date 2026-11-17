import { describe, expect, it } from "vitest";
import { findCountry, toInternational } from "../src/countries.ts";
import { ReloadlyProvider, mapReloadlyStatus } from "../src/providers/reloadly.ts";
import { toOperatorInfo } from "../src/reloadly/catalog.ts";
import { ReloadlyApiError, ReloadlyClient, ReloadlyNetworkError } from "../src/reloadly/client.ts";
import type { Order } from "../src/orders/types.ts";

const order = (over: Partial<Order> = {}): Order =>
  ({
    id: "o1",
    provider: "reloadly",
    countryCode: "SN",
    currency: "XOF",
    operatorId: "1234",
    phone: "221771234567",
    amountLocal: 1000,
    requestId: "202611172100abcdef",
    providerRef: null,
    ...over,
  }) as Order;

describe("mapReloadlyStatus (per Reloadly status definitions)", () => {
  it("maps SUCCESSFUL/PROCESSING/REFUNDED/FAILED", () => {
    expect(mapReloadlyStatus("SUCCESSFUL")).toBe("delivered");
    expect(mapReloadlyStatus("PROCESSING")).toBe("pending");
    expect(mapReloadlyStatus("REFUNDED")).toBe("failed");
    expect(mapReloadlyStatus("FAILED")).toBe("failed");
    expect(mapReloadlyStatus(null)).toBe("pending");
    expect(mapReloadlyStatus("SOMETHING_NEW")).toBe("pending");
  });
});

describe("ReloadlyProvider", () => {
  it("submits once with local amount + our request id as customIdentifier, then reports pending with the ref", async () => {
    const calls: unknown[] = [];
    const p = new ReloadlyProvider({
      topupAsync: async (args) => (calls.push(args), "987654"),
      topupStatus: async () => ({ status: null, transactionId: null, operatorTransactionId: null, deliveredAmount: null, deliveredAmountCurrencyCode: null, pinCode: null }),
      findByCustomIdentifier: async () => null,
    });
    const r = await p.purchase(order());
    expect(r).toMatchObject({ outcome: "pending", providerRef: "987654" });
    expect(calls[0]).toEqual({ operatorId: 1234, amountLocal: 1000, countryIso: "SN", phoneE164Digits: "221771234567", customIdentifier: "202611172100abcdef" });
  });

  it("treats a 4xx rejection as failed (nothing charged) and a network error as pending (never retried)", async () => {
    const rejecting = new ReloadlyProvider({
      topupAsync: async () => Promise.reject(new ReloadlyApiError(400, "INVALID_AMOUNT", "bad amount")),
      topupStatus: async () => Promise.reject(new Error("unused")),
      findByCustomIdentifier: async () => null,
    });
    expect((await rejecting.purchase(order())).outcome).toBe("failed");
    const flaky = new ReloadlyProvider({
      topupAsync: async () => Promise.reject(new ReloadlyNetworkError("socket hang up")),
      topupStatus: async () => Promise.reject(new Error("unused")),
      findByCustomIdentifier: async () => null,
    });
    expect((await flaky.purchase(order())).outcome).toBe("pending");
  });

  it("checks status by ref and maps it, carrying the operator transaction id", async () => {
    const p = new ReloadlyProvider({
      topupAsync: async () => "1",
      topupStatus: async (ref) => ({ status: "SUCCESSFUL", transactionId: ref, operatorTransactionId: "OP-9", deliveredAmount: 1000, deliveredAmountCurrencyCode: "XOF", pinCode: null }),
      findByCustomIdentifier: async () => null,
    });
    expect(await p.check(order({ providerRef: "55" }), 5)).toMatchObject({ outcome: "delivered", txId: "OP-9", providerRef: "55" });
  });

  it("recovers a lost transactionId via customIdentifier, and only fails 'not found' after a grace period", async () => {
    let found: { transactionId: string; status: string | null } | null = null;
    const p = new ReloadlyProvider({
      topupAsync: async () => "1",
      topupStatus: async () => ({ status: "PROCESSING", transactionId: "77", operatorTransactionId: null, deliveredAmount: null, deliveredAmountCurrencyCode: null, pinCode: null }),
      findByCustomIdentifier: async () => found,
    });
    expect((await p.check(order(), 5)).outcome).toBe("pending");
    expect((await p.check(order(), 40)).outcome).toBe("failed");
    found = { transactionId: "77", status: "PROCESSING" };
    expect(await p.check(order(), 40)).toMatchObject({ outcome: "pending", providerRef: "77" });
  });
});

describe("ReloadlyClient wire format", () => {
  it("authenticates with client credentials (audience = base URL), caches the token, and sends Reloadly headers", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fakeFetch = (async (url: URL | string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("oauth/token")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
      if (String(url).includes("/topups-async")) return new Response(JSON.stringify({ transactionId: 4602843 }), { status: 200 });
      return new Response(JSON.stringify({ status: "SUCCESSFUL", transaction: { transactionId: 4602843, operatorTransactionId: "X" } }), { status: 200 });
    }) as typeof fetch;
    const c = new ReloadlyClient({ clientId: "id", clientSecret: "sec", baseUrl: "https://topups-sandbox.reloadly.com" }, fakeFetch);
    const id = await c.topupAsync({ operatorId: 341, amountLocal: 500, countryIso: "SN", phoneE164Digits: "221771234567", customIdentifier: "ref-1" });
    expect(id).toBe("4602843");
    const status = await c.topupStatus(id);
    expect(status.status).toBe("SUCCESSFUL");

    const auth = calls.filter((x) => x.url.includes("oauth/token"));
    expect(auth).toHaveLength(1);
    expect(JSON.parse(String(auth[0]?.init?.body))).toMatchObject({ grant_type: "client_credentials", audience: "https://topups-sandbox.reloadly.com" });
    const topup = calls.find((x) => x.url.endsWith("/topups-async"));
    const headers = topup?.init?.headers as Record<string, string>;
    expect(headers.accept).toBe("application/com.reloadly.topups-v1+json");
    expect(headers.authorization).toBe("Bearer tok");
    expect(JSON.parse(String(topup?.init?.body))).toEqual({
      operatorId: "341",
      amount: "500",
      useLocalAmount: true,
      customIdentifier: "ref-1",
      recipientPhone: { countryCode: "SN", number: "221771234567" },
    });
  });
});

describe("operators & countries", () => {
  it("only offers local-currency operators, as ranges or fixed amounts", () => {
    expect(toOperatorInfo({ operatorId: 1, name: "X", supportsLocalAmounts: false, destinationCurrencyCode: "XOF" })).toBeNull();
    expect(
      toOperatorInfo({ operatorId: 2, name: "Orange Senegal", supportsLocalAmounts: true, destinationCurrencyCode: "XOF", denominationType: "RANGE", localMinAmount: 100, localMaxAmount: 50000 }),
    ).toMatchObject({ operatorId: "2", currency: "XOF", minAmount: 100, maxAmount: 50000, fixedAmounts: [] });
    expect(
      toOperatorInfo({ operatorId: 3, name: "Free Data", supportsLocalAmounts: true, destinationCurrencyCode: "XOF", denominationType: "FIXED", localFixedAmounts: [1000, 500], data: true }),
    ).toMatchObject({ fixedAmounts: [500, 1000], isData: true });
  });

  it("normalises phone numbers to international digits per country", () => {
    const sn = findCountry("sn")!;
    expect(toInternational("77 123 45 67", sn)).toBe("221771234567");
    expect(toInternational("+221 77 123 45 67", sn)).toBe("221771234567");
    expect(toInternational("00221771234567", sn)).toBe("221771234567");
    const ng = findCountry("NG")!;
    expect(toInternational("0803 123 4567", ng)).toBe("2348031234567");
    expect(toInternational("123", ng)).toBeNull();
    expect(findCountry("XX")).toBeNull();
  });
});
