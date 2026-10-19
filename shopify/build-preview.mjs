// Renders shopify/sections/testallwater-ai-assistant.liquid into a standalone, openable HTML
// file for local preview, WITHOUT a Shopify store. This is a small, purpose-built substitution
// for the exact handful of Liquid constructs this one section uses (output tags, the `liquid`
// assign block, one if/else, and the quick-reply block loop) — not a general Liquid engine.
// If the section's Liquid gains new constructs, extend the substitutions below to match.
//
// Usage: node shopify/build-preview.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const sectionPath = fileURLToPath(new URL("./sections/testallwater-ai-assistant.liquid", import.meta.url));
let src = readFileSync(sectionPath, "utf8");

// Mock settings a merchant could plausibly have configured, exercising non-default values so
// the preview proves settings actually take effect (not just that defaults render).
const mock = {
  id: "preview123",
  settings: {
    api_endpoint: "/api/chat", // same-origin in this preview server, see preview-server.mjs
    store_domain: "testallwater.co.uk",
    display_mode: "inline",
    accent_color: "#0a5f9f",
    heading: "TestAllWater AI Assistant",
    welcome_title: "Hi! Let's find the right test.",
    welcome_text: "Describe your water issue in your own words. No technical terms needed — I'll ask the important questions as we go.",
  },
  blocks: [
    { type: "quick_prompt", settings: { text: "My pool water is cloudy" } },
    { type: "quick_prompt", settings: { text: "I need to test drinking water" } },
    { type: "quick_prompt", settings: { text: "My chlorine seems too high" } },
    { type: "quick_prompt", settings: { text: "I need a general water test" } },
  ],
};

// 1. Strip {% comment %}...{% endcomment %} and {% schema %}...{% endschema %}.
src = src.replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, "");
src = src.replace(/\{%-?\s*schema\s*-?%\}[\s\S]*?\{%-?\s*endschema\s*-?%\}/g, "");

// 2. Evaluate the {%- liquid ... -%} assign block (this section's one usage is fixed and
// known), then drop the block itself.
const tw_endpoint = mock.settings.api_endpoint || "/api/chat";
const tw_store_domain = mock.settings.store_domain || "testallwater.co.uk";
const tw_floating = mock.settings.display_mode === "floating";
src = src.replace(/\{%-\s*liquid[\s\S]*?-%\}/, "");

// 3. The one if/else used outside the assign block (the root element's mode class).
src = src.replace(
  /\{%\s*if tw_floating\s*%\}([\s\S]*?)\{%\s*else\s*%\}([\s\S]*?)\{%\s*endif\s*%\}/,
  (_, whenTrue, whenFalse) => (tw_floating ? whenTrue : whenFalse)
);

// 4. The quick-reply block loop.
src = src.replace(
  /\{%-\s*for block in section\.blocks\s*-%\}([\s\S]*?)\{%-\s*endfor\s*-%\}/,
  (_, body) =>
    mock.blocks
      .map((block) => {
        let out = body;
        out = out.replace(/\{%-?\s*if block\.type == 'quick_prompt' and block\.settings\.text != blank\s*-?%\}/, "");
        out = out.replace(/\{%-?\s*endif\s*-?%\}/, "");
        out = out.replace(/\{\{\s*block\.settings\.text\s*\|\s*escape\s*\}\}/g, escapeHtml(block.settings.text));
        return out;
      })
      .join("")
);

// 5. Remaining {{ ... }} output tags: section.id, and section.settings.X with the filters this
// template actually uses (strip, default, escape). Order matters: evaluate inner-to-outer by
// handling the specific combinations present rather than a generic filter pipeline.
function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
const settingOutputs = [
  [/\{\{\s*tw_id\s*\}\}/g, () => mock.id],
  [/\{\{\s*tw_endpoint\s*\|\s*escape\s*\}\}/g, () => escapeHtml(tw_endpoint)],
  [/\{\{\s*tw_store_domain\s*\|\s*escape\s*\}\}/g, () => escapeHtml(tw_store_domain)],
  [/\{\{\s*tw_floating\s*\}\}/g, () => String(tw_floating)],
  [/\{\{\s*section\.settings\.accent_color\s*\|\s*default:\s*'([^']*)'\s*\}\}/g, (_, def) => mock.settings.accent_color || def],
  [/\{\{\s*section\.settings\.heading\s*\|\s*default:\s*'([^']*)'\s*\|\s*escape\s*\}\}/g, (_, def) => escapeHtml(mock.settings.heading || def)],
  [/\{\{\s*section\.settings\.welcome_title\s*\|\s*default:\s*"([^"]*)"\s*\|\s*escape\s*\}\}/g, (_, def) => escapeHtml(mock.settings.welcome_title || def)],
  [/\{\{\s*section\.settings\.welcome_text\s*\|\s*default:\s*"([^"]*)"\s*\|\s*escape\s*\}\}/g, (_, def) => escapeHtml(mock.settings.welcome_text || def)],
];
for (const [pattern, replacer] of settingOutputs) src = src.replace(pattern, replacer);

const outPath = fileURLToPath(new URL("./preview.html", import.meta.url));
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>TestAllWater AI Assistant — section preview</title>
<style>body{margin:0;padding:32px 16px;background:#eef3f6;font-family:Arial,sans-serif}
.tw-preview-note{max-width:720px;margin:0 auto 20px;font-size:13px;color:#55606a;background:#fff;border:1px solid #dde3e8;border-radius:10px;padding:12px 14px}</style>
</head>
<body>
<div class="tw-preview-note">Local preview of <code>shopify/sections/testallwater-ai-assistant.liquid</code>, rendered with mock section settings (not a real Shopify page). Regenerate with <code>node shopify/build-preview.mjs</code> after editing the section.</div>
${src}
</body>
</html>`;

writeFileSync(outPath, html);
console.log(`Wrote ${outPath}`);
