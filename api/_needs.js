// Turns what the customer has said into a structured "need": which kind of water, which
// parameters/tests matter, and whether they are looking for a product. Deterministic and
// keyword based on purpose: the result drives which REAL catalog products are searched for,
// so it must never depend on the (sometimes flaky) language model.
//
// (Files starting with "_" in /api are helpers, not Vercel functions.)

import { issueIndicates } from "./_knowledge.js";

const p = (id, label, user, product = user, rare = false) => ({ id, label, user, product, rare });

// user:    how a customer mentions the parameter
// product: how a product's own title/tags/type mention it (used to verify a product really
//          covers the parameter before claiming it does)
export const PARAMS = [
  p("chlorine", "free and total chlorine", /\b(?:free |total |combined )?chlorine\b|\bcl2\b|\bdpd\b/i, /chlorine|\bdpd\b/i),
  p("ph", "pH", /\bph\b/i, /\bph\b|phenol red/i),
  p("alkalinity", "total alkalinity", /\balkalinity\b/i),
  p("calcium_hardness", "calcium hardness", /calcium hardness|\bcalcium\b/i),
  p("hardness", "water hardness", /\b(?:total |water )?hardness\b|\bhard water\b|limescale/i, /hardness/i),
  p("cyanuric_acid", "cyanuric acid (stabiliser)", /cyanuric|stabili[sz]er|\bcya\b/i),
  p("bromine", "bromine", /\bbromine\b/i),
  p("ammonia", "ammonia", /\bammonia\b|\bnh3\b|\bnh4\b/i),
  p("nitrite", "nitrite", /\bnitrites?\b|\bno2\b/i),
  p("nitrate", "nitrate", /\bnitrates?\b|\bno3\b/i),
  p("phosphate", "phosphate", /\bphosphates?\b|\bphosphorus\b/i),
  p("iron", "iron", /\biron\b|\brust(?:y)?\b|orange (?:stain|water)/i, /\biron\b/i),
  p("copper", "copper", /\bcopper\b/i),
  p("dissolved_oxygen", "dissolved oxygen", /dissolved oxygen|\boxygen\b/i, /dissolved oxygen|\boxygen\b/i),
  p("salinity", "salinity", /salinity|specific gravity|refractometer|\bsalt level\b/i, /salinity|\bsalt\b|nacl|refractometer/i),
  p("tds", "TDS / conductivity", /\btds\b|total dissolved|conductivity/i, /\btds\b|conductivity/i),
  p("turbidity", "turbidity", /\bturbidity\b/i),
  p("lead", "lead", /\blead\b(?!\s+(?:to|the|a|me|you|us|time)\b)/i, /\blead\b/i),
  p("arsenic", "arsenic", /\barsenic\b/i),
  p("fluoride", "fluoride", /\bfluorid(?:e|ation)\b/i),
  p("chloride", "chloride", /\bchloride\b/i),
  p(
    "coliform",
    "bacteria (coliform / E. coli)",
    /coliform|\be\.? ?coli\b|\bbacteri(?:a|al)\b|legionella|pseudomonas/i,
    /coliform|\be\.? ?coli\b|bacteri|microbio|dipslide|legionella|pseudomonas|colilert|colitag/i
  ),
  // Things customers ask about that a water-test shop may simply not sell. They are searched
  // like any other parameter; if the store has nothing, the customer is told so.
  p("pfas", "PFAS", /\bpfas\b|forever chemicals|\bpfoa\b|\bpfos\b/i, /\bpfas\b|pfoa|pfos/i, true),
  p("radon", "radon", /\bradon\b/i, /\bradon\b/i, true),
  p("uranium", "uranium", /\buranium\b/i, /\buranium\b/i, true),
  p("mercury", "mercury", /\bmercury\b/i, /\bmercury\b/i, true),
  p("cadmium", "cadmium", /\bcadmium\b/i, /\bcadmium\b/i, true),
  p("pesticides", "pesticides", /pesticide|herbicide|glyphosate/i, /pesticide|herbicide|glyphosate/i, true),
  p("microplastics", "microplastics", /microplastic/i, /microplastic/i, true),
];

export const PARAM_BY_ID = Object.fromEntries(PARAMS.map((x) => [x.id, x]));

// The kinds of water. First match wins in this order (most specific first).
export const CONTEXTS = [
  { id: "spa", label: "hot tub water", user: /hot ?tub|\bspa\b|jacuzzi|whirlpool|swim ?spa/i },
  { id: "pool", label: "pool water", user: /\bpool\b|swimming/i },
  { id: "pond", label: "pond water", user: /\bpond\b|\bkoi\b/i },
  { id: "aquarium", label: "aquarium water", user: /aquarium|fish ?tank|\bfish\b|\breef\b|shrimp|\bcoral\b|axolotl|(?:fresh|salt|marine)water tank|nano tank/i },
  // "well" alone is too common ("as well", "works well"): it must be a water well.
  { id: "well", label: "well water", user: /\bwell water\b|\b(?:my|our|the|a|private|own) well\b|borehole|private (?:water )?supply|spring water/i },
  { id: "drinking", label: "drinking water", user: /drinking water|tap water|\btap\b|potable|mains water|household water|bottled water|\bdrink\b/i },
];

// What is worth testing for each kind of water when the customer has not named a parameter.
const DEFAULTS = {
  pool: ["chlorine", "ph", "alkalinity", "calcium_hardness", "cyanuric_acid"],
  spa: ["chlorine", "ph", "alkalinity"],
  aquarium: ["ammonia", "nitrite", "nitrate", "ph"],
  pond: ["ammonia", "nitrite", "nitrate", "ph"],
  well: ["coliform", "nitrate", "iron", "hardness", "ph"],
  drinking: ["ph", "chlorine", "hardness", "nitrate", "lead"],
};

// Pool and spa are one family of product, as are aquarium/pond and well/drinking — a pool kit
// is never the right answer for a fish tank. Mirrors api/_catalog.js's own FAMILY grouping
// (kept as an independent copy rather than imported, so this module's parameter-ambiguity
// classification below has no dependency on the catalog layer).
const WATER_FAMILY = { pool: "pool", spa: "pool", aquarium: "aquatic", pond: "aquatic", well: "supply", drinking: "supply" };

// A parameter is "ambiguous" when it is a default check for more than one FAMILY of water (e.g.
// chlorine matters for pool/spa AND drinking water, and the right product genuinely differs by
// family — so knowing the water type still changes the recommendation). A parameter that is
// either a default for only one family, or never defaulted at all (named explicitly only, e.g.
// PFAS or iron), is "unambiguous": once the customer names it, the water type no longer changes
// which product is right, so it should not block a recommendation. Computed from DEFAULTS
// itself rather than a hand-maintained list, so it can never drift out of sync with it.
const AMBIGUOUS_PARAMS = new Set(
  Object.entries(
    Object.entries(DEFAULTS).reduce((families, [context, ids]) => {
      const family = WATER_FAMILY[context];
      for (const id of ids) (families[id] ??= new Set()).add(family);
      return families;
    }, {})
  )
    .filter(([, families]) => families.size > 1)
    .map(([id]) => id)
);

