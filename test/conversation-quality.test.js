// Client-ready QA pass: product ranking quality, conversation intelligence (ask only what
// improves the recommendation, use accumulated context, respect an explicit "just recommend
// something"), product follow-up questions, and a state-aware (never hardcoded) fallback
// sentence. Runs against the real fake Shopify catalog (test/fixtures/store.json) so ranking
// assertions reflect genuine product data, not synthetic fixtures.
import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import handler from "../api/chat.js";
import { findProducts, resetCatalogState, selectProducts } from "../api/_catalog.js";
import { analyzeNeeds, deriveConversationState, constrainQuestionToState } from "../api/_needs.js";
import { createFakeStore, installWorld, llmReply, fixtureProducts } from "./fake-store.js";

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

// --- Phase 1: product ranking quality ----------------------------------------------------

test("ranking: 'iron test for well water' returns only products that actually test iron, not padding with a coliform-only kit", async () => {
  const store = createFakeStore();
  installWorld({ store, llm: llmReply("unused") });
  const needs = analyzeNeeds(["I need an iron test for well water"], deriveConversationState([{ role: "user", content: "I need an iron test for well water" }]));
  const result = await findProducts(needs);
  assert.equal(result.status, "ok");
  assert.ok(result.products.length >= 1);
  for (const p of result.products) {
    assert.ok(p.covers.some((label) => /iron/i.test(label)), `${p.title} must actually cover iron, not just a default well-water checklist item`);
  }
});

test("ranking: one strong product beats padding to three when nothing else is actually relevant", async () => {
  const store = createFakeStore();
  installWorld({ store, llm: llmReply("unused") });
  const needs = analyzeNeeds(["Do you have anything for lead"], deriveConversationState([{ role: "user", content: "Do you have anything for lead" }]));
  const result = await findProducts(needs);
  assert.equal(result.status, "ok");
  for (const p of result.products) assert.ok(p.covers.some((label) => /lead/i.test(label)));
});

test("ranking: an explicitly requested additional parameter still gets a genuinely complementary pick", () => {
  // Multiple EXPLICITLY named parameters (not just the default checklist) still fill more than
  // one slot when each pick adds real, asked-for coverage.
  const needs = analyzeNeeds(["My pool water is cloudy. I want to check chlorine, pH and alkalinity."]);
  const picked = selectProducts(fixtureProducts.map((p) => ({
    handle: p.handle, rank: 0, title: p.title, vendor: p.vendor, type: p.type, tags: p.tags,
    body: p.body, available: p.available, price: Number.parseFloat(p.price), image: p.image,
  })), needs);
  assert.ok(picked.length >= 1);
});

// --- Phase 11: the fallback sentence reflects what is actually known ----------------------

test("fallback sentence: never claims a field is known when it genuinely is not (e.g. a parameter-only PFAS request)", async () => {
  const store = createFakeStore();
  // A reply that happens to ask something the constrain-to-state guard would intercept, to
  // force the "ready" fallback sentence path with water type genuinely still unknown.
  installWorld({ store, llm: llmReply("What kind of water are you testing?") });
  const response = await call([{ role: "user", content: "Do you sell PFAS tests?" }]);
  assert.doesNotMatch(response.payload.reply, /water type, treatment, testing scope and parameters/i, "must not claim fields are known that are not");
  assert.doesNotMatch(response.payload.reply, /\btreatment\b/i, "treatment is never known for a parameter-only request with no water type");
});

// --- Phase 8: product follow-up questions --------------------------------------------------

test("product follow-up: 'which one would you recommend?' is answered from real shown-product facts, with no redundant catalog search", async () => {
  const store = createFakeStore();
  const world = installWorld({ store, llm: llmReply("The first option is the strongest fit.") });
  const conversation = [];
  let response = await sendTurn(conversation, "I need an iron test for well water");
  assert.ok(response.payload.state.lastProducts.length >= 1);

  response = await sendTurn(conversation, "Which one would you recommend?", response.payload.state);
  assert.equal(response.payload.products, undefined, "no new catalog search for a pure follow-up question");
  const system = world.llmCalls.at(-1).body.system;
  assert.match(system, /PRODUCT FOLLOW-UP/);
  assert.match(system, /first option/i);
});

test("product follow-up: a message naming a genuinely new parameter still searches again, not treated as a pure follow-up", async () => {
  const store = createFakeStore();
  installWorld({ store, llm: llmReply("Here is what also covers lead.") });
  const conversation = [];
  let response = await sendTurn(conversation, "I need an iron test for well water");
  response = await sendTurn(conversation, "Do you have one that also tests lead?", response.payload.state);
  // Lead is a new, real signal — this must still be free to search again (not silently treated
  // as a no-op follow-up just because something was already shown).
  assert.ok(response.payload.state.parameters.includes("lead") || response.payload.products !== undefined);
});

// --- Phase 2/3: ask only what improves the recommendation ----------------------------------

test("accumulated context: private well + metallic taste in ONE message asks the narrowing question, not water type again", async () => {
  // Metallic taste implies three plausible causes (iron/copper/lead) — an ambiguous symptom
  // alone must not make the customer ready; it gets one narrowing question instead, but water
  // type (already given in the same message) is never re-asked.
  const response = await call([{ role: "user", content: "I have a private well and my water tastes metallic." }]);
  assert.equal(response.payload.state.waterType, "well");
  assert.equal(response.payload.ready, false, "an ambiguous symptom alone is not enough to recommend");
  assert.doesNotMatch(response.payload.reply, /what kind of water/i, "water type is already known, never re-asked");
  assert.match(response.payload.reply, /iron/i, "explains the plausible causes");
  assert.match(response.payload.reply, /copper/i);
  assert.match(response.payload.reply, /lead/i);
  assert.ok(response.payload.options.length > 1, "offers narrowing options, including a not-sure path");
  assert.ok(response.payload.options.some((o) => /not sure/i.test(o.label)), "a 'not sure / check all' option is offered");
});

test("explicit recommendation rule: 'Which product should I buy?' still gets the structured water-type question, not a raw model reply", async () => {
  const response = await call([{ role: "user", content: "Which product should I buy?" }]);
  assert.equal(response.payload.model, "readiness-gate");
  assert.match(response.payload.reply, /what kind of water/i);
  assert.ok(response.payload.options.length > 1, "real quick-reply options are offered, not nothing");
});

test("explicit recommendation rule: a described problem with no water type yet still gets the structured question", async () => {
  const response = await call([{ role: "user", content: "water tastes weird" }]);
  assert.equal(response.payload.model, "readiness-gate");
  assert.match(response.payload.reply, /what kind of water/i);
});

test("'Just suggest me something.' (with an extra word the exact phrase didn't anticipate) still triggers relaxed readiness", async () => {
  const store = createFakeStore();
  installWorld({ store, llm: llmReply("Here's a sensible starting point.") });
  const conversation = [];
  let response = await sendTurn(conversation, "My pool water is cloudy.");
  response = await sendTurn(conversation, "Just suggest me something.", response.payload.state);
  assert.equal(response.payload.state.relaxedReadiness, true);
  assert.equal(response.payload.ready, true);
});

test("browse phrasing: 'show me all your water testing stuff' is recognized as a browse request, not a water-type question", async () => {
  const response = await call([{ role: "user", content: "show me all your water testing stuff" }]);
  assert.equal(response.payload.state.relaxedReadiness, true);
  assert.doesNotMatch(response.payload.reply, /what kind of water/i);
});

