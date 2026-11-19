"use strict";
// Real footage of the live app for the demo video (ui-demo skill: discover -> rehearse -> record).
// Each segment is its own clip at phone size with a visible cursor and a ring on every tap; every tap
// is logged (ms from clip start) to <segment>.clicks.json so click sounds land on the right frame.
//   PW_CORE=<playwright-core> node record.cjs --rehearse        selectors only, no wallet, no orders
//   PW_CORE=<playwright-core> node record.cjs [segment ...]     record (default: all, in order)
const { chromium } = require(process.env.PW_CORE);
const fs = require("fs");
const path = require("path");

const BASE = process.env.CONFAM_URL || "https://confam-qxdh.onrender.com";
const OUT = path.join(__dirname, "clips");
const STATE = path.join(OUT, "wallet-state.json"); // the test wallet created in the first segment
const VIEW = { width: 430, height: 932 }; // the phone layout the app is designed for
// Recorded at ZOOM x the pixels (sharp when shown large in the film): the window is ZOOM times bigger
// and <body> is zoomed, so the app still lays out at 430 CSS px. The cursor overlay lives on <html>,
// outside the zoom, so its coordinates are plain window pixels.
const ZOOM = Number(process.env.ZOOM || 1.5);
const REC = { width: Math.round(VIEW.width * ZOOM), height: Math.round(VIEW.height * ZOOM) };
const zoomBody = (z) => {
  const apply = () => document.body && (document.body.style.zoom = String(z));
  apply();
  new MutationObserver(apply).observe(document, { childList: true, subtree: true });
};
const REHEARSE = process.argv.includes("--rehearse");

async function injectOverlay(page) {
  await page.evaluate(() => {
    if (document.getElementById("demo-cursor")) return;
    const cursor = document.createElement("div");
    cursor.id = "demo-cursor";
    cursor.innerHTML = '<svg width="30" height="30" viewBox="0 0 24 24"><path d="M5 3L19 12L12 13L9 20L5 3Z" fill="white" stroke="black" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    cursor.style.cssText = "position:fixed;z-index:999999;pointer-events:none;left:320px;top:1050px;transition:left .12s,top .12s;transform:scale(1.5);transform-origin:0 0;filter:drop-shadow(1px 2px 2px rgba(0,0,0,.35))";
    document.documentElement.appendChild(cursor);
    document.addEventListener("mousemove", (e) => {
      cursor.style.left = `${e.clientX}px`;
      cursor.style.top = `${e.clientY}px`;
    });
    window.__ring = (x, y) => {
      const r = document.createElement("div");
      r.style.cssText = `position:fixed;z-index:999998;pointer-events:none;left:${x - 33}px;top:${y - 33}px;width:66px;height:66px;border-radius:50%;border:4px solid #c6f432;box-shadow:0 0 0 2px rgba(0,0,0,.25);transform:scale(.4);opacity:1;transition:transform .45s ease-out,opacity .45s ease-out`;
      document.documentElement.appendChild(r);
      requestAnimationFrame(() => {
        r.style.transform = "scale(1.4)";
        r.style.opacity = "0";
      });
      setTimeout(() => r.remove(), 600);
    };
  });
}

function makeSession(page, segment) {
  const t0 = Date.now();
  const clicks = [];
  const fail = (label) => {
    throw new Error(`"${label}" not visible (segment ${segment})`);
  };
  async function tap(locator, label, after = 900) {
    const el = typeof locator === "string" ? page.locator(locator).first() : locator;
    if (!(await el.isVisible().catch(() => false))) fail(label);
    await el.scrollIntoViewIfNeeded();
    await page.waitForTimeout(250);
    const box = await el.boundingBox();
    if (!box) fail(label);
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y, { steps: 14 });
    await page.waitForTimeout(350);
    await injectOverlay(page);
    await page.evaluate(([cx, cy]) => window.__ring?.(cx, cy), [x, y]);
    clicks.push({ atMs: Date.now() - t0, label, kind: "click" });
    await el.click();
    await page.waitForTimeout(after);
  }
  async function type(locator, text, label) {
    await tap(locator, label, 300);
    const el = page.locator(locator).first();
    await el.fill("");
    clicks.push({ atMs: Date.now() - t0, label: `${label} (typing)`, kind: "typing", chars: text.length });
    await el.pressSequentially(text, { delay: 85 });
    await page.waitForTimeout(600);
  }
  async function pick(selector, value, label) {
    await tap(selector, label, 300);
    await page.selectOption(selector, value);
    await page.waitForTimeout(900);
  }
  async function scrollTo(selector, after = 1200) {
    await page.locator(selector).first().evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "center" }));
    await page.waitForTimeout(after);
  }
  const mark = (label) => clicks.push({ atMs: Date.now() - t0, label, kind: "mark" });
  return { tap, type, pick, scrollTo, mark, clicks };
}

