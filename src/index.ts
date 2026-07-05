import { definePlugin, ulid } from "emdash";
import type { PluginContext, PluginDescriptor, ResolvedPlugin } from "emdash";
import { getDb } from "emdash/runtime";
import Anthropic from "@anthropic-ai/sdk";

// ─── Config ──────────────────────────────────────────────────────────────────

export interface EmdashAutoMetaConfig {
	/** Prefix string that identifies the metadata block. Default: "<!-- ebt-meta:" */
	metaPrefix?: string;
	/** Auto-create tag terms that don't exist in the database. Default: true */
	autoCreateTags?: boolean;
	/** Logging verbosity. Default: "info" */
	logLevel?: "silent" | "info" | "debug";
	/**
	 * Auto-generate excerpt (meta description) via Claude when absent.
	 * Generates a ≤157-char excerpt from the post title + opening paragraphs.
	 * Default: true
	 */
	autoExcerpt?: boolean;
	/**
	 * Anthropic API key for the Vision + excerpt calls. Prefer setting this
	 * explicitly here — relying on process.env only works under nodejs_compat
	 * and the global fallback never resolves on Workers. If omitted, falls back
	 * to process.env.ANTHROPIC_API_KEY then globalThis.ANTHROPIC_API_KEY.
	 */
	anthropicApiKey?: string;
	/**
	 * Absolute origin of the deployed site (e.g. "https://everybittexas.com"),
	 * used to resolve relative media URLs when fetching hero images for Vision.
	 * On Cloudflare Workers globalThis.location is unreliable, so without this
	 * the fetch falls back to http://localhost:4321 and Vision silently fails in
	 * production. If omitted, falls back to globalThis.location.origin, then
	 * SITE_URL / PUBLIC_SITE_URL env vars, then localhost.
	 */
	siteUrl?: string;
	/**
	 * Maps the fixed metadata block keys to the actual taxonomy names in your
	 * Emdash schema. Use this when your site's taxonomies are named differently
	 * from the defaults.
	 */
	taxonomyMap?: {
		/** Taxonomy name for the "categories" key. Default: "category" */
		categories?: string;
		/** Taxonomy name for the "tags" key. Default: "tag" */
		tags?: string;
		/** Taxonomy name for the "regions" key. Default: "regions" */
		regions?: string;
		/** Taxonomy name for the "eras" key. Default: "eras" */
		eras?: string;
		/** Taxonomy name for the "counties" key. Default: "counties" */
		counties?: string;
		/** Taxonomy name for the "cities" key. Default: "cities" */
		cities?: string;
		/** Taxonomy name for the "people" key. Default: "people" */
		people?: string;
		/** Taxonomy name for the "content_types" key. Default: "content_types" */
		content_types?: string;
	};
}

interface ResolvedConfig {
	metaPrefix: string;
	metaPattern: RegExp;
	autoCreateTags: boolean;
	logLevel: "silent" | "info" | "debug";
	autoExcerpt: boolean;
	anthropicApiKey: string;
	siteUrl: string;
	taxonomyMap: {
		categories: string;
		tags: string;
		regions: string;
		eras: string;
		counties: string;
		cities: string;
		people: string;
		content_types: string;
	};
}

function resolveConfig(config: EmdashAutoMetaConfig): ResolvedConfig {
	const metaPrefix = config.metaPrefix ?? "<!-- ebt-meta:";
	const escapedPrefix = metaPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return {
		metaPrefix,
		metaPattern: new RegExp(`${escapedPrefix}(.+?) -->`),
		autoCreateTags: config.autoCreateTags ?? true,
		logLevel: config.logLevel ?? "info",
		autoExcerpt: config.autoExcerpt ?? true,
		anthropicApiKey: config.anthropicApiKey ?? "",
		siteUrl: config.siteUrl ?? "",
		taxonomyMap: {
			categories: config.taxonomyMap?.categories ?? "category",
			tags: config.taxonomyMap?.tags ?? "tag",
			regions: config.taxonomyMap?.regions ?? "regions",
			eras: config.taxonomyMap?.eras ?? "eras",
			counties: config.taxonomyMap?.counties ?? "counties",
			cities: config.taxonomyMap?.cities ?? "cities",
			people: config.taxonomyMap?.people ?? "people",
			content_types: config.taxonomyMap?.content_types ?? "content_types",
		},
	};
}

