import { join } from "path";
import { homedir } from "os";
import { addToSearchIndex, resetSearchIndex } from "./search.js";

export const CACHE_DIR = process.env.CACHE_DIR || join(homedir(), ".cache", "mcp", "samsung-docs");
const DB_PATH = join(CACHE_DIR, "db.json");

export interface PageEntry {
  title: string;
  fetchedAt: number | null; // epoch ms, null = discovered but not fetched
}

export interface DocsDb {
  populatedAt: number | null; // epoch ms of last successful full populate
  pages: Record<string, PageEntry>; // keyed by href
}

async function ensureCacheDir(subdir?: string) {
  const dir = subdir ? join(CACHE_DIR, subdir) : CACHE_DIR;
  await Bun.write(join(dir, ".keep"), ""); // Bun.write creates parent dirs
  return dir;
}

function urlToPath(url: string): string {
  const parsed = new URL(url, "https://developer.samsung.com");
  let result = parsed.pathname.replace(/^\//, "").replace(/\//g, "__").replace(/\.html?$/, "");

  // Include sorted query params so different variants get separate cache entries
  if (parsed.search) {
    parsed.searchParams.sort();
    result += `_q_${parsed.searchParams.toString()}`;
  }

  return result + ".md";
}

// --- db ---

export async function readDb(): Promise<DocsDb> {
  const file = Bun.file(DB_PATH);
  if (await file.exists()) {
    return file.json();
  }
  return { populatedAt: null, pages: {} };
}

export async function writeDb(db: DocsDb): Promise<void> {
  await ensureCacheDir();
  await Bun.write(DB_PATH, JSON.stringify(db));
}

// --- page cache ---

export async function readCached(url: string): Promise<string | null> {
  const filePath = join(CACHE_DIR, "pages", urlToPath(url));
  const file = Bun.file(filePath);
  if (await file.exists()) {
    return file.text();
  }
  return null;
}

export async function writeCache(url: string, content: string): Promise<string> {
  await ensureCacheDir("pages");
  const fileName = urlToPath(url);
  const filePath = join(CACHE_DIR, "pages", fileName);
  await Bun.write(filePath, content);
  await addToSearchIndex(fileName, content);
  return filePath;
}

// --- maintenance ---

export async function clearCache(): Promise<number> {
  const pagesDir = join(CACHE_DIR, "pages");
  const glob = new Bun.Glob("*.md");
  let count = 0;
  for await (const fileName of glob.scan({ cwd: pagesDir, absolute: false })) {
    await Bun.file(join(pagesDir, fileName)).delete();
    count++;
  }
  const dbFile = Bun.file(DB_PATH);
  if (await dbFile.exists()) {
    await dbFile.delete();
  }
  resetSearchIndex();
  return count;
}

export async function cacheStats(): Promise<{
  pageCount: number;
  populatedAt: number | null;
  cacheDir: string;
}> {
  const db = await readDb();
  const fetched = Object.values(db.pages).filter((p) => p.fetchedAt !== null).length;
  return { pageCount: fetched, populatedAt: db.populatedAt, cacheDir: CACHE_DIR };
}