// Real TestAllWater-carried brands (the same list api/_guard.js uses to catch the model naming a
// product it shouldn't). Exported from here, the more foundational module, so _guard.js imports
// it rather than each file keeping its own copy.
export const BRANDS = [
  "lovibond", "palintest", "hanna", "hach", "lamotte", "la motte", "milwaukee", "eutech", "trace2o", "idexx",
  "johnson analytica", "water-i.d", "water-id", "poollab", "test all water", "testallwater", "easy dip", "exact micro",
  "tetra", "jbl", "sera", "salifert", "seachem", "red sea", "nyos", "aquachek", "taylor", "api",
];
const BRAND_LOOKUP = new RegExp(`\\b(${BRANDS.map((b) => b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i");
// Phrasing that asks whether the store carries something specific, as opposed to just mentioning
// a brand in passing.
const PRODUCT_LOOKUP_PHRASE = /\bdo you (?:have|sell|stock|carry|do|offer)\b|\blooking for\b|\bsearching for\b|\bcan i (?:get|buy|find)\b/i;

// A specific named product/brand request (e.g. "Do you have the Lovibond Checkit 5 in 1?") —
// searched directly against the store's own product search (which matches on title), rather
// than by parameter, since there is no catalog of exact model names to match against here. Only
// triggers alongside a real "do you have/sell X" style question or a test-ish word, so an
// incidental brand mention in passing ("I had a Hanna meter years ago") is not treated the same
// way; see api/_guard.js's BRAND_RE for the matching list this reuses.
function detectProductQuery(text) {
  if (!BRAND_LOOKUP.test(text)) return null;
  if (!PRODUCT_LOOKUP_PHRASE.test(text) && !TESTWORD.test(text)) return null;
  const cleaned = text
    .replace(/^.*?\b(?:do you (?:have|sell|stock|carry|do|offer)|looking for|searching for|can i (?:get|buy|find))\b/i, "")
    .replace(/^\s*(?:the|a|an)\s+/i, "")
    .replace(/[?!.]+\s*$/, "")
    .trim();
  return (cleaned || text.trim()).slice(0, 120) || null;
}

// Symptoms that add parameters (context is required for most; a null context means "any").
const SYMPTOMS = [
  { re: /gasping|oxygen|lethargic|at the surface/i, adds: ["dissolved_oxygen"], contexts: ["aquarium", "pond"] },
  { re: /algae|green water|murky/i, adds: ["phosphate"], contexts: ["aquarium", "pond"] },
  { re: /rust|orange|brown|stain/i, adds: ["iron"], contexts: ["well", "drinking"] },
  { re: /metallic|bitter taste|copper taste/i, adds: ["iron", "copper", "lead"], contexts: ["well", "drinking"] },
  { re: /safe to drink|safe to use|contaminat|\bill\b|\bsick\b|diarrh|upset stomach/i, adds: ["coliform", "nitrate"], contexts: ["well", "drinking"] },
  { re: /marine|reef|saltwater|salt water|\bcoral\b/i, adds: ["salinity"], contexts: ["aquarium"] },
];

// The parameters a symptom alone implies (e.g. "tastes metallic" -> iron/copper/lead),
// independent of whether the customer named any of them explicitly. Shared by analyzeNeeds (the
// full candidate list driving search) and deriveConversationState (to tell a single-cause
// symptom apart from one with several plausible causes — see the "symptom-pending" testingScope
// below), so the two can never drift apart on what counts as ambiguous.
function matchedSymptomParams(text, context) {
  const adds = [];
  for (const symptom of SYMPTOMS) {
    if (symptom.re.test(text) && (!context || symptom.contexts.includes(context))) adds.push(...symptom.adds);
  }
  return unique(adds);
}

const DESCRIPTORS = /\b(cloudy|green|murky|foamy|foaming|discoloured|discolored|smelly|cloudiness)\b/i;
const PROBLEM = /cloudy|green|murky|foam|smell|odou?r|taste|stain|dirty|algae|itch|irritat|burn|sick|\bill\b|dying|dead|gasping|safe|contaminat|unsafe|problem|issue|wrong|weird|strange|rust|orange|brown|metallic|hard water|scale/i;
const TESTWORD = /\btest(?:s|ing|ed|er|ers)?\b|\bkit\b|\bstrips?\b|\bmeter\b|\bphotometer\b|\bchecker\b/i;
const INTENT = /\b(buy|purchase|order|price|cost|how much|which (?:test|kit|strips?|product)|what (?:test|kit|strips?|product)|recommend|suggest|looking for|i need (?:a|an|some)|do you (?:sell|have|stock)|where can i (?:get|buy)|shop|product)s?\b/i;
const HAS_VALUE = /\b\d+(?:[.,]\d+)?\s*(?:ppm|mg\/?l|ppb|µg\/?l|ug\/?l|µs|us\/?cm|ms\/?cm|°?[fd]h|dh|%)|\b(?:ph|chlorine|alkalinity|nitrate|nitrite|ammonia|cya|cyanuric acid|hardness|phosphate|tds|bromine|iron|copper|lead)\s*(?:is|was|of|=|:|at|reads?|read|showing|shows?)?\s*\d/i;
// An explanation-seeking question ("What does pH mean?", "Do I need to test alkalinity?") rather
// than a product request — naming a parameter here must not, on its own, be read as wanting
// products (see its two uses below). Anchored to the start of the message, not the whole
// conversation, so it only ever describes the customer's LATEST turn.
export const EDUCATIONAL_QUESTION = /^\s*(?:what(?:'?s| is| does| are)\b|why(?: is| does| do| are)\b|how(?: does| do| often| long)\b|when should\b|do i need to\b|should i\b|is it (?:important|necessary)\b|what'?s? the difference\b)/i;

// A question asking whether a named thing might be the CAUSE of a symptom ("could it be iron?",
// "is it maybe lead?") is not the same as asking to test for it. Naming a parameter here must
// not, on its own, count as an explicit request — unlike a bare mention backed by real
// buying/testing language (INTENT/TESTWORD) — or it would silently skip the ambiguous-symptom
// clarification below and assume a test the customer never actually asked for.
const CAUSE_QUESTION = /\b(?:could|might|can|may) (?:it|that|this) be\b|\bis (?:it|that|this)(?: maybe| possibly)?\b[^.!?\n]{0,15}\?|\bdo you think (?:it'?s|it is|that'?s)\b/i;

// Whether THIS message alone shows real buying intent or describes a problem — unlike
// analyzeNeeds' productIntent/problem, which also fall back to state.goal and so stay true for
// the rest of the conversation once goal is set once (e.g. by a bare "troubleshooting" answer),
// this only ever looks at the current turn's own words. Used by chat.js to decide whether a
// message with nothing else going for it yet (no water type, no parameter) — "Which product
// should I buy?", "what test should I get", "water tastes weird" — still deserves the same
// structured next question as one that does, rather than falling through to an unstructured
// model reply, without that decision staying permanently true for every later turn too.
// TESTWORD is deliberately excluded: it matches the bare word "testing" in passing ("I am
// curious about water testing"), too weak a signal on its own to force the structured gate —
// INTENT already covers the genuine buying-intent phrasings that happen to use "test"/"kit".
export function hasImmediateProductOrProblemSignal(text) {
  return INTENT.test(text) || PROBLEM.test(text);
}

// A follow-up question about the products already shown (e.g. "Which one would you recommend?",
// "Does this test iron?", "Do you have something cheaper?", "Why this one?", "How do I use it?",
// "What does this test tell me?") rather than a new search — answered from state.lastProducts'
// real, already-on-screen facts (see chat.js), never a new catalog call.
// Includes bare ordinal/demonstrative references ("that one", "the second one") made after
// multiple products are shown — the customer is pointing at a specific card, not asking a new
// question, but it still needs the real shown-product facts (and the right one, by position —
// productFollowupContext already labels them "the first option"/"the second option") rather than
// a fresh, redundant search.
export const PRODUCT_FOLLOWUP_INTENT = /\bwhich (?:one|option|kit)\b|\bis (?:this|that|it) (?:one )?(?:good|suitable|right|enough)\b|\bdoes (?:this|that|it) (?:one )?(?:test|cover|include)\b|\bcheaper\b|\bmore expensive\b|\bmore (?:things|parameters|tests)\b|\bwhat'?s the difference\b|\bdifference between\b|\bcompare\b|\bwhich (?:would you|do you) recommend\b|\bbetter (?:one|option)\b|\b(?:is|are) (?:it|this|that|they|these) (?:in stock|available)\b|\bwhy (?:this|that|would you recommend|did you)\b|\bhow do i use\b|\bhow (?:do|would|does) (?:this|that|it) work\b|\bwhat does (?:this|that|it) (?:tell|show|mean|measure|cover)\b|\bwhat does this test (?:measure|tell|show|mean|cover)\b|\bwhat does (?:this|that|it) test for\b|\b(?:that|this) one\b|\bthe (?:first|second|third) (?:one|option)\b|\boption (?:one|two|three|\d)\b/i;

// The customer is rejecting a product already shown (e.g. "no, not this one", "none of these",
// "that's not what I meant", "guide me") — not merely asking a follow-up about it. Used by
// chat.js to skip re-searching/re-showing the same declined products and tell the model plainly
// what happened, instead of silently repeating the recommendation (see REJECTION_NOTE).
export const PRODUCT_REJECTION = /\bnot this (?:one)?\b|\bnot that (?:one)?\b|\bnone of (?:these|those)\b|\b(?:don'?t|doesn'?t) (?:like|want) (?:this|that|these|those)\b|\bthat'?s not (?:it|right|what i (?:meant|wanted|was looking for))\b|\bwrong (?:one|product|test|kit)\b|\b(?:can you )?(?:please )?(?:just )?guide me\b|\bi'?m (?:still |a bit |a little )?confused\b/i;

// A rejection that specifically asks for a DIFFERENT product, rather than guidance — "show me
// something else", "something different", "another option", "anything else". Still a rejection
// (see PRODUCT_REJECTION, recommendationStatus), but handled by chat.js with a real search that
// excludes the handles already shown (needs.excludeHandles), instead of skipping the search.
export const WANTS_ALTERNATIVE = /\bsomething else\b|\bsomething different\b|\banother option\b|\bshow me another\b|\ba different (?:one|option|test|kit)\b|\banything else\b|\bwhat else (?:do you have|is there|can i (?:test|check))\b/i;

// The customer is accepting/confirming the shown recommendation (e.g. "I want this", "I'll take
// it", "sounds good", "that works") — kept narrow and only ever checked once a product has
// actually been shown, so it never collides with an unrelated bare "yes"/"sure" elsewhere in the
// guided-question flow.
export const ACCEPTS_RECOMMENDATION = /\bi'?ll (?:take|get|have|go with) (?:it|this|that)\b|\bi want (?:this|that)(?:\s+one)?\b|\bsounds good\b|\bthat works\b|\bperfect\b|\bthat'?s (?:the one|perfect|great|it)\b|\blet'?s go with (?:this|that)\b/i;

// Whether the latest message is a PURE follow-up about products already shown: the follow-up
// phrasing above, with no new structured signal (a water type, a parameter, a brand/product
// lookup, or a fresh browse request) that would mean a real new search is actually needed. Used
// by chat.js to skip a redundant catalog search for a turn like "which one would you recommend?"
// once products are already on screen — while still searching again the instant anything new is
// actually said (e.g. "do you have one that also tests lead?" still names a new parameter).
export function isPureProductFollowup(text) {
  if (!PRODUCT_FOLLOWUP_INTENT.test(text)) return false;
  if (CONTEXTS.some((c) => c.user.test(text))) return false;
  if (PARAMS.some((p) => p.user.test(text))) return false;
  if (SHOW_PRODUCTS_REQUEST.test(text)) return false;
  if (BRAND_LOOKUP.test(text)) return false;
  return true;
}

// An explicit request to skip ahead to products, or frustration with the questions. Once seen,
// the readiness gate stops asking the "soft" fields (goal, scope, subtype/source) — and, for a
// genuinely context-free "just show me what you have", the kind-of-water question too (see
// canSkipWaterType below): a customer who explicitly asked to browse should never be
// interrogated first, per the product-discovery redesign.
// The "show me ... products/kits/tests/options" and "want(s/ed) to see ... products/options/
// tests/kits" branches allow ordinary words in between ("show me your water testing products",
// "I just want to see your water testing products") rather than only the exact phrase, and
// "what ... kits/tests/products do you sell/have/offer/carry" / "what do you have for/in ..."
// cover the equally natural "asking, not telling" phrasing of the same browse request.
// Exported so chat.js can check whether THIS turn is an explicit "show me products" ask (e.g.
// to allow a fresh search after a rejection) without relying on state.relaxedReadiness, which is
// sticky once set and so can't say whether this specific message asked for it.
export const SHOW_PRODUCTS_REQUEST = /\bjust show me\b|\bshow me\b[^.!?\n]{0,40}\b(?:products|options|kits?|tests?|testing|strips?|stuff|supplies|range|what you (?:have|sell|offer))\b|\bskip (?:the )?questions\b|\bskip ahead\b|\bno more questions\b|\bwant(?:s|ed)? to see\b[^.!?\n]{0,40}\b(?:products|options|tests|kits|what you (?:have|sell|offer))\b|\bcan you just (?:show|recommend)\b|\bjust (?:recommend|suggest)(?: me| us)? something\b|\benough questions\b|\bjust tell me what to (?:buy|get)\b|\bjust browsing\b|\bi(?:'m| am) just looking\b|\bwhat\b[^.!?\n]{0,30}\b(?:kits?|tests?|products?|strips?)\b[^.!?\n]{0,20}\bdo you (?:sell|have|offer|carry)\b|\bwhat do you have (?:for|in)\b/i;
const FRUSTRATION = /\bstop asking(?: me)?\b|\btoo many questions\b|\bthis is taking (?:too long|forever)\b|\bi(?:'m| am) frustrat\w*\b|\bannoy(?:ed|ing)\b|\bjust answer\b|\bi don'?t want to answer (?:more|any more) questions\b/i;
const RELAXED_READINESS_TRIGGER = new RegExp(`${SHOW_PRODUCTS_REQUEST.source}|${FRUSTRATION.source}`, "i");

// General guidance-seeking or confusion ("guide me", "I'm confused", "what should I do") with no
// product or problem signal of its own (see hasImmediateProductOrProblemSignal) — distinct from
// FRUSTRATION/RELAXED_READINESS_TRIGGER above, which means "skip ahead, just show me products."
// This customer isn't impatient for a product; they need orientation. Routed by chat.js past the
// readiness gate into a natural Claude reply, WITHOUT forcing a product search the way relaxed
// readiness does (see "seeksGuidance" in chat.js) — asking one further question, if genuinely
// needed, is left to Claude's own reply rather than the gate's structured buttons.
export const GUIDANCE_SEEKING = /\bguide me\b|\bi'?m (?:still |a bit |a little )?confused\b|\bwhat should i do\b|\bi don'?t know what to do\b|\bcan you (?:just )?help me\b|\bi need (?:some )?guidance\b/i;

// A single "not sure" is normal conversation (handled gracefully per-field below); two in a row
// signals the customer genuinely can't give more detail, which is its own kind of frustration —
// switch to the same helpful fallback as an explicit request rather than asking a third time.
const GENERAL_UNCERTAIN = /^\s*(?:not sure|unsure|no idea|maybe|i don'?t know)\s*[.!]?\s*$/i;
const UNCERTAIN_STREAK_FOR_RELAXED = 2;

function detectContext(text) {
  for (const c of CONTEXTS) if (c.user.test(text)) return c.id;
  return null;
}

const unique = (list) => [...new Set(list)];

const POOL_TREATMENT_QUESTION = /chlorine[- ]treated.*saltwater.*bromine/i;
const TEST_SCOPE_QUESTION = /recently tested.*chlorine.*pH.*complete check/i;
const TEST_SCOPE_CLARIFICATION = /you want to check pH.*also like to check chlorine/i;
const SCOPE_COMPLETE = /\b(?:complete|full|routine|general|basic|broad|all[- ]round)\s+(?:water\s+)?(?:test|check|screen|screening|panel)\b|\b(?:haven't|have not|never|not yet)\s+(?:recently\s+)?tested\b|\b(?:already|recently)\s+tested\b|\btest results?\b|\bresults?\s+(?:are|show|showing|read|came)\b/i;
const SWITCH_INTENT = /\b(?:switch(?:ing)?|change|changing|instead|actually|rather than|new test)\b/i;

const WATER_TYPE_QUESTION = "What kind of water are you testing?";
const TREATMENT_QUESTION = "Is your pool chlorine-treated, saltwater, or treated with bromine?";
const SCOPE_CLARIFICATION = "Got it — you want to check pH. Would you also like to check chlorine?";
const ISSUE_WORDS = ["cloudy", "green", "murky", "foamy", "smelly", "discoloured", "discolored"];
const OTHER_OPTION = { label: "Other / Type my answer", value: "__other__" };
const ISSUE_PATTERNS = [
  { id: "high_chlorine", legacy: null, detail: "high chlorine", re: /(?:chlorine|cl2).{0,20}\b(?:too high|high|elevated)\b|\b(?:too high|high|elevated)\b.{0,20}(?:chlorine|cl2)/i },
  { id: "low_chlorine", legacy: null, detail: "low chlorine", re: /(?:chlorine|cl2).{0,20}\b(?:too low|low)\b|\b(?:too low|low)\b.{0,20}(?:chlorine|cl2)/i },
  { id: "green_water", legacy: "green", detail: "green water", re: /\bgreen\b.{0,20}\b(?:water|pool|algae)?\b|\b(?:water|pool)\b.{0,20}\bgreen\b/i },
  { id: "cloudy_water", legacy: "cloudy", detail: "cloudy water", re: /\bcloudy\b.{0,20}\b(?:water|pool)?\b|\b(?:water|pool)\b.{0,20}\bcloudy\b/i },
];

function detectIssue(text) {
  return ISSUE_PATTERNS.find(({ re }) => re.test(text)) ?? null;
}

function detectTreatment(text) {
  if (/\b(?:salt\s*water|saltwater)(?:\s+pool)?\b/i.test(text)) return "saltwater";
  if (/\bbromine(?:[- ]treated)?(?:\s+pool)?\b|\btreated with bromine\b/i.test(text)) return "bromine";
  if (/\bchlorine[- ]treated\b|\bchlorinated pool\b|\b(?:use|using|treated with|treat(?:ed) with)\s+chlorine\b|^\s*chlorine\s*[.!]?\s*$/i.test(text)) return "chlorine";
  return null;
}

function detectAquariumType(text) {
  if (/\b(?:salt\s*water|saltwater|marine|reef)\b/i.test(text)) return "saltwater";
  if (/\b(?:fresh\s*water|freshwater|tropical)\b/i.test(text)) return "freshwater";
  return null;
}

function detectWaterSource(text) {
  const match = /\b(?:tap|mains|bottled|well|spring)(?: water)?\b|\bprivate (?:water )?supply\b|\bborehole\b/i.exec(text)?.[0];
  if (!match) return null;
  return /\btap\b/i.test(match) || /\bmains\b/i.test(match) ? "tap"
    : /\bwell\b|private|\bborehole\b/i.test(match) ? "well"
      : /\bspring\b/i.test(match) ? "spring" : "bottled";
}

function contextLabel(context) {
  return CONTEXTS.find((item) => item.id === context)?.label ?? "";
}

function isExplicitSwitch(text, candidate) {
  return SWITCH_INTENT.test(text) && Boolean(candidate);
}

function resetWaterSpecificState(state, waterType) {
  state.waterType = waterType;
  state.treatment = null;
  state.testingScope = null;
  state.waterSubtype = null;
  state.waterSource = null;
  state.pendingWaterTypeSwitch = null;
  // A named issue (cloudy/green/high or low chlorine) is pool/spa-specific vocabulary; it must
  // not silently carry over as a stale "known fact" once the conversation is about a different
  // kind of water (it would otherwise reach the system prompt and the knowledge layer as if it
  // still applied, found via Phase 5 QA on a pool -> aquarium switch).
  state.issue = null;
  state.issueDetails = [];
  state.issues = [];
  state.symptomCandidates = [];
  // Same for parameters (pool chlorine must not become an aquarium "known fact"); any named in
  // the switching message itself are added back right after this by the caller.
  state.parameters = [];
  // Products shown for the previous kind of water are no longer relevant once the topic has
  // genuinely moved on — a "does this test X" follow-up after a real topic change must not be
  // answered from stale, now-irrelevant product data.
  state.lastProducts = [];
  // Whether a recommendation was accepted/rejected is specific to the recommendation it was
  // about — a fresh topic has no recommendation yet to have a status on.
  state.recommendationStatus = null;
}

function answerToPendingSwitch(text, candidate) {
  return /^\s*(?:yes|yeah|yep|yes please|yes[, ]+(?:aquarium|pool|spa|hot tub|pond|tap water|drinking water|well water))\s*[.!]?\s*$/i.test(text) &&
    (!detectContext(text) || detectContext(text) === candidate);
}

function fieldAskedBy(reply) {
  if (/switch from .* to|switching to .* instead/i.test(reply)) return "waterTypeSwitch";
  if (/what kind of water are you testing|where is the water from|which setting is closest/i.test(reply)) return "waterType";
  if (/freshwater or saltwater/i.test(reply)) return "aquariumType";
  if (/source of your drinking water|tap, .*private well/i.test(reply)) return "waterSource";
  if (/general screen, or checking a specific concern/i.test(reply)) return "testingScope";
  if (/routine testing.*troubleshoot|troubleshoot.*routine testing|what are you trying to find out/i.test(reply)) return "goal";
  if (/pool chlorine-treated, saltwater|treated with bromine/i.test(reply)) return "treatment";
  if (/what are you trying to check|what would you like to check|would you also like to check chlorine|recently tested.*complete check/i.test(reply)) {
    return "testingScope";
  }
  if (/what are you hoping to check|what are you looking to test/i.test(reply)) return "goal";
  return null;
}

export function deriveConversationState(conversation, previousState = null) {
  const validTypes = new Set(CONTEXTS.map((item) => item.id));
  const state = {
    waterType: validTypes.has(previousState?.waterType) ? previousState.waterType : null,
    treatment: ["chlorine", "saltwater", "bromine"].includes(previousState?.treatment) ? previousState.treatment : null,
    parameters: Array.isArray(previousState?.parameters)
      ? unique(previousState.parameters.filter((id) => Object.hasOwn(PARAM_BY_ID, id)))
      : [],
    // Recomputed fresh from the latest turn's own text every time (see the turn loop below),
    // never carried forward from a stale earlier turn — a specific product lookup should only
    // drive this turn's search, not keep the conversation "stuck" searching for it later.
    productQuery: typeof previousState?.productQuery === "string" ? previousState.productQuery : null,
    // A compact, privacy-safe summary of the products last shown (see chat.js), so a follow-up
    // question ("is this one good for my well?", "do you have something cheaper?") can be
    // answered from the same real facts already on the customer's own screen — never a name or
    // URL the model could mangle, only what the cards themselves already show: price, stock, and
    // which parameters each one covers.
    lastProducts: Array.isArray(previousState?.lastProducts)
      ? previousState.lastProducts
          .filter((p) => p && typeof p === "object")
          .map((p) => ({
            position: Number.isInteger(p.position) ? p.position : 0,
            price: typeof p.price === "string" ? p.price : "",
            available: p.available !== false,
            covers: Array.isArray(p.covers) ? p.covers.filter((c) => typeof c === "string").slice(0, 8) : [],
            // Lets a later "show me something else" exclude exactly these from a fresh search
            // (see chat.js/_catalog.js's excludeHandles) — never shown to the customer or model.
            handle: typeof p.handle === "string" ? p.handle : null,
            // The store's own listing text, truncated (see productFollowupContext in chat.js) —
            // the only authoritative source for "how do I use it"/"what does it measure" beyond
            // the parameters already in `covers`. Often empty; chat.js tells the model to say so
            // rather than invent instructions when it is.
            description: typeof p.description === "string" ? p.description.slice(0, 400) : "",
          }))
          .slice(0, 3)
      : [],
    // Whether the customer accepted, rejected, or hasn't yet reacted to the recommendation in
    // lastProducts. Cleared to null whenever lastProducts itself is cleared (a fresh topic, or
    // no recommendation made yet) — see resetWaterSpecificState.
    recommendationStatus: ["accepted", "rejected", "undecided"].includes(previousState?.recommendationStatus)
      ? previousState.recommendationStatus
      : null,
    issues: Array.isArray(previousState?.issues)
      ? unique(previousState.issues.filter((issue) => ISSUE_WORDS.includes(issue)))
      : [],
    issue: typeof previousState?.issue === "string" ? previousState.issue : null,
    issueDetails: Array.isArray(previousState?.issueDetails)
      ? unique(previousState.issueDetails.filter((detail) => typeof detail === "string"))
      : [],
    // The candidate parameters an ambiguous well/drinking symptom implies (e.g. "tastes
    // metallic" -> iron/copper/lead), held only while testingScope === "symptom-pending" so the
    // follow-up question and its resolution (see deriveConversationState below) know what the
    // customer is choosing between.
    symptomCandidates: Array.isArray(previousState?.symptomCandidates)
      ? unique(previousState.symptomCandidates.filter((id) => Object.hasOwn(PARAM_BY_ID, id)))
      : [],
    goal: typeof previousState?.goal === "string" ? previousState.goal : null,
    waterSubtype: ["freshwater", "saltwater", "unknown"].includes(previousState?.waterSubtype ?? previousState?.aquariumType)
      ? (previousState.waterSubtype ?? previousState.aquariumType)
      : null,
    waterSource: typeof previousState?.waterSource === "string" ? previousState.waterSource : null,
    drinkingSource: typeof previousState?.drinkingSource === "string" ? previousState.drinkingSource : null,
    testingScope: ["complete", "specific", "specific-pending", "not-tested", "general", "unknown", "symptom-pending"].includes(previousState?.testingScope)
      ? previousState.testingScope
      : null,
    lastAskedField: ["waterType", "goal", "treatment", "testingScope", "waterSource", "aquariumType", "waterTypeSwitch"].includes(previousState?.lastAskedField)
      ? previousState.lastAskedField
      : null,
    lastAnsweredField: ["waterType", "goal", "treatment", "testingScope", "waterSource", "aquariumType", "waterTypeSwitch"].includes(previousState?.lastAnsweredField)
      ? previousState.lastAnsweredField
      : null,
    lastAskedOptions: Array.isArray(previousState?.lastAskedOptions)
      ? previousState.lastAskedOptions
        .filter((option) => typeof option?.label === "string" && typeof option?.value === "string")
        .map(({ label, value }) => ({ label, value }))
      : [],
    lastAnswerWasAmbiguous: previousState?.lastAnswerWasAmbiguous === true,
    waterTypeClarificationCount: Number.isInteger(previousState?.waterTypeClarificationCount)
      ? Math.max(0, previousState.waterTypeClarificationCount)
      : 0,
    pendingWaterTypeSwitch:
      validTypes.has(previousState?.pendingWaterTypeSwitch?.from) &&
      validTypes.has(previousState?.pendingWaterTypeSwitch?.to)
        ? { from: previousState.pendingWaterTypeSwitch.from, to: previousState.pendingWaterTypeSwitch.to }
        : null,
    _lastAssistantReply: typeof previousState?._lastAssistantReply === "string" ? previousState._lastAssistantReply : null,
    _secondLastAssistantReply: typeof previousState?._secondLastAssistantReply === "string" ? previousState._secondLastAssistantReply : null,
    relaxedReadiness: previousState?.relaxedReadiness === true,
    uncertainStreak: Number.isInteger(previousState?.uncertainStreak) ? Math.max(0, previousState.uncertainStreak) : 0,
  };
  const users = [];
  const lastUserIndex = conversation.findLastIndex((turn) => turn.role === "user");
  const lastStateReplyIndex = previousState?._lastAssistantReply
    ? conversation.findLastIndex((turn) => turn.role === "assistant" && turn.content === previousState._lastAssistantReply)
    : -1;
  const firstTurnToProcess = previousState
    ? (lastStateReplyIndex >= 0 ? lastStateReplyIndex + 1 : Math.max(0, lastUserIndex))
    : 0;
  let priorAssistant = conversation
    .slice(0, firstTurnToProcess)
    .findLast((turn) => turn.role === "assistant")?.content ?? "";

  for (let i = firstTurnToProcess; i < conversation.length; i++) {
    const turn = conversation[i];
    if (turn.role === "assistant") {
      priorAssistant = turn.content;
      continue;
    }
    if (turn.role !== "user") continue;
    const text = turn.content.trim();
    const requestedField = state.lastAskedField ?? fieldAskedBy(priorAssistant);
    let unansweredField = null;
    state.lastAnsweredField = requestedField;
    users.push(text);

    if (RELAXED_READINESS_TRIGGER.test(text)) state.relaxedReadiness = true;
    state.uncertainStreak = GENERAL_UNCERTAIN.test(text) ? state.uncertainStreak + 1 : 0;
    if (state.uncertainStreak >= UNCERTAIN_STREAK_FOR_RELAXED) state.relaxedReadiness = true;

    const candidate = detectContext(text);
    if (state.pendingWaterTypeSwitch) {
      const pending = state.pendingWaterTypeSwitch;
      if (/\b(?:no|still|remain|keep)\b/i.test(text)) {
        state.pendingWaterTypeSwitch = null;
      } else if (
        isExplicitSwitch(text, pending.to) ||
        answerToPendingSwitch(text, pending.to) ||
        (candidate === pending.to && /switching to|switch to|change to|changing to/i.test(text))
      ) {
        resetWaterSpecificState(state, pending.to);
      }
    } else if (candidate && state.waterType && candidate !== state.waterType) {
      if (isExplicitSwitch(text, candidate)) resetWaterSpecificState(state, candidate);
      else state.pendingWaterTypeSwitch = { from: state.waterType, to: candidate };
    } else if (candidate && !state.waterType) {
      state.waterType = candidate;
      state.waterTypeClarificationCount = 0;
      state.lastAnswerWasAmbiguous = false;
    } else if (candidate && state.waterType === candidate && isExplicitSwitch(text, candidate)) {
      resetWaterSpecificState(state, candidate);
    }

    if (state.pendingWaterTypeSwitch) continue;
    if (state.waterType === "aquarium" && !state.goal) state.goal = "general testing";

    if ((state.waterType === "pool" || state.waterType === "spa") && !state.treatment) {
      const treatment = detectTreatment(text);
      const bareTreatmentAnswer = /^\s*(?:bromine|chlorine|salt\s*water|saltwater)\s*[.!]?\s*$/i.test(text);
      if (treatment && (requestedField === "treatment" || POOL_TREATMENT_QUESTION.test(priorAssistant) ||
        /\b(?:pool|spa)\b/i.test(text) || (users.length === 1 && !bareTreatmentAnswer) ||
        (bareTreatmentAnswer && requestedField === "testingScope" && state.issue === "cloudy_water") ||
        (bareTreatmentAnswer && requestedField !== "testingScope" && requestedField !== "goal"))) {
        state.treatment = treatment;
      }
    }

    if (state.waterType === "aquarium" && !state.waterSubtype) {
      const subtype = detectAquariumType(text);
      if (subtype && (requestedField === "waterType" || requestedField === "aquariumType" ||
        /freshwater or saltwater/i.test(priorAssistant) || /\b(?:aquarium|fish tank|freshwater|fresh water|saltwater|salt water|marine|reef)\b/i.test(text))) {
        state.waterSubtype = subtype;
      } else if (requestedField === "aquariumType") {
        // "not sure", or a reply that ignores the question: ask once only, never again.
        state.waterSubtype = "unknown";
      }
    }

    if (state.waterType === "drinking" || state.waterType === "well") {
      state.waterSource ??= detectWaterSource(text);
      if (!state.waterSource && requestedField === "waterSource" && /^\s*tap\s*[.!]?\s*$/i.test(text)) state.waterSource = "tap";
      if (!state.waterSource && requestedField === "waterSource" &&
        /^\s*(?:yes|no|not sure|unsure|no idea|i don't know)\s*[.!]?\s*$/i.test(text)) state.waterSource = "unknown";
    }
    if (!state.waterSource && state.drinkingSource) state.waterSource = state.drinkingSource;

    state.productQuery = detectProductQuery(text);

    const normalized = text.toLowerCase().replace(/\bsalt\s+water\b/g, "saltwater").replace(/\bph\b/gi, "pH");
    const isTreatmentAnswer = (requestedField === "treatment" || POOL_TREATMENT_QUESTION.test(priorAssistant) ||
      (state.treatment && state.issue !== "green_water")) &&
      /^\s*(?:bromine|chlorine|salt\s*water|saltwater)\s*[.!]?\s*$/i.test(text);
    // "Could it be iron?" names iron but is asking whether it might be the CAUSE, not asking to
    // test for it — unless the message also carries real buying/testing language (INTENT/
    // TESTWORD), a bare cause-question mention must not count as an explicit request, or it would
    // silently skip the ambiguous-symptom clarification below.
    const causeQuestionOnly = CAUSE_QUESTION.test(text) && !INTENT.test(text) && !TESTWORD.test(text);
    const newlyExplicit = PARAMS.filter((parameter) => parameter.user.test(normalized) &&
      !(isTreatmentAnswer && ["bromine", "chlorine"].includes(parameter.id)) &&
      !causeQuestionOnly).map((parameter) => parameter.id);

    // A newly-named parameter with nothing to do with the kind of water already being discussed
    // (e.g. "Actually, do you sell nitrate tests?" mid pool-chlorine conversation), said with
    // topic-change language, is a topic change just as much as explicitly naming a different
    // kind of water — so it is handled the same way: the old water type's own flow (its issue,
    // goal, testing scope) is cleared rather than silently mixed into a pool recommendation, or
    // left stuck asking the old question. A fresh "what kind of water" (or none at all, if the
    // new parameter turns out to be unambiguous — see canSkipWaterType) follows naturally from
    // the normal flow below once waterType is cleared.
    const topicChangedParameter = state.waterType && SWITCH_INTENT.test(text) &&
      newlyExplicit.some((id) => !(DEFAULTS[state.waterType] ?? []).includes(id));
    if (topicChangedParameter) {
      resetWaterSpecificState(state, null);
      state.goal = null;
      state.parameters = unique(newlyExplicit);
    } else {
      state.parameters = unique([...state.parameters, ...newlyExplicit]);
    }

    const recognizedIssue = detectIssue(text);
    if (recognizedIssue) {
      state.issue = recognizedIssue.id;
      state.issueDetails = unique([...state.issueDetails, recognizedIssue.detail]);
      if (recognizedIssue.legacy) state.issues = unique([...state.issues, recognizedIssue.legacy]);
    }
    const issues = ISSUE_WORDS.filter((word) => new RegExp(`\\b${word}\\b`, "i").test(text))
      .map((word) => word === "discoloured" ? "discolored" : word);
    if (issues.length) state.issues = unique([...state.issues, ...issues]);
    if (/^\s*routine(?:\s+testing)?\s*[.!]?\s*$/i.test(text)) state.goal = "routine_testing";
    else if (/^\s*troubleshooting\s*[.!]?\s*$/i.test(text)) state.goal = "troubleshooting";
    else if (recognizedIssue || PROBLEM.test(text) || /\b(?:too high|too low|high levels?|low levels?)\b/i.test(text)) state.goal = "troubleshooting";
    else if (state.waterType === "pool" && requestedField === "goal" &&
      /^\s*(?:routine testing|routine|general testing)\s*[.!]?\s*$/i.test(text)) state.goal = "routine_testing";
    else if (!state.goal && (INTENT.test(text) || TESTWORD.test(text) ||
      (!EDUCATIONAL_QUESTION.test(text) && (state.parameters.length || state.productQuery)))) {
      state.goal = state.parameters.length ? "parameter-specific testing" :
        state.productQuery ? "product lookup" :
        (state.waterType === "pool" ? null : "general testing");
    }

    if (requestedField === "testingScope" || TEST_SCOPE_QUESTION.test(priorAssistant) ||
      TEST_SCOPE_CLARIFICATION.test(priorAssistant)) {
      if (state.testingScope === "symptom-pending") {
        // Any answer resolves this — naming one of the candidates narrows to just that one;
        // "not sure"/"check all"/anything else keeps the full candidate set. Either way this
        // never asks a second time (see getNextMissingField/questionForMissingField below).
        const named = state.symptomCandidates.filter((id) => PARAM_BY_ID[id].user.test(normalized));
        state.parameters = unique([...state.parameters, ...(named.length ? named : state.symptomCandidates)]);
        state.testingScope = "specific";
        state.symptomCandidates = [];
      } else if (/^\s*i\s+(?:have not|haven't)\s+tested(?: yet)?\s*[.!]?\s*$/i.test(text)) {
        state.testingScope = "not-tested";
      } else if (state.testingScope === "not-tested" && newlyExplicit.length) {
        state.testingScope = "specific"; // answers "which result would you like to check first?"
      } else if (SCOPE_COMPLETE.test(text) || /\b(?:complete|full)\b.{0,24}\b(?:test|check)\b|\bpH\s*\+\s*chlorine\b|\bchlorine\s*\+\s*pH\b/i.test(text)) {
        if (/\bpH\s*\+\s*chlorine\b|\bchlorine\s*\+\s*pH\b/i.test(text)) {
          state.parameters = unique([...state.parameters, "ph", "chlorine"]);
          state.testingScope = "specific";
        } else {
          state.testingScope = "complete";
        }
      } else if (/\b(?:just|only)\s+pH\b|\bpH\s+only\b|\bchlorine\s+(?:and|&)\s+pH\b|\bpH\s+(?:and|&)\s+chlorine\b/i.test(text)) {
        state.testingScope = "specific";
      } else if (/^\s*p\s*\.?\s*h\s*[.!]?\s*$/i.test(text) || /^\s*pH\s*[.!]?\s*$/i.test(text)) {
        state.testingScope = "specific-pending";
      } else if (/\bspecific concern\b|\btest (?:for|my)\b/i.test(text) ||
        (state.parameters.length > 0 && !isTreatmentAnswer && !state.parameters.every((id) => id === "ph") &&
          !(state.goal === "troubleshooting" && ["green_water", "cloudy_water", "high_chlorine", "low_chlorine"].includes(state.issue) &&
            state.parameters.length === 1))) {
        state.testingScope = "specific";
      } else if (/^\s*(?:yes|yeah|yep|sure)\s*[.!]?\s*$/i.test(text)) {
        if (state.testingScope === "specific-pending" && state.parameters.includes("ph")) {
          state.parameters = unique([...state.parameters, "chlorine"]);
          state.testingScope = "specific";
        } else {
          state.testingScope = "complete";
        }
      } else if (/^\s*no\s*[.!]?\s*$/i.test(text) && state.testingScope === "specific-pending") {
        state.testingScope = "specific";
      } else if (/^\s*(?:not sure|unsure|maybe|no idea|i don't know)\s*[.!]?\s*$/i.test(text)) {
        if (requestedField === "waterSource") state.waterSource = "unknown";
      }
    }
    if (["pool", "spa"].includes(state.waterType) && state.parameters.length >= 2) state.testingScope = "specific";
    if (["pool", "spa"].includes(state.waterType) && state.goal === "troubleshooting" &&
      ["green_water", "cloudy_water", "high_chlorine", "low_chlorine"].includes(state.issue) &&
      state.parameters.length === 1 && !state.testingScope) state.testingScope = "specific-pending";
    if (["pool", "spa"].includes(state.waterType) && state.parameters.length === 1 &&
      state.parameters[0] === "ph" && !state.testingScope) state.testingScope = "specific-pending";
    if (["drinking", "well"].includes(state.waterType) && state.waterSource && state.parameters.length) {
      state.testingScope = "specific";
    }
    // Naming a specific parameter already answers "what do you want to check" — once the water
    // type is known AND the customer has explicitly named at least one parameter, a separate
    // testing-scope question is just repeating back what they already said. For well/drinking
    // specifically, a described problem (goal already "troubleshooting", e.g. "my tap water
    // tastes metallic") answers it just as well even with no literal parameter named yet (the
    // relevant parameters are only known via the symptom layer, not state.parameters) — asking
    // "general screen or specific concern" after a problem has already been described is exactly
    // the kind of redundant question this redesign set out to remove.
    //
    // Gated on state.waterType already being one of the four types that ask about testing scope
    // at all (see getNextMissingField): applying this before the water type is known would
    // pre-empt the pool/spa troubleshooting-issue flow below, which needs testingScope to still
    // be unset once waterType actually arrives (e.g. bare "my chlorine seems too high", answered
    // with the water type several turns later — the "unknown water type" regression tests pin
    // this). That flow is exempt here too, on purpose: it asks one genuinely richer follow-up
    // ("do you also know your pH?") instead of silently assuming only the one named parameter.
    // A described problem with no parameter named only answers "what to check" when it points to
    // a SINGLE likely cause ("orange staining" -> iron only). A symptom with several plausible
    // causes ("tastes metallic" -> iron/copper/lead) must not be silently assumed to mean all of
    // them — the customer is asked once which, or "not sure/check all" (testingScope =
    // "symptom-pending"; resolved above, and the question itself lives in
    // questionForMissingField/guidedOptionsForField below).
    const implicitWellDrinkingProblem = ["drinking", "well"].includes(state.waterType) &&
      state.goal === "troubleshooting" && !state.parameters.length;
    const symptomCandidates = implicitWellDrinkingProblem ? matchedSymptomParams(text, state.waterType) : [];
    if (["pool", "spa", "drinking", "well"].includes(state.waterType) && !state.testingScope &&
      (state.parameters.length || implicitWellDrinkingProblem) &&
      !(state.goal === "troubleshooting" &&
        ["green_water", "cloudy_water", "high_chlorine", "low_chlorine"].includes(state.issue))) {
      if (implicitWellDrinkingProblem && symptomCandidates.length > 1) {
        state.testingScope = "symptom-pending";
        state.symptomCandidates = symptomCandidates;
      } else {
        state.testingScope = "specific";
      }
    }
    if (!requestedField && /\b(?:complete|full)\b.{0,24}\b(?:test|check)\b/i.test(text)) {
      state.testingScope = "complete";
    }
    if (!state.goal && state.waterType === "aquarium" && state.waterSubtype) state.goal = "general testing";
    if (!state.goal && state.waterType === "drinking" && state.waterSource) state.goal = "general testing";
    state.drinkingSource = state.waterSource;
    if (!state.waterType && requestedField === "waterType" && !candidate) {
      const ambiguous = /^\s*(?:not sure|unsure|no|yes|maybe|no idea|i don't know)\s*[.!]?\s*$/i.test(text);
      state.lastAnswerWasAmbiguous = ambiguous;
      state.waterTypeClarificationCount += 1;
      unansweredField = "waterType";
    }
    state.lastAskedField = unansweredField;
  }
  state.aquariumType = state.waterSubtype;
  return state;
}

// Whether the water type can be skipped entirely rather than asked for: the customer explicitly
// asked to skip ahead or browse (relaxedReadiness), named a specific product/brand
// (productQuery — the water type plays no part in a direct product lookup), or already named an
// explicit parameter that is not ambiguous across water-type families (see AMBIGUOUS_PARAMS).
// In every one of these cases nothing else is required either: goal is already set by the same
// message that triggered them (an explicit parameter or product/browse request always implies
// one — see the goal-setting rules above), and every other field below is only ever asked for a
// specific, known state.waterType, so leaving it unset skips them too.
//
// An AMBIGUOUS explicit parameter (chlorine, pH, nitrate) always vetoes this, however the
// customer is otherwise behaving — frustrated, repeatedly unsure (both also set
// relaxedReadiness), or explicitly asking to skip ahead — because the water type still
// genuinely changes which product is right for one of those, and the "unknown water type asks
// once" regression tests pin exactly that for bare "chlorine".
function canSkipWaterType(state) {
  if (state.parameters.some((id) => AMBIGUOUS_PARAMS.has(id))) return false;
  return state.relaxedReadiness || Boolean(state.productQuery) || state.parameters.length > 0;
}

export function getNextMissingField(state) {
  if (!state.waterType && !canSkipWaterType(state)) return "waterType";
  if (state.pendingWaterTypeSwitch) return "waterTypeSwitch";
  // The customer asked to skip ahead: once relaxed, nothing else is asked for either, even the
  // kind of water (see canSkipWaterType above).
  if (state.relaxedReadiness) return "ready";
  if (!state.goal) return "goal";
  if (state.waterType === "aquarium" && !state.waterSubtype) return "aquariumType";
  if ((state.waterType === "drinking" || state.waterType === "well") && !state.waterSource) return "waterSource";
  if (["pool", "spa", "drinking", "well"].includes(state.waterType) &&
    (!state.testingScope || ["specific-pending", "not-tested", "symptom-pending"].includes(state.testingScope))) return "testingScope";
  return "ready";
}

// Teach while diagnosing: the first time a pool issue is raised, briefly explain what it may
// indicate (from api/_knowledge.js) alongside the next useful question, instead of asking a
// bare question. Phrasing stays short — one teaching sentence, then the question.
function troubleshootingIntro(state) {
  const issueLabel = state.issueDetails.at(-1) ?? "your pool water";
  const indicates = issueIndicates(state.waterType, state.issue);
  const teach = indicates ? ` This often points to ${indicates}.` : "";
  return `Got it — you're troubleshooting ${issueLabel} in your pool.${teach} Have you tested your chlorine and pH yet?`;
}