/** Read an env var from process.env (nodejs_compat) or globalThis, if present. */
function readEnvVar(name: string): string | undefined {
	const fromProcess = typeof process !== "undefined" ? process.env?.[name] : undefined;
	if (fromProcess) return fromProcess;
	const g = typeof globalThis !== "undefined" ? (globalThis as unknown as Record<string, unknown>)[name] : undefined;
	return typeof g === "string" && g ? g : undefined;
}

/** Resolve the Anthropic API key: explicit config first, then env fallbacks. */
function resolveApiKey(cfg: ResolvedConfig): string | undefined {
	return cfg.anthropicApiKey || readEnvVar("ANTHROPIC_API_KEY");
}

/**
 * Resolve the site origin for fetching relative media URLs. Explicit config
 * wins; otherwise try globalThis.location (dev), then SITE_URL/PUBLIC_SITE_URL,
 * and only then fall back to localhost.
 */
function resolveOrigin(cfg: ResolvedConfig): string {
	if (cfg.siteUrl) return cfg.siteUrl.replace(/\/+$/, "");
	const loc = typeof globalThis !== "undefined" && "location" in globalThis
		? (globalThis as unknown as { location?: { origin?: string } }).location?.origin
		: undefined;
	return loc || readEnvVar("SITE_URL") || readEnvVar("PUBLIC_SITE_URL") || "http://localhost:4321";
}

// ─── Metadata Schema ─────────────────────────────────────────────────────────

export interface AutoMeta {
	categories?: string[];
	tags?: string[];
	regions?: string[];
	eras?: string[];
	counties?: string[];
	cities?: string[];
	people?: string[];
	content_types?: string[];
	seo_title?: string;
	seo_description?: string;
}

// ─── Internal Types ───────────────────────────────────────────────────────────

type Db = Awaited<ReturnType<typeof getDb>>;

interface Logger {
	debug(msg: string): void;
	info(msg: string): void;
	warn(msg: string): void;
	error(msg: string): void;
}

// ─── Vision LLM: Alt Text + Figcaption Generation ────────────────────────────

// Blocks metadata/link-local/loopback/private hosts even if they somehow
// match the configured origin's hostname (defense-in-depth on top of the
// same-origin check below).
const BLOCKED_HOSTS = /^(169\.254\.169\.254|metadata\.google\.internal|localhost|127\.|10\.|192\.168\.|::1)/i;
function isPrivateOrLinkLocalIp(hostname: string): boolean {
	if (BLOCKED_HOSTS.test(hostname)) return true;
	const m = hostname.match(/^172\.(\d{1,3})\./);
	if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
	return false;
}

/**
 * Only same-origin (or relative, resolved same-origin) http(s) URLs are
 * allowed — `featured_image.src` is an ordinary content-editor field, not
 * admin-only, so an absolute URL there must never be fetched as-is.
 */
function isSafeImageUrl(fullUrl: string, origin: string): boolean {
	try {
		const parsed = new URL(fullUrl);
		const originHost = new URL(origin).hostname;
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
		if (parsed.hostname !== originHost) return false;
		if (isPrivateOrLinkLocalIp(parsed.hostname)) return false;
		return true;
	} catch {
		return false;
	}
}

/**
 * Fetch image bytes from a local Emdash media URL and convert to base64.
 * Returns null on any failure so callers can fall back gracefully.
 */
