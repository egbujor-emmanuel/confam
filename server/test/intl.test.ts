import { describe, expect, it } from "vitest";
import type { Order } from "../src/orders/types.ts";
import { buildVtpassPayParams, INTL_SERVICE_ID } from "../src/providers/vtpass.ts";
import { costNgn, IntlCatalog, toOffer } from "../src/vtpass/intl.ts";

// Live VTpass variation rows captured 2026-11-18 (Senegal Orange flexible; Ghana MTN fixed).
const flexible = { variation_code: "5028", name: "Enter flexible amount", fixedPrice: "No", variation_amount: null, variation_amount_min: 100, variation_amount_max: 73811, variation_rate: 2.7096, charged_amount: null, charged_currency: "NGN" };
const fixed = { variation_code: "18263", name: "2.50GHS IDD Bundle (30.4Mins)", fixedPrice: "Yes", variation_amount: "2.50", variation_amount_min: "2.50", variation_amount_max: "2.50", variation_rate: 131.112, charged_amount: "327.78", charged_currency: "NGN" };

describe("toOffer", () => {
  it("normalises a flexible top-up with its naira rate", () => {
    expect(toOffer("216", "XOF", flexible)).toEqual({
      operatorId: "216", variationCode: "5028", name: "Enter flexible amount", currency: "XOF", isFixed: false,
      amountLocal: null, minLocal: 100, maxLocal: 73811, ngnPerUnit: 2.7096, chargedNgn: null,
    });
  });

  it("normalises a fixed bundle with VTpass's charged naira amount", () => {
    expect(toOffer("5", "GHS", fixed)).toMatchObject({ isFixed: true, amountLocal: 2.5, chargedNgn: 327.78 });
  });

  it("drops anything that cannot be priced exactly in naira", () => {
    expect(toOffer("5", null, fixed)).toBeNull(); // no currency
    expect(toOffer("5", "GHS", { ...fixed, charged_currency: "USD" })).toBeNull();
    expect(toOffer("5", "GHS", { ...flexible, variation_rate: null })).toBeNull();
    expect(toOffer("5", "GHS", { ...fixed, variation_amount: "0.00", charged_amount: null })).toBeNull(); // sandbox placeholder rows
  });
});

describe("costNgn", () => {
  const flex = toOffer("216", "XOF", flexible)!;
  const bundle = toOffer("5", "GHS", fixed)!;

  it("prices flexible top-ups at rate x amount, rounded up to the kobo", () => {
    expect(costNgn(flex, 1000)).toBe(2709.6);
    expect(costNgn(flex, 333)).toBe(902.30); // 902.2968 -> 902.30
  });

  it("enforces the range and the fixed price", () => {
    expect(() => costNgn(flex, 99)).toThrow(/100 to 73811 XOF/);
    expect(() => costNgn(flex, 73812)).toThrow();
    expect(costNgn(bundle, 2.5)).toBe(327.78);
    expect(() => costNgn(bundle, 3)).toThrow(/fixed price/);
  });
});

describe("IntlCatalog", () => {
  it("rejects a catalogue error response instead of caching it", async () => {
    let calls = 0;
    const cat = new IntlCatalog("https://vtpass.com", (async () => {
      calls++;
      return new Response(JSON.stringify({ response_description: "011" }), { status: 200 });
    }) as typeof fetch);
    await expect(cat.countryCodes()).rejects.toMatchObject({ code: "catalog_unavailable" });
    await expect(cat.countryCodes()).rejects.toMatchObject({ code: "catalog_unavailable" });
    expect(calls).toBe(2);
  });

  it("caches successful responses", async () => {
    let calls = 0;
    const cat = new IntlCatalog("https://vtpass.com", (async () => {
      calls++;
      return new Response(JSON.stringify({ response_description: "000", content: { countries: [{ code: "SN" }, { code: "bad" }] } }), { status: 200 });
    }) as typeof fetch);
    expect([...(await cat.countryCodes())]).toEqual(["SN"]);
    await cat.countryCodes();
    expect(calls).toBe(1);
  });
});

describe("buildVtpassPayParams for international orders", () => {
  it("sends the fields the VTpass International Airtime API requires", () => {
    const order = {
      category: "data", serviceId: INTL_SERVICE_ID, requestId: "202611181300abc", phone: "233241234567", amountLocal: 10,
      operatorId: "5", variationCode: "9001", countryCode: "GH",
    } as Order;
    expect(buildVtpassPayParams(order, "orders@example.com")).toEqual({
      requestId: "202611181300abc",
      serviceID: "foreign-airtime",
      billersCode: "233241234567",
      variationCode: "9001",
      amount: 10,
      phone: "233241234567",
      extra: { operator_id: "5", country_code: "GH", product_type_id: "4", email: "orders@example.com" },
    });
  });
});