function cloudyIntro(state) {
  const indicates = issueIndicates(state.waterType, "cloudy_water");
  return `Got it — cloudy pool water can have a few causes${indicates ? `: ${indicates}` : ""}. What are you trying to check?`;
}

export function questionForMissingField(field, state) {
  if (field === "waterType") {
    return WATER_TYPE_QUESTION;
  }
  if (field === "aquariumType") return "Is it freshwater or saltwater?";
  if (field === "waterSource") return "What is the source of your drinking water?";
  if (field === "goal") return state.waterType === "pool"
    ? "Are you doing routine testing, or trying to troubleshoot a water issue?"
    : `What are you hoping to check in your ${state.waterType === "pool" ? "pool" : "water"}?`;
  if (field === "treatment") return TREATMENT_QUESTION;
  if (field === "testingScope") {
    if (["pool", "spa"].includes(state.waterType) && state.goal === "troubleshooting" &&
      ["green_water", "cloudy_water", "high_chlorine", "low_chlorine"].includes(state.issue)) {
      if (state.testingScope === "not-tested") return "No problem. Which result would you like to check first, or would you prefer a full test?";
      if (state.lastAnsweredField === "goal") {
        return troubleshootingIntro(state);
      }
      if (state.lastAnsweredField === null && state.issue === "cloudy_water") {
        return cloudyIntro(state);
      }
      if (state.parameters.includes("ph")) return "Got it — you want to check pH. Would you also like to check chlorine?";
      if (state.parameters.includes("chlorine")) return "Got it — you know your chlorine level. Do you also know your pH, or would you prefer a full test?";
      if (state.lastAnsweredField === "testingScope") return `To narrow down ${state.issueDetails.at(-1) ?? "the pool water issue"}, do you know either your chlorine or pH result?`;
      return troubleshootingIntro(state);
    }
    if (state.testingScope === "symptom-pending" && state.symptomCandidates.length) {
      const labels = state.symptomCandidates.map((id) => PARAM_BY_ID[id].label);
      const list = labels.length > 1 ? `${labels.slice(0, -1).join(", ")} or ${labels.at(-1)}` : labels[0];
      return `That can point to a few different things — ${list}. Do you know which, or should we check them all?`;
    }
    if (state.waterType === "drinking" || state.waterType === "well") {
      return "Are you looking for a general screen, or checking a specific concern?";
    }
    if (state.parameters.includes("ph") && state.testingScope === "specific-pending") return SCOPE_CLARIFICATION;
    if (state.parameters.includes("ph")) return "Got it — you want to check pH. Would you also like to check chlorine?";
    if (state.issues.includes("green")) {
      const indicates = issueIndicates(state.waterType, "green_water");
      return `Got it. Green pool water${indicates ? ` often points to ${indicates}` : " can point us toward a different set of tests"}. What would you like to check?`;
    }
    if (state.issues.includes("cloudy")) {
      return cloudyIntro(state);
    }
    return "What would you like to check?";
  }
  return "";
}