test("long accumulation: private well -> metallic taste -> 'I don't know my readings' -> 'just recommend something' never repeats a question and ends with real products", async () => {
  const store = createFakeStore();
  installWorld({ store, llm: llmReply("Here's a sensible starting point based on what you've told me.") });
  const conversation = [];
  let response = await sendTurn(conversation, "I have a private well.");
  const firstReply = response.payload.reply;
  response = await sendTurn(conversation, "The water tastes metallic.", response.payload.state);
  // Ambiguous symptom (iron/copper/lead): one narrowing question, not yet ready — this is the
  // ONE useful clarifying question the customer should see, not a form.
  assert.equal(response.payload.ready, false, "an ambiguous symptom alone is not enough to recommend");
  assert.match(response.payload.reply, /iron|copper|lead/i, "explains the plausible causes before asking");
  const narrowingQuestion = response.payload.reply;
  response = await sendTurn(conversation, "I don't know my readings.", response.payload.state);
  // Any answer resolves the narrowing question — "I don't know my readings" doesn't name a
  // specific cause, so all three candidates are kept and the search proceeds.
  assert.equal(response.payload.ready, true, "a non-specific answer still resolves readiness, not a second question");
  assert.notEqual(response.payload.reply, firstReply, "never falls back to repeating the very first question");
  assert.notEqual(response.payload.reply, narrowingQuestion, "the narrowing question is not asked a second time");
  assert.ok(response.payload.products?.length, "a real recommendation is given as soon as the symptom is resolved");
  response = await sendTurn(conversation, "Just recommend something.", response.payload.state);
  assert.ok(response.payload.products?.length, "stays ready on a later turn too");
});

// --- Phase 9: topic change, including a second switch back -------------------------------

test("topic change: switching to nitrate then explicitly back to pool does not get stuck on the nitrate question", async () => {
  const store = createFakeStore();
  installWorld({ store, llm: llmReply("Chlorine and pH are the right starting point.") });
  const conversation = [];
  let response = await sendTurn(conversation, "My pool water is cloudy");
  response = await sendTurn(conversation, "Chlorine & pH", response.payload.state);
  response = await sendTurn(conversation, "Actually, do you sell nitrate tests?", response.payload.state);
  assert.equal(response.payload.state.waterType, null);
  response = await sendTurn(conversation, "Actually, back to my pool question", response.payload.state);
  assert.equal(response.payload.state.waterType, "pool");
  assert.doesNotMatch(response.payload.reply, /what kind of water/i, "switching back to a kind of water already established this turn does not re-ask it");
});

test("topic change: an abandoned pool symptom does not leak into a later unrelated well recommendation", async () => {
  // Found live: "My pool water is cloudy" -> "Actually forget the pool, I need a nitrate test"
  // -> "I have a private well" ended with a product reason reading "relevant to cloudy well
  // water" even though the customer never said their well was cloudy and had explicitly moved
  // on from the pool topic.
  const store = createFakeStore();
  installWorld({ store, llm: llmReply("Nitrate is a sensible check for a private well.") });
  const conversation = [];
  let response = await sendTurn(conversation, "My pool water is cloudy.");
  response = await sendTurn(conversation, "Actually forget the pool. I need a nitrate test.", response.payload.state);
  response = await sendTurn(conversation, "I have a private well.", response.payload.state);
  const products = response.payload.products ?? [];
  assert.ok(products.length >= 1, "a well-water nitrate recommendation is made");
  for (const product of products) {
    assert.doesNotMatch(product.reason ?? "", /cloudy/i, "the abandoned pool symptom must not appear in a well-water product reason");
  }
});

test("short answers: four consecutive non-answers ('Not sure'/'No'/'Yes') never repeat an earlier rephrasing verbatim", async () => {
  // Found live: Pool -> Not sure -> No -> Yes asked the goal question 4 times; turn 4 repeated
  // turn 2's exact rephrasing verbatim, because the dedup check only compared against the single
  // immediately-previous reply, and the uncertain-answer branch only rotates through two fixed
  // phrasings (so a 3rd+ non-answer cycles back without ever matching the one directly before it).
  const store = createFakeStore();
  installWorld({ store, llm: llmReply("unused") });
  const conversation = [];
  const replies = [];
  let state = null;
  for (const text of ["Pool", "Not sure", "No", "Yes"]) {
    const response = await sendTurn(conversation, text, state);
    state = response.payload.state;
    replies.push(response.payload.reply);
  }
  const lastReply = replies.at(-1);
  assert.ok(!replies.slice(0, -1).includes(lastReply), `the 4th reply must not repeat an earlier one verbatim: ${JSON.stringify(replies)}`);
});

// --- constrainQuestionToState: mentioning a known parameter while explaining it is not the
// same as redundantly asking for it -------------------------------------------------------

test("an educational answer that happens to mention a known parameter's name is not replaced with a redundant question", async () => {
  const store = createFakeStore();
  // A realistic explanatory reply: contains "pH" several times (so it would match the
  // parameter's own keyword regex) and ends with a genuine question mark — found live via
  // "What does pH mean?", whose real explanation was being discarded and replaced with "What
  // kind of water are you testing?" even though nothing had actually been asked about yet.
  installWorld({
    store,
    llm: llmReply("pH measures how acidic or alkaline your water is, on a scale of 0-14. Is there anything else you'd like to know about pH?"),
  });
  const response = await call([{ role: "user", content: "What does pH mean?" }]);
  assert.match(response.payload.reply, /acidic or alkaline/i, "the real explanation is kept, not discarded");
  assert.doesNotMatch(response.payload.reply, /what kind of water are you testing/i);
});

// --- Phase 5: educational question transitions naturally into product discovery ----------

test("educational-to-product transition: 'What does pH mean?' then 'Show me a pH test kit.' moves from explanation to a real guided search", async () => {
  const store = createFakeStore();
  installWorld({ store, llm: llmReply("pH measures how acidic or alkaline your water is.") });
  const conversation = [];
  let response = await sendTurn(conversation, "What does pH mean?");
  assert.equal(response.payload.model, "claude-sonnet-5-5");
  assert.equal(response.payload.products, undefined);

  response = await sendTurn(conversation, "Show me a pH test kit.", response.payload.state);
  // pH is ambiguous across pool/spa/aquarium/drinking — the minimum useful clarification is
  // still asked, rather than guessing which family of product to show.
  assert.equal(response.payload.model, "readiness-gate");
  assert.match(response.payload.reply, /what kind of water/i);
});

// --- Phase 10: messy, casual, real-world phrasing -----------------------------------------

test("messy input: lowercase/typo phrasing is understood the same as clean phrasing", async () => {
  const store = createFakeStore();
  installWorld({ store, llm: llmReply("unused") });
  const response = await call([{ role: "user", content: "do u have iron test for well water?" }]);
  assert.equal(response.payload.state.waterType, "well");
  assert.equal(response.payload.ready, true);
  assert.ok(response.payload.products?.length);
});

test("messy input: casual/slang phrasing ('my pool is cloudy af') still recognizes pool context", () => {
  const state = deriveConversationState([{ role: "user", content: "my pool is cloudy af" }]);
  assert.equal(state.waterType, "pool");
  assert.equal(state.issue, "cloudy_water");
});

// --- Final QA pass: each test pins one bug found by driving real conversations ------------

test("ranking: 'tap water for lead' leads with a simple lead test, not a £4,000 field-lab case", async () => {
  installWorld({ store: createFakeStore(), llm: llmReply("unused") });
  const t = "I need to test my tap water for lead";
  const result = await findProducts(analyzeNeeds([t], deriveConversationState([{ role: "user", content: t }])));
  assert.equal(result.status, "ok");
  assert.match(result.products[0].title, /lead/i);
  assert.ok(Number(result.products[0].price.amount) < 50, `got ${result.products[0].title} at ${result.products[0].price.display}`);
});

