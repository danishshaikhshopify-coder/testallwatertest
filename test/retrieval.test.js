// Phase 2: product retrieval at catalog scale (6,000+ products), relevance ranking, and the
// "help first, sell second" selection rules. These exercise api/_catalog.js's pure ranking
// functions directly against large synthetic candidate sets (the store's own search endpoint
// already bounds how many candidates ever reach this code — see "findProducts never fetches
// the whole catalog" below for that guarantee), and api/chat.js's retrieval wiring end to end.
import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreCandidate, selectProducts, findProducts, resetCatalogState } from "../api/_catalog.js";
import { analyzeNeeds } from "../api/_needs.js";
import { installWorld, llmReply } from "./fake-store.js";

const needsFor = (...messages) => analyzeNeeds(messages);

// A candidate shaped exactly like api/_catalog.js's normalizeCandidate() output.
function candidate(over) {
  return {
    handle: "x", rank: 0, title: "Pool Test Strips", vendor: "Generic", type: "Test Kits",
    tags: ["Swimming Pools", "Chlorine Test Kits"], body: "", available: true, price: 9.99, image: null,
    ...over,
  };
}

// A large, mostly-irrelevant synthetic catalog slice: unrelated products, wrong water type,
// out of stock, accessories, expired stock, and a handful of genuinely relevant products at
// very different price points. Mirrors the shape a real 6,000+ product Shopify catalog would
// produce across many search queries.
function syntheticCatalog(size) {
  const candidates = [];
  const noiseTitles = [
    "Garden Hose Reel", "Pool Float Flamingo", "BBQ Tool Set", "Spa Chemical Floc 1kg",
    "Aquarium Gravel 5kg", "Fish Net Small", "Pond Liner 4x5m", "Chlorine Shock Granules 5kg",
    "Replacement Filter Cartridge", "Pool Cover Reel Arm", "Test Tube Rack Accessory",
  ];
  for (let i = 0; i < size; i++) {
    const title = noiseTitles[i % noiseTitles.length];
    candidates.push(candidate({
      handle: `noise-${i}`,
      rank: i,
      title: `${title} ${i}`,
      vendor: `Vendor${i % 40}`,
      type: i % 5 === 0 ? "Accessories" : "Pool Chemicals",
      tags: ["Swimming Pools"],
      available: i % 7 !== 0, // some out of stock
      price: 5 + (i % 500),
    }));
  }
  return candidates;
}

test("retrieval at scale: 6,000+ candidates narrows to a small, genuinely relevant set", () => {
  const needs = needsFor("My pool water is cloudy. I want to check chlorine and pH.");
  const noise = syntheticCatalog(6000);
  const relevant = [
    candidate({ handle: "cheap-relevant", title: "Pool Chlorine & pH Test Strips", price: 6.99, tags: ["Swimming Pools", "Chlorine Test Kits"] }),
    candidate({ handle: "mid-relevant", title: "Pool Chlorine pH Alkalinity Test Kit", vendor: "Other", price: 24.5, tags: ["Swimming Pools", "Chlorine Test Kits", "Alkalinity Test Kits"] }),
    candidate({ handle: "expensive-irrelevant", title: "Commercial Pool Chemical Dosing Pump", vendor: "ExpensiveCo", price: 899.99, type: "Pool Equipment", tags: ["Swimming Pools"] }),
  ];
  const all = [...noise, ...relevant];

  const t0 = Date.now();
  const chosen = selectProducts(all, needs);
  const elapsedMs = Date.now() - t0;

  assert.ok(elapsedMs < 1000, `ranking 6,000+ candidates took too long: ${elapsedMs}ms`);
  assert.ok(chosen.length >= 1 && chosen.length <= 3, `expected 1-3 picks, got ${chosen.length}`);
  assert.ok(chosen.every((p) => p.available), "no out-of-stock product was picked");
  assert.ok(!chosen.some((p) => p.handle.startsWith("noise-")), "no irrelevant noise product was picked");
  assert.ok(!chosen.some((p) => p.handle === "expensive-irrelevant"), "the dosing pump is not a test a customer can use to check chlorine/pH, so it must not be picked");
});

test("retrieval: price is not the ranking factor — the most expensive relevant product does not automatically win", () => {
  const needs = needsFor("My pool water is cloudy. I want to check chlorine and pH.");
  const cheap = candidate({ handle: "cheap", title: "Pool Chlorine pH Test Strips", price: 4.99 });
  const expensive = candidate({ handle: "pricey", title: "Pool Chlorine pH Test Strips Deluxe", vendor: "Other", price: 249.99 });
  // Both cover the same parameters equally well; the cheaper, equally-relevant one should be
  // free to rank first (scoreCandidate has no price term at all).
  const chosenCheapFirst = selectProducts([cheap, expensive], needs);
  assert.equal(scoreCandidate(cheap, needs).score, scoreCandidate(expensive, needs).score, "price must not affect the relevance score");
  assert.ok(chosenCheapFirst.length >= 1);

  // An expensive product that covers FEWER needed parameters must not beat a cheap one that
  // covers MORE of them, even though it costs far more.
  const cheapBroad = candidate({ handle: "broad", title: "Pool Chlorine pH Alkalinity Cyanuric Acid Test Kit", price: 9.99 });
  const expensiveNarrow = candidate({ handle: "narrow", title: "Pool Chlorine Photometer", vendor: "Other", type: "Instruments", price: 599.99 });
  const picks = selectProducts([expensiveNarrow, cheapBroad], needs);
  assert.equal(picks[0].handle, "broad", "broader relevant coverage must outrank a pricier, narrower instrument");
});