async function goHome(page, lang) {
  await page.goto(`${BASE}/#/`);
  await page.waitForSelector("select#country");
  if ((await page.evaluate(() => document.documentElement.lang)) !== lang) await page.locator(".lang-switch button", { hasText: lang.toUpperCase() }).click();
  await injectOverlay(page);
  await page.waitForTimeout(1200);
}

async function payAndWait(page, s, endText) {
  await page.waitForSelector("#pay-title", { timeout: 30000 });
  await page.waitForTimeout(1500);
  await s.tap(page.getByRole("button", { name: /Pay with my Confam wallet|Payer avec mon portefeuille Confam/ }), "pay with wallet", 500);
  s.mark("payment sent");
  await page.waitForFunction((t) => document.querySelector("#order-headline")?.textContent?.match(new RegExp(t)), endText, { timeout: 150000 });
  s.mark("final state");
  // Back up to the card: headline, stamp and wallet balance are the shot that matters.
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" })); // lock, stamp, headline, wallet
  await page.waitForTimeout(800);
  s.mark("result card shown");
  await page.waitForTimeout(4500); // let the stamp land and the balance come back
}

const SEGMENTS = {
  // Home in Nigeria, then the free test wallet.
  async wallet(page, s) {
    await goHome(page, "en");
    await s.pick("select#country", "NG", "country Nigeria");
    await s.tap(".wallet-chip", "connect wallet", 1200);
    await s.tap(page.getByRole("button", { name: /Get a free test wallet/ }), "get test wallet", 500);
    await page.waitForFunction(() => /\d/.test(document.querySelector(".wallet-chip")?.textContent || ""), null, { timeout: 30000 });
    s.mark("balance shown");
    await page.waitForTimeout(2500);
  },
  // Nigeria airtime, sandbox success number: locked -> buying -> delivered -> paid, signed receipt.
  async airtime(page, s) {
    await goHome(page, "en");
    await s.tap(page.locator("button.tile", { hasText: "Airtime" }), "airtime tile", 1500);
    await s.tap(page.getByRole("button", { name: "Use test number" }), "use test number", 900);
    await s.tap(page.locator("button.chip", { hasText: "₦200" }), "amount 200", 1800);
    await s.tap(page.getByRole("button", { name: "Continue to pay" }), "continue to pay", 500);
    await payAndWait(page, s, "Done");
    await s.scrollTo("#proof-title", 2500);
    await page.waitForFunction(() => /valid|valide/i.test(document.querySelector("#proof-title")?.parentElement?.textContent || ""), null, { timeout: 20000 }).catch(() => null);
    s.mark("receipt verified");
    await page.waitForTimeout(2500);
  },
  // Nigeria airtime to an ordinary number: the sandbox fails it, the lock opens, NOT CHARGED.
  async fail(page, s) {
    await goHome(page, "en");
    await s.tap(page.locator("button.tile", { hasText: "Airtime" }), "airtime tile", 1500);
    await s.type("#phone", "08031234567", "phone number");
    await s.tap(page.locator("button.chip", { hasText: "₦200" }), "amount 200", 1800);
    await s.tap(page.getByRole("button", { name: "Continue to pay" }), "continue to pay", 500);
    await payAndWait(page, s, "didn't go through");
  },
  // Senegal, in French: Woyofal prepaid electricity, the token on screen.
  async woyofal(page, s) {
    await goHome(page, "fr");
    await s.pick("select#country", "SN", "pays Sénégal");
    await s.tap(page.locator("button.tile", { hasText: "Électricité" }), "tuile électricité", 1500);
    await s.type("#meter", "14123456789", "numéro de compteur");
    await page.waitForSelector(".notice.info", { timeout: 30000 });
    s.mark("meter checked");
    await page.waitForTimeout(1200);
    await s.type("#phone", "771234567", "téléphone");
    await s.tap(page.locator("button.chip", { hasText: "2" }).filter({ hasText: "000" }).first(), "montant 2000", 1800);
    await s.tap(page.getByRole("button", { name: "Continuer vers le paiement" }), "continuer", 500);
    await payAndWait(page, s, "Terminé");
    await s.scrollTo(".token-box", 3000);
  },
  // The live metrics, as served.
  async stats(page, s) {
    await page.goto(`${BASE}/api/stats?days=30`);
    await page.addStyleTag({ content: "body{font-size:19px;padding:18px;word-break:break-word;background:#fbf8f1;color:#10201a}" });
    await page.evaluate(() => {
      const pre = document.querySelector("pre") || document.body;
      try {
        pre.textContent = JSON.stringify(JSON.parse(pre.textContent), null, 2);
      } catch {}
    });
    await injectOverlay(page);
    s.mark("stats shown");
    await page.waitForTimeout(6000);
  },
};

