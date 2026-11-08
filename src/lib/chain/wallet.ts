import { Buffer } from "buffer";
import { PublicKey, Transaction } from "@solana/web3.js";

const root = globalThis as typeof globalThis & { Buffer?: typeof Buffer };
if (!root.Buffer) root.Buffer = Buffer;

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
  const traceId = `wallet-${Date.now()}`;
  const provider = getPhantom();

  const log = (stage: string, detail?: unknown) => {
    console.info("[LedgerShot][Wallet]", {
      traceId,
      time: new Date().toISOString(),
      stage,
      detail,
    });
  };

  log("wallet.send.start", {
    providerFound: !!provider,
    isPhantom: provider?.isPhantom,
    isConnected: provider?.isConnected,
    publicKey: provider?.publicKey?.toBase58() ?? null,
    feePayer: tx.feePayer?.toBase58() ?? null,
    blockhash: tx.recentBlockhash ?? null,
    instructionCount: tx.instructions.length,
    instructions: tx.instructions.map((ix, index) => ({
      index,
      programId: ix.programId.toBase58(),
      accounts: ix.keys.map((key) => ({
        pubkey: key.pubkey.toBase58(),
        isSigner: key.isSigner,
        isWritable: key.isWritable,
      })),
      dataHex: Array.from(ix.data)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
    })),
  });

  if (!provider?.publicKey) {
    log("wallet.missing", {
      providerFound: !!provider,
      publicKey: provider?.publicKey?.toBase58() ?? null,
    });
    throw new Error("Connect Phantom before sending a transaction.");
  }

  tx.feePayer = provider.publicKey;

  try {
    log("phantom.signAndSend.before", {
      feePayer: tx.feePayer.toBase58(),
      blockhash: tx.recentBlockhash,
      skipPreflight: false,
    });

    const startedAt = Date.now();
    const result = await provider.signAndSendTransaction(tx, {
      skipPreflight: false,
    });

    log("phantom.signAndSend.returned", {
      elapsedMs: Date.now() - startedAt,
      resultType: typeof result,
      isNull: result == null,
      resultKeys: result ? Object.keys(result) : [],
      signature: result?.signature ?? null,
      rawResult: result,
    });

    if (!result?.signature) {
      log("phantom.signature.missing", result);
      throw new Error(
        "Phantom returned without a transaction signature. Inspect phantom.signAndSend.returned.",
      );
    }

    log("wallet.signature.received", {
      signature: result.signature,
    });

    return result.signature;
  } catch (error) {
    log("phantom.signAndSend.exception", {
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null,
    });
    throw error;
  }
}
export function walletPubkey(): PublicKey | null {
  const provider = getPhantom();
  return provider?.publicKey ?? null;
}
