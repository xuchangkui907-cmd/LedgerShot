import type { Desk } from "./escrow.ts";

const KEY = "ledgershot.desk.v1";

export type StoredDesk = {
  mode: "rehearsal" | "live";
  payer: string;
  merchant: string;
  desk: Desk;
  selected: string | null;
  proofs: Record<string, string>;
};

export function loadStoredDesk(): StoredDesk | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredDesk>;
    if (!parsed.desk || !Array.isArray(parsed.desk.jobs) || !parsed.desk.books) return null;
    return {
      mode: parsed.mode === "live" ? "live" : "rehearsal",
      payer: typeof parsed.payer === "string" ? parsed.payer : "",
      merchant: typeof parsed.merchant === "string" ? parsed.merchant : "",
      desk: parsed.desk,
      selected: typeof parsed.selected === "string" ? parsed.selected : null,
      proofs: parsed.proofs && typeof parsed.proofs === "object" ? parsed.proofs : {},
    };
  } catch {
    return null;
  }
}

export function saveStoredDesk(value: StoredDesk): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    // Private mode can reject the write. The in-memory desk still works.
  }
}
