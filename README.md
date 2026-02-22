# samsung-docs-mcp

MCP server for Samsung Developer documentation (`developer.samsung.com`) focused on Smart TV and Signage.

## Behavior

- Discovers documentation pages from predefined entry points.
- Caches page content as markdown in a local cache directory.
- Builds a local full-text index for search.
- Starts a background populate job on first run.
- Runs a weekly refresh using TTL-based refetching.

## Local Run

```bash
bun install
bun run start
```

Server endpoint: `http://localhost:8787/mcp`

Populate cache manually:

```bash
bun run populate
```

## Docker

```bash
docker compose up -d
```

## MCP Configuration

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

### `search`

Search cached docs using MiniSearch (BM25 + fuzzy + prefix). If no local match is found, fetches a small set of matching pages based on title and stores them in cache.

Arguments:

- `query` (`string`, required)
- `maxResults` (`number`, default `10`)
- `files` (`string[]`, optional glob filter)

### `discover`

Discovers pages from one docs section or all sections. Can optionally fetch and cache every discovered page.

Arguments:

- `section` (`"smarttv-develop" | "smarttv-api" | "smarttv-signage-api" | "smarttv-design" | "all"`, default `"all"`)
- `fetchAll` (`boolean`, default `false`)
- `concurrency` (`number`, default `3`, used when `fetchAll=true`)

### `fetch-page`

Fetches a single page and stores it in cache.

Arguments:

- `url` (`string`, required): path or full URL

### `list-pages`

Lists pages present in `db.json`.

Arguments:

- `files` (`string[]`, optional glob filter)

### `list-apis`

Extracts Samsung Product API privilege metadata from cached API reference pages.

Arguments:

- `files` (`string[]`, optional, default `["*samsung-product-api-references/*-api*"]`)
- `since` (`string`, optional version filter, example `">=4,<6.5"`)

### `api-overview`

Builds a compact API summary from cached Product API pages. Returns WebIDL by default, or per-method version details when `since` is set.

Arguments:

- `files` (`string[]`, optional, default `["*samsung-product-api-references/*-api*"]`)
- `device` (`"all" | "tv" | "signage"`, default `"all"`)
- `since` (`string`, optional version filter)

### `clear-cache`

Deletes cached markdown pages and `db.json`.

### `cache-status`

Returns cache directory, last populate timestamp, and cached page count.

## Resources

This server implements MCP resource endpoints: `resources/list`, `resources/read`, and `resources/templates/list`.

Static resources:

- `samsung-docs://cache/status` (`application/json`)
- `samsung-docs://docs/summary` (`application/json`)

Resource template:

- `samsung-docs://page{?href}` (`text/markdown`)

Example page URI:

- `samsung-docs://page?href=%2Fsmarttv%2Fdevelop%2Fapi-references%2Fsamsung-product-api-references.html`

`resources/list` includes page resources generated from `db.json` and is capped by `RESOURCE_PAGE_LIST_LIMIT` (default `120`).

## Cache Layout

Default cache path: `~/.cache/mcp/samsung-docs` (override with `CACHE_DIR`).

- `db.json`: discovered pages and per-page `fetchedAt` timestamps
- `pages/*.md`: cached markdown documents

Signage variants are stored as separate entries using query parameters (for example `?device=signage`).
