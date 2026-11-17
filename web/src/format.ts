export const naira = (n: number): string => `₦${Math.round(n).toLocaleString("en-NG")}`;
export const sats = (n: number): string => `${Math.round(n).toLocaleString("en-NG")} sats`;
export const satsToNaira = (s: number, ngnPerBtc: number): number => (s * ngnPerBtc) / 100_000_000;

export function guessNetwork(phone: string): "mtn" | "airtel" | "glo" | "etisalat" | null {
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

export const NETWORK_LABEL: Record<string, string> = { mtn: "MTN", airtel: "Airtel", glo: "Glo", etisalat: "9mobile" };
export const dataServiceFor = (net: string): string => `${net}-data`;
