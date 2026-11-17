import { useCallback, useEffect, useRef, useState } from "react";
import { savedWalletUrl, walletBalanceSats } from "./wallet.ts";

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia("(prefers-reduced-motion: reduce)").matches : false,
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = (): void => setReduced(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}

export function useHashRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash || "#/");
  useEffect(() => {
    const on = (): void => {
      setHash(window.location.hash || "#/");
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

export const navigate = (hash: string): void => {
  window.location.hash = hash;
};

/** Live wallet balance (polls while mounted). Lets users SEE sats lock and come back. */
export function useWalletBalance(intervalMs = 3000): {
  connected: boolean;
  balance: number | null;
  refresh: () => void;
  reconnect: () => void;
} {
  const [connected, setConnected] = useState(() => Boolean(savedWalletUrl()));
  const [balance, setBalance] = useState<number | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(() => {
    if (!savedWalletUrl()) {
      setConnected(false);
      setBalance(null);
      return;
    }
    setConnected(true);
    walletBalanceSats()
      .then((b) => alive.current && setBalance(b))
      .catch(() => {
        /* transient relay hiccup: keep last value */
      });
  }, []);

  useEffect(() => {
    alive.current = true;
    refresh();
    const t = setInterval(refresh, intervalMs);
    const onChange = (): void => refresh();
    window.addEventListener("confam:wallet", onChange);
    return () => {
      alive.current = false;
      clearInterval(t);
      window.removeEventListener("confam:wallet", onChange);
    };
  }, [refresh, intervalMs]);

  return { connected, balance, refresh, reconnect: () => window.dispatchEvent(new Event("confam:wallet")) };
}