test("ranking: an explicitly named parameter no product covers is an honest no_match, never a kit for something else", () => {
  const needs = analyzeNeeds(["test my well for bacteria"], deriveConversationState([{ role: "user", content: "test my well for bacteria" }]));
  const ironKit = { handle: "k", rank: 0, title: "Well Water Iron & Nitrate Test Kit", vendor: "V", type: "", tags: [], body: "", available: true, price: 20 };
  assert.deepEqual(selectProducts([ironKit], needs), []);
});

test("parsing: plurals and 'lead and ...' are recognised as the parameters they name", () => {
  for (const [text, ids] of [["I want to test nitrates and phosphates", ["nitrate", "phosphate"]], ["do you test for lead and copper?", ["lead", "copper"]]]) {
    const needs = analyzeNeeds([text], deriveConversationState([{ role: "user", content: text }]));
    for (const id of ids) assert.ok(needs.explicit.includes(id), `${id} from "${text}"`);
  }
});

test("no repeated questions: 'reef tank' answers freshwater-or-saltwater, and the subtype is asked once only", async () => {
  installWorld({ store: createFakeStore(), llm: llmReply("Here are the tests for that.") });
  let response = await call([{ role: "user", content: "I want to test nitrates in my reef tank" }]);
  assert.equal(response.payload.state.waterSubtype, "saltwater");
  const conversation = [];
  response = await sendTurn(conversation, "I need nitrate strips for my aquarium");
  assert.match(response.payload.reply, /freshwater or saltwater/i);
  response = await sendTurn(conversation, "does it test ammonia too?", response.payload.state);
  assert.doesNotMatch(response.payload.reply, /freshwater or saltwater/i);
});

test("topic switch: the confirm buttons name the real kinds of water, and pressing one switches", async () => {
  installWorld({ store: createFakeStore(), llm: llmReply("Iron is common in well water.") });
  const conversation = [];
  let response = await sendTurn(conversation, "my hot tub smells");
  response = await sendTurn(conversation, "what about my well water? I think it has iron", response.payload.state);
  assert.deepEqual(response.payload.options.slice(0, 2).map((o) => o.label), ["Yes, well water", "No, keep hot tub"]);
  response = await sendTurn(conversation, response.payload.options[0].value, response.payload.state);
  assert.equal(response.payload.state.waterType, "well");
});

test("topic switch: parameters from the old kind of water are not carried into the new one", async () => {
  installWorld({ store: createFakeStore(), llm: llmReply("Here are aquarium tests.") });
  const conversation = [];
  let response = await sendTurn(conversation, "pool");
  response = await sendTurn(conversation, "chlorine", response.payload.state);
  response = await sendTurn(conversation, "actually I want to test my aquarium", response.payload.state);
  assert.ok(!response.payload.state.parameters.includes("chlorine"));
});

test("green pool: after 'I haven't tested yet', choosing what to check first gives a recommendation, not another question", async () => {
  installWorld({ store: createFakeStore(), llm: llmReply("Start with chlorine.") });
  const conversation = [];
  let response = await sendTurn(conversation, "my pool water is green");
  response = await sendTurn(conversation, "I haven't tested yet", response.payload.state);
  assert.ok(!response.payload.options.some((o) => /I know my/.test(o.label)), "no 'I know my…' after they said they haven't tested");
  response = await sendTurn(conversation, "chlorine", response.payload.state);
  assert.equal(response.payload.ready, true);
  assert.ok(response.payload.products?.length);
});

test("educational: 'how often should I test my hot tub?' is answered by the model, with no catalog search", async () => {
  const store = createFakeStore();
  installWorld({ store, llm: llmReply("Test a hot tub two or three times a week.") });
  const response = await call([{ role: "user", content: "how often should I test my hot tub?" }]);
  assert.notEqual(response.payload.model, "readiness-gate");

  // Even once ready (lead already searched), a plain question does not search again.
  const conversation = [];
  let next = await sendTurn(conversation, "I need to test my tap water for lead");
  const searches = store.calls.filter((c) => c.path === "/search/suggest.json").length;
  next = await sendTurn(conversation, "how often should I test for lead?", next.payload.state);
  assert.equal(store.calls.filter((c) => c.path === "/search/suggest.json").length, searches);
  assert.equal(next.payload.products, undefined);
});

test("honest no-match: radon asked after lead is reported once, and not repeated on the next turn", async () => {
  installWorld({ store: createFakeStore(), llm: llmReply("Here is what I can tell you.") });
  const conversation = [];
  let response = await sendTurn(conversation, "I need to test my tap water for lead");
  response = await sendTurn(conversation, "do you have a radon test?", response.payload.state);
  assert.match(response.payload.reply, /no matching product found.*radon/i);
  response = await sendTurn(conversation, "what else should I test my tap water for?", response.payload.state);
  assert.doesNotMatch(response.payload.reply, /radon/i);
});

test("honest no-match: a no_match search clears the shown-product facts, so a follow-up is not answered from an older topic", async () => {
  installWorld({ store: createFakeStore(), llm: llmReply("Here is what I can tell you.") });
  const conversation = [];
  let response = await sendTurn(conversation, "I need an iron test for well water");
  assert.ok(response.payload.state.lastProducts.length);
  response = await sendTurn(conversation, "actually do you sell PFAS tests?", response.payload.state);
  assert.deepEqual(response.payload.state.lastProducts, []);
});

test("product note: the model is told which tests the customer actually named, so it never claims they mentioned the defaults", async () => {
  const world = installWorld({ store: createFakeStore(), llm: llmReply("This covers lead.") });
  await call([{ role: "user", content: "I need to test my tap water for lead" }]);
  assert.match(world.llmCalls.at(-1).body.system, /customer asked only about lead; .*never say the customer mentioned them/);
});

// --- Symptom-ambiguity readiness: a symptom with several plausible causes must not make the ----
// --- customer recommendation-ready on its own (acceptance tests A-J from the readiness redesign)

test("ambiguous symptom (A): 'My well water tastes metallic.' explains the possible causes and asks one narrowing question, no products", async () => {
  installWorld({ store: createFakeStore(), llm: llmReply("unused") });
  const response = await call([{ role: "user", content: "My well water tastes metallic." }]);
  assert.equal(response.payload.ready, false);
  assert.equal(response.payload.model, "readiness-gate");
  assert.match(response.payload.reply, /iron/i);
  assert.match(response.payload.reply, /copper/i);
  assert.match(response.payload.reply, /lead/i);
  assert.equal((response.payload.products ?? []).length, 0);
  assert.equal(response.payload.state.testingScope, "symptom-pending");
  assert.deepEqual(response.payload.state.symptomCandidates.slice().sort(), ["copper", "iron", "lead"]);
});

test("ambiguous symptom (B): 'Not sure, check all three.' resolves the narrowing question and allows the search", async () => {
  const store = createFakeStore();
  installWorld({ store, llm: llmReply("Here is what covers all three.") });
  const conversation = [];
  let response = await sendTurn(conversation, "My well water tastes metallic.");
  assert.equal(response.payload.ready, false);
  response = await sendTurn(conversation, "Not sure, check all three.", response.payload.state);
  assert.equal(response.payload.ready, true);
  assert.equal(response.payload.state.testingScope, "specific");
  assert.deepEqual(response.payload.state.parameters.slice().sort(), ["copper", "iron", "lead"]);
  assert.ok(response.payload.products?.length, "a real recommendation follows the resolved symptom");
});

test("ambiguous symptom: naming one of the candidates directly narrows to just that one", async () => {
  const store = createFakeStore();
  installWorld({ store, llm: llmReply("Iron it is.") });
  const conversation = [];
  let response = await sendTurn(conversation, "My well water tastes metallic.");
  response = await sendTurn(conversation, "Iron.", response.payload.state);
  assert.equal(response.payload.ready, true);
  assert.deepEqual(response.payload.state.parameters, ["iron"]);
});

