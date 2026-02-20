import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { discoverLinks, fetchPage, ENTRY_POINTS } from "./scraper.js";
import {
  readCached,
  writeCache,
  writeIndex,
  readIndex,
  clearCache,
  cacheStats,
} from "./cache.js";
import { search, buildSearchIndex } from "./search.js";
import { populate } from "./populate.js";

// CLI: bun run src/server.ts --populate [--concurrency 5] [--section all]
if (process.argv.includes("--populate")) {
  const concIdx = process.argv.indexOf("--concurrency");
  const secIdx = process.argv.indexOf("--section");
  await populate({
    concurrency: concIdx !== -1 ? Number(process.argv[concIdx + 1]) : 5,
    section: secIdx !== -1 ? process.argv[secIdx + 1] : "all",
  });
  process.exit(0);
}

const PORT = Number(process.env.PORT) || 8787;

const server = new McpServer({
  name: "samsung-docs",
  version: "0.1.0",
});

server.tool(
  "search",
  "Search Samsung TV and Signage documentation using full-text search (BM25+ scoring with fuzzy matching). Searches local cache first, falls back to online fetching if no results found.",
  {
    query: z.string().describe("Search query (e.g. 'AVPlay API', 'signage remote control', 'web engine specifications')"),
    maxResults: z.number().min(1).max(25).default(10).describe("Maximum number of results to return"),
  },
  async ({ query, maxResults }) => {
    const localResults = await search(query, maxResults).catch(() => []);

    if (localResults.length > 0) {
      const text = localResults
        .map((r) => {
          const matchPreview = r.matches.join("\n  ");
          return `## ${r.title}\nURL: ${r.url} (score: ${r.score.toFixed(1)})\n  ${matchPreview}`;
        })
        .join("\n\n");

      return {
        content: [{ type: "text" as const, text: `Found ${localResults.length} result(s) for "${query}":\n\n${text}` }],
      };
    }

    let idx = await readIndex();
    if (!idx) {
      const links = await discoverLinks(ENTRY_POINTS["smarttv-develop"]);
      await writeIndex(links);
      idx = links;
    }

    const queryTerms = query.toLowerCase().split(/\s+/);
    const matchingUrls = idx.filter((item) => {
      const titleLower = item.title.toLowerCase();
      return queryTerms.some((t) => titleLower.includes(t));
    });

    if (matchingUrls.length === 0) {
      return {
        content: [{ type: "text" as const, text: `No results found for "${query}". Try running 'discover' first to build the local cache, then search again.` }],
      };
    }

    const toFetch = matchingUrls.slice(0, 3);
    const fetched: string[] = [];

    for (const { href, title } of toFetch) {
      try {
        const page = await fetchPage(href);
        await writeCache(href, `# ${page.title}\n\nSource: ${page.url}\n\n${page.markdown}`);
        fetched.push(`## ${title}\nURL: ${href}\n\n${page.markdown.slice(0, 500)}...`);
      } catch (e) {
        fetched.push(`## ${title}\nURL: ${href}\nError: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    return {
      content: [{ type: "text" as const, text: `Fetched ${fetched.length} page(s) matching "${query}" (now cached):\n\n${fetched.join("\n\n---\n\n")}` }],
    };
  }
);

server.tool(
  "discover",
  "Crawl Samsung docs to discover all pages and optionally fetch+cache their content as markdown. Sections: smarttv-develop, smarttv-api, smarttv-signage-api, smarttv-design.",
  {
    section: z
      .enum(["smarttv-develop", "smarttv-api", "smarttv-signage-api", "smarttv-design", "all"])
      .default("all")
      .describe("Which docs section to discover"),
    fetchAll: z
      .boolean()
      .default(false)
      .describe("If true, fetch and cache every discovered page (slow but enables local grep). If false, only builds the index."),
    concurrency: z
      .number()
      .min(1)
      .max(10)
      .default(3)
      .describe("Number of concurrent page fetches (only used when fetchAll=true)"),
  },
  async ({ section, fetchAll, concurrency }) => {
    if (fetchAll) {
      // Reuse the populate logic, capture output
      const oldLog = console.log;
      const lines: string[] = [];
      console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
      try {
        await populate({ concurrency, section });
      } finally {
        console.log = oldLog;
      }
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    }

    // Index-only mode
    const entries =
      section === "all"
        ? Object.entries(ENTRY_POINTS)
        : [[section, ENTRY_POINTS[section as keyof typeof ENTRY_POINTS]] as const];

    let allLinks: { href: string; title: string }[] = [];
    const sectionResults: string[] = [];

    for (const [name, entryUrl] of entries) {
      try {
        const links = await discoverLinks(entryUrl);
        allLinks = allLinks.concat(links);
        sectionResults.push(`${name}: ${links.length} pages found`);
      } catch (e) {
        sectionResults.push(`${name}: Error - ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Deduplicate
    const seen = new Set<string>();
    allLinks = allLinks.filter((l) => {
      if (seen.has(l.href)) return false;
      seen.add(l.href);
      return true;
    });

    // Save index
    const existingIndex = (await readIndex()) || [];
    const existingHrefs = new Set(existingIndex.map((l) => l.href));
    const merged = [...existingIndex, ...allLinks.filter((l) => !existingHrefs.has(l.href))];
    await writeIndex(merged);

    return {
      content: [{
        type: "text" as const,
        text: `Discovered ${allLinks.length} unique pages (${merged.length} total in index).\n\n${sectionResults.join("\n")}\n\nRun with fetchAll=true to download and cache all pages as markdown.`,
      }],
    };
  }
);

server.tool(
  "fetch-page",
  "Fetch a specific Samsung docs page by URL path and return its content as markdown. The result is cached for future local searches.",
  { url: z.string().describe("URL path (e.g. '/smarttv/develop/guides/fundamentals/multitasking.html') or full URL") },
  async ({ url }) => {
    // Check cache first
    const cached = await readCached(url);
    if (cached) {
      return {
        content: [{ type: "text" as const, text: `(from cache)\n\n${cached}` }],
      };
    }

    try {
      const page = await fetchPage(url);
      const content = `# ${page.title}\n\nSource: ${page.url}\n\n${page.markdown}`;
      await writeCache(url, content);
      return {
        content: [{ type: "text" as const, text: content }],
      };
    } catch (e) {
      return {
        content: [{ type: "text" as const, text: `Error fetching ${url}: ${e instanceof Error ? e.message : String(e)}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "clear-cache",
  "Clear all cached Samsung docs pages and the index. Use this to force re-fetching of all pages.",
  {},
  async () => {
    const count = await clearCache();
    return {
      content: [{ type: "text" as const, text: `Cleared ${count} cached pages and index.` }],
    };
  }
);

server.tool(
  "cache-status",
  "Show the current cache status: number of cached pages, whether index exists, and cache directory location.",
  {},
  async () => {
    const stats = await cacheStats();
    return {
      content: [{
        type: "text" as const,
        text: `Cache directory: ${stats.cacheDir}\nIndex exists: ${stats.indexExists}\nCached pages: ${stats.pageCount}`,
      }],
    };
  }
);

let activeTransport: WebStandardStreamableHTTPServerTransport | null = null;

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/mcp") {
      const sessionId = req.headers.get("mcp-session-id");

      if (sessionId && activeTransport) {
        return activeTransport.handleRequest(req);
      }

      if (activeTransport) {
        await server.close();
        activeTransport = null;
      }

      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
      });

      activeTransport = transport;
      await server.connect(transport);
      return transport.handleRequest(req);
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json({ status: "ok", name: "samsung-docs-mcp", version: "0.1.0" });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Samsung Docs MCP server running on http://localhost:${PORT}/mcp`);
