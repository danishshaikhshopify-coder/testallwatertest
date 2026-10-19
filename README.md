# TestAllWater AI Assistant

A direct chat interface that helps customers work out which water test they need.

```
Browser (index.html)  ──POST /api/chat──▶  Vercel function (api/chat.js)  ──▶  Anthropic API
   no secrets                               holds the API key + system prompt     /v1/messages
```

- **Frontend** – `index.html`, a single static page. Every message is sent to `/api/chat` and the reply shown is the real model response. There is no demo or canned-reply fallback: if the request fails, the error is shown.
- **Backend** – `api/chat.js`, a Vercel serverless function. It adds the system prompt and calls Anthropic's Messages API directly (model: `claude-sonnet-5-5`).
- **Conversation context** – the browser keeps the conversation and sends the last 12 turns plus the server-derived structured state with each request; the server forwards the turns to the model after the system prompt.

## Security

- `ANTHROPIC_API_KEY` exists only in the ignored local `.env` or the deployment environment and is only read inside `api/chat.js`. It never appears in `index.html` or any client-side code.
- The system prompt is server-side. Any `system` message sent by a client is discarded, so the endpoint cannot be repurposed as a general-purpose LLM proxy. History length (12 turns) and message size (4,000 chars) are capped.
- The endpoint has no rate limiting. If abuse becomes a concern, add one (e.g. Vercel WAF rate-limit rule or Upstash Ratelimit).

## Shopify product recommendations

The assistant recommends **real products from the live TestAllWater store** (`https://testallwater.co.uk`, Shopify `test-all-water.myshopify.com`) and shows them as product cards under its answer: image, title, price, a "why it matches" line, **View Product**, and **Add to Cart** when there is nothing to choose.

**Recommendation readiness gate.** Product cards are withheld until a deterministic check in `api/_needs.js` confirms the minimum context for the water type: the customer's goal, requested test scope, drinking-water source, or aquarium type. A structured state tracks water type, treatment, scope, individual issues, parameters, goal, and related subtype/source details across turns. The server interprets short answers in the context of the last requested field, asks only for the next useful clarification, and requires explicit confirmation before switching water types. Predictable guided questions include a small set of quick replies and an always-available **Other / Type my answer** action. While a guided clarification is outstanding, the server returns it with options without calling Shopify or Anthropic. Once ready, the existing product matcher runs unchanged; the browser also refuses to render product data unless the response explicitly marks recommendations ready. This is a rule-based gate, not an LLM probability score.

**Skipping ahead.** If the customer explicitly asks to see products ("just show me products") or is frustrated with the questions ("stop asking me questions"), `state.relaxedReadiness` becomes true (and stays true for the rest of the conversation) and the gate stops asking the remaining "soft" fields (goal, scope, subtype/source), searching instead with whatever is already known. A single anchor — the kind of water — is still asked for if truly nothing is known yet; there is no sensible search without it. Two consecutive uncertain answers ("not sure" / "no idea" / "I don't know") are treated the same way — one is normal conversation, but a second in a row reads as the customer genuinely not having more to add. Help first, sell second.

**How the catalog is accessed.** Through the store's *public, read-only storefront endpoints* (`/search/suggest.json`, `/products/<handle>.js`, `/cart.js`). No Shopify API key, token or secret exists anywhere in this project, and what we read is exactly what a customer sees. The catalog has ~4,200 products, so nothing is bulk-downloaded: each conversation runs a few live searches (about 1 s) and re-reads only the three winners.

**Flow** (`api/_needs.js` -> `api/_catalog.js` -> `api/chat.js`):
1. `_needs.js` turns what the customer said into a kind of water, the parameters worth testing, and a deterministic readiness object. When a required detail is missing, the assistant asks one focused question without searching the catalog.
2. Once readiness is true, `_catalog.js` searches the store, then keeps only listings that are in stock, are real tests (not chemicals, refills or accessories), are not expired/clearance/opened stock, are not built for a different kind of water, and whose **title** names a needed parameter or the right kind of water (a generic tag is not enough). It picks up to three so that together they cover different parameters, simple kits and strips before lab instruments, and no more than two per brand. Nothing is labelled "best" or ranked in a way the customer can see.
3. The winners are re-read from `/products/<handle>.js` for the current price and stock; anything sold out is dropped.
4. The model is told only *how many* products are shown and which parameters they are listed for, never their names, prices or links. `api/_guard.js` then removes any price, link or unlisted branded product the model writes anyway.
5. If nothing matches, the customer is told "No matching product found" (added automatically if the model forgets); if the store cannot be reached, the reply says so. Nothing is ever invented.

