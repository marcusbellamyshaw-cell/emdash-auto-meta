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
	};
}

interface ResolvedConfig {
	metaPrefix: string;
	metaPattern: RegExp;
	autoCreateTags: boolean;
	logLevel: "silent" | "info" | "debug";
	taxonomyMap: {
		categories: string;
		tags: string;
		regions: string;
		eras: string;
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
		taxonomyMap: {
			categories: config.taxonomyMap?.categories ?? "category",
			tags: config.taxonomyMap?.tags ?? "tag",
			regions: config.taxonomyMap?.regions ?? "regions",
			eras: config.taxonomyMap?.eras ?? "eras",
		},
	};
}

// ─── Metadata Schema ─────────────────────────────────────────────────────────

export interface AutoMeta {
	categories?: string[];
	tags?: string[];
	regions?: string[];
	eras?: string[];
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

/**
 * Fetch image bytes from a local Emdash media URL and convert to base64.
 * Returns null on any failure so callers can fall back gracefully.
 */
async function fetchImageAsBase64(
	imageUrl: string,
	log: Logger,
): Promise<{ base64: string; mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp" } | null> {
	try {
		// Resolve relative URLs to the local Worker origin
		const origin = typeof globalThis !== "undefined" && "location" in globalThis
			? (globalThis as unknown as { location: { origin: string } }).location.origin
			: "http://localhost:4321";
		const fullUrl = imageUrl.startsWith("http") ? imageUrl : `${origin}${imageUrl}`;
		const resp = await fetch(fullUrl);
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
			binary += String.fromCharCode(bytes[i]);
		}
		const base64 = btoa(binary);
		return { base64, mediaType };
	} catch (err) {
		log.warn(`Vision image fetch error: ${err}`);
		return null;
	}
}

