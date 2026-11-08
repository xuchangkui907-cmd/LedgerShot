import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gateLiveStep } from "./desk-gate.ts";

const sig = "5".repeat(64);

describe("gateLiveStep", () => {
  it("keeps a confirmed init_job on the desk when the audit table is missing", () => {
    const gate = gateLiveStep({
      chainOk: true,
      chainText: "Confirmed init_job on devnet.",
      recorded: {
        verified: false,
        status: "unavailable",
        issues: ['Audit log was not stored: relation "chain_tx" does not exist'],
      },
      instruction: "init_job",
      signature: sig,
      explorerUrl: "https://explorer.solana.com/tx/example?cluster=devnet",
    });
    assert.equal(gate.applyLocal, true);
    assert.equal(gate.tone, "warn");
    assert.match(gate.text, /Open jobs/);
    assert.match(gate.text, /Fund escrow/);
  });

  it("does not move the desk when verification explicitly rejects the claim", () => {
    const gate = gateLiveStep({
      chainOk: true,
      chainText: "Confirmed sync_funded on devnet.",
      recorded: {
        verified: false,
        status: "unverified",
        issues: ["SPL transfer amount does not equal the quoted amount."],
      },
      instruction: "sync_funded",
      signature: sig,
      explorerUrl: null,
    });
    assert.equal(gate.applyLocal, false);
    assert.equal(gate.tone, "danger");
  });

  it("applies a fully verified init and tells the operator the vault is still empty", () => {
    const gate = gateLiveStep({
      chainOk: true,
      chainText: "Confirmed init_job on devnet.",
      recorded: { verified: true, status: "confirmed", issues: [] },
      instruction: "init_job",
      signature: sig,
      explorerUrl: null,
    });
    assert.equal(gate.applyLocal, true);
    assert.equal(gate.tone, "ok");
    assert.match(gate.text, /0 USDC/);
  });

  it("does not apply when the chain transaction itself failed", () => {
    const gate = gateLiveStep({
      chainOk: false,
      chainText: "Output hash does not match the quote.",
      recorded: { verified: false, status: "failed", issues: [] },
      instruction: "release",
      signature: sig,
      explorerUrl: null,
    });
    assert.equal(gate.applyLocal, false);
    assert.equal(gate.tone, "danger");
  });
});