**Everything on a card is real.** Title, price, stock, image, URL and variant id come from Shopify. The only sentence we write is "Listed for X, Y and Z testing", built from parameters found in that product's own title/tags. The page re-validates every card before showing it (https on `testallwater.co.uk`, images from Shopify's CDN, price must look like a GBP amount) and builds cards with DOM nodes only (no `innerHTML`).

**Currency.** The store uses Shopify Markets and prices depend on the visitor's country (the same product is GBP 18.19 or PKR 6,900). Every request pins the UK market (`localization=GB`) and `/cart.js` is checked to report `GBP` before any price is used; if not, no products are shown (fails closed).

**Add to Cart** is a link `https://testallwater.co.uk/cart/add?id=<variant>&quantity=1&return_to=/cart` and only appears for products with a single in-stock variant. The customer completes checkout on the store; nothing is purchased by the assistant.

Settings (both optional, Vercel environment variables): `SHOPIFY_CATALOG=off` switches product recommendations off instantly; `SHOPIFY_STORE_ORIGIN` points at a different storefront.

Known limits: search relevance depends on the store's own titles and tags; products with several variants have no Add to Cart (the customer chooses on the product page); prices are GBP for everyone, and the product page shows the visitor's own currency.

## Retrieval at catalog scale (6,000+ products)

The catalog is never bulk-downloaded and never sent to Claude, however large it is:

- `buildQueries()` (`api/_catalog.js`) turns the structured state/needs into a handful of targeted search terms (at most `MAX_QUERIES` = 6) — the kind of water, the customer's own named parameters, symptom-implied parameters, then the rest of the usual checklist.
- Each query hits Shopify's own `/search/suggest.json`, which always returns a small, bounded result set (10 per query) regardless of whether the store has 4,000 or 60,000 products — the store does the heavy searching, not this code.
- `scoreCandidate()` / `selectProducts()` rank the merged candidates by actual relevance: does the listing's own title/type/tags verifiably cover a needed parameter, does it target the right kind of water, how many of the customer's *own* named parameters vs. symptom-implied vs. default-checklist parameters it covers, and whether it's a simple kit/strip (preferred) or a lab instrument (only when it adds a parameter nothing simpler covers). **Price is not a ranking input at all** — a cheap, relevant kit outranks an expensive, less-relevant one every time; see `test/retrieval.test.js`.
- The greedy-coverage selection in `selectProducts()` already implements "help first, sell second": each pick must add the most *not-yet-covered* parameters, duplicate titles are dropped, and the list caps at `MAX_PRODUCTS` = 3 — a wall of near-identical options is never returned, but a genuinely complementary product (one that covers something the first pick doesn't) is.
- Claude is told only a **count** and the **covered parameter labels** (`productContext()` in `api/chat.js`) — not product names, prices, handles or links. `api/_guard.js` is the backstop if it invents one anyway. This is a stricter version of "send only the fields Claude needs": it sends none of the product's own fields at all.
- `test/retrieval.test.js` proves the bound holds even against a synthetic 7,000-product store: a fixed, small number of HTTP requests regardless of catalog size, ranking that finishes in well under a second against 6,000+ synthetic candidates, and that the most expensive candidate never wins by virtue of price alone.

## Knowledge layer

`api/_knowledge.js` is the factual layer — separate from both the product catalog and from Claude's own conversational wording (the persona/style instructions in `api/chat.js`'s `SYSTEM_PROMPT`). For each supported water type it holds a short framing line, named common problems (e.g. pool green water, aquarium fish gasping) with what they may indicate, which parameters matter and why, and a reasonable follow-up question. The content carries forward guidance that already existed in this project (the prior system-prompt GUIDANCE text and the symptom/parameter associations already in `api/_needs.js`) rather than inventing new medical/scientific claims.

