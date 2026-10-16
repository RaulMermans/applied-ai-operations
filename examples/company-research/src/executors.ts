import type { DeterministicExecutor, DeterministicExecutorContext, DeterministicExecutorResult, JsonObject, JsonValue } from "@aao/framework";
import { canonicalizePublicWebUrl, publicWebSourceId } from "@aao/integration-public-web";
import { isRecord, validateCompanyResearchRequest, validateResearchPlan, type CompanyResearchRequest, type EvidenceSummary, type GroundedReport, type ResearchPlan, type ResearchSource, type ResearchSourcePacket } from "./contracts.js";
import { validateCompanyResearchDraft } from "./grounding.js";
import { COMPANY_RESEARCH_LIMITS as L } from "./limits.js";
import { buildPlanningRequest, buildSynthesisRequest } from "./model-requests.js";
import { buildCompanyResearchResult } from "./render.js";

// The deterministic nodes of the Company Research Workflow: trusted host
// code, referenced by exact executorRef. Each one reads a detached copy of
// Run state and proposes a patch; the Runtime validates and applies it.
//
// They are explicit glue on purpose (ADR-027): Tool output → explicit
// executor → next Tool input. There is no expression, template, JSONPath,
// or mapping language. Glue never calls a provider, the network, the
// filesystem, a model, or a Tool: it has no reference to any of them.

/** State keys, in Workflow order. */
export const STATE_KEYS = Object.freeze({
  request: "request",
  researchRequest: "researchRequest",
  planModelRequest: "planModelRequest",
  planResult: "planResult",
  researchPlan: "researchPlan",
  searchInput: "searchInput",
  searchResult: "searchResult",
  dedupeInput: "dedupeInput",
  dedupeResult: "dedupeResult",
  fetchInput: "fetchInput",
  sourceSelection: "sourceSelection",
  fetchResult: "fetchResult",
  projectInput: "projectInput",
  projectResult: "projectResult",
  sourcePacket: "sourcePacket",
  evidenceSummary: "evidenceSummary",
  synthesisModelRequest: "synthesisModelRequest",
  synthesisResult: "synthesisResult",
  groundedReport: "groundedReport",
  researchResult: "researchResult",
});

export const EXECUTOR_VERSION = "1.0.0";
const ok = (statePatch: Record<string, unknown>): DeterministicExecutorResult => ({ ok: true, statePatch: statePatch as JsonObject });
const fail = (code: string): DeterministicExecutorResult => ({ ok: false, code });

type Values = DeterministicExecutorContext["state"]["values"];
/** The `output` of a canonical ToolResult or ModelResult in state, or `undefined`. */
const outputOf = (values: Values, key: string): Record<string, unknown> | undefined => {
  const stored = values[key];
  return isRecord(stored) && isRecord(stored.output) ? stored.output : undefined;
};
const recordsOf = (output: Record<string, unknown> | undefined, field: "hits" | "pages" | "records"): Record<string, unknown>[] | undefined => {
  const data = output?.data;
  const list = isRecord(data) ? data[field] : undefined;
  return Array.isArray(list) && list.every(isRecord) ? (list as Record<string, unknown>[]) : undefined;
};
const counted = (output: Record<string, unknown> | undefined, field: string): number => {
  const meta = output?.meta;
  const value = isRecord(meta) ? meta[field] : undefined;
  return typeof value === "number" ? value : 0;
};
/** Canonical state written by earlier nodes of this Workflow; re-checked rather than trusted blindly. */
const researchRequestOf = (values: Values): CompanyResearchRequest | undefined => {
  const checked = validateCompanyResearchRequest(values[STATE_KEYS.researchRequest]);
  return checked.ok ? checked.value : undefined;
};

function executor(id: string, execute: (values: Values, runId: string) => DeterministicExecutorResult): DeterministicExecutor {
  return Object.freeze({ id, version: EXECUTOR_VERSION, execute: async (context: DeterministicExecutorContext) => execute(context.state.values, context.runId) });
}

/** research.intake: validate and canonicalize the request; prepare the planning ModelRequest. No model. */
export const intake = executor("company_research.intake", (values, runId) => {
  const checked = validateCompanyResearchRequest(values[STATE_KEYS.request]);
  if (!checked.ok) return fail("INVALID_RESEARCH_REQUEST");
  return ok({ [STATE_KEYS.researchRequest]: checked.value, [STATE_KEYS.planModelRequest]: buildPlanningRequest(runId, checked.value) });
});

