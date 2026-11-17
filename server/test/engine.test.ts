import { beforeEach, describe, expect, it } from "vitest";
import { OrderEngine } from "../src/orders/engine.ts";
import { VtpassProvider, buildVtpassPayParams } from "../src/providers/vtpass.ts";
import { OrderStore } from "../src/orders/store.ts";
import { ReceiptSigner, verifyReceipt } from "../src/receipts/sign.ts";
import { VtpassNetworkError } from "../src/vtpass/client.ts";
import { DELIVERED, DELIVERED_TOKEN, FAILED, FakeLn, FakeVtpass, PROCESSING, seedOrder, silentLog } from "./fakes.ts";

const SECRET = "7f".repeat(32);
const DEADLINE_SEC = 90;

function setup(vtpass: FakeVtpass | null = new FakeVtpass()) {
  let t = 1_800_000_000_000;
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  const store = new OrderStore(":memory:");
  const ln = new FakeLn();
  const signer = new ReceiptSigner(SECRET);
  const engine = new OrderEngine({
    store,
    ln,
    providers: vtpass ? { vtpass: new VtpassProvider(vtpass) } : {},
    signer,
    log: silentLog,
    cfg: { vendDeadlineSec: DEADLINE_SEC, tickMs: 1000 },
    now: clock.now,
  });
  return { store, ln, engine, clock, signer, vtpass };
}

describe("OrderEngine: happy path", () => {
  it("locks, buys once, settles only after delivery, scrubs PII, signs a receipt", async () => {
    const vt = new FakeVtpass([DELIVERED]);
    const { store, ln, engine, clock, signer } = setup(vt);
    const order = await seedOrder(store, ln, clock.now());

    await engine.process(order.id);
    expect(store.get(order.id)?.state).toBe("awaiting_payment");
    expect(vt.payCalls).toHaveLength(0); // never buy before the money is locked

    ln.payerPays(order.paymentHash);
    await engine.process(order.id);

    const done = store.get(order.id)!;
    expect(done.state).toBe("completed");
    expect(vt.payCalls).toHaveLength(1);
    expect(vt.payCalls[0]).toMatchObject({ serviceID: "mtn", amount: 2000, phone: "08011111111", requestId: order.requestId });
    expect(ln.invoices.get(order.paymentHash)?.state).toBe("settled");
    expect(done.phone).toBeNull();
    expect(done.billersCode).toBeNull();
    expect(done.providerTxId).toBe("TX123");
    const receipt = JSON.parse(done.receiptJson!);
    expect(verifyReceipt(receipt, signer.pubkeyHex)).toBe(true);
    expect(store.events(order.id).map((e) => e.to)).toEqual(["awaiting_payment", "locked", "vending", "delivered", "completed"]);
  });

  it("stores the electricity token and units from the provider", async () => {
    const vt = new FakeVtpass([DELIVERED_TOKEN]);
    const { store, ln, engine, clock } = setup(vt);
    const order = await seedOrder(store, ln, clock.now(), {
      category: "electricity",
      serviceId: "ikeja-electric",
      billersCode: "1111111111111",
      meterType: "prepaid",
    });
    ln.payerPays(order.paymentHash);
    await engine.process(order.id);
    const done = store.get(order.id)!;
    expect(done.state).toBe("completed");
    expect(done.token).toBe("2636 2054 4059 8275 7802");
    expect(done.units).toBe("79.9 kWh");
    expect(vt.payCalls[0]).toMatchObject({ billersCode: "1111111111111", variationCode: "prepaid" });
  });
});

