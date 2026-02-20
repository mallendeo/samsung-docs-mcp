import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { discoverLinks, fetchPage, ENTRY_POINTS } from "./scraper.js";
import { readCached, writeCache, readDb, writeDb, clearCache, cacheStats } from "./cache.js";
import { search } from "./search.js";
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
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const server = new McpServer({
  name: "samsung-docs",
  version: "1.1.0",
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

    // Fallback: match against db titles, fetch on demand
    const db = await readDb();
    if (Object.keys(db.pages).length === 0) {
      return {
        content: [{ type: "text" as const, text: `No results found for "${query}". Cache is still being built — try again shortly.` }],
      };
    }

    const queryTerms = query.toLowerCase().split(/\s+/);
    const matchingUrls = Object.entries(db.pages)
      .filter(([, entry]) => queryTerms.some((t) => entry.title.toLowerCase().includes(t)))
      .map(([href, entry]) => ({ href, title: entry.title }));

    if (matchingUrls.length === 0) {
      return {
        content: [{ type: "text" as const, text: `No results found for "${query}". Try a different query or wait for the cache to finish building.` }],
      };
    }

    const toFetch = matchingUrls.slice(0, 3);
    const fetched: string[] = [];

    for (const { href, title } of toFetch) {
      try {
        const page = await fetchPage(href);
        await writeCache(href, `# ${page.title}\n\nSource: ${page.url}\n\n${page.markdown}`);
        db.pages[href] = { title, fetchedAt: Date.now() };
        fetched.push(`## ${title}\nURL: ${href}\n\n${page.markdown.slice(0, 500)}...`);
      } catch (e) {
        fetched.push(`## ${title}\nURL: ${href}\nError: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    await writeDb(db);

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

    const db = await readDb();
    const sectionResults: string[] = [];
    let discovered = 0;

    for (const [name, entryUrl] of entries) {
      try {
        const links = await discoverLinks(entryUrl);
        for (const link of links) {
          if (!db.pages[link.href]) {
            db.pages[link.href] = { title: link.title, fetchedAt: null };
            discovered++;
          }
        }
        sectionResults.push(`${name}: ${links.length} pages found`);
      } catch (e) {
        sectionResults.push(`${name}: Error - ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    await writeDb(db);
    const total = Object.keys(db.pages).length;

    return {
      content: [{
        type: "text" as const,
        text: `Discovered ${discovered} new pages (${total} total in db).\n\n${sectionResults.join("\n")}\n\nRun with fetchAll=true to download and cache all pages as markdown.`,
      }],
    };
  }
);

server.tool(
  "fetch-page",
  "Fetch a specific Samsung docs page by URL path and return its content as markdown. The result is cached for future local searches.",
  { url: z.string().describe("URL path (e.g. '/smarttv/develop/guides/fundamentals/multitasking.html') or full URL") },
  async ({ url }) => {
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

      const db = await readDb();
      db.pages[url] = { title: page.title, fetchedAt: Date.now() };
      await writeDb(db);

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
      content: [{ type: "text" as const, text: `Cleared ${count} cached pages and db.` }],
    };
  }
);

server.tool(
  "cache-status",
  "Show the current cache status: number of cached pages, whether index exists, and cache directory location.",
  {},
  async () => {
    const stats = await cacheStats();
    const populatedLabel = stats.populatedAt
      ? new Date(stats.populatedAt).toISOString()
      : "never";
    return {
      content: [{
        type: "text" as const,
        text: `Cache directory: ${stats.cacheDir}\nPopulated: ${populatedLabel}\nCached pages: ${stats.pageCount}`,
      }],
    };
  }
);

// --- Background populate on first run + weekly refresh ---

(async () => {
  const db = await readDb();
  if (!db.populatedAt) {
    console.log("[startup] First run — populating in background...");
    populate().catch((e) => console.error("[startup] Populate failed:", e));
  }
})();

setInterval(() => {
  console.log("[refresh] Weekly refresh starting...");
  populate().catch((e) => console.error("[refresh] Populate failed:", e));
}, WEEK_MS);

// --- HTTP transport ---

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
      return Response.json({ status: "ok", name: "samsung-docs-mcp", version: "1.1.0" });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Samsung Docs MCP server running on http://localhost:${PORT}/mcp`);