async function rehearse(browser) {
  const ctx = await browser.newContext({ viewport: VIEW, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const check = async (loc, label) => {
    const ok = await loc.first().isVisible().catch(() => false);
    console.log(`${ok ? "REHEARSAL OK  " : "REHEARSAL FAIL"} ${label}`);
    return ok;
  };
  let ok = true;
  await goHome(page, "en");
  ok = (await check(page.locator("select#country"), "country select")) && ok;
  ok = (await check(page.locator("button.tile", { hasText: "Airtime" }), "airtime tile")) && ok;
  await page.locator(".wallet-chip").click();
  ok = (await check(page.getByRole("button", { name: /Get a free test wallet/ }), "get test wallet")) && ok;
  await page.keyboard.press("Escape");
  await page.selectOption("select#country", "NG");
  await page.locator("button.tile", { hasText: "Airtime" }).click();
  for (const [loc, label] of [[page.getByRole("button", { name: "Use test number" }), "use test number"], [page.locator("#phone"), "phone"], [page.locator("button.chip", { hasText: "₦200" }), "₦200 chip"], [page.getByRole("button", { name: "Continue to pay" }), "continue"]]) ok = (await check(loc, label)) && ok;
  await goHome(page, "fr");
  await page.selectOption("select#country", "SN");
  await page.locator("button.tile", { hasText: "Électricité" }).click();
  for (const [loc, label] of [[page.locator("#meter"), "meter"], [page.locator("#phone"), "phone (fr)"], [page.locator("button.chip", { hasText: "2" }).filter({ hasText: "000" }), "2 000 chip"], [page.getByRole("button", { name: "Continuer vers le paiement" }), "continuer"]]) ok = (await check(loc, label)) && ok;
  await ctx.close();
  console.log(ok ? "REHEARSAL PASSED" : "REHEARSAL FAILED");
  if (!ok) process.exitCode = 1;
}

async function record(browser, name) {
  const dir = path.join(OUT, `.raw-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  const ctx = await browser.newContext({
    viewport: REC,
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 1,
    recordVideo: { dir, size: REC },
    ...(name !== "wallet" && fs.existsSync(STATE) ? { storageState: STATE } : {}),
  });
  await ctx.addInitScript(zoomBody, ZOOM);
  const page = await ctx.newPage();
  const s = makeSession(page, name);
  let error = null;
  try {
    await SEGMENTS[name](page, s);
    if (name === "wallet") await ctx.storageState({ path: STATE });
  } catch (err) {
    error = err;
  }
  await ctx.close();
  const src = await page.video().path();
  const dest = path.join(OUT, `${name}.webm`);
  fs.copyFileSync(src, dest);
  fs.writeFileSync(path.join(OUT, `${name}.clicks.json`), JSON.stringify(s.clicks, null, 2));
  if (error) throw new Error(`segment ${name} failed: ${error.message} (partial clip kept at ${dest})`);
  console.log(`recorded ${name}: ${dest} (${s.clicks.length} events)`);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  // Headed, so WebGL (the 3D lock) uses the GPU: headless renders it on the CPU and starves input.
  const browser = await chromium.launch({ headless: process.env.HEADLESS === "1", args: [`--window-size=${REC.width + 40},${REC.height + 80}`, "--window-position=20,0"] });
  try {
    if (REHEARSE) return await rehearse(browser);
    const names = process.argv.slice(2).filter((a) => !a.startsWith("--"));
    for (const name of names.length ? names : Object.keys(SEGMENTS)) await record(browser, name);
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error(`DEMO ERROR: ${err.message}`);
  process.exit(1);
});
