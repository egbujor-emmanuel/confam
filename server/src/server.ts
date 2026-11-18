import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { COUNTRIES } from "./countries.ts";
import { DexpayClient } from "./dexpay/client.ts";
import { createHoldInvoiceProvider } from "./lightning/index.ts";
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
  const intl = vtpass ? new IntlCatalog(cfg.VTPASS_INTL_CATALOG_URL ?? cfg.VTPASS_BASE_URL) : null;
  let intlCountries: ReadonlySet<string> = new Set();
  // Filled in the background: countries where at least one network has data bundles.
  const intlDataCountries = new Set<string>();
  if (intl) {
    try {
      intlCountries = await intl.countryCodes();
      const served = COUNTRIES.filter((c) => c.iso !== "NG" && intlCountries.has(c.iso));
      void findDataCountries(intl, served.map((c) => c.iso), intlDataCountries);
    } catch (err) {
      process.stderr.write(`International catalogue unavailable at startup: ${err instanceof Error ? err.message : String(err)}
`);
    }
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

  await engine.start();
  await app.listen({ port: cfg.PORT, host: cfg.HOST });
  app.log.info({ ln: ln.kind, providers: Object.keys(providers) }, "Confam is up");

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    engine?.stop();
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