async function fetchImageAsBase64(
	imageUrl: string,
	origin: string,
	log: Logger,
): Promise<{ base64: string; mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp" } | null> {
	try {
		// Resolve relative URLs against the configured/resolved site origin.
		const fullUrl = imageUrl.startsWith("http") ? imageUrl : `${origin}${imageUrl}`;
		if (!isSafeImageUrl(fullUrl, origin)) {
			log.warn(`Vision fetch blocked (unsafe URL): ${fullUrl}`);
			return null;
		}
		// 10-second timeout — the image may be fetched via a self-referential
		// subrequest back through the Worker. An unbounded fetch could stall the
		// content:afterSave hook for the full Cloudflare subrequest timeout.
		const imgCtrl = new AbortController();
		const imgTid = setTimeout(() => imgCtrl.abort(), 10_000);
		const resp = await fetch(fullUrl, { signal: imgCtrl.signal })
			.finally(() => clearTimeout(imgTid));
		if (!resp.ok) {
			log.warn(`Vision fetch failed (${resp.status}): ${fullUrl}`);
			return null;
		}
		const contentType = resp.headers.get("content-type") ?? "image/jpeg";
		const mediaType = (
			contentType.includes("png") ? "image/png" :
			contentType.includes("gif") ? "image/gif" :
			contentType.includes("webp") ? "image/webp" :
			"image/jpeg"
		) as "image/jpeg" | "image/png" | "image/gif" | "image/webp";
		const arrayBuffer = await resp.arrayBuffer();
		const bytes = new Uint8Array(arrayBuffer);
		// Base64 encode
		let binary = "";
		for (let i = 0; i < bytes.byteLength; i++) {
			binary += String.fromCharCode(bytes[i]!);
		}
		const base64 = btoa(binary);
		return { base64, mediaType };
	} catch (err) {
		log.warn(`Vision image fetch error: ${err}`);
		return null;
	}
}

interface VisionAltResult {
	altText: string;
	figcaption: string;
}

/**
 * Call the Anthropic Vision API to generate concise alt text and a
 * brief figcaption for a hero image.
 *
 * Falls back gracefully (returns null) if:
 * - ANTHROPIC_API_KEY is missing
 * - The image cannot be fetched
 * - The API call fails for any reason
 */
export async function generateImageMeta(
	imageUrl: string,
	articleTitle: string,
	apiKey: string | undefined,
	origin: string,
	log: Logger,
): Promise<VisionAltResult | null> {
	if (!apiKey) {
		log.warn("Anthropic API key not set – skipping Vision alt text generation");
		return null;
	}

	const imageData = await fetchImageAsBase64(imageUrl, origin, log);
	if (!imageData) return null;

	try {
		// 25-second SDK-level timeout — prevents a slow Vision API response from
		// stalling the content:afterSave hook indefinitely. The hook has
		// errorPolicy:"continue" so a timeout just skips alt-text generation.
		const client = new Anthropic({ apiKey, timeout: 25_000 });
		const response = await client.messages.create({
			model: "claude-sonnet-4-20250514",
			max_tokens: 300,
			messages: [
				{
					role: "user",
					content: [
						{
							type: "image",
							source: {
								type: "base64",
								media_type: imageData.mediaType,
								data: imageData.base64,
							},
						},
						{
							type: "text",
							text: `You are generating accessibility metadata for a Texas history article titled: "${articleTitle}".

Analyze this image and respond with ONLY valid JSON in this exact format (no markdown, no preamble):
{
  "altText": "<concise description of what is physically depicted in the image, 10-20 words, no quotes>",
  "figcaption": "<brief caption suitable for display below the image, 15-30 words, include date/location if visually apparent, credit 'Source unknown' if no credit is visible>"
}

Rules:
- altText must NOT repeat the article title verbatim
- altText must be descriptive of the image contents (people, place, objects, scene)
- If the image is purely decorative or abstract, use altText: ""
- figcaption should be specific to what is shown, written in present tense or as a caption noun phrase`,
						},
					],
				},
			],
		});

		const text = response.content.find((b) => b.type === "text")?.text ?? "";
		// Strip any accidental markdown fences
		const clean = text.replace(/```json|```/g, "").trim();
		const parsed = JSON.parse(clean) as VisionAltResult;
		if (typeof parsed.altText === "string" && typeof parsed.figcaption === "string") {
			log.info(`Vision: alt="${parsed.altText.slice(0, 60)}"`);
			return parsed;
		}
		log.warn("Vision: unexpected response shape");
		return null;
	} catch (err) {
		log.warn(`Vision API error: ${err}`);
		return null;
	}
}

// ─── Helpers & Auto Excerpt Generation ──────────────────────────────────────

/**
 * Extract plain text from Portable Text blocks, skipping headings.
 * Returns at most `maxChars` characters from the opening paragraphs.
 */
