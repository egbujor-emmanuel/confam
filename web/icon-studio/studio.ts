/**
 * Confam icon studio (dev only, never shipped in the app bundle).
 * Renders every brand icon from the SAME three.js lock model the app animates, so the favicon,
 * home-screen icon, category icons and social card are one consistent object.
 *   /icon-studio/?icon=app|maskable|favicon|brand|airtime|data|electricity|og&size=512&format=png|webp|jpeg
 * When done it sets window.__icon to a data URL; icon-studio/render.mjs saves it to web/public.
 */
import "@fontsource/bricolage-grotesque/800.css";
import {
  Color,
  CylinderGeometry,
  DirectionalLight,
  ExtrudeGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  NeutralToneMapping,
  PerspectiveCamera,
  PMREMGenerator,
  SRGBColorSpace,
  Scene,
  Shape,
  WebGLRenderer,
  type Object3D,
} from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { buildLock, coinFaceTexture, PALETTE } from "../src/components/lock3d/model.ts";

type IconKind = "app" | "maskable" | "favicon" | "brand" | "airtime" | "data" | "electricity" | "og";

declare global {
  interface Window {
    __icon?: string;
    __error?: string;
  }
}

const params = new URLSearchParams(location.search);
const kind = (params.get("icon") ?? "app") as IconKind;
const size = Number(params.get("size") ?? 512);
const format = ({ webp: "image/webp", jpeg: "image/jpeg" } as Record<string, string>)[params.get("format") ?? ""] ?? "image/png";
const isOg = kind === "og";
const W = isOg ? 1200 : size;
const H = isOg ? 630 : size;

/** Renders an object with studio lighting onto a transparent canvas of w x h pixels. */
function renderObject(obj: Object3D, w: number, h: number, cam: { fov: number; z: number; y?: number }): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(w, h, false);
  renderer.toneMapping = NeutralToneMapping;
  renderer.outputColorSpace = SRGBColorSpace;
  const scene = new Scene();
  scene.environment = new PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
  const key = new DirectionalLight("#fff6e0", 2.2);
  key.position.set(-3, 4, 5);
  const rim = new DirectionalLight("#c6f135", 1.2);
  rim.position.set(4, 1, -3);
  scene.add(key, rim, obj);
  const camera = new PerspectiveCamera(cam.fov, w / h, 0.1, 50);
  camera.position.set(0, cam.y ?? 0, cam.z);
  camera.lookAt(0, cam.y ?? 0, 0);
  renderer.render(scene, camera);
  return canvas;
}

/** The locked lock, coin clamped in front: "your sats are locked, not sent". */
function lockedLock(): Group {
  const m = buildLock();
  m.shackle.position.y = 0;
  m.shacklePivot.rotation.y = 0;
  m.coinHolder.position.set(0, -0.12, 0.34);
  m.coin.rotation.set(Math.PI / 2, 0, 0);
  m.coinHolder.rotation.set(0.08, -0.25, 0);
  m.coinHolder.scale.setScalar(1.08);
  m.glowMat.emissiveIntensity = 0.55;
  m.rig.rotation.set(0.14, -0.42, 0);
  m.rig.position.y = 0.32;
  return m.rig;
}

function airtimeModel(): Group {
  const g = new Group();
  const body = new Mesh(new RoundedBoxGeometry(0.95, 1.75, 0.16, 6, 0.16), new MeshStandardMaterial({ color: PALETTE.forest, metalness: 0.6, roughness: 0.35 }));
  const screen = new Mesh(
    new RoundedBoxGeometry(0.78, 1.4, 0.04, 4, 0.08),
    new MeshStandardMaterial({ color: "#062019", metalness: 0.2, roughness: 0.08, emissive: new Color(PALETTE.lime), emissiveIntensity: 0.03 }),
  );
  screen.position.z = 0.075;
  const bars = new Group();
  const barMat = new MeshStandardMaterial({ color: PALETTE.lime, emissive: new Color(PALETTE.lime), emissiveIntensity: 0.45 });
  [0.12, 0.2, 0.28].forEach((h, i) => {
    const b = new Mesh(new RoundedBoxGeometry(0.09, h, 0.03, 2, 0.02), barMat);
    b.position.set(-0.13 + i * 0.13, -0.18 + h / 2, 0.1);
    bars.add(b);
  });
  const tex = coinFaceTexture();
  const gold = new Mesh(
    new CylinderGeometry(0.36, 0.36, 0.08, 96),
    [new MeshStandardMaterial({ color: PALETTE.goldEdge, metalness: 1, roughness: 0.3 }), new MeshStandardMaterial({ map: tex, metalness: 0.85, roughness: 0.3 }), new MeshStandardMaterial({ map: tex, metalness: 0.85, roughness: 0.3 })],
  );
  gold.rotation.set(Math.PI / 2, 0, 0);
  const goldHolder = new Group();
  goldHolder.add(gold);
  goldHolder.position.set(0.42, 0.58, 0.3);
  goldHolder.rotation.set(0.2, -0.5, 0.25);
  g.add(body, screen, bars, goldHolder);
  g.rotation.set(0.12, -0.45, 0.12);
  return g;
}

function dataModel(): Group {
  const g = new Group();
  const heights = [0.55, 0.9, 1.25, 1.6];
  const colors = [PALETTE.forest, "#1f7a45", "#6fb52c", PALETTE.lime];
  heights.forEach((h, i) => {
    const mat = new MeshStandardMaterial({ color: colors[i], metalness: 0.45, roughness: 0.32, emissive: new Color(colors[i] ?? PALETTE.lime), emissiveIntensity: i === 3 ? 0.12 : 0 });
    const bar = new Mesh(new RoundedBoxGeometry(0.34, h, 0.34, 4, 0.08), mat);
    bar.position.set(-0.66 + i * 0.44, -0.8 + h / 2, 0);
    g.add(bar);
  });
  g.rotation.set(0.32, -0.55, 0);
  return g;
}

