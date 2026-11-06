import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { PublicKey } from "@solana/web3.js";
import {
  ANCHOR_ERROR,
  DISCRIMINATOR,
  JOB_ACCOUNT_SIZE,
  JOB_ACCOUNT_DISCRIMINATOR,
  ataAddress,
  bytesToHex,
  buildRefundIx,
  decodeJobAccount,
  encodeInitJobData,
  encodeReleaseData,
  hexToBytes,
  i64le,
  jobPda,
  mapProgramError,
  parseJobId,
  statusFromU8,
  u64le,
} from "./onchain.ts";
import { DEMO_MERCHANT, DEMO_PAYER, PROGRAM_ID, USDC_MINT } from "./escrow.ts";

function disc(name: string): string {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8).toString("hex");
}

describe("on-chain encoding", () => {
  it("locks Anchor discriminators to sha256(global:<ix>)[:8]", () => {
    assert.equal(bytesToHex(DISCRIMINATOR.init_job), disc("init_job"));
    assert.equal(bytesToHex(DISCRIMINATOR.sync_funded), disc("sync_funded"));
    assert.equal(bytesToHex(DISCRIMINATOR.release), disc("release"));
    assert.equal(bytesToHex(DISCRIMINATOR.refund), disc("refund"));
  });

  it("encodes init_job as 104 bytes and release as 40 bytes", () => {
    const jobId = parseJobId("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const hash = hexToBytes("11".repeat(32));
    const data = encodeInitJobData({
      jobId,
      amountAtomic: 100_000,
      deadlineUnix: 1_800_000_000,
      specHash: hash,
      expectedHash: hash,
    });
    assert.equal(data.length, 8 + 16 + 8 + 8 + 32 + 32);
    assert.equal(bytesToHex(data.subarray(0, 8)), disc("init_job"));
    assert.equal(bytesToHex(encodeReleaseData(hash)), disc("release") + "11".repeat(32));
    assert.deepEqual([...u64le(100_000)], [160, 134, 1, 0, 0, 0, 0, 0]);
    assert.equal(i64le(-1)[0], 255);
  });

  it("derives a deterministic job PDA and vault ATA", () => {
    const payer = new PublicKey(DEMO_PAYER);
    const jobId = parseJobId("11111111111111111111111111111111");
    const first = jobPda(payer, jobId);
    const second = jobPda(payer, jobId);
    assert.equal(first.address.toBase58(), second.address.toBase58());
    assert.equal(first.address.toBase58().length >= 32, true);
    const vault = ataAddress(first.address);
    assert.notEqual(vault.toBase58(), first.address.toBase58());
    assert.equal(new PublicKey(PROGRAM_ID).toBase58(), PROGRAM_ID);
    assert.equal(new PublicKey(USDC_MINT).toBase58(), USDC_MINT);
  });

  it("round-trips a Job account and maps program errors", () => {
    const payer = new PublicKey(DEMO_PAYER);
    const merchant = new PublicKey(DEMO_MERCHANT);
    const mint = new PublicKey(USDC_MINT);
    const data = new Uint8Array(JOB_ACCOUNT_SIZE);
    data.set(JOB_ACCOUNT_DISCRIMINATOR, 0);
    let offset = 8;
    data.set(payer.toBuffer(), offset); offset += 32;
    data.set(merchant.toBuffer(), offset); offset += 32;
    data.set(mint.toBuffer(), offset); offset += 32;
    data.set(u64le(100_000), offset); offset += 8;
    data.set(parseJobId("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"), offset); offset += 16;
    data.set(i64le(1_800_000_000), offset); offset += 8;
    data.set(hexToBytes("22".repeat(32)), offset); offset += 32;
    data.set(hexToBytes("33".repeat(32)), offset); offset += 32;
    data.set(hexToBytes("44".repeat(32)), offset); offset += 32;
    data[offset] = 1;
    const expectedPda = jobPda(payer, parseJobId("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"));
    data[offset + 1] = expectedPda.bump;
    const job = decodeJobAccount(data, expectedPda.address);
    assert.equal(job.payer, DEMO_PAYER);
    assert.equal(job.merchant, DEMO_MERCHANT);
    assert.equal(job.amountAtomic, "100000");
    assert.equal(job.jobId, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    assert.equal(job.deadlineUnix, 1_800_000_000);
    assert.equal(job.status, "funded");
    assert.equal(job.expectedHash, "44".repeat(32));

    const wrongDiscriminator = Uint8Array.from(data);
    wrongDiscriminator[0] ^= 0xff;
    assert.throws(
      () => decodeJobAccount(wrongDiscriminator, expectedPda.address),
      /discriminator/i,
    );

    assert.throws(
      () => decodeJobAccount(data.subarray(0, data.length - 1), expectedPda.address),
      /exactly/i,
    );

    assert.throws(
      () => decodeJobAccount(new Uint8Array(JOB_ACCOUNT_SIZE + 1), expectedPda.address),
      /exactly/i,
    );

    assert.throws(
      () => decodeJobAccount(data, PublicKey.default),
      /PDA/i,
    );

    const wrongBump = Uint8Array.from(data);
    wrongBump[JOB_ACCOUNT_SIZE - 1] = (expectedPda.bump + 1) & 0xff;
    assert.throws(
      () => decodeJobAccount(wrongBump, expectedPda.address),
      /bump/i,
    );

    const wrongMint = Uint8Array.from(data);
    wrongMint.set(PublicKey.default.toBuffer(), 8 + 32 + 32);
    assert.throws(
      () => decodeJobAccount(wrongMint, expectedPda.address),
      /mint/i,
    );

    const largeAmount = Uint8Array.from(data);
    largeAmount.set(u64le(9_007_199_254_740_992n), 8 + 32 + 32 + 32);
    assert.equal(
      decodeJobAccount(largeAmount, expectedPda.address).amountAtomic,
      "9007199254740992",
    );

    assert.equal(statusFromU8(2), "released");
    assert.equal(mapProgramError(["Program failed: custom program error: 0x1776"], null).code, "HASH_MISMATCH");
    assert.equal(ANCHOR_ERROR[6006]?.code, "HASH_MISMATCH");

    const unknownFailure = mapProgramError(
      ["Program failed: custom program error: 0xdead"],
      { InstructionError: [0, "Custom"] },
    );
    assert.equal(unknownFailure.code, "CHAIN_TX_FAILED");
    assert.match(unknownFailure.message, /confirmed as failed on chain/i);
  });
});

describe("refund instruction signer requirements", () => {
  const merchant = new PublicKey(DEMO_MERCHANT);
  const payer = new PublicKey(DEMO_PAYER);
  const job = new PublicKey(PROGRAM_ID);
  const vault = new PublicKey(USDC_MINT);
  const payerAta = new PublicKey("11111111111111111111111111111111");

  it("requires merchant signature before the deadline", () => {
    const ix = buildRefundIx({
      merchant,
      merchantMustSign: true,
      payer,
      job,
      vault,
      payerAta,
    });

    assert.equal(ix.keys[0].pubkey.toBase58(), merchant.toBase58());
    assert.equal(ix.keys[0].isSigner, true);
    assert.equal(ix.keys[0].isWritable, false);
  });

  it("does not require merchant signature after the deadline", () => {
    const ix = buildRefundIx({
      merchant,
      merchantMustSign: false,
      payer,
      job,
      vault,
      payerAta,
    });

    assert.equal(ix.keys[0].pubkey.toBase58(), merchant.toBase58());
    assert.equal(ix.keys[0].isSigner, false);
    assert.equal(ix.keys[0].isWritable, false);
  });
});