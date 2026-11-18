import { CanvasTexture, Color, CylinderGeometry, Group, Mesh, MeshStandardMaterial, SRGBColorSpace, TorusGeometry, type Texture } from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

/** Brand palette shared by the live lock and the rendered icons. */
export const PALETTE = {
  forest: "#0f4a37",
  forestDeep: "#0b3d2e",
  lime: "#c6f135",
  steel: "#d9e2dc",
  goldEdge: "#d99a1e",
  amber: "#f59e0b",
} as const;

/** Gold sats coin face with a milled ring and the Lightning bolt. */
export function coinFaceTexture(): Texture {
  const size = 512;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  if (!g) return new CanvasTexture(c);
  const mid = size / 2;
  const grad = g.createRadialGradient(mid * 0.8, mid * 0.7, 20, mid, mid, mid);
  grad.addColorStop(0, "#ffe08a");
  grad.addColorStop(0.55, "#f0b429");
  grad.addColorStop(1, "#b7791f");
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  g.strokeStyle = "rgba(90, 55, 5, 0.55)";
  g.lineWidth = 10;
  g.beginPath();
  g.arc(mid, mid, mid * 0.82, 0, Math.PI * 2);
  g.stroke();
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2;
    g.fillStyle = "rgba(90, 55, 5, 0.35)";
    g.beginPath();
    g.arc(mid + Math.cos(a) * mid * 0.9, mid + Math.sin(a) * mid * 0.9, 4, 0, Math.PI * 2);
    g.fill();
  }
  g.fillStyle = PALETTE.forestDeep;
  g.beginPath();
  g.moveTo(mid + 30, mid - 150);
  g.lineTo(mid - 70, mid + 20);
  g.lineTo(mid - 5, mid + 20);
  g.lineTo(mid - 35, mid + 150);
  g.lineTo(mid + 75, mid - 25);
  g.lineTo(mid + 10, mid - 25);
  g.closePath();
  g.fill();
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export interface LockModel {
  rig: Group;
  shackle: Group;
  shacklePivot: Group;
  coinHolder: Group;
  coin: Mesh;
  glowMat: MeshStandardMaterial;
  faceMat: MeshStandardMaterial;
  edgeMat: MeshStandardMaterial;
  faceTex: Texture;
}

/** The payment lock: forest body, state-coloured keyhole, steel shackle, gold coin under the arch. */
export function buildLock(): LockModel {
  const rig = new Group();

  const bodyMat = new MeshStandardMaterial({ color: PALETTE.forest, metalness: 0.55, roughness: 0.38 });
  const body = new Mesh(new RoundedBoxGeometry(1.7, 1.25, 0.5, 6, 0.14), bodyMat);
  body.position.y = -0.75;
  rig.add(body);

  const glowMat = new MeshStandardMaterial({
    color: PALETTE.lime,
    emissive: new Color(PALETTE.lime),
    emissiveIntensity: 1.4,
    metalness: 0.2,
    roughness: 0.3,
  });
  const keyhole = new Mesh(new TorusGeometry(0.17, 0.05, 16, 48), glowMat);
  keyhole.position.set(0, -0.72, 0.26);
  rig.add(keyhole);

  const steel = new MeshStandardMaterial({ color: PALETTE.steel, metalness: 1, roughness: 0.22 });
  const shackle = new Group();
  const arc = new Mesh(new TorusGeometry(0.58, 0.11, 20, 64, Math.PI), steel);
  const legGeo = new CylinderGeometry(0.11, 0.11, 0.55, 20);
  const legL = new Mesh(legGeo, steel);
  const legR = new Mesh(legGeo, steel);
  legL.position.set(-0.58, -0.27, 0);
  legR.position.set(0.58, -0.27, 0);
  shackle.add(arc, legL, legR);
  const shacklePivot = new Group();
  shacklePivot.position.set(0.58, -0.15, 0);
  shackle.position.set(-0.58, 0, 0);
  shacklePivot.add(shackle);
  rig.add(shacklePivot);

  const faceTex = coinFaceTexture();
  const edgeMat = new MeshStandardMaterial({ color: PALETTE.goldEdge, metalness: 0.8, roughness: 0.3 });
  const faceMat = new MeshStandardMaterial({ map: faceTex, metalness: 0.5, roughness: 0.34 });
  const coin = new Mesh(new CylinderGeometry(0.42, 0.42, 0.09, 96), [edgeMat, faceMat, faceMat]);
  coin.rotation.x = Math.PI / 2;
  const coinHolder = new Group();
  coinHolder.position.set(0, 0.2, 0);
  coinHolder.add(coin);
  rig.add(coinHolder);

  return { rig, shackle, shacklePivot, coinHolder, coin, glowMat, faceMat, edgeMat, faceTex };
}