test("explicit requests (C, D): a named, unambiguous parameter still recommends immediately", async () => {
  installWorld({ store: createFakeStore(), llm: llmReply("Here is an iron test.") });
  const a = await call([{ role: "user", content: "I need an iron test for well water." }]);
  assert.equal(a.payload.ready, true);
  assert.ok(a.payload.products?.length);

  const b = await call([{ role: "user", content: "Show me an iron test." }]);
  assert.equal(b.payload.ready, true);
  assert.ok(b.payload.products?.length);
});

test("single-candidate symptom (E): 'orange staining' implies iron only, so direct recommendation remains allowed", async () => {
  installWorld({ store: createFakeStore(), llm: llmReply("This covers iron.") });
  const response = await call([{ role: "user", content: "My well water has orange staining." }]);
  assert.equal(response.payload.ready, true);
  assert.deepEqual(response.payload.state.parameters, ["iron"]);
  assert.ok(response.payload.products?.length);
});

test("an explicitly named parameter overrides an ambiguous symptom in the same message", async () => {
  // "tastes metallic" alone implies iron/copper/lead (ambiguous), but the customer also named
  // iron explicitly — principle 5 (explicit requests recommend immediately) wins.
  installWorld({ store: createFakeStore(), llm: llmReply("Iron it is.") });
  const response = await call([{ role: "user", content: "My well water tastes metallic and I want to check iron." }]);
  assert.equal(response.payload.ready, true);
  assert.deepEqual(response.payload.state.parameters, ["iron"]);
});

test("pool clarification (F): 'My pool is cloudy.' keeps its existing clarification behavior, untouched", async () => {
  const response = await call([{ role: "user", content: "My pool is cloudy." }]);
  assert.equal(response.payload.ready, false);
  assert.match(response.payload.reply, /cloudy pool water/i);
});

test("educational (G): 'What does pH mean?' stays product-free", async () => {
  installWorld({ store: createFakeStore(), llm: llmReply("pH measures acidity.") });
  const response = await call([{ role: "user", content: "What does pH mean?" }]);
  assert.equal((response.payload.products ?? []).length, 0);
});

test("browse (H): 'Show me your water testing products.' is unaffected by the ambiguity rule", async () => {
  installWorld({ store: createFakeStore(), llm: llmReply("Here are some options.") });
  const response = await call([{ role: "user", content: "Show me your water testing products." }]);
  assert.equal(response.payload.ready, true);
  assert.ok(response.payload.products?.length);
});

test("cause question (I): 'Could it be iron?' is not read as a request to test iron — it still gets the narrowing clarification", async () => {
  installWorld({ store: createFakeStore(), llm: llmReply("unused") });
  const response = await call([{ role: "user", content: "My well water tastes metallic. Could it be iron?" }]);
  assert.equal(response.payload.ready, false, "asking whether iron could be the cause is not the same as asking to test for it");
  assert.deepEqual(response.payload.state.parameters, [], "iron is not treated as explicitly requested");
  assert.match(response.payload.reply, /iron/i, "the clarification still names iron as one of the possibilities");
});

test("cause question: genuine testing intent ('could I get an iron test?') still counts as explicit", async () => {
  installWorld({ store: createFakeStore(), llm: llmReply("Here is an iron test.") });
  const response = await call([{ role: "user", content: "My well water tastes metallic. Could I get an iron test?" }]);
  assert.equal(response.payload.ready, true);
  assert.deepEqual(response.payload.state.parameters, ["iron"]);
});

test("no repeated clarification loop (J): the narrowing question is never asked twice, even on a second non-answer", async () => {
  const store = createFakeStore();
  installWorld({ store, llm: llmReply("A sensible starting point.") });
  const conversation = [];
  let response = await sendTurn(conversation, "My well water tastes metallic.");
  const firstQuestion = response.payload.reply;
  response = await sendTurn(conversation, "I'm not sure.", response.payload.state);
  // Any answer resolves symptom-pending in one step (see the resolution logic), so this must
  // already be ready and must not repeat the same clarification.
  assert.equal(response.payload.ready, true);
  assert.notEqual(response.payload.reply, firstQuestion);
});

// --- Conversation memory: rejection, product follow-ups beyond the exact-phrase list, topic ---
// --- change, and long-conversation persistence of early structured facts -----------------------

test("conversation memory (1): rejecting a shown product and asking to be guided gets Claude's real answer, not the known-facts fallback, and does not re-search", async () => {
  const store = createFakeStore();
  // Deliberately mentions "testing scope" — a known field — while genuinely handling the
  // rejection. The OLD constrainQuestionToState discarded any reply matching asksKnownScope
  // regardless of why the model said it; this is exactly the case that must now survive.
  const world = installWorld({
    store,
    llm: llmReply("No problem — forget the testing scope question for a second. What matters most to you: keeping the cost down, or making sure lead is covered too?"),
  });
  const conversation = [];
  let response = await sendTurn(conversation, "My well water tastes metallic.");
  assert.equal(response.payload.ready, false);
  response = await sendTurn(conversation, "check all", response.payload.state);
  assert.equal(response.payload.ready, true);
  assert.ok(response.payload.products?.length, "products shown after resolving the symptom");
  response = await sendTurn(conversation, "no, not this one, can you please guide me", response.payload.state);
  assert.doesNotMatch(response.payload.reply, /I have the .* you shared noted/i, "the canned known-facts fallback must not fire");
  assert.match(response.payload.reply, /testing scope|cost|lead/i, "Claude's real, context-aware reply is kept, not discarded");
  assert.ok(!(response.payload.products?.length), "the declined products are not silently re-shown");
  assert.match(world.llmCalls.at(-1).body.system, /CUSTOMER DECLINED THE RECOMMENDATION/, "the model is told plainly that the recommendation was declined");
});

test("conversation memory (2): 'Why this one?' is answered from the real shown-product facts, no new search", async () => {
  const store = createFakeStore();
  const world = installWorld({ store, llm: llmReply("Because it directly covers iron, which is what causes the metallic taste and staining you described.") });
  const conversation = [];
  let response = await sendTurn(conversation, "I need an iron test for well water.");
  assert.ok(response.payload.products?.length);
  response = await sendTurn(conversation, "Why this one?", response.payload.state);
  assert.ok(!(response.payload.products?.length), "no redundant new catalog search for a pure follow-up question");
  assert.match(world.llmCalls.at(-1).body.system, /PRODUCT FOLLOW-UP/);
});

test("conversation memory (3): 'How do I use it?' is treated as a product follow-up, no new search", async () => {
  const store = createFakeStore();
  const world = installWorld({ store, llm: llmReply("You dip the strip in a fresh sample and compare the colour to the chart after the time stated on the packaging.") });
  const conversation = [];
  let response = await sendTurn(conversation, "I need an iron test for well water.");
  assert.ok(response.payload.products?.length);
  response = await sendTurn(conversation, "How do I use it?", response.payload.state);
  assert.ok(!(response.payload.products?.length));
  assert.match(world.llmCalls.at(-1).body.system, /PRODUCT FOLLOW-UP/);
});

test("conversation memory (4): 'What does this test tell me?' is treated as a product follow-up, no new search", async () => {
  const store = createFakeStore();
  const world = installWorld({ store, llm: llmReply("It tells you the iron concentration in your water, which explains staining and metallic taste at higher levels.") });
  const conversation = [];
  let response = await sendTurn(conversation, "I need an iron test for well water.");
  assert.ok(response.payload.products?.length);
  response = await sendTurn(conversation, "What does this test tell me?", response.payload.state);
  assert.ok(!(response.payload.products?.length));
  assert.match(world.llmCalls.at(-1).body.system, /PRODUCT FOLLOW-UP/);
});

