// Phase 3: conversational intelligence. These tests check the "teach while diagnosing",
// "ask only useful questions", "use context intelligently", "best-fit recommendation with a
// clear reason", "smart optional upsell", "customer control", and "frustration" behaviors
// built on top of the deterministic state machine (api/_needs.js), the knowledge layer
// (api/_knowledge.js), and the retrieval/system-prompt wiring (api/chat.js).
import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import handler from "../api/chat.js";
import { resetCatalogState } from "../api/_catalog.js";
import { deriveConversationState, questionForMissingField, getNextMissingField, assessRecommendationReadiness, analyzeNeeds } from "../api/_needs.js";
import { createFakeStore, installWorld, llmReply } from "./fake-store.js";

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.SHOPIFY_CATALOG = "off";
  mock.method(console, "log", () => {});
  mock.method(console, "error", () => {});
});

afterEach(() => {
  mock.restoreAll();
});

function call(messages, state) {
  const res = {
    headers: {}, setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
  return handler({ method: "POST", headers: {}, body: { messages, state } }, res).then(() => res);
}

async function sendTurn(conversation, content, state = null) {
  conversation.push({ role: "user", content });
  const response = await call(conversation, state);
  if (response.payload?.reply) conversation.push({ role: "assistant", content: response.payload.reply });
  return response;
}

// --- 1. Teach while diagnosing (deterministic path, no LLM involved) ----------------------

test("green pool water: the assistant explains what it may indicate in the SAME message as the next question", () => {
  const state = deriveConversationState([
    { role: "user", content: "I have a swimming pool" },
    { role: "assistant", content: "placeholder" },
    { role: "user", content: "The water is green" },
  ]);
  const question = questionForMissingField(getNextMissingField(state), state);
  // One message: a short explanation of what green water indicates, AND the next question —
  // never a bare question with no teaching.
  assert.match(question, /too little active sanitiser to control algae/i);
  assert.match(question, /Have you tested your chlorine and pH yet\?/);
});

test("cloudy pool water: the first mention explains before asking", () => {
  const state = deriveConversationState([{ role: "user", content: "My pool water is cloudy" }]);
  const question = questionForMissingField(getNextMissingField(state), state);
  assert.match(question, /low sanitiser, a pH\/alkalinity imbalance, or a filtration issue/);
  assert.match(question, /What are you trying to check\?/);
});

// --- 2. Pool, no testing history: narrows down without a generic questionnaire -------------

test("pool with no testing history: teaches, then narrows down, then reaches a recommendation", async () => {
  delete process.env.SHOPIFY_CATALOG;
  resetCatalogState();
  const store = createFakeStore();
  installWorld({ store, llm: llmReply("These cover green pool water well.") });
  const conversation = [];
  let response = await sendTurn(conversation, "I have a swimming pool");
  response = await sendTurn(conversation, "The water is green", response.payload.state);
  assert.match(response.payload.reply, /too little active sanitiser/i);
  response = await sendTurn(conversation, "I haven't tested yet", response.payload.state);
  assert.equal(response.payload.state.testingScope, "not-tested");
  assert.equal(response.payload.ready, false, "still one more useful question: what to check first, or a full test");
  response = await sendTurn(conversation, "Full test", response.payload.state);
  assert.equal(response.payload.ready, true);
  assert.ok(response.payload.products?.length);
});

// --- 3 & 4. Aquarium / drinking water: relevant knowledge reaches the model, not everything --

test("aquarium issue: the model receives the matching knowledge note, not the whole knowledge base", async () => {
  delete process.env.SHOPIFY_CATALOG;
  resetCatalogState();
  const store = createFakeStore();
  const world = installWorld({ store, llm: llmReply("Check ammonia, nitrite and dissolved oxygen.") });
  const conversation = [];
  let response = await sendTurn(conversation, "My aquarium fish are gasping at the surface");
  response = await sendTurn(conversation, "freshwater", response.payload.state);
  assert.equal(response.payload.ready, true);
  const system = world.llmCalls.at(-1).body.system;
  assert.match(system, /WATER TESTING KNOWLEDGE for aquarium/);
  // Only the matching water type's knowledge block is ever included — not a generic mention of
  // "cyanuric acid" (that word is also in the base prompt's universal parameter vocabulary).
  assert.doesNotMatch(system, /WATER TESTING KNOWLEDGE for pool/, "pool-specific knowledge must not leak into an aquarium conversation");
});

test("drinking water concern: guidance says what a test CAN tell, never a safety guarantee", async () => {
  delete process.env.SHOPIFY_CATALOG;
  resetCatalogState();
  const store = createFakeStore();
  const world = installWorld({ store, llm: llmReply("A general screen is a sensible starting point.") });
  const conversation = [];
  let response = await sendTurn(conversation, "I need to test my drinking water");
  response = await sendTurn(conversation, "tap", response.payload.state);
  response = await sendTurn(conversation, "general screen", response.payload.state);
  assert.equal(response.payload.ready, true);
  const system = world.llmCalls.at(-1).body.system;
  assert.match(system, /say what a test CAN tell the customer/i);
  assert.match(system, /never say or imply that a consumer test proves water is medically or legally safe/i);
  assert.match(system, /medical or legal safety guarantee/i);
});

// --- 5 & 6. Customer control and frustration ------------------------------------------------

test('"just show me products" still gets reasoning-rich product guidance for the model', async () => {
  delete process.env.SHOPIFY_CATALOG;
  resetCatalogState();
  const store = createFakeStore();
  const world = installWorld({ store, llm: llmReply("Here is the best fit.") });
  const conversation = [];
  let response = await sendTurn(conversation, "My pool water is cloudy");
  response = await sendTurn(conversation, "just show me products", response.payload.state);
  assert.equal(response.payload.ready, true);
  const system = world.llmCalls.at(-1).body.system;
  assert.match(system, /is the best fit for what the customer described/);
  assert.match(system, /CUSTOMER ASKED TO SKIP AHEAD/);
});

test("repeated uncertainty (two 'not sure' in a row) is treated as frustration and unlocks a recommendation", async () => {
  delete process.env.SHOPIFY_CATALOG;
  resetCatalogState();
  const store = createFakeStore();
  installWorld({ store, llm: llmReply("Here's a sensible starting point.") });
  const conversation = [];
  let response = await sendTurn(conversation, "My pool water is cloudy");
  response = await sendTurn(conversation, "not sure", response.payload.state);
  assert.equal(response.payload.state.relaxedReadiness, false, "a single 'not sure' is normal conversation, not frustration");
  response = await sendTurn(conversation, "not sure", response.payload.state);
  assert.equal(response.payload.state.relaxedReadiness, true, "a second 'not sure' in a row reads as frustration");
  assert.equal(response.payload.ready, true);
  assert.ok(response.payload.products?.length);
});

test("'no idea' is understood the same way as 'not sure' or 'I don't know'", () => {
  const state = deriveConversationState([
    { role: "user", content: "My aquarium fish are gasping at the surface" },
    { role: "assistant", content: "Is it freshwater or saltwater?" },
    { role: "user", content: "no idea" },
  ]);
  assert.equal(state.waterSubtype, "unknown");
});

// --- 7 & 8. Short answers and topic changes, understood from context ------------------------

test("very short answers are understood from the last question, not as unrelated turns", async () => {
  const conversation = [];
  let response = await sendTurn(conversation, "I have a swimming pool");
  response = await sendTurn(conversation, "green", response.payload.state); // bare "green" -> green_water issue
  assert.equal(response.payload.state.issue, "green_water");
  assert.equal(response.payload.state.goal, "troubleshooting");
  response = await sendTurn(conversation, "pH", response.payload.state); // bare "pH" -> a known parameter, in context
  assert.ok(response.payload.state.parameters.includes("ph"));
  assert.equal(response.payload.state.waterType, "pool", "the short answer did not restart or lose the conversation");
});

test("a topic change mid-conversation is recognized immediately when stated explicitly", async () => {
  const conversation = [];
  let response = await sendTurn(conversation, "My pool water is cloudy");
  response = await sendTurn(conversation, "I'm actually asking about my aquarium now", response.payload.state);
  // "actually" signals explicit intent, so the switch happens immediately rather than asking
  // for confirmation first — the change is still recognized, not ignored or merged into "pool".
  assert.equal(response.payload.state.waterType, "aquarium");
  assert.equal(response.payload.state.pendingWaterTypeSwitch, null);
});

test("a topic change stated tentatively asks for confirmation instead of silently switching", async () => {
  const conversation = [];
  let response = await sendTurn(conversation, "My pool water is cloudy");
  response = await sendTurn(conversation, "aquarium", response.payload.state);
  assert.equal(response.payload.state.waterType, "pool", "not switched until confirmed");
  assert.deepEqual(response.payload.state.pendingWaterTypeSwitch, { from: "pool", to: "aquarium" });
  assert.match(response.payload.reply, /switch from pool water to aquarium water/i);
});

// --- 9. Information that makes a previous question unnecessary -----------------------------

test("a single detailed message skips every question it already answered", async () => {
  delete process.env.SHOPIFY_CATALOG;
  resetCatalogState();
  const store = createFakeStore();
  installWorld({ store, llm: llmReply("Here's the right starting point.") });
  const response = await call([{
    role: "user",
    content: "I have a chlorine pool, the water is green, I haven't tested it yet, and I'd like a full test.",
  }]);
  assert.equal(response.payload.ready, true);
  assert.deepEqual(response.payload.readiness.missing, []);
  assert.equal(response.payload.state.waterType, "pool");
  assert.equal(response.payload.state.issue, "green_water");
  assert.equal(response.payload.state.testingScope, "complete");
});

// --- 10 & 11. Product reasoning: clear reason, no automatic upsell --------------------------

test("product guidance gives a clear reason for the best-fit option and does not suggest a second one when only one is shown", async () => {
  delete process.env.SHOPIFY_CATALOG;
  resetCatalogState();
  const store = createFakeStore();
  const world = installWorld({ store, llm: llmReply("This covers it.") });
  const response = await call([{
    role: "user",
    content: "I have a saltwater pool and cloudy water. I want to test chlorine, pH and alkalinity.",
  }]);
  assert.equal(response.payload.ready, true);
  const system = world.llmCalls.at(-1).body.system;
  assert.match(system, /is the best fit for what the customer described/);
  assert.match(system, /Connect their problem to why these parameters matter/);
  if (response.payload.products.length === 1) {
    assert.match(system, /nothing else to add beyond this one unless the customer asks for more/);
  } else {
    assert.match(system, /only as optional/);
    assert.match(system, /never as a requirement/);
  }
});

// --- 13. No invented products, ever ----------------------------------------------------------

test("product guidance always forbids naming, pricing or linking a product directly", async () => {
  delete process.env.SHOPIFY_CATALOG;
  resetCatalogState();
  const store = createFakeStore();
  const world = installWorld({ store, llm: llmReply("Good starting point.") });
  await call([{
    role: "user",
    content: "I have a chlorine-treated pool with cloudy water and want to test chlorine, pH and alkalinity.",
  }]);
  const system = world.llmCalls.at(-1).body.system;
  assert.match(system, /never name, price or link it yourself/i);
  assert.match(system, /Never invent, guess or recall product names/);
});

// --- 14. No repeated questions, and the teaching line is not repeated either ----------------

test("the teaching line is shown once per issue, not repeated on every follow-up turn", async () => {
  const conversation = [];
  let response = await sendTurn(conversation, "I have a swimming pool");
  response = await sendTurn(conversation, "The water is green", response.payload.state);
  const firstReply = response.payload.reply;
  assert.match(firstReply, /too little active sanitiser/i);
  response = await sendTurn(conversation, "I haven't tested yet", response.payload.state);
  assert.doesNotMatch(response.payload.reply, /too little active sanitiser/i, "the explanation is not repeated every turn");
  assert.notEqual(response.payload.reply, firstReply);
});
