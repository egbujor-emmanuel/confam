import { createHash, randomBytes } from "node:crypto";

export interface PreimagePair {
  preimageHex: string;
  paymentHashHex: string;
}

/** 32 random bytes; the payment hash is SHA-256(preimage) as in BOLT 11. */
export function newPreimagePair(): PreimagePair {
  const preimage = randomBytes(32);
  return {
    preimageHex: preimage.toString("hex"),
    paymentHashHex: createHash("sha256").update(preimage).digest("hex"),
  };
}

export function hashOfPreimage(preimageHex: string): string {
  return createHash("sha256").update(Buffer.from(preimageHex, "hex")).digest("hex");
}

export const hexToBase64 = (hex: string): string => Buffer.from(hex, "hex").toString("base64");
export const base64ToHex = (b64: string): string => Buffer.from(b64, "base64").toString("hex");
