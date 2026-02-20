import { join } from "path";
import { homedir } from "os";
import { addToSearchIndex, resetSearchIndex } from "./search.js";

const CACHE_DIR = process.env.CACHE_DIR || join(homedir(), ".cache", "mcp", "samsung-docs");

async function ensureCacheDir(subdir?: string) {
  const dir = subdir ? join(CACHE_DIR, subdir) : CACHE_DIR;
  await Bun.write(join(dir, ".keep"), ""); // Bun.write creates parent dirs
  return dir;
}

function urlToPath(url: string): string {
  // Remove protocol and domain
  let path = url.replace(/^https?:\/\/[^/]+/, "");
  // Remove query params and hash
  path = path.split("?")[0].split("#")[0];
  // Remove leading slash, replace remaining slashes with __
  path = path.replace(/^\//, "").replace(/\//g, "__");
  // Ensure .md extension
  if (!path.endsWith(".md")) {
    path = path.replace(/\.html?$/, "") + ".md";
  }
  return path;
}

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

export async function readIndex(): Promise<{ href: string; title: string }[] | null> {
  const filePath = join(CACHE_DIR, "index.json");
  const file = Bun.file(filePath);
  if (await file.exists()) {
    return file.json();
  }
  return null;
}

export async function writeIndex(index: { href: string; title: string }[]): Promise<void> {
  await ensureCacheDir();
  await Bun.write(join(CACHE_DIR, "index.json"), JSON.stringify(index, null, 2));
}

export async function listCachedPages(): Promise<string[]> {
  const pagesDir = join(CACHE_DIR, "pages");
  const glob = new Bun.Glob("*.md");
  const files: string[] = [];
  for await (const file of glob.scan({ cwd: pagesDir, absolute: false })) {
    files.push(file);
  }
  return files;
}

export async function clearCache(): Promise<number> {
  const pagesDir = join(CACHE_DIR, "pages");
  const glob = new Bun.Glob("*.md");
  let count = 0;
  for await (const fileName of glob.scan({ cwd: pagesDir, absolute: false })) {
    await Bun.file(join(pagesDir, fileName)).delete();
    count++;
  }
  const indexFile = Bun.file(join(CACHE_DIR, "index.json"));
  if (await indexFile.exists()) {
    await indexFile.delete();
  }
  resetSearchIndex();
  return count;
}

export async function cacheStats(): Promise<{ pageCount: number; indexExists: boolean; cacheDir: string }> {
  const pages = await listCachedPages().catch(() => []);
  const indexFile = Bun.file(join(CACHE_DIR, "index.json"));
  const indexExists = await indexFile.exists();
  return { pageCount: pages.length, indexExists, cacheDir: CACHE_DIR };
}
