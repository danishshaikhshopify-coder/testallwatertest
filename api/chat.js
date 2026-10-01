import { randomUUID } from "node:crypto";
import {
  analyzeNeeds,
  assessRecommendationReadiness,
  constrainQuestionToState,
  deriveConversationState,
  guidedResponse,
  getNextMissingField,
  parameterLabels,
} from "./_needs.js";
import { findProducts } from "./_catalog.js";
import { guardReply } from "./_guard.js";

const DEFAULT_BASE_URL = "https://router.bynara.id/v1";
// These Free-plan models were confirmed on NaraRouter's live plan and with the
// complete assistant prompt. Keep the second model as the fallback.
const DEFAULT_MODELS = ["nemotron-3-super-free", "nemotron-3-ultra-free"];
const CONFIGURED_MODELS = (process.env.NARA_ROUTER_MODELS || "")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
const MODELS = [...new Set(CONFIGURED_MODELS.length ? CONFIGURED_MODELS : DEFAULT_MODELS)];
const MODEL = MODELS[0];

// The Free-plan models are reasoning models, but this is simple customer-support chat,
// so thinking is disabled ("none", per NaraRouter's docs): it only adds latency, and
// every model tested worked with it.
const REASONING_EFFORT = "none";

// Each attempt (connect + headers + body) gets a hard deadline. A model-specific 404
// gives the next configured model a longer window; other failures keep the short timeout.
const ATTEMPT_TIMEOUT_MS = 9000;
const MODEL_FALLBACK_TIMEOUT_MS = 20000;
const MAX_ATTEMPTS = 1;
const MAX_OUTPUT_TOKENS = 1000;
const MIN_REPLY_ALNUM = 4; // a reply with fewer letters/digits than this is a truncated glitch
const MAX_HISTORY_MESSAGES = 12;
const MAX_MESSAGE_CHARS = 4000;

// The system prompt lives on the server so clients cannot replace it and use
// this endpoint as a free general-purpose LLM proxy.
const SYSTEM_PROMPT = `
You are TestAllWater's specialist water-testing assistant.

Your job is to help customers understand WHAT THEY SHOULD TEST and WHICH TYPE
OF TEST METHOD is appropriate. You are a water-testing/product-discovery
assistant, not a generic chatbot.

CONVERSATION:
- Let the customer describe the situation naturally. Use structured state and the conversation as the authoritative record.
- Identify water type: pool, spa/hot tub, drinking water, aquarium, pond,
  well water, industrial/commercial water, or other.
- Identify whether they want routine testing, troubleshooting, a specific
  parameter, or general screening.
- Ask only for the next useful missing detail. Never ask for a known fact, restart context, repeat a generic introduction, or repeat a question the customer has already answered.
- Treat short answers such as "pH", "yes", "no", "bromine" and "not sure" in the context of the immediately preceding question.
- The backend may provide structured quick-reply options. Keep the response aligned with those options; do not invent a conflicting question.
- Avoid generic "I can narrow this down" filler. Acknowledge the customer's latest detail and continue naturally.
- Keep questions simple for non-technical customers.
- When enough information is known, recommend the water type, parameters to test,
  suitable test format, and briefly explain why.
- Never guess when an important detail is missing.
- Use the whole conversation. Never ask again for something the customer already told you.
- If the customer repeats themselves, do not repeat your earlier reply; briefly acknowledge it and move forward.

COMMON PARAMETERS:
Free/total chlorine, bromine, pH, alkalinity, hardness, calcium hardness,
cyanuric acid, nitrate, nitrite, ammonia, phosphate, iron, copper,
dissolved oxygen, salinity/TDS, and multi-parameter testing.

GUIDANCE:
For pools/spas, consider chlorine or bromine, pH, alkalinity and other
measurements based on the symptom.
For drinking/well water, distinguish general screening from a specific concern.
Do not claim that a consumer test proves water is medically or legally safe.
For aquariums, consider ammonia, nitrite, nitrate, pH and hardness according
to the setup.
Never diagnose human illness.

PRODUCT RULE:
You can only know about TestAllWater products through a "PRODUCT CONTEXT" note that may be
added to these instructions. Never invent, guess or recall product names, brands, model
numbers, prices, stock, SKUs, ratings, images or links, and never name a specific product
yourself. When the note says products were found, the app shows them as product cards under
your reply: do not repeat their names or prices, refer to them as "the options below", and say
in plain words which parameters they cover. When the note says no product was found, say
clearly that no matching product was found in the TestAllWater catalog and continue helping
with advice. Without a note, recommend test types and parameters only.
If the customer gives test results, say briefly whether each value looks low, normal or high
for that kind of water, and which further test is worth doing.

STYLE:
Be concise, friendly, knowledgeable and practical. Avoid long lectures.
Use short paragraphs or bullets when useful.
`.trim();

