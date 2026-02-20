import { discoverLinks, fetchPage, ENTRY_POINTS } from "./scraper.js";
import { writeCache, readDb, writeDb } from "./cache.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export async function populate(opts: { concurrency?: number; section?: string; ttlMs?: number } = {}) {
  const concurrency = opts.concurrency ?? 5;
  const section = opts.section ?? "all";
  const ttlMs = opts.ttlMs ?? WEEK_MS;
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
      console.log(`[discover] ${name}: ${links.length} pages`);
    } catch (e) {
      console.error(`[discover] ${name}: ${e instanceof Error ? e.message : e}`);
    }
  }

  // Deduplicate
  const seen = new Set<string>();
  allLinks = allLinks.filter((l) => {
    if (seen.has(l.href)) return false;
    seen.add(l.href);
    return true;
  });

  // Load db, register discovered pages
  const db = await readDb();
  for (const link of allLinks) {
    if (!db.pages[link.href]) {
      db.pages[link.href] = { title: link.title, fetchedAt: null };
    }
  }
  console.log(`[db] ${Object.keys(db.pages).length} total pages tracked`);

  // Fetch pages that need refresh
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
        console.log(`[fetch] ${done}/${total} (${fetched} new, ${skipped} fresh, ${errors} errors)`);
      }
    } catch (e) {
      errors++;
      console.error(`[error] ${link.href}: ${e instanceof Error ? e.message : e}`);
    }
  }

  for (let i = 0; i < allLinks.length; i += concurrency) {
    const batch = allLinks.slice(i, i + concurrency);
    await Promise.all(batch.map(fetchAndCache));
    await writeDb(db); // persist progress after each batch
  }

  db.populatedAt = Date.now();
  await writeDb(db);
  console.log(`\nDone. ${fetched} new, ${skipped} fresh, ${errors} errors (${total} total)`);
}
