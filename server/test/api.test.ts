import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { OrderService } from "../src/orders/service.ts";
import { OrderStore } from "../src/orders/store.ts";
import { ReceiptSigner } from "../src/receipts/sign.ts";
import { Catalog } from "../src/vtpass/catalog.ts";
import { IntlCatalog } from "../src/vtpass/intl.ts";
import { FakeLn } from "./fakes.ts";

const cfg = loadConfig({
  NODE_ENV: "test",
  MERCHANT_NWC_URL: "nostr+walletconnect://abc?relay=wss://r.example&secret=00",
  NOSTR_SECRET_KEY_HEX: "11".repeat(32),
  VTPASS_API_KEY: "k",
  VTPASS_PUBLIC_KEY: "PK_x",
  VTPASS_SECRET_KEY: "SK_x",
  TEST_WALLET_FAUCET: "false",
});

const vtpassCatalog = {
  services: async (identifier: string) =>
    identifier === "airtime"
      ? [
          { serviceID: "mtn", name: "MTN Airtime VTU", minimium_amount: "50", maximum_amount: "50000" },
          { serviceID: "foreign-airtime", name: "Foreign", minimium_amount: "1", maximum_amount: "1" },
        ]
      : identifier === "electricity-bill"
        ? [{ serviceID: "ikeja-electric", name: "Ikeja Electric Payment - IKEDC", minimium_amount: "500", maximum_amount: "1000000" }]
        : [{ serviceID: "mtn-data", name: "MTN Data", minimium_amount: "1", maximum_amount: "1000000" }],
  variations: async () => [{ variation_code: "mtn-10mb-100", name: "N100 100MB - 24 hrs", variation_amount: "100.00" }],
};

/**
 * VTpass international catalogue, shaped exactly like the live responses captured 2026-11-18 from
 * https://vtpass.com/api/get-international-airtime-operators and /api/service-variations
 * (Senegal Orange: flexible 100-73,811 XOF at 2.7096 NGN/XOF; Ghana MTN: fixed bundles).
 */
const INTL_RESPONSES: Record<string, unknown> = {
  "/api/get-international-airtime-countries": { response_description: "000", content: { countries: [{ code: "SN" }, { code: "GH" }] } },
  "/api/get-international-airtime-operators?code=SN&product_type_id=1": {
    response_description: "000",
    content: [{ operator_id: "216", name: "Senegal Orange", operator_image: "https://vtpass.com/resources/images/operators/88.png" }],
  },
  "/api/get-international-airtime-operators?code=SN&product_type_id=4": { response_description: "000", content: [] },
  "/api/service-variations?serviceID=foreign-airtime&operator_id=216&product_type_id=1": {
    response_description: "000",
    content: {
      currency: "XOF",
      variations: [
        { variation_code: "5028", name: "Enter flexible amount", fixedPrice: "No", variation_amount: null, variation_amount_min: 100, variation_amount_max: 73811, variation_rate: 2.7096, charged_amount: null, charged_currency: "NGN" },
      ],
    },
  },
  "/api/get-international-airtime-operators?code=GH&product_type_id=4": { response_description: "000", content: [{ operator_id: "5", name: "Ghana MTN" }] },
  "/api/service-variations?serviceID=foreign-airtime&operator_id=5&product_type_id=4": {
    response_description: "000",
    content: {
      currency: "GHS",
      variations: [
        { variation_code: "18263", name: "2.50GHS IDD Bundle (30.4Mins)", fixedPrice: "Yes", variation_amount: "2.50", variation_rate: 131.112, charged_amount: "327.78", charged_currency: "NGN" },
        { variation_code: "9001", name: "1GB Mobile Data", fixedPrice: "Yes", variation_amount: "10.00", variation_rate: 131.1, charged_amount: "1311.00", charged_currency: "NGN" },
      ],
    },
  },
};
const intlFetch = (async (url: URL | string) => {
  const u = new URL(String(url));
  const body = INTL_RESPONSES[u.pathname + u.search];
  return new Response(JSON.stringify(body ?? { response_description: "011" }), { status: 200 });
}) as typeof fetch;

const rates = { current: async (currency: string) => ({ currency, perBtc: currency === "XOF" ? 60_000_000 : 150_000_000, source: "test", fetchedAt: Date.now() }) };
// 50,000 XOF at 60M XOF/BTC = 83,334 sats, which is above this cap (exercised by the cap test).
const limits = { minNgn: 50, maxNgn: 50000, maxSats: 80000, feeBps: 0, invoiceExpirySec: 600 };

