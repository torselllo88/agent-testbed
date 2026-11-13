import { createHash } from "node:crypto";
import type { ExperimentRecord } from "../persistence/experimentRepository.js";
import type { ExposureDetectionRecord } from "../persistence/exposureRepository.js";
import { parseCsvObjects, toCsv } from "./csv.js";
import { EXPOSURE_LABELS, type ExposureLabel, type ExposureResult } from "./exposure.js";

/**
 * What comes out of exposure detection: per-run and per-proposition CSVs for
 * analysis, a blind sample for manual labeling, and the agreement between
 * manual and detector labels (the detector's validation).
 */

export interface RunWithExposure {
  run: ExperimentRecord;
  detection: ExposureDetectionRecord | null;
}

const resultOf = (d: ExposureDetectionRecord | null) => (d ? (d.result as ExposureResult) : null);
const metric = (run: ExperimentRecord) => (run.summary ?? {}) as {
  proposals?: { first?: { outcome?: string; classification?: string | null } | null };
  topology?: { type?: string } | null;
};

/** One row per run: outcome next to the proposer's exposure at the decision horizon. */
export function exposureRunsCsv(entries: RunWithExposure[]): string {
  const header = [
    "batch_id",
    "experiment_id",
    "condition_key",
    "task_definition_hash",
    "topology",
    "outcome",
    "first_proposal_outcome",
    "first_proposal_class",
    "detector_version",
    "facts_hash",
    "labeled_messages",
    "unlabeled_messages",
    "facts_total",
    "facts_correct",
    "facts_distorted",
    "facts_conflicting",
    "facts_absent",
    "derived_total",
    "derived_correct",
    "derived_distorted",
    "derived_conflicting",
    "derived_absent",
    "solution_relay",
  ];
  const rows = entries.map(({ run, detection }) => {
    const r = resultOf(detection);
    const s = r?.summary;
    const m = metric(run);
    return [
      run.batchId,
      run.id,
      run.conditionKey,
      run.taskDefinitionHash,
      m.topology?.type,
      run.outcome,
      m.proposals?.first?.outcome,
      m.proposals?.first?.classification,
      detection?.detectorVersion,
      detection?.factsHash,
      s?.labeledMessages,
      s?.unlabeledMessages,
      s?.proposerFacts.total,
      s?.proposerFacts.correct,
      s?.proposerFacts.distorted,
      s?.proposerFacts.conflicting,
      s?.proposerFacts.absent,
      s?.proposerDerived.total,
      s?.proposerDerived.correct,
      s?.proposerDerived.distorted,
      s?.proposerDerived.conflicting,
      s?.proposerDerived.absent,
      s?.solutionRelay,
    ];
  });
  return toCsv([header, ...rows]);
}

/** One row per run × proposition: the proposer's exposure class and when the first correct mention reached it. */
export function exposureFactsCsv(entries: RunWithExposure[]): string {
  const header = ["batch_id", "experiment_id", "condition_key", "task_definition_hash", "fact_id", "kind", "source", "proposer_class", "first_correct_turn", "first_correct_from"];
  const rows = entries.flatMap(({ run, detection }) => {
    const r = resultOf(detection);
    if (!r) return [];
    return r.facts.map((f) => {
      const e = r.summary.proposer[f.id]!;
      return [run.batchId, run.id, run.conditionKey, run.taskDefinitionHash, f.id, f.kind, f.source, e.class, e.firstCorrectTurn, e.firstCorrectFrom];
    });
  });
  return toCsv([header, ...rows]);
}

export const LABELING_HEADER = ["experiment_id", "message_id", "sender", "message", "fact_id", "kind", "statement", "human_label", "notes"];

/**
 * A blind sample for manual labeling: n messages drawn with a seed from the
 * labeled runs, one row per message × proposition, the human_label column
 * empty — the detector's labels are not in the file.
 */
export function labelingSampleCsv(entries: RunWithExposure[], n: number, seed: number): string {
  const pool = entries.flatMap(({ run, detection }) => {
    const r = resultOf(detection);
    return r ? r.messages.map((m) => ({ run, r, m })) : [];
  });
  const ranked = pool
    .map((item) => ({ item, key: createHash("sha256").update(`${seed}:${item.run.id}:${item.m.messageId}`).digest("hex") }))
    .sort((a, b) => a.key.localeCompare(b.key))
    .slice(0, n)
    .map((x) => x.item);
  const rows = ranked.flatMap(({ run, r, m }) => r.facts.map((f) => [run.id, m.messageId, m.senderId, m.text, f.id, f.kind, f.statement, "", ""]));
  return toCsv([LABELING_HEADER, ...rows]);
}