test("retrieval: help first, sell second — one strong match beats several near-duplicates", () => {
  const needs = needsFor("My pool water is green.");
  const nearDuplicates = Array.from({ length: 5 }, (_, i) =>
    candidate({ handle: `dup-${i}`, rank: i, title: "Pool Chlorine pH Test Strips", vendor: `V${i}`, price: 7.99 }));
  const chosen = selectProducts(nearDuplicates, needs);
  assert.equal(chosen.length, 1, "near-identical products collapse to a single recommendation, not a wall of options");
});

test("retrieval: a genuinely complementary product is offered, and ranks ahead of a non-complementary filler", () => {
  const needs = needsFor("My pool water is cloudy. I want to check chlorine, pH and alkalinity.");
  const primary = candidate({ handle: "primary", title: "Pool Chlorine pH Test Strips", price: 6.99 });
  const genuinelyComplementary = candidate({ handle: "alkalinity", title: "Pool Alkalinity Test Kit", vendor: "Other", price: 8.99, tags: ["Swimming Pools", "Alkalinity Test Kits"] });
  const chosen = selectProducts([primary, genuinelyComplementary], needs);
  assert.ok(chosen.some((p) => p.handle === "primary"));
  assert.ok(chosen.some((p) => p.handle === "alkalinity"), "the alkalinity kit adds real, needed coverage and should be offered alongside the primary pick");

  // A near-duplicate that adds nothing new is still outranked by the genuinely complementary
  // pick when a choice has to be made (selectProducts fills remaining coverage gains first).
  const uselessDuplicate = candidate({ handle: "dup2", title: "Pool Chlorine pH Test Strips Mini", vendor: "Third", price: 5.99 });
  const withFiller = selectProducts([primary, genuinelyComplementary, uselessDuplicate], needs);
  assert.ok(withFiller.findIndex((p) => p.handle === "alkalinity") < withFiller.findIndex((p) => p.handle === "dup2"),
    "the product that adds real coverage is prioritized over one that does not");
});

test("retrieval: unavailable, accessory, chemical and expired listings are excluded regardless of catalog size", () => {
  const needs = needsFor("My pool water is cloudy.");
  const bad = [
    candidate({ handle: "oos", available: false }),
    candidate({ handle: "acc", type: "Accessories", title: "Test Tube Rack" }),
    candidate({ handle: "chem", title: "Chlorine Shock Granules 5kg", type: "Pool Chemicals" }),
    candidate({ handle: "exp", title: "Pool Test Strips Expired 04/26" }),
  ];
  assert.deepEqual(selectProducts(bad, needs), []);
});

test("retrieval: findProducts never fetches the whole catalog, however large it is", async () => {
  resetCatalogState();
  // A store with far more than 6,000 products, but search results are always capped at 10 by
  // Shopify's own endpoint (emulated here) — the code must never try to list or page through
  // the full catalog to find relevant products.
  const BIG_CATALOG_SIZE = 7000;
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    calls.push(u.pathname);
    if (u.pathname === "/cart.js") {
      return new Response(JSON.stringify({ currency: "GBP" }), { status: 200 });
    }
    if (u.pathname === "/search/suggest.json") {
      // However big the real catalog is, a search endpoint returns at most a handful of hits.
      const results = Array.from({ length: 10 }, (_, i) => ({
        handle: `relevant-${i}`, id: i, title: "Pool Chlorine pH Test Strips", vendor: "V",
        price: "9.99", available: true, tags: ["Swimming Pools", "Chlorine Test Kits"], body: "",
        type: "Test Kits", image: null,
      }));
      return new Response(JSON.stringify({ resources: { results: { products: results } } }), { status: 200 });
    }
    if (/^\/products\/relevant-\d+\.js$/.test(u.pathname)) {
      return new Response(JSON.stringify({
        id: 1, handle: u.pathname.split("/")[2].replace(".js", ""), title: "Pool Chlorine pH Test Strips",
        vendor: "V", available: true, price_min: 999, variants: [{ id: 1, available: true, price: 999 }],
      }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };

  const needs = analyzeNeeds(["My pool water is cloudy. I want to check chlorine and pH."]);
  const result = await findProducts(needs);

  assert.equal(result.status, "ok");
  assert.ok(result.products.length >= 1 && result.products.length <= 3);
  // Bounded regardless of BIG_CATALOG_SIZE: one currency check, a handful of search queries
  // (MAX_QUERIES), and at most MAX_PRODUCTS product look-ups — never one request per product.
  const searchCalls = calls.filter((p) => p === "/search/suggest.json").length;
  const productCalls = calls.filter((p) => /^\/products\//.test(p)).length;
  assert.ok(searchCalls <= 6, `expected a handful of search queries, got ${searchCalls}`);
  assert.ok(productCalls <= 3, `expected at most 3 product look-ups, got ${productCalls}`);
  assert.ok(calls.length < 15, `expected a small, bounded number of requests for a ${BIG_CATALOG_SIZE}-product catalog, got ${calls.length}`);
});

test("retrieval: no invented products — every recommended product traces back to a real store handle", async () => {
  resetCatalogState();
  const { createFakeStore } = await import("./fake-store.js");
  const store = createFakeStore();
  installWorld({ store, llm: llmReply("unused") });
  const needs = analyzeNeeds(["My pool water is cloudy."]);
  const result = await findProducts(needs);
  assert.equal(result.status, "ok");
  for (const p of result.products) {
    assert.ok(p.id && p.url && p.title, "every product has real id/url/title from the store");
    assert.match(p.url, /^https:\/\/testallwater\.co\.uk\/products\//);
  }
});
