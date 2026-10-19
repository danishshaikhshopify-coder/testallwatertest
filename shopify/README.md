# TestAllWater AI Assistant — Shopify Custom Section

A self-contained Shopify theme section that embeds the AI water-testing assistant directly in
the storefront. No Shopify app, no secrets, no Shopify Admin API calls from the browser — it
only ever talks to the already-deployed Vercel `/api/chat` endpoint, over plain `fetch()`.

**Nothing here has been connected to the live TestAllWater theme.** This is ready for manual
installation and testing in a development theme first.

## Files

| File | Purpose |
| --- | --- |
| `sections/testallwater-ai-assistant.liquid` | The section itself — copy this one file into a theme's `sections/` directory. Everything (HTML, scoped CSS, JS) lives inside it; there are no other assets to install. |
| `build-preview.mjs` | Renders the section with mock settings into `preview.html`, for local testing without a Shopify store. Re-run after editing the section. |
| `preview-server.mjs` | Serves `preview.html` at `/` and forwards `/api/chat` to the real, unmodified backend handler, so the preview's fetch calls actually work. |
| `preview.html` | Generated output of `build-preview.mjs` — not meant to be hand-edited. |

## Local preview (no Shopify store needed)

```bash
node shopify/build-preview.mjs      # renders the section with mock settings
node shopify/preview-server.mjs     # serves it at http://localhost:3100, with a working /api/chat
```

Needs the same `.env` (`ANTHROPIC_API_KEY=...`) the main project's `npm run dev` uses. Re-run
`build-preview.mjs` any time you edit the `.liquid` file, then refresh the browser — the preview
server doesn't need restarting unless you're also changing backend code.

## Installing in a Shopify theme (development theme — not the live one)

1. In the Shopify admin: **Online Store → Themes**. Either duplicate the live theme (so you're
   editing a copy) or work on an existing development/unpublished theme. Do not edit the live,
   published theme directly.
2. Open that theme's code editor (**Actions → Edit code**) and add a new section file:
   `sections/testallwater-ai-assistant.liquid`. Paste in the full contents of
   `shopify/sections/testallwater-ai-assistant.liquid` from this repo.
3. Back in **Online Store → Themes → Customize**, open the page you want the assistant on, click
   **Add section**, and choose **TestAllWater AI Assistant**.
4. In the section's settings panel (right-hand sidebar), fill in:
   - **API endpoint URL** — the full URL of your deployed Vercel backend, e.g.
     `https://your-app.vercel.app/api/chat`. This is required for production; leaving it blank
     only works if the storefront and the API happen to share an origin (never true for a real
     Shopify domain calling a Vercel deployment).
   - **Storefront domain** — defaults to `testallwater.co.uk`; change only if the catalog's
     product links point somewhere else (must match `SHOPIFY_STORE_ORIGIN` on the backend, if
     that's been changed from its own default).
   - **Display mode** — "Inline" embeds the chat directly in the page; "Floating launcher" adds
     a bottom-right bubble that opens/closes it (useful for a site-wide assistant rather than a
     single page).
   - Accent color, heading, and welcome message text, if you want to adjust them.
   - Add/edit/remove **Quick reply suggestion** blocks for the starter prompts shown above the
     input.
5. On the Vercel project, add (or update) two environment variables, then redeploy:
   - `ANTHROPIC_API_KEY` — already required; unchanged by this phase.
   - `CORS_ALLOWED_ORIGINS` — set to your storefront's exact origin(s), comma-separated, e.g.
     `https://testallwater.co.uk,https://your-store.myshopify.com` (the second covers the theme
     editor's own preview domain). Leaving it unset defaults to `*` (any origin) — fine for
     testing, worth tightening once you're happy with the integration, since this is the one
     setting that controls which sites' browsers are allowed to call the endpoint at all.
6. Preview the page in the theme editor (this works even on an unpublished theme) and test the
   conversation end to end before publishing anything.

## What to test manually in Shopify (this repo's tests can't reach a real store)

- The section actually appears correctly in **Customize** and its settings panel works.
- A real conversation reaches readiness and shows real product cards (confirms
  `CORS_ALLOWED_ORIGINS` is configured correctly — a CORS failure shows as every message failing
  with the generic friendly error, visible as a CORS error in the browser console).
- The section renders correctly inside the actual theme's layout (no visual collision with the
  theme's own header/footer/other sections) — this repo's CSS is scoped to avoid affecting the
  rest of the page, but only a real theme page proves there's no unexpected interaction.
- Floating mode, if used, doesn't overlap the theme's own cart drawer, chat widgets, or
  cookie banner.
- Mobile Safari/Chrome on a real device (the project's automated and browser-pane testing covers
  layout at mobile widths, but real touch behavior and on-screen keyboard interaction are worth
  a manual pass).
