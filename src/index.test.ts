import { test } from "node:test";
import assert from "node:assert/strict";
import { extractMeta } from "./index.ts";

const META_PREFIX = "<!-- ebt-meta:";
const PATTERN = new RegExp(`${META_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(.+?) -->`);

/** Build a single Portable Text block whose children are the given text fragments. */
function block(children: { text: string; marks?: string[] }[]): Record<string, unknown> {
	return {
		_type: "block",
		children: children.map((c) => ({ _type: "span", text: c.text, marks: c.marks ?? [] })),
	};
}

function contentData(metaBlock: Record<string, unknown>): Record<string, unknown> {
	return { content: [{ _type: "block", children: [{ _type: "span", text: "intro paragraph" }] }, metaBlock] };
}

test("reconstructs a meta block fragmented by Markdown italic corruption (underscored keys)", () => {
	// Markdown parses `seo_title` / `seo_description` underscores as emphasis
	// delimiters, splitting the JSON string into three spans — the middle one
	// carries an "em" mark.
	const raw = '{"seo_title":"A Great Title","seo_description":"A great description here.","content_types":["news"]}';
	const cut = raw.indexOf("_title") + "_".length; // split inside "seo_title"
	const metaBlock = block([
		{ text: `${META_PREFIX}${raw.slice(0, cut)}` },
		{ text: raw.slice(cut, cut + 10), marks: ["em"] },
		{ text: `${raw.slice(cut + 10)} -->` },
	]);

	const result = extractMeta(contentData(metaBlock), PATTERN, META_PREFIX);

	assert.ok(result, "expected a match");
	assert.ok(!result!.parseError, `expected no parse error, got: ${JSON.stringify(result!.parseError)}`);
	assert.equal(result!.meta?.seo_title, "A Great Title");
	assert.equal(result!.meta?.seo_description, "A great description here.");
	assert.deepEqual(result!.meta?.content_types, ["news"]);
});

test("accepts space-separated keys as a Markdown-safe equivalent", () => {
	const metaBlock = block([
		{
			text: `${META_PREFIX}{"seo title":"A Great Title","seo description":"A great description here.","content types":["news"]} -->`,
		},
	]);

	const result = extractMeta(contentData(metaBlock), PATTERN, META_PREFIX);

	assert.ok(result, "expected a match");
	assert.ok(!result!.parseError);
	assert.equal(result!.meta?.seo_title, "A Great Title");
	assert.equal(result!.meta?.seo_description, "A great description here.");
	assert.deepEqual(result!.meta?.content_types, ["news"]);
});

test("surfaces a parse error instead of silently no-oping on malformed JSON", () => {
	// Not valid JSON even after span reconstruction.
	const metaBlock = block([{ text: `${META_PREFIX}{"seo_title": not valid json} -->` }]);

	const result = extractMeta(contentData(metaBlock), PATTERN, META_PREFIX);

	assert.ok(result, "expected extractMeta to recognize the block");
	assert.ok(result!.parseError, "expected a parseError instead of a silent skip");
	assert.match(result!.parseError!.message, /json/i);
	assert.ok(result!.parseError!.raw.includes("not valid json"));
});

import { assignTaxonomies } from "./index.ts";

type Term = { id: string; slug: string; taxonomy: string };

function fakeCtx(initial: { terms: Term[]; entryTerms: string[] }) {
	const terms = [...initial.terms];
	const entry = new Set(initial.entryTerms);
	let next = 0;
	const calls: string[] = [];
	const taxonomies = {
		getTerms: async (taxonomy: string) => terms.filter((t) => t.taxonomy === taxonomy),
		getEntryTerms: async (_c: string, _e: string, opts?: { taxonomy?: string }) =>
			terms.filter((t) => entry.has(t.id) && (!opts?.taxonomy || t.taxonomy === opts.taxonomy)),
		createTerm: async (taxonomy: string, input: { label: string; slug?: string }) => {
			const t = { id: `new${++next}`, slug: input.slug ?? input.label, taxonomy };
			terms.push(t);
			calls.push(`create:${t.slug}`);
			return t;
		},
		addEntryTerms: async (_c: string, _e: string, _tax: string, ids: string[]) => {
			ids.forEach((i) => entry.add(i));
			calls.push(`add:${ids.join(",")}`);
			return [];
		},
		removeEntryTerms: async (_c: string, _e: string, _tax: string, ids: string[]) => {
			ids.forEach((i) => entry.delete(i));
			calls.push(`remove:${ids.join(",")}`);
			return [];
		},
	};
	return { ctx: { taxonomies, kv: {}, log: {} } as never, entry, calls };
}

const cfg = {
	autoCreateTags: true,
	taxonomyMap: { categories: "category", tags: "tag", regions: "region", eras: "era", counties: "county", cities: "city", people: "person", content_types: "content_type" },
} as never;
const log = { info() {}, warn() {}, error() {}, debug() {} } as never;

test("assignTaxonomies replaces an entry's terms, creates missing auto-create terms, skips unknown strict terms", async () => {
	const { ctx, entry, calls } = fakeCtx({
		terms: [
			{ id: "c1", slug: "news", taxonomy: "category" },
			{ id: "c2", slug: "history", taxonomy: "category" },
		],
		entryTerms: ["c1"],
	});
	await assignTaxonomies(ctx, "posts", "p1", { categories: ["history", "nope"], tags: ["texas-history"] } as never, cfg, log);
	assert.deepEqual([...entry].sort(), ["c2", "new1"]); // c1 removed, c2 + new tag added, "nope" skipped (not auto-created)
	assert.ok(calls.includes("create:texas-history"));
	assert.ok(calls.includes("remove:c1"));
	assert.ok(!calls.some((c) => c.includes("nope")));
});

test("assignTaxonomies is a no-op when the meta block names no taxonomies", async () => {
	const { ctx, calls } = fakeCtx({ terms: [], entryTerms: [] });
	await assignTaxonomies(ctx, "posts", "p1", {} as never, cfg, log);
	assert.deepEqual(calls, []);
});