function parseBody(req) {
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body || {};
}

// Keep only user/assistant turns from the client. Any client-supplied
// "system" message is dropped.
function sanitizeHistory(incoming) {
  if (!Array.isArray(incoming)) return [];
  return incoming
    .filter(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim()
    )
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_CHARS) }))
    .slice(-MAX_HISTORY_MESSAGES);
}

// --- Repeated messages -------------------------------------------------------------
// If the customer sends the same message again after the AI already answered it, the
// model is told so, otherwise it tends to re-run the same list, reasoning and question.
const MIN_REPEAT_CHARS = 10; // shorter replies ("yes", "chlorine") are legitimately reused

const REPEATED_MESSAGE_NOTE = `IMPORTANT - REPEATED MESSAGE: The customer's latest message is word-for-word the same as one they already sent earlier in this conversation, and you already answered it. Treat it as a cue to move the conversation forward, not to answer again.
- Begin with a brief, warm acknowledgement that does not sound like a correction (for example: "Thanks, I've got that.").
- Do NOT repeat or restate anything you already told them: do not re-list tests or parameters, do not repeat your reasoning, do not summarise your earlier recommendation. At most point back to it in a few words (for example: "the tests I listed above").
- Do NOT ask any question you have already asked, even reworded.
- Then add something NEW and useful: ONE different, more specific question you have not asked yet, or a concrete next step (for example how to collect a sample, which result to look out for, or which test format suits them). Only if you have not yet given any recommendation, give your best one now from what you know.
- If the message is a short reply that plausibly answers a newer question than before, just continue normally.`;

// Compare ignoring case, spacing and surrounding punctuation.
const normalizeForCompare = (text) =>
  text.toLowerCase().replace(/\s+/g, " ").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");

// A message that was sent again straight away, with no AI reply in between, was never
// answered (typically the first attempt failed or timed out). Keep only the last copy so
// a plain "send it again" is treated as the first time, not as a repeat.
function dropUnansweredRepeats(history) {
  return history.filter(
    (m, i) =>
      !(
        m.role === "user" &&
        history[i + 1]?.role === "user" &&
        normalizeForCompare(m.content) === normalizeForCompare(history[i + 1].content)
      )
  );
}

// True when the latest user message equals an earlier one that the AI already answered.
function isAnsweredRepeat(history) {
  const last = history[history.length - 1];
  const key = normalizeForCompare(last.content);
  if (key.length < MIN_REPEAT_CHARS) return false;
  return history.some(
    (m, i) =>
      i < history.length - 1 &&
      m.role === "user" &&
      normalizeForCompare(m.content) === key &&
      history.slice(i + 1, -1).some((later) => later.role === "assistant")
  );
}

