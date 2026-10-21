import { randomUUID } from "node:crypto";
import {
  analyzeNeeds,
  assessRecommendationReadiness,
  constrainQuestionToState,
  deriveConversationState,
  guidedResponse,
  getNextMissingField,
  parameterLabels,
  isPureProductFollowup,
  hasImmediateProductOrProblemSignal,
  EDUCATIONAL_QUESTION,
  PARAM_BY_ID,
} from "./_needs.js";
import { findProducts } from "./_catalog.js";
import { guardReply } from "./_guard.js";
import { knowledgeContext } from "./_knowledge.js";
import { enrichEvent, logEvent } from "./_telemetry.js";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MODEL = "claude-sonnet-5-5";

// Each attempt (connect + headers + body) gets a hard deadline. A retryable failure
// (timeout, network error, or the service being temporarily overloaded) gets one more
// attempt with the identical request and a longer deadline. Other failures are not retried.
const ATTEMPT_TIMEOUT_MS = 9000;
const RETRY_TIMEOUT_MS = 20000;
const MAX_ATTEMPTS = 2;
const MAX_OUTPUT_TOKENS = 1000;
const MIN_REPLY_ALNUM = 4; // a reply with fewer letters/digits than this is a truncated glitch
const MAX_HISTORY_MESSAGES = 12;
const MAX_MESSAGE_CHARS = 4000;

