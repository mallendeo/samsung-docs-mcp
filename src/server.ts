import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { discoverLinks, fetchPage, ENTRY_POINTS } from "./scraper.js";
import { readCached, writeCache, readDb, writeDb, clearCache, cacheStats } from "./cache.js";
import { search, matchesGlob } from "./search.js";
import { populate, WEEK_MS } from "./populate.js";
import pkg from "../package.json";

const { version } = pkg;

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

function matchesVersionFilter(ver: string, filter: string): boolean {
  return filter.split(",").every((part) => {
    const m = part.trim().match(/^(>=|<=|!=|>|<|=)(.+)$/);
    if (!m) return false;
    const cmp = compareVersions(ver, m[2]);
    switch (m[1]) {
      case ">=": return cmp >= 0;
      case "<=": return cmp <= 0;
      case ">":  return cmp > 0;
      case "<":  return cmp < 0;
      case "=":  return cmp === 0;
      case "!=": return cmp !== 0;
      default:   return false;
    }
  });
}

function extractApiSince(content: string): string | null {
  const m = content.match(/\nSince\s*:\s*([\d.]+)/);
  return m?.[1] ?? null;
}

function extractMethods(content: string): { name: string; since: string; signature: string }[] {
  const apiSince = extractApiSince(content) ?? "unknown";
  const methods: { name: string; since: string; signature: string }[] = [];
  const sections = content.split(/(?=^#### )/m);

  for (const section of sections) {
    const header = section.match(/^#### (\w+)/);
    if (!header) continue;

    const sinceMatch = section.match(/Since\s*:\s*([\d.]+)/);
    const since = sinceMatch?.[1] ?? apiSince;

    const sigMatch = section.match(/```\n([^\n]*?\(.*?\)[^\n]*)\n```/);
    const signature = sigMatch?.[1]?.trim() ?? header[1] + "()";

    methods.push({ name: header[1], since, signature });
  }

  return methods;
}

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
  version,
});

server.tool(
  "search",
  "Search Samsung TV and Signage documentation using full-text search (BM25+ scoring with fuzzy matching). Searches local cache first, falls back to online fetching if no results found.",
  {
    query: z.string().describe("Search query (e.g. 'AVPlay API', 'signage remote control', 'web engine specifications')"),
    maxResults: z.number().min(1).max(25).default(10).describe("Maximum number of results to return"),
    files: z.array(z.string()).optional().describe("Glob patterns to filter which pages to search (e.g. ['*product-api*', '*signage*'])"),
  },
  async ({ query, maxResults, files }) => {
    const localResults = await search(query, maxResults, files).catch(() => []);

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
      const lines: string[] = [];
      await populate({ concurrency, section, log: (...args) => lines.push(args.map(String).join(" ")) });
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
  "Clear all cached pages and the db. Use to force a full re-fetch.",
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
  "Show cache stats: directory, populate timestamp, number of cached pages.",
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

server.tool(
  "list-pages",
  "List all known documentation pages. Supports glob filtering on URL paths.",
  {
    files: z.array(z.string()).optional().describe("Glob patterns to filter pages (e.g. ['*product-api*']). Returns all pages if omitted."),
  },
  async ({ files }) => {
    const db = await readDb();
    let entries = Object.entries(db.pages);

    if (files?.length) {
      entries = entries.filter(([href]) => files.some((p) => matchesGlob(href, p)));
    }

    const lines = entries.map(([href, e]) => {
      const status = e.fetchedAt ? "cached" : "pending";
      return `${status} | ${e.title} | ${href}`;
    });

    return {
      content: [{
        type: "text" as const,
        text: `${entries.length} page(s):\n\n${lines.join("\n")}`,
      }],
    };
  }
);

server.tool(
  "list-apis",
  "Extract and list all Samsung Product API privileges from cached docs, grouped by privilege level. Scans all product API reference pages (TV + Signage) and returns API name, privilege level, and privilege URL.",
  {
    files: z.array(z.string()).optional().describe("Glob patterns to filter pages (default: ['*samsung-product-api-references/*-api*'])"),
    since: z.string().optional().describe("Version filter using operators: '>=4', '<6.5', '>=2,<=5'. Filters APIs by their top-level Since version."),
  },
  async ({ files, since }) => {
    const db = await readDb();
    const patterns = files?.length ? files : ["*samsung-product-api-references/*-api*"];
    const entries = Object.entries(db.pages).filter(([href]) =>
      patterns.some((p) => matchesGlob(href, p))
    );

    interface ApiInfo {
      api: string;
      level: string;
      privilege: string;
      device: string | null;
    }

    const apis: ApiInfo[] = [];

    for (const [href, entry] of entries) {
      const content = await readCached(href);
      if (!content) continue;

      if (since) {
        const apiVer = extractApiSince(content);
        if (!apiVer || !matchesVersionFilter(apiVer, since)) continue;
      }

      const device = href.includes("device=signage") ? "signage" : href.includes("device=htv") ? "htv" : null;
      const apiName = entry.title;

      // Extract privilege blocks: "Privilege Level : X" followed by "Privilege : URL"
      const levelPattern = /Privilege\s+Level\s*:\s*(Public|Partner|Platform)/gi;
      const privPattern = /Privilege\s*:\s*(http\S+)/gi;

      const levels = [...content.matchAll(levelPattern)].map((m) => m[1]);
      const privs = [...content.matchAll(privPattern)].map((m) => m[1]);

      if (levels.length === 0 && privs.length === 0) {
        apis.push({ api: apiName, level: "none", privilege: "-", device });
        continue;
      }

      // Deduplicate level+privilege pairs
      const seen = new Set<string>();
      const count = Math.max(levels.length, privs.length);
      for (let i = 0; i < count; i++) {
        const level = (levels[i] || levels[0] || "unknown").toLowerCase();
        const priv = privs[i] || privs[0] || "unknown";
        const key = `${level}|${priv}`;
        if (seen.has(key)) continue;
        seen.add(key);
        apis.push({ api: apiName, level, privilege: priv, device });
      }
    }

    // Group by level
    const grouped: Record<string, ApiInfo[]> = {};
    for (const api of apis) {
      const key = api.level;
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(api);
    }

    const sections: string[] = [];
    for (const level of ["partner", "public", "platform", "none"]) {
      const items = grouped[level];
      if (!items) continue;

      const label = level === "none" ? "No privileges required" : level.charAt(0).toUpperCase() + level.slice(1);
      const lines = items.map((a) => {
        const suffix = a.device ? ` (${a.device})` : "";
        return a.level === "none"
          ? `- ${a.api}${suffix}`
          : `- ${a.api}${suffix} — ${a.privilege}`;
      });
      sections.push(`### ${label}\n${lines.join("\n")}`);
    }

    return {
      content: [{
        type: "text" as const,
        text: `${apis.length} API privilege entries from ${entries.length} pages:\n\n${sections.join("\n\n")}`,
      }],
    };
  }
);

server.tool(
  "api-overview",
  "Return a compact overview of all Samsung Product APIs by extracting the WebIDL definitions from each cached API reference page. Groups by API name with privilege info. When 'since' is provided, shows per-method version info instead of WebIDL.",
  {
    files: z.array(z.string()).optional().describe("Glob patterns to filter pages (default: ['*samsung-product-api-references/*-api*'])"),
    device: z.enum(["all", "tv", "signage"]).default("all").describe("Filter by device type"),
    since: z.string().optional().describe("Version filter using operators: '>=4', '<6.5', '>=2,<=5'. Filters individual methods by their Since version."),
  },
  async ({ files, device, since }) => {
    const db = await readDb();
    const patterns = files?.length ? files : ["*samsung-product-api-references/*-api*"];
    let entries = Object.entries(db.pages).filter(([href]) =>
      patterns.some((p) => matchesGlob(href, p))
    );

    if (device === "signage") {
      entries = entries.filter(([href]) => href.includes("device=signage"));
    } else if (device === "tv") {
      entries = entries.filter(([href]) => !href.includes("device="));
    }

    const sections: string[] = [];

    for (const [href, entry] of entries) {
      const content = await readCached(href);
      if (!content) continue;

      const suffix = href.includes("device=signage") ? " (signage)" : href.includes("device=htv") ? " (htv)" : "";
      const apiSince = extractApiSince(content) ?? "unknown";

      const levelMatch = content.match(/Privilege\s+Level\s*:\s*(Public|Partner|Platform)/i);
      const privMatch = content.match(/Privilege\s*:\s*(http\S+)/);
      const privLine = levelMatch
        ? `${levelMatch[1]}${privMatch ? ` — ${privMatch[1]}` : ""}`
        : "none";

      if (since) {
        const methods = extractMethods(content);
        const filtered = methods.filter((m) => matchesVersionFilter(m.since, since));
        if (filtered.length === 0) continue;
        const lines = filtered.map((m) => `- ${m.signature} — since ${m.since}`);
        sections.push(`## ${entry.title}${suffix} (since ${apiSince})\nPrivilege: ${privLine}\n${lines.join("\n")}`);
      } else {
        const webidlMatch = content.match(/## (?:\d+\.\s*)?Full WebIDL\s*\n+```[\s\S]*?\n([\s\S]*?)\n```/);
        if (webidlMatch) {
          sections.push(`## ${entry.title}${suffix}\nPrivilege: ${privLine}\n\`\`\`webidl\n${webidlMatch[1].trim()}\n\`\`\``);
        } else {
          const summaryMatch = content.match(/## Summary of Interfaces and Methods\s*\n([\s\S]*?)(?=\n## )/);
          if (summaryMatch) {
            sections.push(`## ${entry.title}${suffix}\nPrivilege: ${privLine}\n${summaryMatch[1].trim()}`);
          } else {
            sections.push(`## ${entry.title}${suffix}\nPrivilege: ${privLine}\n(no WebIDL or summary found)`);
          }
        }
      }
    }

    return {
      content: [{
        type: "text" as const,
        text: `${entries.length} API(s):\n\n${sections.join("\n\n---\n\n")}`,
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
      return Response.json({ status: "ok", name: "samsung-docs-mcp", version });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Samsung Docs MCP server running on http://localhost:${PORT}/mcp`);