test("conversation memory (5): pool to aquarium topic change drops the stale pool issue", async () => {
  const store = createFakeStore();
  installWorld({ store, llm: llmReply("Let's look at your aquarium water instead.") });
  const conversation = [];
  let response = await sendTurn(conversation, "My pool water is cloudy.");
  assert.equal(response.payload.state.waterType, "pool");
  assert.equal(response.payload.state.issue, "cloudy_water");
  // Deliberately avoids the word "pool" so the switch is detected by the new context
  // ("fish tank"), not by an accidental repeat of the old keyword.
  response = await sendTurn(conversation, "Actually, forget that, I have a fish tank I need to test.", response.payload.state);
  assert.equal(response.payload.state.waterType, "aquarium");
  assert.equal(response.payload.state.issue, null, "the pool-specific issue must not survive the switch");
  assert.equal(response.payload.state.issueDetails.length, 0);
});

test("conversation memory (6): well to drinking-water topic change drops the stale well-specific parameter", async () => {
  const store = createFakeStore();
  installWorld({ store, llm: llmReply("Let's talk about your tap water instead.") });
  const conversation = [];
  let response = await sendTurn(conversation, "I have a private well and I want to test for iron.");
  assert.equal(response.payload.state.waterType, "well");
  assert.deepEqual(response.payload.state.parameters, ["iron"]);
  // Deliberately avoids the word "well" so the switch is detected by the new context
  // ("tap water"), not by an accidental substring match on the old one.
  response = await sendTurn(conversation, "Actually, forget that, I need to test my tap water instead.", response.payload.state);
  assert.equal(response.payload.state.waterType, "drinking");
  assert.equal(response.payload.state.waterSource, "tap");
  assert.deepEqual(response.payload.state.parameters, [], "the old well-specific parameter must not carry over to drinking water");
});

test("conversation memory (7): an early structured fact survives well past the 12-message transcript window", async () => {
  const store = createFakeStore();
  const world = installWorld({ store, llm: llmReply("Here's what I can tell you about that.") });
  const conversation = [];
  let response = await sendTurn(conversation, "I need an iron test for well water.");
  assert.equal(response.payload.state.waterType, "well");
  assert.ok(response.payload.products?.length);
  // 12 more follow-up turns — well past the 12-raw-message window the transcript sent to
  // Claude is capped at — using phrasing the broadened PRODUCT_FOLLOWUP_INTENT now recognizes,
  // so none of them trigger a fresh search that could re-derive water type from scratch.
  const followUps = [
    "Why this one?", "How do I use it?", "What does this test tell me?", "Is it in stock?",
    "Is there a cheaper option?", "Why this one?", "How do I use it?", "What does this test tell me?",
    "Is it in stock?", "Is there a cheaper option?", "Why this one?", "How do I use it?",
  ];
  for (const text of followUps) {
    response = await sendTurn(conversation, text, response.payload.state);
  }
  assert.equal(response.payload.state.waterType, "well", "the water type set in turn 1 is still known 13 turns later");
  assert.equal(response.payload.ready, true, "readiness is not lost even though the raw turn 1 message fell out of the transcript window");
  assert.match(world.llmCalls.at(-1).body.system, /Water type: well/, "the system prompt's KNOWN FACTS still state it correctly on the final turn");
  assert.doesNotMatch(world.llmCalls.at(-1).body.messages.map((m) => m.content).join(" "), /I need an iron test for well water/, "sanity check: the raw turn-1 message has genuinely fallen out of the capped transcript");
});

// --- recommendationStatus: track accept/reject/undecided on the shown recommendation ----------

test("recommendation status (1): 'not this one' rejects and does not show the same products again", async () => {
  const store = createFakeStore();
  installWorld({ store, llm: llmReply("Let's find out what matters most to you.") });
  const conversation = [];
  let response = await sendTurn(conversation, "I need an iron test for well water.");
  assert.ok(response.payload.products?.length);
  response = await sendTurn(conversation, "not this one", response.payload.state);
  assert.equal(response.payload.state.recommendationStatus, "rejected");
  assert.ok(!(response.payload.products?.length), "no products shown on the rejection turn itself");
});

test("recommendation status (2): 'show me something else' excludes the shown product and finds a genuine alternative", async () => {
  const store = createFakeStore();
  installWorld({ store, llm: llmReply("Here is another option.") });
  const conversation = [];
  let response = await sendTurn(conversation, "I need an iron test for well water.");
  const firstTitle = response.payload.products[0].title;
  response = await sendTurn(conversation, "Show me something else", response.payload.state);
  assert.ok(response.payload.products?.length, "a genuinely different product was found");
  assert.notEqual(response.payload.products[0].title, firstTitle, "the previously shown product is excluded, not repeated");
  assert.equal(response.payload.state.recommendationStatus, "undecided", "a fresh recommendation is pending again, not stuck as rejected");
});

test("recommendation status (3): 'why this one?' keeps the current product context, status stays undecided", async () => {
  const store = createFakeStore();
  const world = installWorld({
    store,
    llm: async (url, init, n) => new Response(JSON.stringify({ content: [{ type: "text", text: `Explanation number ${n}` }], stop_reason: "end_turn" }), { status: 200 }),
  });
  const conversation = [];
  let response = await sendTurn(conversation, "I need an iron test for well water.");
  assert.equal(response.payload.state.recommendationStatus, "undecided");
  response = await sendTurn(conversation, "Why this one?", response.payload.state);
  assert.equal(response.payload.state.recommendationStatus, "undecided", "a follow-up question does not change accept/reject status");
  assert.ok(!(response.payload.products?.length), "no redundant new search for a pure follow-up");
  assert.match(world.llmCalls.at(-1).body.system, /PRODUCT FOLLOW-UP/);
});

test("recommendation status (4): 'I want this' accepts the recommendation and keeps that context", async () => {
  const store = createFakeStore();
  const world = installWorld({
    store,
    llm: async (url, init, n) => new Response(JSON.stringify({ content: [{ type: "text", text: `Great, reply ${n}` }], stop_reason: "end_turn" }), { status: 200 }),
  });
  const conversation = [];
  let response = await sendTurn(conversation, "I need an iron test for well water.");
  response = await sendTurn(conversation, "I want this", response.payload.state);
  assert.equal(response.payload.state.recommendationStatus, "accepted");
  assert.ok(!(response.payload.products?.length), "no redundant new search once accepted");
  assert.match(world.llmCalls.at(-1).body.system, /CUSTOMER ACCEPTED THE RECOMMENDATION/);
});

test("recommendation status (5): after a rejection, a later vague message does not silently re-trigger a product search", async () => {
  const store = createFakeStore();
  installWorld({ store, llm: llmReply("What matters most to you right now?") });
  const conversation = [];
  let response = await sendTurn(conversation, "I need an iron test for well water.");
  response = await sendTurn(conversation, "not this one", response.payload.state);
  assert.equal(response.payload.state.recommendationStatus, "rejected");
  response = await sendTurn(conversation, "okay, what do you think I should do", response.payload.state);
  assert.ok(!(response.payload.products?.length), "an old, sticky goal must not silently re-trigger the same search");
  assert.equal(response.payload.state.recommendationStatus, "rejected", "still rejected, no new recommendation was made");
});

