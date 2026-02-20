# samsung-docs-mcp

MCP server that scrapes and caches Samsung Smart TV and Signage documentation from developer.samsung.com.

## Setup

```bash
bun install
bun run start        # http://localhost:8787/mcp
bun run populate     # pre-cache all ~300 docs pages
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

- **search** - local-first search over cached docs, online fallback
- **discover** - crawl doc sidebars, optionally fetch all pages
- **fetch-page** - fetch a single page by URL path, cache as markdown
- **clear-cache** - wipe all cached pages and index
- **cache-status** - show cache stats

Cache lives at `~/.cache/mcp/samsung-docs/`.
