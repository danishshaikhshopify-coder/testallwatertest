# TestAllWater AI Assistant

A direct chat interface that helps customers work out which water test they need.

```
Browser (index.html)  ──POST /api/chat──▶  Vercel function (api/chat.js)  ──▶  NaraRouter
   no secrets                               holds the API key + system prompt     /v1/chat/completions
```

- **Frontend** – `index.html`, a single static page. Every message is sent to `/api/chat` and the reply shown is the real model response. There is no demo or canned-reply fallback: if the request fails, the error is shown.
- **Backend** – `api/chat.js`, a Vercel serverless function. It adds the system prompt and calls NaraRouter's OpenAI-compatible API with the Free-plan fallback chain (`nemotron-3-super-free`, then `nemotron-3-ultra-free`). Both models were confirmed on the current Free plan and returned real replies with the complete assistant prompt. Check `https://router.bynara.id/api/plans` before changing the list.
- **Conversation context** – the browser keeps the conversation and sends the last 12 turns plus the server-derived structured state with each request; the server forwards the turns to the model after the system prompt.

## Security

- `NARA_ROUTER_API_KEY` exists only in the ignored local `.env` or the deployment environment and is only read inside `api/chat.js`. It never appears in `index.html` or any client-side code.
- The system prompt is server-side. Any `system` message sent by a client is discarded, so the endpoint cannot be repurposed as a general-purpose LLM proxy. History length (12 turns) and message size (4,000 chars) are capped.
- The endpoint has no rate limiting. If abuse becomes a concern, add one (e.g. Vercel WAF rate-limit rule or Upstash Ratelimit).

## Shopify product recommendations

The assistant recommends **real products from the live TestAllWater store** (`https://testallwater.co.uk`, Shopify `test-all-water.myshopify.com`) and shows them as product cards under its answer: image, title, price, a "why it matches" line, **View Product**, and **Add to Cart** when there is nothing to choose.

**Recommendation readiness gate.** Product cards are withheld until a deterministic check in `api/_needs.js` confirms the minimum context for the water type: the customer's goal, requested test scope, drinking-water source, or aquarium type. A structured state tracks water type, treatment, scope, individual issues, parameters, goal, and related subtype/source details across turns. The server interprets short answers in the context of the last requested field, asks only for the next useful clarification, and requires explicit confirmation before switching water types. Predictable guided questions include a small set of quick replies and an always-available **Other / Type my answer** action. While a guided clarification is outstanding, the server returns it with options without calling Shopify or NaraRouter. Once ready, the existing product matcher runs unchanged; the browser also refuses to render product data unless the response explicitly marks recommendations ready. This is a rule-based gate, not an LLM probability score.

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

## Model selection

**Current configuration (checked 2026-09-29):** NaraRouter no longer lists `nex-n2.5-pro` in its public plans and returns a model-not-found response for that ID. `nemotron-3-super-free` and `nemotron-3-ultra-free` both returned real replies with the complete TestAllWater prompt and live Shopify product context, so they are configured as primary and fallback. Model availability and performance can change; the live plan is authoritative.

The comparison below is a historical benchmark of the earlier model selection, not the current configuration.

The Free-plan chat models were compared on the live deployment through the exact production flow (server prompt, `reasoning_effort: "none"`, 1000 tokens, 2 x 9s attempts). Requests were interleaved model-by-model with identical prompts (six realistic customer messages, one of them multi-turn) so every model saw the same upstream conditions. 48 requests per model over two runs:

| Model | Answered | 95% CI | Timeouts | Hard errors | Median reply time | p90 |
| --- | --- | --- | --- | --- | --- | --- |
| `nex-n2.5-pro` (previous primary; now unavailable) | 38/48 (79%) | 66-88% | 10 | 0 | 7.4s | 15.5s |
| `nemotron-3-super-free` | 29/48 (60%) | 46-73% | 8 | 11 (empty reply) | 5.2s | 7.7s |
| `nemotron-3-ultra-free` | 19/48 (40%) | 27-54% | 23 | 6 | 13.8s | 17.3s |
| `laguna-s-2.1` | 17/48 (35%) | 23-50% | 24 | 7 | 8.9s | 18.1s |
| `nemotron-3.5-lightning-free` (previous) | 8/48 (17%) | 9-30% | 40 | 0 | 13.7s | 18.0s |

Caveats:
- NaraRouter has stall episodes lasting 10+ minutes in which **every** model times out at once (in the second run, 7 of 60 requests succeeded across all five models during one). Model choice cannot fix that; only same-window comparisons like the above are meaningful, and results will drift as NaraRouter's capacity changes.
- The previously configured `nex-n2.5-pro` sometimes answered with a JSON object instead of prose (9 of 187 replies in earlier testing, mostly aquarium questions), and the key varied (`message`, `response`, `answer`, `question`, `assistant_response`, `assistantMessage`, or a structured `{"water_type": ..., "parameters": [...]}`) and was often cut off part-way. `api/chat.js` never lets raw JSON reach a customer: a prose field is unwrapped, flat fields become a readable list, and unrenderable JSON becomes a `bad_response` error. The handling remains useful for any model that returns JSON.
- The previous `nex-n2.5-pro` occasionally stopped after a token or two. Replies with fewer than four letters or digits are still treated as `empty_reply` errors rather than shown as broken bubbles; those content-level errors are not retried.
- `nemotron-3-super-free` was the fastest when it worked, but about a quarter of its requests came back empty.