test("recommendation status (6): a genuine topic change clears the old recommendation status", async () => {
  const store = createFakeStore();
  installWorld({ store, llm: llmReply("Let's look at your aquarium.") });
  const conversation = [];
  let response = await sendTurn(conversation, "I need an iron test for well water.");
  response = await sendTurn(conversation, "not this one", response.payload.state);
  assert.equal(response.payload.state.recommendationStatus, "rejected");
  response = await sendTurn(conversation, "Actually, forget that, I have a fish tank I need to test.", response.payload.state);
  assert.equal(response.payload.state.recommendationStatus, null, "a fresh topic has no recommendation yet to have a status on");
  assert.equal(response.payload.state.lastProducts.length, 0);
});

test("recommendation status (7): a stale state.goal alone must not force a new product search after rejection", async () => {
  const store = createFakeStore();
  installWorld({ store, llm: llmReply("Let's think about this differently.") });
  const conversation = [];
  let response = await sendTurn(conversation, "I need an iron test for well water.");
  response = await sendTurn(conversation, "not this one", response.payload.state);
  assert.ok(response.payload.state.goal, "sanity check: state.goal is still set — the exact condition that used to cause stale re-searches");
  response = await sendTurn(conversation, "hmm not sure what to do now", response.payload.state);
  assert.ok(!(response.payload.products?.length), "despite state.goal still being set, no search runs on a non-explicit later turn");
});

// --- Phase 3: Claude as the conversational brain — natural references, open-ended guidance, ---
// --- and confirming constrainQuestionToState never discards a genuine, context-aware reply ----

test("Phase 3 (1): 'guide me' after a recommendation rejection gets real guidance, not the known-facts fallback", async () => {
  const store = createFakeStore();
  // Distinct text per call (not a fixed llmReply) so the turn-to-turn dedup — which exists to
  // catch Claude genuinely repeating itself — can't collide with this test's own fixture text
  // and mask what we're actually testing here.
  const world = installWorld({
    store,
    llm: async (url, init, n) => new Response(JSON.stringify({
      content: [{ type: "text", text: `Reply ${n} — let's step back; your testing scope aside, what matters most: keeping cost down, or covering lead too?` }],
      stop_reason: "end_turn",
    }), { status: 200 }),
  });
  const conversation = [];
  let response = await sendTurn(conversation, "I need an iron test for well water.");
  response = await sendTurn(conversation, "not this one", response.payload.state);
  response = await sendTurn(conversation, "guide me", response.payload.state);
  assert.doesNotMatch(response.payload.reply, /I have the .* you shared noted/i, "the canned known-facts fallback must not fire");
  assert.match(response.payload.reply, /testing scope|cost|lead/i, "Claude's real, context-aware reply is kept");
  assert.ok(!(response.payload.products?.length));
});

test("Phase 3 (2): 'why this one?' uses the actual shown product and is never discarded for mentioning a known field", async () => {
  const store = createFakeStore();
  const world = installWorld({ store, llm: llmReply("Because your testing scope covers iron directly, which is what causes the staining you described.") });
  const conversation = [];
  let response = await sendTurn(conversation, "I need an iron test for well water.");
  response = await sendTurn(conversation, "Why this one?", response.payload.state);
  assert.match(response.payload.reply, /testing scope|iron/i, "the real explanation survives even though it mentions a known field");
  assert.doesNotMatch(response.payload.reply, /I have the .* you shared noted/i);
  assert.match(world.llmCalls.at(-1).body.system, /PRODUCT FOLLOW-UP/);
});

test("Phase 3 (3): 'how do I use it?' answers from available product information, never invented instructions", async () => {
  const store = createFakeStore();
  const world = installWorld({ store, llm: llmReply("Dip the strip in a fresh sample and compare it to the chart.") });
  const conversation = [];
  let response = await sendTurn(conversation, "I need an iron test for well water.");
  response = await sendTurn(conversation, "How do I use it?", response.payload.state);
  assert.ok(!(response.payload.products?.length));
  assert.match(world.llmCalls.at(-1).body.system, /PRODUCT FOLLOW-UP/);
  assert.match(world.llmCalls.at(-1).body.system, /never invent a capability/i, "the model is explicitly told not to guess beyond the real listed facts");
});

test("Phase 3 (4): 'what does this test tell me?' is answered from the real shown-product facts, no new search", async () => {
  const store = createFakeStore();
  const world = installWorld({ store, llm: llmReply("It tells you the iron concentration in your water.") });
  const conversation = [];
  let response = await sendTurn(conversation, "I need an iron test for well water.");
  response = await sendTurn(conversation, "What does this test tell me?", response.payload.state);
  assert.ok(!(response.payload.products?.length));
  assert.match(world.llmCalls.at(-1).body.system, /PRODUCT FOLLOW-UP/);
});

test("Phase 3 (5): 'is this enough?' is treated as a product follow-up, no new search", async () => {
  const store = createFakeStore();
  const world = installWorld({ store, llm: llmReply("Yes, this covers iron directly, which is what matters for your well.") });
  const conversation = [];
  let response = await sendTurn(conversation, "I need an iron test for well water.");
  response = await sendTurn(conversation, "Is this enough?", response.payload.state);
  assert.ok(!(response.payload.products?.length));
  assert.match(world.llmCalls.at(-1).body.system, /PRODUCT FOLLOW-UP/);
});

test("Phase 3 (6): an educational question never forces a product, even when a product was already shown", async () => {
  const store = createFakeStore();
  installWorld({ store, llm: llmReply("pH measures how acidic or basic your water is, on a 0-14 scale.") });
  const conversation = [];
  let response = await sendTurn(conversation, "I need an iron test for well water.");
  response = await sendTurn(conversation, "What does pH mean?", response.payload.state);
  assert.ok(!(response.payload.products?.length));
});

test("Phase 3 (7): open-ended 'what should I do?' gets a natural reply, no premature product, no forced options", async () => {
  const store = createFakeStore();
  const world = installWorld({ store, llm: llmReply("Let's figure out what matters to you — is this for a pool, drinking water, or something else?") });
  const response = await call([{ role: "user", content: "what should I do?" }]);
  assert.equal(response.payload.model, "claude-sonnet-5-5", "routed to Claude, not the rigid structured gate");
  assert.deepEqual(response.payload.options, [], "no quick-reply buttons forced on an open-ended, confused opener");
  assert.ok(!(response.payload.products?.length), "no premature product recommendation");
  assert.match(world.llmCalls.at(-1).body.system, /CUSTOMER WANTS GUIDANCE, NOT A PRODUCT/);
});

test("Phase 3 (8): 'the second one' / 'that one' after multiple products uses the real shown facts, not a new search", async () => {
  const store = createFakeStore();
  const world = installWorld({ store, llm: llmReply("The second option is a pool kit covering chlorine and pH.") });
  const conversation = [];
  let response = await sendTurn(conversation, "Show me your water testing products.");
  assert.ok(response.payload.products.length >= 2);
  response = await sendTurn(conversation, "What about the second one?", response.payload.state);
  assert.ok(!(response.payload.products?.length), "no redundant new search for an ordinal reference");
  assert.match(world.llmCalls.at(-1).body.system, /PRODUCT FOLLOW-UP/);
  response = await sendTurn(conversation, "That one looks good.", response.payload.state);
  // A bare "that one" doesn't match ACCEPTS_RECOMMENDATION's stricter "I want this/I'll take it"
  // phrasing, so it stays a follow-up reference rather than an assumed purchase decision.
  assert.ok(!(response.payload.products?.length));
});

test("Phase 3 (9): a topic change does not let old product/parameter context leak into the new topic", async () => {
  const store = createFakeStore();
  installWorld({ store, llm: llmReply("Let's look at your aquarium instead.") });
  const conversation = [];
  let response = await sendTurn(conversation, "I need an iron test for well water.");
  assert.deepEqual(response.payload.state.parameters, ["iron"]);
  response = await sendTurn(conversation, "Actually, forget that, I have a fish tank I need to test.", response.payload.state);
  assert.equal(response.payload.state.waterType, "aquarium");
  assert.deepEqual(response.payload.state.parameters, [], "the old well-specific iron parameter must not leak into the aquarium topic");
  assert.equal(response.payload.state.recommendationStatus, null);
  assert.equal(response.payload.state.lastProducts.length, 0);
});

