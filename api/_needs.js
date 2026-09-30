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

// messages: the customer's messages, oldest first. Only the most recent ones count, so a
// change of topic ("...actually it is for my fish tank") is followed.
export function analyzeNeeds(messages) {
  const window = messages.filter((m) => typeof m === "string").slice(-3);
  const text = window.join("\n");
  const last = window[window.length - 1] ?? "";

  // The latest message decides the kind of water; earlier ones only fill in when it is silent.
  let context = detectContext(last);
  for (let i = window.length - 2; i >= 0 && !context; i--) context = detectContext(window[i]);

  // Parameters named by the customer (also when they quote a test value, e.g. "pH 8.1").
  const explicit = PARAMS.filter((x) => x.user.test(text)).map((x) => x.id);

  const symptomParams = [];
  for (const s of SYMPTOMS) {
    if (s.re.test(text) && (!context || s.contexts.includes(context))) symptomParams.push(...s.adds);
  }

  const defaults = context ? DEFAULTS[context] : [];
  const hasRare = explicit.some((id) => PARAM_BY_ID[id].rare);
  // A customer asking for something specific and unusual (PFAS, radon...) gets results for THAT,
  // not for the generic checklist of their kind of water.
  const parameters = unique([...explicit, ...symptomParams, ...(hasRare ? [] : defaults)]);

  const productIntent = INTENT.test(text) || TESTWORD.test(text);
  const problem = PROBLEM.test(text);
  const wantsProducts = parameters.length > 0 && (productIntent || problem || explicit.length > 0);

  const descriptor = (DESCRIPTORS.exec(text)?.[1] ?? "").toLowerCase().replace("cloudiness", "cloudy").replace("foaming", "foamy");
  const contextLabel = context ? CONTEXTS.find((c) => c.id === context).label : "";

  return {
    context,
    parameters,
    explicit,
    symptomParams: unique(symptomParams),
    // Reagent refills, tablets and cartridges are only for people who already own an instrument,
    // so they are only suggested when the customer asks for them.
    wantsConsumables: /reagent|refill|replacement|cartridge|tablets?\b/i.test(text),
    productIntent,
    problem,
    wantsProducts,
    hasValues: HAS_VALUE.test(text),
    label: contextLabel ? [descriptor, contextLabel].filter(Boolean).join(" ") : "",
    hasRare,
  };
}

const POOL_TYPE = /\bsalt\s*water\b|\bsaltwater\b|\bsalt pool\b|\bsaltwater pool\b|\bchlorine[- ]treated\b|\bchlorinated pool\b|\b(?:use|using|treated with|treat(?:ed) with)\s+(?:chlorine|bromine)\b/i;
const AQUARIUM_TYPE = /\bfreshwater\b|\bfresh water\b|\bsaltwater\b|\bsalt water\b|\bmarine\b|\breef\b|\btropical\b/i;
const DRINKING_SOURCE = /\btap water\b|\bmains water\b|\bbottled water\b|\bprivate (?:water )?supply\b|\bwell water\b|\bborehole\b|\bspring water\b/i;
const TEST_SCOPE =
  /\b(?:complete|full|routine|general|basic|broad|all[- ]round)\s+(?:water\s+)?(?:test|check|screen|screening|panel)\b|\b(?:haven't|have not|never|not yet)\s+(?:recently\s+)?tested\b|\b(?:already|recently)\s+tested\b|\btest results?\b|\bresults?\s+(?:are|show|showing|read|came)\b|\b(?:chlorine|ph|alkalinity)\s+(?:is|was|at|reads?)\s+\d/i;

function determineRecommendationReadiness(messages, needs) {
  const text = messages.filter((message) => typeof message === "string").join("\n");
  const hasGoal = needs.problem || needs.productIntent || needs.explicit.length > 0;
  const poolTypeKnown = needs.context !== "pool" && needs.context !== "spa" || POOL_TYPE.test(text);
  const aquariumTypeKnown = needs.context !== "aquarium" || AQUARIUM_TYPE.test(text);
  const drinkingSourceKnown = needs.context !== "drinking" || DRINKING_SOURCE.test(text);
  const poolTreatment = /\bsalt\s*water\b|\bsaltwater\b|\bsalt pool\b/i.test(text)
    ? "saltwater"
    : /\bbromine\b/i.test(text)
      ? "bromine"
      : /\bchlorine[- ]treated\b|\bchlorinated pool\b|\b(?:use|using|treated with|treat(?:ed) with)\s+chlorine\b/i.test(text)
        ? "chlorine"
        : null;
  const aquariumType = /\bsaltwater\b|\bsalt water\b|\bmarine\b|\breef\b/i.test(text)
    ? "saltwater"
    : /\bfreshwater\b|\bfresh water\b|\btropical\b/i.test(text)
      ? "freshwater"
      : null;
  const waterSource = /\btap water\b|\bmains water\b|\bbottled water\b|\bprivate (?:water )?supply\b|\bwell water\b|\bborehole\b|\bspring water\b/i.exec(text)?.[0] ?? null;
  const poolScopeKnown =
    (needs.context !== "pool" && needs.context !== "spa") ||
    needs.explicit.length >= 2 ||
    needs.hasValues ||
    TEST_SCOPE.test(text);

  const missing = [];
  if (!needs.context) missing.push("water_type");
  if (!hasGoal) missing.push("goal");
  if (!poolTypeKnown) missing.push("pool_treatment");
  if (!aquariumTypeKnown) missing.push("aquarium_type");
  if (!drinkingSourceKnown) missing.push("water_source");
  if (!poolScopeKnown) missing.push("testing_scope");

  let question = "";
  if (missing.includes("water_type")) {
    question = "What kind of water are you testing, such as a pool, hot tub, aquarium, tap water, or well water?";
  } else if (missing.includes("goal")) {
    question = `What are you hoping to check in your ${needs.context === "pool" ? "pool" : "water"}?`;
  } else if (missing.includes("pool_treatment")) {
    question = "Is your pool chlorine-treated, saltwater, or treated with bromine?";
  } else if (missing.includes("aquarium_type")) {
    question = "Is your aquarium freshwater or saltwater?";
  } else if (missing.includes("water_source")) {
    question = "Is your drinking water from the tap, a private well, or another source?";
  } else if (missing.includes("testing_scope")) {
    question = "Have you recently tested the chlorine and pH levels, or would you like a complete check?";
  }

  return {
    ready: missing.length === 0,
    context: needs.context,
    goal: needs.label || (needs.explicit.length ? "parameter-specific testing" : needs.productIntent ? "general testing" : null),
    poolTreatment,
    aquariumType,
    waterSource,
    goalKnown: hasGoal,
    poolTreatmentKnown: poolTypeKnown,
    aquariumTypeKnown,
    waterSourceKnown: drinkingSourceKnown,
    testingScopeKnown: poolScopeKnown,
    relevantParameters: needs.parameters,
    existingTestInformation: needs.hasValues || TEST_SCOPE.test(text),
    missing,
    question,
  };
}

export function assessRecommendationReadiness(messages, needs = analyzeNeeds(messages)) {
  return determineRecommendationReadiness(messages, needs);
}

export const parameterLabels = (ids) => ids.map((id) => PARAM_BY_ID[id]?.label).filter(Boolean);
