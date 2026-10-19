// Phase 2: the knowledge layer (api/_knowledge.js) is separate from both the product catalog
// and Claude's own conversational wording. These tests check that knowledgeContext() retrieves
// only what is relevant to the current conversation (not the whole knowledge base), and that
// it never depends on the water type being known.
import { test } from "node:test";
import assert from "node:assert/strict";
import { knowledgeContext, WATER_TYPE_KNOWLEDGE, SAFETY_DISCLAIMER } from "../api/_knowledge.js";
import { analyzeNeeds, deriveConversationState } from "../api/_needs.js";

function stateFor(messages) {
  return deriveConversationState(messages.map((content) => ({ role: "user", content })));
}

test("knowledge: returns nothing when the water type is not known yet", () => {
  const state = stateFor(["hello"]);
  const needs = analyzeNeeds(["hello"], state);
  assert.equal(knowledgeContext(state, needs), "");
});

test("knowledge: a pool issue surfaces what it may indicate and why the relevant parameters matter", () => {
  const state = stateFor(["My pool water is green."]);
  const needs = analyzeNeeds(["My pool water is green."], state);
  const note = knowledgeContext(state, needs);
  assert.match(note, /WATER TESTING KNOWLEDGE for pool/);
  assert.match(note, /too little active sanitiser/i);
  assert.match(note, /chlorine.*the active sanitiser level/i);
  assert.match(note, new RegExp(SAFETY_DISCLAIMER.replace(/[.]/g, "\\.")));
});

test("knowledge: only the relevant water type's facts are retrieved, not the whole knowledge base", () => {
  const state = stateFor(["My aquarium fish are gasping at the surface"]);
  const needs = analyzeNeeds(["My aquarium fish are gasping at the surface"], state);
  const note = knowledgeContext(state, needs);
  assert.match(note, /aquarium/);
  // Pool- and well-specific facts must not leak into an aquarium conversation.
  assert.doesNotMatch(note, /cyanuric acid/i);
  assert.doesNotMatch(note, /orange\/brown staining/i);
});

test("knowledge: never invents facts beyond the structured data (every water type's intro is present verbatim)", () => {
  for (const [type, entry] of Object.entries(WATER_TYPE_KNOWLEDGE)) {
    const state = { waterType: type, issue: null, issueDetails: [], lastAskedField: null };
    const note = knowledgeContext(state, { parameters: [] });
    assert.ok(note.includes(entry.intro), `${type}: intro text must appear verbatim`);
  }
});

test("knowledge: the universal safety rule is always present when a water type is known", () => {
  for (const type of Object.keys(WATER_TYPE_KNOWLEDGE)) {
    const note = knowledgeContext({ waterType: type, issue: null, issueDetails: [], lastAskedField: null }, { parameters: [] });
    assert.match(note, /Never diagnose human illness/);
  }
});

test("knowledge: a follow-up question is suggested only when it has not already been asked", () => {
  const withoutAsk = knowledgeContext(
    { waterType: "pool", issue: "green_water", issueDetails: ["green water"], lastAskedField: null },
    { parameters: ["chlorine", "ph"] }
  );
  assert.match(withoutAsk, /Have you tested your chlorine or pH yet\?/);

  const alreadyAsked = knowledgeContext(
    { waterType: "pool", issue: "green_water", issueDetails: ["green water"], lastAskedField: "testingScope" },
    { parameters: ["chlorine", "ph"] }
  );
  assert.doesNotMatch(alreadyAsked, /Have you tested your chlorine or pH yet\?/);
});