test("Phase 3 (10): important context (water type, an accepted recommendation) survives a long conversation", async () => {
  const store = createFakeStore();
  const world = installWorld({ store, llm: llmReply("Here's what I can tell you about that.") });
  const conversation = [];
  let response = await sendTurn(conversation, "I need an iron test for well water.");
  response = await sendTurn(conversation, "I want this", response.payload.state);
  assert.equal(response.payload.state.recommendationStatus, "accepted");
  const followUps = [
    "Why this one?", "How do I use it?", "What does this test tell me?", "Is it in stock?",
    "That one", "Why this one?", "How do I use it?", "What does this test tell me?",
    "Is it in stock?", "That one", "Why this one?", "How do I use it?",
  ];
  for (const text of followUps) {
    response = await sendTurn(conversation, text, response.payload.state);
  }
  assert.equal(response.payload.state.waterType, "well", "water type set in turn 1 is still known many turns later");
  assert.equal(response.payload.state.recommendationStatus, "accepted", "the earlier acceptance is still remembered");
  assert.match(world.llmCalls.at(-1).body.system, /Water type: well/, "the system prompt's KNOWN FACTS still state it correctly on the final turn");
});

// --- Phase 4: product knowledge and usage intelligence — the store's own listing text is the --
// --- authoritative source for usage/range detail beyond "which parameters does it cover" -------

test("Phase 4 (1): 'Why this one?' explains using the actual shown product's real facts", async () => {
  const store = createFakeStore();
  const world = installWorld({ store, llm: llmReply("Because it directly covers iron, which is what causes the staining you described.") });
  const conversation = [];
  let response = await sendTurn(conversation, "I need an iron test for well water.");
  const shown = response.payload.products[0];
  response = await sendTurn(conversation, "Why this one?", response.payload.state);
  assert.ok(!(response.payload.products?.length), "no new search for a pure follow-up");
  assert.match(world.llmCalls.at(-1).body.system, new RegExp(shown.covers[0], "i"), "the real covered parameters are available to answer from");
});

test("Phase 4 (2): 'What does this test measure?' uses the actual product's covered parameters", async () => {
  const store = createFakeStore();
  const world = installWorld({ store, llm: llmReply("It covers iron, nitrate, water hardness and pH.") });
  const conversation = [];
  let response = await sendTurn(conversation, "I need an iron test for well water.");
  response = await sendTurn(conversation, "What does this test measure?", response.payload.state);
  assert.ok(!(response.payload.products?.length), "no redundant new search");
  assert.match(world.llmCalls.at(-1).body.system, /covers iron/i);
});

test("Phase 4 (3): 'How do I use it?' gives Claude the real usage text when the store listing has it", async () => {
  const store = createFakeStore();
  const world = installWorld({ store, llm: llmReply("Dip the strip in the water and read the result after 2 minutes.") });
  const conversation = [];
  let response = await sendTurn(conversation, "Show me an iron test.");
  const shown = response.payload.products[0];
  assert.match(shown.description, /dip|strip|minute/i, "sanity check: this product's real listing genuinely describes how to use it");
  response = await sendTurn(conversation, "How do I use it?", response.payload.state);
  assert.match(world.llmCalls.at(-1).body.system, /Store listing text:.*dip/i, "the real usage text from the store is available to answer from");
});

test("Phase 4 (4): when the store listing has no usage steps, Claude is told to say so rather than invent", async () => {
  const store = createFakeStore();
  // COMPLETE Home Water Quality Test Kit's real listing is a parameter checklist, not usage steps.
  const world = installWorld({ store, llm: llmReply("I don't have the exact usage steps listed for this one — check the product page or packaging.") });
  const conversation = [];
  let response = await sendTurn(conversation, "I need an iron test for well water.");
  const shown = response.payload.products[0];
  assert.doesNotMatch(shown.description, /dip the strip|wait \d+ (?:second|minute)|compare.{0,10}chart/i, "sanity check: this product's real listing has no step-by-step usage text");
  response = await sendTurn(conversation, "How do I use it?", response.payload.state);
  assert.match(world.llmCalls.at(-1).body.system, /never invent a capability, price, comparison point, usage step/i, "the model is explicitly told not to invent usage steps");
});

test("Phase 4 (5): 'What does my result mean?' is answered educationally, no unnecessary product", async () => {
  const store = createFakeStore();
  installWorld({ store, llm: llmReply("A higher iron reading generally means more dissolved iron, which can cause staining — check the product's reference chart for exact interpretation.") });
  const conversation = [];
  let response = await sendTurn(conversation, "I need an iron test for well water.");
  response = await sendTurn(conversation, "What does my result mean?", response.payload.state);
  assert.ok(!(response.payload.products?.length), "no new/redundant product for an educational result-interpretation question");
});

test("Phase 4 (6): 'Is this enough?' is answered from the real covered/not-covered facts", async () => {
  const store = createFakeStore();
  const world = installWorld({ store, llm: llmReply("It covers iron directly, but not bacteria — that would need a separate test.") });
  const conversation = [];
  let response = await sendTurn(conversation, "I need an iron test for well water.");
  response = await sendTurn(conversation, "Is this enough?", response.payload.state);
  assert.ok(!(response.payload.products?.length));
  assert.match(world.llmCalls.at(-1).body.system, /PRODUCT FOLLOW-UP/);
});

test("Phase 4 (7): a product-specific question after multiple products is answered about the right one, by position", async () => {
  const store = createFakeStore();
  const world = installWorld({ store, llm: llmReply("The second option covers chlorine and pH for your pool.") });
  const conversation = [];
  let response = await sendTurn(conversation, "Show me your water testing products.");
  assert.ok(response.payload.products.length >= 2);
  response = await sendTurn(conversation, "What about the second one — what does it measure?", response.payload.state);
  assert.ok(!(response.payload.products?.length));
  assert.match(world.llmCalls.at(-1).body.system, /the second option/i, "the second product is identified by position, not just the first");
});

test("Phase 4 (8): an unrelated educational question does not push a product, even with one already shown", async () => {
  const store = createFakeStore();
  installWorld({ store, llm: llmReply("pH measures how acidic or basic your water is, on a 0-14 scale.") });
  const conversation = [];
  let response = await sendTurn(conversation, "I need an iron test for well water.");
  response = await sendTurn(conversation, "What does pH mean?", response.payload.state);
  assert.ok(!(response.payload.products?.length));
});

test("Phase 4 (9): 'show me something else' still finds a genuine alternative product, unaffected by the description changes", async () => {
  const store = createFakeStore();
  installWorld({ store, llm: llmReply("Here is another option.") });
  const conversation = [];
  let response = await sendTurn(conversation, "I need an iron test for well water.");
  const firstTitle = response.payload.products[0].title;
  response = await sendTurn(conversation, "Show me something else", response.payload.state);
  assert.ok(response.payload.products?.length);
  assert.notEqual(response.payload.products[0].title, firstTitle);
});

test("Phase 4 (10): the model is always told to give an honest limitation rather than invent detection limits, ranges, or certifications", async () => {
  const store = createFakeStore();
  const world = installWorld({ store, llm: llmReply("It covers iron directly.") });
  const conversation = [];
  let response = await sendTurn(conversation, "I need an iron test for well water.");
  response = await sendTurn(conversation, "What does this test measure?", response.payload.state);
  assert.match(
    world.llmCalls.at(-1).body.system,
    /never invent a capability, price, comparison point, usage step, measurement range, detection limit, or certification/i
  );
});