function extractPlainText(content: unknown, maxChars = 600): string {
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as Record<string, unknown>;
		if (b._type !== "block") continue;
		const style = typeof b.style === "string" ? b.style : "normal";
		if (style === "h1" || style === "h2" || style === "h3" || style === "h4") continue;
		const children = b.children;
		if (!Array.isArray(children)) continue;
		const text = children
			.filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
			.map((c) => (typeof c.text === "string" ? c.text : ""))
			.join("");
		if (text.trim()) {
			parts.push(text.trim());
			if (parts.join(" ").length >= maxChars) break;
		}
	}
	return parts.join(" ").slice(0, maxChars);
}

/**
 * Use Claude Haiku to generate a meta description (140–157 chars) from the
 * post title and opening body text.
 * Returns null on failure so callers can skip gracefully.
 */
async function generateAutoExcerpt(
	title: string,
	bodyText: string,
	apiKey: string | undefined,
	log: Logger,
): Promise<string | null> {
	if (!apiKey) {
		log.warn("Anthropic API key not set – skipping auto-excerpt generation");
		return null;
	}

	try {
		const client = new Anthropic({ apiKey, timeout: 20_000 });
		const response = await client.messages.create({
			model: "claude-haiku-4-5-20251001",
			max_tokens: 120,
			messages: [
				{
					role: "user",
					content: `Write a meta description for this article. Requirements:
- Between 140 and 157 characters total (count carefully before responding)
- Plain text only, no quotes, no em dashes at the start
- Enticing, specific, written in present tense
- Do not start with the article title verbatim

Article title: ${title}
Article opening: ${bodyText.slice(0, 500)}

Respond with ONLY the meta description text.`,
				},
			],
		});

		const text =
			(response.content.find((b) => b.type === "text") as { type: "text"; text: string } | undefined)
				?.text?.trim() ?? "";

		if (text.length >= 100 && text.length <= 160) {
			log.info(`Auto-excerpt generated (${text.length} chars)`);
			return text;
		}

		// Trim to 157 if model went slightly over
		if (text.length > 160) {
			const trimmed = text.slice(0, 157).replace(/\s+\S*$/, "").trim();
			if (trimmed.length >= 100) {
				log.info(`Auto-excerpt trimmed to ${trimmed.length} chars`);
				return trimmed;
			}
		}

		log.warn(`Auto-excerpt rejected (${text.length} chars): "${text.slice(0, 60)}"`);
		return null;
	} catch (err) {
		log.warn(`Auto-excerpt error: ${err}`);
		return null;
	}
}

function makeLogger(ctx: PluginContext, level: "silent" | "info" | "debug"): Logger {
	const tag = "[emdash-auto-meta]";
	return {
		debug: (msg) => { if (level === "debug") ctx.log.debug(`${tag} ${msg}`); },
		info:  (msg) => { if (level !== "silent") ctx.log.info(`${tag} ${msg}`); },
		warn:  (msg) => { if (level !== "silent") ctx.log.warn(`${tag} ${msg}`); },
		error: (msg) => { if (level !== "silent") ctx.log.error(`${tag} ${msg}`); },
	};
}

/**
 * Merge dual key-style fields (underscored + space-separated) into the
 * canonical AutoMeta shape. Only fields that contain an underscore need
 * this — space is the Markdown-safe workaround for those.
 */
function normalizeMeta(raw: Record<string, unknown>): AutoMeta {
	const pick = <T,>(a: string, b: string): T | undefined => (raw[a] ?? raw[b]) as T | undefined;
	return {
		categories: raw.categories as string[] | undefined,
		tags: raw.tags as string[] | undefined,
		regions: raw.regions as string[] | undefined,
		eras: raw.eras as string[] | undefined,
		counties: raw.counties as string[] | undefined,
		cities: raw.cities as string[] | undefined,
		people: raw.people as string[] | undefined,
		content_types: pick<string[]>("content_types", "content types"),
		seo_title: pick<string>("seo_title", "seo title"),
		seo_description: pick<string>("seo_description", "seo description"),
	};
}

export interface ExtractedMeta {
	cleanedData: Record<string, unknown>;
	meta?: AutoMeta;
	parseError?: { raw: string; message: string };
}

