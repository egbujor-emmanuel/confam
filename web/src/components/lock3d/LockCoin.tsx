import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "../../hooks.ts";
import type { LockCoinScene, LockVisual } from "./scene.ts";

type Props = {
  state: LockVisual;
  label: string;
  className?: string;
};

interface NetworkInformationLike {
  saveData?: boolean;
  effectiveType?: string;
}

/** WebGL 3D only where it is cheap: no data-saver, not 2G, enough memory, WebGL available. */
function canAfford3d(): boolean {
  if (typeof window === "undefined") return false;
  const nav = navigator as Navigator & { connection?: NetworkInformationLike; deviceMemory?: number };
  if (nav.connection?.saveData) return false;
  // The scene loads lazily after first paint, so 3G is fine; only skip it on 2G-class links.
  if (nav.connection?.effectiveType && /^(slow-2g|2g)$/.test(nav.connection.effectiveType)) return false;
  if (typeof nav.deviceMemory === "number" && nav.deviceMemory < 3) return false;
  try {
    const c = document.createElement("canvas");
    return Boolean(c.getContext("webgl2") ?? c.getContext("webgl"));
  } catch {
    return false;
  }
}

/**
 * The payment lock, in 3D. Mirrors the hold invoice: open while waiting, clamped while your sats
 * are locked, opens to send the coin to the merchant on delivery, or back to you on failure.
 * Falls back to a lightweight SVG on slow networks, data-saver, low memory or no WebGL.
 */
export function LockCoin({ state, label, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<LockCoinScene | null>(null);
  const reduced = useReducedMotion();
  const [mode, setMode] = useState<"pending" | "3d" | "svg">("pending");

  useEffect(() => {
    if (!canAfford3d()) {
      setMode("svg");
      return;
    }
    let disposed = false;
    const start = (): void => {
      import("./scene.ts")
        .then(({ createLockCoinScene }) => {
          if (disposed || !canvasRef.current) return;
          sceneRef.current = createLockCoinScene(canvasRef.current, reduced);
          sceneRef.current.setState(state);
          setMode("3d");
        })
        .catch(() => !disposed && setMode("svg"));
    };
    // Load after first paint so the 3D never competes with the page itself.
    const idle = (window as Window & { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
    const handle = idle ? idle(start) : window.setTimeout(start, 200);
    return () => {
      disposed = true;
      if (!idle) window.clearTimeout(handle);
      sceneRef.current?.dispose();
      sceneRef.current = null;
    };
    // The scene is created once; state changes are pushed below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced]);

  useEffect(() => {
    sceneRef.current?.setState(state);
  }, [state]);

  return (
    <div className={`lock3d ${className ?? ""}`} data-mode={mode} data-state={state} role="img" aria-label={label}>
      <canvas ref={canvasRef} aria-hidden="true" />
      {mode !== "3d" && <LockSvg state={state} />}
    </div>
  );
}

function LockSvg({ state }: { state: LockVisual }) {
  return (
    <svg className="lock-svg" viewBox="0 0 200 200" aria-hidden="true">
      <defs>
        <radialGradient id="coinG" cx="40%" cy="35%" r="70%">
          <stop offset="0" stopColor="#ffe08a" />
          <stop offset="0.6" stopColor="#f0b429" />
          <stop offset="1" stopColor="#b7791f" />
        </radialGradient>
      </defs>
      <g className="lock-svg__shackle">
        <path d="M62 112 V78 a38 38 0 0 1 76 0 V112" fill="none" stroke="#d9e2dc" strokeWidth="14" strokeLinecap="round" />
      </g>
      <g className="lock-svg__coin">
        <circle cx="100" cy="86" r="28" fill="url(#coinG)" stroke="#b7791f" strokeWidth="2" />
        <path d="M104 66 L90 88 H99 L95 106 L110 83 H101 Z" fill="#0b3d2e" />
      </g>
      <rect x="44" y="104" width="112" height="78" rx="16" fill="#0f4a37" />
      <circle className="lock-svg__glow" cx="100" cy="142" r="10" fill="none" strokeWidth="5" />
    </svg>
  );
}
