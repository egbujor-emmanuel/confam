import { describe, expect, it } from "vitest";
import { classifyVtpass, extractToken, extractTransactionId, extractUnits } from "../src/vtpass/classify.ts";

// Response bodies copied from VTpass documentation examples.
const deliveredAirtime = {
  code: "000",
  content: { transactions: { status: "delivered", transactionId: "17415980564672211596777904" } },
  response_description: "TRANSACTION SUCCESSFUL",
  purchased_code: "",
};
const deliveredPrepaid = {
  code: "000",
  content: { transactions: { status: "delivered", extras: "Token : 26362054405982757802" } },
  purchased_code: "Token : 26362054405982757802",
  token: "Token : 26362054405982757802",
  units: "79.9 kWh",
};

describe("classifyVtpass", () => {
  it("treats code 000 + delivered as delivered", () => {
    expect(classifyVtpass(deliveredAirtime).outcome).toBe("delivered");
  });

  it("treats code 000 + initiated/pending as pending (never settles early)", () => {
    for (const status of ["initiated", "pending"]) {
      expect(classifyVtpass({ code: "000", content: { transactions: { status } } }).outcome).toBe("pending");
    }
  });

  it("treats code 000 with a missing status as pending", () => {
    expect(classifyVtpass({ code: "000" }).outcome).toBe("pending");
  });

  it("treats explicit failure codes as failed", () => {
    for (const code of ["016", "091", "018", "013", "017", "040", "030"]) {
      expect(classifyVtpass({ code }).outcome, code).toBe("failed");
    }
  });

  it("treats code 000 + failed/reversed status as failed", () => {
    expect(classifyVtpass({ code: "000", content: { transactions: { status: "failed" } } }).outcome).toBe("failed");
    expect(classifyVtpass({ code: "000", content: { transactions: { status: "reversed" } } }).outcome).toBe("failed");
  });

  it("treats processing / unclear codes as pending (VTpass: unclear => requery)", () => {
    for (const code of ["099", "089", "044", "001", "014", "083", "999"]) {
      expect(classifyVtpass({ code }).outcome, code).toBe("pending");
    }
  });

  it("treats empty, null and non-object bodies as pending (timeout/no response)", () => {
    expect(classifyVtpass(null).outcome).toBe("pending");
    expect(classifyVtpass(undefined).outcome).toBe("pending");
    expect(classifyVtpass("<html>502</html>").outcome).toBe("pending");
    expect(classifyVtpass({}).outcome).toBe("pending");
  });

  it("never treats requery code 015 (request not found) as a failure; the deadline releases it", () => {
    // A lagging or replicated provider can say "not found" for a request it later delivers.
    expect(classifyVtpass({ code: "015" }, { secondsSincePay: 5 }).outcome).toBe("pending");
    expect(classifyVtpass({ code: "015" }, { secondsSincePay: 25 }).outcome).toBe("pending");
    expect(classifyVtpass({ code: "015" }, { secondsSincePay: 600 }).outcome).toBe("pending");
  });

  it("accepts numeric codes defensively", () => {
    expect(classifyVtpass({ code: 16 }).outcome).toBe("failed");
  });
});

describe("extractors", () => {
  it("extracts and groups a prepaid electricity token", () => {
    expect(extractToken(deliveredPrepaid)).toBe("2636 2054 4059 8275 7802");
  });

  it("falls back to transactions.extras for the token (requery shape)", () => {
    expect(extractToken({ content: { transactions: { extras: "Token : 26362054405982757802" } } })).toBe(
      "2636 2054 4059 8275 7802",
    );
  });

  it("returns null when there is no token (airtime/data)", () => {
    expect(extractToken(deliveredAirtime)).toBeNull();
    expect(extractToken({ purchased_code: "N/A" })).toBeNull();
  });

  it("extracts units and transaction id", () => {
    expect(extractUnits(deliveredPrepaid)).toBe("79.9 kWh");
    expect(extractUnits({ units: "N/A" })).toBeNull();
    expect(extractTransactionId(deliveredAirtime)).toBe("17415980564672211596777904");
  });
});
