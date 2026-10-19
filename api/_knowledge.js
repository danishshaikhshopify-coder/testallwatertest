// General water-testing knowledge, kept separate from both the product catalog
// (api/_catalog.js) and Claude's own conversational wording (the persona/style text in
// api/chat.js). This module is the factual layer: what a symptom may indicate, which
// parameters are useful and why, and what a reasonable follow-up question is. Claude's job
// is only to explain this naturally and simply — it must not invent facts beyond what is here.
//
// The content below does not introduce new medical/scientific claims: it carries forward the
// guidance that already existed in this project (api/chat.js's prior system-prompt GUIDANCE
// section, and the symptom/parameter associations already encoded in api/_needs.js).
//
// Like the catalog, this is retrieved, not dumped: knowledgeContext() returns only the facts
// relevant to the current conversation, not the whole knowledge base.
//
// Files starting with "_" in /api are helpers, not Vercel functions.

import { PARAM_BY_ID } from "./_needs.js";

// Why each parameter is worth testing. Generic across water types; a water-type's own
// `intro` line supplies the context-specific framing.
const PARAMETER_WHY = {
  chlorine: "the active sanitiser level — too low and the water isn't being disinfected, too high can irritate skin and eyes",
  ph: "controls how well the sanitiser works and how comfortable the water is; out-of-range pH makes chlorine or bromine far less effective",
  alkalinity: "keeps pH stable; when it's off, pH drifts and is hard to correct",
  calcium_hardness: "protects pool surfaces and equipment from scaling (too high) or corrosion (too low); doesn't itself cause cloudy or green water",
  cyanuric_acid: "the stabiliser that protects chlorine from sunlight; too little and chlorine burns off fast, too much and chlorine becomes sluggish — a common hidden cause of algae",
  bromine: "the active sanitiser level in bromine-treated water, playing the same role chlorine does in a chlorine pool",
  hardness: "total dissolved calcium/magnesium; very hard water causes limescale, very soft water can be corrosive",
  ammonia: "toxic to fish even at low levels; a rising reading is often the first sign of a fish-tank problem",
  nitrite: "toxic to fish; appears as ammonia is broken down by the tank's biological filter",
  nitrate: "the end product of the nitrogen cycle; high levels stress fish and feed algae",
  phosphate: "a key nutrient for algae growth; often behind green or murky water",
  dissolved_oxygen: "how much oxygen is available to fish; low readings can leave fish gasping at the surface",
  salinity: "the salt concentration marine/reef livestock need within a narrow range",
  iron: "causes orange/brown staining and a metallic taste; a common well-water issue",
  copper: "can give water a metallic taste and, at high levels, is a health concern",
  lead: "a serious health concern with no safe level for drinking water; old pipework is the usual source",
  tds: "total dissolved solids — a general indicator of overall water quality and taste",
  turbidity: "cloudiness from suspended particles, which can also shield bacteria from disinfection",
  coliform: "an indicator of bacterial contamination (including E. coli); a key safety check for well or private supplies",
  fluoride: "naturally present or added for dental health; only a concern at unusually high levels",
  chloride: "linked to taste and, at high levels, to corrosion of pipework",
};

const why = (id) => PARAMETER_WHY[id] ?? `relevant to ${PARAM_BY_ID[id]?.label ?? id}`;

