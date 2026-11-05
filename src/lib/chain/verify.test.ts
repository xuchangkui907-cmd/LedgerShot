import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { PublicKey } from "@solana/web3.js";
import { DEMO_MERCHANT, DEMO_PAYER, PROGRAM_ID, USDC_MINT } from "./escrow.ts";
import {
  DISCRIMINATOR,
  TOKEN_PROGRAM_ID,
  bytesToHex,
  encodeInitJobData,
  encodeReleaseData,
  hexToBytes,
  jobPda,
  parseJobId,
  u64le,
  vaultAddress,
} from "./onchain.ts";
import {
  atomicText,
  decodeInitJobArgs,
  decodeProgramIx,
  idlLock,
  verifyLedgerShotTx,
} from "./verify.ts";

const jobId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const hash = "11".repeat(32);

describe("independent tx verification", () => {
  it("locks the checked-in IDL to the program id, mint, and discriminators", () => {
    const idl = JSON.parse(readFileSync(new URL("./idl.json", import.meta.url), "utf8")) as {
      address: string;
      mint: string;
      discriminators: Record<string, string>;
    };
    const lock = idlLock();
    assert.equal(idl.address, PROGRAM_ID);
    assert.equal(idl.mint, USDC_MINT);
    assert.equal(idl.discriminators.init_job, bytesToHex(DISCRIMINATOR.init_job));
    assert.equal(lock.address, idl.address);
    assert.equal(lock.mint, idl.mint);
  });

  it("decodes init_job args without trusting the client claim", () => {
    const data = encodeInitJobData({
      jobId: parseJobId(jobId),
      amountAtomic: 100_000,
      deadlineUnix: 1_800_000_000,
      specHash: hexToBytes(hash),
      expectedHash: hexToBytes(hash),
    });
    assert.equal(decodeProgramIx(data), "init_job");
    const args = decodeInitJobArgs(data);
    assert.equal(args?.jobId, jobId);
    assert.equal(args?.amountAtomic, "100000");
    assert.equal(atomicText(100_000), "100000");
  });

  it("accepts a well-formed init_job and rejects a wrong program or mint", () => {
    const payer = new PublicKey(DEMO_PAYER);
    const job = jobPda(payer, parseJobId(jobId)).address;
    const vault = vaultAddress(job);
    const data = encodeInitJobData({
      jobId: parseJobId(jobId),
      amountAtomic: 100_000,
      deadlineUnix: 1_800_000_000,
      specHash: hexToBytes(hash),
      expectedHash: hexToBytes(hash),
    });
    const good = verifyLedgerShotTx(
      {
        instruction: "init_job",
        jobId,
        payer: DEMO_PAYER,
        merchant: DEMO_MERCHANT,
        amountAtomic: "100000",
      },
      [
        {
          programId: PROGRAM_ID,
          accounts: [
            DEMO_MERCHANT,
            DEMO_PAYER,
            USDC_MINT,
            job.toBase58(),
            vault.toBase58(),
            TOKEN_PROGRAM_ID.toBase58(),
          ],
          data,
        },
      ],
      { pre: [], post: [] },
      null,
    );
    assert.equal(good.chainOk, true);
    assert.equal(good.programOk, true);
    assert.equal(good.mintOk, true);

    const wrongProgram = verifyLedgerShotTx(
      {
        instruction: "init_job",
        jobId,
        payer: DEMO_PAYER,
        merchant: DEMO_MERCHANT,
        amountAtomic: "100000",
      },
      [{ programId: TOKEN_PROGRAM_ID.toBase58(), accounts: [USDC_MINT], data }],
      { pre: [], post: [] },
      null,
    );
    assert.equal(wrongProgram.chainOk, false);
    assert.equal(wrongProgram.programOk, false);

    const wrongMint = verifyLedgerShotTx(
      {
        instruction: "init_job",
        jobId,
        payer: DEMO_PAYER,
        merchant: DEMO_MERCHANT,
        amountAtomic: "100000",
      },
      [
        {
          programId: PROGRAM_ID,
          accounts: [DEMO_MERCHANT, DEMO_PAYER, DEMO_PAYER, job.toBase58()],
          data,
        },
      ],
      { pre: [], post: [] },
      null,
    );
    assert.equal(wrongMint.mintOk, false);
    assert.equal(wrongMint.chainOk, false);
  });

  it("treats a program error as not chain-ok even if accounts parse", () => {
    const payer = new PublicKey(DEMO_PAYER);
    const job = jobPda(payer, parseJobId(jobId)).address;
    const data = encodeReleaseData(hexToBytes(hash));
    const result = verifyLedgerShotTx(
      {
        instruction: "release",
        jobId,
        payer: DEMO_PAYER,
        merchant: DEMO_MERCHANT,
        amountAtomic: "100000",
        outputHash: hash,
      },
      [
        {
          programId: PROGRAM_ID,
          accounts: [DEMO_MERCHANT, job.toBase58(), USDC_MINT, vaultAddress(job).toBase58()],
          data,
        },
      ],
      { pre: [], post: [] },
      { InstructionError: [0, { Custom: 6006 }] },
    );
    assert.equal(result.chainOk, false);
    assert.ok(result.issues.some((issue) => /error/i.test(issue)));
  });

  it("requires an exact USDC transfer into the vault for sync_funded", () => {
    const payer = new PublicKey(DEMO_PAYER);
    const job = jobPda(payer, parseJobId(jobId)).address;
    const vault = vaultAddress(job).toBase58();
    const result = verifyLedgerShotTx(
      {
        instruction: "sync_funded",
        jobId,
        payer: DEMO_PAYER,
        merchant: DEMO_MERCHANT,
        amountAtomic: "100000",
      },
      [
        {
          programId: TOKEN_PROGRAM_ID.toBase58(),
          accounts: ["source", vault, DEMO_PAYER],
          data: Uint8Array.from([3, ...u64le(100_000)]),
        },
        {
          programId: PROGRAM_ID,
          accounts: [DEMO_PAYER, job.toBase58(), USDC_MINT, vault],
          data: DISCRIMINATOR.sync_funded,
        },
      ],
      {
        pre: [{ account: vault, mint: USDC_MINT, owner: job.toBase58(), amount: "0" }],
        post: [{ account: vault, mint: USDC_MINT, owner: job.toBase58(), amount: "100000" }],
      },
      null,
    );
    assert.equal(result.chainOk, true);
    assert.equal(result.amountOk, true);
  });
});
