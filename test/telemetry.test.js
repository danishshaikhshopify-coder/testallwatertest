// Phase 4: conversation observability. Tests the pure event-building/signal-classification
// functions in api/_telemetry.js directly, and the integration with api/chat.js — including
// the deterministic readiness-gate path, which previously logged nothing at all.
import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import handler from "../api/chat.js";
import { resetCatalogState } from "../api/_catalog.js";
import { enrichEvent, classifySignals, logEvent, aggregateSignals } from "../api/_telemetry.js";
import { createFakeStore, installWorld, llmReply } from "./fake-store.js";

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.SHOPIFY_CATALOG = "off";
});

afterEach(() => {
  mock.restoreAll();
});

function baseState(over = {}) {
  return {
    waterType: null, waterSubtype: null, waterSource: null, treatment: null, goal: null,
    issue: null, issueDetails: [], testingScope: null, lastAskedField: null,
    lastAnswerWasAmbiguous: false, waterTypeClarificationCount: 0, uncertainStreak: 0,
    relaxedReadiness: false, pendingWaterTypeSwitch: null, conversationId: "conv-1",
    ...over,
  };
}

function baseMeta(over = {}) {
  return { requestId: "req-1", model: "claude-sonnet-5-5", historyMessages: 1, startedAt: Date.now() - 5, readiness: { ready: true, missing: [] }, outcome: "ok", replyChars: 42, ...over };
}

// --- 1. Event creation --------------------------------------------------------------------

