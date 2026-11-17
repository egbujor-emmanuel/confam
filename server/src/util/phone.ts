/** Normalises Nigerian mobile numbers to local 11-digit form (0XXXXXXXXXX). Returns null if invalid. */
export function normalizeNgPhone(input: string): string | null {
  const digits = input.replace(/[\s\-()]/g, "");
  let local: string;
  if (/^\+?234\d{10}$/.test(digits)) local = `0${digits.replace(/^\+?234/, "")}`;
  else if (/^0\d{10}$/.test(digits)) local = digits;
  else return null;
  return /^0[789][01]\d{8}$/.test(local) ? local : null;
}

/**
 * VTpass sandbox "magic" billers codes that simulate outcomes
 * (https://vtpass.com/documentation/mtn-airtime-vtu-api/): pending, unexpected, no response, timeout.
 * Accepted ONLY when talking to the sandbox, so judges can watch the money-release path.
 */
export const SANDBOX_MAGIC_NUMBERS = new Set(["201000000000", "500000000000", "400000000000", "300000000000"]);

export function acceptPhone(input: string, sandbox: boolean): string | null {
  const trimmed = input.replace(/\s/g, "");
  if (sandbox && SANDBOX_MAGIC_NUMBERS.has(trimmed)) return trimmed;
  return normalizeNgPhone(trimmed);
}

/** Network guess from prefix (number portability means users can override in the UI). */
const PREFIXES: Record<"mtn" | "airtel" | "glo" | "etisalat", string[]> = {
  mtn: ["07025", "07026", "0703", "0704", "0706", "0803", "0806", "0810", "0813", "0814", "0816", "0903", "0906", "0913", "0916"],
  airtel: ["0701", "0708", "0802", "0808", "0812", "0901", "0902", "0904", "0907", "0912"],
  glo: ["0705", "0805", "0807", "0811", "0815", "0905", "0915"],
  etisalat: ["0809", "0817", "0818", "0908", "0909"],
};

export function guessNetwork(phone: string): "mtn" | "airtel" | "glo" | "etisalat" | null {
  const p = normalizeNgPhone(phone);
  if (!p) return null;
  for (const [net, list] of Object.entries(PREFIXES) as [keyof typeof PREFIXES, string[]][]) {
    if (list.some((pre) => p.startsWith(pre))) return net;
  }
  return null;
}
