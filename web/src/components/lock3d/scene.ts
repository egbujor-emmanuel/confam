import { gsap } from "gsap";
import { Color, Mesh, PerspectiveCamera, NeutralToneMapping, PMREMGenerator, SRGBColorSpace, Scene, WebGLRenderer } from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { buildLock, PALETTE } from "./model.ts";

/** Visual states mirror the payment: the lock IS the hold invoice. */
export type LockVisual = "idle" | "awaiting" | "locked" | "vending" | "completed" | "released" | "expired";

export interface LockCoinScene {
  setState(state: LockVisual): void;
  dispose(): void;
}

const GLOW: Record<LockVisual, string> = {
  idle: PALETTE.lime,
  awaiting: PALETTE.lime,
  locked: "#f59e0b",
  vending: "#f59e0b",
  completed: "#22c55e",
  released: PALETTE.lime,
  expired: "#6b7d75",
};

export function createLockCoinScene(canvas: HTMLCanvasElement, reducedMotion: boolean): LockCoinScene {
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "low-power" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.toneMapping = NeutralToneMapping;
  renderer.outputColorSpace = SRGBColorSpace;

  const scene = new Scene();
  const pmrem = new PMREMGenerator(renderer);
  const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envTex;

  const camera = new PerspectiveCamera(32, 1, 0.1, 50);
  camera.position.set(0, 0.15, 6.2);

  const { rig, shackle, shacklePivot, coinHolder, coin, glowMat, faceMat, edgeMat, faceTex } = buildLock();
  scene.add(rig);

  // Animated values (GSAP tweens these; the render loop reads them).
  const v = { shackleLift: 0.42, shackleSwing: 0.45, coinX: 0, coinY: 0.2, coinZ: 0, coinScale: 1, coinOpacity: 1, spin: 0.6, glow: 1.4 };
  let state: LockVisual = "idle";
  let pointerX = 0;
  let pointerY = 0;
  let visible = true;
  let raf = 0;
  let last = performance.now();
  let t = 0;

  faceMat.transparent = edgeMat.transparent = true;

  const resize = (): void => {
    const parent = canvas.parentElement;
    if (!parent) return;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  if (canvas.parentElement) ro.observe(canvas.parentElement);
  resize();

  const onPointer = (e: PointerEvent): void => {
    const r = canvas.getBoundingClientRect();
    pointerX = ((e.clientX - r.left) / Math.max(1, r.width) - 0.5) * 2;
    pointerY = ((e.clientY - r.top) / Math.max(1, r.height) - 0.5) * 2;
  };
  if (!reducedMotion) window.addEventListener("pointermove", onPointer, { passive: true });

  const io = new IntersectionObserver(([entry]) => {
    visible = Boolean(entry?.isIntersecting);
    if (visible) loop();
  });
  io.observe(canvas);
  const onVis = (): void => {
    if (!document.hidden) loop();
  };
  document.addEventListener("visibilitychange", onVis);

  function frame(now: number): void {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    t += dt;
    shackle.position.y = v.shackleLift;
    shacklePivot.rotation.y = v.shackleSwing;
    const bob = reducedMotion ? 0 : Math.sin(t * 1.6) * 0.04;
    coinHolder.position.set(v.coinX, v.coinY + bob, v.coinZ);
    coinHolder.scale.setScalar(v.coinScale);
    coin.rotation.z += reducedMotion ? 0 : v.spin * dt;
    faceMat.opacity = edgeMat.opacity = v.coinOpacity;
    glowMat.emissiveIntensity = v.glow * (state === "locked" || state === "vending" ? 0.75 + Math.sin(t * 4) * 0.35 : 1);
    rig.rotation.y += ((reducedMotion ? 0 : pointerX * 0.35) + Math.sin(t * 0.4) * 0.08 - rig.rotation.y) * 0.06;
    rig.rotation.x += ((reducedMotion ? 0 : pointerY * 0.12) - rig.rotation.x) * 0.06;
    renderer.render(scene, camera);
  }

  function loop(): void {
    cancelAnimationFrame(raf);
    const tick = (now: number): void => {
      if (!visible || document.hidden) return;
      frame(now);
      if (!reducedMotion) raf = requestAnimationFrame(tick);
    };
    last = performance.now();
    raf = requestAnimationFrame(tick);
  }

  const tweenTo = (target: Partial<typeof v>, duration: number, ease = "power3.out"): gsap.core.Tween =>
    gsap.to(v, { ...target, duration: reducedMotion ? 0 : duration, ease, onUpdate: reducedMotion ? () => frame(performance.now()) : undefined });

  function setState(next: LockVisual): void {
    if (next === state) return;
    state = next;
    gsap.killTweensOf(v);
    const glow = new Color(GLOW[next]);
    glowMat.color.copy(glow);
    glowMat.emissive.copy(glow);
    switch (next) {
      case "idle":
      case "awaiting":
        tweenTo({ shackleLift: 0.42, shackleSwing: 0.45, coinX: 0, coinY: 0.2, coinZ: 0, coinScale: 1, coinOpacity: 1, spin: 0.6, glow: 1.4 }, 0.8);
        break;
      case "locked":
        tweenTo({ coinX: 0, coinY: 0.12, coinZ: 0, coinScale: 1, coinOpacity: 1, spin: 0.15, glow: 1.6 }, 0.4);
        tweenTo({ shackleSwing: 0 }, 0.25).then(() => tweenTo({ shackleLift: 0, glow: 1.8 }, 0.45, "back.out(3)"));
        break;
      case "vending":
        tweenTo({ shackleLift: 0, shackleSwing: 0, coinY: 0.12, spin: 1.4, glow: 1.6 }, 0.4);
        break;
      case "completed":
        // Unlock, then the coin goes to the merchant (delivered first, paid second).
        tweenTo({ shackleLift: 0.42, glow: 2 }, 0.35, "power2.out").then(() => {
          tweenTo({ shackleSwing: 0.45 }, 0.3);
          tweenTo({ coinX: 2.6, coinY: 1.4, coinZ: -1.5, coinScale: 0.6, spin: 9, coinOpacity: 0 }, 0.9, "power2.in");
        });
        break;
      case "released":
        // Unlock, the coin comes back to you: never charged.
        tweenTo({ shackleLift: 0.42, glow: 1.6 }, 0.35, "power2.out").then(() => {
          tweenTo({ shackleSwing: 0.45 }, 0.3);
          tweenTo({ coinZ: 2.2, coinY: -0.25, coinScale: 1.15, spin: 3 }, 0.55, "power2.out").then(() =>
            tweenTo({ coinX: 0, coinY: 0.2, coinZ: 0, coinScale: 1, spin: 0.6 }, 0.9, "elastic.out(1, 0.6)"),
          );
        });
        break;
      case "expired":
        tweenTo({ shackleLift: 0.42, shackleSwing: 0.45, coinOpacity: 0.45, spin: 0.1, glow: 0.4 }, 0.6);
        break;
    }
    loop();
  }

  loop();

  return {
    setState,
    dispose() {
      cancelAnimationFrame(raf);
      gsap.killTweensOf(v);
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pointermove", onPointer);
      scene.traverse((o) => {
        if (o instanceof Mesh) {
          o.geometry.dispose();
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          mats.forEach((m) => m.dispose());
        }
      });
      faceTex.dispose();
      envTex.dispose();
      pmrem.dispose();
      renderer.dispose();
    },
  };
}