## Conversation behaviour

- **Repeated messages.** If the customer sends the same message again after the AI already answered it (compared ignoring case, spacing and end punctuation; messages under 10 characters such as "yes" are exempt), the server adds a note to the system prompt telling the model to acknowledge it and move forward instead of repeating its earlier reply or question. The base prompt also tells the model to use the whole conversation.
- **Failed then resent.** A message that got no answer (timeout or error) stays in the conversation as context. If the customer just sends it again, the unanswered copy is dropped so it is treated as a first-time message, not a repeat.
- **Errors.** Customers see plain, friendly copy (timeout: "…please send your message again, our conversation is still here…"; busy; generic). Technical details go to the browser console and the Vercel logs only, and the failed exchange never enters the history, so the next message continues normally.
- **Markdown.** Assistant replies render Markdown: `**bold**`, `*italic*`, `` `code` ``, fenced code blocks, bullet / numbered / nested lists, headings (shown as bold lines), horizontal rules and `http(s)` links (opened with `noopener noreferrer nofollow`). Tables and other syntax appear as plain text. The customer's own messages are always plain text. The renderer builds DOM nodes (`createElement`, `createTextNode`) from a fixed tag whitelist and never uses `innerHTML`, so model output cannot inject markup or scripts; `test/ui.test.js` checks this with a DOM that throws if `innerHTML` is touched.

## Reliability and debugging

- The model is called with `reasoning_effort: "none"` and `max_tokens: 1000`. It is a reasoning model, but this is simple customer-support chat: at its default depth the free model took 22s to 50s+ per reply, and at `"low"` about one request in three still hit the deadline.
- **Retry:** each upstream attempt has a hard deadline. A stalled or unreachable request is retried once with the identical request; a model-specific 404 tries the next configured model, which gets up to 20s to answer. Other attempts have a 9s deadline. The first success is returned immediately; authentication, rate-limit, and unrelated request errors are not retried. The maximum catalog and model wait stays inside the browser's 40s safety limit.
- Error responses are JSON: `{ "error": "<friendly message>", "code": "...", "requestId": "..." }` with codes `timeout` (504), `rate_limited` (429), `model_unavailable`, `upstream_error`, `unreachable`, `bad_response`, `empty_reply` (502). `detail` (the raw upstream reason) is for debugging and is not shown in the UI.
- Every request writes one JSON log line to **Vercel → Project → Logs** (`"event":"chat"`): `outcome`, `attempts` (outcome and ms of each attempt), `upstreamStatus`, `headersMs`, `bodyMs`, `totalMs`, `finishReason`, token counts (`reasoningTokens` shows how much time was spent thinking), and `requestId` (the `x-vercel-id`). Failures are logged at error level. Logs contain no API key and no message text.
- If too many requests still fail, check `attempts` and `totalMs` in the logs; the remaining lever is a different free model from `https://router.bynara.id/api/plans`.

## Deploy on Vercel

1. Import this GitHub repo in Vercel (framework preset: **Other**; no build command, no output directory).
2. Add environment variables (Project → Settings → Environment Variables), for **Production** and **Preview**:

   | Name | Value |
   | --- | --- |
   | `NARA_ROUTER_API_KEY` | your NaraRouter key |
   | `NARA_ROUTER_BASE_URL` | `https://router.bynara.id/v1` |

3. Deploy. Every push to `main` then deploys automatically.

Environment variable changes only apply to **new** deployments — redeploy after editing them.

## Local development

```bash
npm install                               # install dependencies
npm run dev                               # serves http://localhost:3000
npm test                                  # unit tests (mocked NaraRouter, no key needed)
```

Set `NARA_ROUTER_API_KEY` and `NARA_ROUTER_BASE_URL=https://router.bynara.id/v1` in the ignored `.env` file before starting the server. The local server explicitly loads that file before importing the API handler, and values in `.env` take precedence over inherited shell variables. It serves the existing `index.html` and forwards `/api/chat` to the existing NaraRouter handler. Copy `.env.example` to `.env` only if you need a template; replace the placeholder with your own key.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Chat UI (static) |
| `api/chat.js` | `/api/chat` serverless function |
| `api/_needs.js` | Customer messages -> kind of water and parameters to test |
| `api/_catalog.js` | Live Shopify catalog search, relevance rules, card data |
| `api/_guard.js` | Removes invented prices, links and branded products from replies |
| `test/shop.test.js`, `test/fake-store.js`, `test/fixtures/store.json` | Product tests against a fake store built from real captured data |
| `vercel.json` | Function config (`maxDuration: 60`) |
| `package.json` | ESM + Node 22 + local development and test scripts |
| `server.js` | Local Express server for `index.html` and `/api/chat` |
| `test/chat.test.js` | Backend and no-secret-in-frontend tests |
| `.env.example` | Environment variable template |

## Notes

When the live Shopify storefront is reachable, matching products from its public read-only catalog are shown as product cards. If no product matches or the store is unavailable, the assistant still explains the relevant test categories and parameters.