function boltModel(): Group {
  const s = new Shape();
  // Same bolt silhouette as the coin face, in model units.
  const pts: [number, number][] = [
    [0.12, 0.9],
    [-0.42, -0.08],
    [-0.04, -0.08],
    [-0.22, -0.9],
    [0.44, 0.15],
    [0.06, 0.15],
  ];
  s.moveTo(pts[0]![0], pts[0]![1]);
  pts.slice(1).forEach(([x, y]) => s.lineTo(x, y));
  s.closePath();
  const geo = new ExtrudeGeometry(s, { depth: 0.3, bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.06, bevelSegments: 8 });
  geo.center();
  const mat = new MeshStandardMaterial({ color: "#f5b82e", metalness: 0.9, roughness: 0.22, emissive: new Color(PALETTE.amber), emissiveIntensity: 0.08 });
  const bolt = new Mesh(geo, mat);
  const g = new Group();
  g.add(bolt);
  g.rotation.set(0.18, -0.5, -0.08);
  return g;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Lime tile with soft studio light and a contact shadow, then the 3D lock on top. */
function composeAppIcon(out: CanvasRenderingContext2D, rounded: boolean, inset: number): void {
  const s = size;
  out.save();
  if (rounded) {
    roundRect(out, 0, 0, s, s, s * 0.225);
    out.clip();
  }
  const bg = out.createRadialGradient(s * 0.38, s * 0.28, s * 0.05, s * 0.5, s * 0.55, s * 0.8);
  bg.addColorStop(0, "#e2ff6a");
  bg.addColorStop(0.55, PALETTE.lime);
  bg.addColorStop(1, "#93c21a");
  out.fillStyle = bg;
  out.fillRect(0, 0, s, s);
  const shadow = out.createRadialGradient(s * 0.5, s * 0.84, 0, s * 0.5, s * 0.84, s * 0.34);
  shadow.addColorStop(0, "rgba(7, 42, 32, 0.42)");
  shadow.addColorStop(1, "rgba(7, 42, 32, 0)");
  out.fillStyle = shadow;
  out.save();
  out.translate(0, s * 0.84);
  out.scale(1, 0.24);
  out.translate(0, -s * 0.84);
  out.fillRect(0, 0, s, s * 2);
  out.restore();
  const art = Math.round(s * (1 - inset * 2));
  const lock = renderObject(lockedLock(), art * 2, art * 2, { fov: 30, z: 5.6, y: 0.1 });
  out.drawImage(lock, (s - art) / 2, (s - art) / 2, art, art);
  out.restore();
}

async function composeOg(out: CanvasRenderingContext2D): Promise<void> {
  await document.fonts.load('800 80px "Bricolage Grotesque"');
  const bg = out.createRadialGradient(W * 0.72, H * 0.3, 40, W * 0.6, H * 0.5, W * 0.75);
  bg.addColorStop(0, "#14604a");
  bg.addColorStop(0.5, PALETTE.forestDeep);
  bg.addColorStop(1, "#05211a");
  out.fillStyle = bg;
  out.fillRect(0, 0, W, H);
  const lock = renderObject(lockedLock(), 1040, 1040, { fov: 30, z: 5.8, y: 0.1 });
  out.drawImage(lock, W - 600, (H - 520) / 2 - 10, 520, 520);
  out.fillStyle = "#fbf8f1";
  out.font = '800 34px "Bricolage Grotesque"';
  out.fillText("Confam", 72, 104);
  out.font = '800 92px "Bricolage Grotesque"';
  out.fillStyle = "#fbf8f1";
  out.fillText("E no land?", 68, 262);
  out.fillStyle = PALETTE.lime;
  out.fillText("You no pay.", 68, 362);
  out.fillStyle = "rgba(251, 248, 241, 0.82)";
  out.font = '500 30px system-ui, "Segoe UI", sans-serif';
  out.fillText("Pay airtime, data and electricity with Bitcoin,", 72, 444);
  out.fillText("anywhere in Africa. Paid only after delivery.", 72, 486);
  out.fillStyle = "rgba(251, 248, 241, 0.55)";
  out.font = '600 22px system-ui, "Segoe UI", sans-serif';
  out.fillText("Lightning hold invoices · Pas livré ? Pas payé.", 72, 566);
}

async function main(): Promise<void> {
  const out = document.createElement("canvas");
  out.width = W;
  out.height = H;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable");
  switch (kind) {
    case "app":
      composeAppIcon(ctx, false, 0.04);
      break;
    case "maskable":
      composeAppIcon(ctx, false, 0.14); // keeps the art inside the 80% maskable safe zone
      break;
    case "favicon":
    case "brand":
      composeAppIcon(ctx, true, size <= 32 ? -0.06 : 0.02);
      break;
    case "airtime":
      ctx.drawImage(renderObject(airtimeModel(), size, size, { fov: 30, z: 3.9, y: 0.05 }), 0, 0);
      break;
    case "data":
      ctx.drawImage(renderObject(dataModel(), size, size, { fov: 30, z: 3.9, y: -0.05 }), 0, 0);
      break;
    case "electricity":
      ctx.drawImage(renderObject(boltModel(), size, size, { fov: 30, z: 3.6, y: 0 }), 0, 0);
      break;
    case "og":
      await composeOg(ctx);
      break;
  }
  out.style.maxWidth = "100%";
  document.body.append(out);
  window.__icon = out.toDataURL(format, 0.92);
}

main().catch((e: unknown) => {
  window.__error = e instanceof Error ? e.message : String(e);
});