// An error that maps to a specific HTTP status and a message that is safe to show
// to customers.
class ChatError extends Error {
  constructor(code, status, message, retryable = false) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

const timeoutError = () =>
  new ChatError("timeout", 504, "The AI took too long to respond. Please try again.");

// Retry stalls, network failures, or a model-specific 404 with the next configured model.
// Authentication, rate-limit, and unrelated request errors are returned without retrying.
const isRetryable = (error) =>
  error.code === "timeout" ||
  error.code === "unreachable" ||
  error.code === "model_unavailable" ||
  error.retryable;

function toChatError(error, meta) {
  if (error instanceof ChatError) return error;
  if (error?.name === "AbortError") return timeoutError();
  meta.errorDetail = [error?.message, error?.cause?.code].filter(Boolean).join(" / ");
  return new ChatError("unreachable", 502, "Could not reach the AI service. Please try again.");
}

// Human-readable message from an upstream error body: {error:{message}}, {error:"..."},
// {message}, or {detail}.
function upstreamMessage(data) {
  const found = typeof data?.error === "string" ? data.error : data?.error?.message ?? data?.message ?? data?.detail;
  if (!found) return "";
  return (typeof found === "string" ? found : JSON.stringify(found)).slice(0, 300);
}

// Some models, including the previously configured nex-n2.5-pro, answer with a JSON
// object instead of prose, and the key varies: {"message": ...},
// {"response": ...}, {"answer": ...}, {"assistant_response": ...}, {"assistantMessage": ...},
// or a structured object like {"water_type": ..., "parameters": [...], "test_format": ...}.
// Customers must never see raw JSON, so:
//   1. an object with a prose field   -> show just that text
//   2. a flat object of plain values  -> show it as a readable bullet list
//   3. anything else that is JSON     -> not renderable (caller reports an error)
// The invariant: a reply that starts like a JSON object ({ "key": ... }, optionally in a
// ```json fence) is NEVER shown raw. It is often cut off part-way (live examples: no closing
// brace, or truncated inside nested content), so it is repaired by closing whatever is open.
// Replies that do not start like a JSON object are returned untouched.
const PROSE_KEYS = ["message", "response", "reply", "answer", "question", "assistantmessage", "assistantresponse", "text", "content"];
// "{" followed by a quote, a closing brace, or nothing (a reply cut off right after the "{")
const JSON_OBJECT_START = /^\{\s*("|\}|$)/;
const JSON_FENCE = /^```(?:json)?[ \t]*\n([\s\S]*?)\n?(?:```[ \t]*)?$/i; // closing fence optional (cut off)
const keyId = (key) => key.toLowerCase().replace(/[^a-z]/g, "");
const isPlain = (v) => ["string", "number", "boolean"].includes(typeof v);
const humanizeKey = (key) => {
  const words = key.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

// Close whatever a cut-off JSON text left open: an unfinished string, a dangling key or
// trailing comma, and every open { and [ (innermost first).
function repairJson(text) {
  const open = [];
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") open.push(ch);
    else if (ch === "}" || ch === "]") open.pop();
  }
  let out = inString ? `${text}"` : text;
  if (open[open.length - 1] === "[") {
    // inside an array: drop an element that was cut off mid-string, keep finished ones
    if (inString) out = out.replace(/([,[]\s*)"(?:[^"\\]|\\.)*"$/, "$1");
  } else {
    // inside an object: a key with no value (a string after "," or "{" is always a key)
    out = out.replace(/([,{]\s*)"[^"\\]*"\s*:?\s*$/, "$1");
  }
  out = out.replace(/,\s*$/, ""); // trailing comma
  return out + open.reverse().map((c) => (c === "{" ? "}" : "]")).join("");
}

// The parsed object, or null when it looks like JSON but cannot be made sense of.
function parseJsonObject(text) {
  for (const candidate of [text, repairJson(text)]) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch {
      // try the repaired text
    }
  }
  return null;
}

function unwrapJsonReply(reply) {
  const fenced = JSON_FENCE.exec(reply);
  const candidate = fenced ? fenced[1].trim() : reply;
  if (!JSON_OBJECT_START.test(candidate)) return { text: reply };
  const obj = parseJsonObject(candidate);
  if (obj === null) return { text: null, unwrapped: "unrenderable" };

  const keys = new Map(Object.keys(obj).map((k) => [keyId(k), k]));
  for (const id of PROSE_KEYS) {
    const value = obj[keys.get(id)];
    if (typeof value === "string" && value.trim()) return { text: value.trim(), unwrapped: "prose" };
  }

  const entries = Object.entries(obj).filter(([, v]) => !(typeof v === "string" && !v.trim()));
  const flat = entries.every(([, v]) => isPlain(v) || (Array.isArray(v) && v.every(isPlain)));
  if (entries.length && flat) {
    const list = entries
      .map(([k, v]) => `- **${humanizeKey(k)}:** ${Array.isArray(v) ? v.join(", ") : v}`)
      .join("\n");
    return { text: list, unwrapped: "fields" };
  }
  return { text: null, unwrapped: "unrenderable" };
}

// One JSON log line per request for Vercel Runtime Logs. Never includes the API
// key or any message text; only sizes, timings and outcomes.
function logRequest(meta) {
  const { startedAt, ...fields } = meta;
  const line = JSON.stringify({ event: "chat", ...fields, totalMs: Date.now() - startedAt });
  if (meta.outcome === "ok") console.log(line);
  else console.error(line);
}

async function attemptOnce({ baseUrl, apiKey, model, messages, meta, timeoutMs }) {
  const attemptStartedAt = Date.now();
  const controller = new AbortController();
  let timer;
  // The deadline is a race, not only an abort signal, so the client gets an answer
  // even if the socket never reacts to the abort.
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(timeoutError());
    }, timeoutMs);
  });

  const exchange = (async () => {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.35,
        max_tokens: MAX_OUTPUT_TOKENS,
        reasoning_effort: REASONING_EFFORT,
      }),
      signal: controller.signal,
    });
    meta.upstreamStatus = response.status;
    meta.headersMs = Date.now() - attemptStartedAt;

    // Read the body as text under the same signal: a body that stalls is a timeout,
    // not an "empty response".
    const raw = await response.text();
    meta.bodyMs = Date.now() - attemptStartedAt;

    let data = null;
    try {
      data = JSON.parse(raw);
    } catch {
      meta.rawSnippet = raw.slice(0, 200);
    }

    if (!response.ok) {
      const message = upstreamMessage(data);
      // errorDetail keeps the raw body when there is no structured message, so logs
      // and the JSON "detail" field always show why the upstream failed.
      meta.errorDetail = message || raw.slice(0, 300) || "(empty response body)";
      meta.upstreamRequestId = data?.error?.request_id || response.headers.get("x-request-id");
      if (response.status === 429) {
        throw new ChatError(
          "rate_limited",
          429,
          "The AI service is busy right now. Please try again in a moment."
        );
      }
      if (response.status === 404 && /\bmodel\b/i.test(message)) {
        throw new ChatError("model_unavailable", 502, "The selected AI model is unavailable.");
      }
      throw new ChatError(
        "upstream_error",
        502,
        `The AI service returned an error (HTTP ${response.status})${message ? `: ${message}` : "."}`
      );
    }

    if (!data) {
      throw new ChatError("bad_response", 502, "The AI service returned an unreadable response.");
    }

    const choice = data.choices?.[0];
    meta.finishReason = choice?.finish_reason;
    meta.promptTokens = data.usage?.prompt_tokens;
    meta.completionTokens = data.usage?.completion_tokens;
    meta.reasoningTokens = data.usage?.completion_tokens_details?.reasoning_tokens;
    meta.hadReasoning = Boolean(choice?.message?.reasoning_content || choice?.message?.reasoning);

    const reply = choice?.message?.content?.trim();
    if (!reply) {
      throw new ChatError(
        "empty_reply",
        502,
        choice?.finish_reason === "length"
          ? "The AI ran out of tokens before answering. Please try again."
          : "The AI returned an empty answer. Please try again.",
        true
      );
    }
    const { text, unwrapped } = unwrapJsonReply(reply);
    if (unwrapped) meta.unwrappedJson = unwrapped;
    if (text === null) {
      throw new ChatError("bad_response", 502, "The AI service returned an unreadable response.");
    }
    // The model occasionally stops after a token or two ("{", "For"): never show that.
    if (text.replace(/[^\p{L}\p{N}]/gu, "").length < MIN_REPLY_ALNUM) {
      meta.degenerateReply = true;
      throw new ChatError("empty_reply", 502, "The AI returned an empty answer. Please try again.");
    }
    return text;
  })();

  try {
    return await Promise.race([exchange, deadline]);
  } catch (error) {
    throw toChatError(error, meta);
  } finally {
    clearTimeout(timer);
  }
}

