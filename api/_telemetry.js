// Conversation observability: one structured event per /api/chat request, so real
// conversations can later be reviewed for parser gaps, knowledge gaps, bad recommendations,
// and frustrating/repetitive exchanges. This is logging, not analytics and not model
// training — see the "Conversation observability" note in README.md.
//
// PRIVACY (deliberate, see README.md for the full reasoning):
//   - NEVER logged: the customer's raw message text, the assistant's raw reply text,
//     ANTHROPIC_API_KEY, or any Shopify credential (there are none in this project).
//   - Logged: category-level structured state (water type, issue id, goal, etc. — all drawn
//     from small fixed vocabularies, not free text), counts, timings, outcomes, and the real
//     catalog product ids that were shown (catalog data, not personal data).
//   - There is deliberately nothing to "redact": fields that could carry free text are left
//     out of the event at construction time rather than collected and stripped afterwards.
//
// Today's sink is a single JSON line to console.log/console.error, exactly as Phase 1 already
// did (meta -> logRequest) — captured by Vercel's own Runtime Logs with no new service.
// enrichEvent()/classifySignals() are pure; swapping in a real destination later (a log drain,
// a queue) means changing logEvent()'s body, not anything that touches a conversation.
//
// Files starting with "_" in /api are helpers, not Vercel functions.

import { WATER_TYPE_KNOWLEDGE } from "./_knowledge.js";

// Only the categorical/structured fields of conversation state are ever logged — never free
// text. `issue`/`issueDetails` are drawn from a small fixed vocabulary (see ISSUE_PATTERNS /
// ISSUE_WORDS in api/_needs.js), not arbitrary customer wording.
function stateSnapshot(state) {
  return {
    waterType: state.waterType,
    waterSubtype: state.waterSubtype,
    waterSource: state.waterSource,
    treatment: state.treatment,
    goal: state.goal,
    issue: state.issue,
    issueDetails: state.issueDetails,
    testingScope: state.testingScope,
    lastAskedField: state.lastAskedField,
    lastAnswerWasAmbiguous: state.lastAnswerWasAmbiguous,
    waterTypeClarificationCount: state.waterTypeClarificationCount,
    uncertainStreak: state.uncertainStreak,
    relaxedReadiness: state.relaxedReadiness,
    pendingWaterTypeSwitch: state.pendingWaterTypeSwitch,
  };
}

// Deterministic review signals — a fixed, searchable vocabulary a human reviewer can filter
// on, computed only from fields already on the event (never from message text, and never by
// asking an LLM to grade the conversation).
export function classifySignals(event) {
  const signals = [];
  const state = event.state ?? {};

  if (event.repeatedMessage) signals.push("repeated_question");
  if (state.lastAnswerWasAmbiguous) signals.push("ambiguous_answer");
  if (state.waterTypeClarificationCount >= 2) signals.push("water_type_not_recognized");
  if (state.uncertainStreak >= 2) signals.push("repeated_uncertainty");
  if (event.relaxedReadiness) signals.push("frustrated_or_skipped_ahead");
  if (state.pendingWaterTypeSwitch) signals.push("topic_switch_pending");
  if (event.rejectedKnownFieldQuestion) signals.push("model_ignored_known_state");
  if (event.degenerateReply || event.unwrappedJson === "unrenderable") signals.push("unexpected_fallback");
  if (event.guardRemoved) signals.push("guard_removed_content");
  if (event.outcome && event.outcome !== "ok") signals.push("api_error");
  if (event.catalog?.status === "no_match") signals.push("no_product_match");
  if (event.catalog?.status === "unavailable") signals.push("catalog_unavailable");
  if (event.catalog?.status === "ok" && event.catalog.shown > 0) signals.push("product_recommended");
  if (state.waterType && state.issue && !WATER_TYPE_KNOWLEDGE[state.waterType]?.problems?.[state.issue]) {
    signals.push("knowledge_gap");
  }
  if (!event.readiness?.ready && !state.waterType) signals.push("no_useful_context_yet");
  return signals;
}

// Adds the Phase 4 observability fields to the flat event chat.js already builds (`meta`),
// without renaming or restructuring any existing field — every field Phase 1-3 already log
// and test (model, outcome, upstreamStatus, attempts, catalog, needs, ...) stays exactly as
// it was. `timestamp`/`totalMs` are derived from `startedAt`, which is then dropped (it is
// wall-clock epoch ms, not useful once totalMs exists, and not meaningful to a reviewer).
export function enrichEvent(meta, state) {
  const { startedAt, ...fields } = meta;
  const event = {
    event: "chat",
    ...fields,
    totalMs: Date.now() - startedAt,
    timestamp: new Date(startedAt).toISOString(),
    conversationId: state.conversationId,
    state: stateSnapshot(state),
  };
  event.signals = classifySignals(event);
  return event;
}

// The actual sink. Kept deliberately thin (see the file header) so a future destination is a
// one-function change. "ok" goes to stdout; anything else (an upstream/model error) to stderr —
// the same split Phase 1's logRequest already used, so Vercel Runtime Logs still separate them.
export function logEvent(event) {
  const line = JSON.stringify(event);
  if (event.outcome === "ok") console.log(line);
  else console.error(line);
}
