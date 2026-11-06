import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatUsdc } from "./format.ts";

describe("ledger USDC formatting", () => {
  it("formats integer atomic amounts without floating-point conversion", () => {
    assert.equal(formatUsdc(100_000), "0.10 USDC");
    assert.equal(formatUsdc("100000"), "0.10 USDC");
    assert.equal(formatUsdc(1_900_000n), "1.90 USDC");
    assert.equal(formatUsdc(0), "0.00 USDC");
  });

  it("rounds to four decimal places using integer arithmetic", () => {
    assert.equal(formatUsdc("1234567"), "1.2346 USDC");
    assert.equal(formatUsdc("1234549"), "1.2345 USDC");
    assert.equal(formatUsdc("1234550"), "1.2346 USDC");
  });

  it("preserves precision for atomic amounts above Number.MAX_SAFE_INTEGER", () => {
    assert.equal(
      formatUsdc("9007199254740992"),
      "9,007,199,254.741 USDC",
    );
  });

  it("rejects unsafe numbers and malformed integer strings", () => {
    assert.throws(() => formatUsdc(Number.MAX_SAFE_INTEGER + 1), RangeError);
    assert.throws(() => formatUsdc("1.25"), TypeError);
    assert.throws(() => formatUsdc("abc"), TypeError);
  });
});
