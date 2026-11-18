import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { OrderService } from "../src/orders/service.ts";
import { OrderStore } from "../src/orders/store.ts";
import { AtStatusInbox } from "../src/providers/africastalking.ts";
import { ReceiptSigner } from "../src/receipts/sign.ts";
import { ReloadlyCatalog } from "../src/reloadly/catalog.ts";
import type { ReloadlyOperator } from "../src/reloadly/client.ts";
import { Catalog } from "../src/vtpass/catalog.ts";
import { FakeLn } from "./fakes.ts";

const cfg = loadConfig({
  NODE_ENV: "test",
  MERCHANT_NWC_URL: "nostr+walletconnect://abc?relay=wss://r.example&secret=00",
  NOSTR_SECRET_KEY_HEX: "11".repeat(32),
  VTPASS_API_KEY: "k",
  VTPASS_PUBLIC_KEY: "PK_x",
  VTPASS_SECRET_KEY: "SK_x",
  RELOADLY_CLIENT_ID: "rid",
  RELOADLY_CLIENT_SECRET: "rsecret",
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

const orangeSn: ReloadlyOperator = {
  operatorId: 341,
  name: "Orange Senegal",
  supportsLocalAmounts: true,
  destinationCurrencyCode: "XOF",
  denominationType: "RANGE",
  localMinAmount: 100,
  localMaxAmount: 50000,
  suggestedAmountsMap: { "1": 500, "2": 1000 },
};
const freeDataSn: ReloadlyOperator = {
  operatorId: 900,
  name: "Free Senegal Data",
  supportsLocalAmounts: true,
  destinationCurrencyCode: "XOF",
  denominationType: "FIXED",
  data: true,
  localFixedAmounts: [1000, 2000],
  localFixedAmountsDescriptions: { "1000": "1 GB / 7 days", "2000": "3 GB / 30 days" },
};
const reloadlyFakeClient = {
  autoDetectOperator: async (phone: string) => {
    if (phone.startsWith("22177")) return orangeSn;
    throw new Error("not found");
  },
  operatorsByCountry: async (iso: string) => (iso === "SN" ? [orangeSn, freeDataSn] : []),
  getOperator: async (id: number) => (id === 341 ? orangeSn : freeDataSn),
};

const rates = { current: async (currency: string) => ({ currency, perBtc: currency === "XOF" ? 60_000_000 : 150_000_000, source: "test", fetchedAt: Date.now() }) };
// 50,000 XOF at 60M XOF/BTC = 83,334 sats, which is above this cap (exercised by the cap test).
const limits = { minNgn: 50, maxNgn: 50000, maxSats: 80000, feeBps: 0, invoiceExpirySec: 600 };

let app: FastifyInstance;
let store: OrderStore;
let ln: FakeLn;
let kicked: string[];

function deps(webDistDir = "/nonexistent") {
  const catalog = new Catalog(vtpassCatalog);
  const reloadly = new ReloadlyCatalog(reloadlyFakeClient);
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
    reloadly,
    rates,
    vtpassSandbox: true,
    limits,
  });
  return {
    app: { cfg, store, orders, kick: (id: string) => kicked.push(id), catalog, reloadly, rates, signer: new ReceiptSigner(cfg.NOSTR_SECRET_KEY_HEX), ln },
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
    expect(res.body).not.toContain("rsecret");
    expect(res.body).not.toContain("secret=");
    expect(res.json()).toMatchObject({ providers: { vtpass: { configured: true }, reloadly: { configured: true, sandbox: true } } });
  });

  it("lists African countries with the provider serving each service", async () => {
    const res = await app.inject({ method: "GET", url: "/api/countries" });
    const byIso = Object.fromEntries(res.json().countries.map((c: { iso: string }) => [c.iso, c]));
    expect(byIso.NG.services).toEqual({ airtime: "vtpass", data: "vtpass", electricity: "vtpass" });
    expect(byIso.SN.services).toEqual({ airtime: "reloadly", data: "reloadly", electricity: null });
    expect(byIso.SN).toMatchObject({ currency: "XOF", dial: "221" });
  });

  it("filters the VTpass catalogue to supported Nigerian networks", async () => {
    const res = await app.inject({ method: "GET", url: "/api/catalog/airtime" });
    expect(res.json().services.map((s: { serviceID: string }) => s.serviceID)).toEqual(["mtn"]);
  });

  it("detects a Senegalese operator and lists local data plans", async () => {
    const det = await app.inject({ method: "GET", url: "/api/operators/detect?country=SN&phone=77%20123%2045%2067" });
    expect(det.json().operator).toMatchObject({ operatorId: "341", name: "Orange Senegal", currency: "XOF", minAmount: 100 });
    const bad = await app.inject({ method: "GET", url: "/api/operators/detect?country=SN&phone=70%20123%2045%2067" });
    expect(bad.json().error.code).toBe("operator_not_found");
    const plans = await app.inject({ method: "GET", url: "/api/data-plans?country=SN" });
    expect(plans.json().plans).toEqual([
      { operatorId: "900", operatorName: "Free Senegal Data", amountLocal: 1000, name: "1 GB / 7 days" },
      { operatorId: "900", operatorName: "Free Senegal Data", amountLocal: 2000, name: "3 GB / 30 days" },
    ]);
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

  it("creates a Senegal airtime order via Reloadly in XOF with the detected operator", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/orders",
      payload: { category: "airtime", countryCode: "SN", phone: "77 123 45 67", amountLocal: 600 },
    });
    expect(res.statusCode).toBe(201);
    const o = res.json();
    expect(o).toMatchObject({ currency: "XOF", countryCode: "SN", amountLocal: 600, amountSats: 1000, product: "600 XOF Orange Senegal airtime" });
    expect(store.get(o.id)).toMatchObject({ provider: "reloadly", operatorId: "341", phone: "221771234567" });
    expect(res.body).not.toContain("221771234567");
  });

  it("enforces the operator's local limits and fixed data-plan prices", async () => {
    const tooSmall = await app.inject({ method: "POST", url: "/api/orders", payload: { category: "airtime", countryCode: "SN", phone: "771234567", amountLocal: 50 } });
    expect(tooSmall.json().error.code).toBe("bad_amount");
    const plan = await app.inject({ method: "POST", url: "/api/orders", payload: { category: "data", countryCode: "SN", phone: "771234567", operatorId: "900", amountLocal: 2000 } });
    expect(plan.statusCode).toBe(201);
    expect(plan.json().product).toBe("Free Senegal Data: 3 GB / 30 days");
    const fakePlan = await app.inject({ method: "POST", url: "/api/orders", payload: { category: "data", countryCode: "SN", phone: "771234567", operatorId: "900", amountLocal: 1 } });
    expect(fakePlan.json().error.code).toBe("unknown_plan");
  });

  it("caps any order by sats regardless of currency", async () => {
    const res = await app.inject({ method: "POST", url: "/api/orders", payload: { category: "airtime", countryCode: "SN", phone: "771234567", amountLocal: 50000 } });
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

describe("API: Africa's Talking airtime", () => {
  const atCfg = loadConfig({
    NODE_ENV: "test",
    MERCHANT_NWC_URL: "nostr+walletconnect://abc?relay=wss://r.example&secret=00",
    NOSTR_SECRET_KEY_HEX: "11".repeat(32),
    VTPASS_API_KEY: "k",
    VTPASS_PUBLIC_KEY: "PK_x",
    VTPASS_SECRET_KEY: "SK_x",
    AT_USERNAME: "sandbox",
    AT_API_KEY: "atkey",
    AT_CALLBACK_TOKEN: "t".repeat(32),
    TEST_WALLET_FAUCET: "false",
  });
  let atApp: FastifyInstance;
  let inbox: AtStatusInbox;

  beforeEach(async () => {
    inbox = new AtStatusInbox();
    const orders = new OrderService({
      store,
      ln,
      vtpass: { verifyMerchant: async () => ({}) },
      vtpassCatalog: new Catalog(vtpassCatalog),
      reloadly: null,
      africastalking: true,
      rates,
      vtpassSandbox: true,
      limits,
    });
    atApp = await buildApp(
      { cfg: atCfg, store, orders, kick: (id: string) => kicked.push(id), catalog: new Catalog(vtpassCatalog), reloadly: null, atInbox: inbox, rates, signer: new ReceiptSigner(atCfg.NOSTR_SECRET_KEY_HEX), ln },
      { webDistDir: "/nonexistent" },
    );
  });
  afterEach(async () => {
    await atApp.close();
  });

  it("routes airtime outside Nigeria to Africa's Talking and lists only served countries", async () => {
    const res = await atApp.inject({ method: "GET", url: "/api/countries" });
    const countries = res.json().countries as { iso: string; services: Record<string, string | null> }[];
    const sn = countries.find((c) => c.iso === "SN");
    expect(sn?.services).toEqual({ airtime: "africastalking", data: null, electricity: null });
    expect(countries.find((c) => c.iso === "NG")?.services.airtime).toBe("vtpass");
    expect(countries.some((c) => c.iso === "ML")).toBe(false); // not covered by AT, no Reloadly
    expect(countries.some((c) => c.iso === "ET")).toBe(true);
    expect(res.body).not.toContain("atkey");
  });

  it("describes the country's airtime range across every network", async () => {
    const res = await atApp.inject({ method: "GET", url: "/api/operators/detect?country=SN&phone=771234567" });
    expect(res.statusCode).toBe(200);
    expect(res.json().operator).toMatchObject({ isAutoNetwork: true, currency: "XOF", minAmount: 500, maxAmount: 60000, fixedAmounts: [] });
  });

  it("creates a Senegal airtime order via Africa's Talking within AT's limits", async () => {
    const res = await atApp.inject({ method: "POST", url: "/api/orders", payload: { category: "airtime", countryCode: "SN", phone: "77 123 45 67", amountLocal: 1000, operatorId: "0" } });
    expect(res.statusCode).toBe(201);
    const order = store.get(res.json().id);
    expect(order?.provider).toBe("africastalking");
    expect(order?.currency).toBe("XOF");
    expect(order?.phone).toBe("221771234567");
    const low = await atApp.inject({ method: "POST", url: "/api/orders", payload: { category: "airtime", countryCode: "SN", phone: "771234567", amountLocal: 100 } });
    expect(low.statusCode).toBe(400);
    expect(low.json().error.code).toBe("bad_amount");
  });

  it("accepts the airtime status callback only with the secret token, as JSON or form data", async () => {
    const url = `/api/webhooks/africastalking/airtime/${"t".repeat(32)}`;
    const wrong = await atApp.inject({ method: "POST", url: "/api/webhooks/africastalking/airtime/nope", payload: { requestId: "ATQid_1", status: "Success" } });
    expect(wrong.statusCode).toBe(404);
    expect(inbox.get("ATQid_1")).toBeNull();
    const json = await atApp.inject({ method: "POST", url, payload: { requestId: "ATQid_1", status: "Success", phoneNumber: "+221771234567" } });
    expect(json.statusCode).toBe(200);
    expect(inbox.get("ATQid_1")).toBe("Success");
    const form = await atApp.inject({
      method: "POST",
      url,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "requestId=ATQid_2&status=Failed",
    });
    expect(form.statusCode).toBe(200);
    expect(inbox.get("ATQid_2")).toBe("Failed");
    const junk = await atApp.inject({ method: "POST", url, payload: { requestId: "ATQid_3", status: "Delivered?" } });
    expect(junk.statusCode).toBe(400);
  });
});
