import type { ConfidenceLevel, MigrationAnalysisResult, MigrationContractRecord } from "../types/index.js";

const RANK: Record<ConfidenceLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

export type RecheckOutcome = "notify" | "update" | "unchanged";

/**
 * Compares a re-analysis with the stored detection. Worth a new alert when
 * Token B appeared or the confidence level went up; any other difference
 * (score, matched names) is only saved.
 */
export function recheckOutcome(previous: MigrationContractRecord, next: MigrationAnalysisResult): RecheckOutcome {
  if (next.tokenBAddress && !previous.tokenBAddress) return "notify";
  if (RANK[next.confidence] > RANK[previous.confidence]) return "notify";

  const changed =
    next.confidence !== previous.confidence ||
    next.confidenceScore !== previous.confidenceScore ||
    next.tokenBAddress?.toLowerCase() !== previous.tokenBAddress?.toLowerCase() ||
    next.tokenBSource !== previous.tokenBSource ||
    next.matchedGetter !== previous.matchedGetter ||
    next.matchedFunctions.join() !== previous.matchedFunctions.join() ||
    next.matchedEvents.join() !== previous.matchedEvents.join() ||
    next.matchedAuxiliary.join() !== previous.matchedAuxiliary.join();
  return changed ? "update" : "unchanged";
}