// The system prompt lives on the server so clients cannot replace it and use
// this endpoint as a free general-purpose LLM proxy.
const SYSTEM_PROMPT = `
You are TestAllWater's specialist water-testing assistant — an expert water-testing advisor
who explains things simply, asks only useful questions, remembers context, and recommends the
most appropriate TestAllWater product once there is enough information.

Your job is to help customers understand WHAT THEY SHOULD TEST and WHICH TYPE
OF TEST METHOD is appropriate. You are a water-testing/product-discovery
assistant, not a generic chatbot.

HOW YOU COME ACROSS:
You feel like a knowledgeable friend and teacher — not a sales bot, not a generic chatbot, and
not an interrogation form. Help first, sell second: the customer should learn something useful
every turn, even one where you're still narrowing things down.
- Tone: friendly, confident, simple, human, helpful. Not robotic, not overly enthusiastic, not
  salesy. No unnecessary emojis.
- Teach while you diagnose: when the customer describes a problem, briefly explain what it can
  indicate IN THE SAME MESSAGE as your next question — never a bare question on its own, and
  never a separate "explanation" message followed by a separate "question" message. Use the
  "WATER TESTING KNOWLEDGE" note (added below when relevant) as your factual basis.
- Ask only useful questions: before asking anything, check that the answer would materially
  change what you recommend or how you explain things. Never ask just because a field exists.
  Different situations need different amounts of information — do not force a fixed number of
  questions.
- Keep replies short and conversational: normally one short explanation plus either one question
  or one recommendation. Avoid long lectures or walls of bullet points; a short list is fine when
  a few distinct parameters genuinely need naming, but do not over-explain.

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
A "WATER TESTING KNOWLEDGE" note may be added to these instructions with the facts relevant
to this conversation (what the customer's issue may indicate, which parameters matter and why).
Treat it as your factual basis and explain it naturally and simply; never add facts beyond it.
For drinking water especially: say what a test CAN tell the customer rather than a stronger
claim — never say or imply that a consumer test proves water is medically or legally safe,
unless the knowledge/product information actually supports that. Never diagnose human illness.

PRODUCT RULE:
You can only know about TestAllWater products through a "PRODUCT CONTEXT" note that may be
added to these instructions. Never invent, guess or recall product names, brands, model
numbers, prices, stock, SKUs, ratings, images or links, and never name a specific product
yourself. When the note says products were found, the app shows them as product cards under
your reply: do not repeat their names or prices, refer to them as "the options below", and say
in plain words which parameters they cover. When the note says no product was found, say
clearly that no matching product was found in the TestAllWater catalog and continue helping
with advice. Without a note, recommend test types and parameters only. If a related but
imperfect option is offered instead of an exact match, say plainly that it's the closest
alternative rather than describing it as if it were exactly what was asked for.
If the customer gives test results, say briefly whether each value looks low, normal or high
for that kind of water, and which further test is worth doing.
A "PRODUCT FOLLOW-UP" note may be added when the customer is asking about the products already
shown (which one to pick, whether one covers something, price comparisons). Answer only from
the facts it lists (by position: "the first option", "the second option"); if something is
asked that isn't in that note, say you don't have that detail rather than guessing.

STYLE:
Be concise, friendly, knowledgeable and practical. Avoid long lectures.
- Normally 2-4 short sentences, or a short paragraph plus a short list when a few distinct
  items genuinely need naming — never a wall of text, and never more than one short list.
- Use Markdown naturally: **bold** a genuinely key term or the headline recommendation, not
  every sentence; a short bullet list only when comparing or naming several items; never pile up
  headings for a reply this short.
- Say the recommendation plainly, then briefly why — do not bury it in a long explanation.
- Never repeat a disclaimer, a safety note, or an explanation you already gave earlier in this
  conversation; say it once, then refer back to it briefly if it comes up again.
- Never use filler or generic AI phrasing — none of: "As an AI...", "I'd be happy to...",
  "Based on your request/message...", "Please provide the following information...", "Certainly!",
  "I understand that...". Just answer, the way a knowledgeable person would.
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

// The Anthropic Messages API requires messages to strictly alternate user/assistant and
// to start with a user turn. The client-side conversation can have consecutive turns of the
// same role (e.g. a resend after a failure), so adjacent same-role turns are merged, and any
// leading assistant turn with no preceding user turn is dropped.
function toAnthropicMessages(conversation) {
  const merged = [];
  for (const m of conversation) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) {
      last.content += `\n${m.content}`;
    } else {
      merged.push({ role: m.role, content: m.content });
    }
  }
  while (merged.length && merged[0].role !== "user") merged.shift();
  return merged;
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

// The customer explicitly asked to skip ahead to products, or is frustrated with the
// questions (see detectShowProductsOverride in _needs.js). Help first, sell second: give the
// best recommendation from what is already known rather than gathering more.
const RELAXED_READINESS_NOTE = `IMPORTANT - CUSTOMER ASKED TO SKIP AHEAD: The customer asked to see products directly, or is frustrated with the questions. Do not ask any further clarifying question.
- Use only the facts already known (see KNOWN FACTS) to explain and recommend.
- If some detail is still unknown, make the best reasonable recommendation anyway rather than asking for it.
- Keep it brief and helpful; do not apologise at length for having asked questions.`;

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

// Retry stalls, network failures, or the service being temporarily overloaded, with the
// identical request. Authentication, rate-limit, and unrelated request errors are returned
// without retrying.
const isRetryable = (error) =>
  error.code === "timeout" ||
  error.code === "unreachable" ||
  error.code === "overloaded" ||
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

// Some models answer with a JSON object instead of prose, and the key varies:
// {"message": ...}, {"response": ...}, {"answer": ...}, {"assistant_response": ...},
// {"assistantMessage": ...}, or a structured object like {"water_type": ..., "parameters":
// [...], "test_format": ...}.
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

async function attemptOnce({ apiKey, system, messages, meta, timeoutMs }) {
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
    const response = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        system,
        messages,
        max_tokens: MAX_OUTPUT_TOKENS,
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
      meta.upstreamRequestId = data?.request_id || response.headers.get("request-id");
      if (response.status === 429) {
        throw new ChatError(
          "rate_limited",
          429,
          "The AI service is busy right now. Please try again in a moment."
        );
      }
      if (response.status === 529) {
        throw new ChatError(
          "overloaded",
          503,
          "The AI service is temporarily overloaded. Please try again in a moment.",
          true
        );
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

    meta.finishReason = data.stop_reason;
    meta.promptTokens = data.usage?.input_tokens;
    meta.completionTokens = data.usage?.output_tokens;

    const reply = data.content?.find((block) => block?.type === "text")?.text?.trim();
    if (!reply) {
      throw new ChatError(
        "empty_reply",
        502,
        data.stop_reason === "max_tokens"
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

// Up to MAX_ATTEMPTS identical requests to the one configured model; the first success is
// returned immediately.
async function callModel({ apiKey, system, messages, meta }) {
  meta.attempts = [];
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Per-attempt fields describe the attempt that decided the outcome.
    delete meta.upstreamStatus;
    delete meta.headersMs;
    delete meta.bodyMs;
    delete meta.rawSnippet;
    delete meta.degenerateReply;

    const startedAt = Date.now();
    const timeoutMs = attempt === 1 ? ATTEMPT_TIMEOUT_MS : RETRY_TIMEOUT_MS;
    try {
      const reply = await attemptOnce({ apiKey, system, messages, meta, timeoutMs });
      meta.attempts.push({ attempt, timeoutMs, outcome: "ok", ms: Date.now() - startedAt });
      return { reply };
    } catch (error) {
      meta.attempts.push({ attempt, timeoutMs, outcome: error.code, ms: Date.now() - startedAt });
      lastError = error;
      if (!isRetryable(error)) throw lastError;
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
  return needs.productQuery || needs.label || parameterLabels(needs.parameters).slice(0, NO_MATCH_TOPIC_MAX).join(", ") || "what the customer asked for";
}

// What the customer named that none of the shown products covers (e.g. radon asked after a lead
// test is already shown), as labels — or "" when every named parameter is covered.
function uncoveredExplicit(needs, catalog) {
  const shown = new Set(catalog.products.flatMap((p) => p.covers));
  return parameterLabels(needs.explicit).filter((label) => !shown.has(label)).join(", ");
}

function productContext(needs, catalog) {
  const topics = parameterLabels(needs.parameters).join(", ");
  if (catalog.status === "ok") {
    const n = catalog.products.length;
    const [primary, ...extra] = catalog.products;
    const covers = [...new Set(catalog.products.flatMap((p) => p.covers))].join(", ");
    // A product/brand lookup or a plain browse request covers no specific parameter (covers is
    // empty) — the model is told that plainly instead of being handed an empty list to describe.
    let note = covers
      ? `PRODUCT CONTEXT: The app is showing ${n} real TestAllWater product${n === 1 ? "" : "s"} as product cards under your reply, listed for: ${covers}. Tests relevant to this conversation: ${topics}. The customer ${needs.explicit.length ? `asked only about ${parameterLabels(needs.explicit).join(", ")}` : "did not name a specific test"}; the rest are the usual checks for this kind of water — never say the customer mentioned them.`
      : `PRODUCT CONTEXT: The app is showing ${n} real TestAllWater product${n === 1 ? "" : "s"} as product cards under your reply, matching ${needs.productQuery ? `the product the customer asked about` : "what the customer wants to browse"}.`;
    note += primary.covers.length
      ? ` Recommend clearly: the first one (covering ${primary.covers.join(", ")}) is the best fit for what the customer described. Connect their problem to why these parameters matter, then present it as your main recommendation. Call it "the option below" (or "the first option" if more than one is shown) — never name, price or link it yourself.`
      : ` Present ${n === 1 ? "it" : "them"} as "the option${n === 1 ? "" : "s"} below" — never name, price or link ${n === 1 ? "it" : "them"} yourself.`;
    if (extra.length) {
      const extraCovers = [...new Set(extra.flatMap((p) => p.covers))].join(", ");
      note += extraCovers
        ? ` ${extra.length === 1 ? "One additional option is" : `${extra.length} additional options are`} also shown, covering: ${extraCovers}. Mention ${extra.length === 1 ? "it" : "them"} only as optional — soft language like "if you want to go a little further..." — and only when genuinely useful here, never as a requirement and never just to add more products.`
        : ` ${extra.length === 1 ? "One more option is" : `${extra.length} more options are`} also shown.`;
    } else {
      note += " There is nothing else to add beyond this one unless the customer asks for more.";
    }
    const missing = uncoveredExplicit(needs, catalog);
    if (missing) note += ` No product in the TestAllWater catalog covers: ${missing}. Say plainly that no matching product was found for ${missing}; do not suggest the options shown are for it.`;
    return note;
  }
  if (catalog.status === "no_match") {
    return `PRODUCT CONTEXT: The TestAllWater catalog has NO product matching: ${noMatchTopic(needs)}. Say clearly that no matching product was found in the TestAllWater catalog. Do not name, suggest or invent any product, price or link. You can still explain which tests are relevant.`;
  }
  if (catalog.status === "unavailable") {
    return `PRODUCT CONTEXT: The product catalog could not be checked right now. Do not name or suggest any specific product; tell the customer you can't show product options at the moment, and carry on explaining which tests are relevant (${topics}).`;
  }
  return "";
}

