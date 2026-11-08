export type AuditReceipt = {
  verified: boolean;
  issues: string[];
  status: string;
};

export type BannerTone = "ok" | "warn" | "danger";

const EXPLICIT_REJECT = new Set(["unverified", "failed", "missing"]);

/**
 * Chain confirmation and the audit log are different facts.
 * A confirmed init_job must still land in Open jobs when the log table is down.
 * An explicit verification reject must not move the desk.
 */
export function gateLiveStep(input: {
  chainOk: boolean;
  chainText: string;
  recorded: AuditReceipt;
  instruction: string;
  signature: string | null;
  explorerUrl: string | null;
}): { applyLocal: boolean; tone: BannerTone; text: string } {
  const issue = input.recorded.issues.find((item) => item.length > 0);
  const proof = [input.signature, input.explorerUrl].filter(Boolean).join(" ");

  if (!input.chainOk) {
    return {
      applyLocal: false,
      tone: "danger",
      text: [input.chainText, issue].filter(Boolean).join(" · "),
    };
  }

  if (input.recorded.verified) {
    const next =
      input.instruction === "init_job"
        ? " Job is in Open jobs. The vault stays at 0 USDC until Fund escrow."
        : "";
    return {
      applyLocal: true,
      tone: "ok",
      text: `Server independently verified ${input.instruction}.${next} ${proof}`.trim(),
    };
  }

  if (EXPLICIT_REJECT.has(input.recorded.status)) {
    return {
      applyLocal: false,
      tone: "danger",
      text: `Chain reported ${input.instruction}, but independent verification rejected it${issue ? `: ${issue}` : "."} Desk was not updated. ${proof}`.trim(),
    };
  }

  const next =
    input.instruction === "init_job"
      ? " The job is in Open jobs and selected. A 0 USDC vault is expected until Fund escrow."
      : " Local books follow the confirmed transaction.";
  return {
    applyLocal: true,
    tone: "warn",
    text: `${input.chainText} Audit log is not stored yet${issue ? ` (${issue})` : ""}.${next} ${proof}`.trim(),
  };
}