describe("OrderEngine: failure paths never charge the customer", () => {
  it("cancels the lock when the provider says failed", async () => {
    const vt = new FakeVtpass([FAILED]);
    const { store, ln, engine, clock } = setup(vt);
    const order = await seedOrder(store, ln, clock.now());
    ln.payerPays(order.paymentHash);
    await engine.process(order.id);
    const o = store.get(order.id)!;
    expect(o.state).toBe("released");
    expect(o.releaseReason).toBe("delivery_failed");
    expect(ln.invoices.get(order.paymentHash)?.state).toBe("canceled");
    expect(ln.settleCalls).toBe(0);
    expect(o.phone).toBeNull();
  });

  it("keeps the lock while pending, then settles when requery confirms delivery", async () => {
    const vt = new FakeVtpass([PROCESSING], [DELIVERED]);
    const { store, ln, engine, clock } = setup(vt);
    const order = await seedOrder(store, ln, clock.now());
    ln.payerPays(order.paymentHash);
    await engine.process(order.id);
    expect(store.get(order.id)?.state).toBe("vending");
    expect(ln.invoices.get(order.paymentHash)?.state).toBe("accepted");

    clock.advance(4000);
    await engine.process(order.id);
    expect(store.get(order.id)?.state).toBe("completed");
    expect(vt.payCalls).toHaveLength(1);
    expect(vt.requeryCalls).toEqual([order.requestId]);
  });

  it("releases the lock at the deadline if delivery stays unconfirmed, then reconciles", async () => {
    const vt = new FakeVtpass([PROCESSING], [PROCESSING, PROCESSING]);
    const { store, ln, engine, clock } = setup(vt);
    const order = await seedOrder(store, ln, clock.now());
    ln.payerPays(order.paymentHash);
    await engine.process(order.id);

    clock.advance(4000);
    await engine.process(order.id); // still pending, within deadline
    expect(store.get(order.id)?.state).toBe("vending");

    clock.advance(DEADLINE_SEC * 1000);
    await engine.process(order.id);
    const released = store.get(order.id)!;
    expect(released.state).toBe("released");
    expect(released.releaseReason).toBe("delivery_unconfirmed");
    expect(released.reconState).toBe("watching");
    expect(ln.invoices.get(order.paymentHash)?.state).toBe("canceled");

    // The provider later confirms: customer keeps it for free, operator absorbs the cost.
    vt.requeryResponses.push(DELIVERED_TOKEN);
    clock.advance(61_000);
    await engine.tick();
    const late = store.get(order.id)!;
    expect(late.state).toBe("released");
    expect(late.reconState).toBe("delivered_after_release");
    expect(late.token).toBe("2636 2054 4059 8275 7802");
  });

  it("treats a network error on /pay as pending and NEVER calls /pay again", async () => {
    const vt = new FakeVtpass([new VtpassNetworkError("socket hang up")], [DELIVERED]);
    const { store, ln, engine, clock } = setup(vt);
    const order = await seedOrder(store, ln, clock.now());
    ln.payerPays(order.paymentHash);
    await engine.process(order.id);
    expect(store.get(order.id)?.state).toBe("vending");
    clock.advance(4000);
    await engine.process(order.id);
    await engine.process(order.id);
    expect(store.get(order.id)?.state).toBe("completed");
    expect(vt.payCalls).toHaveLength(1);
  });

  it("calls /pay exactly once under concurrent processing", async () => {
    const vt = new FakeVtpass([DELIVERED]);
    const { store, ln, engine, clock } = setup(vt);
    const order = await seedOrder(store, ln, clock.now());
    ln.payerPays(order.paymentHash);
    await Promise.all([engine.process(order.id), engine.process(order.id), engine.tick(), engine.tick()]);
    expect(vt.payCalls).toHaveLength(1);
    expect(store.get(order.id)?.state).toBe("completed");
  });

  it("recovers after a crash mid-purchase by requerying, not re-buying", async () => {
    const vt = new FakeVtpass([], [DELIVERED]);
    const { store, ln, engine, clock } = setup(vt);
    const order = await seedOrder(store, ln, clock.now());
    ln.payerPays(order.paymentHash);
    // Simulate a crash right after claiming the purchase (state persisted as vending).
    store.transition(order.id, "awaiting_payment", "locked", { lockedAt: clock.now() }, "locked", clock.now());
    store.transition(order.id, "locked", "vending", { vendStartedAt: clock.now() }, "buying", clock.now());
    clock.advance(5000);
    await engine.process(order.id);
    expect(vt.payCalls).toHaveLength(0);
    expect(store.get(order.id)?.state).toBe("completed");
  });

  it("does not buy if the lock vanished before purchase", async () => {
    const vt = new FakeVtpass([DELIVERED]);
    const { store, ln, engine, clock } = setup(vt);
    const order = await seedOrder(store, ln, clock.now());
    store.transition(order.id, "awaiting_payment", "locked", { lockedAt: clock.now() }, "locked", clock.now());
    ln.invoices.get(order.paymentHash)!.state = "canceled";
    await engine.process(order.id);
    expect(vt.payCalls).toHaveLength(0);
    expect(store.get(order.id)).toMatchObject({ state: "released", releaseReason: "lock_lost" });
  });

  it("releases (without buying) when the bill provider is not configured", async () => {
    const { store, ln, engine, clock } = setup(null);
    const order = await seedOrder(store, ln, clock.now());
    ln.payerPays(order.paymentHash);
    await engine.process(order.id);
    expect(store.get(order.id)?.state).toBe("released");
    expect(ln.invoices.get(order.paymentHash)?.state).toBe("canceled");
  });

  it("releases a short-paid lock (amount mismatch) without buying", async () => {
    const vt = new FakeVtpass([DELIVERED]);
    const { store, ln, engine, clock } = setup(vt);
    const order = await seedOrder(store, ln, clock.now());
    ln.payerPays(order.paymentHash, 1000);
    await engine.process(order.id);
    expect(vt.payCalls).toHaveLength(0);
    expect(store.get(order.id)).toMatchObject({ state: "released", releaseReason: "amount_mismatch" });
  });
});

