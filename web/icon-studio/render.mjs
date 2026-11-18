// Renders every Confam icon from the icon studio into web/public.
// Usage: start `npx vite --port 5199` in web/, then `node icon-studio/render.mjs`.
// Needs playwright-core (PLAYWRIGHT_CORE=folder if not resolvable) and optionally CHROMIUM_PATH for a specific browser build.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "..", "public");
const base = process.env.STUDIO_URL ?? "http://localhost:5199/icon-studio/";

async function loadChromium() {
  try {
    return (await import("playwright-core")).chromium;
  } catch {
    const path = process.env.PLAYWRIGHT_CORE;
    if (!path) throw new Error("playwright-core not found: set PLAYWRIGHT_CORE to its folder");
    return (await import(pathToFileURL(join(path, "index.mjs")).href)).chromium;
  }
}

/** [output file, icon kind, pixel size, format] */
const JOBS = [
  ["icons/icon-512.png", "app", 512, "png"],
  ["icons/icon-192.png", "app", 192, "png"],
  ["icons/icon-maskable-512.png", "maskable", 512, "png"],
  ["apple-touch-icon.png", "app", 180, "png"],
  ["favicon-32.png", "favicon", 32, "png"],
  ["favicon-16.png", "favicon", 16, "png"],
  ["icons/brand-96.webp", "brand", 96, "webp"],
  ["icons/airtime.webp", "airtime", 168, "webp"],
  ["icons/data.webp", "data", 168, "webp"],
  ["icons/electricity.webp", "electricity", 168, "webp"],
  ["og.jpg", "og", 0, "jpeg"],
];

const chromium = await loadChromium();
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("page error:", e.message));
try {
  for (const [file, icon, size, format] of JOBS) {
    await page.goto(`${base}?icon=${icon}&size=${size}&format=${format}`);
    await page.waitForFunction(() => window.__icon || window.__error, null, { timeout: 30_000 });
    const error = await page.evaluate(() => window.__error);
    if (error) throw new Error(`${file}: ${error}`);
    const dataUrl = await page.evaluate(() => window.__icon);
    const bytes = Buffer.from(dataUrl.split(",")[1], "base64");
    const out = join(publicDir, file);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, bytes);
    console.log(`${file.padEnd(30)} ${(bytes.length / 1024).toFixed(1)} KB`);
  }
} finally {
  await browser.close();
}