// Per water type: a short framing line, plus named problems with what they may indicate,
// the parameters that matter most for them, and a reasonable follow-up question.
//
// `indicates` is a bare fragment, not a full sentence: no leading "usually"/"often" and no
// capital letter, so callers can compose it into their own framing ("This often points to
// <indicates>.") without doubling up on the same adverb.
export const WATER_TYPE_KNOWLEDGE = {
  pool: {
    intro: "For pool water, the sanitiser level (chlorine or bromine), pH and alkalinity are the core checks; cyanuric acid and calcium hardness matter for ongoing maintenance.",
    problems: {
      green_water: {
        indicates: "too little active sanitiser to control algae, sometimes combined with high pH or low stabiliser",
        parameters: ["chlorine", "ph", "cyanuric_acid"],
        followUp: "Have you tested your chlorine or pH yet?",
      },
      cloudy_water: {
        indicates: "low sanitiser, a pH/alkalinity imbalance, or a filtration issue",
        parameters: ["chlorine", "ph", "alkalinity"],
        followUp: "Do you know your chlorine or pH result?",
      },
      high_chlorine: {
        indicates: "overdosing, or a cyanuric acid level high enough to make chlorine readings misleading",
        parameters: ["chlorine", "cyanuric_acid"],
      },
      low_chlorine: {
        indicates: "sanitiser being used up faster than it's added — sunlight with low stabiliser, bather load, or organic contamination",
        parameters: ["chlorine", "cyanuric_acid"],
      },
    },
  },
  spa: {
    intro: "For hot tubs and spas, sanitiser (chlorine or bromine), pH and alkalinity are the core checks, tested more often than a pool because of the higher water temperature and bather load.",
    problems: {},
  },
  aquarium: {
    intro: "For aquariums, ammonia, nitrite, nitrate and pH are the core checks; hardness and salinity matter for specific setups.",
    problems: {
      gasping_low_oxygen: {
        indicates: "low dissolved oxygen, or ammonia/nitrite stress making it harder for fish to respire",
        parameters: ["dissolved_oxygen", "ammonia", "nitrite"],
        followUp: "Has this started suddenly, or built up over a few days?",
      },
      algae_green_water: {
        indicates: "excess nutrients (often phosphate or nitrate) feeding algae, sometimes combined with too much light",
        parameters: ["phosphate", "nitrate", "ammonia"],
      },
    },
  },
  pond: {
    intro: "For ponds, ammonia, nitrite, nitrate and pH are the core checks, same as an aquarium but at outdoor scale, where algae and oxygen swings are common.",
    problems: {
      algae_green_water: {
        indicates: "excess nutrients (phosphate/nitrate) feeding algae, often worse in warm, sunny weather",
        parameters: ["phosphate", "nitrate"],
      },
    },
  },
  well: {
    intro: "For well and private-supply water, bacteria (coliform), nitrate and the metals/hardness relevant to the symptom are the core checks — private supplies have no automatic treatment, so routine testing matters more than for mains water.",
    problems: {
      staining_or_metallic_taste: {
        indicates: "iron (for orange/brown staining), or iron, copper or lead (for a metallic or bitter taste) depending on the source",
        parameters: ["iron", "copper", "lead"],
      },
      safety_concern: {
        indicates: "a bacteria and nitrate check first, as the most useful starting point for a safety concern",
        parameters: ["coliform", "nitrate"],
      },
    },
  },
  drinking: {
    intro: "For drinking water, a general screen usually covers pH, hardness, nitrate and lead; a specific concern (taste, staining, a safety worry) narrows this down further.",
    problems: {
      staining_or_metallic_taste: {
        indicates: "iron (for orange/brown staining), or iron, copper or lead (for a metallic or bitter taste), often from household pipework",
        parameters: ["iron", "copper", "lead"],
      },
      safety_concern: {
        indicates: "a bacteria and nitrate check first, as the most useful starting point for a safety concern",
        parameters: ["coliform", "nitrate"],
      },
    },
  },
};

// Never diagnose human illness or claim a consumer test proves water is medically or legally
// safe; this is a constant across every water type, so it lives here once rather than in Claude's
// own prompt text (kept there too as a hard rule, but the fact itself belongs with the knowledge).
export const SAFETY_DISCLAIMER =
  "A consumer test gives a useful indication, not a medical or legal safety guarantee. Never diagnose human illness.";

// The raw "may indicate" fragment for a named problem, or "" when there is nothing specific to
// say. Used by api/_needs.js to teach while it asks its deterministic guided questions (e.g.
// "Green pool water often points to <this>."), and by knowledgeContext() below for the LLM path.
// Returns a fragment, not a full sentence, so the caller controls the surrounding phrasing.
export function issueIndicates(waterType, issueId) {
  return WATER_TYPE_KNOWLEDGE[waterType]?.problems?.[issueId]?.indicates ?? "";
}

// Returns a compact system-prompt note with only the facts relevant to this conversation —
// the water type's framing line, the matched problem's explanation and parameters (if any),
// and a short "why" for each parameter actually in play. Returns "" when there is nothing
// specific to add yet (e.g. the water type isn't known).
export function knowledgeContext(state, needs) {
  const entry = WATER_TYPE_KNOWLEDGE[state?.waterType];
  if (!entry) return "";

  const lines = [`WATER TESTING KNOWLEDGE for ${state.waterType}: ${entry.intro}`];

  const problem = state.issue && entry.problems[state.issue];
  if (problem) {
    lines.push(`The customer's issue (${state.issueDetails?.at(-1) ?? state.issue}) typically indicates: ${problem.indicates}.`);
    if (problem.followUp && state.lastAskedField !== "testingScope") {
      lines.push(`A genuinely useful follow-up, if not already asked: "${problem.followUp}"`);
    }
  }

  const relevant = (needs?.parameters ?? []).slice(0, 6);
  if (relevant.length) {
    lines.push("Why these parameters matter here:");
    for (const id of relevant) lines.push(`- ${PARAM_BY_ID[id]?.label ?? id}: ${why(id)}`);
  }

  lines.push(SAFETY_DISCLAIMER);
  return lines.join("\n");
}
