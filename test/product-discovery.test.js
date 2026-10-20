// Product-discovery redesign: the four starter quick-prompts are only suggestions — they must
// never be special cases the assistant is otherwise tied to. These tests drive api/chat.js with
// the real fake Shopify catalog (test/fixtures/store.json, captured from testallwater.co.uk) to
// prove that free-form natural-language requests reach real catalog products (or a clear "no
// match") without being forced through the old, narrower quick-prompt-shaped flow, while the
// deterministic readiness gate still asks a genuinely useful follow-up when one is needed.
import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import handler from "../api/chat.js";
import { resetCatalogState } from "../api/_catalog.js";
import { createFakeStore, installWorld, llmReply } from "./fake-store.js";

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.SHOPIFY_CATALOG;
  resetCatalogState();
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

// --- 1. Natural-language product request (no quick-prompt wording, no parameter named) -------

test("natural-language request: a hot tub mentioned in the customer's own words reaches real products, no quick-prompt phrasing needed", async () => {
  const store = createFakeStore();
  installWorld({ store, llm: llmReply("A chlorine and pH check is the right starting point.") });
  const conversation = [];
  let response = await sendTurn(conversation, "I need something to check my hot tub water");
  assert.equal(response.payload.state.waterType, "spa");
  assert.equal(response.payload.ready, false, "one useful follow-up (what to check) is still asked");
  response = await sendTurn(conversation, "Chlorine & pH", response.payload.state);
  assert.equal(response.payload.ready, true);
  assert.ok(response.payload.products?.length, "a real product is recommended from natural phrasing alone");
});

// --- 2. Parameter-only request (no water type at all) -----------------------------------------

test("parameter-only request: naming an unambiguous parameter (PFAS) skips the water-type question entirely", async () => {
  const store = createFakeStore();
  installWorld({ store, llm: llmReply("Here is what the catalog has for that.") });
  const response = await call([{ role: "user", content: "Do you sell PFAS tests?" }]);
  assert.equal(response.payload.ready, true);
  assert.equal(response.payload.state.waterType, null, "water type was never required for this request");
  assert.doesNotMatch(response.payload.reply, /what kind of water/i);
});

// --- 3. Product-specific request (a named product, searched directly by title) ----------------

test("product-specific request: a named product/brand is searched directly, not funnelled through the generic water-type flow", async () => {
  const store = createFakeStore();
  installWorld({ store, llm: llmReply("That's a solid all-round pool and spa kit.") });
  const response = await call([{ role: "user", content: "Do you have the Lovibond Checkit 5 in 1?" }]);
  assert.equal(response.payload.ready, true);
  assert.equal(response.payload.state.waterType, null, "no generic water-type interrogation for a named product");
  assert.doesNotMatch(response.payload.reply, /what kind of water/i);
  assert.ok(response.payload.products?.length, "the real matching product is found");
  assert.ok(
    response.payload.products.some((p) => /checkit/i.test(p.title)),
    "the actual named product (or the closest real match) is what comes back, not an unrelated kit"
  );
});

// --- 4. Water-source + parameter request (both given together, in one natural sentence) -------

test("water-source + parameter request: 'iron in well water' is ready immediately from a single message", async () => {
  const store = createFakeStore();
  installWorld({ store, llm: llmReply("Iron is a common well-water issue — here's what covers it.") });
  const response = await call([{ role: "user", content: "Do you have anything to test iron in well water?" }]);
  assert.equal(response.payload.ready, true);
  assert.equal(response.payload.state.waterType, "well");
  assert.deepEqual(response.payload.readiness.missing, []);
  assert.ok(response.payload.products?.length);
  assert.ok(response.payload.products.some((p) => /iron/i.test(p.reason)), "the real product's own reason mentions iron");
});

// --- 5. No catalog match (a real search that genuinely finds nothing relevant) -----------------

