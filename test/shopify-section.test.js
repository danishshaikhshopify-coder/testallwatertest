// Phase 6: the Shopify Custom Section (shopify/sections/testallwater-ai-assistant.liquid).
// The section's <script> is extracted and run exactly as ui.test.js already does for
// index.html — in a fake DOM that throws if anything ever touches innerHTML — proving the
// ported widget behaves the same way the already-exhaustively-tested prototype does: real
// handler, real /api/chat backend, scripted upstream.
import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import handler from "../api/chat.js";
import { resetCatalogState } from "../api/_catalog.js";
import { FakeEl, FakeText, toHtml, textOf, allElements } from "./fake-dom.js";
import { createFakeStore, installWorld, llmReply } from "./fake-store.js";

const liquidPath = new URL("../shopify/sections/testallwater-ai-assistant.liquid", import.meta.url);
const liquid = readFileSync(liquidPath, "utf8");

const SECTION_ID = "T1";
const ROOT_ID = `tw-assistant-${SECTION_ID}`;

function elementId(name) {
  return `tw-${name}-${SECTION_ID}`;
}

// {{ tw_id }} is the only Liquid output left inside <script>...</script> (everything else is
// settings-driven HTML/CSS outside the script); substitute it exactly like
// shopify/build-preview.mjs does, so the tested code is the real shipped code.
const scriptMatch = /<script>([\s\S]*?)<\/script>/.exec(liquid);
const script = scriptMatch[1].replace(/\{\{\s*tw_id\s*\}\}/g, SECTION_ID);

test("the section's schema is valid JSON with the expected settings and blocks", () => {
  const schemaMatch = /\{%-?\s*schema\s*-?%\}([\s\S]*?)\{%-?\s*endschema\s*-?%\}/.exec(liquid);
  assert.ok(schemaMatch, "schema block present");
  const schema = JSON.parse(schemaMatch[1]);
  const ids = schema.settings.filter((s) => s.id).map((s) => s.id);
  assert.ok(ids.includes("api_endpoint"));
  assert.ok(ids.includes("store_domain"));
  assert.ok(ids.includes("display_mode"));
  assert.equal(schema.blocks[0].type, "quick_prompt");
});

test("no setting hardcodes a secret, and the API endpoint has no invented production URL", () => {
  // Mentioning ANTHROPIC_API_KEY by *name* in an explanatory comment is fine (and expected —
  // it says the key stays server-side); an actual key-shaped value is never fine.
  assert.doesNotMatch(liquid, /sk-ant-[A-Za-z0-9_-]{10,}|shpat_[A-Za-z0-9]|shpca_[A-Za-z0-9]|shpss_[A-Za-z0-9]/i);
  // The default must be the safe, same-origin fallback — never a guessed absolute URL.
  assert.match(liquid, /tw_endpoint = '\/api\/chat'/);
});

test("CSS never touches :root, bare body/html, or an unscoped universal selector", () => {
  const styleMatch = /<style>([\s\S]*?)<\/style>/.exec(liquid);
  assert.ok(styleMatch);
  const css = styleMatch[1];
  assert.doesNotMatch(css, /(^|\n)\s*:root\s*\{/);
  assert.doesNotMatch(css, /(^|\n)\s*body\s*\{/);
  assert.doesNotMatch(css, /(^|\n)\s*html\s*\{/);
  // A bare, unscoped universal reset (e.g. "*{box-sizing:...}" right after a rule or at the
  // start of the stylesheet) — not a scoped descendant combinator like ".tw-assistant-root *".
  assert.doesNotMatch(css, /(^|\})\s*\*\s*\{/);
});

// --- A fake DOM for this section's specific element ids -------------------------------------

function buildFakeDoc({ endpoint = "/api/chat", storeDomain = "testallwater.co.uk", floating = false, blocks = [] } = {}) {
  const byId = new Map();
  const root = new FakeEl("div");
  root.setAttribute("data-tw-endpoint", endpoint);
  root.setAttribute("data-tw-store-domain", storeDomain);
  root.setAttribute("data-tw-floating", String(floating));
  byId.set(ROOT_ID, root);

  const messages = new FakeEl("div");
  const welcome = new FakeEl("div");
  welcome.className = "tw-welcome";
  messages.appendChild(welcome);
  byId.set(elementId("messages"), messages);

  const quick = new FakeEl("div");
  for (const text of blocks) {
    const chip = new FakeEl("button");
    chip.className = "tw-chip";
    chip.textContent = text;
    quick.appendChild(chip);
  }
  byId.set(elementId("quick"), quick);

  const doc = {
    createElement: (tag) => new FakeEl(tag),
    createTextNode: (text) => new FakeText(text),
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, new FakeEl("div"));
      return byId.get(id);
    },
  };
  return { doc, root, messages, quick };
}

function bootSection(fetchImpl, opts) {
  const { doc, root, messages, quick } = buildFakeDoc(opts);
  const consoleErrors = [];
  const sandbox = {
    document: doc,
    fetch: fetchImpl,
    AbortController,
    URL,
    setTimeout: (...args) => globalThis.setTimeout(...args),
    clearTimeout: (...args) => globalThis.clearTimeout(...args),
    requestAnimationFrame: (fn) => fn(),
    console: { error: (...args) => consoleErrors.push(args), log() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);

  const el = (name) => doc.getElementById(elementId(name));
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const settle = async () => {
    for (let i = 0; i < 300 && el("send").disabled; i++) await flush();
  };
  return {
    doc, root, messages, quick, el, consoleErrors, flush, settle,
    submit(text) {
      el("input").value = text;
      el("form").onsubmit({ preventDefault() {} });
    },
    async send(text) {
      this.submit(text);
      await this.settle();
    },
    isIdle: () => !el("send").disabled && !el("input").disabled && !el("typing").classes.has("show"),
    rows: () =>
      messages.children.filter((c) => c.tag === "div" && c.classes.has("tw-row")).map((row) => ({
        role: row.classes.has("user") ? "user" : "assistant",
        bubble: row.children.find((child) => child.classes?.has("tw-bubble")),
        row,
      })),
  };
}

function apiFetch(_url, init) {
  return new Promise((resolve) => {
    const res = {
      setHeader() {},
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve(new Response(JSON.stringify(payload), { status: this.statusCode ?? 200 })); },
    };
    handler({ method: init.method, headers: {}, body: JSON.parse(init.body) }, res);
  });
}
const ok = (content) => ({ body: { content: [{ type: "text", text: content }], stop_reason: "end_turn" } });

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.SHOPIFY_CATALOG = "off";
  mock.method(console, "log", () => {});
  mock.method(console, "error", () => {});
});

