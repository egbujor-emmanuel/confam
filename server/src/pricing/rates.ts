type FetchLike = typeof fetch;

export interface Rate {
  currency: string;
  /** Local currency units per 1 BTC. */
  perBtc: number;
  source: string;
  fetchedAt: number;
}

export interface RateSource {
  name: string;
  /** Returns local-currency units per BTC, or throws if this source cannot price `currency`. */
  fetch(currency: string, fetchImpl: FetchLike): Promise<number>;
}

const json = async (fetchImpl: FetchLike, url: string): Promise<unknown> => {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(8000), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json() as Promise<unknown>;
};

/** Direct BTC price in the local currency (CoinGecko supports some African currencies, e.g. NGN, ZAR). */
export const coingeckoDirect: RateSource = {
  name: "coingecko",
  async fetch(currency, f) {
    const c = currency.toLowerCase();
    const body = (await json(f, `https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=${c}`)) as {
      bitcoin?: Record<string, number>;
    };
    const v = body.bitcoin?.[c];
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) throw new Error(`coingecko: no ${currency} price`);
    return v;
  },
};

/** Universal: BTC/USD (Kraken) x USD/local (open.er-api.com). Works for XOF, XAF, GHS, KES, etc. */
export const btcUsdTimesFx: RateSource = {
  name: "kraken*er-api",
  async fetch(currency, f) {
    const [k, fx] = await Promise.all([
      json(f, "https://api.kraken.com/0/public/Ticker?pair=XBTUSD") as Promise<{ result?: Record<string, { c?: [string, string] }> }>,
      json(f, "https://open.er-api.com/v6/latest/USD") as Promise<{ rates?: Record<string, number> }>,
    ]);
    const pair = k.result ? Object.values(k.result)[0] : undefined;
    const usd = Number(pair?.c?.[0]);
    const local = currency.toUpperCase() === "USD" ? 1 : fx.rates?.[currency.toUpperCase()];
    if (!Number.isFinite(usd) || usd <= 0 || typeof local !== "number" || local <= 0) throw new Error(`fallback: no ${currency} data`);
    return usd * local;
  },
};

export interface RateServiceOptions {
  sources?: RateSource[];
  cacheMs?: number;
  /** Refuse to quote on a rate older than this, even if all sources are down. */
  maxStaleMs?: number;
  fetchImpl?: FetchLike;
  now?: () => number;
}

export class RateService {
  private readonly cache = new Map<string, Rate>();
  private readonly inflight = new Map<string, Promise<Rate>>();
  private readonly sources: RateSource[];
  private readonly cacheMs: number;
  private readonly maxStaleMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;

  constructor(opts: RateServiceOptions = {}) {
    this.sources = opts.sources ?? [coingeckoDirect, btcUsdTimesFx];
    this.cacheMs = opts.cacheMs ?? 60_000;
    this.maxStaleMs = opts.maxStaleMs ?? 10 * 60_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  async current(currency: string): Promise<Rate> {
    const key = currency.toUpperCase();
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.fetchedAt < this.cacheMs) return hit;
    let p = this.inflight.get(key);
    if (!p) {
      p = this.refresh(key).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  private async refresh(currency: string): Promise<Rate> {
    const errors: string[] = [];
    for (const src of this.sources) {
      try {
        const perBtc = await src.fetch(currency, this.fetchImpl);
        const rate = { currency, perBtc, source: src.name, fetchedAt: this.now() };
        this.cache.set(currency, rate);
        return rate;
      } catch (err) {
        errors.push(`${src.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const stale = this.cache.get(currency);
    if (stale && this.now() - stale.fetchedAt < this.maxStaleMs) return stale;
    throw new Error(`No BTC/${currency} rate available (${errors.join("; ")})`);
  }
}

/** Sats needed to buy `amountLocal` at `perBtc`, plus an optional fee in basis points. Always rounds UP. */
export function localToSats(amountLocal: number, perBtc: number, feeBps = 0): number {
  if (!(amountLocal > 0) || !(perBtc > 0)) throw new Error("amount and rate must be positive");
  const sats = (amountLocal * 100_000_000 * (10_000 + feeBps)) / (perBtc * 10_000);
  return Math.ceil(sats - 1e-9);
}
