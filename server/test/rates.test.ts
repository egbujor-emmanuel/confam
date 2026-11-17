import { describe, expect, it } from "vitest";
import { RateService, btcUsdTimesFx, type RateSource } from "../src/pricing/rates.ts";

const src = (name: string, impl: (currency: string) => Promise<number>): RateSource => ({ name, fetch: (c) => impl(c) });

describe("RateService", () => {
  it("uses the first healthy source and caches per currency", async () => {
    let calls = 0;
    const svc = new RateService({ sources: [src("a", async () => (calls++, 100))], cacheMs: 60_000 });
    expect((await svc.current("NGN")).perBtc).toBe(100);
    await svc.current("ngn");
    expect(calls).toBe(1);
    await svc.current("XOF");
    expect(calls).toBe(2);
  });

  it("falls back to the next source", async () => {
    const svc = new RateService({ sources: [src("a", async () => Promise.reject(new Error("down"))), src("b", async () => 200)] });
    expect(await svc.current("GHS")).toMatchObject({ perBtc: 200, source: "b", currency: "GHS" });
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
    await svc.current("KES");
    fail = true;
    t = 5000;
    expect((await svc.current("KES")).perBtc).toBe(300);
    t = 20_000;
    await expect(svc.current("KES")).rejects.toThrow(/No BTC\/KES rate/);
  });
});

describe("btcUsdTimesFx", () => {
  it("multiplies BTC/USD by USD/local (works for XOF and other African currencies)", async () => {
    const fakeFetch = (async (url: string) => {
      const body = String(url).includes("kraken")
        ? { result: { XXBTZUSD: { c: ["60000.0", "1"] } } }
        : { rates: { XOF: 600, NGN: 1500 } };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    expect(await btcUsdTimesFx.fetch("XOF", fakeFetch)).toBe(36_000_000);
    await expect(btcUsdTimesFx.fetch("ZZZ", fakeFetch)).rejects.toThrow();
  });
});