// Up to MAX_ATTEMPTS identical requests; the first success is returned immediately.
async function callModel({ baseUrl, apiKey, messages, meta }) {
  meta.attempts = [];
  let lastError;

  for (const model of MODELS) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Per-attempt fields describe the attempt that decided the outcome.
    delete meta.upstreamStatus;
    delete meta.headersMs;
    delete meta.bodyMs;
    delete meta.rawSnippet;
    delete meta.degenerateReply;

    const startedAt = Date.now();
    const timeoutMs = lastError && model !== MODELS[0] ? MODEL_FALLBACK_TIMEOUT_MS : ATTEMPT_TIMEOUT_MS;
    try {
      const reply = await attemptOnce({ baseUrl, apiKey, model, messages, meta, timeoutMs });
      meta.attempts.push({ model, attempt, timeoutMs, outcome: "ok", ms: Date.now() - startedAt });
      return { reply, model };
    } catch (error) {
      meta.attempts.push({ model, attempt, timeoutMs, outcome: error.code, ms: Date.now() - startedAt });
      lastError = error;
      if (!isRetryable(error)) return Promise.reject(lastError);
    }
  }
  }

  if (lastError.code === "timeout") {
    const deadlines = [...new Set(meta.attempts.map(({ timeoutMs }) => timeoutMs))];
    const timing = deadlines.length === 1
      ? `tried ${meta.attempts.length} times, ${deadlines[0] / 1000}s each`
      : `tried ${meta.attempts.length} times, with ${deadlines.map((ms) => `${ms / 1000}s`).join(" and ")} deadlines`;
    throw new ChatError(
      "timeout",
      504,
      `The AI took too long to respond (${timing}). Please try again.`
    );
  }
  throw lastError;
}