afterEach(() => {
  mock.restoreAll();
});

// --- Initial render ---------------------------------------------------------------------

test("initial render: booting does not touch the messages container beyond what's already there", () => {
  const { messages } = bootSection(apiFetch, {});
  assert.equal(messages.children.length, 1); // just the welcome block, untouched
});

test("booting twice (e.g. a Shopify theme-editor re-render) does not double-initialize", () => {
  const { doc, root } = buildFakeDoc({});
  const sandbox = { document: doc, fetch: apiFetch, AbortController, URL, setTimeout, clearTimeout, requestAnimationFrame: (fn) => fn(), console: { error() {}, log() {} } };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  vm.runInContext(script, sandbox); // a second execution of the same script against the same DOM
  assert.equal(root.getAttribute("data-tw-booted"), "1");
});

// --- Sending a message, loading state, quick replies, Other ------------------------------

test("sending a message shows it, disables input while busy, and renders the reply", async () => {
  const store = createFakeStore();
  resetCatalogState();
  installWorld({ store, llm: llmReply("Here's what to check.") });
  const page = bootSection(apiFetch, {});

  // setBusy(true) runs synchronously inside ask(), before the fetch's promise chain gets a
  // chance to resolve, so this must be true immediately after submit() returns — checking it
  // only after an await would race against how fast the (mocked) request happens to resolve.
  page.submit("My pool water is cloudy");
  assert.equal(page.el("send").disabled, true, "send is disabled while the request is in flight");
  assert.equal(page.el("input").disabled, true);
  await page.settle();

  assert.ok(page.isIdle());
  const rows = page.rows();
  assert.equal(rows[0].role, "user");
  assert.equal(textOf(rows[0].bubble), "My pool water is cloudy");
  assert.equal(rows[1].role, "assistant");
});

test("a quick-reply chip submits its own text as the message", async () => {
  const page = bootSection(apiFetch, { blocks: ["My pool water is cloudy"] });
  const chip = page.quick.children[0];
  chip.onclick();
  await page.settle();
  const rows = page.rows();
  assert.equal(textOf(rows[0].bubble), "My pool water is cloudy");
});

test('"Other / Type my answer" focuses the input and sends nothing', async () => {
  const store = createFakeStore();
  resetCatalogState();
  installWorld({ store, llm: llmReply("unused") });
  const page = bootSection(apiFetch, {});
  await page.send("free chlorine"); // reaches the "unknown water type" guided question with an Other option

  const replyButtons = allElements(page.messages).filter((e) => e.classes?.has("tw-reply"));
  const other = replyButtons.find((b) => textOf(b) === "Other / Type my answer");
  assert.ok(other, "Other option is present");
  const before = page.rows().length;
  other.onclick();
  assert.equal(page.el("input").focused, true);
  assert.equal(page.rows().length, before, "no fake turn was sent");
});

// --- API error, network failure --------------------------------------------------------

test("an API error shows friendly copy, clears the busy state, and never leaks server detail", async () => {
  const page = bootSection(async () => new Response(JSON.stringify({ error: "boom", code: "upstream_error" }), { status: 502 }), {});
  await page.send("hello");
  const rows = page.rows();
  assert.match(textOf(rows.at(-1).bubble), /something went wrong/i);
  assert.doesNotMatch(textOf(rows.at(-1).bubble), /boom|502|upstream_error/);
  assert.ok(page.isIdle());
  assert.ok(page.consoleErrors.length > 0, "technical detail still reaches the console, not the customer");
});