export function extractMeta(
	data: Record<string, unknown>,
	pattern: RegExp,
	metaPrefix: string,
): ExtractedMeta | null {
	for (const [fieldKey, fieldValue] of Object.entries(data)) {
		if (!Array.isArray(fieldValue)) continue;
		for (let i = 0; i < fieldValue.length; i++) {
			const block = fieldValue[i] as unknown;
			if (!block || typeof block !== "object") continue;
			const blockObj = block as Record<string, unknown>;
			if (blockObj._type !== "block") continue;
			const children = blockObj.children;
			if (!Array.isArray(children)) continue;
			// Reconstruct the block's full text from every span child, in order,
			// regardless of which spans carry marks. Markdown-to-PortableText
			// conversion can split the meta block into multiple spans (e.g. a
			// pair of underscores becomes an "em" mark), fragmenting the JSON
			// string across children — concatenating them back in order undoes
			// that split before JSON.parse ever sees it.
			const fullText = children
				.filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
				.map((c) => (typeof c.text === "string" ? c.text : ""))
				.join("");
			if (!fullText.includes(metaPrefix)) continue;
			const match = fullText.match(pattern);
			if (!match?.[1]) continue;
			const cleanedArray = (fieldValue as unknown[]).filter((_, idx) => idx !== i);
			const cleanedData = { ...data, [fieldKey]: cleanedArray };
			try {
				const meta = normalizeMeta(JSON.parse(match[1]) as Record<string, unknown>);
				return { meta, cleanedData };
			} catch (err) {
				return {
					parseError: { raw: match[1], message: err instanceof Error ? err.message : String(err) },
					cleanedData,
				};
			}
		}
	}
	return null;
}

async function resolveTermSlugs(
	db: Db,
	taxonomyName: string,
	slugs: string[],
	autoCreate: boolean,
	log: Logger,
): Promise<string[]> {
	if (slugs.length === 0) return [];
	const rows = await db
		.selectFrom("taxonomies")
		.select(["slug", "translation_group"])
		.where("name", "=", taxonomyName)
		.where("slug", "in", slugs)
		.execute();
	const existingBySlug = new Map(rows.map((r) => [r.slug, r.translation_group]));
	const groups: string[] = [];
	for (const slug of slugs) {
		const group = existingBySlug.get(slug);
		if (group) {
			groups.push(group);
		} else if (autoCreate) {
			const id = ulid();
			const label = slug
				.split("-")
				.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
				.join(" ");
			await db
				.insertInto("taxonomies")
				.values({ id, name: taxonomyName, slug, label, parent_id: null, data: null, locale: "en", translation_group: id } as never)
				.execute();
			groups.push(id);
			log.info(`Created "${taxonomyName}" term: ${slug}`);
		} else {
			log.warn(`Term not found: ${taxonomyName}/${slug}`);
		}
	}
	return groups;
}

async function setContentTerms(
	db: Db,
	collection: string,
	entryId: string,
	taxonomyName: string,
	termGroups: string[],
): Promise<void> {
	const newSet = new Set(termGroups);
	const current = await db
		.selectFrom("content_taxonomies")
		.innerJoin("taxonomies", "taxonomies.translation_group", "content_taxonomies.taxonomy_id")
		.select("content_taxonomies.taxonomy_id")
		.distinct()
		.where("content_taxonomies.collection", "=", collection)
		.where("content_taxonomies.entry_id", "=", entryId)
		.where("taxonomies.name", "=", taxonomyName)
		.execute();
	const currentSet = new Set(current.map((r) => r.taxonomy_id));
	const toRemove = [...currentSet].filter((g) => !newSet.has(g));
	if (toRemove.length > 0) {
		await db
			.deleteFrom("content_taxonomies")
			.where("collection", "=", collection)
			.where("entry_id", "=", entryId)
			.where("taxonomy_id", "in", toRemove)
			.execute();
	}
	const toAdd = [...newSet].filter((g) => !currentSet.has(g));
	if (toAdd.length > 0) {
		await db
			.insertInto("content_taxonomies")
			.values(toAdd.map((taxonomy_id) => ({ collection, entry_id: entryId, taxonomy_id })))
			.onConflict((oc) => oc.doNothing())
			.execute();
	}
}

/**
 * Assign every taxonomy referenced in a meta block to the content item.
 * Direct DB writes (no content hook). Each taxonomy fails independently so a
 * single bad term never blocks the others. Handles all eight taxonomy keys.
 */