export interface AgreementReport {
  /** Pairs compared: rows with a human label and a detector label. */
  n: number;
  /** Rows with a human label the detector has no label for (no pass, an unlabeled message, an unknown id). */
  unmatched: number;
  /** Share of identical labels. */
  observed: number | null;
  /** Cohen's kappa over the three labels (null: undefined, e.g. one label only). */
  kappa: number | null;
  /** confusion[human][detector]. */
  confusion: Record<ExposureLabel, Record<ExposureLabel, number>>;
  /** Per label, the detector measured against the human labels. */
  perLabel: Record<ExposureLabel, { precision: number | null; recall: number | null; support: number }>;
  byKind: Record<string, { n: number; observed: number | null; kappa: number | null }>;
  disagreements: Array<{ experimentId: string; messageId: string; factId: string; human: ExposureLabel; detector: ExposureLabel }>;
}

/** Reads a filled-in labeling file and compares it with the detector's labels (the latest pass of each run). */
export function agreementFromCsv(text: string, detectionOf: (experimentId: string) => ExposureDetectionRecord | null): AgreementReport {
  const pairs: Array<{ human: ExposureLabel; detector: ExposureLabel; kind: string; experimentId: string; messageId: string; factId: string }> = [];
  let unmatched = 0;
  for (const row of parseCsvObjects(text)) {
    const human = row.human_label?.trim().toLowerCase();
    if (!human) continue;
    if (!(EXPOSURE_LABELS as readonly string[]).includes(human)) throw new Error(`human_label "${row.human_label}" is not one of ${EXPOSURE_LABELS.join(", ")} (message ${row.message_id}, ${row.fact_id})`);
    const r = resultOf(detectionOf(row.experiment_id ?? ""));
    const detector = r?.messages.find((m) => m.messageId === row.message_id)?.labels?.[row.fact_id ?? ""]?.label;
    if (!detector) {
      unmatched += 1;
      continue;
    }
    const kind = r!.facts.find((f) => f.id === row.fact_id)?.kind ?? row.kind ?? "unknown";
    pairs.push({ human: human as ExposureLabel, detector, kind, experimentId: row.experiment_id!, messageId: row.message_id!, factId: row.fact_id! });
  }
  const kinds = [...new Set(pairs.map((p) => p.kind))];
  return {
    ...agreement(pairs),
    unmatched,
    byKind: Object.fromEntries(kinds.map((k) => [k, (({ n, observed, kappa }) => ({ n, observed, kappa }))(agreement(pairs.filter((p) => p.kind === k)))])),
    disagreements: pairs.filter((p) => p.human !== p.detector).map(({ kind: _kind, ...rest }) => rest),
  };
}

export function agreement(pairs: Array<{ human: ExposureLabel; detector: ExposureLabel }>): Omit<AgreementReport, "unmatched" | "byKind" | "disagreements"> {
  const zero = () => Object.fromEntries(EXPOSURE_LABELS.map((l) => [l, 0])) as Record<ExposureLabel, number>;
  const confusion = Object.fromEntries(EXPOSURE_LABELS.map((l) => [l, zero()])) as Record<ExposureLabel, Record<ExposureLabel, number>>;
  for (const p of pairs) confusion[p.human][p.detector] += 1;
  const n = pairs.length;
  const agree = EXPOSURE_LABELS.reduce((s, l) => s + confusion[l][l], 0);
  const human = (l: ExposureLabel) => EXPOSURE_LABELS.reduce((s, d) => s + confusion[l][d], 0);
  const detector = (l: ExposureLabel) => EXPOSURE_LABELS.reduce((s, h) => s + confusion[h][l], 0);
  const observed = n ? agree / n : null;
  const expected = n ? EXPOSURE_LABELS.reduce((s, l) => s + (human(l) / n) * (detector(l) / n), 0) : null;
  const kappa = observed !== null && expected !== null && expected < 1 ? (observed - expected) / (1 - expected) : null;
  const perLabel = Object.fromEntries(
    EXPOSURE_LABELS.map((l) => [l, { precision: detector(l) ? confusion[l][l] / detector(l) : null, recall: human(l) ? confusion[l][l] / human(l) : null, support: human(l) }])
  ) as AgreementReport["perLabel"];
  return { n, observed, kappa, confusion, perLabel };
}