// A follow-up about products already on the customer's screen ("which one would you
// recommend?", "does this test iron?", "do you have something cheaper?") — answered only from
// the same real facts those cards already show (price, stock, covered parameters), referred to
// by position exactly as productContext's own "the first option" convention does, never by a
// name the model might get wrong.
function productFollowupContext(state) {
  const lines = state.lastProducts.map((p, i) => {
    const ordinal = ["first", "second", "third"][i] ?? `option ${i + 1}`;
    const covers = p.covers.length ? p.covers.join(", ") : "no listed parameters on record";
    const stock = p.available ? "in stock" : "currently out of stock";
    return `- The ${ordinal} option: covers ${covers}; ${p.price || "price shown on its card"}; ${stock}.`;
  });
  return `PRODUCT FOLLOW-UP: The customer is asking about the product(s) already shown earlier in the chat (they are above your reply, so never say "below"), listed here by position (the same "first option"/"second option" ordering already used). Answer ONLY from these real facts — never invent a capability, price, or comparison point not listed here. If the customer asks for something not covered by this information (e.g. an exact spec not listed), say you don't have that detail rather than guessing.\n${lines.join("\n")}`;
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
  const missing = catalog.status === "ok" && !catalog.products.some((p) => !p.covers.length) ? uncoveredExplicit(needs, catalog) : "";
  if (missing && !SAYS_NO_MATCH.test(text)) {
    text += `\n\n**No matching product found:** the TestAllWater catalog doesn't currently list a product for ${missing}.`;
  }
  if (catalog.status === "unavailable" && !SAYS_UNAVAILABLE.test(text)) {
    text += "\n\n**Product options unavailable:** I couldn't check the TestAllWater catalog just now, so I can't show products at the moment. Please try again shortly.";
  }
  return text;
}

