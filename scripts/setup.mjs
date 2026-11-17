#!/usr/bin/env node
// One-command setup: installs dependencies, creates .env (generated signing key + a merchant
// test wallet if none is set), and builds the web app. Safe to re-run: never overwrites values.
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = resolve(root, ".env");
const say = (msg) => process.stdout.write(`${msg}\n`);

function run(cmd) {
  say(`\n> ${cmd}`);
  execSync(cmd, { cwd: root, stdio: "inherit" });
}

function parseEnv(text) {
  const out = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out.set(m[1], m[2]);
  }
  return out;
}

function setVar(text, key, value) {
  const re = new RegExp(`^${key}=.*$`, "m");
  return re.test(text) ? text.replace(re, `${key}=${value}`) : `${text.trimEnd()}\n${key}=${value}\n`;
}

async function faucetWallet(sats) {
  const res = await fetch(`https://faucet.nwc.dev?balance=${sats}`, { method: "POST", signal: AbortSignal.timeout(20000) });
  const url = (await res.text()).trim();
  if (!url.startsWith("nostr+walletconnect://")) throw new Error("faucet returned an unexpected response");
  return url;
}

async function main() {
  const [major] = process.versions.node.split(".").map(Number);
  if (major < 24) throw new Error(`Node 24+ required (found ${process.versions.node}).`);

  if (!existsSync(resolve(root, "node_modules"))) run("npm install");

  let text = existsSync(envPath) ? readFileSync(envPath, "utf8") : readFileSync(resolve(root, ".env.example"), "utf8");
  const env = parseEnv(text);

  if (!env.get("NOSTR_SECRET_KEY_HEX")) {
    text = setVar(text, "NOSTR_SECRET_KEY_HEX", randomBytes(32).toString("hex"));
    say("Generated a receipt-signing key.");
  }

  // Pass provider keys through the environment for non-interactive setup.
  for (const key of ["VTPASS_API_KEY", "VTPASS_PUBLIC_KEY", "VTPASS_SECRET_KEY", "RELOADLY_CLIENT_ID", "RELOADLY_CLIENT_SECRET"]) {
    if (!env.get(key) && process.env[key]) text = setVar(text, key, process.env[key]);
  }

  if ((env.get("LN_BACKEND") ?? "nwc") === "nwc" && !env.get("MERCHANT_NWC_URL")) {
    try {
      text = setVar(text, "MERCHANT_NWC_URL", await faucetWallet(1000));
      say("Created a merchant test wallet (faucet.nwc.dev) that issues hold invoices.");
    } catch (err) {
      say(`Could not create a test wallet automatically (${err.message}). Set MERCHANT_NWC_URL in .env.`);
    }
  }

  writeFileSync(envPath, text, { mode: 0o600 });
  say(`Wrote ${envPath}`);

  run("npm run build -w web");

  const final = parseEnv(text);
  const missingVtpass = ["VTPASS_API_KEY", "VTPASS_PUBLIC_KEY", "VTPASS_SECRET_KEY"].filter((k) => !final.get(k));
  const missingReloadly = ["RELOADLY_CLIENT_ID", "RELOADLY_CLIENT_SECRET"].filter((k) => !final.get(k));
  say("\nSetup complete.");
  if (missingReloadly.length) {
    say(`For airtime/data across Africa, add Reloadly sandbox keys to .env (${missingReloadly.join(", ")}): reloadly.com > Developers > API Settings (Test mode).`);
  }
  if (missingVtpass.length) {
    say(`For Nigerian electricity tokens, add VTpass sandbox keys to .env (${missingVtpass.join(", ")}): https://sandbox.vtpass.com > Account > API Keys.`);
  }
  say("Start Confam with:  npm start   (then open http://localhost:8787)");
}

main().catch((err) => {
  process.stderr.write(`Setup failed: ${err.message}\n`);
  process.exit(1);
});