test("a network failure (fetch rejects) also shows friendly copy and recovers", async () => {
  const page = bootSection(async () => { throw new TypeError("Failed to fetch"); }, {});
  await page.send("hello");
  assert.match(textOf(page.rows().at(-1).bubble), /something went wrong/i);
  assert.ok(page.isIdle());
});

// --- Product rendering and state round-trip ----------------------------------------------

test("product cards render from the real catalog fields only, and the conversation state round-trips opaquely", async () => {
  delete process.env.SHOPIFY_CATALOG;
  const store = createFakeStore();
  resetCatalogState();
  installWorld({ store, llm: llmReply("Here's the best fit.") });
  const page = bootSection(apiFetch, {});
  await page.send("I have a chlorine-treated pool with cloudy water and want to test chlorine, pH and alkalinity.");

  const cards = allElements(page.messages).filter((e) => e.classes?.has("tw-pcard"));
  assert.ok(cards.length >= 1 && cards.length <= 3);
  for (const card of cards) {
    const link = allElements(card).find((e) => e.classes?.has("tw-ptitle"));
    assert.match(link.getAttribute("href"), /^https:\/\/testallwater\.co\.uk\/products\//);
  }
  assert.ok(page.isIdle());
});

test("a product whose link is not the configured store domain is never rendered", async () => {
  const page = bootSection(
    async () => new Response(JSON.stringify({
      reply: "Here you go.", model: "m", ready: true, readiness: { ready: true },
      products: [{
        id: "1", title: "Evil Kit", vendor: "X", url: "https://evil.example/products/x",
        image: null, price: { amount: "9.99", currency: "GBP", display: "£9.99", from: false },
        available: true, addToCartUrl: null, reason: "x", covers: [],
      }],
    }), { status: 200 }),
    {}
  );
  await page.send("pool test please, my pool is cloudy");
  const cards = allElements(page.messages).filter((e) => e.classes?.has("tw-pcard"));
  assert.equal(cards.length, 0);
});

test("the store_domain setting controls which product links are accepted", async () => {
  const page = bootSection(
    async () => new Response(JSON.stringify({
      reply: "Here you go.", model: "m", ready: true, readiness: { ready: true },
      products: [{
        id: "1", title: "A kit", vendor: "X", url: "https://example-store.myshopify.com/products/x",
        image: null, price: { amount: "9.99", currency: "GBP", display: "£9.99", from: false },
        available: true, addToCartUrl: null, reason: "x", covers: [],
      }],
    }), { status: 200 }),
    { storeDomain: "example-store.myshopify.com" }
  );
  await page.send("pool test please, my pool is cloudy");
  const cards = allElements(page.messages).filter((e) => e.classes?.has("tw-pcard"));
  assert.equal(cards.length, 1);
});

// --- Markdown / friendlyError / product-card pure functions (same guarantees as the prototype) --

const renderMatch = /\/\*<render>\*\/([\s\S]*?)\/\*<\/render>\*\//.exec(script);
const { renderMarkdown, friendlyError, renderProductCards } = new Function(
  `${renderMatch[1]}\nreturn { renderMarkdown, friendlyError, renderProductCards };`
)();

test("markdown rendering matches the prototype's guarantees: bold renders, never innerHTML", () => {
  const root = new FakeEl("div");
  renderMarkdown("**Test next:** check pH", { createElement: (t) => new FakeEl(t), createTextNode: (t) => new FakeText(t) }, root);
  assert.equal(root.children.map(toHtml).join(""), "<p><strong>Test next:</strong> check pH</p>");
});

test("markdown XSS: hostile model output never becomes markup", () => {
  const root = new FakeEl("div");
  const doc = { createElement: (t) => new FakeEl(t), createTextNode: (t) => new FakeText(t) };
  renderMarkdown("<script>alert(1)</script>", doc, root); // FakeEl throws if innerHTML is ever touched
  const out = root.children.map(toHtml).join("");
  assert.doesNotMatch(out, /<script/i);
});

test("friendlyError never includes technical detail", () => {
  const timeout = friendlyError(Object.assign(new Error("x"), { code: "timeout" }));
  const busy = friendlyError(Object.assign(new Error("x"), { code: "rate_limited" }));
  const other = friendlyError(new TypeError("Failed to fetch"));
  for (const msg of [timeout, busy, other]) assert.doesNotMatch(msg, /HTTP|50\d|stack|Error:/i);
});

test("renderProductCards caps at three and validates each one independently", () => {
  const doc = { createElement: (t) => new FakeEl(t), createTextNode: (t) => new FakeText(t) };
  const parent = new FakeEl("div");
  const good = (n) => ({
    id: String(n), title: "Kit " + n, vendor: "V", url: `https://testallwater.co.uk/products/kit-${n}`,
    image: null, price: { amount: "9.99", currency: "GBP", display: "£9.99", from: false },
    available: true, addToCartUrl: null, reason: "r", covers: [],
  });
  const shown = renderProductCards([good(1), good(2), good(3), good(4)], doc, parent);
  assert.equal(shown.length, 3);
});
