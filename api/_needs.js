// Turns what the customer has said into a structured "need": which kind of water, which
// parameters/tests matter, and whether they are looking for a product. Deterministic and
// keyword based on purpose: the result drives which REAL catalog products are searched for,
// so it must never depend on the (sometimes flaky) language model.
//
// (Files starting with "_" in /api are helpers, not Vercel functions.)

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
  p("nitrite", "nitrite", /\bnitrite\b|\bno2\b/i),
  p("nitrate", "nitrate", /\bnitrate\b|\bno3\b/i),
  p("phosphate", "phosphate", /\bphosphate\b|\bphosphorus\b/i),
  p("iron", "iron", /\biron\b|\brust(?:y)?\b|orange (?:stain|water)/i, /\biron\b/i),
  p("copper", "copper", /\bcopper\b/i),
  p("dissolved_oxygen", "dissolved oxygen", /dissolved oxygen|\boxygen\b/i, /dissolved oxygen|\boxygen\b/i),
  p("salinity", "salinity", /salinity|specific gravity|refractometer|\bsalt level\b/i, /salinity|\bsalt\b|nacl|refractometer/i),
  p("tds", "TDS / conductivity", /\btds\b|total dissolved|conductivity/i, /\btds\b|conductivity/i),
  p("turbidity", "turbidity", /\bturbidity\b/i),
  p("lead", "lead", /\blead\b(?!\s+(?:to|the|a|me|you|us|time))/i, /\blead\b/i),
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

// Symptoms that add parameters (context is required for most; a null context means "any").
const SYMPTOMS = [
  { re: /gasping|oxygen|lethargic|at the surface/i, adds: ["dissolved_oxygen"], contexts: ["aquarium", "pond"] },
  { re: /algae|green water|murky/i, adds: ["phosphate"], contexts: ["aquarium", "pond"] },
  { re: /rust|orange|brown|stain/i, adds: ["iron"], contexts: ["well", "drinking"] },
  { re: /metallic|bitter taste|copper taste/i, adds: ["iron", "copper", "lead"], contexts: ["well", "drinking"] },
  { re: /safe to drink|safe to use|contaminat|\bill\b|\bsick\b|diarrh|upset stomach/i, adds: ["coliform", "nitrate"], contexts: ["well", "drinking"] },
  { re: /marine|reef|saltwater|salt water|\bcoral\b/i, adds: ["salinity"], contexts: ["aquarium"] },
];

const DESCRIPTORS = /\b(cloudy|green|murky|foamy|foaming|discoloured|discolored|smelly|cloudiness)\b/i;
const PROBLEM = /cloudy|green|murky|foam|smell|odou?r|taste|stain|dirty|algae|itch|irritat|burn|sick|\bill\b|dying|dead|gasping|safe|contaminat|unsafe|problem|issue|wrong|weird|strange|rust|orange|brown|metallic|hard water|scale/i;
const TESTWORD = /\btest(?:s|ing|ed|er|ers)?\b|\bkit\b|\bstrips?\b|\bmeter\b|\bphotometer\b|\bchecker\b/i;
const INTENT = /\b(buy|purchase|order|price|cost|how much|which (?:test|kit|strips?|product)|what (?:test|kit|strips?|product)|recommend|suggest|looking for|i need (?:a|an|some)|do you (?:sell|have|stock)|where can i (?:get|buy)|shop|product)s?\b/i;
const HAS_VALUE = /\b\d+(?:[.,]\d+)?\s*(?:ppm|mg\/?l|ppb|µg\/?l|ug\/?l|µs|us\/?cm|ms\/?cm|°?[fd]h|dh|%)|\b(?:ph|chlorine|alkalinity|nitrate|nitrite|ammonia|cya|cyanuric acid|hardness|phosphate|tds|bromine|iron|copper|lead)\s*(?:is|was|of|=|:|at|reads?|read|showing|shows?)?\s*\d/i;

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

