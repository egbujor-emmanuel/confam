import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createHoldInvoiceProvider } from "./lightning/index.ts";
import { OrderEngine } from "./orders/engine.ts";
import { OrderService } from "./orders/service.ts";
import { OrderStore } from "./orders/store.ts";
import { RateService } from "./pricing/rates.ts";
import { AtClient } from "./africastalking/client.ts";
import { AfricasTalkingProvider, AtStatusInbox } from "./providers/africastalking.ts";
import { ReloadlyProvider } from "./providers/reloadly.ts";
import type { ProviderRegistry } from "./providers/types.ts";
import { VtpassProvider } from "./providers/vtpass.ts";
import { ReceiptSigner } from "./receipts/sign.ts";
import { ReloadlyCatalog } from "./reloadly/catalog.ts";
import { ReloadlyClient } from "./reloadly/client.ts";
import { Catalog } from "./vtpass/catalog.ts";
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
  const reloadlyClient = cfg.reloadlyConfigured
    ? new ReloadlyClient({
        baseUrl: cfg.RELOADLY_BASE_URL,
        clientId: cfg.RELOADLY_CLIENT_ID as string,
        clientSecret: cfg.RELOADLY_CLIENT_SECRET as string,
      })
    : null;

  const atClient = cfg.atConfigured ? new AtClient({ username: cfg.AT_USERNAME as string, apiKey: cfg.AT_API_KEY as string }) : null;
  const atInbox = atClient ? new AtStatusInbox() : null;

  const providers: ProviderRegistry = {};
  if (atClient && atInbox) providers.africastalking = new AfricasTalkingProvider(atClient, atInbox);
  if (vtpass) providers.vtpass = new VtpassProvider(vtpass);
  if (reloadlyClient) providers.reloadly = new ReloadlyProvider(reloadlyClient);

  const catalog = new Catalog(vtpass);
  const reloadly = reloadlyClient ? new ReloadlyCatalog(reloadlyClient) : null;
  const rates = new RateService();
  const signer = new ReceiptSigner(cfg.NOSTR_SECRET_KEY_HEX);
  const orders = new OrderService({
    store,
    ln,
    vtpass,
    vtpassCatalog: catalog,
    reloadly,
    africastalking: Boolean(atClient),
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
    { cfg, store, orders, kick: (id) => void engine?.process(id), catalog, reloadly, atInbox, rates, signer, ln },
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
