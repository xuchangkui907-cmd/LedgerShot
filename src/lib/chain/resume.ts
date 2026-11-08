import { PublicKey } from "@solana/web3.js";
import { PROGRAM_ID, type ChainJob } from "./escrow.ts";
import type { OnchainJob } from "./onchain.ts";
import { fetchCompiledTx, fetchJob, getConnection } from "./rpc.ts";
import { decodeInitJobArgs, decodeProgramIx } from "./verify.ts";

export function chainJobFromAccount(
  job: OnchainJob,
  meta?: Partial<Pick<ChainJob, "sku" | "title" | "brief">>,
): ChainJob {
  const price = Number(job.amountAtomic);
  if (!Number.isSafeInteger(price)) {
    throw new Error("On-chain amount does not fit a safe integer.");
  }
  return {
    id: job.jobId,
    sku: meta?.sku ?? "still",
    title: meta?.title?.trim() || `Devnet job ${job.jobId.slice(0, 8)}`,
    brief:
      meta?.brief?.trim() ||
      "Recovered from the Job PDA. Amount, hashes, and status come from the account.",
    priceAtomic: price,
    deadlineUnix: job.deadlineUnix,
    status: job.status,
    specHash: job.specHash,
    expectedHash: job.expectedHash,
    outputHash: job.status === "released" ? job.outputHash : "",
    payer: job.payer,
    merchant: job.merchant,
  };
}

export async function loadJobById(payer: string, jobId: string): Promise<OnchainJob> {
  const job = await fetchJob(new PublicKey(payer), jobId);
  if (!job) throw new Error("No Job PDA for that payer and job id.");
  return job;
}

export async function loadJobBySignature(signature: string): Promise<OnchainJob> {
  const compiled = await fetchCompiledTx(signature.trim());
  if (compiled.missing) {
    throw new Error("Devnet RPC has no transaction for that signature yet. Paste the 32-hex job id, or retry in a few seconds.");
  }
  const init =
    compiled.ixs.find((ix) => ix.programId === PROGRAM_ID && decodeProgramIx(ix.data) === "init_job" && !ix.inner) ??
    compiled.ixs.find((ix) => ix.programId === PROGRAM_ID && decodeProgramIx(ix.data) === "init_job");
  if (!init) throw new Error("That transaction does not contain init_job.");
  const args = decodeInitJobArgs(init.data);
  if (!args) throw new Error("init_job arguments could not be decoded.");
  const payer = init.accounts[1];
  if (!payer) throw new Error("init_job is missing the payer account.");
  const job = await fetchJob(new PublicKey(payer), args.jobId);
  if (!job) throw new Error("Signature decoded, but the Job PDA is not on chain.");
  return job;
}

export async function loadRecentJobs(merchant: string, limit = 8): Promise<OnchainJob[]> {
  const signatures = await getConnection().getSignaturesForAddress(new PublicKey(merchant), { limit });
  const found: OnchainJob[] = [];
  const seen = new Set<string>();
  for (const row of signatures) {
    if (row.err) continue;
    try {
      const job = await loadJobBySignature(row.signature);
      if (job.merchant !== merchant || seen.has(job.jobId)) continue;
      seen.add(job.jobId);
      found.push(job);
    } catch {
      // Signature is not an init_job. Keep scanning.
    }
  }
  return found;
}
