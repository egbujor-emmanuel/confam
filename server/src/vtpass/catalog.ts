import type { Category } from "../orders/types.ts";
import type { VtpassClient } from "./client.ts";

export interface CatalogService {
  serviceID: string;
  name: string;
  minAmount: number | null;
  maxAmount: number | null;
  image: string | null;
}

export interface CatalogVariation {
  code: string;
  name: string;
  amountNgn: number;
}

const IDENTIFIER: Record<Category, string> = { airtime: "airtime", data: "data", electricity: "electricity-bill" };

/** Nigerian mobile networks we support for airtime/data (VTpass also lists foreign airtime, ISPs, etc.). */
const ALLOW: Partial<Record<Category, ReadonlySet<string>>> = {
  airtime: new Set(["mtn", "airtel", "glo", "etisalat"]),
  data: new Set(["mtn-data", "airtel-data", "glo-data", "etisalat-data"]),
};

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v.replace(/[^\d.]/g, "")) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

interface Cached<T> {
  at: number;
  value: T;
}

/** Live service catalogue from VTpass (never hardcoded), cached for an hour. */
export class Catalog {
  private readonly services = new Map<Category, Cached<CatalogService[]>>();
  private readonly variations = new Map<string, Cached<CatalogVariation[]>>();

  constructor(
    private readonly client: Pick<VtpassClient, "services" | "variations"> | null,
    private readonly ttlMs = 3_600_000,
    private readonly now: () => number = Date.now,
  ) {}

  async list(category: Category): Promise<CatalogService[]> {
    const hit = this.services.get(category);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.value;
    if (!this.client) return [];
    const raw = await this.client.services(IDENTIFIER[category]);
    const allow = ALLOW[category];
    const value = raw
      .filter((s) => typeof s.serviceID === "string" && (!allow || allow.has(s.serviceID)))
      .map((s) => ({
        serviceID: s.serviceID,
        name: s.name,
        minAmount: num(s.minimium_amount), // sic: VTpass spells it "minimium_amount"
        maxAmount: num(s.maximum_amount),
        image: typeof s.image === "string" ? s.image : null,
      }));
    if (value.length > 0) this.services.set(category, { at: this.now(), value });
    return value;
  }

  async find(category: Category, serviceID: string): Promise<CatalogService | null> {
    return (await this.list(category)).find((s) => s.serviceID === serviceID) ?? null;
  }

  async listVariations(serviceID: string): Promise<CatalogVariation[]> {
    const hit = this.variations.get(serviceID);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.value;
    if (!this.client) return [];
    const value = (await this.client.variations(serviceID))
      .map((v) => ({ code: v.variation_code, name: v.name, amountNgn: num(v.variation_amount) ?? 0 }))
      .filter((v) => v.code && v.amountNgn > 0);
    // VTpass sometimes repeats a variation code with different names: keep the first.
    const unique = [...new Map(value.map((v) => [v.code, v])).values()];
    if (unique.length > 0) this.variations.set(serviceID, { at: this.now(), value: unique });
    return unique;
  }
}