let app: FastifyInstance;
let store: OrderStore;
let ln: FakeLn;
let kicked: string[];

function deps(webDistDir = "/nonexistent") {
  const catalog = new Catalog(vtpassCatalog);
  const intl = new IntlCatalog("https://vtpass.com", intlFetch);
  const orders = new OrderService({
    store,
    ln,
    vtpass: {
      verifyMerchant: async ({ billersCode }) =>
        billersCode === "1111111111111"
          ? { code: "000", content: { Customer_Name: "TESTMETER ONE", Address: "ABULE EGBA", Can_Vend: "yes", WrongBillersCode: false } }
          : { code: "000", content: { error: "meter not found", WrongBillersCode: true } },
    },
    vtpassCatalog: catalog,
    intl,
    intlCountries: new Set(["SN", "GH"]),
    intlDataCountries: new Set(["GH"]),
    rates,
    vtpassSandbox: true,
    limits,
  });
  return {
    app: { cfg, store, orders, kick: (id: string) => kicked.push(id), catalog, intl, rates, signer: new ReceiptSigner(cfg.NOSTR_SECRET_KEY_HEX), ln },
    opts: { webDistDir },
  };
}

beforeEach(async () => {
  store = new OrderStore(":memory:");
  ln = new FakeLn();
  kicked = [];
  const d = deps();
  app = await buildApp(d.app, d.opts);
});

afterEach(async () => {
  await app.close();
  store.close();
});

describe("API: config & catalogue", () => {
  it("exposes config without secrets", async () => {
    const res = await app.inject({ method: "GET", url: "/api/config" });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("SK_x");
    expect(res.body).not.toContain("secret=");
    expect(res.json()).toMatchObject({ providers: { vtpass: { configured: true, sandbox: true } } });
  });

  it("lists African countries with the provider serving each service", async () => {
    const res = await app.inject({ method: "GET", url: "/api/countries" });
    const byIso = Object.fromEntries(res.json().countries.map((c: { iso: string }) => [c.iso, c]));
    expect(byIso.NG.services).toEqual({ airtime: "vtpass", data: "vtpass", electricity: "vtpass" });
    expect(byIso.SN.services).toEqual({ airtime: "vtpass", data: null, electricity: null }); // no data bundles in this fixture
    expect(byIso.GH.services).toEqual({ airtime: "vtpass", data: "vtpass", electricity: null });
    expect(byIso.ML).toBeUndefined(); // not in VTpass's international list in this fixture
    expect(byIso.SN).toMatchObject({ currency: "XOF", dial: "221" });
  });

  it("filters the VTpass catalogue to supported Nigerian networks", async () => {
    const res = await app.inject({ method: "GET", url: "/api/catalog/airtime" });
    expect(res.json().services.map((s: { serviceID: string }) => s.serviceID)).toEqual(["mtn"]);
  });

  it("lists a country's networks and products from VTpass without exposing the naira cost", async () => {
    const ops = await app.inject({ method: "GET", url: "/api/intl/operators?country=SN&category=airtime" });
    expect(ops.json().operators).toEqual([{ operatorId: "216", name: "Senegal Orange", logo: "https://vtpass.com/resources/images/operators/88.png" }]);
    const offers = await app.inject({ method: "GET", url: "/api/intl/offers?operator=216&category=airtime" });
    expect(offers.json().offers).toEqual([{ variationCode: "5028", name: "Enter flexible amount", currency: "XOF", isFixed: false, amountLocal: null, minLocal: 100, maxLocal: 73811 }]);
    expect(offers.body).not.toContain("2.7096");
    const data = await app.inject({ method: "GET", url: "/api/intl/offers?operator=5&category=data" });
    expect(data.json().offers.map((o: { variationCode: string }) => o.variationCode)).toEqual(["9001"]); // IDD voice bundle filtered out
    expect((await app.inject({ method: "GET", url: "/api/intl/operators?country=ML&category=airtime" })).statusCode).toBe(503);
    expect((await app.inject({ method: "GET", url: "/api/intl/operators?country=NG&category=airtime" })).statusCode).toBe(503);
  });

  it("quotes in any supported currency", async () => {
    const res = await app.inject({ method: "GET", url: "/api/quote?amount=600&currency=XOF" });
    expect(res.json()).toMatchObject({ currency: "XOF", amountSats: 1000 });
    expect((await app.inject({ method: "GET", url: "/api/quote?amount=600&currency=EUR" })).statusCode).toBe(400);
  });
});