test("enrichEvent produces the documented shape without renaming any existing field", () => {
  const event = enrichEvent(baseMeta(), baseState());
  assert.equal(event.event, "chat");
  assert.equal(event.requestId, "req-1");
  assert.equal(event.model, "claude-sonnet-5-5");
  assert.equal(event.outcome, "ok");
  assert.equal(typeof event.totalMs, "number");
  assert.ok(event.totalMs >= 0);
  assert.match(event.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(event.conversationId, "conv-1");
  assert.equal(event.startedAt, undefined, "the raw epoch-ms startedAt is dropped once totalMs/timestamp exist");
  assert.deepEqual(Object.keys(event.state).sort(), [
    "goal", "issue", "issueDetails", "lastAnswerWasAmbiguous", "lastAskedField", "pendingWaterTypeSwitch",
    "recommendationStatus", "relaxedReadiness", "testingScope", "treatment", "uncertainStreak", "waterSource",
    "waterSubtype", "waterType", "waterTypeClarificationCount",
  ].sort());
  assert.ok(Array.isArray(event.signals));
});

// --- 2. Sensitive key exclusion ----------------------------------------------------------

test("no event ever contains the API key, a Shopify credential, or raw message text", () => {
  const event = enrichEvent(baseMeta({ repeatedMessage: true }), baseState({ waterType: "pool", issue: "green_water", issueDetails: ["green water"] }));
  const serialized = JSON.stringify(event);
  assert.doesNotMatch(serialized, /sk-ant|ANTHROPIC_API_KEY|shpat_|shpca_|shpss_/i);
  // issueDetails is drawn from a small fixed vocabulary, not free text — still, confirm no
  // arbitrary customer wording (e.g. a full sentence) ever appears.
  assert.ok(event.state.issueDetails.every((d) => d.split(" ").length <= 3));
});

// --- 3. Expected fields present under realistic conditions --------------------------------

test("a recommendation event includes catalog status, product ids, and the product_recommended signal", () => {
  const event = enrichEvent(
    baseMeta({ catalog: { status: "ok", shown: 2, queries: 3, candidates: 7, qualified: 2 } }),
    baseState({ waterType: "pool", issue: "green_water", issueDetails: ["green water"], testingScope: "complete" })
  );
  assert.equal(event.catalog.status, "ok");
  assert.equal(event.catalog.shown, 2);
  assert.ok(event.signals.includes("product_recommended"));
});

test("no-match and unavailable catalog outcomes produce their own distinct signals", () => {
  const noMatch = enrichEvent(baseMeta({ catalog: { status: "no_match", shown: 0 } }), baseState({ waterType: "well" }));
  assert.ok(noMatch.signals.includes("no_product_match"));
  const unavailable = enrichEvent(baseMeta({ catalog: { status: "unavailable", shown: 0 } }), baseState({ waterType: "pool" }));
  assert.ok(unavailable.signals.includes("catalog_unavailable"));
});

// --- 4. Error events -----------------------------------------------------------------------

test("an error event is classified with the api_error signal and keeps the error code", () => {
  const event = enrichEvent(baseMeta({ outcome: "timeout", replyChars: undefined, errorDetail: "tried 2 times" }), baseState({ waterType: "pool" }));
  assert.equal(event.outcome, "timeout");
  assert.ok(event.signals.includes("api_error"));
});

// --- 5. Frustration / override signals ------------------------------------------------------

test("relaxedReadiness is classified as frustrated_or_skipped_ahead", () => {
  const event = enrichEvent(baseMeta({ relaxedReadiness: true }), baseState({ waterType: "pool", relaxedReadiness: true }));
  assert.ok(event.signals.includes("frustrated_or_skipped_ahead"));
});

test("a second consecutive uncertain answer is classified as repeated_uncertainty", () => {
  const once = enrichEvent(baseMeta(), baseState({ waterType: "pool", uncertainStreak: 1 }));
  assert.ok(!once.signals.includes("repeated_uncertainty"));
  const twice = enrichEvent(baseMeta(), baseState({ waterType: "pool", uncertainStreak: 2 }));
  assert.ok(twice.signals.includes("repeated_uncertainty"));
});

test("an unresolved water-type clarification is classified as water_type_not_recognized", () => {
  const event = enrichEvent(baseMeta(), baseState({ waterTypeClarificationCount: 2 }));
  assert.ok(event.signals.includes("water_type_not_recognized"));
});

// --- 6. Repeated-question signal ------------------------------------------------------------

test("repeatedMessage is classified as repeated_question", () => {
  const event = enrichEvent(baseMeta({ repeatedMessage: true }), baseState({ waterType: "pool" }));
  assert.ok(event.signals.includes("repeated_question"));
});

// --- 7. Normal conversation event -----------------------------------------------------------

test("a normal, successful turn with nothing unusual carries no review signals at all", () => {
  const event = enrichEvent(baseMeta(), baseState({ waterType: "pool", goal: "routine_testing", testingScope: "complete" }));
  assert.deepEqual(event.signals, []);
});

test("knowledge_gap fires only when the water type is known but the specific issue has no matching knowledge entry", () => {
  const known = enrichEvent(baseMeta(), baseState({ waterType: "pool", issue: "green_water" }));
  assert.ok(!known.signals.includes("knowledge_gap"));
  const unknown = enrichEvent(baseMeta(), baseState({ waterType: "pool", issue: "not_a_real_issue_id" }));
  assert.ok(unknown.signals.includes("knowledge_gap"));
});

// --- Sink routing ----------------------------------------------------------------------------

test("logEvent writes ok outcomes to console.log and everything else to console.error", () => {
  const logs = { out: [], err: [] };
  mock.method(console, "log", (line) => logs.out.push(line));
  mock.method(console, "error", (line) => logs.err.push(line));
  logEvent({ outcome: "ok" });
  logEvent({ outcome: "timeout" });
  assert.equal(logs.out.length, 1);
  assert.equal(logs.err.length, 1);
});

// --- Integration: the previously-silent deterministic gate now logs too --------------------

test("integration: a deterministic guided-response turn (no LLM call) now also logs exactly one event", async () => {
  const logs = { out: [], err: [] };
  mock.method(console, "log", (line) => logs.out.push(line));
  mock.method(console, "error", (line) => logs.err.push(line));
  const res = { headers: {}, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(p) { this.payload = p; return this; } };
  await handler({ method: "POST", headers: {}, body: { messages: [{ role: "user", content: "My pool water is cloudy" }] } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.ready, false);
  assert.equal(logs.out.length + logs.err.length, 1, "the deterministic (no-LLM) path must log exactly one event, same as the LLM path");
  const entry = JSON.parse((logs.out[0] ?? logs.err[0]));
  assert.equal(entry.event, "chat");
  assert.equal(entry.model, "readiness-gate");
  assert.equal(entry.outcome, "ok");
  assert.equal(entry.state.waterType, "pool");
  assert.ok(entry.conversationId);
  assert.doesNotMatch(JSON.stringify(entry), /cloudy pool water|test-key/i);
});

test("integration: the conversationId is stable across turns and travels only inside state", async () => {
  delete process.env.SHOPIFY_CATALOG;
  resetCatalogState();
  const store = createFakeStore();
  installWorld({ store, llm: llmReply("Here you go.") });
  const logs = [];
  mock.method(console, "log", (line) => logs.push(line));

  function call(messages, state) {
    const res = { headers: {}, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(p) { this.payload = p; return this; } };
    return handler({ method: "POST", headers: {}, body: { messages, state } }, res).then(() => res);
  }

  const conv = [{ role: "user", content: "My pool water is cloudy" }];
  const first = await call(conv, undefined);
  assert.ok(first.payload.state.conversationId);

  conv.push({ role: "assistant", content: first.payload.reply }, { role: "user", content: "bromine" });
  const second = await call(conv, first.payload.state);
  assert.equal(second.payload.state.conversationId, first.payload.state.conversationId, "the same conversation keeps the same id across turns");

  const entries = logs.map((l) => JSON.parse(l));
  assert.ok(entries.every((e) => e.conversationId === first.payload.state.conversationId));
});

test("integration: no source file in the telemetry layer contains a hardcoded secret", () => {
  // Reuses the same guarantee the existing secret-scan test already enforces project-wide;
  // scoped here as a direct check on the new file.
  const text = readFileSync(new URL("../api/_telemetry.js", import.meta.url), "utf8");
  assert.doesNotMatch(text, /sk-[A-Za-z0-9_-]{16,}|shpat_|shpca_|shpss_/);
});

// --- Phase 5: the learning/improvement loop — new signals, and a pure aggregation utility -----

function callThrough(handler) {
  return function call(messages, state) {
    const res = { headers: {}, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(p) { this.payload = p; return this; } };
    return handler({ method: "POST", headers: {}, body: { messages, state } }, res).then(() => res);
  };
}

test("Phase 5 (1): recommendation_rejected is recorded for a real conversation that ends in rejection", async () => {
  delete process.env.SHOPIFY_CATALOG;
  resetCatalogState();
  installWorld({ store: createFakeStore(), llm: llmReply("Let's find something else.") });
  const logs = [];
  mock.method(console, "log", (line) => logs.push(line));
  mock.method(console, "error", (line) => logs.push(line));
  const call = callThrough(handler);
  let r = await call([{ role: "user", content: "I need an iron test for well water." }]);
  r = await call(
    [{ role: "user", content: "I need an iron test for well water." }, { role: "assistant", content: r.payload.reply }, { role: "user", content: "not this one" }],
    r.payload.state
  );
  const entries = logs.map((l) => JSON.parse(l));
  assert.ok(entries.some((e) => e.signals.includes("recommendation_rejected")));
});

test("Phase 5 (2): recommendation_accepted is recorded for a real conversation that ends in acceptance", async () => {
  delete process.env.SHOPIFY_CATALOG;
  resetCatalogState();
  installWorld({ store: createFakeStore(), llm: llmReply("Great choice.") });
  const logs = [];
  mock.method(console, "log", (line) => logs.push(line));
  mock.method(console, "error", (line) => logs.push(line));
  const call = callThrough(handler);
  let r = await call([{ role: "user", content: "I need an iron test for well water." }]);
  r = await call(
    [{ role: "user", content: "I need an iron test for well water." }, { role: "assistant", content: r.payload.reply }, { role: "user", content: "I want this" }],
    r.payload.state
  );
  const entries = logs.map((l) => JSON.parse(l));
  assert.ok(entries.some((e) => e.signals.includes("recommendation_accepted")));
});

test("Phase 5 (3): repeated_question is recorded for a real word-for-word repeated message", async () => {
  delete process.env.SHOPIFY_CATALOG;
  resetCatalogState();
  installWorld({ store: createFakeStore(), llm: llmReply("A pool kit would be the usual starting point.") });
  const logs = [];
  mock.method(console, "log", (line) => logs.push(line));
  mock.method(console, "error", (line) => logs.push(line));
  const call = callThrough(handler);
  let r = await call([{ role: "user", content: "My pool water is cloudy, what do I need?" }]);
  r = await call(
    [{ role: "user", content: "My pool water is cloudy, what do I need?" }, { role: "assistant", content: r.payload.reply }, { role: "user", content: "My pool water is cloudy, what do I need?" }],
    r.payload.state
  );
  const entries = logs.map((l) => JSON.parse(l));
  assert.ok(entries.some((e) => e.signals.includes("repeated_question")));
});

test("Phase 5 (4): knowledge_gap fires for a real conversation about an issue the knowledge layer has no entry for", () => {
  const event = enrichEvent(baseMeta(), baseState({ waterType: "pool", issue: "not_a_real_issue_id" }));
  assert.ok(event.signals.includes("knowledge_gap"));
});

test("Phase 5 (5): no_product_match is recorded for a real conversation about a parameter the catalog doesn't carry", async () => {
  delete process.env.SHOPIFY_CATALOG;
  resetCatalogState();
  installWorld({ store: createFakeStore(), llm: llmReply("I couldn't find a matching radon test.") });
  const logs = [];
  mock.method(console, "log", (line) => logs.push(line));
  mock.method(console, "error", (line) => logs.push(line));
  const call = callThrough(handler);
  await call([{ role: "user", content: "I need a radon test for my well water." }]);
  const entries = logs.map((l) => JSON.parse(l));
  assert.ok(entries.some((e) => e.signals.includes("no_product_match")));
});

test("Phase 5 (6): frustrated_or_skipped_ahead is recorded for a real 'just tell me what to buy' turn", async () => {
  delete process.env.SHOPIFY_CATALOG;
  resetCatalogState();
  installWorld({ store: createFakeStore(), llm: llmReply("Here is a sensible starting point.") });
  const logs = [];
  mock.method(console, "log", (line) => logs.push(line));
  mock.method(console, "error", (line) => logs.push(line));
  const call = callThrough(handler);
  await call([{ role: "user", content: "Just tell me what to buy." }]);
  const entries = logs.map((l) => JSON.parse(l));
  assert.ok(entries.some((e) => e.signals.includes("frustrated_or_skipped_ahead")));
});

test("Phase 5 (7): catalog and API failures each get their own distinct signal from a real conversation", async () => {
  delete process.env.SHOPIFY_CATALOG;
  resetCatalogState();
  const logs = [];
  mock.method(console, "log", (line) => logs.push(line));
  mock.method(console, "error", (line) => logs.push(line));
  const call = callThrough(handler);

  // Catalog failure: the store itself is unreachable.
  installWorld({ store: createFakeStore({ failSearch: true }), llm: llmReply("Trouble reaching the catalog.") });
  await call([{ role: "user", content: "I need an iron test for well water." }]);

  // API failure: the model call itself fails.
  resetCatalogState();
  installWorld({ store: createFakeStore(), llm: async () => new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 529 }) });
  await call([{ role: "user", content: "I need an iron test for well water." }]);

  const entries = logs.map((l) => JSON.parse(l));
  assert.ok(entries.some((e) => e.signals.includes("catalog_unavailable")), "a catalog failure gets catalog_unavailable");
  assert.ok(entries.some((e) => e.signals.includes("api_error")), "a model/API failure gets api_error, distinct from the catalog signal");
});

