import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { PageCapture, SectionCapture } from "@/lib/converter-v3/contracts/capture";
import type { VisibleContentElement } from "@/lib/converter-v3/contracts/geometry";
import type { LayoutDocument } from "@/lib/converter-v3/contracts/layout";
import type {
  ContentIntegrityReport,
  ExportReport,
  SnapshotVisualSummary,
  VisualValidationIssue,
  VisualValidationReport
} from "@/lib/converter-v3/contracts/output";
import { extractVisibleContentElements } from "@/lib/converter-v3/universal-content";
import { renderHtmlToScreenshot } from "@/lib/converter-v3/visual-similarity";
import type { ElementorDocument, ElementorElement } from "@/types/conversion";

const PLACEHOLDER_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a2kAAAAASUVORK5CYII=";

type ConvertedRepresentation = {
  sourceNodeIds: Set<string>;
  htmlSourceNodeIds: Set<string>;
  usedVisualFallback: boolean;
};

type DebugLostElement = {
  nodeId: string;
  tag: string;
  text: string;
  href?: string;
  src?: string;
  poster?: string;
  backgroundImage?: string;
  box: VisibleContentElement["box"];
  categories: Array<"text" | "media" | "interactive" | "container">;
  reason: string;
  validationIssueTypes: VisualValidationIssue["type"][];
};

type ConversionDebugBundleResult = {
  debugDir: string;
  originalScreenshotPath: string;
  convertedScreenshotPath: string;
  extractedElementsPath: string;
  detectedSectionsPath: string;
  lostElementsPath: string;
  conversionReportPath: string;
  lostElements: DebugLostElement[];
  convertedElementsCount: number;
  extractedElementsCount: number;
};

