import { describe, expect, it } from "vitest";
import { OrderStore } from "../src/orders/store.ts";
import { FakeLn, seedOrder } from "./fakes.ts";

const T0 = 1_800_000_000_000;

async function scenario() {
  const store = new OrderStore(":memory:");
  const ln = new FakeLn();
  const done = async (sec: number, overrides = {}) => {
    const o = await seedOrder(store, ln, T0, overrides);
    store.transition(o.id, "awaiting_payment", "locked", { lockedAt: T0 + 1000 }, "", T0 + 1000);
    store.transition(o.id, "locked", "vending", { vendStartedAt: T0 + 1000 }, "", T0 + 1000);
    store.transition(o.id, "vending", "delivered", { deliveredAt: T0 + 1000 + sec * 1000 }, "", T0 + 1000 + sec * 1000);
    store.transition(o.id, "delivered", "completed", { completedAt: T0 + 2000 + sec * 1000 }, "", T0 + 2000 + sec * 1000);
  };
  await done(4);
  await done(10, { countryCode: "SN", currency: "XOF", category: "electricity", provider: "dexpay" });
  await done(20);
  const failed = await seedOrder(store, ln, T0);
  store.transition(failed.id, "awaiting_payment", "locked", { lockedAt: T0 + 1000 }, "", T0 + 1000);
  store.transition(failed.id, "locked", "released", { releasedAt: T0 + 3000, releaseReason: "delivery_failed" }, "", T0 + 3000);
  const late = await seedOrder(store, ln, T0);
  store.transition(late.id, "awaiting_payment", "locked", { lockedAt: T0 + 1000 }, "", T0 + 1000);
  store.transition(late.id, "locked", "released", { releasedAt: T0 + 91_000, releaseReason: "delivery_unconfirmed", reconState: "delivered_after_release" }, "", T0 + 91_000);
  await seedOrder(store, ln, T0); // created, never paid
  const old = await seedOrder(store, ln, T0 - 30 * 86_400_000); // outside the window
  store.transition(old.id, "awaiting_payment", "expired", {}, "", T0 - 30 * 86_400_000);
  return store;
}

describe("OrderStore.stats (aggregates only, for /api/stats)", () => {
  it("measures delivery, releases, speed and the operator's losses over a window", async () => {
    const store = await scenario();
    const s = store.stats(T0 - 7 * 86_400_000);
    expect(s.ordersCreated).toBe(6);
    expect(s.paymentsLocked).toBe(5);
    expect(s.completed).toBe(3);
    expect(s.released).toEqual({ total: 2, deliveryFailed: 1, deliveryUnconfirmed: 1, amountMismatch: 0, lockLost: 0 });
    expect(s.deliveryRate).toBeCloseTo(3 / 5);
    expect(s.medianSecondsToDelivery).toBe(10);
    expect(s.deliveredAfterRelease).toBe(1); // delivered free: the operator absorbed it
    expect(s.chargedWithoutDelivery).toBe(0); // the guarantee, measured
    expect(s.byCountry).toEqual({ NG: 5, SN: 1 });
    expect(s.byCategory).toEqual({ airtime: 5, electricity: 1 });
  });

  it("returns zeros, not NaN, for an empty window", () => {
    const s = new OrderStore(":memory:").stats(0);
    expect(s).toMatchObject({ ordersCreated: 0, paymentsLocked: 0, completed: 0, deliveryRate: null, medianSecondsToDelivery: null });
  });
});