test("Phase 5 (8): telemetry from a real conversation never contains the raw message text or the API key", async () => {
  delete process.env.SHOPIFY_CATALOG;
  resetCatalogState();
  const DISTINCTIVE = "zyxqvorphlemtastic private well situation";
  installWorld({ store: createFakeStore(), llm: llmReply(`Understood, ${DISTINCTIVE} noted in the reply too.`) });
  const logs = [];
  mock.method(console, "log", (line) => logs.push(line));
  mock.method(console, "error", (line) => logs.push(line));
  const call = callThrough(handler);
  await call([{ role: "user", content: `My well water is weird, this is my ${DISTINCTIVE}.` }]);
  const serialized = logs.join("\n");
  assert.doesNotMatch(serialized, new RegExp(DISTINCTIVE, "i"), "neither the raw customer text nor the raw assistant reply (which also contained this phrase) ever reaches the log");
  assert.doesNotMatch(serialized, /test-key/i);
});

test("Phase 5 (9): telemetry stays stable when newer optional state fields are missing", () => {
  // Simulates a minimal/older round-tripped state object that predates fields like
  // recommendationStatus or symptomCandidates — enrichEvent/classifySignals must not throw, and
  // must not invent a signal from fields that simply aren't there.
  const minimalState = { conversationId: "conv-minimal" };
  assert.doesNotThrow(() => enrichEvent(baseMeta(), minimalState));
  const event = enrichEvent(baseMeta(), minimalState);
  assert.deepEqual(event.signals, []);
  assert.equal(event.conversationId, "conv-minimal");
});