describe("API: orders", () => {
  it("creates a Nigerian airtime order via VTpass and never leaks secrets or the raw phone", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/orders",
      payload: { category: "airtime", countryCode: "NG", serviceID: "mtn", phone: "0801 111 1111", amountLocal: 1500 },
    });
    expect(res.statusCode).toBe(201);
    const o = res.json();
    expect(o).toMatchObject({ state: "awaiting_payment", amountLocal: 1500, currency: "NGN", amountSats: 1000, recipient: "0801****111" });
    expect(kicked).toEqual([o.id]);
    const stored = store.get(o.id)!;
    expect(stored.provider).toBe("vtpass");
    expect(res.body).not.toContain(stored.preimage);
    expect(res.body).not.toContain(stored.requestId);
    expect(res.body).not.toContain("08011111111");
  });

  it("creates a Senegal airtime order priced from VTpass's naira cost, so the sats always cover it", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/orders",
      payload: { category: "airtime", countryCode: "SN", phone: "77 123 45 67", amountLocal: 1000, operatorId: "216", variationCode: "5028" },
    });
    expect(res.statusCode).toBe(201);
    const o = res.json();
    // 1000 XOF x 2.7096 = 2,709.60 NGN; at 150M NGN/BTC = 1,806.4 -> 1,807 sats.
    expect(o).toMatchObject({ currency: "XOF", countryCode: "SN", amountLocal: 1000, amountSats: 1807, product: "1,000 XOF Senegal Orange airtime" });
    expect(o.ratePerBtc).toBeCloseTo((1000 * 1e8) / 1807, 3);
    expect(store.get(o.id)).toMatchObject({ provider: "vtpass", serviceId: "foreign-airtime", operatorId: "216", variationCode: "5028", phone: "221771234567" });
    expect(res.body).not.toContain("221771234567");
  });

  it("enforces VTpass's local range and fixed bundle prices, and rejects unknown products", async () => {
    const base = { countryCode: "SN", phone: "771234567", operatorId: "216", variationCode: "5028" };
    const tooSmall = await app.inject({ method: "POST", url: "/api/orders", payload: { ...base, category: "airtime", amountLocal: 50 } });
    expect(tooSmall.json().error.code).toBe("bad_amount");
    const bundle = await app.inject({
      method: "POST",
      url: "/api/orders",
      payload: { category: "data", countryCode: "GH", phone: "024 123 4567", operatorId: "5", variationCode: "9001", amountLocal: 1 },
    });
    expect(bundle.statusCode).toBe(201);
    // Fixed price: the client amount is ignored; 1,311 NGN at 150M NGN/BTC -> 874 sats.
    expect(bundle.json()).toMatchObject({ product: "Ghana MTN: 1GB Mobile Data", amountLocal: 10, currency: "GHS", amountSats: 874 });
    const fake = await app.inject({ method: "POST", url: "/api/orders", payload: { ...base, category: "airtime", amountLocal: 1000, variationCode: "9999" } });
    expect(fake.json().error.code).toBe("unknown_plan");
    const wrongOp = await app.inject({ method: "POST", url: "/api/orders", payload: { ...base, category: "airtime", amountLocal: 1000, operatorId: "5" } });
    expect(wrongOp.json().error.code).toBe("unknown_operator");
  });

  it("accepts VTpass's sandbox success number for international orders in sandbox mode", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/orders",
      payload: { category: "airtime", countryCode: "SN", phone: "08011111111", amountLocal: 1000, operatorId: "216", variationCode: "5028" },
    });
    expect(res.statusCode).toBe(201);
    expect(store.get(res.json().id)?.phone).toBe("08011111111");
  });

  it("caps any order by naira cost regardless of currency", async () => {
    // 73,811 XOF x 2.7096 = 200,000 NGN > MAX_ORDER_NGN (50,000).
    const res = await app.inject({
      method: "POST",
      url: "/api/orders",
      payload: { category: "airtime", countryCode: "SN", phone: "771234567", amountLocal: 73811, operatorId: "216", variationCode: "5028" },
    });
    expect(res.json().error.code).toBe("bad_amount");
  });

  it("prices Nigerian data plans from the provider catalogue, ignoring any client amount", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/orders",
      payload: { category: "data", countryCode: "NG", serviceID: "mtn-data", phone: "08011111111", variationCode: "mtn-10mb-100", amountLocal: 1 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().amountLocal).toBe(100);
  });

  it("verifies the meter before an electricity order and masks the customer name", async () => {
    const payload = { category: "electricity", countryCode: "NG", serviceID: "ikeja-electric", meterType: "prepaid", phone: "08011111111", amountLocal: 2000 };
    const ok = await app.inject({ method: "POST", url: "/api/orders", payload: { ...payload, meterNumber: "1111111111111" } });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ customerName: "TESTMETER O.", recipient: "meter 1111******111" });
    const bad = await app.inject({ method: "POST", url: "/api/orders", payload: { ...payload, meterNumber: "1234567890123" } });
    expect(bad.json().error.code).toBe("meter_not_found");
    const notNg = await app.inject({ method: "POST", url: "/api/orders", payload: { ...payload, countryCode: "SN", meterNumber: "1111111111111" } });
    expect(notNg.json().error.code).toBe("provider_unconfigured");
  });

  it("rejects bad input with clear errors and never kicks the engine", async () => {
    const cases = [
      { payload: { category: "airtime", countryCode: "NG", serviceID: "mtn", phone: "123", amountLocal: 100 }, code: "invalid_input" },
      { payload: { category: "airtime", countryCode: "NG", serviceID: "mtn", phone: "08031234567", amountLocal: 10 }, code: "bad_amount" },
      { payload: { category: "airtime", countryCode: "NG", serviceID: "foreign-airtime", phone: "08031234567", amountLocal: 100 }, code: "unknown_service" },
      { payload: { category: "airtime", countryCode: "NG", serviceID: "mtn", phone: "06031234567", amountLocal: 100 }, code: "bad_phone" },
      { payload: { category: "airtime", countryCode: "XX", phone: "08031234567", amountLocal: 100 }, code: "unknown_country" },
      { payload: { category: "crypto", countryCode: "NG" }, code: "invalid_input" },
    ];
    for (const c of cases) {
      const res = await app.inject({ method: "POST", url: "/api/orders", payload: c.payload });
      expect(res.statusCode, JSON.stringify(c.payload)).toBeGreaterThanOrEqual(400);
      expect(res.json().error.code, JSON.stringify(c.payload)).toBe(c.code);
    }
    expect(kicked).toHaveLength(0);
  });

  it("returns 404 for unknown orders and 400 for malformed ids", async () => {
    expect((await app.inject({ method: "GET", url: "/api/orders/AAAAAAAAAAAAAAAAAAAAAA" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/orders/not-a-valid-id!" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/orders/../../etc/passwd" })).statusCode).toBe(404);
  });
});