// "pool", "hot tub", "well water": the words answerToPendingSwitch accepts after "yes".
const switchName = (id) => ["well", "drinking"].includes(id) ? contextLabel(id) : contextLabel(id).replace(/ water$/, "");

function clarifyWaterTypeSwitch(state) {
  const from = state.pendingWaterTypeSwitch?.from;
  const to = state.pendingWaterTypeSwitch?.to;
  if (!from || !to) return "";
  return `It sounds like you're testing ${contextLabel(to)} instead. Should I switch from ${contextLabel(from)} to ${contextLabel(to)}?`;
}

export function guidedOptionsForField(field, state) {
  let choices = [];
  if (field === "waterType") choices = [
    { label: "Pool", value: "pool" },
    { label: "Hot tub / spa", value: "hot tub" },
    { label: "Aquarium", value: "aquarium" },
    { label: "Drinking water", value: "drinking water" },
    { label: "Well water", value: "well water" },
  ];
  else if (field === "aquariumType") choices = [
    { label: "Freshwater", value: "freshwater" },
    { label: "Saltwater", value: "saltwater" },
    { label: "Not sure", value: "not sure" },
  ];
  else if (field === "waterSource") choices = [
    { label: "Tap water", value: "tap" },
    { label: "Private well", value: "well water" },
    { label: "Not sure", value: "not sure" },
  ];
  else if (field === "testingScope" && state.testingScope === "symptom-pending") {
    choices = [
      ...state.symptomCandidates.map((id) => ({ label: `Just ${PARAM_BY_ID[id].label}`, value: id })),
      { label: "Not sure, check all", value: "check all" },
    ];
  }
  else if (field === "testingScope" && (state.waterType === "pool" || state.waterType === "spa") &&
    !(state.goal === "troubleshooting" && ["green_water", "cloudy_water", "high_chlorine", "low_chlorine"].includes(state.issue) &&
      ["goal", "testingScope"].includes(state.lastAnsweredField))) {
    if (state.parameters.includes("ph") && state.testingScope === "specific-pending") {
      choices = [
        { label: "pH only", value: "pH only" },
        { label: "pH + Chlorine", value: "pH + Chlorine" },
      ];
    } else {
      choices = [
        { label: "Chlorine & pH", value: "Chlorine & pH" },
        { label: "Full pool water check", value: "complete pool water test" },
      ];
    }
  } else if (field === "testingScope" && !(["pool", "spa"].includes(state.waterType) && state.goal === "troubleshooting" &&
    ["green_water", "cloudy_water", "high_chlorine", "low_chlorine"].includes(state.issue) &&
    ["goal", "testingScope"].includes(state.lastAnsweredField))) {
    choices = [
      { label: "General screen", value: "general water screen" },
      { label: "Specific concern", value: "specific water concern" },
      { label: "Not sure", value: "not sure" },
    ];
  } else if (field === "treatment") {
    choices = [
      { label: "Chlorine", value: "chlorine" },
      { label: "Saltwater", value: "saltwater" },
      { label: "Bromine", value: "bromine" },
    ];
  } else if (field === "waterTypeSwitch") {
    const to = switchName(state.pendingWaterTypeSwitch?.to);
    const from = switchName(state.pendingWaterTypeSwitch?.from);
    choices = [
      { label: `Yes, ${to}`, value: `yes ${to}` },
      { label: `No, keep ${from}`, value: `no keep ${from}` },
    ];
  } else if (field === "goal") {
    choices = ["pool", "spa"].includes(state.waterType)
      ? [
          { label: "Routine testing", value: "routine testing" },
          { label: "Troubleshoot a problem", value: "troubleshooting" },
        ]
      : [
          { label: "General screen", value: "general water screen" },
          { label: "Specific parameter", value: "specific water concern" },
        ];
  } else if (field === "testingScope" && ["pool", "spa"].includes(state.waterType) && state.goal === "troubleshooting" &&
    ["green_water", "cloudy_water", "high_chlorine", "low_chlorine"].includes(state.issue) &&
    ["goal", "testingScope"].includes(state.lastAnsweredField)) {
    choices = state.testingScope === "not-tested"
        ? [
            ...(!state.parameters.includes("chlorine") ? [{ label: "Check chlorine", value: "chlorine" }] : []),
            ...(!state.parameters.includes("ph") ? [{ label: "Check pH", value: "pH" }] : []),
            { label: "Full test", value: "complete pool water test" },
          ]
        : [
            { label: "I haven't tested yet", value: "I haven't tested yet" },
            ...(!state.parameters.includes("chlorine") ? [{ label: "I know my chlorine", value: "I know my chlorine" }] : []),
            ...(!state.parameters.includes("ph") ? [{ label: "I know my pH", value: "I know my pH" }] : []),
            { label: "Full test", value: "complete pool water test" },
          ];
  }
  const choiceLimit = field === "waterType" ? 5
    : state.testingScope === "symptom-pending" ? state.symptomCandidates.length + 1
    : field === "testingScope" && state.goal === "troubleshooting" && state.issue ? 4 : 3;
  return [...choices.slice(0, choiceLimit), OTHER_OPTION];
}