async function assignTaxonomies(
	collection: string,
	contentId: string,
	meta: AutoMeta,
	cfg: ResolvedConfig,
	log: Logger,
): Promise<void> {
	const assignments = [
		{ taxName: cfg.taxonomyMap.categories, slugs: meta.categories ?? [], autoCreate: false },
		{ taxName: cfg.taxonomyMap.tags, slugs: meta.tags ?? [], autoCreate: cfg.autoCreateTags },
		{ taxName: cfg.taxonomyMap.regions, slugs: meta.regions ?? [], autoCreate: false },
		{ taxName: cfg.taxonomyMap.eras, slugs: meta.eras ?? [], autoCreate: false },
		{ taxName: cfg.taxonomyMap.counties, slugs: meta.counties ?? [], autoCreate: false },
		{ taxName: cfg.taxonomyMap.cities, slugs: meta.cities ?? [], autoCreate: cfg.autoCreateTags },
		{ taxName: cfg.taxonomyMap.people, slugs: meta.people ?? [], autoCreate: cfg.autoCreateTags },
		{ taxName: cfg.taxonomyMap.content_types, slugs: meta.content_types ?? [], autoCreate: false },
	];
	if (!assignments.some((a) => a.slugs.length > 0)) return;

	let db: Db;
	try {
		db = await getDb();
	} catch (err) {
		log.error(`Could not get DB: ${err}`);
		return;
	}

	for (const { taxName, slugs, autoCreate } of assignments) {
		if (slugs.length === 0) continue;
		try {
			const groups = await resolveTermSlugs(db, taxName, slugs, autoCreate, log);
			if (groups.length > 0) {
				await setContentTerms(db, collection, contentId, taxName, groups);
				log.info(`Assigned "${taxName}": ${slugs.join(", ")}`);
			}
		} catch (err) {
			log.error(`Taxonomy "${taxName}" failed: ${err}`);
		}
	}
}

// ─── Descriptor Factory ───────────────────────────────────────────────────────

export function emdashAutoMeta(config: EmdashAutoMetaConfig = {}): PluginDescriptor<EmdashAutoMetaConfig> {
	return {
		id: "emdash-auto-meta",
		version: "1.3.0",
		entrypoint: "emdash-auto-meta",
		options: config,
		capabilities: ["content:write"],
	};
}

// ─── Runtime Factory ──────────────────────────────────────────────────────────

