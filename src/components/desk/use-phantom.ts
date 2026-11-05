import { useEffect, useState } from "react";
import { connectPhantom, disconnectPhantom, getPhantom } from "@/lib/chain/wallet.ts";

export function usePhantom() {
  const [available, setAvailable] = useState(false);
  const [pubkey, setPubkey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const provider = getPhantom();
    setAvailable(Boolean(provider));
    if (provider?.publicKey) setPubkey(provider.publicKey.toBase58());
    const onConnect = (key?: { toBase58?: () => string } | null) => {
      setPubkey(key?.toBase58?.() ?? provider?.publicKey?.toBase58() ?? null);
    };
    const onDisconnect = () => setPubkey(null);
    provider?.on("connect", onConnect);
    provider?.on("disconnect", onDisconnect);
    provider?.on("accountChanged", onConnect);
    return () => {
      provider?.off?.("connect", onConnect);
      provider?.off?.("disconnect", onDisconnect);
      provider?.off?.("accountChanged", onConnect);
    };
  }, []);

  async function connect() {
    setError(null);
    try {
      const next = await connectPhantom();
      setPubkey(next);
      setAvailable(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Wallet connect failed.");
    }
  }

  async function disconnect() {
    await disconnectPhantom();
    setPubkey(null);
  }

  return { available, pubkey, error, connect, disconnect };
}
