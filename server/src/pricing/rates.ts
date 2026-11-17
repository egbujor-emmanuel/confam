type FetchLike = typeof fetch;

export interface Rate {
  ngnPerBtc: number;
  source: string;
  fetchedAt: number;
}

export interface RateSource {
  name: string;
  fetch(fetchImpl: FetchLike): Promise<number>;
}

const json = async (fetchImpl: FetchLike, url: string): Promise<unknown> => {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(8000), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json() as Promise<unknown>;
};

export const coingecko: RateSource = {
  name: "coingecko",
  async fetch(f) {
    const body = (await json(f, "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=ngn")) as {
      bitcoin?: { ngn?: number };
    };
    const v = body.bitcoin?.ngn;
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error("coingecko: no NGN price");
    return v;
  },
};

/** Fallback: Kraken BTC/USD x open.er-api.com USD/NGN. */
export const krakenTimesFx: RateSource = {
  name: "kraken*er-api",
  async fetch(f) {
    const [k, fx] = await Promise.all([
      json(f, "https://api.kraken.com/0/public/Ticker?pair=XBTUSD") as Promise<{
        result?: Record<string, { c?: [string, string] }>;
      }>,
      json(f, "https://open.er-api.com/v6/latest/USD") as Promise<{ rates?: { NGN?: number } }>,
    ]);
    const pair = k.result ? Object.values(k.result)[0] : undefined;
    const usd = Number(pair?.c?.[0]);
    const ngn = fx.rates?.NGN;
    if (!Number.isFinite(usd) || usd <= 0 || typeof ngn !== "number" || ngn <= 0) throw new Error("fallback: bad data");
    return usd * ngn;
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
  private cached: Rate | null = null;
  private inflight: Promise<Rate> | null = null;
  private readonly sources: RateSource[];
  private readonly cacheMs: number;
  private readonly maxStaleMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;

  constructor(opts: RateServiceOptions = {}) {
    this.sources = opts.sources ?? [coingecko, krakenTimesFx];
    this.cacheMs = opts.cacheMs ?? 60_000;
    this.maxStaleMs = opts.maxStaleMs ?? 10 * 60_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  async current(): Promise<Rate> {
    if (this.cached && this.now() - this.cached.fetchedAt < this.cacheMs) return this.cached;
    this.inflight ??= this.refresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async refresh(): Promise<Rate> {
    const errors: string[] = [];
    for (const src of this.sources) {
      try {
        const ngnPerBtc = await src.fetch(this.fetchImpl);
        this.cached = { ngnPerBtc, source: src.name, fetchedAt: this.now() };
        return this.cached;
      } catch (err) {
        errors.push(`${src.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (this.cached && this.now() - this.cached.fetchedAt < this.maxStaleMs) return this.cached;
    throw new Error(`No BTC/NGN rate available (${errors.join("; ")})`);
  }
}

/** Sats needed to buy `amountNgn` at `ngnPerBtc`, plus an optional fee in basis points. Always rounds UP. */
export function ngnToSats(amountNgn: number, ngnPerBtc: number, feeBps = 0): number {
  if (!(amountNgn > 0) || !(ngnPerBtc > 0)) throw new Error("amount and rate must be positive");
  const sats = (amountNgn * 100_000_000 * (10_000 + feeBps)) / (ngnPerBtc * 10_000);
  return Math.ceil(sats - 1e-9);
}
