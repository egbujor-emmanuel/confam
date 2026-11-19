// Phase 1 (discover): list the visible interactive elements on each page of the demo flow.
const { chromium } = require(process.env.PW_CORE);
const BASE = "https://confam-qxdh.onrender.com";
const dump = (page) => page.evaluate(() => Array.from(document.querySelectorAll("input, select, textarea, button, a[href]"))
  .filter((el) => el.offsetParent !== null)
  .map((el) => `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${el.className && typeof el.className === "string" ? "." + el.className.split(" ").join(".") : ""} "${(el.textContent || el.getAttribute("aria-label") || el.placeholder || "").trim().slice(0, 40)}"${el.tagName === "SELECT" ? " options=" + Array.from(el.options).map((o) => o.value).slice(0, 8).join(",") : ""}${el.href ? " -> " + el.getAttribute("href") : ""}`));
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 430, height: 932 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  for (const hash of ["#/", "#/buy/airtime", "#/buy/electricity"]) {
    await p.goto(BASE + "/" + hash);
    await p.waitForTimeout(2500);
    console.log(`\n== ${hash}\n  ` + (await dump(p)).join("\n  "));
  }
  await p.goto(BASE + "/#/");
  await p.waitForTimeout(1500);
  await p.locator(".wallet-chip").click();
  await p.waitForTimeout(800);
  console.log("\n== wallet sheet\n  " + (await dump(p)).join("\n  "));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