// --- Real product context -------------------------------------------------------------------
// The model never sees product names, prices or links (it could repeat or mangle them). It is
// told only how many real products are being shown and which parameters they are listed for.

const NO_MATCH_TOPIC_MAX = 3;

function noMatchTopic(needs) {
  const explicit = parameterLabels(needs.explicit);
  if (explicit.length) return explicit.slice(0, NO_MATCH_TOPIC_MAX).join(", ");
  return needs.label || parameterLabels(needs.parameters).slice(0, NO_MATCH_TOPIC_MAX).join(", ") || "this";
}

function productContext(needs, catalog) {
  const topics = parameterLabels(needs.parameters).join(", ");
  if (catalog.status === "ok") {
    const n = catalog.products.length;
    const covers = [...new Set(catalog.products.flatMap((p) => p.covers))].join(", ");
    return `PRODUCT CONTEXT: The app is showing ${n} real TestAllWater product${n === 1 ? "" : "s"} as product cards under your reply, listed for: ${covers}. Tests relevant to this conversation: ${topics}. Say the options are shown below and explain in plain words which of these tests matter and why. Do not name, price or link any product yourself.`;
  }
  if (catalog.status === "no_match") {
    return `PRODUCT CONTEXT: The TestAllWater catalog has NO product matching: ${noMatchTopic(needs)}. Say clearly that no matching product was found in the TestAllWater catalog. Do not name, suggest or invent any product, price or link. You can still explain which tests are relevant.`;
  }
  if (catalog.status === "unavailable") {
    return `PRODUCT CONTEXT: The product catalog could not be checked right now. Do not name or suggest any specific product; tell the customer you can't show product options at the moment, and carry on explaining which tests are relevant (${topics}).`;
  }
  return "";
}

const SAYS_NO_MATCH = /\bno (?:matching|suitable|relevant)\b[^.\n]{0,60}\b(?:product|kit|test)s?\b|\bno (?:product|kit|test)s?\b.{0,40}\b(?:found|available|listed)\b|couldn.?t find (?:a |any )?(?:matching |suitable )?(?:product|kit)|(?:don.?t|do not|doesn.?t|does not) (?:currently )?(?:have|list|stock|sell|carry)/i;
const SAYS_UNAVAILABLE = /couldn.?t (?:check|load|reach|access)|can.?t show (?:product|any)|unable to (?:check|show|load)|catalog(?:ue)? (?:is )?(?:un|temporar)/i;

