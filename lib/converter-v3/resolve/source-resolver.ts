import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import * as cheerio from "cheerio";

import { analyzeInputPage, toResolvedAssetList } from "@/lib/converter-v3/analyze/input-page-analyzer";
import type { ResolvedSource, SourceKind } from "@/lib/converter-v3/contracts/source";
import { detectSourceKindFromZipSnapshot } from "@/lib/converter-v3/resolve/source-detector";
import { loadZipSnapshotFromBuffer, type ZipProjectSnapshot } from "@/lib/converter-v3/resolve/zip-project-reader";
import { extractLovableProjectHtml } from "@/lib/lovable";

function getTitle(html: string): string {
  const $ = cheerio.load(html);
  return $("title").first().text().trim() || "Untitled Capture";
}

function getDefaultSourceRoot() {
  return path.join(process.cwd(), ".tmp", "converter-v3-sources");
}

function sanitizeRelativePath(value: string) {
  return value
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .split("/")
    .filter(Boolean)
    .reduce<string[]>((parts, part) => {
      if (part === ".") {
        return parts;
      }

      if (part === "..") {
        parts.pop();
        return parts;
      }

      parts.push(part);
      return parts;
    }, [])
    .join("/");
}

async function writeZipSnapshotToDirectory(snapshot: ZipProjectSnapshot, targetDir: string) {
  await mkdir(targetDir, { recursive: true });

  await Promise.all(
    Object.values(snapshot.zip.files)
      .filter((entry) => !entry.dir)
      .map(async (entry) => {
        const normalizedName = sanitizeRelativePath(entry.name);
        const targetPath = path.join(targetDir, normalizedName);
        await mkdir(path.dirname(targetPath), { recursive: true });
        await writeFile(targetPath, Buffer.from(await entry.async("arraybuffer")));
      })
  );
}

function pickHtmlEntry(snapshot: ZipProjectSnapshot) {
  const normalizedEntries = [...snapshot.htmlEntries].sort((left, right) => {
    const leftIndexPriority = /(^|\/)index\.html$/i.test(left) ? 0 : 1;
    const rightIndexPriority = /(^|\/)index\.html$/i.test(right) ? 0 : 1;

    if (leftIndexPriority !== rightIndexPriority) {
      return leftIndexPriority - rightIndexPriority;
    }

    return left.length - right.length || left.localeCompare(right);
  });

  return normalizedEntries[0] ?? null;
}

function normalizeProjectPath(value: string) {
  return value.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\?.*$/, "").replace(/#.*$/, "");
}

function rankReactEntryCandidate(value: string) {
  if (/src\/main\.(?:tsx|jsx|ts|js)$/i.test(value)) {
    return 0;
  }

  if (/src\/index\.(?:tsx|jsx|ts|js)$/i.test(value)) {
    return 1;
  }

  if (/src\/App\.(?:tsx|jsx|ts|js)$/i.test(value)) {
    return 2;
  }

  if (/src\/(?:Root|root|entry(?:-client|-server)?)\.(?:tsx|jsx|ts|js)$/i.test(value)) {
    return 3;
  }

  if (/src\/(?:routes|pages)\/index\.(?:tsx|jsx|ts|js)$/i.test(value)) {
    return 4;
  }

  if (/src\/(?:routes|pages)\//i.test(value)) {
    return 5;
  }

  if (/\.(?:tsx|jsx)$/i.test(value)) {
    return 6;
  }

  return 7;
}

