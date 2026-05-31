# fetch-notion-docs

**English** | [简体中文](./README.zh-CN.md)

Download an entire **public** Notion site as Markdown — including internal reference links (rewritten as local relative links) and images (downloaded locally).

Made for the case where you want to archive **someone else's published public site** (not your own workspace, no official token available). Built on [`notion-client`](https://github.com/NotionX/react-notion-x) (public pages are readable via `getPage(pageId)` with no token) + [`notion-utils`](https://github.com/NotionX/react-notion-x), with custom crawling and Markdown serialization.

## Features

- **Recursive BFS crawl** from the root page: follows sub-pages / database rows / page mentions / in-site `a`-links
- Renders each page to **Markdown**: bold, italic, strikethrough, inline code, links, headings, lists, to-dos, quotes, callouts, code blocks, equations, images
  - `toggle` → `<details>`
  - database views → Markdown tables (first view)
  - unknown block types fall back to plain text
- **Internal page references** rewritten to relative links to local `.md` files
- **Images** downloaded via signed URLs into `assets/` (deduped by URL hash)
- Generates an `_index.md` site overview
- **Robust against rate limiting**: exponential backoff + re-queue on failure + global cooldown on consecutive failures; permanent errors (404 / unpublished) are skipped immediately

## Install

Requires **Node.js 18+** (uses the built-in `fetch`).

```bash
npm install
```

Install as a global command (during development use `npm link`; or after publishing, `npm i -g fetch-notion-docs`):

```bash
npm link
```

## Usage

### 1. Command line

```bash
# global command
fetch-notion-docs "<ROOT_URL>" ./docs

# or run directly without a global install
node cli.mjs "<ROOT_URL>" ./docs

# or via npm script (args go after --)
npm run crawl -- "<ROOT_URL>" ./docs
```

Example:

```bash
fetch-notion-docs "https://your-site.notion.site/Xxxx-00d28b31..." ./docs
```

### 2. As a library

```js
import { crawlNotionSite } from 'fetch-notion-docs';

const result = await crawlNotionSite(
  'https://your-site.notion.site/Xxxx-00d28b31...',
  './docs',
  {
    maxPages: 500,
    requestDelayMs: 700,
    maxRequeue: 5,
    log: () => {},        // pass a no-op to silence normal logs
    warn: console.warn,
  }
);
// result: { pages, images, failed: string[], outDir, indexFile }
```

Lower-level rendering functions are also exported: `renderBlocks(blockIds, recordMap, ctx)`, `renderInline(richText, ctx)`, and the error type `PermanentError`.

Output:

```
docs/
├── _index.md             # site overview (links to all pages)
├── <page-title>-<id>.md  # one Markdown file per page
└── assets/               # downloaded images
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `MAX_PAGES` | `500` | Max number of pages to crawl |
| `REQUEST_DELAY_MS` | `700` | Base throttle interval (ms) between pages; raise it under heavy rate limiting |
| `MAX_REQUEUE` | `5` | Max re-queue attempts per page after a rate-limit failure |

Example (slow down to avoid rate limiting):

```bash
REQUEST_DELAY_MS=1200 MAX_PAGES=1000 fetch-notion-docs "<ROOT_URL>" ./docs
```

## Requirements & limitations

- **The site must be Published (public)**, otherwise `loadPageChunk` returns unauthorized and the page can't be fetched.
- Pages that can't be fetched (404 / unpublished / a different workspace) are **kept as their original Notion remote links**, not localized.
- Only the **first view** of a database is read; nested databases, `synced_block`, and special embeds (Figma / Drive, etc.) currently use fallback rendering and may not be ideal.
- You are downloading **third-party content** — confirm copyright and usage rights yourself. This repo `.gitignore`s `docs/` by default; committing crawled output to version control is not recommended.

## Implementation notes

- `getPage(id, { fetchCollections: true, signFileUrls: true })` returns an `ExtendedRecordMap` (`block` / `collection` / `collection_view` / `collection_query` / `signed_urls`).
- ⚠️ Records returned by `notion-client` 7.x are **double-wrapped** with a role; the real value lives at `entry.value.value` (unwrapped consistently via the `rval()` helper).
- Sub-pages are blocks of `type === 'page' | 'collection_view_page'` in the recordMap; each needs its own `getPage` call to obtain its body.
- Images prefer `signed_urls[blockId]`, falling back to `defaultMapImageUrl`.
- Rich text is a decoration array (`b`/`i`/`s`/`c`/`a`/`p`/`e`…), converted to Markdown by `renderInline`.

## License

[MIT](./LICENSE)