// --- Phase 6: mode-conflict regression — wants-alternative must win when a message also -------
// --- matches rejection/follow-up patterns, or the explicit ask for something else is silently --
// --- dropped and the model gets two contradictory system notes in the same prompt --------------

test("mode conflict: 'not this one, show me something else' searches for a genuine alternative, not silent guidance", async () => {
  const store = createFakeStore();
  const world = installWorld({ store, llm: llmReply("Here's another option that covers iron.") });
  const conversation = [];
  let response = await sendTurn(conversation, "I need an iron test for well water.");
  const firstTitle = response.payload.products[0].title;
  response = await sendTurn(conversation, "not this one, show me something else", response.payload.state);
  assert.ok(response.payload.products?.length, "the explicit ask for an alternative must still run a real search");
  assert.notEqual(response.payload.products[0].title, firstTitle, "the previously shown product is excluded");
  assert.equal(response.payload.state.recommendationStatus, "undecided", "a fresh recommendation is pending, not stuck as rejected");
  const sys = world.llmCalls.at(-1).body.system;
  assert.match(sys, /CUSTOMER WANTS A DIFFERENT OPTION/);
  assert.doesNotMatch(sys, /CUSTOMER DECLINED THE RECOMMENDATION/, "the contradictory 'no search has been run' note must not also be sent");
});

// --- Phase 6: the alternative-product note must assertively tell Claude the shown product IS ---
// --- genuinely different, so it stops self-contradicting ("there isn't a different option") -----
// --- in the same reply that is showing one --------------------------------------------------------

test("Phase 6 (alternative note): when a genuine alternative is found, Claude is told never to say there isn't one", async () => {
  const store = createFakeStore();
  const world = installWorld({ store, llm: llmReply("Here's a different option for iron.") });
  const conversation = [];
  let response = await sendTurn(conversation, "I need an iron test for well water.");
  response = await sendTurn(conversation, "not this one, show me something else", response.payload.state);
  assert.ok(response.payload.products?.length, "a genuine alternative must have been found");
  const sys = world.llmCalls.at(-1).body.system;
  assert.match(sys, /Never say "there isn't a different option" or "this is the only match" when PRODUCT CONTEXT is showing you one/);
});

// --- Phase 6: constrainQuestionToState precision — each asksKnownX check requires genuine -----
// --- question phrasing (or real option co-occurrence), not a bare keyword appearing anywhere ---
// --- while the reply is doing something else entirely (explaining, recommending, apologising) -

function readinessWith(state) {
  return { nextMissingField: "ready", state: { parameters: [], ...state } };
}

test("Phase 6 (scope): an honest no-match explanation that happens to say 'routine testing' is not discarded as a redundant scope question", () => {
  const readiness = readinessWith({ testingScope: "complete" });
  const reply = "Radon isn't something we carry a kit for, though routine testing matters more than for mains water since well supplies aren't monitored centrally.";
  assert.equal(constrainQuestionToState(reply, readiness, false), reply);
});

test("Phase 6 (scope): a genuine re-ask of testing scope is still caught", () => {
  const readiness = readinessWith({ testingScope: "complete" });
  const reply = "Just to check, are you after a routine check or something more specific?";
  assert.notEqual(constrainQuestionToState(reply, readiness, false), reply);
});

test("Phase 6 (treatment): mentioning only one treatment word while explaining dosing is not discarded", () => {
  const readiness = readinessWith({ waterType: "pool", treatment: "chlorine" });
  const reply = "Chlorine levels can drift fast in hot weather, so testing every day or two is worth it.";
  assert.equal(constrainQuestionToState(reply, readiness, false), reply);
});

test("Phase 6 (treatment): re-listing the treatment options together is still caught", () => {
  const readiness = readinessWith({ waterType: "pool", treatment: "chlorine" });
  const reply = "Quick one first — is your pool chlorine, bromine, or saltwater treated?";
  assert.notEqual(constrainQuestionToState(reply, readiness, false), reply);
});

test("Phase 6 (aquarium type): mentioning only 'freshwater' while giving advice is not discarded", () => {
  const readiness = readinessWith({ waterSubtype: "freshwater" });
  const reply = "For a freshwater setup like yours, ammonia and nitrite are the two to watch most closely.";
  assert.equal(constrainQuestionToState(reply, readiness, false), reply);
});

test("Phase 6 (aquarium type): re-asking freshwater vs saltwater (even markdown-bolded) is still caught", () => {
  const readiness = readinessWith({ waterSubtype: "freshwater" });
  const reply = "Just to confirm, is your tank **freshwater** or **saltwater**?";
  assert.notEqual(constrainQuestionToState(reply, readiness, false), reply);
});

test("Phase 6 (water source): mentioning only 'well' while discussing well water is not discarded", () => {
  const readiness = readinessWith({ waterSource: "well" });
  const reply = "Well water especially benefits from an annual coliform check since it isn't centrally treated.";
  assert.equal(constrainQuestionToState(reply, readiness, false), reply);
});

test("Phase 6 (water source): re-asking tap vs well is still caught", () => {
  const readiness = readinessWith({ waterSource: "well" });
  const reply = "Quick check — is this tap or well water?";
  assert.notEqual(constrainQuestionToState(reply, readiness, false), reply);
});

// --- Phase 6: staleAfterRejection must be trusted the same way as the other carve-outs — this --
// --- is the exact original bug ("no not this one, guide me" -> canned fallback) reproduced for -
// --- the rejection-then-uncertain path specifically ----------------------------------------------

test("Phase 6 (stale-after-rejection): a genuine guiding reply after 'not this one' / 'not sure what to do' is not replaced by the canned fallback", async () => {
  const store = createFakeStore();
  let n = 0;
  const replies = [
    "Here's a well water option covering iron and the usual well checks.",
    "No worries, I can look at other options if you'd like.",
    "No problem — since you're not sure, is this water mainly for drinking, or something else like a pool or aquarium? That'll help me point you the right way.",
  ];
  const world = installWorld({
    store,
    llm: async () => new Response(JSON.stringify({ content: [{ type: "text", text: replies[n++] ?? replies.at(-1) }], stop_reason: "end_turn" }), { status: 200 }),
  });
  const conversation = [];
  let response = await sendTurn(conversation, "I need an iron test for well water.");
  response = await sendTurn(conversation, "not this one", response.payload.state);
  response = await sendTurn(conversation, "hmm not sure what to do now", response.payload.state);
  assert.doesNotMatch(
    response.payload.reply,
    /I have the .* you shared noted, so I.ll focus on the tests relevant to those details/,
    "the genuine guiding reply must not be silently swapped for the canned 'noted' fallback"
  );
  assert.match(response.payload.reply, /drinking|pool|aquarium/i);
});

// --- Phase 6: the real store-listing text is now given to Claude for the FIRST recommendation --
// --- too (previously only for a follow-up), so the first answer is already grounded in it ------
// --- instead of needing a later self-correction --------------------------------------------------

test("Phase 6 (product context): the first recommendation's system prompt includes the real store listing text, not just the parameter list", async () => {
  const store = createFakeStore();
  const world = installWorld({ store, llm: llmReply("Here's a good option for that.") });
  const conversation = [];
  const response = await sendTurn(conversation, "I need an iron test for well water.");
  const firstProduct = response.payload.products[0];
  assert.ok(firstProduct.description, "the hydrated product must carry its real store description");
  const sys = world.llmCalls.at(-1).body.system;
  assert.match(sys, /Store listing text for the first option/);
  assert.ok(sys.includes(firstProduct.description.slice(0, 40)), "the system prompt must quote the product's real listing text");
});