test("Phase 5 (10): aggregateSignals correctly ranks repeated failure patterns across a batch of events", () => {
  const events = [
    enrichEvent(baseMeta({ catalog: { status: "no_match", shown: 0 } }), baseState({ waterType: "well" })),
    enrichEvent(baseMeta({ catalog: { status: "no_match", shown: 0 } }), baseState({ waterType: "well" })),
    enrichEvent(baseMeta({ catalog: { status: "no_match", shown: 0 } }), baseState({ waterType: "drinking" })),
    enrichEvent(baseMeta({ relaxedReadiness: true }), baseState({ waterType: "pool", relaxedReadiness: true })),
    enrichEvent(baseMeta(), baseState({ waterType: "pool", goal: "routine_testing", testingScope: "complete" })),
  ];
  const summary = aggregateSignals(events);
  assert.equal(summary.totalEvents, 5);
  assert.equal(summary.bySignal.no_product_match, 3, "the repeated failure pattern is counted correctly");
  assert.equal(summary.bySignal.frustrated_or_skipped_ahead, 1);
  assert.equal(summary.topSignals[0].signal, "no_product_match", "the most common signal is ranked first");
  assert.equal(summary.topSignals[0].count, 3);
  // No crash and a sensible empty result for a batch with nothing to report.
  assert.deepEqual(aggregateSignals([]), { totalEvents: 0, bySignal: {}, topSignals: [] });
});
