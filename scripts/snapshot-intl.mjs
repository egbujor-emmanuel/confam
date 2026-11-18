// Captures VTpass's live international airtime/data catalogue for Confam's countries into
// server/src/vtpass/intl-snapshot.json. The server uses it only as a last-known-good fallback when
// VTpass's live catalogue answers with an empty list (observed for hours at a time for some networks).
//
//   node scripts/snapshot-intl.mjs            # crawl and merge into the existing snapshot
//
// Responses are keyed by the exact request path the server uses. Empty replies are retried; a path
// that stays empty keeps its previous (older) capture, so a re-run never loses known-good data.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const BASE = "https://vtpass.com";
const OUT = resolve(import.meta.dirname, "../server/src/vtpass/intl-snapshot.json");
const ISOS = ["SN", "CI", "GH", "KE", "CM", "ML", "BF", "BJ", "TG", "GN", "UG", "TZ", "RW", "ZA", "ZM", "ET", "MW", "MZ"];
const TYPES = [1, 4];
const RETRIES = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const previous = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { responses: {} };
const responses = { ...previous.responses };
const capturedAt = { ...(previous.capturedAt ?? {}) };
let fresh = 0;
let kept = 0;
let missing = 0;

async function capture(path, hasData) {
  for (let i = 0; i <= RETRIES; i++) {
    if (i > 0) await sleep(1500 * i);
    try {
      const res = await fetch(BASE + path, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20000) });
      const body = await res.json();
      if (res.ok && body.response_description === "000" && hasData(body)) {
        responses[path] = body;
        capturedAt[path] = new Date().toISOString();
        fresh++;
        return body;
      }
    } catch {
      // retry
    }
  }
  if (responses[path]) kept++;
  else missing++;
  return responses[path] ?? null;
}

const items = (v) => Array.isArray(v) && v.length > 0;
await capture("/api/get-international-airtime-countries", (b) => items(b.content?.countries));
for (const iso of ISOS) {
  for (const type of TYPES) {
    const ops = await capture(`/api/get-international-airtime-operators?code=${iso}&product_type_id=${type}`, (b) => items(b.content));
    for (const op of ops?.content ?? []) {
      await capture(`/api/service-variations?serviceID=foreign-airtime&operator_id=${encodeURIComponent(op.operator_id)}&product_type_id=${type}`, (b) =>
        items(b.content?.variations) || items(b.content?.varations),
      );
    }
  }
  process.stdout.write(`${iso} `);
}
writeFileSync(OUT, `${JSON.stringify({ source: BASE, note: "Real VTpass catalogue replies; fallback only.", capturedAt, responses }, null, 1)}\n`);
console.log(`\nfresh=${fresh} kept-older=${kept} missing=${missing} -> ${OUT}`);
