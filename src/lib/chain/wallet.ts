import { PublicKey, Transaction } from "@solana/web3.js";
import { recordDiagnostic, recordDiagnosticError } from "./diagnostics.ts";

export type PhantomProvider = {
  isPhantom?: boolean;
  publicKey: PublicKey | null;
  isConnected?: boolean;
  connect: (opts?: { onlyIfTrusted?: boolean }) => Promise<{ publicKey: PublicKey }>;
  disconnect: () => Promise<void>;
  signAndSendTransaction: (
    transaction: Transaction,
    opts?: { skipPreflight?: boolean },
  ) => Promise<{ signature: string }>;
  signTransaction: (transaction: Transaction) => Promise<Transaction>;
  on: (event: "connect" | "disconnect" | "accountChanged", handler: (pubkey?: PublicKey | null) => void) => void;
  off?: (event: "connect" | "disconnect" | "accountChanged", handler: (pubkey?: PublicKey | null) => void) => void;
};

declare global {
  interface Window {
    solana?: PhantomProvider;
    phantom?: { solana?: PhantomProvider };
  }
}

export function getPhantom(): PhantomProvider | null {
  if (typeof window === "undefined") return null;
  const provider = window.phantom?.solana ?? window.solana;
  if (!provider?.isPhantom) return null;
  return provider;
}

export async function connectPhantom(): Promise<string> {
  const provider = getPhantom();
  if (!provider) {
    throw new Error("Phantom is not installed in this browser.");
  }
  const result = await provider.connect();
  return result.publicKey.toBase58();
}

export async function disconnectPhantom(): Promise<void> {
  const provider = getPhantom();
  if (provider?.isConnected) await provider.disconnect();
}

export async function sendWithWallet(tx: Transaction): Promise<string> {
  const provider = getPhantom();
  if (!provider?.publicKey) {
    throw new Error("Connect Phantom before sending a transaction.");
  }
  tx.feePayer = provider.publicKey;
  recordDiagnostic("PHANTOM_PROVIDER", "success", {
    detected: true,
    isPhantom: provider.isPhantom === true,
    isConnected: provider.isConnected ?? null,
    publicKey: provider.publicKey.toBase58(),
  });
  recordDiagnostic("PHANTOM_SEND", "start", {
    method: "signAndSendTransaction",
    skipPreflight: false,
    feePayer: tx.feePayer.toBase58(),
    recentBlockhash: tx.recentBlockhash ?? null,
    instructionCount: tx.instructions.length,
    programs: tx.instructions.map((ix) => ix.programId.toBase58()),
    accountKeys: tx.instructions.flatMap((ix) => ix.keys.map((key) => ({
      pubkey: key.pubkey.toBase58(), signer: key.isSigner, writable: key.isWritable,
    }))),
  });
  try {
    const result = await provider.signAndSendTransaction(tx, { skipPreflight: false });
    if (!result.signature) throw new Error("Wallet did not return a signature.");
    recordDiagnostic("PHANTOM_SEND", "success", { signature: result.signature });
    return result.signature;
  } catch (error) {
    recordDiagnosticError("PHANTOM_SEND", error);
    throw error;
  }
}

export function walletPubkey(): PublicKey | null {
  const provider = getPhantom();
  return provider?.publicKey ?? null;
}