export interface VisionAltResult {
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
	log: Logger,
): Promise<VisionAltResult | null> {
	const apiKey = (typeof process !== "undefined" && process.env?.ANTHROPIC_API_KEY) ??
		(typeof globalThis !== "undefined" ? (globalThis as unknown as Record<string, string>)["ANTHROPIC_API_KEY"] : undefined);

	if (!apiKey) {
		log.warn("ANTHROPIC_API_KEY not set – skipping Vision alt text generation");
		return null;
	}

	const imageData = await fetchImageAsBase64(imageUrl, log);
	if (!imageData) return null;

	try {
		const client = new Anthropic({ apiKey });
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeLogger(ctx: PluginContext, level: "silent" | "info" | "debug"): Logger {
	const tag = "[emdash-auto-meta]";
	return {
		debug: (msg) => { if (level === "debug") ctx.log.debug(`${tag} ${msg}`); },
		info:  (msg) => { if (level !== "silent") ctx.log.info(`${tag} ${msg}`); },
		warn:  (msg) => { if (level !== "silent") ctx.log.warn(`${tag} ${msg}`); },
		error: (msg) => { if (level !== "silent") ctx.log.error(`${tag} ${msg}`); },
	};
}

function extractMeta(
	data: Record<string, unknown>,
	pattern: RegExp,
): { meta: AutoMeta; cleanedData: Record<string, unknown> } | null {
	for (const [fieldKey, fieldValue] of Object.entries(data)) {
		if (!Array.isArray(fieldValue)) continue;
		for (let i = 0; i < fieldValue.length; i++) {
			const block = fieldValue[i] as unknown;
			if (!block || typeof block !== "object") continue;
			const blockObj = block as Record<string, unknown>;
			if (blockObj._type !== "block") continue;
			const children = blockObj.children;
			if (!Array.isArray(children)) continue;
			for (const child of children) {
				if (!child || typeof child !== "object") continue;
				const childObj = child as Record<string, unknown>;
				if (typeof childObj.text !== "string") continue;
				const match = childObj.text.match(pattern);
				if (!match?.[1]) continue;
				let meta: AutoMeta;
				try {
					meta = JSON.parse(match[1]) as AutoMeta;
				} catch {
					return null;
				}
				const cleanedArray = (fieldValue as unknown[]).filter((_, idx) => idx !== i);
				return { meta, cleanedData: { ...data, [fieldKey]: cleanedArray } };
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

// ─── Descriptor Factory ───────────────────────────────────────────────────────

export function emdashAutoMeta(config: EmdashAutoMetaConfig = {}): PluginDescriptor<EmdashAutoMetaConfig> {
	return {
		id: "emdash-auto-meta",
		version: "1.0.0",
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
		version: "1.0.0",
		capabilities: ["content:write"],

		hooks: {
			"content:afterSave": {
				errorPolicy: "continue",
				handler: async (event: never, ctx: PluginContext) => {
					const log = makeLogger(ctx, cfg.logLevel);
					const ev = event as { content: Record<string, unknown>; collection: string };
					const content = ev.content;
					const contentId = typeof content.id === "string" ? content.id : null;
					const contentData = content.data as Record<string, unknown> | null | undefined;
					if (!contentId || !contentData) return;

					const extracted = extractMeta(contentData, cfg.metaPattern);
					if (!extracted) return;

					const { meta, cleanedData } = extracted;
					log.info(`Processing ${ev.collection}/${contentId}`);

					// ── Vision: generate alt text + figcaption for the hero image ──────
					const featuredImage = contentData.featured_image as Record<string, unknown> | null | undefined;
					const imageStorageKey =
						(featuredImage?.meta as Record<string, unknown> | undefined)?.storageKey as string | undefined ??
						(typeof featuredImage?.id === "string" ? featuredImage.id : undefined);
					const imageUrl = imageStorageKey
						? `/_emdash/api/media/file/${imageStorageKey}`
						: (typeof featuredImage?.src === "string" ? featuredImage.src : undefined);

					let visionResult: VisionAltResult | null = null;
					if (imageUrl) {
						const title = typeof contentData.title === "string" ? contentData.title : "";
						visionResult = await generateImageMeta(imageUrl, title, log);
					}

					// Build update payload: cleaned body + optional SEO + Vision-generated image meta
					const updatePayload: Record<string, unknown> = { ...cleanedData };
					if (meta.seo_title || meta.seo_description) {
						updatePayload["seo"] = {
							title: meta.seo_title ?? "",
							description: meta.seo_description ?? "",
						};
					}
					// Patch hero image alt if Vision succeeded and image exists
					if (visionResult && featuredImage && typeof featuredImage === "object") {
						updatePayload["featured_image"] = {
							...featuredImage,
							alt: visionResult.altText,
							// Store figcaption in a custom field if the schema supports it;
							// otherwise it will be accessible via the alt field and plugin storage.
							caption: visionResult.figcaption,
						};
						// Persist figcaption to plugin KV so themes can read it independently
						await ctx.kv.set(`figcaption:${ev.collection}:${contentId}`, visionResult.figcaption);
						log.info(`Vision figcaption stored for ${contentId}`);
					}

					// Strip the meta block (and set SEO) in a single content update
					if (ctx.content && "update" in ctx.content) {
						try {
							await (ctx.content as {
								update: (col: string, id: string, data: Record<string, unknown>) => Promise<unknown>;
							}).update(ev.collection, contentId, updatePayload);
							log.debug(`Content updated: ${ev.collection}/${contentId}`);
						} catch (err) {
							log.error(`Content update failed: ${err}`);
						}
					}

					// Taxonomy assignment — each taxonomy fails independently
					const assignments = [
						{ taxName: cfg.taxonomyMap.categories, slugs: meta.categories ?? [], autoCreate: false },
						{ taxName: cfg.taxonomyMap.tags,       slugs: meta.tags ?? [],       autoCreate: cfg.autoCreateTags },
						{ taxName: cfg.taxonomyMap.regions,    slugs: meta.regions ?? [],    autoCreate: false },
						{ taxName: cfg.taxonomyMap.eras,       slugs: meta.eras ?? [],       autoCreate: false },
					];

					if (assignments.every((a) => a.slugs.length === 0)) return;

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
								await setContentTerms(db, ev.collection, contentId, taxName, groups);
								log.info(`Assigned "${taxName}": ${slugs.join(", ")}`);
							}
						} catch (err) {
							log.error(`Taxonomy "${taxName}" failed: ${err}`);
						}
					}
				},
			},
		},
	});
}

export default createPlugin;