async function pickLovableEntry(snapshot: ZipProjectSnapshot) {
  const knownFileNames = new Set(snapshot.fileNames.map((name) => normalizeProjectPath(name)));
  const sortedHtmlEntries = [...snapshot.htmlEntries].sort((left, right) => {
    const leftPriority = /(^|\/)index\.html$/i.test(left) ? 0 : 1;
    const rightPriority = /(^|\/)index\.html$/i.test(right) ? 0 : 1;

    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }

    return left.length - right.length || left.localeCompare(right);
  });

  for (const htmlEntry of sortedHtmlEntries) {
    const source = await snapshot.zip.file(htmlEntry)?.async("text");

    if (!source) {
      continue;
    }

    for (const match of source.matchAll(
      /<script[^>]+type=["']module["'][^>]+src=["']([^"']+)["']/gi
    )) {
      const scriptPath = normalizeProjectPath(match[1]);

      if (knownFileNames.has(scriptPath)) {
        return scriptPath;
      }
    }
  }

  const candidates = [...new Set(snapshot.reactEntryCandidates)].sort((left, right) => {
    const leftRank = rankReactEntryCandidate(left);
    const rightRank = rankReactEntryCandidate(right);

    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }

    return left.length - right.length || left.localeCompare(right);
  });

  return candidates[0] ?? snapshot.sourceEntries[0] ?? null;
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

function buildResolvedSource(params: {
  id?: string;
  sourceKind: SourceKind;
  html: string;
  title?: string;
  entryFile?: string | null;
  routeFile?: string | null;
  archiveFileCount?: number;
  notes?: string[];
  sourcePath?: string | null;
  renderContext?: ResolvedSource["renderContext"];
}) {
  const id = params.id ?? crypto.randomUUID();
  const title = params.title ?? getTitle(params.html);
  const inputAnalysis = analyzeInputPage({
    html: params.html,
    sourceKind: params.sourceKind,
    fileName:
      params.sourcePath ??
      params.entryFile ??
      params.routeFile ??
      `${title}.html`
  });

  return {
    id,
    sourceKind: params.sourceKind,
    title,
    html: params.html,
    assets: toResolvedAssetList(inputAnalysis.assets.found),
    entryFile: params.entryFile ?? null,
    routeFile: params.routeFile ?? null,
    archiveFileCount: params.archiveFileCount ?? 0,
    notes: params.notes ?? [],
    sourcePath: params.sourcePath ?? null,
    renderContext:
      params.renderContext ??
      ({
        mode: "set-content",
        sourcePath: params.sourcePath ?? null
      } satisfies ResolvedSource["renderContext"]),
    inputAnalysis
  } satisfies ResolvedSource;
}

export function resolveSourceFromHtml(html: string): ResolvedSource {
  return buildResolvedSource({
    sourceKind: "raw-html",
    html,
    notes: ["Entrada resolvida a partir de HTML bruto."]
  });
}

export async function resolveSourceFromLocalFile(filePath: string): Promise<ResolvedSource> {
  const absolutePath = path.resolve(filePath);
  const html = await readFile(absolutePath, "utf8");
  const fileName = path.basename(absolutePath);

  return buildResolvedSource({
    sourceKind: "raw-html",
    html,
    sourcePath: absolutePath,
    entryFile: fileName,
    notes: ["Entrada resolvida a partir de um arquivo HTML local."],
    renderContext: {
      mode: "local-server",
      documentRoot: path.dirname(absolutePath),
      entryPath: fileName,
      sourcePath: absolutePath
    }
  });
}

export async function resolveSourceFromLocalPath(filePath: string): Promise<ResolvedSource> {
  const absolutePath = path.resolve(filePath);

  if (!absolutePath.toLowerCase().endsWith(".zip")) {
    return resolveSourceFromLocalFile(absolutePath);
  }

  const buffer = await readFile(absolutePath);
  const resolved = await resolveSourceFromZipBuffer(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  );

  return {
    ...resolved,
    sourcePath: absolutePath,
    notes: [
      ...resolved.notes,
      "Entrada ZIP resolvida a partir de um arquivo local para benchmark universal."
    ]
  };
}

async function resolveStaticHtmlArchive(
  snapshot: ZipProjectSnapshot,
  sourceRoot: string
): Promise<ResolvedSource> {
  const entryFile = pickHtmlEntry(snapshot);

  if (!entryFile) {
    throw new Error("O ZIP nao contem nenhum arquivo HTML exportado.");
  }

  const id = crypto.randomUUID();
  const targetDir = path.join(sourceRoot, id);
  const normalizedEntry = sanitizeRelativePath(entryFile);
  const entryAbsolutePath = path.join(targetDir, normalizedEntry);
  await writeZipSnapshotToDirectory(snapshot, targetDir);
  const html = await readFile(entryAbsolutePath, "utf8");

  return buildResolvedSource({
    id,
    sourceKind: "static-html-archive",
    html,
    entryFile: normalizedEntry,
    archiveFileCount: snapshot.fileNames.length,
    sourcePath: entryAbsolutePath,
    notes: [
      "ZIP detectado como site HTML exportado.",
      "Assets locais ficaram disponiveis para renderizacao universal via servidor local."
    ],
    renderContext: {
      mode: "local-server",
      documentRoot: targetDir,
      entryPath: normalizedEntry,
      sourcePath: entryAbsolutePath
    }
  });
}

async function resolveLovableArchive(snapshot: ZipProjectSnapshot): Promise<ResolvedSource> {
  const entryFile = await pickLovableEntry(snapshot);
  const routeFile =
    entryFile && /(^|\/)src\/(?:routes|pages)\//i.test(entryFile) ? entryFile : null;
  const renderedHtml = await extractLovableProjectHtml(snapshot.zip, {
    entryFile
  });

  if (!renderedHtml) {
    throw new Error("Nao foi possivel renderizar o projeto Lovable/React a partir do ZIP enviado.");
  }

  const routeSource = entryFile
    ? await snapshot.zip.file(entryFile)?.async("text")
    : "";

  return buildResolvedSource({
    sourceKind: "lovable-react-source",
    html: injectLovableHeadLinks(renderedHtml, routeSource ?? ""),
    entryFile,
    routeFile,
    archiveFileCount: snapshot.fileNames.length,
    sourcePath: entryFile,
    notes: [
      "ZIP detectado como projeto Lovable/React.",
      "Entrada React/Lovable identificada de forma universal a partir da estrutura do projeto.",
      "HTML final reconstruido antes da conversao para evitar dependencia de um site especifico."
    ]
  });
}

export async function resolveSourceFromUpload(file: File): Promise<ResolvedSource> {
  if (!file.name.toLowerCase().endsWith(".zip")) {
    return buildResolvedSource({
      sourceKind: "raw-html",
      html: await file.text(),
      entryFile: file.name,
      sourcePath: file.name,
      notes: ["Entrada detectada como HTML bruto enviado diretamente."]
    });
  }

  const snapshot = await loadZipSnapshotFromBuffer(await file.arrayBuffer());
  const sourceKind = detectSourceKindFromZipSnapshot(snapshot);
  const sourceRoot = getDefaultSourceRoot();
  await mkdir(sourceRoot, { recursive: true });

  if (sourceKind === "static-html-archive") {
    return resolveStaticHtmlArchive(snapshot, sourceRoot);
  }

  return resolveLovableArchive(snapshot);
}

export async function resolveSourceFromZipBuffer(buffer: ArrayBuffer): Promise<ResolvedSource> {
  const snapshot = await loadZipSnapshotFromBuffer(buffer);
  const sourceKind = detectSourceKindFromZipSnapshot(snapshot);
  const sourceRoot = getDefaultSourceRoot();
  await mkdir(sourceRoot, { recursive: true });

  if (sourceKind === "static-html-archive") {
    return resolveStaticHtmlArchive(snapshot, sourceRoot);
  }

  return resolveLovableArchive(snapshot);
}
