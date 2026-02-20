# samsung-docs-mcp

MCP server that scrapes and caches Samsung Smart TV and Signage documentation from developer.samsung.com.

Automatically populates the cache on first run and refreshes weekly (TTL-based, only re-fetches stale pages).

## Setup

```bash
bun install
bun run start        # http://localhost:8787/mcp
bun run populate     # pre-cache all ~330 docs pages
```

### Docker

```bash
docker compose up -d
```

## MCP config

```json
{
  "mcpServers": {
    "samsung-docs": {
      "url": "http://localhost:8787/mcp"
    }
  }
}
```

## Tools

### search

Full-text search over cached docs (BM25+ with fuzzy matching). Falls back to fetching matching pages on demand if the local index has no results.

- `query` (string) — search query
- `maxResults` (number, default 10) — max results to return
- `files` (string[], optional) — glob patterns to filter which pages to search (e.g. `["*product-api*", "*signage*"]`)

### discover

Crawl Samsung docs sidebars to discover all pages. Optionally fetch and cache every page.

- `section` (enum, default "all") — `smarttv-develop`, `smarttv-api`, `smarttv-signage-api`, `smarttv-design`, or `all`
- `fetchAll` (boolean, default false) — download and cache every discovered page
- `concurrency` (number, default 3) — concurrent fetches when `fetchAll=true`

### fetch-page

Fetch a single Samsung docs page by URL path and return its content as markdown. Result is cached.

- `url` (string) — URL path (e.g. `/smarttv/develop/guides/fundamentals/multitasking.html`) or full URL

### list-pages

List all known documentation pages. Supports glob filtering on URL paths.

- `files` (string[], optional) — glob patterns to filter pages (e.g. `["*product-api*"]`)

### list-apis

Extract all Samsung Product API privileges from cached docs, grouped by privilege level.

- `files` (string[], optional) — glob patterns to filter pages (default: `["*samsung-product-api-references/*-api*"]`)
- `since` (string, optional) — version filter using operators: `>=4`, `<6.5`, `>=2,<=5`. Filters by API-level Since version.

### api-overview

Compact overview of all Samsung Product APIs via WebIDL definitions extracted from each cached API reference page. When `since` is provided, shows per-method version info instead of WebIDL.

- `files` (string[], optional) — glob patterns to filter pages (default: `["*samsung-product-api-references/*-api*"]`)
- `device` (enum, default "all") — `tv`, `signage`, or `all`
- `since` (string, optional) — version filter using operators: `>=4`, `<6.5`, `>=2,<=5`, `!=3`. Comma-separated for ranges. Filters individual methods by their Since version.

### clear-cache

Wipe all cached pages and the db. Use to force a full re-fetch.

### cache-status

Show cache stats: directory, populate timestamp, number of cached pages.

## Cache

Cache lives at `~/.cache/mcp/samsung-docs/` (or `$CACHE_DIR`).

- `db.json` — page index with per-page `fetchedAt` timestamps for TTL-based refresh
- `pages/*.md` — cached markdown content

Signage API pages are fetched with `?device=signage` and cached separately from their TV counterparts.