/** Validates the model's ResearchPlan deterministically. An invalid plan fails the Run before any Tool runs. */
export const validatePlan = executor("company_research.validate_plan", (values) => {
  const request = researchRequestOf(values);
  if (request === undefined) return fail("RESEARCH_STATE_INVALID");
  const checked = validateResearchPlan(outputOf(values, STATE_KEYS.planResult), request);
  if (!checked.ok) return fail("INVALID_RESEARCH_PLAN");
  return ok({ [STATE_KEYS.researchPlan]: checked.value });
});

/** Glue: validated plan → `public_web.search` input. */
export const prepareSearch = executor("company_research.prepare_search", (values) => {
  const plan = values[STATE_KEYS.researchPlan] as unknown as ResearchPlan | undefined;
  if (!isRecord(plan) || !Array.isArray(plan.queries)) return fail("RESEARCH_STATE_INVALID");
  return ok({ [STATE_KEYS.searchInput]: { queries: plan.queries.map((query) => query.query), resultsPerQuery: L.resultsPerQuery } });
});

/** Glue: normalized search hits → `records.dedupe` input, keyed by canonical URL, keeping the first-seen hit. */
export const prepareDedupe = executor("company_research.prepare_dedupe", (values) => {
  const hits = recordsOf(outputOf(values, STATE_KEYS.searchResult), "hits");
  if (hits === undefined) return fail("RESEARCH_STATE_INVALID");
  return ok({ [STATE_KEYS.dedupeInput]: { records: hits, keys: ["url"], keep: "first" } });
});

/**
 * Glue: deduplicated hits → the exact URL list for `public_web.fetch_pages`,
 * in first-seen ranking order, capped at `maxSources`. The selection is
 * recorded so later nodes can prove no page outside it was used.
 */
export const prepareFetch = executor("company_research.prepare_fetch", (values) => {
  const records = recordsOf(outputOf(values, STATE_KEYS.dedupeResult), "records");
  if (records === undefined || !records.every((record) => typeof record.url === "string")) return fail("RESEARCH_STATE_INVALID");
  const candidates = records.map((record) => record.url as string);
  const selected = candidates.slice(0, L.maxSources);
  return ok({
    [STATE_KEYS.fetchInput]: { urls: selected, maxCharsPerPage: L.maxCharsPerSource, maxTotalChars: L.maxTotalEvidenceChars },
    [STATE_KEYS.sourceSelection]: { candidates: candidates.length, selected, notFetched: candidates.length - selected.length },
  });
});

/** Glue: fetched pages → `records.project` input, keeping only the fields synthesis needs. */
export const prepareProject = executor("company_research.prepare_project", (values) => {
  const pages = recordsOf(outputOf(values, STATE_KEYS.fetchResult), "pages");
  if (pages === undefined) return fail("RESEARCH_STATE_INVALID");
  return ok({ [STATE_KEYS.projectInput]: { records: pages, fields: ["sourceId", "url", "title", "text", "truncated"] } });
});

/**
 * Builds the ResearchSourcePacket from projected records, with
 * deterministic context admission (source order → at most `maxSources` →
 * per-source cap → total cap; a source with no remaining budget is
 * dropped and counted), the evidence summary, and the synthesis
 * ModelRequest. Each source is re-checked: its URL must be one this Run
 * selected for fetch, and its id must equal the AAO source id of that URL.
 */
