/**
 * Airtime coverage and per-transaction value limits, from the Africa's Talking "Value Limits" table
 * (https://developers.africastalking.com/docs/airtime/sending). Where limits differ by network we keep
 * the range every listed network accepts, so a valid quote never fails on a network-specific limit.
 */
export interface AtAirtimeLimits {
  currency: string;
  min: number;
  max: number;
  /** Quick-pick amounts shown in the form (all within [min, max]). */
  suggested: number[];
}

export const AT_AIRTIME: Readonly<Record<string, AtAirtimeLimits>> = {
  NG: { currency: "NGN", min: 50, max: 20_000, suggested: [100, 200, 500, 1000, 2000] },
  KE: { currency: "KES", min: 5, max: 5_000, suggested: [20, 50, 100, 250, 500] },
  GH: { currency: "GHS", min: 1, max: 500, suggested: [2, 5, 10, 20, 50] },
  SN: { currency: "XOF", min: 500, max: 60_000, suggested: [500, 1000, 2000, 5000, 10_000] },
  CI: { currency: "XOF", min: 150, max: 100_000, suggested: [200, 500, 1000, 2000, 5000] },
  BJ: { currency: "XOF", min: 200, max: 30_000, suggested: [200, 500, 1000, 2000, 5000] },
  CM: { currency: "XAF", min: 150, max: 25_000, suggested: [200, 500, 1000, 2000, 5000] },
  UG: { currency: "UGX", min: 500, max: 200_000, suggested: [1000, 2000, 5000, 10_000, 20_000] },
  TZ: { currency: "TZS", min: 500, max: 200_000, suggested: [500, 1000, 2000, 5000, 10_000] },
  RW: { currency: "RWF", min: 100, max: 40_000, suggested: [200, 500, 1000, 2000, 5000] },
  ZA: { currency: "ZAR", min: 5, max: 1_000, suggested: [10, 20, 50, 100, 200] },
  ZM: { currency: "ZMW", min: 5, max: 1_000, suggested: [5, 10, 20, 50, 100] },
  ET: { currency: "ETB", min: 5, max: 5_000, suggested: [10, 25, 50, 100, 250] },
  MW: { currency: "MWK", min: 368, max: 30_000, suggested: [500, 1000, 2000, 5000, 10_000] },
  MZ: { currency: "MZN", min: 152, max: 1_450, suggested: [200, 300, 500, 1000] },
};

export function atAirtimeLimits(countryIso: string): AtAirtimeLimits | null {
  return AT_AIRTIME[countryIso.toUpperCase()] ?? null;
}
