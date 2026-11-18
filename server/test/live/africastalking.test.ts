import { describe, expect, it } from "vitest";
import { AtClient } from "../../src/africastalking/client.ts";
import { loadConfig } from "../../src/config.ts";

/**
 * LIVE: the real Africa's Talking sandbox (AT_USERNAME=sandbox + sandbox API key in .env).
 * Records what the sandbox actually returns for send + status, which the provider relies on.
 * Skipped when AT keys are not configured.
 */
const cfg = (() => {
  try {
    process.loadEnvFile(new URL("../../../.env", import.meta.url));
  } catch {
    // no .env: rely on the process environment
  }
  try {
    return loadConfig();
  } catch {
    return null;
  }
})();
const enabled = Boolean(cfg?.atConfigured);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!enabled)("Africa's Talking sandbox (live)", () => {
  it("sends airtime to a Nigerian and a Senegalese number and reports a status for each", async () => {
    const client = new AtClient({ username: cfg?.AT_USERNAME as string, apiKey: cfg?.AT_API_KEY as string });
    const cases = [
      { phoneE164: "+2348031234567", currency: "NGN", amount: 100 },
      { phoneE164: "+221771234567", currency: "XOF", amount: 1000 },
    ];
    for (const c of cases) {
      const sent = await client.sendAirtime({ ...c, idempotencyKey: `live-${Date.now()}-${c.currency}` });
      // eslint-disable-next-line no-console
      console.info(`[AT sandbox] send ${c.currency} ->`, sent);
      expect(["Sent", "Failed"]).toContain(sent.status);
      if (!sent.requestId) continue;
      let status: string | null = null;
      for (let i = 0; i < 10 && status !== "Success" && status !== "Failed"; i++) {
        await sleep(3000);
        status = await client.airtimeStatus(sent.requestId).catch((e: unknown) => `error: ${e instanceof Error ? e.message : String(e)}`);
        // eslint-disable-next-line no-console
        console.info(`[AT sandbox] status ${sent.requestId} (${i + 1}) ->`, status);
      }
      expect(status).not.toBeNull();
    }
  }, 90_000);
});
