import { existsSync } from "node:fs";
import { resolve } from "node:path";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { AppError } from "./errors.ts";
import { registerApi, type ApiDeps } from "./routes/api.ts";

export interface AppOptions {
  logger?: boolean;
  webDistDir?: string;
}

/** Builds the HTTP app. Kept separate from server.ts so tests can use app.inject(). */
export async function buildApp(deps: ApiDeps, opts: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    // Exactly one proxy hop (Render's load balancer): the client IP for rate limits is the address it
    // saw, not a spoofable X-Forwarded-For entry.
    trustProxy: (_address: string, hop: number) => hop < 1,
    bodyLimit: 16 * 1024,
    logger: opts.logger
      ? {
          level: deps.cfg.NODE_ENV === "production" ? "info" : "debug",
          // Never log request bodies (phone/meter numbers) or wallet secrets.
          redact: ["req.headers.authorization", "req.headers.cookie", "req.body", "nwcUrl", "preimage", "phone", "billersCode"],
          // Request lines carry the method and path only: no client IP, port or headers.
          serializers: { req: logRequest },
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
  await app.register(rateLimit, { global: true, max: 120, timeWindow: "1 minute", keyGenerator: clientKey });

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
    // hashed bundles; files under /assets/ are content-hashed and can be cached forever; other
    // public files (icons, manifest, social card) get a day, saving a round trip per visit on 3G.
    app.addHook("onSend", async (req, reply, payload) => {
      if (req.method === "GET" && !req.url.startsWith("/api/")) {
        reply.header("cache-control", staticCacheControl(req.url.split("?")[0] ?? "", reply.statusCode));
      }
      return payload;
    });
    app.setNotFoundHandler((req, reply) => {
      const path = req.url.split("?")[0] ?? "";
      // SPA fallback only for app routes. A missing asset/file must 404, never return HTML as JS.
      const isFileLike = path.startsWith("/assets/") || FILE_LIKE.test(path);
      if (req.method === "GET" && !path.startsWith("/api/") && !isFileLike) return reply.sendFile("index.html");
      return reply.code(404).send({ error: { code: "not_found", message: "Not found." } });
    });
  }

  return app;
}

/** A path that names a file (has an extension), e.g. /og.jpg or /manifest.webmanifest. */
const FILE_LIKE = /\.[a-z0-9]{1,12}$/i;

/** Cache policy for files served from web/dist. Exported for tests. */
export function staticCacheControl(path: string, status: number): string {
  if (status !== 200) return "no-cache";
  if (path.startsWith("/assets/")) return "public, max-age=31536000, immutable";
  if (FILE_LIKE.test(path) && !path.endsWith(".html")) return "public, max-age=86400";
  return "no-cache";
}

/**
 * The address rate limits count against. Render sits behind Cloudflare, which overwrites
 * CF-Connecting-IP with the real visitor address on every request, so it cannot be forged through
 * Cloudflare. Without Cloudflare (local runs), the socket address. X-Forwarded-For is never used:
 * a client can write anything into it.
 */
export function clientKey(req: FastifyRequest): string {
  const cf = req.headers["cf-connecting-ip"];
  if (req.headers["cf-ray"] && typeof cf === "string" && cf.length > 0 && cf.length <= 45) return cf;
  return req.socket.remoteAddress ?? "unknown";
}

/** What a request log line may contain. The client's IP address is personal data, so it is left out. */
export function logRequest(req: { method?: string; url?: string }): { method?: string; url?: string } {
  return { method: req.method, url: req.url };
}
