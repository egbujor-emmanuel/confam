const TZ_TO_ISO: Record<string, string> = {
  "Africa/Dakar": "SN",
  "Africa/Lagos": "NG",
  "Africa/Abidjan": "CI",
  "Africa/Accra": "GH",
  "Africa/Nairobi": "KE",
  "Africa/Douala": "CM",
  "Africa/Bamako": "ML",
  "Africa/Ouagadougou": "BF",
  "Africa/Porto-Novo": "BJ",
  "Africa/Lome": "TG",
  "Africa/Conakry": "GN",
  "Africa/Kampala": "UG",
  "Africa/Dar_es_Salaam": "TZ",
  "Africa/Kigali": "RW",
  "Africa/Johannesburg": "ZA",
  "Africa/Lusaka": "ZM",
};

const KEY = "confam.country";

export function initialCountry(): string {
  try {
    const saved = window.localStorage.getItem(KEY);
    if (saved && /^[A-Z]{2}$/.test(saved)) return saved;
  } catch {
    /* storage unavailable */
  }
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && TZ_TO_ISO[tz]) return TZ_TO_ISO[tz];
  } catch {
    /* Intl unavailable */
  }
  return "SN";
}

export function saveCountry(iso: string): void {
  try {
    window.localStorage.setItem(KEY, iso);
  } catch {
    /* storage unavailable */
  }
}
