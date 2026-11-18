import { buildApp } from "./app.ts";
import { readFileSync } from "node:fs";
import { loadConfig } from "./config.ts";
import { COUNTRIES } from "./countries.ts";
import { DexpayClient } from "./dexpay/client.ts";
import { createHoldInvoiceProvider } from "./lightning/index.ts";
import { RemoteBackup, tursoRemote } from "./orders/backup.ts";
import { OrderEngine } from "./orders/engine.ts";
import { OrderService } from "./orders/service.ts";
import { OrderStore } from "./orders/store.ts";
import { RateService } from "./pricing/rates.ts";
import { DexpayProvider } from "./providers/dexpay.ts";
import type { ProviderRegistry } from "./providers/types.ts";
import { VtpassProvider } from "./providers/vtpass.ts";
import { ReceiptSigner } from "./receipts/sign.ts";
import { Catalog } from "./vtpass/catalog.ts";
import { IntlCatalog } from "./vtpass/intl.ts";
import { VtpassClient } from "./vtpass/client.ts";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const store = new OrderStore(cfg.DB_PATH);
  const ln = createHoldInvoiceProvider(cfg);

  const vtpass = cfg.vtpassConfigured
    ? new VtpassClient({
        baseUrl: cfg.VTPASS_BASE_URL,
        apiKey: cfg.VTPASS_API_KEY as string,
        publicKey: cfg.VTPASS_PUBLIC_KEY as string,
        secretKey: cfg.VTPASS_SECRET_KEY as string,
      })
    : null;
  const providers: ProviderRegistry = {};
  if (vtpass) providers.vtpass = new VtpassProvider(vtpass, cfg.VTPASS_CUSTOMER_EMAIL);
  // Senegal electricity (Woyofal) via DEXPAY.
  const dexpay = cfg.DEXPAY_SECRET_KEY ? new DexpayClient(cfg.DEXPAY_BASE_URL, cfg.DEXPAY_SECRET_KEY) : null;
  if (dexpay) providers.dexpay = new DexpayProvider(dexpay);

  // International airtime/data: the country list is read once at startup from VTpass's catalogue.
  const intlCatalogUrl = cfg.VTPASS_INTL_CATALOG_URL ?? cfg.VTPASS_BASE_URL;
  const intl = vtpass ? new IntlCatalog(intlCatalogUrl, fetch, 3_600_000, Date.now, 400, loadIntlSnapshot(intlCatalogUrl)) : null;
  // Filled from VTpass's catalogue at startup and refreshed every 30 minutes. Add-only: VTpass's
  // catalogue sometimes answers with an empty list, which must never hide a country that has products.
  const intlCountries = new Set<string>();
  const intlDataCountries = new Set<string>();
  const refreshIntl = async (): Promise<void> => {
    if (!intl) return;
    try {
      for (const iso of await intl.countryCodes()) intlCountries.add(iso);
      const served = COUNTRIES.filter((c) => c.iso !== "NG" && intlCountries.has(c.iso));
      await findDataCountries(intl, served.map((c) => c.iso), intlDataCountries);
    } catch (err) {
      process.stderr.write(`International catalogue refresh failed: ${err instanceof Error ? err.message : String(err)}
`);
    }
  };
  if (intl) {
    try {
      for (const iso of await intl.countryCodes()) intlCountries.add(iso);
    } catch (err) {
      process.stderr.write(`International catalogue unavailable at startup: ${err instanceof Error ? err.message : String(err)}
`);
    }
    void refreshIntl();
    setInterval(() => void refreshIntl(), 30 * 60_000).unref();
  }

  const catalog = new Catalog(vtpass);
  const rates = new RateService();
  const signer = new ReceiptSigner(cfg.NOSTR_SECRET_KEY_HEX);
  const orders = new OrderService({
    store,
    ln,
    vtpass,
    vtpassCatalog: catalog,
    intl,
    intlCountries,
    intlDataCountries,
    dexpay,
    rates,
    vtpassSandbox: cfg.vtpassIsSandbox,
    limits: {
      minNgn: cfg.MIN_ORDER_NGN,
      maxNgn: cfg.MAX_ORDER_NGN,
      maxSats: cfg.MAX_ORDER_SATS,
      feeBps: cfg.SERVICE_FEE_BPS,
      invoiceExpirySec: cfg.INVOICE_EXPIRY_SEC,
    },
  });

  // The engine logs through Fastify's (redacting) logger, so it is created right after the app.
  let engine: OrderEngine | null = null;
  const app = await buildApp(
    { cfg, store, orders, kick: (id) => void engine?.process(id), catalog, intl, rates, signer, ln },
    { logger: true },
  );
  engine = new OrderEngine({
    store,
    ln,
    providers,
    signer,
    log: app.log,
    cfg: { vendDeadlineSec: cfg.VEND_DEADLINE_SEC, tickMs: cfg.ENGINE_TICK_MS },
  });

  // Restore from the durable copy BEFORE the engine runs, so locked payments resume where they were.
  let stopBackup: (() => Promise<void>) | null = null;
  if (cfg.TURSO_DATABASE_URL && cfg.TURSO_AUTH_TOKEN) {
    const backup = new RemoteBackup(store, await tursoRemote(cfg.TURSO_DATABASE_URL, cfg.TURSO_AUTH_TOKEN), {
      info: (m) => app.log.info(m),
      warn: (m) => app.log.warn(m),
    });
    await initWithRetry(backup, (m) => app.log.warn(m));
    stopBackup = backup.start(5000);
    app.log.info("order backup to Turso is on");
  } else {
    app.log.warn("TURSO_DATABASE_URL not set: orders live only on this disk");
  }

  await engine.start();
  await app.listen({ port: cfg.PORT, host: cfg.HOST });
  app.log.info({ ln: ln.kind, providers: Object.keys(providers) }, "Confam is up");

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    engine?.stop();
    await stopBackup?.();
    await app.close();
    ln.close?.();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

/** Adds each country where some network has at least one data bundle (errors just leave it out). */
async function findDataCountries(intl: IntlCatalog, isos: string[], into: Set<string>): Promise<void> {
  await Promise.all(
    isos.map(async (iso) => {
      try {
        for (const op of await intl.operators(iso, "data")) {
          if ((await intl.offers(op.operatorId, "data")).length > 0) {
            into.add(iso);
            return;
          }
        }
      } catch {
        // Catalogue hiccup for this country: data stays hidden there rather than showing a dead end.
      }
    }),
  );
}

/** The restore must succeed before the engine starts; retry briefly, then refuse to start on stale data. */
async function initWithRetry(backup: RemoteBackup, warn: (m: string) => void): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await backup.init();
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt >= 5) throw new Error(`Could not reach the Turso backup after 5 attempts: ${msg}`);
      warn(`Turso backup unreachable (attempt ${attempt}/5): ${msg}`);
      await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
}

/** Last-known-good VTpass catalogue replies (scripts/snapshot-intl.mjs); only valid for the live catalogue. */
function loadIntlSnapshot(catalogUrl: string): Record<string, unknown> {
  try {
    const snap = JSON.parse(readFileSync(new URL("./vtpass/intl-snapshot.json", import.meta.url), "utf8")) as {
      source?: string;
      responses?: Record<string, unknown>;
    };
    return snap.source && new URL(snap.source).host === new URL(catalogUrl).host ? (snap.responses ?? {}) : {};
  } catch {
    return {};
  }
}
