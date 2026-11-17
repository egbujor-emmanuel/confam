import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { OrderService } from "../src/orders/service.ts";
import { OrderStore } from "../src/orders/store.ts";
import { ReceiptSigner } from "../src/receipts/sign.ts";
import { Catalog } from "../src/vtpass/catalog.ts";
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

let app: FastifyInstance;
let store: OrderStore;
let ln: FakeLn;
let kicked: string[];

beforeEach(async () => {
  store = new OrderStore(":memory:");
  ln = new FakeLn();
  kicked = [];
  const catalog = new Catalog(vtpassCatalog);
  const rates = { current: async () => ({ ngnPerBtc: 150_000_000, source: "test", fetchedAt: Date.now() }) };
  const orders = new OrderService({
    store,
    ln,
    vtpass: {
      verifyMerchant: async ({ billersCode }) =>
        billersCode === "1111111111111"
          ? { code: "000", content: { Customer_Name: "TESTMETER ONE", Address: "ABULE EGBA", Can_Vend: "yes", WrongBillersCode: false } }
          : { code: "000", content: { error: "meter not found", WrongBillersCode: true } },
    },
    catalog,
    rates,
    sandbox: true,
    limits: { minNgn: 50, maxNgn: 50000, feeBps: 0, invoiceExpirySec: 600 },
  });
  app = await buildApp(
    { cfg, store, orders, kick: (id) => kicked.push(id), catalog, rates, signer: new ReceiptSigner(cfg.NOSTR_SECRET_KEY_HEX), ln },
    { webDistDir: "/nonexistent" },
  );
});

afterEach(async () => {
  await app.close();
  store.close();
});

describe("API", () => {
  it("exposes config without secrets", async () => {
    const res = await app.inject({ method: "GET", url: "/api/config" });
    expect(res.statusCode).toBe(200);
    const body = res.body;
    expect(body).not.toContain("SK_x");
    expect(body).not.toContain("secret=");
    expect(res.json()).toMatchObject({ provider: { configured: true, sandbox: true }, testWallet: { enabled: false } });
  });

  it("filters the catalogue to supported Nigerian networks", async () => {
    const res = await app.inject({ method: "GET", url: "/api/catalog/airtime" });
    expect(res.json().services.map((s: { serviceID: string }) => s.serviceID)).toEqual(["mtn"]);
  });

  it("creates an airtime order, kicks the engine, and never leaks preimage / raw phone / request id", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/orders",
      payload: { category: "airtime", serviceID: "mtn", phone: "0801 111 1111", amountNgn: 1500 },
    });
    expect(res.statusCode).toBe(201);
    const o = res.json();
    expect(o).toMatchObject({ state: "awaiting_payment", amountNgn: 1500, amountSats: 1000, recipient: "0801****111" });
    expect(o.invoice).toMatch(/^lntbs/);
    expect(kicked).toEqual([o.id]);
    const stored = store.get(o.id)!;
    expect(res.body).not.toContain(stored.preimage);
    expect(res.body).not.toContain(stored.requestId);
    expect(res.body).not.toContain("08011111111");

    const view = await app.inject({ method: "GET", url: `/api/orders/${o.id}` });
    expect(view.json().timeline[0]).toMatchObject({ state: "awaiting_payment" });
  });

  it("prices data plans from the provider catalogue, ignoring any client amount", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/orders",
      payload: { category: "data", serviceID: "mtn-data", phone: "08011111111", variationCode: "mtn-10mb-100", amountNgn: 1 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().amountNgn).toBe(100);
  });

  it("verifies the meter before an electricity order and masks the customer name", async () => {
    const ok = await app.inject({
      method: "POST",
      url: "/api/orders",
      payload: { category: "electricity", serviceID: "ikeja-electric", meterNumber: "1111111111111", meterType: "prepaid", phone: "08011111111", amountNgn: 2000 },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ customerName: "TESTMETER O.", recipient: "meter 1111******111" });

    const bad = await app.inject({
      method: "POST",
      url: "/api/orders",
      payload: { category: "electricity", serviceID: "ikeja-electric", meterNumber: "1234567890123", meterType: "prepaid", phone: "08011111111", amountNgn: 2000 },
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe("meter_not_found");
  });

  it("rejects bad input with clear errors", async () => {
    const cases = [
      { payload: { category: "airtime", serviceID: "mtn", phone: "123", amountNgn: 100 }, code: "invalid_input" },
      { payload: { category: "airtime", serviceID: "mtn", phone: "08031234567", amountNgn: 10 }, code: "bad_amount" },
      { payload: { category: "airtime", serviceID: "mtn", phone: "08031234567", amountNgn: 60000 }, code: "bad_amount" },
      { payload: { category: "airtime", serviceID: "foreign-airtime", phone: "08031234567", amountNgn: 100 }, code: "unknown_service" },
      { payload: { category: "airtime", serviceID: "mtn", phone: "06031234567", amountNgn: 100 }, code: "bad_phone" },
      { payload: { category: "crypto", serviceID: "mtn" }, code: "invalid_input" },
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
    // Path traversal is normalised away before routing and never reaches the order handler.
    expect((await app.inject({ method: "GET", url: "/api/orders/../../etc/passwd" })).statusCode).toBe(404);
  });

  it("serves index.html as no-cache and hashed assets as immutable (no stale app after deploys)", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dist = mkdtempSync(join(tmpdir(), "confam-dist-"));
    mkdirSync(join(dist, "assets"));
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>t</title>");
    writeFileSync(join(dist, "assets", "index-abc123.js"), "console.log(1)");
    const catalog = new Catalog(vtpassCatalog);
    const rates = { current: async () => ({ ngnPerBtc: 1, source: "t", fetchedAt: 0 }) };
    const web = await buildApp(
      {
        cfg,
        store,
        orders: new OrderService({ store, ln, vtpass: null, catalog, rates, sandbox: true, limits: { minNgn: 50, maxNgn: 50000, feeBps: 0, invoiceExpirySec: 600 } }),
        kick: () => {},
        catalog,
        rates,
        signer: new ReceiptSigner(cfg.NOSTR_SECRET_KEY_HEX),
        ln,
      },
      { webDistDir: dist },
    );
    expect((await web.inject({ url: "/" })).headers["cache-control"]).toBe("no-cache");
    expect((await web.inject({ url: "/#/order/x" })).headers["cache-control"]).toBe("no-cache");
    expect((await web.inject({ url: "/some/deep/link" })).headers["cache-control"]).toBe("no-cache");
    expect((await web.inject({ url: "/assets/index-abc123.js" })).headers["cache-control"]).toContain("immutable");
    expect((await web.inject({ url: "/api/nope" })).statusCode).toBe(404);
    // A file added after startup (a rebuild) is served, and a missing asset 404s instead of returning HTML.
    writeFileSync(join(dist, "assets", "index-new999.js"), "console.log(2)");
    const added = await web.inject({ url: "/assets/index-new999.js" });
    expect(added.statusCode).toBe(200);
    expect(added.headers["content-type"]).toContain("javascript");
    const missing = await web.inject({ url: "/assets/index-gone.js" });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers["content-type"]).not.toContain("text/html");
    await web.close();
  });

  it("sets security headers", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });
});