`knowledgeContext(state, needs)` retrieves — the same philosophy as the product catalog — only the facts relevant to the current conversation (the known water type's framing line, the matched problem if any, and a "why" line for each parameter actually in play), never the whole knowledge base, and adds them to the system prompt as a `WATER TESTING KNOWLEDGE` note. Claude's job stays to explain this naturally and simply; the facts themselves live here, not in Claude's prompt text, so they can be reviewed and expanded later without touching conversational wording.

`issueIndicates(waterType, issueId)` exposes the same "may indicate" fact as a short fragment that `api/_needs.js` weaves directly into its deterministic guided questions (no LLM call) — e.g. "Got it — you're troubleshooting green water in your pool. This often points to too little active sanitiser to control algae... Have you tested your chlorine and pH yet?" — so the teach-while-diagnosing behavior holds even before Claude is ever called.

## Conversational intelligence

**Help first, sell second.** The system prompt in `api/chat.js` describes the assistant as a knowledgeable friend and teacher, not a sales bot or an interrogation form: it teaches while it diagnoses (explanation and question in the same message, never separate messages), asks a question only when the answer would materially change the recommendation, and keeps replies short — normally one short explanation plus one question or one recommendation.

**Best-fit recommendation with a reason.** `productContext()` in `api/chat.js` tells Claude which specific parameters the *best-fit* product covers (the first, highest-scoring pick from `_catalog.js`'s already-ranked list) and instructs it to connect the customer's problem to why those parameters matter, presenting that one as the main recommendation — "the option below," never a name. Any further products shown are described only as genuinely optional ("if you want to go a little further...") and only when they cover something the first one doesn't; Claude is told explicitly never to add one just to pad the recommendation.

**Frustration and customer control.** On top of the explicit "just show me products" / "stop asking" override from Phase 2, two consecutive uncertain answers ("not sure", "no idea", "I don't know") now trigger the same relaxed-readiness fallback — a single uncertain answer is normal and gets a simpler rephrased question, but a second in a row is treated as the customer genuinely not having more to add, and the assistant moves straight to its best available recommendation.

**Safety.** For drinking water especially, the system prompt requires saying what a test *can* tell the customer rather than a stronger claim, and never implying a consumer test is a medical or legal safety guarantee — backed by the same rule in the knowledge layer's `SAFETY_DISCLAIMER`.

## Conversation observability

`api/_telemetry.js` turns every `/api/chat` request into one structured JSON event, logged to `console.log` (outcome `"ok"`) or `console.error` (anything else) — exactly the mechanism Phase 1 already used, captured by **Vercel → Project → Logs** with no new service. The one real gap this closed: the deterministic readiness-gate path (most turns — every "what kind of water", "have you tested yet" exchange) previously logged **nothing at all**; only turns that reached Claude were observed. Every turn now logs exactly one event.

**Event shape** (fields kept from Phase 1-3 unchanged; new Phase 4 fields marked):
```
{
  event: "chat",
  timestamp,                 // NEW — ISO 8601
  totalMs, requestId,
  conversationId,            // NEW — stable per conversation, see below
  model,                     // "claude-sonnet-5-5" or "readiness-gate" (no LLM call made)
  outcome,                   // "ok" or an error code (timeout, upstream_error, ...)
  historyMessages, readiness: { ready, missing },
  repeatedMessage?, relaxedReadiness?, droppedUnansweredRepeats?,
  catalog?: { status, shown, queries, candidates, qualified, ms },
  needs?: { context, parameters },
  attempts?, upstreamStatus?, headersMs?, bodyMs?, finishReason?,
  promptTokens?, completionTokens?, guardRemoved?, unwrappedJson?,
  degenerateReply?, rejectedKnownFieldQuestion?, replyChars?, errorDetail?,
  state: {                   // NEW — categorical only, see "Privacy" below
    waterType, waterSubtype, waterSource, treatment, goal, issue, issueDetails,
    testingScope, lastAskedField, lastAnswerWasAmbiguous, waterTypeClarificationCount,
    uncertainStreak, relaxedReadiness, pendingWaterTypeSwitch,
  },
  productIds?,                // NEW — real Shopify product ids shown, when catalog.status is "ok"
  signals: [...],              // NEW — see "Review signals" below
}
```

**`conversationId`.** The frontend already round-trips the opaque `state` object on every request without inspecting it (`index.html`'s `ask()` just stores whatever `state` the server last returned and sends it back). `conversationId` rides inside that same object: generated once on the first turn, carried forward unchanged after that — no new request/response field, no frontend change, nothing the customer sees. It exists only to group one conversation's log lines for review; it is never sent to Anthropic or Shopify.

**Privacy.** Decided, not left open:
- **Never logged, ever:** the customer's raw message text, the assistant's raw reply text, `ANTHROPIC_API_KEY`, any Shopify credential (there are none in this project to begin with). This isn't a redaction step applied afterwards — these fields are simply never collected into the event object in the first place, so there is nothing to scrub or leak.
- **Logged:** category-level structured state (`waterType`, `issue`, `goal`, ... — each drawn from the small fixed vocabularies already in `api/_needs.js`, not free text), counts, timings, outcomes, and real catalog product ids (catalog data, not personal data). `issueDetails` is the one field that looks like prose but is actually one of six fixed phrases ("green water", "cloudy water", ...) — `test/telemetry.test.js` checks this stays true.
- **Retention:** whatever Vercel's own Runtime Logs retention is today — this project adds no separate store, so there is nothing here with its own retention policy to configure.
- **Open decision, not guessed:** where these events should live for longer-term review (a Vercel log drain, a dedicated analytics sink, a small database) is a product/infra choice this repository can't make safely on its own — see "Unresolved decisions" below.

**Review signals.** `classifySignals()` tags each event with a fixed, searchable vocabulary computed only from already-logged structured fields (never from message text, never from an LLM grading the conversation): `repeated_question`, `ambiguous_answer`, `water_type_not_recognized`, `repeated_uncertainty`, `frustrated_or_skipped_ahead`, `topic_switch_pending`, `model_ignored_known_state`, `unexpected_fallback`, `guard_removed_content`, `api_error`, `no_product_match`, `catalog_unavailable`, `product_recommended`, `knowledge_gap`, `no_useful_context_yet`.

**The improvement loop this enables (not automatic training):**
```
Real conversations → review (filter logs by signal) → identify a recurring problem
  → improve the parser (api/_needs.js) / knowledge (api/_knowledge.js) / retrieval (api/_catalog.js) / prompt (api/chat.js)
  → add a regression test for it → deploy the improvement
```
Nothing here changes Claude's weights or fine-tunes anything; every improvement is a code change reviewed and tested like any other.

## Model selection

**Current configuration:** the backend calls the official Anthropic Messages API (`https://api.anthropic.com/v1/messages`) directly with the model `claude-sonnet-5-5`. There is no model fallback chain or third-party router; a retryable failure (timeout, network error, or the service being temporarily overloaded) is retried once with the identical request.

Notes:
- `api/chat.js` never lets raw JSON reach a customer, in case a reply is ever shaped like a JSON object instead of prose: a prose field is unwrapped, flat fields become a readable list, and unrenderable JSON becomes a `bad_response` error.
- Replies with fewer than four letters or digits are treated as `empty_reply` errors rather than shown as broken bubbles.

## Conversation behaviour

- **Repeated messages.** If the customer sends the same message again after the AI already answered it (compared ignoring case, spacing and end punctuation; messages under 10 characters such as "yes" are exempt), the server adds a note to the system prompt telling the model to acknowledge it and move forward instead of repeating its earlier reply or question. The base prompt also tells the model to use the whole conversation.
- **Failed then resent.** A message that got no answer (timeout or error) stays in the conversation as context. If the customer just sends it again, the unanswered copy is dropped so it is treated as a first-time message, not a repeat.
- **Errors.** Customers see plain, friendly copy (timeout: "…please send your message again, our conversation is still here…"; busy; generic). Technical details go to the browser console and the Vercel logs only, and the failed exchange never enters the history, so the next message continues normally.
- **Markdown.** Assistant replies render Markdown: `**bold**`, `*italic*`, `` `code` ``, fenced code blocks, bullet / numbered / nested lists, headings (shown as bold lines), horizontal rules and `http(s)` links (opened with `noopener noreferrer nofollow`). Tables and other syntax appear as plain text. The customer's own messages are always plain text. The renderer builds DOM nodes (`createElement`, `createTextNode`) from a fixed tag whitelist and never uses `innerHTML`, so model output cannot inject markup or scripts; `test/ui.test.js` checks this with a DOM that throws if `innerHTML` is touched.

## Reliability and debugging

- The model is called with `max_tokens: 1000` (`temperature` is left at the model's default; this model deprecates the parameter).
- **Retry:** each upstream attempt has a hard deadline. A stalled or unreachable request, or one rejected with a 529 (overloaded), is retried once with the identical request, which gets up to 20s to answer. The first attempt has a 9s deadline. The first success is returned immediately; authentication, rate-limit, and unrelated request errors are not retried. The maximum catalog and model wait stays inside the browser's 40s safety limit.
- Error responses are JSON: `{ "error": "<friendly message>", "code": "...", "requestId": "..." }` with codes `timeout` (504), `rate_limited` (429), `overloaded` (503), `upstream_error`, `unreachable`, `bad_response`, `empty_reply` (502). `detail` (the raw upstream reason) is for debugging and is not shown in the UI.
- Every request writes one JSON log line to **Vercel → Project → Logs** (`"event":"chat"`): `outcome`, `attempts` (outcome and ms of each attempt), `upstreamStatus`, `headersMs`, `bodyMs`, `totalMs`, `finishReason`, token counts, and `requestId` (the `x-vercel-id`). Failures are logged at error level. Logs contain no API key and no message text.
- If too many requests still fail, check `attempts` and `totalMs` in the logs, and Anthropic's own status page.

## Deploy on Vercel

1. Import this GitHub repo in Vercel (framework preset: **Other**; no build command, no output directory).
2. Add an environment variable (Project → Settings → Environment Variables), for **Production** and **Preview**:

   | Name | Value |
   | --- | --- |
   | `ANTHROPIC_API_KEY` | your Anthropic API key |

3. Deploy. Every push to `main` then deploys automatically.

Environment variable changes only apply to **new** deployments — redeploy after editing them.

## Local development

```bash
npm install                               # install dependencies
npm run dev                               # serves http://localhost:3000
npm test                                  # unit tests (mocked Anthropic API, no key needed)
```

Set `ANTHROPIC_API_KEY` in the ignored `.env` file before starting the server. The local server explicitly loads that file before importing the API handler, and values in `.env` take precedence over inherited shell variables. It serves the existing `index.html` and forwards `/api/chat` to the existing handler. Copy `.env.example` to `.env` only if you need a template; replace the placeholder with your own key.

## Shopify Custom Section

`shopify/sections/testallwater-ai-assistant.liquid` embeds the same assistant directly in the TestAllWater Shopify storefront — a single self-contained Liquid section (scoped CSS, vanilla JS, no Shopify app, no new secrets) that calls the already-deployed `/api/chat` endpoint from the browser. See **[shopify/README.md](shopify/README.md)** for the full architecture, settings, and manual installation steps.

Two backend additions exist only to support this, both backward compatible with the existing contract and tests:
- **CORS** (`api/chat.js`) — a cross-origin browser request needs explicit allow headers; `CORS_ALLOWED_ORIGINS` (comma-separated, defaults to `*`) controls which origins are allowed, tightenable to the real storefront domain(s) in production.
- Nothing else about `/api/chat`'s request/response contract changed — the section round-trips `state` exactly as opaquely as `index.html` already does, and renders `products` from the same fields, validated the same way (store-domain and Shopify-CDN checks before any card is shown; nothing is ever invented).

Not connected to the live theme — prepared for manual installation and testing in a development theme first.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Chat UI (static) |
| `api/chat.js` | `/api/chat` serverless function |
| `api/_needs.js` | Customer messages -> kind of water and parameters to test |
| `api/_catalog.js` | Live Shopify catalog search, relevance rules, card data |
| `api/_guard.js` | Removes invented prices, links and branded products from replies |
| `api/_knowledge.js` | The factual knowledge layer (what a symptom indicates, why a parameter matters), separate from the catalog and from Claude's own wording |
| `api/_telemetry.js` | Conversation-observability event schema, review-signal classification, and the logging sink |
| `test/shop.test.js`, `test/fake-store.js`, `test/fixtures/store.json` | Product tests against a fake store built from real captured data |
| `test/retrieval.test.js` | Retrieval-at-scale tests: 6,000+ synthetic candidates, ranking, price-not-primary, no bulk catalog fetch |
| `test/knowledge.test.js` | Tests for the knowledge layer's targeted retrieval |
| `test/conversation.test.js` | Conversational-intelligence tests: teaching, frustration, short answers, topic changes, product reasoning |
| `test/telemetry.test.js` | Conversation-observability tests: event schema, no secrets/message text, review signals |
| `test/qa-regressions.test.js` | Regression tests for bugs found during Phase 5 production QA |
| `test/shopify-section.test.js` | Tests for the Shopify section's ported JS: render, send, quick replies, errors, product cards |
| `shopify/sections/testallwater-ai-assistant.liquid` | The Shopify Custom Section — copy this one file into a theme's `sections/` directory |
| `shopify/README.md` | Installation instructions and settings reference for the Shopify section |
| `shopify/build-preview.mjs`, `shopify/preview-server.mjs` | Local preview tooling for the section, no Shopify store needed |
| `vercel.json` | Function config (`maxDuration: 60`) |
| `package.json` | ESM + Node 22 + local development and test scripts |
| `server.js` | Local Express server for `index.html` and `/api/chat` |
| `test/chat.test.js` | Backend and no-secret-in-frontend tests |
| `.env.example` | Environment variable template |

## Notes

When the live Shopify storefront is reachable, matching products from its public read-only catalog are shown as product cards. If no product matches or the store is unavailable, the assistant still explains the relevant test categories and parameters.