const WATER_TYPE_QUESTION = "What kind of water are you testing, such as a pool, hot tub, aquarium, tap water, or well water?";
const TREATMENT_QUESTION = "Is your pool chlorine-treated, saltwater, or treated with bromine?";
const SCOPE_CLARIFICATION = "Got it — you want to check pH. Would you also like to check chlorine?";
const ISSUE_WORDS = ["cloudy", "green", "murky", "foamy", "smelly", "discoloured", "discolored"];
const OTHER_OPTION = { label: "Other / Type my answer", value: "__other__" };

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
}

function answerToPendingSwitch(text, candidate) {
  return /^\s*(?:yes|yeah|yep|yes please|yes[, ]+(?:aquarium|pool|spa|hot tub|pond|tap water|drinking water|well water))\s*[.!]?\s*$/i.test(text) &&
    (!detectContext(text) || detectContext(text) === candidate);
}

function fieldAskedBy(reply) {
  if (/switch from .* to|switching to .* instead/i.test(reply)) return "waterTypeSwitch";
  if (/freshwater or saltwater/i.test(reply)) return "aquariumType";
  if (/source of your drinking water|tap, .*private well/i.test(reply)) return "waterSource";
  if (/general screen, or checking a specific concern/i.test(reply)) return "testingScope";
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
    issues: Array.isArray(previousState?.issues)
      ? unique(previousState.issues.filter((issue) => ISSUE_WORDS.includes(issue)))
      : [],
    goal: typeof previousState?.goal === "string" ? previousState.goal : null,
    waterSubtype: ["freshwater", "saltwater", "unknown"].includes(previousState?.waterSubtype ?? previousState?.aquariumType)
      ? (previousState.waterSubtype ?? previousState.aquariumType)
      : null,
    waterSource: typeof previousState?.waterSource === "string" ? previousState.waterSource : null,
    testingScope: ["complete", "specific", "specific-pending", "general", "unknown"].includes(previousState?.testingScope)
      ? previousState.testingScope
      : null,
    lastAskedField: ["waterType", "goal", "treatment", "testingScope", "waterSource", "aquariumType", "waterTypeSwitch"].includes(previousState?.lastAskedField)
      ? previousState.lastAskedField
      : null,
    pendingWaterTypeSwitch:
      validTypes.has(previousState?.pendingWaterTypeSwitch?.from) &&
      validTypes.has(previousState?.pendingWaterTypeSwitch?.to)
        ? { from: previousState.pendingWaterTypeSwitch.from, to: previousState.pendingWaterTypeSwitch.to }
        : null,
    _lastAssistantReply: typeof previousState?._lastAssistantReply === "string" ? previousState._lastAssistantReply : null,
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
    users.push(text);

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
    } else if (candidate && state.waterType === candidate && isExplicitSwitch(text, candidate)) {
      resetWaterSpecificState(state, candidate);
    }

    if (state.pendingWaterTypeSwitch) continue;
    if (state.waterType === "aquarium" && !state.goal) state.goal = "general testing";

    if ((state.waterType === "pool" || state.waterType === "spa") && !state.treatment) {
      const treatment = detectTreatment(text);
      if (treatment && (requestedField === "treatment" || POOL_TREATMENT_QUESTION.test(priorAssistant) ||
        users.length === 1 || /\b(?:pool|spa)\b/i.test(text) || /^\s*(?:bromine|chlorine|salt\s*water|saltwater)\s*[.!]?\s*$/i.test(text))) {
        state.treatment = treatment;
      }
    }

    if (state.waterType === "aquarium" && !state.waterSubtype) {
      const subtype = detectAquariumType(text);
      if (subtype && (requestedField === "waterType" || requestedField === "aquariumType" ||
        /freshwater or saltwater/i.test(priorAssistant) || /\b(?:aquarium|fish tank|freshwater|fresh water|saltwater|salt water)\b/i.test(text))) {
        state.waterSubtype = subtype;
      } else if (requestedField === "aquariumType" && /^\s*(?:not sure|unsure|i don't know)\s*[.!]?\s*$/i.test(text)) {
        state.waterSubtype = "unknown";
      }
    }

    if (state.waterType === "drinking" || state.waterType === "well") {
      state.waterSource ??= detectWaterSource(text);
      if (!state.waterSource && requestedField === "waterSource" && /^\s*tap\s*[.!]?\s*$/i.test(text)) state.waterSource = "tap";
      if (!state.waterSource && requestedField === "waterSource" &&
        /^\s*(?:yes|no|not sure|unsure|i don't know)\s*[.!]?\s*$/i.test(text)) state.waterSource = "unknown";
    }

    const normalized = text.toLowerCase().replace(/\bsalt\s+water\b/g, "saltwater").replace(/\bph\b/gi, "pH");
    const isTreatmentAnswer = (POOL_TREATMENT_QUESTION.test(priorAssistant) ||
      (["pool", "spa"].includes(state.waterType) && state.treatment && /^\s*(?:bromine|chlorine|salt\s*water|saltwater)\s*[.!]?\s*$/i.test(text))) &&
      /^\s*(?:bromine|chlorine|salt\s*water|saltwater)\s*[.!]?\s*$/i.test(text);
    state.parameters = unique([
      ...state.parameters,
      ...PARAMS.filter((parameter) => parameter.user.test(normalized) &&
        !(isTreatmentAnswer && ["bromine", "chlorine"].includes(parameter.id))).map((parameter) => parameter.id),
    ]);

    const issues = ISSUE_WORDS.filter((word) => new RegExp(`\\b${word}\\b`, "i").test(text))
      .map((word) => word === "discoloured" ? "discolored" : word);
    if (issues.length) state.issues = unique([...state.issues, ...issues]);
    if (PROBLEM.test(text)) state.goal = "troubleshooting";
    else if (!state.goal && (INTENT.test(text) || TESTWORD.test(text) || state.parameters.length)) {
      state.goal = state.parameters.length ? "parameter-specific testing" : "general testing";
    }

    if (requestedField === "testingScope" || TEST_SCOPE_QUESTION.test(priorAssistant) ||
      TEST_SCOPE_CLARIFICATION.test(priorAssistant)) {
      if (SCOPE_COMPLETE.test(text) || /\b(?:complete|full)\b.{0,24}\b(?:test|check)\b|\bpH\s*\+\s*chlorine\b|\bchlorine\s*\+\s*pH\b/i.test(text)) {
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
        (state.parameters.length > 0 && !isTreatmentAnswer && !state.parameters.every((id) => id === "ph"))) {
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
      } else if (/^\s*(?:not sure|unsure|maybe|i don't know)\s*[.!]?\s*$/i.test(text)) {
        if (requestedField === "waterSource") state.waterSource = "unknown";
      }
    }
    if (["pool", "spa"].includes(state.waterType) && state.parameters.length >= 2) state.testingScope = "specific";
    if (["pool", "spa"].includes(state.waterType) && state.parameters.length === 1 &&
      state.parameters[0] === "ph" && !state.testingScope) state.testingScope = "specific-pending";
    if (["drinking", "well"].includes(state.waterType) && state.waterSource && state.parameters.length) {
      state.testingScope = "specific";
    }
    if (!requestedField && /\b(?:complete|full)\b.{0,24}\b(?:test|check)\b/i.test(text)) {
      state.testingScope = "complete";
    }
    if (!state.goal && state.waterType === "aquarium" && state.waterSubtype) state.goal = "general testing";
    if (!state.goal && state.waterType === "drinking" && state.waterSource) state.goal = "general testing";
    state.lastAskedField = null;
  }
  state.aquariumType = state.waterSubtype;
  return state;
}

export function getNextMissingField(state) {
  if (!state.waterType) return "waterType";
  if (state.pendingWaterTypeSwitch) return "waterTypeSwitch";
  if (!state.goal) return "goal";
  if (state.waterType === "aquarium" && !state.waterSubtype) return "aquariumType";
  if ((state.waterType === "drinking" || state.waterType === "well") && !state.waterSource) return "waterSource";
  if (["pool", "spa", "drinking", "well"].includes(state.waterType) &&
    (!state.testingScope || state.testingScope === "specific-pending")) return "testingScope";
  return "ready";
}

export function questionForMissingField(field, state) {
  if (field === "waterType") {
    return WATER_TYPE_QUESTION;
  }
  if (field === "aquariumType") return "Is it freshwater or saltwater?";
  if (field === "waterSource") return "What is the source of your drinking water?";
  if (field === "goal") return `What are you hoping to check in your ${state.waterType === "pool" ? "pool" : "water"}?`;
  if (field === "treatment") return TREATMENT_QUESTION;
  if (field === "testingScope") {
    if (state.waterType === "drinking" || state.waterType === "well") {
      return "Are you looking for a general screen, or checking a specific concern?";
    }
    if (state.parameters.includes("ph") && state.testingScope === "specific-pending") return SCOPE_CLARIFICATION;
    if (state.parameters.includes("ph")) return "Got it — you want to check pH. Would you also like to check chlorine?";
    if (state.issues.includes("green")) {
      return "Got it. Green pool water can point us toward a different set of tests. What would you like to check?";
    }
    if (state.issues.includes("cloudy")) {
      return "Got it — cloudy pool water can have a few causes. What are you trying to check?";
    }
    return "What would you like to check?";
  }
  return "";
}

function clarifyWaterTypeSwitch(state) {
  const from = state.pendingWaterTypeSwitch?.from;
  const to = state.pendingWaterTypeSwitch?.to;
  if (!from || !to) return "";
  const toLabel = contextLabel(to).replace(/ water$/, "");
  const fromLabel = contextLabel(from).replace(/ water$/, "");
  if (to === "aquarium" && from === "pool") {
    return "It sounds like you're testing aquarium water instead. Should I switch from pool water to aquarium water?";
  }
  const article = /^[aeiou]/i.test(toLabel) ? "an" : "a";
  return `It sounds like you're testing ${toLabel} instead. Should I switch from ${fromLabel} water to ${toLabel}?`;
}

export function guidedOptionsForField(field, state) {
  let choices = [];
  if (field === "waterType") choices = [
    { label: "Pool", value: "pool" },
    { label: "Aquarium", value: "aquarium" },
    { label: "Drinking water", value: "drinking water" },
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
  else if (field === "testingScope" && (state.waterType === "pool" || state.waterType === "spa")) {
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
  } else if (field === "testingScope") {
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
    choices = [
      { label: "Yes, aquarium", value: "yes aquarium" },
      { label: "No, keep pool", value: "no keep pool" },
    ];
  } else if (field === "goal") {
    choices = ["pool", "spa"].includes(state.waterType)
      ? [
          { label: "Chlorine & pH", value: "chlorine and pH" },
          { label: "Full pool water check", value: "complete pool water test" },
        ]
      : [
          { label: "General screen", value: "general water screen" },
          { label: "Specific parameter", value: "specific water concern" },
        ];
  }
  return [...choices.slice(0, 3), OTHER_OPTION];
}

export function guidedResponse(state, readiness, latestUserMessage = "") {
  const field = state.pendingWaterTypeSwitch ? "waterTypeSwitch" : readiness.nextMissingField;
  let reply = state.pendingWaterTypeSwitch
    ? clarifyWaterTypeSwitch(state)
    : questionForMissingField(field, state);
  const uncertain = /^\s*(?:no|not sure|unsure|maybe|i don't know)\s*[.!]?\s*$/i.test(latestUserMessage);
  if (field === "waterTypeSwitch" && state.lastAskedField === "waterTypeSwitch" &&
    new RegExp(`^\\s*${state.pendingWaterTypeSwitch?.to}\\s*[.!]?\\s*$`, "i").test(latestUserMessage)) {
    reply = "I’ll keep your pool as-is for now. Choose “Yes, aquarium” to switch, or “No, keep pool” to continue.";
  } else if (field === "testingScope" && state.treatment && /^\s*(?:bromine|chlorine|salt\s*water|saltwater)\s*[.!]?\s*$/i.test(latestUserMessage)) {
    reply = `Thanks — ${state.treatment} noted. What would you like to test?`;
  } else if (uncertain && field === "testingScope" && ["pool", "spa"].includes(state.waterType)) {
    reply = "No problem. We can start with chlorine and pH, or check the full pool balance. Which would you prefer?";
  } else if (uncertain && field === "testingScope") {
    reply = "No problem. We can start with a general screen, or focus on a particular concern. Which would help?";
  } else if (uncertain && field === "treatment") {
    reply = "No problem — we can still narrow down the useful tests. What would you like to check?";
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
  const symptomParams = [];
  for (const symptom of SYMPTOMS) {
    if (symptom.re.test(text) && (!context || symptom.contexts.includes(context))) symptomParams.push(...symptom.adds);
  }
  const hasRare = explicit.some((id) => PARAM_BY_ID[id].rare);
  const parameters = unique([...explicit, ...symptomParams, ...(hasRare ? [] : (context ? DEFAULTS[context] ?? [] : []))]);
  const productIntent = INTENT.test(text) || TESTWORD.test(text) || Boolean(state.goal);
  const problem = PROBLEM.test(text) || state.goal === "troubleshooting";
  const wantsProducts = parameters.length > 0 && (productIntent || problem || explicit.length > 0);
  const descriptor = state.issues.at(-1) ??
    (DESCRIPTORS.exec(text)?.[1] ?? "").toLowerCase().replace("cloudiness", "cloudy").replace("foaming", "foamy");

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
  };
}

function determineRecommendationReadiness(messages, needs, conversation, state) {
  const nextMissingField = getNextMissingField(state);
  const missing = [];
  if (!state.waterType) missing.push("water_type");
  if (state.pendingWaterTypeSwitch) missing.push("water_type_confirmation");
  if (!state.goal) missing.push("goal");
  if (state.waterType === "aquarium" && !state.waterSubtype) missing.push("aquarium_type");
  if ((state.waterType === "drinking" || state.waterType === "well") && !state.waterSource) missing.push("water_source");
  if (["pool", "spa", "drinking", "well"].includes(state.waterType) &&
    (!state.testingScope || state.testingScope === "specific-pending")) missing.push("testing_scope");

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
    testingScopeKnown: Boolean(state.testingScope && state.testingScope !== "specific-pending"),
    relevantParameters: needs.parameters,
    existingTestInformation: needs.hasValues,
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

export function constrainQuestionToState(reply, readiness) {
  if (!/\?/.test(reply)) return reply;
  const known = readiness.state;
  const asksKnownTreatment = (known.waterType === "pool" || known.waterType === "spa") &&
    Boolean(known.treatment) &&
    /\b(?:chlorine|bromine|salt[\s-]?water|treatment|treated|saniti[sz]er)\b/i.test(reply);
  const asksKnownWaterType = Boolean(known.waterType) &&
    /what kind of water|which (?:kind|type) of water|are we (?:talking about|testing)|is (?:this|it) (?:a |an )?(?:pool|aquarium|hot tub|tap water)/i.test(reply);
  const asksKnownGoal = Boolean(known.goal) &&
    /what are you (?:hoping|trying|looking) to (?:check|test|solve)|what do you want to (?:check|test)|what issue are you/i.test(reply);
  const asksKnownScope = Boolean(known.testingScope && known.testingScope !== "specific-pending") &&
    /recently tested|complete check|full check|routine (?:test|check)|testing scope/i.test(reply);
  const asksKnownParameter = known.parameters.some((id) => {
    const pattern = PARAM_BY_ID[id]?.user;
    return pattern?.test(reply);
  });
  const asksKnownAquariumType = Boolean(known.waterSubtype) &&
    /freshwater|fresh water|saltwater|salt water/i.test(reply);
  const asksKnownWaterSource = Boolean(known.waterSource) &&
    /tap|well|bottled|spring|source/i.test(reply);
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
  return "I have the water type, treatment, testing scope and parameters you shared noted, so I’ll focus on the tests relevant to those details.";
}

export const parameterLabels = (ids) => ids.map((id) => PARAM_BY_ID[id]?.label).filter(Boolean);
