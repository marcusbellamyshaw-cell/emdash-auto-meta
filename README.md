# emdash-auto-meta

An [Emdash CMS](https://emdashcms.com) plugin that lets AI agents (Claude, ChatGPT, etc.) assign taxonomy terms and set SEO metadata when creating content via the [Emdash MCP server](https://docs.emdashcms.com/mcp).

## The Problem

The Emdash MCP server is great for creating and updating content, but has two gaps that make it hard to use from an AI agent on mobile or in agentic workflows:

1. **No `content_set_terms` tool.** There is no way for an agent to assign taxonomy terms (categories, tags, etc.) through the MCP server.
2. **SEO metadata serialization bug.** The `seo` parameter in `content_update` does not persist correctly. ([Discussion #1070](https://github.com/emdash-cms/emdash/discussions/1070))

This plugin works around both gaps by letting the agent embed a small metadata block directly in the post content. The plugin intercepts every save via `content:afterSave`, processes the block, and strips it before the content reaches readers.

## How It Works

1. When creating a post, the agent appends a metadata block to the Portable Text content field:

   ```
   <!-- ebt-meta:{"categories":["history"],"tags":["dallas"],"seo_title":"My Title"} -->
   ```

2. On `content:afterSave`, this plugin scans all Portable Text fields for the block.
3. It resolves taxonomy slugs to database IDs, assigns terms, and sets SEO — all in a single pass.
4. It strips the block from the content and saves the cleaned version.

The save pipeline sees only the final, clean content. The metadata block is never visible to site visitors.

## Installation

```bash
npm install emdash-auto-meta
```

If you're referencing the plugin locally via a `file:` path during development, also run `npm install` inside the plugin directory so Vite can resolve its peer dependency:

```bash
cd path/to/emdash-auto-meta && npm install
```

**Requirements:**

- Emdash `^0.12.0`
- Cloudflare Workers (paid plan) — this plugin uses `getDb()` from `emdash/runtime` and must run as a trusted plugin in your Workers environment
- Must be registered in `plugins: []` (not `sandboxed: []`)

## Setup

```typescript
// astro.config.mjs
import { emdashAutoMeta } from "emdash-auto-meta";

export default defineConfig({
  integrations: [
    emdash({
      plugins: [
        emdashAutoMeta({
          taxonomyMap: {
            categories: "category",  // your Emdash taxonomy name
            tags: "tag",
            regions: "regions",
            eras: "eras",
          },
        }),
      ],
    }),
  ],
});
```

## Metadata Block Format

Append this block to the end of any Portable Text content field when creating a post. The agent writes it; the plugin strips it.

```
<!-- ebt-meta:{
  "categories": ["history-landmarks"],
  "tags": ["dallas-texas", "new-tag"],
  "regions": ["prairies-lakes"],
  "eras": ["the-oil-boom"],
  "seo_title": "Your SEO Title",
  "seo_description": "Your meta description."
} -->
```

The block must be a single Portable Text block node containing the raw HTML comment. All fields are optional — include only what you need.

### TypeScript Interface

```typescript
interface AutoMeta {
  /** Slugs of existing category terms to assign */
  categories?: string[];
  /** Slugs of tag terms to assign (auto-created if autoCreateTags is true) */
  tags?: string[];
  /** Slugs of existing region terms to assign */
  regions?: string[];
  /** Slugs of existing era terms to assign */
  eras?: string[];
  /** SEO title tag */
  seo_title?: string;
  /** SEO meta description */
  seo_description?: string;
}
```

## Configuration

```typescript
emdashAutoMeta({
  metaPrefix?: string;
  autoCreateTags?: boolean;
  logLevel?: "silent" | "info" | "debug";
  taxonomyMap?: {
    categories?: string;
    tags?: string;
    regions?: string;
    eras?: string;
  };
})
```

| Option | Type | Default | Description |
|---|---|---|---|
| `metaPrefix` | `string` | `"<!-- ebt-meta:"` | The prefix string that identifies the metadata block. Change this if your agents use a different convention. |
| `autoCreateTags` | `boolean` | `true` | When `true`, tag slugs that don't exist in the database are created automatically. Set to `false` to require all tags to be pre-created. |
| `logLevel` | `"silent" \| "info" \| "debug"` | `"info"` | Controls log output. `"debug"` logs every step including successful updates. `"silent"` suppresses everything except errors. |
| `taxonomyMap.categories` | `string` | `"category"` | The Emdash taxonomy name that maps to the `categories` key in the metadata block. |
| `taxonomyMap.tags` | `string` | `"tag"` | The Emdash taxonomy name that maps to the `tags` key. |
| `taxonomyMap.regions` | `string` | `"regions"` | The Emdash taxonomy name that maps to the `regions` key. |
| `taxonomyMap.eras` | `string` | `"eras"` | The Emdash taxonomy name that maps to the `eras` key. |

### Taxonomy Notes

- **`categories`, `regions`, `eras`** — slugs must match terms that already exist in your Emdash database. Unknown slugs are logged as warnings and skipped.
- **`tags`** — when `autoCreateTags: true` (the default), unknown slugs are created as new terms with a label derived from the slug (`"dallas-texas"` → `"Dallas Texas"`). Set `autoCreateTags: false` to treat tags the same as other taxonomies.
- Taxonomy names in `taxonomyMap` must match the `name` field in your Emdash seed exactly, not the display label.

### Prompt for Your Agent

Add something like this to your agent's system prompt or instructions:

```
When creating a post in Emdash, append a metadata block as the final
paragraph of the content field using this exact format:

<!-- ebt-meta:{"categories":["slug"],"tags":["slug"],"seo_title":"Title","seo_description":"Description."} -->

Only include the fields you have values for. Taxonomy slugs must be
lowercase and hyphenated (e.g. "history-landmarks", not "History Landmarks").
```

## Limitations

- **Trusted plugin only.** This plugin uses `getDb()` from `emdash/runtime` to assign taxonomy terms, which requires direct database access. It cannot run in `sandboxed: []` mode.
- **Cloudflare Workers (paid plan) required.** The trusted plugin mode that provides `getDb()` is only available on Cloudflare Workers with a paid plan.
- **Media upload not supported in v1.0.** Attaching images via URL is planned for v1.1, pending a reliable solution for server-side image fetching in the Cloudflare Workers environment. For now, upload images manually through the Emdash admin after creating a post.
- **Metadata block must be in a Portable Text field.** The plugin scans only `_type: "block"` nodes inside array fields. It will not find the block in plain text or other field types.
- **One metadata block per save.** Only the first block found is processed. If the agent writes multiple blocks, only the first is consumed; the rest remain in the content.

## Contributing

This plugin was built as a workaround for two gaps in the Emdash MCP server. If you're interested in seeing native MCP support for taxonomy assignment and SEO metadata, join the discussion:

[github.com/emdash-cms/emdash/discussions/1070](https://github.com/emdash-cms/emdash/discussions/1070)

Bug reports and pull requests welcome. Please open an issue before submitting a PR for anything beyond a small bug fix.

## About

AI-assisted taxonomy and SEO metadata plugin for EmDash CMS. Designed by Marcus Shaw for [Every Bit Texas](https://everybittexas.com). Coded by [Claude Code](https://claude.ai/code).

Built for [EmDash CMS](https://github.com/emdash-cms/emdash) — star the repo to support open-source CMS development.

## License

MIT
