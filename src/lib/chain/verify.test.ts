import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { DEMO_MERCHANT, DEMO_PAYER, PROGRAM_ID, USDC_MINT } from "./escrow.ts";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  DISCRIMINATOR,
  TOKEN_PROGRAM_ID,
  USDC_MINT_PUBKEY,
  ataAddress,
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
  decodeReleaseArgs,
  decodeSplTransferAmount,
  idlLock,
  verifyLedgerShotTx,
  type CompiledInstruction,
  type TokenBalanceRow,
  type VerifyClaim,
} from "./verify.ts";

const jobId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const hash = "11".repeat(32);
const amount = 100_000;
const amountText = String(amount);

const payer = new PublicKey(DEMO_PAYER);
const merchant = new PublicKey(DEMO_MERCHANT);
const job = jobPda(payer, parseJobId(jobId)).address;
const jobAddress = job.toBase58();
const vault = vaultAddress(job).toBase58();
const payerAta = ataAddress(payer).toBase58();
const merchantAta = ataAddress(merchant).toBase58();
const mint = USDC_MINT_PUBKEY.toBase58();
const tokenProgram = TOKEN_PROGRAM_ID.toBase58();
const associatedProgram = ASSOCIATED_TOKEN_PROGRAM_ID.toBase58();
const systemProgram = SystemProgram.programId.toBase58();

function claim(instruction: VerifyClaim["instruction"], extra: Partial<VerifyClaim> = {}): VerifyClaim {
  return {
    instruction,
    jobId,
    payer: DEMO_PAYER,
    merchant: DEMO_MERCHANT,
    amountAtomic: amountText,
    ...(instruction === "release" ? { outputHash: hash } : {}),
    ...extra,
  };
}

function ledgerIx(
  instruction: VerifyClaim["instruction"],
  data?: Uint8Array,
  accounts?: string[],
): CompiledInstruction {
  let ixAccounts: string[];
  let ixData: Uint8Array;

  if (instruction === "init_job") {
    ixAccounts = [
      DEMO_MERCHANT,
      DEMO_PAYER,
      mint,
      jobAddress,
      vault,
      tokenProgram,
      associatedProgram,
      systemProgram,
    ];
    ixData = encodeInitJobData({
      jobId: parseJobId(jobId),
      amountAtomic: amount,
      deadlineUnix: 1_800_000_000,
      specHash: hexToBytes(hash),
      expectedHash: hexToBytes(hash),
    });
  } else if (instruction === "sync_funded") {
    ixAccounts = [DEMO_PAYER, jobAddress, mint, vault];
    ixData = DISCRIMINATOR.sync_funded;
  } else if (instruction === "release") {
    ixAccounts = [DEMO_MERCHANT, jobAddress, mint, vault, merchantAta, tokenProgram];
    ixData = encodeReleaseData(hexToBytes(hash));
  } else {
    ixAccounts = [
      DEMO_MERCHANT,
      jobAddress,
      DEMO_PAYER,
      mint,
      vault,
      payerAta,
      tokenProgram,
    ];
    ixData = DISCRIMINATOR.refund;
  }

  return {
    programId: PROGRAM_ID,
    accounts: accounts ?? ixAccounts,
    data: data ?? ixData,
  };
}

function transferIx(
  source: string,
  destination: string,
  authority: string,
  inner: boolean,
  transferAmount = amount,
  parentIndex?: number,
): CompiledInstruction {
  return {
    programId: tokenProgram,
    accounts: [source, destination, authority],
    data: Uint8Array.from([3, ...u64le(transferAmount)]),
    inner,
    ...(parentIndex === undefined ? {} : { parentIndex }),
  };
}

function row(account: string, owner: string, value: string): TokenBalanceRow {
  return { account, mint, owner, amount: value };
}

function ataCreateIx(ata: string, owner: string): CompiledInstruction {
  return {
    programId: associatedProgram,
    accounts: [
      DEMO_PAYER,
      ata,
      owner,
      mint,
      systemProgram,
      tokenProgram,
    ],
    data: Uint8Array.of(1),
  };
}

