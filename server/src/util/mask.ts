/** Keeps the first 4 and last 3 characters: 08031234567 -> 0803****567. */
export function maskId(value: string): string {
  if (value.length <= 7) return `${value.slice(0, 1)}${"*".repeat(Math.max(0, value.length - 2))}${value.slice(-1)}`;
  return `${value.slice(0, 4)}${"*".repeat(value.length - 7)}${value.slice(-3)}`;
}

/** Keeps first name and initial of the rest: "NP NGEMA" -> "NP N." */
export function maskName(name: string | null | undefined): string | null {
  if (!name) return null;
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0] ?? null;
  return `${parts[0]} ${parts
    .slice(1)
    .map((p) => `${p[0]}.`)
    .join(" ")}`;
}
