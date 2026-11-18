/** African countries Confam serves. Operators/billers per country are fetched live from providers. */
export interface Country {
  iso: string;
  name: string;
  nameFr: string;
  dial: string;
  currency: string;
  flag: string;
}

export const COUNTRIES: readonly Country[] = [
  { iso: "SN", name: "Senegal", nameFr: "Sénégal", dial: "221", currency: "XOF", flag: "🇸🇳" },
  { iso: "NG", name: "Nigeria", nameFr: "Nigeria", dial: "234", currency: "NGN", flag: "🇳🇬" },
  { iso: "CI", name: "Côte d'Ivoire", nameFr: "Côte d'Ivoire", dial: "225", currency: "XOF", flag: "🇨🇮" },
  { iso: "GH", name: "Ghana", nameFr: "Ghana", dial: "233", currency: "GHS", flag: "🇬🇭" },
  { iso: "KE", name: "Kenya", nameFr: "Kenya", dial: "254", currency: "KES", flag: "🇰🇪" },
  { iso: "CM", name: "Cameroon", nameFr: "Cameroun", dial: "237", currency: "XAF", flag: "🇨🇲" },
  { iso: "ML", name: "Mali", nameFr: "Mali", dial: "223", currency: "XOF", flag: "🇲🇱" },
  { iso: "BF", name: "Burkina Faso", nameFr: "Burkina Faso", dial: "226", currency: "XOF", flag: "🇧🇫" },
  { iso: "BJ", name: "Benin", nameFr: "Bénin", dial: "229", currency: "XOF", flag: "🇧🇯" },
  { iso: "TG", name: "Togo", nameFr: "Togo", dial: "228", currency: "XOF", flag: "🇹🇬" },
  { iso: "GN", name: "Guinea", nameFr: "Guinée", dial: "224", currency: "GNF", flag: "🇬🇳" },
  { iso: "UG", name: "Uganda", nameFr: "Ouganda", dial: "256", currency: "UGX", flag: "🇺🇬" },
  { iso: "TZ", name: "Tanzania", nameFr: "Tanzanie", dial: "255", currency: "TZS", flag: "🇹🇿" },
  { iso: "RW", name: "Rwanda", nameFr: "Rwanda", dial: "250", currency: "RWF", flag: "🇷🇼" },
  { iso: "ZA", name: "South Africa", nameFr: "Afrique du Sud", dial: "27", currency: "ZAR", flag: "🇿🇦" },
  { iso: "ZM", name: "Zambia", nameFr: "Zambie", dial: "260", currency: "ZMW", flag: "🇿🇲" },
  { iso: "ET", name: "Ethiopia", nameFr: "Éthiopie", dial: "251", currency: "ETB", flag: "🇪🇹" },
  { iso: "MW", name: "Malawi", nameFr: "Malawi", dial: "265", currency: "MWK", flag: "🇲🇼" },
  { iso: "MZ", name: "Mozambique", nameFr: "Mozambique", dial: "258", currency: "MZN", flag: "🇲🇿" },
];

const BY_ISO = new Map(COUNTRIES.map((c) => [c.iso, c]));

export function findCountry(iso: string): Country | null {
  return BY_ISO.get(iso.toUpperCase()) ?? null;
}

/**
 * Normalises a phone number to international digits without "+" (e.g. "221771234567").
 * Accepts local format (leading 0 or none), "+<dial>…" or "<dial>…". Returns null if implausible.
 * Final validation is done by the operator lookup.
 */
export function toInternational(phone: string, country: Country): string | null {
  let d = phone.replace(/[\s\-().]/g, "");
  if (d.startsWith("+")) d = d.slice(1);
  else if (d.startsWith("00")) d = d.slice(2);
  if (!/^\d+$/.test(d)) return null;
  let national: string;
  if (d.startsWith(country.dial) && d.length > country.dial.length + 6) national = d.slice(country.dial.length);
  else national = d.replace(/^0/, "");
  if (national.length < 7 || national.length > 11) return null;
  return `${country.dial}${national}`;
}