describe("API: static app & headers", () => {
  it("serves index.html as no-cache, hashed assets as immutable, and never HTML for a missing asset", async () => {
    const dist = mkdtempSync(join(tmpdir(), "confam-dist-"));
    mkdirSync(join(dist, "assets"));
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>t</title>");
    writeFileSync(join(dist, "assets", "index-abc123.js"), "console.log(1)");
    const d = deps(dist);
    const web = await buildApp(d.app, d.opts);
    expect((await web.inject({ url: "/" })).headers["cache-control"]).toBe("no-cache");
    expect((await web.inject({ url: "/some/deep/link" })).headers["cache-control"]).toBe("no-cache");
    expect((await web.inject({ url: "/assets/index-abc123.js" })).headers["cache-control"]).toContain("immutable");
    writeFileSync(join(dist, "assets", "index-new999.js"), "console.log(2)");
    const added = await web.inject({ url: "/assets/index-new999.js" });
    expect(added.statusCode).toBe(200);
    expect(added.headers["content-type"]).toContain("javascript");
    const missing = await web.inject({ url: "/assets/index-gone.js" });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers["content-type"]).not.toContain("text/html");
    // Public files: cached a day; a missing one (long extension too) is a 404, never the SPA shell.
    writeFileSync(join(dist, "og.jpg"), "jpg");
    expect((await web.inject({ url: "/og.jpg" })).headers["cache-control"]).toBe("public, max-age=86400");
    const noManifest = await web.inject({ url: "/manifest.webmanifest" });
    expect(noManifest.statusCode).toBe(404);
    expect(noManifest.headers["cache-control"]).toBe("no-cache");
    await web.close();
  });

  it("sets security headers", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });
});
