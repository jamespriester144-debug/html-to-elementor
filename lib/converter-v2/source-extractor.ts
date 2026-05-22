import crypto from "node:crypto";

import * as cheerio from "cheerio";
import JSZip from "jszip";

import { extractLovableProjectHtml } from "@/lib/lovable";
import { uploadConversionAsset } from "@/lib/storage";

import type { ExtractedSource } from "@/lib/converter-v2/types";

function getMimeType(path: string) {
  const lowerPath = path.toLowerCase();

  if (lowerPath.endsWith(".png")) return "image/png";
  if (lowerPath.endsWith(".jpg") || lowerPath.endsWith(".jpeg")) return "image/jpeg";
  if (lowerPath.endsWith(".webp")) return "image/webp";
  if (lowerPath.endsWith(".svg")) return "image/svg+xml";
  if (lowerPath.endsWith(".gif")) return "image/gif";
  if (lowerPath.endsWith(".avif")) return "image/avif";
  if (lowerPath.endsWith(".css")) return "text/css; charset=utf-8";
  if (lowerPath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (lowerPath.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (lowerPath.endsWith(".woff2")) return "font/woff2";
  if (lowerPath.endsWith(".woff")) return "font/woff";
  if (lowerPath.endsWith(".ttf")) return "font/ttf";
  return "application/octet-stream";
}

function cleanAssetUrl(value: string) {
  return value.split("#")[0].split("?")[0].trim();
}

function dirname(path: string) {
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index === -1 ? "" : normalized.slice(0, index);
}

function resolvePath(baseDir: string, source: string) {
  const cleanSource = cleanAssetUrl(source).replace(/^\/+/, "");
  const parts = `${baseDir}/${cleanSource}`
    .split("/")
    .filter(Boolean)
    .reduce<string[]>((acc, part) => {
      if (part === ".") return acc;
      if (part === "..") acc.pop();
      else acc.push(part);
      return acc;
    }, []);

  return parts.join("/");
}

function findZipAsset(zip: JSZip, htmlEntryName: string, source: string) {
  const cleanSource = cleanAssetUrl(source);
  const baseDir = dirname(htmlEntryName);
  const normalizedSource = cleanSource.replace(/^\/+/, "");
  const candidates = [
    resolvePath(baseDir, cleanSource),
    normalizedSource,
    `${baseDir}/${normalizedSource}`.replace(/^\/+/, "")
  ];
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);

  return (
    candidates
      .map((candidate) =>
        entries.find((entry) => entry.name.replace(/\\/g, "/") === candidate)
      )
      .find(Boolean) ??
    entries.find((entry) =>
      entry.name.replace(/\\/g, "/").endsWith(`/${normalizedSource}`)
    )
  );
}

function extractGoogleFontLinks(sourceText: string) {
  return [...sourceText.matchAll(/href:\s*"([^"]+)"/g)]
    .map((match) => match[1])
    .filter((href) => href.startsWith("https://fonts.googleapis.com"));
}

function ensureHeadTag($: cheerio.CheerioAPI) {
  if (!$("html").length) {
    $.root().append("<html><head></head><body></body></html>");
  }

  if (!$("head").length) {
    $("html").prepend("<head></head>");
  }
}

function injectLovableHeadLinks(html: string, sourceText: string) {
  const $ = cheerio.load(html);
  ensureHeadTag($);
  const head = $("head");
  const fontLinks = extractGoogleFontLinks(sourceText);

  if (fontLinks.length > 0) {
    if (!head.find('link[href="https://fonts.googleapis.com"]').length) {
      head.prepend('<link rel="preconnect" href="https://fonts.googleapis.com" />');
    }
    if (!head.find('link[href="https://fonts.gstatic.com"]').length) {
      head.prepend('<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />');
    }
  }

  for (const href of fontLinks.reverse()) {
    if (!head.find(`link[href="${href}"]`).length) {
      head.prepend(`<link rel="stylesheet" href="${href}" />`);
    }
  }

  return $.html();
}

async function externalizeHtmlArchiveAssets(
  html: string,
  zip: JSZip,
  htmlEntryName: string,
  conversionKey: string
) {
  const $ = cheerio.load(html);
  const replacements = new Map<string, string>();

  async function resolveAsset(source: string) {
    if (!source || /^([a-z]+:|#|\/\/)/i.test(source)) {
      return source;
    }

    if (replacements.has(source)) {
      return replacements.get(source) ?? source;
    }

    const entry = findZipAsset(zip, htmlEntryName, source);

    if (!entry) {
      return source;
    }

    const publicUrl = await uploadConversionAsset({
      conversionKey,
      sourcePath: cleanAssetUrl(source),
      contentType: getMimeType(entry.name),
      body: await entry.async("arraybuffer")
    });
    replacements.set(source, publicUrl);
    return publicUrl;
  }

  for (const element of $("img[src], img[data-src], img[data-lazy-src], img[data-original], source[src], video[poster], link[href], script[src]").toArray()) {
    const node = $(element);
    const attribute =
      node.attr("src") !== undefined
        ? "src"
        : node.attr("data-src") !== undefined
          ? "data-src"
          : node.attr("data-lazy-src") !== undefined
            ? "data-lazy-src"
            : node.attr("data-original") !== undefined
              ? "data-original"
              : node.attr("poster") !== undefined
                ? "poster"
                : "href";
    const value = node.attr(attribute);

    if (!value) continue;

    const resolved = await resolveAsset(value);
    node.attr(attribute, resolved);

    if (["data-src", "data-lazy-src", "data-original"].includes(attribute)) {
      node.attr("src", resolved);
    }
  }

  for (const element of $("[srcset], [data-srcset]").toArray()) {
    const node = $(element);
    const srcset = node.attr("srcset") || node.attr("data-srcset");

    if (!srcset) continue;

    const resolved = await Promise.all(
      srcset.split(",").map(async (item) => {
        const [source, ...descriptor] = item.trim().split(/\s+/);
        const publicUrl = await resolveAsset(source);
        return [publicUrl, ...descriptor].join(" ");
      })
    );

    node.attr("srcset", resolved.join(", "));
    node.removeAttr("data-srcset");
  }

  for (const element of $("[style]").toArray()) {
    const node = $(element);
    let style = node.attr("style") ?? "";

    for (const source of [...style.matchAll(/url\((['"]?)(.*?)\1\)/g)].map((match) => match[2])) {
      style = style.replace(source, await resolveAsset(source));
    }

    node.attr("style", style);
  }

  for (const styleElement of $("style").toArray()) {
    const node = $(styleElement);
    let css = node.html() ?? "";

    for (const source of [...css.matchAll(/url\((['"]?)(.*?)\1\)/g)].map((match) => match[2])) {
      css = css.replace(source, await resolveAsset(source));
    }

    node.text(css);
  }

  return $.html();
}

export async function extractSourceFromZip(zip: JSZip): Promise<ExtractedSource> {
  const htmlFiles = Object.values(zip.files).filter((entry) => {
    const name = entry.name.toLowerCase();
    return !entry.dir && name.endsWith(".html") && !name.includes("__macosx/");
  });

  const selectedHtml =
    htmlFiles.find((entry) => entry.name.toLowerCase().endsWith("index.html")) ??
    htmlFiles[0];

  if (selectedHtml) {
    return {
      html: await externalizeHtmlArchiveAssets(
        await selectedHtml.async("text"),
        zip,
        selectedHtml.name,
        crypto.randomUUID()
      ),
      sourceKind: "static-html-archive"
    };
  }

  const routeEntry =
    zip.file(/src\/routes\/index\.(tsx|jsx)$/)[0] ??
    zip.file(/src\/pages\/index\.(tsx|jsx)$/)[0] ??
    zip.file(/src\/App\.(tsx|jsx)$/)[0];

  if (!routeEntry) {
    throw new Error("O arquivo .zip nao contem nenhum HTML exportado nem uma entrada Lovable reconhecivel.");
  }

  const renderedHtml = await extractLovableProjectHtml(zip);

  if (!renderedHtml) {
    throw new Error("Nao foi possivel renderizar o projeto Lovable em HTML a partir do ZIP enviado.");
  }

  return {
    html: injectLovableHeadLinks(renderedHtml, await routeEntry.async("text")),
    sourceKind: "lovable-react-source"
  };
}

export async function extractSourceFromUpload(file: File): Promise<ExtractedSource> {
  const fileName = file.name.toLowerCase();

  if (fileName.endsWith(".zip")) {
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    return extractSourceFromZip(zip);
  }

  return {
    html: await file.text(),
    sourceKind: "raw-html"
  };
}
