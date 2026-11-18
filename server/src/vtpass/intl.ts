import { AppError } from "../errors.ts";

type FetchLike = typeof fetch;

/** VTpass International Airtime/Data product types (https://vtpass.com/documentation/foreign-airtime/). */
export const INTL_PRODUCT_TYPE = { airtime: 1, data: 4 } as const;
export type IntlCategory = keyof typeof INTL_PRODUCT_TYPE;

export interface IntlOperator {
  operatorId: string;
  name: string;
  logo: string | null;
}

/** One purchasable item: a flexible top-up range or a fixed-price bundle, with VTpass's naira cost. */
export interface IntlOffer {
  operatorId: string;
  variationCode: string;
  name: string;
  /** Currency the recipient receives (from the variation list, the source of truth). */
  currency: string;
  isFixed: boolean;
  /** Fixed offers: the local amount. Flexible offers: null. */
  amountLocal: number | null;
  minLocal: number | null;
  maxLocal: number | null;
  /** Naira VTpass charges per unit of local currency. */
  ngnPerUnit: number | null;
  /** Fixed offers: the naira VTpass charges. */
  chargedNgn: number | null;
}

interface RawVariation {
  variation_code?: string;
  name?: string;
  fixedPrice?: string;
  variation_amount?: string | number | null;
  variation_amount_min?: string | number | null;
  variation_amount_max?: string | number | null;
  variation_rate?: string | number | null;
  charged_amount?: string | number | null;
  charged_currency?: string | null;
}

/** Extra attempts when VTpass returns an empty list (observed: about 1 in 3 replies during testing). */
const EMPTY_RETRIES = 2;
const hasItems = (v: unknown): boolean => Array.isArray(v) && v.length > 0;

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Normalises one VTpass variation; returns null for anything we cannot price exactly in naira. */
export function toOffer(operatorId: string, currency: string | null, v: RawVariation): IntlOffer | null {
  if (!currency || !v.variation_code || !v.name) return null;
  if (v.charged_currency && v.charged_currency !== "NGN") return null;
  const rate = num(v.variation_rate);
  if (v.fixedPrice === "Yes") {
    const amount = num(v.variation_amount);
    const charged = num(v.charged_amount) ?? (amount !== null && rate !== null ? amount * rate : null);
    if (amount === null || charged === null) return null;
    return { operatorId, variationCode: v.variation_code, name: v.name, currency, isFixed: true, amountLocal: amount, minLocal: amount, maxLocal: amount, ngnPerUnit: rate, chargedNgn: charged };
  }
  const min = num(v.variation_amount_min);
  const max = num(v.variation_amount_max);
  if (rate === null || min === null || max === null || min > max) return null;
  return { operatorId, variationCode: v.variation_code, name: v.name, currency, isFixed: false, amountLocal: null, minLocal: min, maxLocal: max, ngnPerUnit: rate, chargedNgn: null };
}

/** Naira cost of an offer at a local amount, rounded up to the kobo. Throws if the amount is outside the offer. */
export function costNgn(offer: IntlOffer, amountLocal: number): number {
  if (offer.isFixed) {
    if (amountLocal !== offer.amountLocal || offer.chargedNgn === null) throw new AppError(400, "bad_amount", "That bundle has a fixed price.");
    return Math.ceil(offer.chargedNgn * 100) / 100;
  }
  if (offer.minLocal === null || offer.maxLocal === null || offer.ngnPerUnit === null) throw new AppError(400, "bad_amount", "That top-up is unavailable.");
  if (amountLocal < offer.minLocal || amountLocal > offer.maxLocal) {
    throw new AppError(400, "bad_amount", `Choose ${offer.minLocal} to ${offer.maxLocal} ${offer.currency}.`);
  }
  return Math.ceil(offer.ngnPerUnit * amountLocal * 100) / 100;
}

/**
 * VTpass International Airtime/Data catalogue. These are public GET endpoints; `baseUrl` is
 * https://vtpass.com (real per-country catalogue) or https://sandbox.vtpass.com. Cached for an hour.
 */
