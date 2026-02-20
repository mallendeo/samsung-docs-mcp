import { discoverLinks, fetchPage, ENTRY_POINTS } from "./scraper.js";
import { writeCache, readDb, writeDb } from "./cache.js";

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

type Logger = (...args: unknown[]) => void;

export async function populate(opts: { concurrency?: number; section?: string; ttlMs?: number; log?: Logger } = {}) {
  const concurrency = opts.concurrency ?? 5;
  const section = opts.section ?? "all";
  const ttlMs = opts.ttlMs ?? WEEK_MS;
  const log = opts.log ?? console.log;
  const now = Date.now();

  const entries =
    section === "all"
      ? Object.entries(ENTRY_POINTS)
      : [[section, ENTRY_POINTS[section as keyof typeof ENTRY_POINTS]]];

  let allLinks: { href: string; title: string }[] = [];

  for (const [name, entryUrl] of entries) {
    try {
      const links = await discoverLinks(entryUrl);
      allLinks = allLinks.concat(links);
      log(`[discover] ${name}: ${links.length} pages`);
    } catch (e) {
      log(`[discover] ${name}: error — ${e instanceof Error ? e.message : e}`);
    }
  }

  const seen = new Set<string>();
  allLinks = allLinks.filter((l) => {
    if (seen.has(l.href)) return false;
    seen.add(l.href);
    return true;
  });

  const db = await readDb();
  for (const link of allLinks) {
    if (!db.pages[link.href]) {
      db.pages[link.href] = { title: link.title, fetchedAt: null };
    }
  }
  log(`[db] ${Object.keys(db.pages).length} total pages tracked`);

  let fetched = 0;
  let skipped = 0;
  let errors = 0;
  const total = allLinks.length;

  async function fetchAndCache(link: { href: string; title: string }) {
    try {
      const entry = db.pages[link.href];
      if (entry?.fetchedAt && now - entry.fetchedAt < ttlMs) {
        skipped++;
        return;
      }
      const page = await fetchPage(link.href);
      await writeCache(link.href, `# ${page.title}\n\nSource: ${page.url}\n\n${page.markdown}`);
      db.pages[link.href] = { title: link.title, fetchedAt: Date.now() };
      fetched++;
      const done = fetched + skipped + errors;
      if (done % 10 === 0 || done === total) {
        log(`[fetch] ${done}/${total} (${fetched} new, ${skipped} fresh, ${errors} errors)`);
      }
    } catch (e) {
      errors++;
      log(`[error] ${link.href}: ${e instanceof Error ? e.message : e}`);
    }
  }

  for (let i = 0; i < allLinks.length; i += concurrency) {
    const batch = allLinks.slice(i, i + concurrency);
    await Promise.all(batch.map(fetchAndCache));
    await writeDb(db);
  }

  db.populatedAt = Date.now();
  await writeDb(db);
  log(`\nDone. ${fetched} new, ${skipped} fresh, ${errors} errors (${total} total)`);
}