describe("OrderEngine: resilience", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup(new FakeVtpass([FAILED]));
  });

  it("never marks released until the cancel is confirmed", async () => {
    const { store, ln, engine, clock } = ctx;
    const order = await seedOrder(store, ln, clock.now());
    ln.payerPays(order.paymentHash);
    ln.failCancelTimes = 1;
    await engine.process(order.id);
    expect(store.get(order.id)?.state).toBe("vending");
    expect(ln.invoices.get(order.paymentHash)?.state).toBe("accepted");
    clock.advance(4000);
    ctx.vtpass!.requeryResponses.push(FAILED);
    await engine.process(order.id);
    expect(store.get(order.id)?.state).toBe("released");
    expect(ln.invoices.get(order.paymentHash)?.state).toBe("canceled");
  });

  it("retries settlement after a transient wallet error", async () => {
    const vt = new FakeVtpass([DELIVERED]);
    const c = setup(vt);
    const order = await seedOrder(c.store, c.ln, c.clock.now());
    c.ln.payerPays(order.paymentHash);
    c.ln.failSettleTimes = 1;
    await c.engine.process(order.id);
    expect(c.store.get(order.id)?.state).toBe("delivered");
    expect(c.store.get(order.id)?.receiptJson).not.toBeNull();
    await c.engine.process(order.id);
    expect(c.store.get(order.id)?.state).toBe("completed");
    expect(vt.payCalls).toHaveLength(1);
  });

  it("expires unpaid orders and cancels their invoice", async () => {
    const { store, ln, engine, clock } = ctx;
    const order = await seedOrder(store, ln, clock.now());
    clock.advance(600_000 + 31_000);
    await engine.process(order.id);
    expect(store.get(order.id)?.state).toBe("expired");
    expect(ln.invoices.get(order.paymentHash)?.state).toBe("canceled");
  });

  it("does nothing while the wallet is unreachable (no state change, no purchase)", async () => {
    const { store, ln, engine, clock } = ctx;
    const order = await seedOrder(store, ln, clock.now());
    ln.payerPays(order.paymentHash);
    ln.statusUnavailable = true;
    await engine.process(order.id);
    expect(store.get(order.id)?.state).toBe("awaiting_payment");
    expect(ctx.vtpass!.payCalls).toHaveLength(0);
  });
});

describe("buildVtpassPayParams", () => {
  it("maps data orders to billersCode + variation_code", async () => {
    const { store, ln, clock } = setup();
    const order = await seedOrder(store, ln, clock.now(), {
      category: "data",
      serviceId: "mtn-data",
      variationCode: "mtn-10mb-100",
      billersCode: "08011111111",
      amountLocal: 100,
    });
    expect(buildVtpassPayParams(order)).toMatchObject({
      serviceID: "mtn-data",
      billersCode: "08011111111",
      variationCode: "mtn-10mb-100",
      phone: "08011111111",
    });
  });
});