export function createPlugin(options: EmdashAutoMetaConfig = {}): ResolvedPlugin {
	const cfg = resolveConfig(options);

	return definePlugin({
		id: "emdash-auto-meta",
		version: "1.3.0",
		capabilities: ["content:write"],

		hooks: {
			"content:afterSave": {
				errorPolicy: "continue",
				handler: async (event: unknown, ctx: PluginContext) => {
					const log = makeLogger(ctx, cfg.logLevel);
					const ev = event as { content: Record<string, unknown>; collection: string };
					const content = ev.content;
					const contentId = typeof content.id === "string" ? content.id : null;
					const contentData = content.data as Record<string, unknown> | null | undefined;
					if (!contentId || !contentData) return;

					// Only act on saves that carry a meta block. The strip update below
					// removes the block, so the re-entrant content:afterSave it triggers
					// finds no block here and returns early — no loops, and no duplicate
					// Vision/excerpt LLM calls on the re-entrant save.
					const extracted = extractMeta(contentData, cfg.metaPattern, cfg.metaPrefix);
					if (!extracted) return;
					log.info(`Processing meta block: ${ev.collection}/${contentId}`);

					type ContentUpdater = {
						update: (col: string, id: string, data: Record<string, unknown>) => Promise<unknown>;
					};
					const updater = (ctx.content && "update" in ctx.content)
						? ctx.content as unknown as ContentUpdater
						: null;

					if (extracted.parseError) {
						const { raw, message } = extracted.parseError;
						log.error(
							`Meta block parse failed for ${ev.collection}/${contentId}: ${message} | raw="${raw}"`,
						);
						// Visible failure signal (not a silent no-op) since the hook's
						// errorPolicy:"continue" means a thrown error here wouldn't
						// reliably surface back to the MCP caller.
						await ctx.kv.set(
							`metaParseError:${ev.collection}:${contentId}`,
							JSON.stringify({ raw, message, at: new Date().toISOString() }),
						);
						// Still strip the malformed block so the raw comment doesn't leak
						// into published content, but skip taxonomy/SEO/LLM work below.
						if (updater) {
							try {
								await updater.update(ev.collection, contentId, extracted.cleanedData);
							} catch (err) {
								log.error(`Strip update failed after parse error: ${err}`);
							}
						}
						return;
					}
					const meta = extracted.meta!;
					const cleanedData = extracted.cleanedData;

					// ── CRITICAL PATH FIRST: taxonomy assignment ──────────────────
					// Runs BEFORE the slow Vision/excerpt LLM work below. On Cloudflare
					// Workers the content:afterSave continuation can be cut off once the
					// HTTP response is returned; doing these fast DB writes first means
					// taxonomies are always assigned even if the best-effort LLM steps
					// get starved. (This was the regression: the Vision call ran first
					// and the handler died before ever reaching taxonomy assignment.)
					await assignTaxonomies(ev.collection, contentId, meta, cfg, log);

					// ── Strip the meta block + set SEO (fast, no LLM) ─────────────
					// Its own update so the authored comment is removed and SEO is set
					// reliably, even if the Vision/excerpt work below is cut short.
					const stripPayload: Record<string, unknown> = { ...cleanedData };
					if (meta.seo_title || meta.seo_description) {
						const existingSeo = contentData.seo && typeof contentData.seo === "object"
							? (contentData.seo as Record<string, unknown>)
							: {};
						stripPayload["seo"] = {
							...existingSeo,
							...(meta.seo_title ? { title: meta.seo_title } : {}),
							...(meta.seo_description ? { description: meta.seo_description } : {}),
						};
					}
					if (updater) {
						try {
							await updater.update(ev.collection, contentId, stripPayload);
							log.debug(`Stripped meta block: ${ev.collection}/${contentId}`);
						} catch (err) {
							log.error(`Strip update failed: ${err}`);
						}
					}

					// ── Best-effort LLM extras: Vision alt/caption + auto-excerpt ──
					// Intentionally LAST. These are slow and may be cut short on
					// Workers, but the critical taxonomy + block-strip + SEO work
					// above is already done by this point.
					const apiKey = resolveApiKey(cfg);
					const origin = resolveOrigin(cfg);
					const extrasPayload: Record<string, unknown> = {};
					let hasExtras = false;

					// Vision: generate alt text + figcaption for the hero image
					const featuredImage = contentData.featured_image as Record<string, unknown> | null | undefined;
					const imageStorageKey =
						(featuredImage?.meta as Record<string, unknown> | undefined)?.storageKey as string | undefined ??
						(typeof featuredImage?.id === "string" ? featuredImage.id : undefined);
					const imageUrl = imageStorageKey
						? `/_emdash/api/media/file/${imageStorageKey}`
						: (typeof featuredImage?.src === "string" ? featuredImage.src : undefined);
					if (imageUrl && featuredImage && typeof featuredImage === "object") {
						const title = typeof contentData.title === "string" ? contentData.title : "";
						const visionResult = await generateImageMeta(imageUrl, title, apiKey, origin, log);
						if (visionResult) {
							extrasPayload["featured_image"] = {
								...featuredImage,
								alt: visionResult.altText,
								caption: visionResult.figcaption,
							};
							hasExtras = true;
							await ctx.kv.set(`figcaption:${ev.collection}:${contentId}`, visionResult.figcaption);
							log.info(`Vision figcaption stored for ${contentId}`);
						}
					}

					// Auto-generate excerpt only when one isn't already present, so it
					// never overwrites a manually authored excerpt.
					if (cfg.autoExcerpt) {
						const existingExcerpt =
							typeof contentData.excerpt === "string" ? contentData.excerpt.trim() : "";
						if (!existingExcerpt) {
							const title = typeof contentData.title === "string" ? contentData.title : "";
							const bodyText = extractPlainText(contentData.content);
							if (title && bodyText) {
								const generated = await generateAutoExcerpt(title, bodyText, apiKey, log);
								if (generated) {
									extrasPayload["excerpt"] = generated;
									hasExtras = true;
								}
							}
						}
					}

					if (hasExtras && updater) {
						try {
							await updater.update(ev.collection, contentId, extrasPayload);
							log.debug(`Applied LLM extras: ${ev.collection}/${contentId}`);
						} catch (err) {
							log.error(`Extras update failed: ${err}`);
						}
					}
				},
			},
		},
	});
}

export default createPlugin;
