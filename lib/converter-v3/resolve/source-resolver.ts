import crypto from "node:crypto";

import * as cheerio from "cheerio";

import { extractSourceFromUpload, extractSourceFromZip } from "@/lib/converter-v2/source-extractor";
import type {
  ResolvedAsset,
  ResolvedAssetKind,
  ResolvedSource,
  SourceKind
} from "@/lib/converter-v3/contracts/source";
import { detectSourceKindFromZipSnapshot } from "@/lib/converter-v3/resolve/source-detector";
import { loadZipSnapshotFromBuffer } from "@/lib/converter-v3/resolve/zip-project-reader";

function getAssetKind(source: string): ResolvedAssetKind {
  const lowerSource = source.toLowerCase();

  if (/\.(png|jpe?g|webp|gif|svg|avif)(?:$|[?#])/.test(lowerSource) || lowerSource.startsWith("data:image/")) {
    return "image";
  }
  if (/\.(woff2?|ttf|otf)(?:$|[?#])/.test(lowerSource)) {
    return "font";
  }
  if (/\.(css)(?:$|[?#])/.test(lowerSource)) {
    return "stylesheet";
  }
  if (/\.(js|mjs)(?:$|[?#])/.test(lowerSource)) {
    return "script";
  }

  return "other";
}

function getAssetLocation(source: string): ResolvedAsset["location"] {
  if (source.startsWith("data:")) return "embedded";
  if (/^https?:\/\//i.test(source) || source.startsWith("//")) return "external";
  return "local";
}

function collectAssets(html: string): ResolvedAsset[] {
  const $ = cheerio.load(html);
  const sources = new Set<string>();

  $("img[src], source[srcset], script[src], link[href]").each((_, element) => {
    const node = $(element);
    const value =
      node.attr("src") ??
      node.attr("href") ??
      node
        .attr("srcset")
        ?.split(",")
        .map((item) => item.trim().split(/\s+/)[0])
        .find(Boolean);

    if (value) {
      sources.add(value);
    }
  });

  $("[style], style").each((_, element) => {
    const value = $(element).attr("style") ?? $(element).html() ?? "";

    for (const match of value.matchAll(/url\((['"]?)(.*?)\1\)/g)) {
      if (match[2]) {
        sources.add(match[2].trim());
      }
    }
  });

  return [...sources].map((source) => ({
    kind: getAssetKind(source),
    source,
    location: getAssetLocation(source)
  }));
}

function getTitle(html: string): string {
  const $ = cheerio.load(html);
  return $("title").first().text().trim() || "Untitled Capture";
}

export function resolveSourceFromHtml(html: string): ResolvedSource {
  return {
    id: crypto.randomUUID(),
    sourceKind: "raw-html",
    title: getTitle(html),
    html,
    assets: collectAssets(html),
    entryFile: null,
    routeFile: null,
    archiveFileCount: 0,
    notes: ["Entrada resolvida a partir de HTML bruto."]
  };
}

export async function resolveSourceFromUpload(file: File): Promise<ResolvedSource> {
  const resolved = await extractSourceFromUpload(file);
  let sourceKind: SourceKind = resolved.sourceKind;
  let archiveFileCount = 0;
  let entryFile: string | null = null;
  let routeFile: string | null = null;
  const notes: string[] = [];

  if (file.name.toLowerCase().endsWith(".zip")) {
    const snapshot = await loadZipSnapshotFromBuffer(await file.arrayBuffer());
    sourceKind = detectSourceKindFromZipSnapshot(snapshot);
    archiveFileCount = snapshot.fileNames.length;
    entryFile = snapshot.htmlEntries.find((name) => /index\.html$/i.test(name)) ?? snapshot.htmlEntries[0] ?? null;
    routeFile = snapshot.routeEntries[0] ?? null;
    notes.push(
      sourceKind === "lovable-react-source"
        ? "ZIP detectado como projeto Lovable/React."
        : "ZIP detectado como arquivo HTML estatico."
    );
  } else {
    notes.push("Entrada detectada como HTML bruto.");
  }

  return sourceKind === "raw-html"
    ? {
        ...resolveSourceFromHtml(resolved.html),
        notes
      }
    : {
        id: crypto.randomUUID(),
        sourceKind,
        title: getTitle(resolved.html),
        html: resolved.html,
        assets: collectAssets(resolved.html),
        entryFile,
        routeFile,
        archiveFileCount,
        notes
      };
}

export async function resolveSourceFromZipBuffer(buffer: ArrayBuffer): Promise<ResolvedSource> {
  const snapshot = await loadZipSnapshotFromBuffer(buffer);
  const resolved = await extractSourceFromZip(snapshot.zip);

  return {
    id: crypto.randomUUID(),
    sourceKind: detectSourceKindFromZipSnapshot(snapshot),
    title: getTitle(resolved.html),
    html: resolved.html,
    assets: collectAssets(resolved.html),
    entryFile: snapshot.htmlEntries.find((name) => /index\.html$/i.test(name)) ?? snapshot.htmlEntries[0] ?? null,
    routeFile: snapshot.routeEntries[0] ?? null,
    archiveFileCount: snapshot.fileNames.length,
    notes: [
      snapshot.htmlEntries.length > 0
        ? "Fonte resolvida a partir de um HTML exportado do ZIP."
        : "Fonte resolvida a partir de um projeto Lovable/React do ZIP."
    ]
  };
}
