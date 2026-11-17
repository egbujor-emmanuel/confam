import { AppError } from "../errors.ts";
import type { ReloadlyClient, ReloadlyOperator } from "./client.ts";

export interface OperatorInfo {
  operatorId: string;
  name: string;
  currency: string;
  /** For range operators. */
  minAmount: number | null;
  maxAmount: number | null;
  /** For fixed-denomination operators (and data plans). */
  fixedAmounts: number[];
  suggestedAmounts: number[];
  logo: string | null;
  isData: boolean;
}

export interface DataPlan {
  operatorId: string;
  operatorName: string;
  amountLocal: number;
  name: string;
}

/** Only local-currency operators are offered, so prices are exact in the customer's own currency. */
export function toOperatorInfo(op: ReloadlyOperator): OperatorInfo | null {
  if (!op.supportsLocalAmounts || !op.destinationCurrencyCode) return null;
  const fixed = (op.localFixedAmounts ?? []).filter((n) => n > 0).sort((a, b) => a - b);
  const suggested = Object.values(op.suggestedAmountsMap ?? {})
    .filter((n): n is number => typeof n === "number" && n > 0)
    .sort((a, b) => a - b)
    .slice(0, 6);
  const isRange = op.denominationType === "RANGE" && (op.localMinAmount ?? 0) > 0;
  if (!isRange && fixed.length === 0) return null;
  return {
    operatorId: String(op.operatorId),
    name: op.name,
    currency: op.destinationCurrencyCode,
    minAmount: isRange ? (op.localMinAmount ?? null) : null,
    maxAmount: isRange ? (op.localMaxAmount ?? null) : null,
    fixedAmounts: fixed,
    suggestedAmounts: suggested,
    logo: op.logoUrls?.[0] ?? null,
    isData: Boolean(op.data || op.bundle),
  };
}

export class ReloadlyCatalog {
  private readonly byCountry = new Map<string, { at: number; ops: ReloadlyOperator[] }>();

  constructor(
    private readonly client: Pick<ReloadlyClient, "autoDetectOperator" | "operatorsByCountry" | "getOperator">,
    private readonly ttlMs = 3_600_000,
    private readonly now: () => number = Date.now,
  ) {}

  async detect(phoneIntl: string, countryIso: string): Promise<OperatorInfo> {
    let op: ReloadlyOperator;
    try {
      op = await this.client.autoDetectOperator(phoneIntl, countryIso);
    } catch {
      throw new AppError(422, "operator_not_found", "We couldn't find a mobile network for that number. Check the number and country.");
    }
    const info = toOperatorInfo(op);
    if (!info) throw new AppError(422, "operator_unsupported", `${op.name} top-ups aren't available in local currency yet.`);
    return info;
  }

  async operator(operatorId: string): Promise<OperatorInfo> {
    const info = toOperatorInfo(await this.client.getOperator(Number(operatorId)));
    if (!info) throw new AppError(422, "operator_unsupported", "That network isn't available in local currency.");
    return info;
  }

  async dataPlans(countryIso: string): Promise<DataPlan[]> {
    const plans: DataPlan[] = [];
    for (const op of await this.operators(countryIso)) {
      if (!(op.data || op.bundle) || !op.supportsLocalAmounts) continue;
      const desc = op.localFixedAmountsDescriptions ?? {};
      for (const amount of op.localFixedAmounts ?? []) {
        if (!(amount > 0)) continue;
        const name = desc[String(amount)] ?? desc[amount.toFixed(2)] ?? `${amount} ${op.destinationCurrencyCode ?? ""}`.trim();
        plans.push({ operatorId: String(op.operatorId), operatorName: op.name, amountLocal: amount, name });
      }
    }
    return plans.sort((a, b) => a.operatorName.localeCompare(b.operatorName) || a.amountLocal - b.amountLocal);
  }

  private async operators(countryIso: string): Promise<ReloadlyOperator[]> {
    const hit = this.byCountry.get(countryIso);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.ops;
    const ops = await this.client.operatorsByCountry(countryIso);
    if (ops.length > 0) this.byCountry.set(countryIso, { at: this.now(), ops });
    return ops;
  }
}