// The Shopify Custom Section calls this endpoint from the storefront's own origin (a
// different domain from where this function is deployed), so the browser needs an explicit
// CORS allow before it will let that cross-origin fetch through at all. This endpoint takes
// no cookies/credentials and holds no secrets reachable from the response, so a permissive
// default is a reasonable, well-documented choice (see README "Shopify Custom Section");
// CORS_ALLOWED_ORIGINS lets it be tightened to the real storefront domain(s) in production.
function applyCors(req, res) {
  // Read fresh each call (not cached at module load) so it reflects the environment at
  // request time, same as every other env-driven setting in this handler.
  const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || "*")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  const origin = req.headers?.origin;
  if (allowedOrigins.includes("*")) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export default async function handler(req, res) {
  const startedAt = Date.now();
  applyCors(req, res);
  // The browser's CORS preflight for a cross-origin POST with a JSON body; nothing to answer
  // beyond the allow headers above.
  if (req.method === "OPTIONS") {
    return res.status(200).json({});
  }
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    console.error(JSON.stringify({ event: "chat_config_error", problem: "ANTHROPIC_API_KEY is not set" }));
    return res.status(500).json({ error: "ANTHROPIC_API_KEY is not configured in Vercel." });
  }

  const history = sanitizeHistory(parseBody(req).messages);

  if (history.length === 0 || history[history.length - 1].role !== "user") {
    return res.status(400).json({ error: "No user message supplied." });
  }

  const conversation = dropUnansweredRepeats(history);
  const repeated = isAnsweredRepeat(conversation);

  const userMessages = conversation.filter((m) => m.role === "user").map((m) => m.content);
  const incomingState = parseBody(req).state;
  const state = deriveConversationState(conversation, incomingState);
  const needs = analyzeNeeds(userMessages, state);
  const readiness = assessRecommendationReadiness(userMessages, needs, conversation, state);

  const requestId = req.headers?.["x-vercel-id"] || randomUUID();
  // A stable id for the whole conversation, round-tripped the same way `state` already is
  // (the frontend passes it back opaquely): generated once, then carried on every turn. Used
  // only to group this conversation's log events for later review — never sent to Anthropic
  // or Shopify, and never shown to the customer.
  state.conversationId = typeof incomingState?.conversationId === "string" && incomingState.conversationId
    ? incomingState.conversationId
    : randomUUID();

  // Entering the deterministic gate (vs. a raw, unstructured model reply) whenever there is
  // already SOME signal worth acting on: wanting products, a known water type, a pending
  // switch, having relaxed the gate, or THIS message's own buying intent or described problem,
  // even with nothing else yet named ("Which product should I buy?", "water tastes weird") —
  // checked against the latest message alone (hasImmediateProductOrProblemSignal), not the
  // sticky needs.productIntent/needs.problem, which would otherwise stay true for the rest of
  // the conversation the moment any earlier turn set state.goal.
  // A plain question ("how often should I test my hot tub?") is answered by the model, which is
  // still told the next missing field; a question describing a problem still gets the gate.
  const latestText = userMessages.at(-1) ?? "";
  const educational = EDUCATIONAL_QUESTION.test(latestText) && !hasImmediateProductOrProblemSignal(latestText) &&
    !state.pendingWaterTypeSwitch;
  if (!readiness.ready && !educational && (needs.wantsProducts || state.waterType || state.pendingWaterTypeSwitch ||
    state.relaxedReadiness || hasImmediateProductOrProblemSignal(latestText))) {
    const guided = guidedResponse(state, readiness, userMessages.at(-1) ?? "");
    state.lastAskedField = guided.field;
    state.lastAskedOptions = guided.options;
    state._secondLastAssistantReply = state._lastAssistantReply;
    state._lastAssistantReply = guided.reply;
    const meta = {
      requestId,
      model: "readiness-gate",
      historyMessages: conversation.length,
      startedAt,
      readiness: { ready: readiness.ready, missing: readiness.missing },
      outcome: "ok",
      replyChars: guided.reply.length,
      needs: { context: needs.context, parameters: needs.parameters },
    };
    if (repeated) meta.repeatedMessage = true;
    if (state.relaxedReadiness) meta.relaxedReadiness = true;
    if (conversation.length !== history.length) meta.droppedUnansweredRepeats = history.length - conversation.length;
    logEvent(enrichEvent(meta, state));
    return res.status(200).json({
      reply: guided.reply,
      options: guided.options,
      model: "readiness-gate",
      readiness,
      state,
      ready: false,
    });
  }

  // A follow-up about the products already shown ("which one would you recommend?", "does this
  // test iron?", "do you have something cheaper?") — answered from the real facts already on
  // those cards (price, stock, covered parameters), never a new search or a new name/figure.
  // Checked first so it can also skip a redundant catalog search: the sticky state that keeps
  // readiness "ready" (e.g. an explicit parameter named earlier) would otherwise make every
  // later turn re-search for the same products all over again.
  const latestMessage = userMessages.at(-1) ?? "";
  const productFollowup = state.lastProducts.length > 0 && isPureProductFollowup(latestMessage);

  // Product matching is allowed only after the deterministic readiness gate is satisfied.
  const catalog = repeated || !needs.wantsProducts || !readiness.ready || productFollowup || educational
    ? { status: "skipped", products: [], meta: {} }
    : await findProducts(needs);

  // A rare parameter the store has no product for (radon, PFAS) has now been answered; keep it
  // out of later searches, or every following turn repeats the same "no matching product".
  if (catalog.status === "ok" || catalog.status === "no_match") {
    const shown = new Set(catalog.products.flatMap((p) => p.covers));
    state.parameters = state.parameters.filter((id) => !PARAM_BY_ID[id]?.rare || shown.has(PARAM_BY_ID[id].label));
  }

  if (catalog.status === "ok") {
    state.lastProducts = catalog.products.slice(0, 3).map((p, i) => ({
      position: i + 1,
      price: p.price?.display ?? "",
      available: p.available !== false,
      covers: p.covers ?? [],
    }));
  } else if (catalog.status === "no_match") {
    state.lastProducts = []; // the topic moved on; older cards must not answer a follow-up
  }

  // The notes go into the single system prompt (the Anthropic API takes it as a separate
  // top-level field, not as a message in the conversation).
  const system = [
    SYSTEM_PROMPT,
    `KNOWN FACTS:\n- Water type: ${state.waterType || "not known"}\n- Water subtype: ${state.waterSubtype || "not known"}\n- Water source: ${state.drinkingSource || state.waterSource || "not known"}\n- Treatment: ${state.treatment || "not applicable or not known"}\n- Issue: ${state.issue || "none"}\n- Issue details: ${state.issueDetails?.length ? state.issueDetails.join(", ") : "none"}\n- Issues reported: ${state.issues?.length ? state.issues.join(", ") : "none"}\n- Testing scope: ${state.testingScope || "not known"}\n- Parameters: ${needs.parameters.length ? parameterLabels(needs.parameters).join(", ") : "not known"}\n- Goal: ${state.goal || "not known"}\nDO NOT ASK FOR THESE AGAIN. This structured state is authoritative; do not reset context for short answers. The deterministic next missing field is "${getNextMissingField(state)}". If it is not "ready", ask about ONLY that field and do not ask about any known field. Use any structured quick-reply options returned by the backend. If it is "ready", answer using the known facts without restarting clarification.`,
    readiness.ready ? "RECOMMENDATION STATUS: READY. The required context has been gathered. Do not ask for information already provided; give a recommendation based on the gathered details." : "",
    repeated ? REPEATED_MESSAGE_NOTE : "",
    state.relaxedReadiness ? RELAXED_READINESS_NOTE : "",
    knowledgeContext(state, needs),
    productContext(needs, catalog),
    productFollowup ? productFollowupContext(state) : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const messages = toAnthropicMessages(conversation);
  const meta = {
    requestId,
    model: MODEL,
    historyMessages: conversation.length,
    startedAt,
    readiness: { ready: readiness.ready, missing: readiness.missing },
  };
  if (repeated) meta.repeatedMessage = true;
  if (state.relaxedReadiness) meta.relaxedReadiness = true;
  if (conversation.length !== history.length) meta.droppedUnansweredRepeats = history.length - conversation.length;
  if (catalog.status !== "skipped") {
    meta.catalog = { status: catalog.status, shown: catalog.products.length, ...catalog.meta };
    meta.needs = { context: needs.context, parameters: needs.parameters };
  }

  try {
    const result = await callModel({ apiKey, system, messages, meta });
    const constrainedReply = constrainQuestionToState(result.reply, readiness);
    if (constrainedReply !== result.reply) meta.rejectedKnownFieldQuestion = true;
    let reply = finalizeReply(constrainedReply, needs, catalog, meta);
    let options = [];
    if (reply && (reply === state._lastAssistantReply || reply === state._secondLastAssistantReply)) {
      if (readiness.ready) {
        const parameterSummary = needs.parameters.length ? parameterLabels(needs.parameters).join(", ") : "the relevant parameters";
        reply = `I have your ${state.waterType || "water"} test details noted. Here are the TestAllWater options for ${parameterSummary}.`;
      } else {
        const next = guidedResponse(state, readiness, userMessages.at(-1) ?? "");
        reply = next.reply || "What kind of water are you testing?";
        options = next.options;
        state.lastAskedField = next.field;
        state.lastAskedOptions = next.options;
      }
    }
    state._secondLastAssistantReply = state._lastAssistantReply;
    state._lastAssistantReply = reply;
    meta.outcome = "ok";
    meta.replyChars = reply.length;
    logEvent(enrichEvent(meta, state));
    const body = { reply, options, model: MODEL, readiness, state, ready: readiness.ready };
    if (catalog.products.length) body.products = catalog.products;
    return res.status(200).json(body);
  } catch (error) {
    meta.outcome = error.code;
    logEvent(enrichEvent(meta, state));
    return res
      .status(error.status)
      .json({ error: error.message, code: error.code, requestId, detail: meta.errorDetail });
  }
}
