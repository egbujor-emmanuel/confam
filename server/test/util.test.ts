import { describe, expect, it } from "vitest";
import { hashOfPreimage, newPreimagePair } from "../src/lightning/crypto.ts";
import { localToSats } from "../src/pricing/rates.ts";
import { maskId, maskName } from "../src/util/mask.ts";
import { acceptPhone, guessNetwork, normalizeNgPhone } from "../src/util/phone.ts";
import { lagosStamp, newRequestId } from "../src/vtpass/requestId.ts";

describe("request id (VTpass rules)", () => {
  it("uses Africa/Lagos (UTC+1) YYYYMMDDHHII", () => {
    // 23:30 UTC on Nov 17 is 00:30 on Nov 18 in Lagos.
    expect(lagosStamp(new Date("2026-11-17T23:30:00Z"))).toBe("202611180030");
  });

  it("is 12 numeric chars + random suffix, unique per call", () => {
    const now = new Date("2026-11-17T10:05:00Z");
    const a = newRequestId(now);
    const b = newRequestId(now);
    expect(a.slice(0, 12)).toBe("202611171105");
    expect(a).toMatch(/^\d{12}[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
  });
});

describe("localToSats", () => {
  it("converts and always rounds up", () => {
    // ₦1,000 at ₦150,000,000/BTC = 666.67 sats -> 667
    expect(localToSats(1000, 150_000_000)).toBe(667);
  });

  it("returns an exact value without bumping on exact division", () => {
    expect(localToSats(1500, 150_000_000)).toBe(1000);
  });

  it("applies a fee in basis points", () => {
    expect(localToSats(1500, 150_000_000, 100)).toBe(1010);
  });

  it("rejects non-positive input", () => {
    expect(() => localToSats(0, 1)).toThrow();
    expect(() => localToSats(100, 0)).toThrow();
  });
});

describe("phones", () => {
  it("normalises +234 / 234 / spaced input", () => {
    expect(normalizeNgPhone("+234 803 123 4567")).toBe("08031234567");
    expect(normalizeNgPhone("2348031234567")).toBe("08031234567");
    expect(normalizeNgPhone("0803-123-4567")).toBe("08031234567");
  });

  it("rejects invalid numbers", () => {
    expect(normalizeNgPhone("0603 123 4567")).toBeNull();
    expect(normalizeNgPhone("080312345")).toBeNull();
    expect(normalizeNgPhone("abc")).toBeNull();
  });

  it("allows VTpass sandbox magic numbers only in sandbox", () => {
    expect(acceptPhone("201000000000", true)).toBe("201000000000");
    expect(acceptPhone("201000000000", false)).toBeNull();
    expect(acceptPhone("08011111111", false)).toBe("08011111111");
  });

  it("guesses networks from prefixes", () => {
    expect(guessNetwork("08031234567")).toBe("mtn");
    expect(guessNetwork("08021234567")).toBe("airtel");
    expect(guessNetwork("08051234567")).toBe("glo");
    expect(guessNetwork("08091234567")).toBe("etisalat");
    expect(guessNetwork("07025123456")).toBe("mtn");
  });
});

describe("masking", () => {
  it("masks ids and names", () => {
    expect(maskId("08031234567")).toBe("0803****567");
    expect(maskId("1111111111111")).toBe("1111******111");
    expect(maskName("NP NGEMA")).toBe("NP N.");
    expect(maskName(null)).toBeNull();
  });
});

describe("preimage", () => {
  it("hash is sha256(preimage)", () => {
    const p = newPreimagePair();
    expect(p.preimageHex).toMatch(/^[0-9a-f]{64}$/);
    expect(hashOfPreimage(p.preimageHex)).toBe(p.paymentHashHex);
  });
});