describe("independent transaction verification", () => {
  it("locks the checked-in IDL to the configured program, mint, and discriminators", () => {
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
    assert.equal(lock.discriminators.refund, bytesToHex(DISCRIMINATOR.refund));
  });

  it("decodes instruction arguments and rejects malformed lengths", () => {
    const initData = encodeInitJobData({
      jobId: parseJobId(jobId),
      amountAtomic: amount,
      deadlineUnix: 1_800_000_000,
      specHash: hexToBytes(hash),
      expectedHash: hexToBytes(hash),
    });
    const releaseData = encodeReleaseData(hexToBytes(hash));

    assert.equal(decodeProgramIx(initData), "init_job");
    assert.equal(decodeInitJobArgs(initData)?.jobId, jobId);
    assert.equal(decodeInitJobArgs(initData)?.amountAtomic, amountText);
    assert.equal(decodeInitJobArgs(initData.slice(0, -1)), null);

    assert.equal(decodeProgramIx(releaseData), "release");
    assert.equal(decodeReleaseArgs(releaseData)?.outputHash, hash);
    assert.equal(decodeReleaseArgs(Uint8Array.from([...releaseData, 0])), null);

    assert.equal(decodeSplTransferAmount(Uint8Array.from([3, ...u64le(amount)])), amountText);
    assert.equal(decodeSplTransferAmount(Uint8Array.from([3, ...u64le(amount), 0])), null);
    assert.equal(atomicText(amount), amountText);
    assert.throws(() => atomicText(Number.MAX_SAFE_INTEGER + 1));
    assert.throws(() => atomicText(-1));
    assert.throws(() => atomicText("1.5"));
    assert.throws(() => atomicText("-1"));
  });

  it("accepts init_job only with the exact eight-account layout and configured mint", () => {
    const result = verifyLedgerShotTx(
      claim("init_job"),
      [ledgerIx("init_job")],
      { pre: [], post: [] },
      null,
    );

    assert.equal(result.chainOk, true);
    assert.equal(result.programOk, true);
    assert.equal(result.mintOk, true);
    assert.equal(result.amountOk, true);
    assert.equal(result.accountsOk, true);
    assert.equal(result.amountAtomic, amountText);
  });

  it("rejects init_job with a wrong mint, missing account, duplicate program instruction, or transaction error", () => {
    const good = ledgerIx("init_job");

    const wrongMint = [...good.accounts];
    wrongMint[2] = DEMO_PAYER;
    const badMintResult = verifyLedgerShotTx(
      claim("init_job"),
      [ledgerIx("init_job", good.data, wrongMint)],
      { pre: [], post: [] },
      null,
    );
    assert.equal(badMintResult.chainOk, false);
    assert.equal(badMintResult.mintOk, false);

    const missingAccountResult = verifyLedgerShotTx(
      claim("init_job"),
      [ledgerIx("init_job", good.data, good.accounts.slice(0, -1))],
      { pre: [], post: [] },
      null,
    );
    assert.equal(missingAccountResult.chainOk, false);
    assert.equal(missingAccountResult.accountsOk, false);

    const duplicateResult = verifyLedgerShotTx(
      claim("init_job"),
      [good, good],
      { pre: [], post: [] },
      null,
    );
    assert.equal(duplicateResult.chainOk, false);
    assert.equal(duplicateResult.programOk, false);

    const injectedCpiResult = verifyLedgerShotTx(
      claim("init_job"),
      [good, { ...good, inner: true, parentIndex: 0 }],
      { pre: [], post: [] },
      null,
    );
    assert.equal(injectedCpiResult.chainOk, false);
    assert.equal(injectedCpiResult.programOk, false);

    const erroredResult = verifyLedgerShotTx(
      claim("init_job"),
      [good],
      { pre: [], post: [] },
      { InstructionError: [0, { Custom: 6006 }] },
    );
    assert.equal(erroredResult.chainOk, false);
  });

  it("accepts sync_funded only when payer USDC is transferred into the job vault", () => {
    const ixs = [
      transferIx(payerAta, vault, DEMO_PAYER, false),
      ledgerIx("sync_funded"),
    ];
    const token = {
      pre: [
        row(payerAta, DEMO_PAYER, "200000"),
        row(vault, jobAddress, "0"),
      ],
      post: [
        row(payerAta, DEMO_PAYER, "100000"),
        row(vault, jobAddress, amountText),
      ],
    };

    const result = verifyLedgerShotTx(claim("sync_funded"), ixs, token, null);
    assert.equal(result.chainOk, true);
    assert.equal(result.amountOk, true);
    assert.equal(result.mintOk, true);
    assert.equal(result.accountsOk, true);
  });

  it("rejects sync_funded when the transfer source, authority, amount, or balance delta is wrong", () => {
    const token = {
      pre: [
        row(payerAta, DEMO_PAYER, "200000"),
        row(vault, jobAddress, "0"),
      ],
      post: [
        row(payerAta, DEMO_PAYER, "100000"),
        row(vault, jobAddress, amountText),
      ],
    };

    const wrongSource = verifyLedgerShotTx(
      claim("sync_funded"),
      [
        transferIx(merchantAta, vault, DEMO_PAYER, false),
        ledgerIx("sync_funded"),
      ],
      token,
      null,
    );
    assert.equal(wrongSource.chainOk, false);

    const wrongAuthority = verifyLedgerShotTx(
      claim("sync_funded"),
      [
        transferIx(payerAta, vault, DEMO_MERCHANT, false),
        ledgerIx("sync_funded"),
      ],
      token,
      null,
    );
    assert.equal(wrongAuthority.chainOk, false);

    const wrongAmount = verifyLedgerShotTx(
      claim("sync_funded"),
      [
        transferIx(payerAta, vault, DEMO_PAYER, false, amount - 1),
        ledgerIx("sync_funded"),
      ],
      token,
      null,
    );
    assert.equal(wrongAmount.chainOk, false);

    const wrongDelta = verifyLedgerShotTx(
      claim("sync_funded"),
      [
        transferIx(payerAta, vault, DEMO_PAYER, false),
        ledgerIx("sync_funded"),
      ],
      {
        pre: token.pre,
        post: [
          row(payerAta, DEMO_PAYER, "150000"),
          row(vault, jobAddress, "50000"),
        ],
      },
      null,
    );
    assert.equal(wrongDelta.chainOk, false);
  });

  it("accepts release only when the vault pays the merchant ATA with the claimed hash", () => {
    const result = verifyLedgerShotTx(
      claim("release"),
      [
        ledgerIx("release"),
        transferIx(vault, merchantAta, jobAddress, true, amount, 0),
      ],
      {
        pre: [
          row(vault, jobAddress, amountText),
          row(merchantAta, DEMO_MERCHANT, "0"),
        ],
        post: [
          row(vault, jobAddress, "0"),
          row(merchantAta, DEMO_MERCHANT, amountText),
        ],
      },
      null,
    );

    assert.equal(result.chainOk, true);
    assert.equal(result.amountOk, true);
    assert.equal(result.accountsOk, true);
  });

  it("rejects release to a different recipient, with a different hash, or without a valid recipient ATA", () => {
    const balances = {
      pre: [
        row(vault, jobAddress, amountText),
        row(merchantAta, DEMO_MERCHANT, "0"),
      ],
      post: [
        row(vault, jobAddress, "0"),
        row(merchantAta, DEMO_MERCHANT, amountText),
      ],
    };

    const wrongRecipient = verifyLedgerShotTx(
      claim("release"),
      [
        ledgerIx("release"),
        transferIx(vault, payerAta, jobAddress, true, amount, 0),
      ],
      balances,
      null,
    );
    assert.equal(wrongRecipient.chainOk, false);

    const wrongHash = verifyLedgerShotTx(
      claim("release", { outputHash: "22".repeat(32) }),
      [
        ledgerIx("release"),
        transferIx(vault, merchantAta, jobAddress, true, amount, 0),
      ],
      balances,
      null,
    );
    assert.equal(wrongHash.chainOk, false);

    const missingAta = verifyLedgerShotTx(
      claim("release"),
      [
        ledgerIx("release"),
        transferIx(vault, merchantAta, jobAddress, true, amount, 0),
      ],
      {
        pre: [row(vault, jobAddress, amountText)],
        post: [
          row(vault, jobAddress, "0"),
          row(merchantAta, DEMO_MERCHANT, amountText),
        ],
      },
      null,
    );
    assert.equal(missingAta.chainOk, false);
  });

  it("accepts release when the recipient ATA is created idempotently in the same transaction", () => {
    const result = verifyLedgerShotTx(
      claim("release"),
      [
        ataCreateIx(merchantAta, DEMO_MERCHANT),
        ledgerIx("release"),
        transferIx(vault, merchantAta, jobAddress, true, amount, 1),
      ],
      {
        pre: [row(vault, jobAddress, amountText)],
        post: [
          row(vault, jobAddress, "0"),
          row(merchantAta, DEMO_MERCHANT, amountText),
        ],
      },
      null,
    );

    assert.equal(result.chainOk, true);
  });

  it("accepts refund only when the vault pays the payer ATA", () => {
    const result = verifyLedgerShotTx(
      claim("refund"),
      [
        ledgerIx("refund"),
        transferIx(vault, payerAta, jobAddress, true, amount, 0),
      ],
      {
        pre: [
          row(vault, jobAddress, amountText),
          row(payerAta, DEMO_PAYER, "0"),
        ],
        post: [
          row(vault, jobAddress, "0"),
          row(payerAta, DEMO_PAYER, amountText),
        ],
      },
      null,
    );

    assert.equal(result.chainOk, true);
    assert.equal(result.amountOk, true);
    assert.equal(result.accountsOk, true);
  });

  it("rejects refund to a different destination or with a mismatched token owner", () => {
    const wrongDestination = verifyLedgerShotTx(
      claim("refund"),
      [
        ledgerIx("refund"),
        transferIx(vault, merchantAta, jobAddress, true, amount, 0),
      ],
      {
        pre: [
          row(vault, jobAddress, amountText),
          row(payerAta, DEMO_PAYER, "0"),
        ],
        post: [
          row(vault, jobAddress, "0"),
          row(payerAta, DEMO_PAYER, amountText),
        ],
      },
      null,
    );
    assert.equal(wrongDestination.chainOk, false);

    const wrongOwner = verifyLedgerShotTx(
      claim("refund"),
      [
        ledgerIx("refund"),
        transferIx(vault, payerAta, jobAddress, true, amount, 0),
      ],
      {
        pre: [
          row(vault, jobAddress, amountText),
          row(payerAta, DEMO_MERCHANT, "0"),
        ],
        post: [
          row(vault, jobAddress, "0"),
          row(payerAta, DEMO_MERCHANT, amountText),
        ],
      },
      null,
    );
    assert.equal(wrongOwner.chainOk, false);
  });

  it("rejects SPL transfers placed at the wrong instruction level", () => {
    const wrongSyncLevel = verifyLedgerShotTx(
      claim("sync_funded"),
      [
        transferIx(payerAta, vault, DEMO_PAYER, true),
        ledgerIx("sync_funded"),
      ],
      {
        pre: [
          row(payerAta, DEMO_PAYER, "200000"),
          row(vault, jobAddress, "0"),
        ],
        post: [
          row(payerAta, DEMO_PAYER, "100000"),
          row(vault, jobAddress, amountText),
        ],
      },
      null,
    );
    assert.equal(wrongSyncLevel.chainOk, false);

    const wrongReleaseLevel = verifyLedgerShotTx(
      claim("release"),
      [
        transferIx(vault, merchantAta, jobAddress, false),
        ledgerIx("release"),
      ],
      {
        pre: [
          row(vault, jobAddress, amountText),
          row(merchantAta, DEMO_MERCHANT, "0"),
        ],
        post: [
          row(vault, jobAddress, "0"),
          row(merchantAta, DEMO_MERCHANT, amountText),
        ],
      },
      null,
    );
    assert.equal(wrongReleaseLevel.chainOk, false);

    const wrongRefundLevel = verifyLedgerShotTx(
      claim("refund"),
      [
        transferIx(vault, payerAta, jobAddress, false),
        ledgerIx("refund"),
      ],
      {
        pre: [
          row(vault, jobAddress, amountText),
          row(payerAta, DEMO_PAYER, "0"),
        ],
        post: [
          row(vault, jobAddress, "0"),
          row(payerAta, DEMO_PAYER, amountText),
        ],
      },
      null,
    );
    assert.equal(wrongRefundLevel.chainOk, false);
  });

  it("rejects duplicate token balance rows and missing source balance evidence", () => {
    const duplicateRows = verifyLedgerShotTx(
      claim("sync_funded"),
      [
        transferIx(payerAta, vault, DEMO_PAYER, false),
        ledgerIx("sync_funded"),
      ],
      {
        pre: [
          row(payerAta, DEMO_PAYER, "200000"),
          row(payerAta, DEMO_PAYER, "200000"),
          row(vault, jobAddress, "0"),
        ],
        post: [
          row(payerAta, DEMO_PAYER, "100000"),
          row(vault, jobAddress, amountText),
        ],
      },
      null,
    );
    assert.equal(duplicateRows.chainOk, false);

    const missingSource = verifyLedgerShotTx(
      claim("sync_funded"),
      [
        transferIx(payerAta, vault, DEMO_PAYER, false),
        ledgerIx("sync_funded"),
      ],
      {
        pre: [row(vault, jobAddress, "0")],
        post: [row(vault, jobAddress, amountText)],
      },
      null,
    );
    assert.equal(missingSource.chainOk, false);
  });
});
