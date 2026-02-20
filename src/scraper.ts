import { parse, type HTMLElement } from "node-html-parser";

const BASE_URL = "https://developer.samsung.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";

async function fetchHtml(url: string): Promise<HTMLElement> {
  const fullUrl = url.startsWith("http") ? url : `${BASE_URL}${url}`;
  const res = await fetch(fullUrl, {
    headers: { "User-Agent": UA },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText} (${fullUrl})`);
  const html = await res.text();
  return parse(html, {
    blockTextElements: { script: true, noscript: true, style: true },
  });
}

export async function discoverLinks(entryUrl: string): Promise<{ href: string; title: string }[]> {
  const entry = new URL(entryUrl, BASE_URL);
  const inheritParams = new URLSearchParams(entry.search);

  const doc = await fetchHtml(entry.href);
  const links = doc.querySelectorAll(".sdp-lnb-menu a.nav-link");
  const results: { href: string; title: string }[] = [];
  const seen = new Set<string>();

  for (const a of links) {
    const rawHref = a.getAttribute("href");
    const title = a.text.trim();
    if (!rawHref) continue;

    let linkUrl: URL;
    try {
      linkUrl = new URL(rawHref, BASE_URL);
    } catch {
      continue;
    }

    // Skip external links (tizen.org, onlinedocs, etc.)
    if (linkUrl.origin !== entry.origin) continue;

    // Propagate query params from entry URL to discovered links
    for (const [key, value] of inheritParams) {
      if (!linkUrl.searchParams.has(key)) {
        linkUrl.searchParams.set(key, value);
      }
    }

    const href = linkUrl.pathname + linkUrl.search;
    if (seen.has(href)) continue;
    seen.add(href);
    results.push({ href, title });
  }

  return results;
}

function htmlToMarkdown(el: HTMLElement): string {
  // Remove scripts, styles, nav elements
  el.querySelectorAll("script, style, nav, .sdp-lnb, header, footer").forEach((e) => e.remove());

  let md = "";

  function walk(node: HTMLElement) {
    const tag = node.tagName?.toLowerCase();

    if (tag === "h1") md += `\n# ${node.text.trim()}\n\n`;
    else if (tag === "h2") md += `\n## ${node.text.trim()}\n\n`;
    else if (tag === "h3") md += `\n### ${node.text.trim()}\n\n`;
    else if (tag === "h4") md += `\n#### ${node.text.trim()}\n\n`;
    else if (tag === "h5") md += `\n##### ${node.text.trim()}\n\n`;
    else if (tag === "h6") md += `\n###### ${node.text.trim()}\n\n`;
    else if (tag === "p") md += `${node.text.trim()}\n\n`;
    else if (tag === "pre" || tag === "code") {
      const code = node.text.trim();
      if (code) md += `\n\`\`\`\n${code}\n\`\`\`\n\n`;
    } else if (tag === "li") md += `- ${node.text.trim()}\n`;
    else if (tag === "ul" || tag === "ol") {
      for (const child of node.childNodes) {
        if ((child as HTMLElement).tagName) walk(child as HTMLElement);
      }
      md += "\n";
    } else if (tag === "table") {
      const rows = node.querySelectorAll("tr");
      for (let i = 0; i < rows.length; i++) {
        const cells = rows[i].querySelectorAll("th, td");
        const row = cells.map((c) => c.text.trim()).join(" | ");
        md += `| ${row} |\n`;
        if (i === 0) {
          md += `| ${cells.map(() => "---").join(" | ")} |\n`;
        }
      }
      md += "\n";
    } else if (tag === "a") {
      const href = node.getAttribute("href");
      const text = node.text.trim();
      if (href && text) md += `[${text}](${href})`;
      else md += text;
    } else if (tag === "img") {
      const alt = node.getAttribute("alt") || "";
      const src = node.getAttribute("src") || "";
      if (src) md += `![${alt}](${src})\n`;
    } else if (tag === "br") {
      md += "\n";
    } else if (tag === "hr") {
      md += "\n---\n\n";
    } else if (tag === "strong" || tag === "b") {
      md += `**${node.text.trim()}**`;
    } else if (tag === "em" || tag === "i") {
      md += `*${node.text.trim()}*`;
    } else if (tag === "blockquote") {
      md += node.text
        .trim()
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n");
      md += "\n\n";
    } else {
      // Recurse into other elements
      for (const child of node.childNodes) {
        if ((child as HTMLElement).tagName) {
          walk(child as HTMLElement);
        } else {
          const text = child.text?.trim();
          if (text) md += text + " ";
        }
      }
    }
  }

  walk(el);

  // Clean up excessive whitespace
  return md
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

export async function fetchPage(url: string): Promise<{ title: string; markdown: string; url: string }> {
  const fullUrl = url.startsWith("http") ? url : `${BASE_URL}${url}`;
  const doc = await fetchHtml(fullUrl);

  const title = doc.querySelector("title")?.text?.replace(" | Samsung Developer", "").trim() || "Untitled";

  // Main content is in <main> element
  const main = doc.querySelector("main");
  if (!main) {
    // Fallback: try article or the doc content area
    const article = doc.querySelector("article") || doc.querySelector(".sdp-content") || doc.querySelector(".doc-content");
    if (article) {
      return { title, markdown: htmlToMarkdown(article), url: fullUrl };
    }
    return { title, markdown: `No content found for ${fullUrl}`, url: fullUrl };
  }

  const markdown = htmlToMarkdown(main);
  return { title, markdown, url: fullUrl };
}

export const ENTRY_POINTS = {
  "smarttv-develop": "/smarttv/develop/specifications/general-specifications.html",
  "smarttv-api": "/smarttv/develop/api-references/samsung-product-api-references.html",
  "smarttv-signage-api": "/smarttv/develop/api-references/samsung-product-api-references-signage.html?device=signage",
  "smarttv-design": "/smarttv/design/overview.html",
} as const;
