import MiniSearch from "minisearch";
import { join } from "path";
import { homedir } from "os";

const CACHE_DIR = process.env.CACHE_DIR || join(homedir(), ".cache", "mcp", "samsung-docs");
const PAGES_DIR = join(CACHE_DIR, "pages");

interface SearchDoc {
  id: string;
  url: string;
  title: string;
  body: string;
}

export interface SearchResult {
  url: string;
  title: string;
  score: number;
  terms: string[];
  matches: string[];
}

let index: MiniSearch<SearchDoc> | null = null;
let indexedIds = new Set<string>();

function createIndex(): MiniSearch<SearchDoc> {
  return new MiniSearch<SearchDoc>({
    fields: ["title", "body"],
    storeFields: ["url", "title"],
    searchOptions: {
      boost: { title: 3 },
      fuzzy: 0.2,
      prefix: true,
    },
  });
}

function fileToUrl(fileName: string): string {
  return "/" + fileName.replace(/\.md$/, "").replace(/__/g, "/");
}

function extractTitle(content: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : "Untitled";
}

function extractMatchingLines(content: string, terms: string[], max = 5): string[] {
  const lines = content.split("\n");
  const matches: string[] = [];
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (terms.some((t) => lower.includes(t))) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("Source:")) {
        matches.push(trimmed);
        if (matches.length >= max) break;
      }
    }
  }
  return matches;
}

export async function buildSearchIndex(): Promise<number> {
  index = createIndex();
  indexedIds = new Set();

  const glob = new Bun.Glob("*.md");
  const docs: SearchDoc[] = [];

  for await (const fileName of glob.scan({ cwd: PAGES_DIR, absolute: false })) {
    const content = await Bun.file(join(PAGES_DIR, fileName)).text();
    const url = fileToUrl(fileName);
    const doc: SearchDoc = {
      id: fileName,
      url,
      title: extractTitle(content),
      body: content,
    };
    docs.push(doc);
    indexedIds.add(fileName);
  }

  index.addAll(docs);
  return docs.length;
}

export async function addToSearchIndex(fileName: string, content: string): Promise<void> {
  if (!index) return;
  if (indexedIds.has(fileName)) {
    index.discard(fileName);
  }
  const doc: SearchDoc = {
    id: fileName,
    url: fileToUrl(fileName),
    title: extractTitle(content),
    body: content,
  };
  index.add(doc);
  indexedIds.add(fileName);
}

export function resetSearchIndex(): void {
  index = null;
  indexedIds = new Set();
}

export async function search(query: string, maxResults = 10): Promise<SearchResult[]> {
  if (!index) {
    await buildSearchIndex();
  }

  const results = index!.search(query).slice(0, maxResults);

  const searchResults: SearchResult[] = [];
  for (const result of results) {
    const filePath = join(PAGES_DIR, result.id);
    const file = Bun.file(filePath);
    let matches: string[] = [];
    if (await file.exists()) {
      const content = await file.text();
      matches = extractMatchingLines(content, result.terms);
    }

    searchResults.push({
      url: result.url,
      title: result.title,
      score: result.score,
      terms: result.terms,
      matches,
    });
  }

  return searchResults;
}