test("no catalog match: a parameter the store does not sell a test for is reported plainly, never a look-alike", async () => {
  const store = createFakeStore();
  installWorld({ store, llm: llmReply("Unused — the deterministic no-match line is what the customer sees.") });
  const response = await call([{ role: "user", content: "I need a radon test for my well water" }]);
  assert.equal(response.payload.ready, true);
  assert.equal(response.payload.products, undefined, "no card is shown for a parameter the catalog does not sell a test for");
  assert.match(response.payload.reply, /no matching product/i);
});

// --- 6. Topic change via a new parameter, not just a new water-type word -----------------------

test("topic change: an unrelated parameter named with switch language is a fresh topic, not stuck on the old pool question", async () => {
  const store = createFakeStore();
  installWorld({ store, llm: llmReply("Nitrate matters most for aquarium or well water — here is what covers it.") });
  const conversation = [];
  let response = await sendTurn(conversation, "My pool water is cloudy");
  response = await sendTurn(conversation, "Chlorine & pH", response.payload.state);
  assert.equal(response.payload.state.waterType, "pool");

  response = await sendTurn(conversation, "Actually, do you sell nitrate tests?", response.payload.state);
  assert.equal(response.payload.state.waterType, null, "the old pool context is cleared, not mixed with an unrelated parameter");
  assert.equal(response.payload.state.issue, null);
  assert.ok(response.payload.state.parameters.includes("nitrate"));
  assert.doesNotMatch(response.payload.reply, /chlorine or pH result|full test|pool/i, "not stuck re-asking the old pool troubleshooting question");
});

// --- 7. Explicit browse-products request (nothing specific at all) -----------------------------

test("explicit browse request: 'I just want to see your water testing products' is never interrogated first", async () => {
  const store = createFakeStore();
  installWorld({ store, llm: llmReply("Here are a few places to start.") });
  const response = await call([{ role: "user", content: "I just want to see your water testing products." }]);
  assert.equal(response.payload.ready, true);
  assert.equal(response.payload.state.waterType, null);
  assert.doesNotMatch(response.payload.reply, /what kind of water/i);
  assert.ok(response.payload.products?.length, "a representative slice of the catalog is shown, not nothing");
});

// --- 8. Vague problem requiring clarification (symptom-inferred parameters stay provisional) ---

test("vague problem: a metallic taste with no water type asks the one genuinely useful follow-up, then finds real products", async () => {
  const store = createFakeStore();
  installWorld({ store, llm: llmReply("Metals from the plumbing are the most common cause.") });
  const conversation = [];
  let response = await sendTurn(conversation, "I need something for metallic tasting water");
  assert.equal(response.payload.ready, false, "a symptom alone does not skip straight to a recommendation");
  assert.equal(response.payload.state.waterType, null);
  assert.match(response.payload.reply, /what kind of water/i, "the one genuinely useful follow-up — which kind of water — is asked, not skipped");

  response = await sendTurn(conversation, "well water", response.payload.state);
  assert.equal(response.payload.state.waterType, "well");
  assert.equal(response.payload.ready, true);
  assert.ok(response.payload.products?.length);
});

// --- 9. The four original quick prompts still work end to end, unaffected by the redesign ------

test("the four original quick-prompt starters each still reach a sensible, non-crashing outcome", async () => {
  for (const prompt of [
    "My pool water is cloudy",
    "I need to test drinking water",
    "My chlorine seems too high",
    "I need a general water test",
  ]) {
    const store = createFakeStore();
    installWorld({ store, llm: llmReply("Here is a sensible starting point.") });
    const response = await call([{ role: "user", content: prompt }]);
    assert.equal(typeof response.payload.reply, "string", `"${prompt}" must still get a real reply`);
    assert.ok(response.payload.reply.length > 0, `"${prompt}" reply must not be empty`);
    assert.ok(Array.isArray(response.payload.options), `"${prompt}" must still offer guided options`);
  }
});

