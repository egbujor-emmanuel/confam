import { existsSync } from "node:fs";
import { resolve } from "node:path";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { AppError } from "./errors.ts";
import { registerApi, type ApiDeps } from "./routes/api.ts";

export interface AppOptions {
  logger?: boolean;
  webDistDir?: string;
}

/** Builds the HTTP app. Kept separate from server.ts so tests can use app.inject(). */
export async function buildApp(deps: ApiDeps, opts: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    trustProxy: true,
    bodyLimit: 16 * 1024,
    logger: opts.logger
      ? {
          level: deps.cfg.NODE_ENV === "production" ? "info" : "debug",
          // Never log request bodies (phone/meter numbers) or wallet secrets.
          redact: ["req.headers.authorization", "req.headers.cookie", "req.body", "nwcUrl", "preimage", "phone", "billersCode"],
        }
      : false,
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https://sandbox.vtpass.com", "https://vtpass.com"],
        // The in-browser test wallet talks to its wallet service over Nostr relays (wss).
        connectSrc: ["'self'", "wss:"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  });
  await app.register(cors, { origin: deps.cfg.NODE_ENV === "production" ? false : deps.cfg.corsOrigins });
  await app.register(rateLimit, { global: true, max: 120, timeWindow: "1 minute" });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 429) {
      return reply.code(429).send({ error: { code: "rate_limited", message: "Too many requests. Slow down a little." } });
    }
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: { code: "bad_request", message: "Bad request." } });
    }
    req.log.error({ err: err instanceof Error ? err.message : String(err) }, "unhandled error");
    return reply.code(500).send({ error: { code: "internal", message: "Something went wrong. Your money is safe; try again." } });
  });

  await registerApi(app, deps);

  const dist = opts.webDistDir ?? resolve(import.meta.dirname, "../../web/dist");
  if (existsSync(resolve(dist, "index.html"))) {
    // wildcard: true resolves files at request time (a startup-time route table breaks after rebuilds).
    await app.register(fastifyStatic, { root: dist, wildcard: true, cacheControl: false });
    // index.html (and every SPA route) must always revalidate because it points at the current
    // hashed bundles; files under /assets/ are content-hashed and can be cached forever.
    app.addHook("onSend", async (req, reply, payload) => {
      if (req.method === "GET" && !req.url.startsWith("/api/")) {
        const immutable = req.url.startsWith("/assets/") && reply.statusCode === 200;
        reply.header("cache-control", immutable ? "public, max-age=31536000, immutable" : "no-cache");
      }
      return payload;
    });
    app.setNotFoundHandler((req, reply) => {
      const path = req.url.split("?")[0] ?? "";
      // SPA fallback only for app routes. A missing asset/file must 404, never return HTML as JS.
      const isFileLike = path.startsWith("/assets/") || /\.[a-z0-9]{1,8}$/i.test(path);
      if (req.method === "GET" && !path.startsWith("/api/") && !isFileLike) return reply.sendFile("index.html");
      return reply.code(404).send({ error: { code: "not_found", message: "Not found." } });
    });
  }

  return app;
}