export const buildSourcePacket = executor("company_research.build_source_packet", (values, runId) => {
  const request = researchRequestOf(values);
  const records = recordsOf(outputOf(values, STATE_KEYS.projectResult), "records");
  const selection = values[STATE_KEYS.sourceSelection];
  if (request === undefined || records === undefined || !isRecord(selection) || !Array.isArray(selection.selected)) return fail("RESEARCH_STATE_INVALID");
  const selected = new Set(selection.selected as string[]);

  const sources: ResearchSource[] = [];
  let remaining: number = L.maxTotalEvidenceChars;
  let truncated = 0;
  let dropped = 0;
  for (const record of records) {
    const { sourceId, url, title, text } = record;
    if (typeof url !== "string" || canonicalizePublicWebUrl(url) !== url || !selected.has(url) || sourceId !== publicWebSourceId(url) || typeof title !== "string" || typeof text !== "string" || typeof record.truncated !== "boolean") return fail("SOURCE_PACKET_INVALID");
    if (sources.length === L.maxSources || remaining === 0) {
      dropped += 1;
      continue;
    }
    const cap = Math.min(L.maxCharsPerSource, remaining);
    let kept = text;
    if (text.length > cap) {
      kept = text.slice(0, cap);
      const last = kept.charCodeAt(kept.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) kept = kept.slice(0, -1);
    }
    const cut = record.truncated || kept.length < text.length;
    if (cut) truncated += 1;
    remaining -= kept.length;
    sources.push({ sourceId, title, url, text: kept, truncated: cut });
  }
  const packet: ResearchSourcePacket = { schemaVersion: 1, sources, admission: { offered: records.length, admitted: sources.length, truncated, dropped } };

  const search = outputOf(values, STATE_KEYS.searchResult);
  const fetched = outputOf(values, STATE_KEYS.fetchResult);
  const evidence: EvidenceSummary = {
    partial: false,
    searchQueries: counted(search, "queriesAttempted"),
    searchQueriesFailed: counted(search, "queriesFailed"),
    searchHits: counted(search, "hitsReturned"),
    candidateSources: typeof selection.candidates === "number" ? selection.candidates : 0,
    candidatesNotFetched: typeof selection.notFetched === "number" ? selection.notFetched : 0,
    sourcesRequested: counted(fetched, "requested"),
    sourcesFetched: counted(fetched, "fetched"),
    sourcesFailed: counted(fetched, "failed"),
    sourcesTruncated: truncated,
    sourcesDropped: dropped,
    sourcesAdmitted: sources.length,
  };
  evidence.partial = evidence.searchQueriesFailed > 0 || evidence.candidatesNotFetched > 0 || evidence.sourcesFailed > 0 || truncated > 0 || dropped > 0;
  return ok({ [STATE_KEYS.sourcePacket]: packet, [STATE_KEYS.evidenceSummary]: evidence, [STATE_KEYS.synthesisModelRequest]: buildSynthesisRequest(runId, request, packet) });
});

/** Deterministic grounding validation. A draft that fails it stops the Run: no report is rendered. */
export const validateGrounding = executor("company_research.validate_grounding", (values) => {
  const request = researchRequestOf(values);
  const packet = values[STATE_KEYS.sourcePacket] as unknown as ResearchSourcePacket | undefined;
  if (request === undefined || !isRecord(packet) || !Array.isArray(packet.sources)) return fail("RESEARCH_STATE_INVALID");
  const checked = validateCompanyResearchDraft({ request, sourcePacket: packet, draft: outputOf(values, STATE_KEYS.synthesisResult) });
  if (!checked.ok) return fail(checked.issues[0]!.code);
  return ok({ [STATE_KEYS.groundedReport]: checked.report });
});

/** Deterministic rendering of the final CompanyResearchResult v1 (structured result plus Markdown). */
export const render = executor("company_research.render", (values) => {
  const request = researchRequestOf(values);
  const report = values[STATE_KEYS.groundedReport] as unknown as GroundedReport | undefined;
  const packet = values[STATE_KEYS.sourcePacket] as unknown as ResearchSourcePacket | undefined;
  const evidence = values[STATE_KEYS.evidenceSummary] as unknown as EvidenceSummary | undefined;
  if (request === undefined || !isRecord(report) || !isRecord(packet) || !isRecord(evidence)) return fail("RESEARCH_STATE_INVALID");
  return ok({ [STATE_KEYS.researchResult]: buildCompanyResearchResult({ request, report, sourcePacket: packet, evidence }) as unknown as JsonValue });
});

/** Every deterministic executor of the Workflow, registered with `createAAO({ deterministicExecutors })`. */
export const COMPANY_RESEARCH_EXECUTORS: readonly DeterministicExecutor[] = Object.freeze([intake, validatePlan, prepareSearch, prepareDedupe, prepareFetch, prepareProject, buildSourcePacket, validateGrounding, render]);