export class IntlCatalog {
  private readonly cache = new Map<string, { at: number; value: unknown }>();
  /**
   * Last reply that had data, per path, kept without expiry. Seeded from a committed snapshot of real
   * VTpass replies, so it also works right after a restart.
   */
  private readonly lastGood: Map<string, unknown>;

  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly ttlMs = 3_600_000,
    private readonly now: () => number = Date.now,
    private readonly retryDelayMs = 400,
    seed: Readonly<Record<string, unknown>> = {},
  ) {
    this.lastGood = new Map(Object.entries(seed));
  }

  /** ISO codes VTpass sells international airtime to. */
  async countryCodes(): Promise<Set<string>> {
    const body = (await this.get("/api/get-international-airtime-countries", (v) => hasItems((v as { content?: { countries?: unknown } }).content?.countries))) as { content?: { countries?: { code?: string }[] } };
    return new Set((body.content?.countries ?? []).map((c) => c.code ?? "").filter((c) => /^[A-Z]{2}$/.test(c)));
  }

  async operators(countryIso: string, category: IntlCategory): Promise<IntlOperator[]> {
    const q = `code=${encodeURIComponent(countryIso)}&product_type_id=${INTL_PRODUCT_TYPE[category]}`;
    const body = (await this.get(`/api/get-international-airtime-operators?${q}`, (v) => hasItems((v as { content?: unknown }).content))) as {
      content?: { operator_id?: string | number; name?: string; operator_image?: string }[];
    };
    return (Array.isArray(body.content) ? body.content : [])
      .filter((o) => o.operator_id !== undefined && typeof o.name === "string")
      .map((o) => ({ operatorId: String(o.operator_id), name: o.name as string, logo: typeof o.operator_image === "string" ? o.operator_image : null }));
  }

  async offers(operatorId: string, category: IntlCategory): Promise<IntlOffer[]> {
    const q = `serviceID=foreign-airtime&operator_id=${encodeURIComponent(operatorId)}&product_type_id=${INTL_PRODUCT_TYPE[category]}`;
    const body = (await this.get(`/api/service-variations?${q}`, (v) => {
      const c = (v as { content?: { variations?: unknown; varations?: unknown } }).content;
      return hasItems(c?.variations) || hasItems(c?.varations);
    })) as {
      content?: { currency?: string | null; variations?: RawVariation[]; varations?: RawVariation[] };
    };
    const currency = body.content?.currency ?? null;
    const list = body.content?.variations ?? body.content?.varations ?? [];
    const offers = list.map((v) => toOffer(operatorId, currency, v)).filter((o): o is IntlOffer => o !== null);
    // Airtime = flexible top-ups; data = fixed bundles whose names say data.
    return category === "airtime" ? offers.filter((o) => !o.isFixed) : offers.filter((o) => o.isFixed && /data|gb|mb/i.test(o.name));
  }

  async findOffer(operatorId: string, category: IntlCategory, variationCode: string): Promise<IntlOffer> {
    const offer = (await this.offers(operatorId, category)).find((o) => o.variationCode === variationCode);
    if (!offer) throw new AppError(400, "unknown_plan", "That product is not available.");
    return offer;
  }

  /**
   * GET with caching. VTpass's live catalogue intermittently answers "000" with an EMPTY list for a
   * country or network that does have products, so an empty reply is retried and never cached:
   * otherwise one bad reply would hide a network's products for the whole cache period.
   */
  private async get(path: string, hasData: (value: unknown) => boolean): Promise<unknown> {
    const hit = this.cache.get(path);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.value;
    let last: unknown = null;
    for (let attempt = 0; attempt < EMPTY_RETRIES + 1; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, this.retryDelayMs * attempt));
      last = await this.fetchOnce(path);
      if (hasData(last)) {
        this.cache.set(path, { at: this.now(), value: last });
        this.lastGood.set(path, last);
        return last;
      }
    }
    // VTpass sometimes hides a product for hours. Show the last real data instead of nothing: buying a
    // product that is really down simply fails, and Confam then releases the customer's sats.
    return this.lastGood.get(path) ?? last; // not cached, so the next request asks VTpass again
  }

  private async fetchOnce(path: string): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(new URL(path, this.baseUrl), { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    } catch {
      throw new AppError(503, "catalog_unavailable", "The product catalogue is unavailable. Try again shortly.");
    }
    const value = (await res.json().catch(() => null)) as { response_description?: string } | null;
    if (!res.ok || !value || value.response_description !== "000") {
      throw new AppError(503, "catalog_unavailable", "The product catalogue is unavailable. Try again shortly.");
    }
    return value;
  }
}
