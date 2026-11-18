import type { Lang } from "./i18n.ts";

const locale = (lang: Lang): string => (lang === "fr" ? "fr-FR" : "en-GB");

/** Local money, e.g. "₦2,000", "1 000 F CFA", "GH₵50". Zero-decimal currencies show no decimals. */
export function money(amount: number, currency: string, lang: Lang = "en"): string {
  try {
    return new Intl.NumberFormat(locale(lang), {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
      maximumFractionDigits: ["XOF", "XAF", "NGN", "UGX", "RWF", "GNF", "TZS"].includes(currency) ? 0 : 2,
    }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

export const sats = (n: number, lang: Lang = "en"): string => `${Math.round(n).toLocaleString(locale(lang))} sats`;
export const satsToLocal = (s: number, perBtc: number): number => (s * perBtc) / 100_000_000;

/** Nigerian network from prefix (VTpass flow only; elsewhere the operator is detected by the provider). */
export function guessNgNetwork(phone: string): "mtn" | "airtel" | "glo" | "etisalat" | null {
  const d = phone.replace(/\D/g, "").replace(/^234/, "0");
  const p = d.startsWith("0") ? d : `0${d}`;
  const t: Record<string, string[]> = {
    mtn: ["07025", "07026", "0703", "0704", "0706", "0803", "0806", "0810", "0813", "0814", "0816", "0903", "0906", "0913", "0916"],
    airtel: ["0701", "0708", "0802", "0808", "0812", "0901", "0902", "0904", "0907", "0912"],
    glo: ["0705", "0805", "0807", "0811", "0815", "0905", "0915"],
    etisalat: ["0809", "0817", "0818", "0908", "0909"],
  };
  for (const [net, list] of Object.entries(t)) if (list.some((x) => p.startsWith(x))) return net as "mtn";
  return null;
}

export const NG_NETWORK_LABEL: Record<string, string> = { mtn: "MTN", airtel: "Airtel", glo: "Glo", etisalat: "9mobile" };