test("quick prompt 'My chlorine seems too high' still asks the water type once (chlorine is ambiguous across pool/spa/drinking)", async () => {
  const response = await call([{ role: "user", content: "My chlorine seems too high" }]);
  assert.equal(response.payload.ready, false);
  assert.equal(response.payload.state.waterType, null);
  assert.match(response.payload.reply, /what kind of water/i);
});

// --- 10. Educational question: answered without being treated as a product request -------------

test("educational question: 'What does pH mean?' gets an answer, not a product pitch", async () => {
  const store = createFakeStore();
  installWorld({ store, llm: llmReply("pH measures how acidic or alkaline your water is, on a 0-14 scale.") });
  const response = await call([{ role: "user", content: "What does pH mean?" }]);
  assert.equal(response.payload.model, "claude-sonnet-5-5", "a real conversational answer, not the deterministic readiness gate");
  assert.equal(response.payload.products, undefined, "no product cards for a pure explanation question");
  assert.ok(!store.calls.some((entry) => entry.path === "/search/suggest.json"), "the catalog is never searched for a pure explanation question");
});

// --- 11. Bare named brand, no explicit "do you have" framing other than the brand + "test" -----

test("bare brand request: 'Do you have Lovibond?' searches the real catalog directly", async () => {
  const store = createFakeStore();
  installWorld({ store, llm: llmReply("Lovibond makes a range of pool and spa kits.") });
  const response = await call([{ role: "user", content: "Do you have Lovibond?" }]);
  assert.equal(response.payload.ready, true);
  assert.equal(response.payload.state.waterType, null);
  assert.ok(response.payload.products?.length, "a real Lovibond product is found");
  assert.ok(response.payload.products.every((p) => /lovibond/i.test(p.vendor)), "every card shown is actually a Lovibond product");
});

// --- 12. Product URL validation on the new (product-specific / browse) retrieval paths ---------

test("product URL validation: every card from a named-product search is a real, validated testallwater.co.uk product URL", async () => {
  const store = createFakeStore();
  installWorld({ store, llm: llmReply("Here is the match.") });
  const response = await call([{ role: "user", content: "Do you have the Lovibond Checkit 5 in 1?" }]);
  assert.ok(response.payload.products?.length);
  for (const p of response.payload.products) {
    assert.match(p.url, /^https:\/\/testallwater\.co\.uk\/products\/[a-z0-9][a-z0-9_-]*$/, `product URL must be a real, validated store URL: ${p.url}`);
    assert.ok(p.price?.display, "price comes from the real store record");
    assert.equal(typeof p.available, "boolean");
  }
});

test("product URL validation: every card from a browse-request search is a real, validated testallwater.co.uk product URL", async () => {
  const store = createFakeStore();
  installWorld({ store, llm: llmReply("Here are a few places to start.") });
  const response = await call([{ role: "user", content: "show me what water test kits you sell" }]);
  assert.ok(response.payload.products?.length);
  for (const p of response.payload.products) {
    assert.match(p.url, /^https:\/\/testallwater\.co\.uk\/products\/[a-z0-9][a-z0-9_-]*$/, `product URL must be a real, validated store URL: ${p.url}`);
  }
});

// --- 13. The exact spec phrasing for a metallic-taste complaint --------------------------------

test("'My water tastes metallic' (exact phrasing): explains briefly, then clarifies source before recommending", async () => {
  const store = createFakeStore();
  installWorld({ store, llm: llmReply("Metals from pipework are the most common cause.") });
  const conversation = [];
  let response = await sendTurn(conversation, "My water tastes metallic.");
  assert.equal(response.payload.ready, false);
  assert.equal(response.payload.state.waterType, null);
  assert.match(response.payload.reply, /what kind of water/i);

  response = await sendTurn(conversation, "it's from my tap", response.payload.state);
  assert.equal(response.payload.state.waterType, "drinking");
  assert.equal(response.payload.ready, true);
  assert.ok(response.payload.products?.length);
});