function sanitizePathSegment(value: string) {
  return value
    .replace(/^.*[\\/]/, "")
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "conversion";
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtmlAttribute(value: string) {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

function escapeCssValue(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function normalizeText(value: string | undefined) {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeImageToken(value: string | undefined) {
  return (value ?? "").replace(/^url\((['"]?)(.*?)\1\)$/i, "$2").trim();
}

function readSourceNodeId(element: ElementorElement) {
  const value = element.settings?.converter_v3_source_node_id;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function collectConvertedRepresentation(document: ElementorDocument): ConvertedRepresentation {
  const sourceNodeIds = new Set<string>();
  const htmlSourceNodeIds = new Set<string>();
  let usedVisualFallback = false;

  const visit = (element: ElementorElement) => {
    const sourceNodeId = readSourceNodeId(element);

    if (sourceNodeId) {
      sourceNodeIds.add(sourceNodeId);
    }

    if (element.widgetType === "html") {
      const html = String(element.settings?.html ?? "");

      if (/converter-v3-snapshot|converter-v3-frame/i.test(html)) {
        usedVisualFallback = true;
      }

      [...html.matchAll(/data-capture-id="([^"]+)"/g)].forEach((match) => {
        if (match[1]) {
          htmlSourceNodeIds.add(match[1]);
        }
      });
    }

    element.elements.forEach(visit);
  };

  document.content.forEach(visit);

  return {
    sourceNodeIds,
    htmlSourceNodeIds,
    usedVisualFallback
  };
}

function buildCategories(element: VisibleContentElement) {
  const categories: DebugLostElement["categories"] = [];

  if (element.isText) {
    categories.push("text");
  }

  if (element.isMedia || element.backgroundImage || element.poster) {
    categories.push("media");
  }

  if (element.isInteractive || element.isLink || element.isButton) {
    categories.push("interactive");
  }

  if (element.isVisualContainer) {
    categories.push("container");
  }

  return categories;
}

function buildIssueMap(validation: VisualValidationReport) {
  const issuesByNodeId = new Map<string, VisualValidationIssue[]>();

  validation.issues.forEach((issue) => {
    const existing = issuesByNodeId.get(issue.nodeId) ?? [];
    existing.push(issue);
    issuesByNodeId.set(issue.nodeId, existing);
  });

  return issuesByNodeId;
}

function hasPreservedDescendant(
  nodeId: string,
  preservedNodeIds: Set<string>,
  childIdsByNodeId: Map<string, string[]>
) {
  const queue = [...(childIdsByNodeId.get(nodeId) ?? [])];

  while (queue.length > 0) {
    const currentId = queue.shift();

    if (!currentId) {
      continue;
    }

    if (preservedNodeIds.has(currentId)) {
      return true;
    }

    queue.push(...(childIdsByNodeId.get(currentId) ?? []));
  }

  return false;
}

function computeLostElements(params: {
  capture: PageCapture;
  extractedElements: VisibleContentElement[];
  converted: ConvertedRepresentation;
  validation: VisualValidationReport;
  contentIntegrity: ContentIntegrityReport;
}) {
  const issuesByNodeId = buildIssueMap(params.validation);
  const preservedNodeIds = new Set([
    ...params.converted.sourceNodeIds,
    ...params.converted.htmlSourceNodeIds
  ]);
  const childIdsByNodeId = new Map(
    params.capture.nodes.map((node) => [node.id, node.childIds])
  );
  const outputEmpty =
    params.contentIntegrity.convertedBodyEmpty || !params.contentIntegrity.visibleContentDetected;

  if (
    params.contentIntegrity.status === "passed" &&
    params.converted.usedVisualFallback
  ) {
    return {
      convertedElementsCount: params.extractedElements.length,
      lostElements: [] as DebugLostElement[]
    };
  }

  const lostElements = params.extractedElements.filter((element) => {
    if (outputEmpty) {
      return true;
    }

    if (preservedNodeIds.has(element.nodeId)) {
      return false;
    }

    if (
      element.isVisualContainer &&
      hasPreservedDescendant(element.nodeId, preservedNodeIds, childIdsByNodeId)
    ) {
      return false;
    }

    return true;
  });

  return {
    convertedElementsCount: Math.max(params.extractedElements.length - lostElements.length, 0),
    lostElements: lostElements.map((element) => {
      const issues = issuesByNodeId.get(element.nodeId) ?? [];
      return {
        nodeId: element.nodeId,
        tag: element.tag,
        text: element.text,
        href: element.href,
        src: element.src,
        poster: element.poster,
        backgroundImage: element.backgroundImage,
        box: element.box,
        categories: buildCategories(element),
        reason:
          issues[0]?.message ??
          params.contentIntegrity.failureReason ??
          "Elemento extraido nao apareceu no documento convertido.",
        validationIssueTypes: [...new Set(issues.map((issue) => issue.type))]
      };
    })
  };
}

function buildDetectedSections(layout: LayoutDocument, sections?: SectionCapture[]) {
  const sectionByNodeId = new Map((sections ?? []).map((section) => [section.nodeId, section]));
  const layoutNodeById = new Map(layout.nodes.map((node) => [node.id, node]));
  const orderedSectionIds =
    layout.detectedSections.length > 0
      ? layout.detectedSections.map((section) => section.id)
      : layout.sectionIds;

  return orderedSectionIds.map((sectionId, index) => {
    const detected = layout.detectedSections.find((section) => section.id === sectionId);
    const section = sectionByNodeId.get(sectionId);
    const layoutNode = layoutNodeById.get(sectionId);

    return {
      id: sectionId,
      name:
        section?.name ??
        `${detected?.type ?? layoutNode?.kind ?? "section"}-${index + 1}`,
      type: section?.type ?? detected?.type ?? layoutNode?.kind ?? "section",
      confidence: detected?.confidence,
      box: section?.box ?? layoutNode?.box ?? null,
      childIds: detected?.childIds ?? layoutNode?.children ?? [],
      subtreeNodeIds: section?.subtreeNodeIds ?? [],
      unsafeReasons: section?.debug?.unsafeReasons ?? [],
      capturedViewports: Object.values(section?.viewports ?? {}).map((viewport) => ({
        viewport: viewport.viewport,
        width: viewport.width,
        height: viewport.height,
        snapshotPath: viewport.snapshotPath,
        captureStrategy: viewport.captureStrategy,
        linkOverlayCount: viewport.linkOverlays.length
      }))
    };
  });
}

function buildNodeInlineStyle(element: ElementorElement, captureNodeById: Map<string, PageCapture["nodes"][number]>) {
  const styles = [
    "box-sizing:border-box",
    "width:100%"
  ];
  const sourceNodeId = readSourceNodeId(element);
  const sourceNode = sourceNodeId ? captureNodeById.get(sourceNodeId) : undefined;
  const sourceStyles = sourceNode?.computedStyles ?? {};

  const styleEntries: Array<[string, string | undefined]> = [
    ["display", sourceStyles.display],
    ["flex-direction", sourceStyles["flex-direction"]],
    ["flex-wrap", sourceStyles["flex-wrap"]],
    ["justify-content", sourceStyles["justify-content"]],
    ["align-items", sourceStyles["align-items"]],
    ["gap", sourceStyles.gap],
    ["grid-template-columns", sourceStyles["grid-template-columns"]],
    ["background", sourceStyles.background],
    ["background-color", sourceStyles["background-color"]],
    ["background-image", sourceStyles["background-image"]],
    ["background-position", sourceStyles["background-position"]],
    ["background-size", sourceStyles["background-size"]],
    ["background-repeat", sourceStyles["background-repeat"]],
    ["color", sourceStyles.color],
    ["padding", sourceStyles.padding],
    ["margin", sourceStyles.margin],
    ["border", sourceStyles.border],
    ["border-radius", sourceStyles["border-radius"]],
    ["box-shadow", sourceStyles["box-shadow"]],
    ["text-align", sourceStyles["text-align"]],
    ["max-width", sourceStyles["max-width"]]
  ];

  styleEntries.forEach(([name, value]) => {
    if (value && value !== "normal" && value !== "auto" && value !== "none") {
      styles.push(`${name}:${escapeCssValue(value)}`);
    }
  });

  if (sourceNode?.box?.height && sourceNode.box.height > 32) {
    styles.push(`min-height:${Math.round(sourceNode.box.height)}px`);
  }

  if (sourceNode?.box?.width && sourceNode.box.width > 32) {
    styles.push(`min-width:${Math.round(Math.min(sourceNode.box.width, 1440))}px`);
  }

  if (!styles.some((style) => style.startsWith("display:"))) {
    styles.push(element.elType === "widget" ? "display:block" : "display:flex");
  }

  if (element.elType !== "widget" && !styles.some((style) => style.startsWith("flex-direction:"))) {
    styles.push("flex-direction:column");
  }

  if (element.elType !== "widget" && !styles.some((style) => style.startsWith("gap:"))) {
    styles.push("gap:16px");
  }

  return styles.join(";");
}

function renderWidgetMarkup(
  element: ElementorElement,
  captureNodeById: Map<string, PageCapture["nodes"][number]>
) {
  const style = buildNodeInlineStyle(element, captureNodeById);

  switch (element.widgetType) {
    case "heading": {
      const title = normalizeText(String(element.settings?.title ?? ""));
      return title ? `<h2 style="${style}">${escapeHtml(title)}</h2>` : "";
    }
    case "text-editor": {
      const editor = String(element.settings?.editor ?? "").trim();
      return editor ? `<div style="${style}">${editor}</div>` : "";
    }
    case "blockquote": {
      const quote = normalizeText(String(element.settings?.blockquote_content ?? ""));
      return quote ? `<blockquote style="${style}">${escapeHtml(quote)}</blockquote>` : "";
    }
    case "button": {
      const text = normalizeText(String(element.settings?.text ?? "")) || "Button";
      const href =
        typeof (element.settings?.link as { url?: string } | undefined)?.url === "string"
          ? ((element.settings?.link as { url?: string }).url ?? "").trim()
          : "";
      return `<a href="${escapeHtmlAttribute(href || "#")}" style="${style};display:inline-flex;align-items:center;justify-content:center;padding:12px 20px;text-decoration:none;border-radius:12px;background:#111;color:#fff;">${escapeHtml(
        text
      )}</a>`;
    }
    case "image": {
      const imageUrl = normalizeImageToken(
        (element.settings?.image as { url?: string } | undefined)?.url
      );
      return imageUrl
        ? `<img src="${escapeHtmlAttribute(imageUrl)}" alt="" style="${style};display:block;max-width:100%;height:auto;" />`
        : "";
    }
    case "icon-list": {
      const items =
        (element.settings?.icon_list as Array<{ text?: string }> | undefined) ?? [];
      const listItems = items
        .map((item) => normalizeText(item.text))
        .filter(Boolean)
        .map((text) => `<li>${escapeHtml(text)}</li>`)
        .join("");
      return listItems ? `<ul style="${style}">${listItems}</ul>` : "";
    }
    case "accordion": {
      const tabs =
        (element.settings?.tabs as Array<{ tab_title?: string; tab_content?: string }> | undefined) ?? [];
      const details = tabs
        .map((tab) => {
          const title = normalizeText(tab.tab_title);
          const content = String(tab.tab_content ?? "").trim();
          return title || content
            ? `<details style="border:1px solid #ddd;border-radius:12px;padding:10px 14px;"><summary>${escapeHtml(
                title || "Details"
              )}</summary><div>${content}</div></details>`
            : "";
        })
        .join("");
      return details ? `<div style="${style}">${details}</div>` : "";
    }
    case "html": {
      const html = String(element.settings?.html ?? "");
      return html ? `<div style="${style}">${html}</div>` : "";
    }
    default: {
      const children = element.elements
        .map((child) => renderElementMarkup(child, captureNodeById))
        .join("");
      return children ? `<div style="${style}">${children}</div>` : "";
    }
  }
}

function renderElementMarkup(
  element: ElementorElement,
  captureNodeById: Map<string, PageCapture["nodes"][number]>
): string {
  if (element.elType === "widget") {
    return renderWidgetMarkup(element, captureNodeById);
  }

  const tag =
    typeof element.settings?.html_tag === "string" && element.settings.html_tag.trim()
      ? element.settings.html_tag.trim()
      : element.elType === "section"
        ? "section"
        : "div";
  const children = element.elements
    .map((child) => renderElementMarkup(child, captureNodeById))
    .join("");

  return `<${tag} style="${buildNodeInlineStyle(element, captureNodeById)}">${children}</${tag}>`;
}

export function buildConvertedPreviewHtml(params: {
  capture: PageCapture;
  document: ElementorDocument;
}) {
  const desktopViewport =
    params.capture.viewports.find((viewport) => viewport.name === "desktop") ??
    params.capture.viewports[0];
  const pageWidth = desktopViewport?.width ?? 1440;
  const captureNodeById = new Map(params.capture.nodes.map((node) => [node.id, node]));
  const body = params.document.content
    .map((element) => renderElementMarkup(element, captureNodeById))
    .join("");

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      html, body {
        margin: 0;
        padding: 0;
        background: #ffffff;
        color: #111111;
        font-family: Arial, sans-serif;
      }

      *, *::before, *::after {
        box-sizing: border-box;
      }

      img {
        max-width: 100%;
        height: auto;
      }

      main {
        width: ${Math.max(pageWidth, 1)}px;
        max-width: 100%;
        margin: 0 auto;
        padding: 0;
      }
    </style>
  </head>
  <body>
    <main>${body}</main>
  </body>
</html>`;
}

async function ensureScreenshot(params: {
  targetPath: string;
  sourcePath?: string;
  html?: string;
  viewportWidth: number;
  viewportHeight: number;
}) {
  try {
    if (params.sourcePath) {
      await copyFile(params.sourcePath, params.targetPath);
      return;
    }

    if (params.html) {
      await renderHtmlToScreenshot({
        html: params.html,
        viewportWidth: params.viewportWidth,
        viewportHeight: params.viewportHeight,
        outputPath: params.targetPath,
        fullPage: true
      });
      return;
    }
  } catch {
    // Fall through to placeholder generation.
  }

  await writeFile(params.targetPath, Buffer.from(PLACEHOLDER_PNG_BASE64, "base64"));
}

async function writeJson(filePath: string, value: unknown) {
  await writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

export async function writeConversionDebugBundle(params: {
  capture: PageCapture;
  layout: LayoutDocument;
  document: ElementorDocument;
  validation: VisualValidationReport;
  contentIntegrity: ContentIntegrityReport;
  report: ExportReport;
  snapshot?: SnapshotVisualSummary;
  previewHtml?: string;
}) : Promise<ConversionDebugBundleResult> {
  const extractedElements = extractVisibleContentElements(params.capture);
  const converted = collectConvertedRepresentation(params.document);
  const detectedSections = buildDetectedSections(params.layout, params.capture.sections);
  const { lostElements, convertedElementsCount } = computeLostElements({
    capture: params.capture,
    extractedElements,
    converted,
    validation: params.validation,
    contentIntegrity: params.contentIntegrity
  });
  const debugDir = path.join(
    process.cwd(),
    "debug",
    "conversions",
    `${sanitizePathSegment(params.capture.title || params.capture.id)}-${sanitizePathSegment(
      params.capture.id
    )}`
  );
  const originalScreenshotPath = path.join(debugDir, "original-screenshot.png");
  const convertedScreenshotPath = path.join(debugDir, "converted-screenshot.png");
  const extractedElementsPath = path.join(debugDir, "extracted-elements.json");
  const detectedSectionsPath = path.join(debugDir, "detected-sections.json");
  const lostElementsPath = path.join(debugDir, "lost-elements.json");
  const conversionReportPath = path.join(debugDir, "conversion-report.json");
  const desktopViewport =
    params.capture.viewports.find((viewport) => viewport.name === "desktop") ??
    params.capture.viewports[0] ?? {
      width: 1440,
      height: 1024
    };
  const convertedPreviewHtml =
    params.previewHtml && params.previewHtml.trim().length > 0
      ? params.previewHtml
      : buildConvertedPreviewHtml({
          capture: params.capture,
          document: params.document
        });

  await mkdir(debugDir, { recursive: true });

  await ensureScreenshot({
    targetPath: originalScreenshotPath,
    sourcePath: params.capture.artifacts.screenshots.desktop,
    html: params.capture.renderedHtml,
    viewportWidth: desktopViewport.width,
    viewportHeight: desktopViewport.height
  });
  await ensureScreenshot({
    targetPath: convertedScreenshotPath,
    sourcePath: params.snapshot?.convertedScreenshotPath,
    html: convertedPreviewHtml,
    viewportWidth: desktopViewport.width,
    viewportHeight: desktopViewport.height
  });
  await writeJson(extractedElementsPath, extractedElements);
  await writeJson(detectedSectionsPath, detectedSections);
  await writeJson(lostElementsPath, lostElements);
  await writeJson(conversionReportPath, {
    id: params.capture.id,
    title: params.capture.title,
    renderer: params.capture.renderer,
    selectedMode: params.report.selectedMode,
    emittedMode: params.report.emittedMode,
    originalElements: params.capture.summary.visibleNodes,
    originalMeaningfulElements: extractedElements.length,
    extractedElements: extractedElements.length,
    convertedElements: convertedElementsCount,
    lostElements: lostElements.length,
    detectedSections: detectedSections.length,
    createdSections: params.report.contentMetrics.createdSections,
    countsByType: {
      texts: params.report.contentMetrics.detectedTexts,
      images: params.report.contentMetrics.detectedImages,
      buttons: params.report.contentMetrics.detectedButtons,
      links: params.report.contentMetrics.detectedLinks,
      visualContainers: params.report.contentMetrics.detectedVisualContainers,
      geometryGroups: params.report.contentMetrics.detectedGeometryGroups
    },
    emptyExport: {
      happened:
        params.contentIntegrity.convertedBodyEmpty || !params.contentIntegrity.visibleContentDetected,
      failureStage: params.contentIntegrity.failureStage,
      reason: params.contentIntegrity.failureReason
    },
    contentIntegrityStatus: params.contentIntegrity.status,
    fallbackReason: params.report.fallbackReason,
    snapshotReason: params.report.snapshotReason,
    warnings: params.report.warnings,
    validationIssues: params.validation.issues.map((issue) => ({
      type: issue.type,
      nodeId: issue.nodeId,
      message: issue.message,
      sectionId: issue.sectionId
    })),
    artifactPaths: {
      originalScreenshotPath,
      convertedScreenshotPath,
      extractedElementsPath,
      detectedSectionsPath,
      lostElementsPath,
      conversionReportPath
    }
  });

  return {
    debugDir,
    originalScreenshotPath,
    convertedScreenshotPath,
    extractedElementsPath,
    detectedSectionsPath,
    lostElementsPath,
    conversionReportPath,
    lostElements,
    convertedElementsCount,
    extractedElementsCount: extractedElements.length
  };
}