export function guidedResponse(state, readiness, latestUserMessage = "") {
  const field = state.pendingWaterTypeSwitch ? "waterTypeSwitch" : readiness.nextMissingField;
  let reply = state.pendingWaterTypeSwitch
    ? clarifyWaterTypeSwitch(state)
    : questionForMissingField(field, state);
  const uncertain = /^\s*(?:yes|no|not sure|unsure|maybe|no idea|i don't know)\s*[.!]?\s*$/i.test(latestUserMessage);
  if (field === "waterType" && state.lastAskedField === "waterType" && !detectContext(latestUserMessage)) {
    reply = state.waterTypeClarificationCount <= 1
      ? "No problem — we can narrow it down another way. Where is the water from?"
      : "That's okay. Which setting is closest, or where is the water from?";
  } else if (field === "waterTypeSwitch" && state.lastAskedField === "waterTypeSwitch" &&
    new RegExp(`^\\s*${state.pendingWaterTypeSwitch?.to}\\s*[.!]?\\s*$`, "i").test(latestUserMessage)) {
    const to = switchName(state.pendingWaterTypeSwitch.to);
    const from = switchName(state.pendingWaterTypeSwitch.from);
    reply = `I’ll keep your ${from} as-is for now. Choose “Yes, ${to}” to switch, or “No, keep ${from}” to continue.`;
  } else if (field === "testingScope" && state.treatment && /^\s*(?:bromine|chlorine|salt\s*water|saltwater)\s*[.!]?\s*$/i.test(latestUserMessage)) {
    reply = `Thanks — ${state.treatment} noted. What would you like to test?`;
  } else if (uncertain && field === "testingScope" && ["pool", "spa"].includes(state.waterType)) {
    reply = "No problem. We can start with chlorine and pH, or check the full pool balance. Which would you prefer?";
  } else if (uncertain && field === "testingScope") {
    reply = "No problem. We can start with a general screen, or focus on a particular concern. Which would help?";
  } else if (uncertain && field === "treatment") {
    reply = "No problem — we can still narrow down the useful tests. What would you like to check?";
  } else if (uncertain && field === "goal") {
    reply = ["pool", "spa"].includes(state.waterType)
      ? "No problem. Are you doing routine testing, or troubleshooting an issue?"
      : "No problem — are you checking something specific, or would a general screen work?";
  }
  // Checked against the last TWO replies, not just one: the uncertain-answer branches above
  // only have two rotating phrasings per field, so a third+ consecutive non-answer would
  // otherwise cycle back to the reply from two turns ago without ever matching the immediately
  // preceding one.
  const recentlyShown = (text) => text === state._lastAssistantReply || text === state._secondLastAssistantReply;
  if (reply && recentlyShown(reply)) {
    const isPool = ["pool", "spa"].includes(state.waterType);
    if (field === "goal") reply = "What best describes what you're testing: routine checks or a specific problem?";
    else if (field === "testingScope" && state.goal === "troubleshooting" && isPool) {
      const issue = state.issueDetails.at(-1) ?? "the pool water issue";
      reply = state.parameters.length
        ? `Would you like a full test to investigate ${issue}, or do you know another result?`
        : `Would it help to tell me your chlorine or pH result, or should we plan a full test for ${issue}?`;
    } else if (field === "testingScope" && state.goal === "troubleshooting") {
      reply = state.parameters.length
        ? "Would a full test suit you better, or do you already have another result to go on?"
        : "Would it help to share any result you already have, or should we plan a general test instead?";
    } else if (field === "waterType") reply = "Which setting is closest to the water you want to test?";
    else reply = "What would you like to share next so I can narrow down the right test?";
  }
  if (reply && recentlyShown(reply)) {
    reply = `I have ${state.issueDetails.at(-1) ?? "your water issue"} noted. What would you like to check next?`;
  }
  return {
    reply,
    options: guidedOptionsForField(field, state),
    field,
  };
}

export function analyzeNeeds(messages, state = deriveConversationState(messages.map((content) => ({ role: "user", content })))) {
  const text = messages.filter((message) => typeof message === "string").join("\n");
  const context = state.waterType;
  const explicit = PARAMS.filter((parameter) => state.parameters.includes(parameter.id)).map((parameter) => parameter.id);
  const symptomParams = matchedSymptomParams(text, context);
  const hasRare = explicit.some((id) => PARAM_BY_ID[id].rare);
  const parameters = unique([...explicit, ...symptomParams, ...(hasRare ? [] : (context ? DEFAULTS[context] ?? [] : []))]);
  const productIntent = INTENT.test(text) || TESTWORD.test(text) || Boolean(state.goal);
  const problem = PROBLEM.test(text) || state.goal === "troubleshooting";
  const productQuery = state.productQuery ?? null;
  // Explicit "just show me what you have", with nothing more specific to go on (no parameter,
  // no named product) — a genuine browse request, not a parameter-driven search.
  const browseIntent = state.relaxedReadiness && parameters.length === 0 && !productQuery;
  // A bare "explicit.length > 0" would otherwise treat naming a parameter in a pure explanation
  // question ("What does pH mean?") as a product request on its own; checked against only the
  // latest message, not the whole conversation, so an earlier educational turn never silences a
  // later genuine request.
  const latestMessage = messages.filter((m) => typeof m === "string").at(-1) ?? "";
  const explicitAlone = explicit.length > 0 && !EDUCATIONAL_QUESTION.test(latestMessage);
  const wantsProducts = (parameters.length > 0 && (productIntent || problem || explicitAlone)) ||
    Boolean(productQuery) || browseIntent;
  // Scoped to the latest message, not the whole conversation: state.issues is cleared on an
  // explicit topic change (resetWaterSpecificState), and re-scanning old turns would resurrect
  // an abandoned symptom (e.g. "cloudy" from a pool question the customer already moved on from).
  const descriptor = state.issues.at(-1) ??
    (DESCRIPTORS.exec(latestMessage)?.[1] ?? "").toLowerCase().replace("cloudiness", "cloudy").replace("foaming", "foamy");

  return {
    context,
    parameters,
    explicit,
    symptomParams: unique(symptomParams),
    wantsConsumables: /reagent|refill|replacement|cartridge|tablets?\b/i.test(text),
    productIntent,
    problem,
    wantsProducts,
    hasValues: HAS_VALUE.test(text),
    label: contextLabel(context) ? [descriptor, contextLabel(context)].filter(Boolean).join(" ") : "",
    hasRare,
    productQuery,
    browseIntent,
  };
}

function determineRecommendationReadiness(messages, needs, conversation, state) {
  const nextMissingField = getNextMissingField(state);
  const missing = [];
  if (!state.waterType && !canSkipWaterType(state)) missing.push("water_type");
  if (state.pendingWaterTypeSwitch) missing.push("water_type_confirmation");
  if (!state.relaxedReadiness) {
    if (!state.goal) missing.push("goal");
    if (state.waterType === "aquarium" && !state.waterSubtype) missing.push("aquarium_type");
    if ((state.waterType === "drinking" || state.waterType === "well") && !state.waterSource) missing.push("water_source");
    if (["pool", "spa", "drinking", "well"].includes(state.waterType) &&
      (!state.testingScope || ["specific-pending", "not-tested", "symptom-pending"].includes(state.testingScope))) missing.push("testing_scope");
  }

  const question = state.pendingWaterTypeSwitch
    ? clarifyWaterTypeSwitch(state)
    : questionForMissingField(nextMissingField, state);
  return {
    ready: nextMissingField === "ready" && !state.pendingWaterTypeSwitch,
    nextMissingField: state.pendingWaterTypeSwitch ? "waterTypeSwitch" : nextMissingField,
    state,
    context: state.waterType,
    goal: state.goal,
    poolTreatment: state.treatment,
    aquariumType: state.waterSubtype,
    waterSource: state.waterSource,
    goalKnown: Boolean(state.goal),
    poolTreatmentKnown: Boolean(state.treatment),
    aquariumTypeKnown: Boolean(state.waterSubtype),
    waterSourceKnown: Boolean(state.waterSource),
    testingScopeKnown: Boolean(state.testingScope && !["specific-pending", "not-tested", "symptom-pending"].includes(state.testingScope)),
    relevantParameters: needs.parameters,
    existingTestInformation: needs.hasValues,
    relaxedReadiness: state.relaxedReadiness,
    missing,
    question,
  };
}

export function assessRecommendationReadiness(messages, needs, conversation = [], state = deriveConversationState(conversation)) {
  return determineRecommendationReadiness(messages, needs, conversation, state);
}

export function isPoolTreatmentQuestion(text) {
  return POOL_TREATMENT_QUESTION.test(text);
}

// `trustReply` is computed once by the caller (chat.js) from whatever it already knows about
// this turn — rejecting, wanting a different option, accepting, or a pure product follow-up
// ("why this one?", "that one", "is this enough?") — rather than re-derived here from regexes a
// second time. Any of those is reason enough to trust Claude's own reply rather than
// re-litigating it against the known-field patterns below: a genuine, context-aware answer to
// any of them will often mention a known field in passing (the product it just recommended, the
// parameter it covers) without that being a redundant re-ask — the patterns below have no way to
// tell the two apart, and discarding a real answer here is worse than occasionally missing a
// true repeat (which the dedup in guidedResponse/chat.js already catches by comparing actual
// text).
export function constrainQuestionToState(reply, readiness, trustReply = false) {
  if (!/\?/.test(reply)) return reply;
  if (trustReply) return reply;
  const known = readiness.state;
  // Requires at least two of the three treatment words together, the same co-occurrence
  // reasoning as asksKnownAquariumType/WaterSource below: the deterministic treatment question
  // itself lists all three options together ("chlorine-treated, saltwater, or treated with
  // bromine?"), so seeing at least two together is a genuine "listing the options again" signal
  // — unlike a bare "chlorine" on its own, which a reply about a bromine pool could easily say
  // while discussing something else (e.g. comparing sanitisers).
  const TREATMENT_WORDS = [/\bchlorine\b/i, /\bbromine\b/i, /\bsalt[\s-]?water\b/i];
  const asksKnownTreatment = (known.waterType === "pool" || known.waterType === "spa") &&
    Boolean(known.treatment) &&
    TREATMENT_WORDS.filter((re) => re.test(reply)).length >= 2;
  const asksKnownWaterType = Boolean(known.waterType) &&
    /what kind of water|which (?:kind|type) of water|are we (?:talking about|testing)|is (?:this|it) (?:a |an )?(?:pool|aquarium|hot tub|tap water)/i.test(reply);
  const asksKnownGoal = Boolean(known.goal) &&
    /what are you (?:hoping|trying|looking) to (?:check|test|solve)\b|what do you want to (?:check|test)\b|what issue are you/i.test(reply);
  // \b after test/check: without it, "routine test" matches as a substring of ordinary prose
  // like "routine testing matters" — found live via an honest no-match explanation for radon
  // ("...routine testing matters more than for mains water...") being discarded purely because
  // of this missing boundary, not because anything was actually being re-asked.
  const asksKnownScope = Boolean(known.testingScope && !["specific-pending", "symptom-pending"].includes(known.testingScope)) &&
    /recently tested\b|complete check\b|full check\b|routine (?:test|check)\b|testing scope\b/i.test(reply);
  // Merely mentioning a known parameter's name is not the same as asking for it again — a
  // reply explaining what pH means legitimately says "pH" several times without being a
  // redundant question. Only flagged when the reply also sounds like it is asking FOR that
  // value (found via a "What does pH mean?" educational reply that happened to contain a "?"
  // and the word "pH", getting its real explanation replaced with the waterType fallback
  // question even though nothing had actually been asked about yet).
  const ASKS_FOR_PARAMETER_VALUE = /\bdo you know your\b|\bwhat is your\b|\bwhat'?s your\b|\bhave you (?:tested|measured|checked)\b|\byour (?:current|latest|recent)\b/i;
  const asksKnownParameter = ASKS_FOR_PARAMETER_VALUE.test(reply) && known.parameters.some((id) => {
    const pattern = PARAM_BY_ID[id]?.user;
    return pattern?.test(reply);
  });
  // Both of these previously matched on a bare keyword appearing ANYWHERE in the reply
  // ("freshwater"/"saltwater", or "tap"/"well"/"source"), with no requirement that the reply
  // was actually ASKING about it — unlike every other asksKnownX check above, which all require
  // genuine question phrasing. A reply about well water is practically guaranteed to say "well"
  // somewhere while doing something else entirely (explaining, recommending, apologising) —
  // found live via a plain "I need a radon test for my well water" discarding Claude's honest,
  // on-topic no-match explanation purely because it said "well" twice.
  // Requiring BOTH options to co-occur (rather than one exact phrase) is deliberate: a real
  // "which one" question naturally names both choices, however it's worded ("is this fresh or
  // salt water", markdown-bolded, etc.) — a single mention of either one, on its own, is not a
  // question about which one the water is, just the word appearing while discussing that topic.
  const asksKnownAquariumType = Boolean(known.waterSubtype) &&
    /fresh\s?water/i.test(reply) && /salt\s?water/i.test(reply);
  const asksKnownWaterSource = Boolean(known.waterSource) &&
    /\btap\b/i.test(reply) && /\bwell\b/i.test(reply);
  if (
    !asksKnownTreatment &&
    !asksKnownWaterType &&
    !asksKnownGoal &&
    !asksKnownScope &&
    !asksKnownParameter &&
    !asksKnownAquariumType &&
    !asksKnownWaterSource
  ) return reply;
  if (readiness.nextMissingField !== "ready") return questionForMissingField(readiness.nextMissingField, known);
  // Built from what is actually known, never a fixed list — this previously always claimed
  // "water type, treatment, testing scope and parameters" were noted even when, e.g., a
  // parameter-only request (PFAS, a named product, a browse request) left water type and
  // treatment genuinely unknown, which read as an odd non-sequitur in exactly those cases.
  const knownFacts = [];
  if (known.waterType) knownFacts.push("water type");
  if (known.treatment) knownFacts.push("treatment");
  if (known.testingScope && !["specific-pending", "symptom-pending"].includes(known.testingScope)) knownFacts.push("testing scope");
  if (known.parameters.length) knownFacts.push("parameters");
  if (!knownFacts.length) return "I'll focus on what's genuinely relevant to what you've asked about.";
  const list = knownFacts.length < 2 ? knownFacts.join("")
    : `${knownFacts.slice(0, -1).join(", ")} and ${knownFacts.at(-1)}`;
  return `I have the ${list} you shared noted, so I’ll focus on the tests relevant to those details.`;
}

export const parameterLabels = (ids) => ids.map((id) => PARAM_BY_ID[id]?.label).filter(Boolean);
