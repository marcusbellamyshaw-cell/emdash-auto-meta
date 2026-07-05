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
