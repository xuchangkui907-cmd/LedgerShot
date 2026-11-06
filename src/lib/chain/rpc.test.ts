import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifySignatureStatus } from "./rpc.ts";

describe("Solana signature status classification", () => {
  it("treats a missing status as unknown", () => {
    assert.equal(classifySignatureStatus(null), "unknown");
  });

  it("does not treat processed as confirmed", () => {
    assert.equal(
      classifySignatureStatus({ err: null, confirmationStatus: "processed" }),
      "unknown",
    );
  });

  it("treats confirmed as confirmed", () => {
    assert.equal(
      classifySignatureStatus({ err: null, confirmationStatus: "confirmed" }),
      "confirmed",
    );
  });

  it("treats finalized as confirmed", () => {
    assert.equal(
      classifySignatureStatus({ err: null, confirmationStatus: "finalized" }),
      "confirmed",
    );
  });

  it("treats an on-chain error as failed regardless of confirmation level", () => {
    assert.equal(
      classifySignatureStatus({
        err: { InstructionError: [0, "Custom"] },
        confirmationStatus: "confirmed",
      }),
      "failed",
    );
  });

  it("does not treat an unrecognized status as confirmed", () => {
    assert.equal(
      classifySignatureStatus({ err: null, confirmationStatus: null }),
      "unknown",
    );
  });
});
