import { describe, expect, it } from "vitest";
import { RateService, type RateSource } from "../src/pricing/rates.ts";

const src = (name: string, impl: () => Promise<number>): RateSource => ({ name, fetch: impl });

describe("RateService", () => {
  it("uses the first healthy source and caches it", async () => {
    let calls = 0;
    const svc = new RateService({ sources: [src("a", async () => (calls++, 100))], cacheMs: 60_000 });
    expect((await svc.current()).ngnPerBtc).toBe(100);
    await svc.current();
    expect(calls).toBe(1);
  });

  it("falls back to the next source", async () => {
    const svc = new RateService({
      sources: [src("a", async () => Promise.reject(new Error("down"))), src("b", async () => 200)],
    });
    const r = await svc.current();
    expect(r).toMatchObject({ ngnPerBtc: 200, source: "b" });
  });

  it("serves a slightly stale rate if all sources fail, but refuses a very stale one", async () => {
    let t = 0;
    let fail = false;
    const svc = new RateService({
      sources: [src("a", async () => (fail ? Promise.reject(new Error("down")) : 300))],
      cacheMs: 1000,
      maxStaleMs: 10_000,
      now: () => t,
    });
    await svc.current();
    fail = true;
    t = 5000;
    expect((await svc.current()).ngnPerBtc).toBe(300);
    t = 20_000;
    await expect(svc.current()).rejects.toThrow(/No BTC\/NGN rate/);
  });
});
