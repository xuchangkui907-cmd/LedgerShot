import type { Sku } from "./escrow.ts";

/** Canonical brief commitment. Stable bytes, no timestamps. */
export function specText(input: {
  sku: Sku;
  title: string;
  brief: string;
  priceAtomic: number;
}): string {
  return `ledger-shot/v1|${input.sku}|${input.title}|${input.brief}|${input.priceAtomic}`;
}

export function deliverableText(input: { sku: Sku; title: string; brief: string }): string {
  return input.sku === "still" ? stillSvg(input.title, input.brief) : dubSheet(input.title, input.brief);
}

export function tamperedText(body: string): string {
  return `${body}\nTAMPER`;
}

export function stillSvg(title: string, brief: string): string {
  const t = xml(title).slice(0, 42);
  const b = xml(brief).slice(0, 96);
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640" viewBox="0 0 640 640">`,
    `<rect width="640" height="640" fill="#101614"/>`,
    `<rect x="48" y="48" width="544" height="544" fill="#17211c" stroke="#d7a35a" stroke-width="4"/>`,
    `<text x="80" y="140" fill="#d7a35a" font-size="22" font-family="monospace">LEDGERSHOT STILL</text>`,
    `<text x="80" y="320" fill="#e8f0ea" font-size="42" font-family="sans-serif">${t}</text>`,
    `<text x="80" y="390" fill="#93a59a" font-size="20" font-family="sans-serif">${b}</text>`,
    `</svg>`,
  ].join("\n");
}

export function dubSheet(title: string, brief: string): string {
  return [
    "LEDGERSHOT DUB SHEET",
    `title: ${title}`,
    `brief: ${brief}`,
    "lanes: EN | ES",
    "duration: 15s",
    "music: none",
  ].join("\n");
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function xml(value: string): string {
  const amp = "\u0026amp;";
  const lt = "\u0026lt;";
  const gt = "\u0026gt;";
  const quot = "\u0026quot;";
  return value.replaceAll("&", amp).replaceAll("<", lt).replaceAll(">", gt).replaceAll('"', quot);
}