// Cleans the model's text and makes sure the customer is always told plainly when there is no
// product, or when the catalog could not be checked, even if the model forgot to say so.
function finalizeReply(reply, needs, catalog, meta) {
  const guarded = guardReply(reply, catalog.products);
  if (guarded.removed) meta.guardRemoved = guarded.removed;
  let text = guarded.text;
  if (!text) {
    text = catalog.products.length
      ? "Here are the options from the TestAllWater catalog that match what you told me."
      : "Could you tell me a little more about your water so I can suggest the right test?";
  }
  if (catalog.status === "no_match" && !SAYS_NO_MATCH.test(text)) {
    text += `\n\n**No matching product found:** the TestAllWater catalog doesn't currently list a product for ${noMatchTopic(needs)}.`;
  }
  if (catalog.status === "unavailable" && !SAYS_UNAVAILABLE.test(text)) {
    text += "\n\n**Product options unavailable:** I couldn't check the TestAllWater catalog just now, so I can't show products at the moment. Please try again shortly.";
  }
  return text;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.NARA_ROUTER_API_KEY;
  const baseUrl = (process.env.NARA_ROUTER_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");

  if (!apiKey) {
    console.error(JSON.stringify({ event: "chat_config_error", problem: "NARA_ROUTER_API_KEY is not set" }));
    return res.status(500).json({ error: "NARA_ROUTER_API_KEY is not configured in Vercel." });
  }

  const history = sanitizeHistory(parseBody(req).messages);

  if (history.length === 0 || history[history.length - 1].role !== "user") {
    return res.status(400).json({ error: "No user message supplied." });
  }

  const conversation = dropUnansweredRepeats(history);
  const repeated = isAnsweredRepeat(conversation);

  const userMessages = conversation.filter((m) => m.role === "user").map((m) => m.content);
  const state = deriveConversationState(conversation, parseBody(req).state);
  const needs = analyzeNeeds(userMessages, state);
  const readiness = assessRecommendationReadiness(userMessages, needs, conversation, state);

  if (!readiness.ready && (needs.wantsProducts || state.waterType || state.pendingWaterTypeSwitch)) {
    const guided = guidedResponse(state, readiness, userMessages.at(-1) ?? "");
    state.lastAskedField = guided.field;
    state.lastAskedOptions = guided.options;
    state._lastAssistantReply = guided.reply;
    return res.status(200).json({
      reply: guided.reply,
      options: guided.options,
      model: "readiness-gate",
      readiness,
      state,
      ready: false,
    });
  }

  // Product matching is allowed only after the deterministic readiness gate is satisfied.
  const catalog = repeated || !needs.wantsProducts || !readiness.ready
    ? { status: "skipped", products: [], meta: {} }
    : await findProducts(needs);

  // The notes go into the single system message (some models mishandle several).
  const system = [
    SYSTEM_PROMPT,
    `KNOWN FACTS:\n- Water type: ${state.waterType || "not known"}\n- Water subtype: ${state.waterSubtype || "not known"}\n- Water source: ${state.waterSource || "not known"}\n- Treatment: ${state.treatment || "not applicable or not known"}\n- Issues reported: ${state.issues?.length ? state.issues.join(", ") : "none"}\n- Testing scope: ${state.testingScope || "not known"}\n- Parameters: ${needs.parameters.length ? parameterLabels(needs.parameters).join(", ") : "not known"}\n- Goal: ${state.goal || "not known"}\nDO NOT ASK FOR THESE AGAIN. This structured state is authoritative; do not reset context for short answers. The deterministic next missing field is "${getNextMissingField(state)}". If it is not "ready", ask about ONLY that field and do not ask about any known field. Use any structured quick-reply options returned by the backend. If it is "ready", answer using the known facts without restarting clarification.`,
    readiness.ready ? "RECOMMENDATION STATUS: READY. The required context has been gathered. Do not ask for information already provided; give a recommendation based on the gathered details." : "",
    repeated ? REPEATED_MESSAGE_NOTE : "",
    productContext(needs, catalog),
  ]
    .filter(Boolean)
    .join("\n\n");
  const messages = [{ role: "system", content: system }, ...conversation];
  const requestId = req.headers?.["x-vercel-id"] || randomUUID();
  const meta = {
    requestId,
    models: MODELS,
    model: MODEL,
    reasoningEffort: REASONING_EFFORT,
    historyMessages: conversation.length,
    startedAt: Date.now(),
    readiness: { ready: readiness.ready, missing: readiness.missing },
  };
  if (repeated) meta.repeatedMessage = true;
  if (conversation.length !== history.length) meta.droppedUnansweredRepeats = history.length - conversation.length;
  if (catalog.status !== "skipped") {
    meta.catalog = { status: catalog.status, shown: catalog.products.length, ...catalog.meta };
    meta.needs = { context: needs.context, parameters: needs.parameters };
  }

  try {
    const result = await callModel({ baseUrl, apiKey, messages, meta });
    const constrainedReply = constrainQuestionToState(result.reply, readiness);
    if (constrainedReply !== result.reply) meta.rejectedKnownFieldQuestion = true;
    const reply = finalizeReply(constrainedReply, needs, catalog, meta);
    state._lastAssistantReply = reply;
    meta.model = result.model;
    meta.outcome = "ok";
    meta.replyChars = reply.length;
    logRequest(meta);
    const body = { reply, options: [], model: result.model, readiness, state, ready: readiness.ready };
    if (catalog.products.length) body.products = catalog.products;
    return res.status(200).json(body);
  } catch (error) {
    meta.outcome = error.code;
    logRequest(meta);
    return res
      .status(error.status)
      .json({ error: error.message, code: error.code, requestId, detail: meta.errorDetail });
  }
}
