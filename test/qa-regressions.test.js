// Phase 5: regression tests for bugs found during production QA (realistic live-conversation
// stress testing across pool/aquarium/drinking-water scenarios).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { deriveConversationState, guidedResponse, assessRecommendationReadiness, analyzeNeeds } from "../api/_needs.js";

beforeEach(() => {
  process.env.SHOPIFY_CATALOG = "off";
});

function driveConversation(messages) {
  const conv = [];
  let state = null;
  let last;
  for (const text of messages) {
    conv.push({ role: "user", content: text });
    state = deriveConversationState(conv, state);
    const userMessages = conv.filter((m) => m.role === "user").map((m) => m.content);
    const needs = analyzeNeeds(userMessages, state);
    const readiness = assessRecommendationReadiness(userMessages, needs, conv, state);
    last = guidedResponse(state, readiness, text);
    conv.push({ role: "assistant", content: last.reply });
    state.lastAskedField = last.field;
    state._lastAssistantReply = last.reply;
  }
  return { state, last };
}

// Bug: when the anti-repeat dedup fallback fired for the testingScope field on a
// non-pool water type (the literal testingScope question for drinking/well is always the
// same fixed string, so asking it twice collides with `_lastAssistantReply`), the fallback
// text unconditionally said "chlorine or pH result" and "the pool water issue" — pool-specific
// language leaking into a drinking-water (or any non-pool) conversation.
test("QA regression: the testingScope anti-repeat fallback never mentions chlorine/pH or 'pool' for a non-pool water type", () => {
  const { last } = driveConversation(["My tap water smells and tastes weird", "tap"]);
  assert.doesNotMatch(last.reply, /chlorine or pH result/i);
  assert.doesNotMatch(last.reply, /\bpool\b/i);
});

test("QA regression: the same fallback for a safety-sensitive drinking-water message also stays on-topic", () => {
  const { last } = driveConversation(["Is my tap water safe to drink? I'm worried about contamination", "tap"]);
  assert.doesNotMatch(last.reply, /chlorine or pH result/i);
  assert.doesNotMatch(last.reply, /\bpool\b/i);
});

// The pool-specific fallback wording must still work correctly for an actual pool
// conversation — the fix must not have removed the pool-specific phrasing, only scoped it.
test("QA regression: the pool-specific testingScope fallback still mentions chlorine/pH for an actual pool conversation", () => {
  const { last } = driveConversation(["My pool water is cloudy", "chlorine", "chlorine"]);
  assert.match(last.reply, /chlorine or pH result|full test/i);
});

// The goal-field anti-repeat fallback previously hardcoded "pool test" regardless of water
// type; confirm it no longer does when the normal goal question collides with the last reply.
test("QA regression: the goal-field anti-repeat fallback does not say 'pool' for a non-pool water type", () => {
  const conv = [{ role: "user", content: "I have a private well" }];
  const state = deriveConversationState(conv);
  const needs = analyzeNeeds(["I have a private well"], state);
  const readiness = assessRecommendationReadiness(["I have a private well"], needs, conv, state);
  assert.equal(readiness.nextMissingField, "goal");
  // Force the exact dedup collision: the normal "goal" question for a non-pool type is
  // always this fixed string, so if it was already asked, asking it again must not fall
  // back to pool-specific wording.
  state._lastAssistantReply = "What are you hoping to check in your water?";
  const guided = guidedResponse(state, readiness, "I have a private well");
  assert.doesNotMatch(guided.reply, /\bpool\b/i);
});

// Bug: switching water type (explicitly, e.g. "I'm switching to my aquarium") cleared
// treatment/testingScope/subtype/source but not `issue`/`issueDetails`/`issues` — a
// pool-specific issue id (cloudy_water, high_chlorine, ...) silently survived into the new
// water type's state, reaching the system prompt's "KNOWN FACTS" and the knowledge layer as
// if it still applied (caught by the telemetry `knowledge_gap` signal during QA).
test("QA regression: switching water type clears the previous water type's issue, not just treatment/scope", () => {
  const { state } = driveConversation([
    "My pool water is cloudy",
    "bromine",
    "I am switching to my aquarium",
  ]);
  assert.equal(state.waterType, "aquarium");
  assert.equal(state.issue, null);
  assert.deepEqual(state.issueDetails, []);
  assert.deepEqual(state.issues, []);
});
