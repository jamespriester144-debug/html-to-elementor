import * as cheerio from "cheerio";

import { auditThemeConsistency } from "@/lib/converter-v3/analyze/theme-detector";
import type { PageCapture } from "@/lib/converter-v3/contracts/capture";
import type { LayoutDocument, LayoutNode, OutputMode } from "@/lib/converter-v3/contracts/layout";
import type {
  VisualIssueSeverity,
  VisualValidationIssue,
  VisualValidationReport
} from "@/lib/converter-v3/contracts/output";
import {
  colorDistance,
  isClearlyDarkColor,
  isClearlyLightColor,
  resolveDominantColorMismatchSeverity
} from "@/lib/converter-v3/visual-similarity";
import type { ElementorDocument, ElementorElement } from "@/types/conversion";

type ActualButton = {
  text: string;
  href?: string;
};

type ActualRepresentation = {
  sourceNodeIds: Set<string>;
  htmlPreservedNodeIds: Set<string>;
  texts: string[];
  images: string[];
  buttons: ActualButton[];
  links: string[];
  globalFallback: boolean;
  elementsBySourceNodeId: Map<string, ElementorElement[]>;
};

type SectionContext = {
  sectionId: string;
  sectionName: string;
  sectionType: string;
};

type ValidationMetrics = {
  originalVisibleHeight?: number;
  convertedVisibleHeight?: number;
  heightDifferenceRatio?: number;
  dominantColorDistance?: number;
  sourceDominantColor?: string;
  convertedDominantColor?: string;
};

const SECTION_TYPES_WITH_PRIORITY = new Set(["header", "hero", "section", "cta", "grid", "footer"]);
const MAIN_SECTION_LIMIT = 5;
const WARNING_HEIGHT_RATIO = 0.18;
const CRITICAL_HEIGHT_RATIO = 0.35;
const BLOCKING_HEIGHT_RATIO = 0.55;
const HEADER_FOOTER_BACKGROUND_DISTANCE = 90;

function normalizeText(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeImageToken(value: string | undefined): string {
  return (value ?? "").replace(/^url\((['"]?)(.*?)\1\)$/i, "$2").trim();
}

function splitCssSegments(value: string) {
  const segments: string[] = [];
  let current = "";
  let depth = 0;

  for (const character of value) {
    if (character === "(") {
      depth += 1;
      current += character;
      continue;
    }

    if (character === ")") {
      depth = Math.max(0, depth - 1);
      current += character;
      continue;
    }

    if (character === "," && depth === 0) {
      const segment = current.trim();

      if (segment) {
        segments.push(segment);
      }

      current = "";
      continue;
    }

    current += character;
  }

  const trailingSegment = current.trim();

  if (trailingSegment) {
    segments.push(trailingSegment);
  }

  return segments;
}

function parseBackgroundUrl(value?: string): string | undefined {
  if (!value || value === "none") {
    return undefined;
  }

  return splitCssSegments(value)
    .map((segment) => segment.match(/^url\((['"]?)(.*?)\1\)$/i)?.[2]?.trim())
    .find((candidate): candidate is string => Boolean(candidate));
}

function backgroundHasGradient(value?: string) {
  return /gradient\(/i.test(value ?? "");
}

function hasMeaningfulBackgroundColor(value?: string) {
  const normalized = (value ?? "").replace(/\s+/g, "").toLowerCase();

  return Boolean(
    normalized &&
      normalized !== "transparent" &&
      normalized !== "rgba(0,0,0,0)" &&
      normalized !== "none"
  );
}

function buildSectionContextByNodeId(layout: LayoutDocument) {
  const nodeById = new Map(layout.nodes.map((node) => [node.id, node]));
  const sectionIndexById = new Map(
    layout.detectedSections.map((section, index) => [section.id, index + 1])
  );
  const detectedSectionById = new Map(
    layout.detectedSections.map((section) => [section.id, section])
  );
  const contextBySectionId = new Map<string, SectionContext>();

  const resolveSectionContext = (sectionId: string): SectionContext => {
    const existing = contextBySectionId.get(sectionId);

    if (existing) {
      return existing;
    }

    const detected = detectedSectionById.get(sectionId);
    const fallbackNode = nodeById.get(sectionId);
    const sectionType =
      detected?.type ??
      fallbackNode?.detection?.semanticRole ??
      fallbackNode?.kind ??
      "section";
    const sectionIndex =
      sectionIndexById.get(sectionId) ??
      layout.sectionIds.findIndex((candidate) => candidate === sectionId) + 1;
    const context = {
      sectionId,
      sectionType,
      sectionName:
        sectionIndex > 0 ? `${sectionType}-${sectionIndex}` : `${sectionType}-${sectionId}`
    };

    contextBySectionId.set(sectionId, context);
    return context;
  };

  const byNodeId = new Map<string, SectionContext>();

  layout.nodes.forEach((node) => {
    let currentId: string | null = node.id;

    while (currentId) {
      if (detectedSectionById.has(currentId) || layout.sectionIds.includes(currentId)) {
        byNodeId.set(node.id, resolveSectionContext(currentId));
        return;
      }

      currentId = nodeById.get(currentId)?.parentId ?? null;
    }
  });

  return byNodeId;
}

function formatSectionSuffix(section?: SectionContext) {
  return section ? ` Secao ${section.sectionName} (${section.sectionId}).` : "";
}

function collectExpectedTextNodes(layout: LayoutDocument): LayoutNode[] {
  return layout.nodes.filter(
    (node) =>
      !node.flags.hidden &&
      node.kind === "text" &&
      Boolean(normalizeText(node.content.text))
  );
}

function collectExpectedImages(layout: LayoutDocument): LayoutNode[] {
  return layout.nodes.filter(
    (node) =>
      !node.flags.hidden &&
      (node.kind === "image" || Boolean(normalizeImageToken(node.style.backgroundImage)))
  );
}

function collectExpectedButtons(layout: LayoutDocument): LayoutNode[] {
  return layout.nodes.filter((node) => !node.flags.hidden && node.kind === "button");
}

function collectExpectedLinks(layout: LayoutDocument): LayoutNode[] {
  return layout.nodes.filter(
    (node) =>
      !node.flags.hidden &&
      node.kind === "button" &&
      Boolean(node.content.href?.trim())
  );
}

function collectExpectedSections(layout: LayoutDocument): LayoutNode[] {
  return layout.detectedSections
    .filter((section) => section.type === "section" || section.type === "hero" || section.type === "grid")
    .map((section) => layout.nodes.find((node) => node.id === section.id))
    .filter((node): node is LayoutNode => Boolean(node));
}

function collectExpectedCards(layout: LayoutDocument): LayoutNode[] {
  return layout.nodes.filter(
    (node) => !node.flags.hidden && node.detection?.semanticRole === "card"
  );
}

function collectExpectedHeaders(layout: LayoutDocument): LayoutNode[] {
  return layout.nodes.filter(
    (node) => !node.flags.hidden && node.detection?.semanticRole === "header"
  );
}

function collectExpectedFooters(layout: LayoutDocument): LayoutNode[] {
  return layout.nodes.filter(
    (node) => !node.flags.hidden && node.detection?.semanticRole === "footer"
  );
}

function collectExpectedPositionNodes(layout: LayoutDocument): LayoutNode[] {
  return layout.nodes.filter(
    (node) =>
      !node.flags.hidden &&
      !node.flags.decorative &&
      node.kind !== "page" &&
      node.box.width > 0 &&
      node.box.height > 0
  );
}

function readSourceNodeId(element: ElementorElement): string | undefined {
  const nodeId = element.settings?.converter_v3_source_node_id;
  return typeof nodeId === "string" && nodeId.trim() ? nodeId.trim() : undefined;
}

function readMappedSourceNodeIds(element: ElementorElement): string[] {
  const ids = new Set<string>();
  const sourceNodeId = readSourceNodeId(element);
  const pageShellCaptureNodeId = element.settings?.converter_v3_page_shell_capture_node_id;

  if (sourceNodeId) {
    ids.add(sourceNodeId);
  }

  if (typeof pageShellCaptureNodeId === "string" && pageShellCaptureNodeId.trim()) {
    ids.add(pageShellCaptureNodeId.trim());
  }

  return [...ids];
}

function pushElementSourceMapping(
  actual: ActualRepresentation,
  sourceNodeId: string,
  element: ElementorElement
) {
  const elements = actual.elementsBySourceNodeId.get(sourceNodeId) ?? [];
  elements.push(element);
  actual.elementsBySourceNodeId.set(sourceNodeId, elements);
}

function collectFromHtmlWidget(html: string, actual: ActualRepresentation) {
  const sourceIds = [...html.matchAll(/data-capture-id="([^"]+)"/g)].map((match) => match[1]);

  sourceIds.forEach((id) => {
    actual.sourceNodeIds.add(id);
    actual.htmlPreservedNodeIds.add(id);
  });

  if (/converter-v3-frame/i.test(html)) {
    actual.globalFallback = true;
  }

  const $ = cheerio.load(html);
  const textTags = $("h1,h2,h3,h4,h5,h6,p,span,small,strong,em,label,li,blockquote");
  textTags.each((_, element) => {
    const text = normalizeText($(element).text());

    if (text) {
      actual.texts.push(text);
    }
  });

  $("img").each((_, element) => {
    const src = normalizeImageToken($(element).attr("src"));

    if (src) {
      actual.images.push(src);
    }
  });

  $("[style]").each((_, element) => {
    const style = $(element).attr("style") ?? "";
    const backgroundMatch = style.match(/background-image\s*:\s*([^;]+)/i);

    if (backgroundMatch?.[1]) {
      const token = normalizeImageToken(backgroundMatch[1]);

      if (token) {
        actual.images.push(token);
      }
    }
  });

  $("a,button").each((_, element) => {
    const text = normalizeText($(element).text());
    const href = $(element).attr("href")?.trim();

    if (text || href) {
      actual.buttons.push({ text, href });
    }
  });
}

function collectActualRepresentation(document: ElementorDocument): ActualRepresentation {
  const actual: ActualRepresentation = {
    sourceNodeIds: new Set<string>(),
    htmlPreservedNodeIds: new Set<string>(),
    texts: [],
    images: [],
    buttons: [],
    links: [],
    globalFallback: false,
    elementsBySourceNodeId: new Map<string, ElementorElement[]>()
  };

  const visit = (element: ElementorElement) => {
    readMappedSourceNodeIds(element).forEach((sourceNodeId) => {
      actual.sourceNodeIds.add(sourceNodeId);
      pushElementSourceMapping(actual, sourceNodeId, element);
    });

    if (element.widgetType === "heading") {
      const title = normalizeText(String(element.settings?.title ?? ""));

      if (title) {
        actual.texts.push(title);
      }
    }

    if (element.widgetType === "text-editor") {
      const editor = normalizeText(String(element.settings?.editor ?? ""));

      if (editor) {
        actual.texts.push(editor);
      }
    }

    if (element.widgetType === "blockquote") {
      const quote = normalizeText(String(element.settings?.blockquote_content ?? ""));

      if (quote) {
        actual.texts.push(quote);
      }
    }

    if (element.widgetType === "icon-list") {
      const items = (element.settings?.icon_list as Array<{ text?: string }> | undefined) ?? [];

      items.forEach((item) => {
        const text = normalizeText(item.text);

        if (text) {
          actual.texts.push(text);
        }
      });
    }

    if (element.widgetType === "accordion") {
      const tabs =
        (element.settings?.tabs as Array<{ tab_title?: string; tab_content?: string }> | undefined) ?? [];

      tabs.forEach((tab) => {
        const title = normalizeText(tab.tab_title);
        const content = normalizeText(tab.tab_content);

        if (title) {
          actual.texts.push(title);
        }

        if (content) {
          actual.texts.push(content);
        }
      });
    }

    if (element.widgetType === "button") {
      const text = normalizeText(String(element.settings?.text ?? ""));
      const link = element.settings?.link as { url?: string } | undefined;
      actual.buttons.push({
        text,
        href: link?.url?.trim()
      });

      if (link?.url?.trim()) {
        actual.links.push(link.url.trim());
      }
    }

    if (element.widgetType === "image") {
      const image = element.settings?.image as { url?: string } | undefined;
      const url = normalizeImageToken(image?.url);

      if (url) {
        actual.images.push(url);
      }
    }

    const backgroundImageSetting = element.settings?.background_image as { url?: string } | undefined;
    const backgroundImage = normalizeImageToken(backgroundImageSetting?.url);

    if (backgroundImage) {
      actual.images.push(backgroundImage);
    }

    if (element.widgetType === "html") {
      const html = String(element.settings?.html ?? "");
      const converterMode =
        typeof element.settings?.converter_v3_mode === "string"
          ? element.settings.converter_v3_mode
          : "";

      if (converterMode.startsWith("snapshot-")) {
        actual.globalFallback = true;
      }

      if (html) {
        collectFromHtmlWidget(html, actual);
      }
    }

    element.elements.forEach(visit);
  };

  document.content.forEach(visit);

  return actual;
}

function consumeMatch<TExpected, TActual>(
  expected: TExpected[],
  actual: TActual[],
  isMatch: (left: TExpected, right: TActual) => boolean
): { matched: number; missing: TExpected[] } {
  const available = [...actual];
  let matched = 0;
  const missing: TExpected[] = [];

  expected.forEach((item) => {
    const index = available.findIndex((candidate) => isMatch(item, candidate));

    if (index === -1) {
      missing.push(item);
      return;
    }

    available.splice(index, 1);
    matched += 1;
  });

  return { matched, missing };
}

function collectLayoutSubtreeIds(layout: LayoutDocument, rootId: string) {
  const childrenById = new Map(layout.nodes.map((node) => [node.id, node.children]));
  const visited = new Set<string>();
  const queue = [rootId];

  while (queue.length > 0) {
    const currentId = queue.shift();

    if (!currentId || visited.has(currentId)) {
      continue;
    }

    visited.add(currentId);
    queue.push(...(childrenById.get(currentId) ?? []));
  }

  return visited;
}

function hasBackgroundAsset(value: unknown) {
  return typeof (value as { url?: string } | undefined)?.url === "string";
}

function hasGradientSetting(
  settings: ElementorElement["settings"],
  keyPrefix: "background" | "background_overlay"
) {
  return settings[`${keyPrefix}_background`] === "gradient";
}

function elementHasImageAsset(element: ElementorElement) {
  const image = element.settings?.image as { url?: string } | undefined;
  return Boolean(image?.url?.trim());
}

function elementHasBackgroundImage(element: ElementorElement) {
  return hasBackgroundAsset(element.settings?.background_image);
}

function elementHasGradientOrOverlay(element: ElementorElement) {
  return (
    hasGradientSetting(element.settings, "background") ||
    hasGradientSetting(element.settings, "background_overlay") ||
    hasMeaningfulBackgroundColor(String(element.settings?.background_overlay_color ?? ""))
  );
}

function readElementBackgroundColors(element: ElementorElement) {
  return [
    String(element.settings?.background_color ?? "").trim(),
    String(element.settings?.background_overlay_color ?? "").trim()
  ].filter((value) => hasMeaningfulBackgroundColor(value));
}

function collectMappedBackgroundColors(nodeIds: Set<string>, actual: ActualRepresentation) {
  const colors = new Set<string>();

  nodeIds.forEach((nodeId) => {
    const elements = actual.elementsBySourceNodeId.get(nodeId) ?? [];

    elements.forEach((element) => {
      readElementBackgroundColors(element).forEach((color) => colors.add(color));
    });
  });

  return [...colors];
}

function elementHasBackgroundSettings(element: ElementorElement) {
  return (
    hasMeaningfulBackgroundColor(String(element.settings?.background_color ?? "")) ||
    elementHasBackgroundImage(element) ||
    elementHasGradientOrOverlay(element)
  );
}

function sourceNodeHasVisualBackground(node?: LayoutNode) {
  return Boolean(
    node &&
      (
        hasMeaningfulBackgroundColor(node.style.backgroundColor) ||
        Boolean(parseBackgroundUrl(node.style.backgroundImage)) ||
        backgroundHasGradient(node.style.backgroundImage)
      )
  );
}

function sourceNodeHasBackgroundImage(node?: LayoutNode) {
  return Boolean(node && parseBackgroundUrl(node.style.backgroundImage));
}

function sourceNodeHasGradient(node?: LayoutNode) {
  return Boolean(node && backgroundHasGradient(node.style.backgroundImage));
}

function nodeSetHasMappedVisualShell(
  nodeIds: Set<string>,
  actual: ActualRepresentation,
  matcher: (element: ElementorElement) => boolean
) {
  for (const nodeId of nodeIds) {
    if (actual.htmlPreservedNodeIds.has(nodeId)) {
      return true;
    }

    const elements = actual.elementsBySourceNodeId.get(nodeId) ?? [];

    if (elements.some(matcher)) {
      return true;
    }
  }

  return false;
}

function countRepresentedNodes(nodeIds: Set<string>, actual: ActualRepresentation) {
  let represented = 0;

  nodeIds.forEach((nodeId) => {
    if (actual.sourceNodeIds.has(nodeId) || actual.htmlPreservedNodeIds.has(nodeId)) {
      represented += 1;
    }
  });

  return represented;
}

function determineIssueSeverityWeight(severity?: VisualIssueSeverity) {
  switch (severity) {
    case "blocking":
      return 3;
    case "critical":
      return 2;
    case "warning":
      return 1;
    default:
      return 0;
  }
}

function getHighestSeverity(issues: VisualValidationIssue[]) {
  if (issues.some((issue) => issue.severity === "blocking")) {
    return "blocking" as const;
  }

  if (issues.some((issue) => issue.severity === "critical")) {
    return "critical" as const;
  }

  if (issues.some((issue) => issue.severity === "warning")) {
    return "warning" as const;
  }

  return "none" as const;
}

function buildEmptyStats() {
  return {
    expectedTexts: 0,
    matchedTexts: 0,
    expectedImages: 0,
    matchedImages: 0,
    expectedButtons: 0,
    matchedButtons: 0,
    expectedLinks: 0,
    matchedLinks: 0,
    expectedSections: 0,
    matchedSections: 0,
    expectedCards: 0,
    matchedCards: 0,
    expectedHeaders: 0,
    matchedHeaders: 0,
    expectedFooters: 0,
    matchedFooters: 0,
    expectedPositionedNodes: 0,
    matchedPositionedNodes: 0
  };
}

function dedupeIssues(issues: VisualValidationIssue[]) {
  const seen = new Map<string, VisualValidationIssue>();

  issues.forEach((issue) => {
    const key = [
      issue.type,
      issue.nodeId,
      issue.sectionId ?? "",
      issue.viewport ?? "",
      issue.message
    ].join(":");
    const existing = seen.get(key);

    if (
      !existing ||
      determineIssueSeverityWeight(issue.severity) >
        determineIssueSeverityWeight(existing.severity)
    ) {
      seen.set(key, issue);
    }
  });

  return [...seen.values()];
}

function isNodeImportant(params: {
  node: LayoutNode;
  sectionContext?: SectionContext;
  criticalNodeIds: Set<string>;
}) {
  return (
    params.criticalNodeIds.has(params.node.id) ||
    ["hero", "header", "footer", "grid", "card"].includes(params.sectionContext?.sectionType ?? "")
  );
}

function pickPrimarySectionIds(layout: LayoutDocument) {
  const primaryDetected = layout.detectedSections
    .filter((section) => SECTION_TYPES_WITH_PRIORITY.has(section.type))
    .map((section) => section.id);

  return [...new Set([...primaryDetected, ...layout.sectionIds])].slice(0, MAIN_SECTION_LIMIT);
}

function countMeaningfulSubtreeNodes(nodeIds: Set<string>, nodeById: Map<string, LayoutNode>) {
  let total = 0;

  nodeIds.forEach((nodeId) => {
    const node = nodeById.get(nodeId);

    if (!node || node.flags.hidden) {
      return;
    }

    if (
      node.kind === "text" ||
      node.kind === "image" ||
      node.kind === "button" ||
      sourceNodeHasVisualBackground(node)
    ) {
      total += 1;
    }
  });

  return total;
}

function buildValidationMetrics(params: {
  layout: LayoutDocument;
  actual: ActualRepresentation;
  sourceThemeBackground?: string;
  convertedThemeBackground?: string;
}) {
  const originalVisibleHeight = params.layout.nodes.reduce(
    (max, node) => Math.max(max, node.box.y + node.box.height),
    0
  );
  const nodeById = new Map(params.layout.nodes.map((node) => [node.id, node]));
  const convertedVisibleHeight = [...new Set([
    ...params.actual.sourceNodeIds,
    ...params.actual.htmlPreservedNodeIds
  ])].reduce((max, nodeId) => {
    const node = nodeById.get(nodeId);
    return Math.max(max, node ? node.box.y + node.box.height : 0);
  }, 0);
  const heightDifferenceRatio =
    originalVisibleHeight > 0
      ? Number.parseFloat(
          (
            Math.abs(originalVisibleHeight - convertedVisibleHeight) / Math.max(originalVisibleHeight, 1)
          ).toFixed(4)
        )
      : undefined;
  const dominantColorDistance = colorDistance(
    params.sourceThemeBackground,
    params.convertedThemeBackground
  );

  return {
    originalVisibleHeight: originalVisibleHeight || undefined,
    convertedVisibleHeight: convertedVisibleHeight || undefined,
    heightDifferenceRatio,
    dominantColorDistance,
    sourceDominantColor: params.sourceThemeBackground,
    convertedDominantColor: params.convertedThemeBackground
  } satisfies ValidationMetrics;
}

export class VisualValidationError extends Error {
  report: VisualValidationReport;

  constructor(report: VisualValidationReport) {
    super(
      report.blockingReason ??
        `Exportacao bloqueada pela validacao visual: ${report.issueCount} perda(s) detectada(s).`
    );
    this.name = "VisualValidationError";
    this.report = report;
  }
}

export function validateElementorExport(params: {
  capture: PageCapture;
  layout: LayoutDocument;
  document: ElementorDocument;
  mode: OutputMode;
  previewHtml?: string;
}): VisualValidationReport {
  const actual = collectActualRepresentation(params.document);
  const sectionContextByNodeId = buildSectionContextByNodeId(params.layout);
  const nodeById = new Map(params.layout.nodes.map((node) => [node.id, node]));
  const criticalResourceNodeIds = new Set(
    (params.capture.inputAnalysis.diagnostics.resources ?? [])
      .filter((resource) => resource.critical && resource.nodeId)
      .map((resource) => resource.nodeId as string)
  );
  const createIssue = (
    type: VisualValidationIssue["type"],
    nodeId: string,
    message: string,
    options: Partial<VisualValidationIssue> = {}
  ): VisualValidationIssue => {
    const section = sectionContextByNodeId.get(nodeId);

    return {
      type,
      nodeId,
      message: `${message.replace(/\.+$/, "")}.${formatSectionSuffix(section)}`.trim(),
      severity: options.severity ?? "blocking",
      sectionId: options.sectionId ?? section?.sectionId,
      sectionName: options.sectionName ?? section?.sectionName,
      sectionType: options.sectionType ?? section?.sectionType,
      sectionTypeLabel: options.sectionTypeLabel,
      viewport: options.viewport,
      similarity: options.similarity,
      similarityPercent: options.similarityPercent,
      lossType: options.lossType,
      estimatedLossCount: options.estimatedLossCount,
      estimatedLosses: options.estimatedLosses,
      bbox: options.bbox,
      originalScreenshotPath: options.originalScreenshotPath,
      convertedScreenshotPath: options.convertedScreenshotPath,
      diffScreenshotPath: options.diffScreenshotPath,
      originalValue: options.originalValue,
      convertedValue: options.convertedValue
    };
  };

  if (actual.globalFallback) {
    const expectedPositionedNodes = collectExpectedPositionNodes(params.layout).length;
    const expectedTexts = collectExpectedTextNodes(params.layout).length;
    const expectedImages = collectExpectedImages(params.layout).length;
    const expectedButtons = collectExpectedButtons(params.layout).length;
    const expectedLinks = collectExpectedLinks(params.layout).length;
    const expectedSections = collectExpectedSections(params.layout).length;
    const expectedCards = collectExpectedCards(params.layout).length;
    const expectedHeaders = collectExpectedHeaders(params.layout).length;
    const expectedFooters = collectExpectedFooters(params.layout).length;

    return {
      passed: true,
      mode: params.mode,
      issueCount: 0,
      issues: [],
      severityCounts: {
        warning: 0,
        critical: 0,
        blocking: 0
      },
      highestSeverity: "none",
      summaryMessages: [],
      stats: {
        expectedTexts,
        matchedTexts: expectedTexts,
        expectedImages,
        matchedImages: expectedImages,
        expectedButtons,
        matchedButtons: expectedButtons,
        expectedLinks,
        matchedLinks: expectedLinks,
        expectedSections,
        matchedSections: expectedSections,
        expectedCards,
        matchedCards: expectedCards,
        expectedHeaders,
        matchedHeaders: expectedHeaders,
        expectedFooters,
        matchedFooters: expectedFooters,
        expectedPositionedNodes,
        matchedPositionedNodes: expectedPositionedNodes
      }
    };
  }

  const expectedTexts = collectExpectedTextNodes(params.layout);
  const expectedImages = collectExpectedImages(params.layout);
  const expectedButtons = collectExpectedButtons(params.layout);
  const expectedLinks = collectExpectedLinks(params.layout);
  const expectedSections = collectExpectedSections(params.layout);
  const expectedCards = collectExpectedCards(params.layout);
  const expectedHeaders = collectExpectedHeaders(params.layout);
  const expectedFooters = collectExpectedFooters(params.layout);
  const expectedPositions = collectExpectedPositionNodes(params.layout);
  const textMatches = consumeMatch(
    expectedTexts.map((node) => normalizeText(node.content.text)),
    actual.texts,
    (expected, received) => expected === received
  );
  const imageMatches = consumeMatch(
    expectedImages.map((node) =>
      normalizeImageToken(node.content.src ?? node.style.backgroundImage)
    ),
    actual.images,
    (expected, received) => expected === normalizeImageToken(received)
  );
  const buttonMatches = consumeMatch(
    expectedButtons.map((node) => ({
      id: node.id,
      text: normalizeText(node.content.text),
      href: node.content.href?.trim()
    })),
    actual.buttons,
    (expected, received) =>
      expected.text === normalizeText(received.text) &&
      (expected.href ? expected.href === received.href?.trim() : true)
  );
  const linkMatches = consumeMatch(
    expectedLinks.map((node) => node.content.href?.trim() ?? ""),
    actual.links,
    (expected, received) => expected === received.trim()
  );
  const missingPositionNodes = expectedPositions.filter(
    (node) => !actual.sourceNodeIds.has(node.id) && !actual.htmlPreservedNodeIds.has(node.id)
  );
  const missingSections = expectedSections.filter(
    (node) => !actual.sourceNodeIds.has(node.id) && !actual.htmlPreservedNodeIds.has(node.id)
  );
  const missingCards = expectedCards.filter(
    (node) => !actual.sourceNodeIds.has(node.id) && !actual.htmlPreservedNodeIds.has(node.id)
  );
  const missingHeaders = expectedHeaders.filter(
    (node) => !actual.sourceNodeIds.has(node.id) && !actual.htmlPreservedNodeIds.has(node.id)
  );
  const missingFooters = expectedFooters.filter(
    (node) => !actual.sourceNodeIds.has(node.id) && !actual.htmlPreservedNodeIds.has(node.id)
  );
  const issues: VisualValidationIssue[] = [];

  textMatches.missing.forEach((text) => {
    const node = expectedTexts.find((candidate) => normalizeText(candidate.content.text) === text);

    if (!node) {
      return;
    }

    issues.push(
      createIssue("missing-text", node.id, `Texto visivel perdido: "${text}"`, {
        severity: "blocking"
      })
    );
  });

  imageMatches.missing.forEach((image) => {
    const node = expectedImages.find(
      (candidate) =>
        normalizeImageToken(candidate.content.src ?? candidate.style.backgroundImage) === image
    );

    if (!node) {
      return;
    }

    const sectionContext = sectionContextByNodeId.get(node.id);
    const important = isNodeImportant({
      node,
      sectionContext,
      criticalNodeIds: criticalResourceNodeIds
    });
    const backgroundImage = Boolean(normalizeImageToken(node.style.backgroundImage));

    issues.push(
      createIssue(
        backgroundImage && important
          ? "background-mismatch"
          : important
            ? "important-image-missing"
            : "missing-image",
        node.id,
        backgroundImage && important
          ? "important visual asset missing"
          : important
            ? "important visual asset missing"
            : `Imagem ou background visual perdido: ${image}`,
        {
          severity: important ? "critical" : "blocking"
        }
      )
    );
  });

  buttonMatches.missing.forEach((button) => {
    issues.push(
      createIssue(
        "missing-button",
        button.id,
        `Botao visivel perdido: "${button.text || button.href || button.id}"`,
        {
          severity: "blocking"
        }
      )
    );
  });

  expectedButtons.forEach((button) => {
    if (!button.content.href) {
      return;
    }

    const matched = actual.buttons.some(
      (candidate) =>
        normalizeText(candidate.text) === normalizeText(button.content.text) &&
        candidate.href?.trim() === button.content.href?.trim()
    );

    if (!matched) {
      issues.push(
        createIssue(
          "missing-link",
          button.id,
          `Link do botao nao foi preservado para "${normalizeText(button.content.text)}"`,
          {
            severity: "blocking"
          }
        )
      );
    }
  });

  missingSections.forEach((node) => {
    issues.push(
      createIssue("missing-section", node.id, `Secao visivel perdida: ${node.id}`, {
        severity: "blocking"
      })
    );
  });

  missingCards.forEach((node) => {
    issues.push(
      createIssue("missing-card", node.id, `Card visivel perdido: ${node.id}`, {
        severity: "blocking"
      })
    );
  });

  missingHeaders.forEach((node) => {
    issues.push(
      createIssue("missing-header", node.id, `Header visivel perdido: ${node.id}`, {
        severity: "blocking"
      })
    );
  });

  missingFooters.forEach((node) => {
    issues.push(
      createIssue("missing-footer", node.id, `Footer visivel perdido: ${node.id}`, {
        severity: "blocking"
      })
    );
  });

  missingPositionNodes.forEach((node) => {
    issues.push(
      createIssue(
        "missing-position",
        node.id,
        `No visual sem representacao posicionada no export: ${node.id}`,
        {
          severity: "blocking"
        }
      )
    );
  });

  const themeAudit = auditThemeConsistency({
    sourceThemeAnalysis: params.capture.themeAnalysis,
    previewHtml: params.previewHtml,
    emittedMode: params.mode
  });
  const metrics = buildValidationMetrics({
    layout: params.layout,
    actual,
    sourceThemeBackground:
      themeAudit?.sourceTokens.globalBackground ?? params.capture.themeAnalysis?.designTokens.globalBackground,
    convertedThemeBackground: themeAudit?.convertedTokens.globalBackground
  });

  if (themeAudit && !themeAudit.passed) {
    themeAudit.issues.forEach((issue) => {
      if (issue.type === "theme-mismatch") {
        const convertedBackground = themeAudit.convertedTokens.globalBackground;

        if (
          themeAudit.sourceTheme === "dark" &&
          isClearlyLightColor(convertedBackground)
        ) {
          issues.push(
            createIssue("body-white-on-dark", params.layout.rootNodeId, "dark theme lost", {
              severity: "blocking",
              originalValue: issue.originalValue,
              convertedValue: issue.convertedValue
            })
          );
          return;
        }

        issues.push(
          createIssue("theme-mismatch", params.layout.rootNodeId, issue.message, {
            severity: "critical",
            originalValue: issue.originalValue,
            convertedValue: issue.convertedValue
          })
        );
        return;
      }

      if (issue.type === "card-background-mismatch") {
        issues.push(
          createIssue("card-background-mismatch", params.layout.rootNodeId, issue.message, {
            severity:
              themeAudit.sourceTheme === "dark" && isClearlyLightColor(issue.convertedValue)
                ? "critical"
                : "warning",
            originalValue: issue.originalValue,
            convertedValue: issue.convertedValue
          })
        );
        return;
      }

      if (issue.type === "default-button-style-detected") {
        issues.push(
          createIssue("default-button-style-detected", params.layout.rootNodeId, issue.message, {
            severity: "critical",
            originalValue: issue.originalValue,
            convertedValue: issue.convertedValue
          })
        );
        return;
      }

      if (issue.type === "default-input-style-detected") {
        issues.push(
          createIssue("default-input-style-detected", params.layout.rootNodeId, issue.message, {
            severity: "critical",
            originalValue: issue.originalValue,
            convertedValue: issue.convertedValue
          })
        );
      }
    });
  }

  if (
    typeof metrics.dominantColorDistance === "number" &&
    metrics.sourceDominantColor &&
    metrics.convertedDominantColor &&
    (
      Boolean(resolveDominantColorMismatchSeverity(metrics.dominantColorDistance)) ||
      (isClearlyDarkColor(metrics.sourceDominantColor) &&
        isClearlyLightColor(metrics.convertedDominantColor))
    )
  ) {
    issues.push(
      createIssue("dominant-color-mismatch", params.layout.rootNodeId, "dominant color mismatch", {
        severity:
          (isClearlyDarkColor(metrics.sourceDominantColor) &&
            isClearlyLightColor(metrics.convertedDominantColor)
              ? "blocking"
              : resolveDominantColorMismatchSeverity(metrics.dominantColorDistance)) ?? "critical",
        originalValue: metrics.sourceDominantColor,
        convertedValue: metrics.convertedDominantColor
      })
    );
  }

  if (
    typeof metrics.heightDifferenceRatio === "number" &&
    typeof metrics.originalVisibleHeight === "number" &&
    typeof metrics.convertedVisibleHeight === "number" &&
    metrics.heightDifferenceRatio >= WARNING_HEIGHT_RATIO
  ) {
    issues.push(
      createIssue(
        "height-mismatch",
        params.layout.rootNodeId,
        "page height mismatch",
        {
          severity:
            metrics.heightDifferenceRatio >= BLOCKING_HEIGHT_RATIO
              ? "blocking"
              : metrics.heightDifferenceRatio >= CRITICAL_HEIGHT_RATIO
                ? "critical"
                : "warning",
          originalValue: metrics.originalVisibleHeight,
          convertedValue: metrics.convertedVisibleHeight
        }
      )
    );
  }

  const heroSectionIds = [
    ...new Set([
      ...params.layout.detectedSections
        .filter((section) => section.type === "hero")
        .map((section) => section.id),
      ...(params.layout.semanticIndex.hero ?? [])
    ])
  ];

  heroSectionIds.forEach((heroId) => {
    const heroSubtreeIds = collectLayoutSubtreeIds(params.layout, heroId);
    const heroSection = params.capture.sections?.find((section) => section.nodeId === heroId);
    const heroNode = nodeById.get(heroId);
    const expectsBackgroundImage =
      heroSection?.debug?.cssBackgrounds.some(
        (background) =>
          Boolean(background.backgroundUrls?.length) || Boolean(parseBackgroundUrl(background.backgroundImage))
      ) === true ||
      [...heroSubtreeIds].some((nodeId) => sourceNodeHasBackgroundImage(nodeById.get(nodeId)));
    const expectsOverlay =
      heroSection?.debug?.cssBackgrounds.some((background) => background.hasGradient) === true ||
      [...heroSubtreeIds].some((nodeId) => {
        const node = nodeById.get(nodeId);
        return Boolean(
          node &&
            (
              sourceNodeHasGradient(node) ||
              node.detection?.semanticRole === "overlay" ||
              node.visual?.layer === "overlay"
            )
        );
      });
    const hasMappedBackground =
      heroSection !== undefined || sourceNodeHasVisualBackground(heroNode)
        ? nodeSetHasMappedVisualShell(heroSubtreeIds, actual, elementHasBackgroundSettings)
        : true;
    const hasMappedBackgroundImage = nodeSetHasMappedVisualShell(
      heroSubtreeIds,
      actual,
      elementHasBackgroundImage
    );
    const hasMappedOverlay = nodeSetHasMappedVisualShell(
      heroSubtreeIds,
      actual,
      elementHasGradientOrOverlay
    );

    if (expectsBackgroundImage && !hasMappedBackgroundImage) {
      issues.push(
        createIssue("hero-background-missing", heroId, "hero background missing", {
          severity: "critical"
        })
      );
    }

    if (expectsOverlay && !hasMappedOverlay) {
      issues.push(
        createIssue("hero-overlay-missing", heroId, "hero overlay missing", {
          severity: "critical"
        })
      );
    }

    if ((expectsBackgroundImage || sourceNodeHasVisualBackground(heroNode)) && !hasMappedBackground) {
      issues.push(
        createIssue("background-mismatch", heroId, "important visual asset missing", {
          severity: "critical"
        })
      );
    }
  });

  (["header", "footer"] as const).forEach((role) => {
    const roleNodeIds =
      params.layout.semanticIndex[role] ??
      params.layout.nodes
        .filter((node) => node.detection?.semanticRole === role)
        .map((node) => node.id);

    roleNodeIds.forEach((nodeId) => {
      const node = nodeById.get(nodeId);

      if (!node || !sourceNodeHasVisualBackground(node)) {
        return;
      }

      const subtreeIds = collectLayoutSubtreeIds(params.layout, nodeId);

      if (countRepresentedNodes(subtreeIds, actual) === 0) {
        return;
      }

      const hasMappedBackground = nodeSetHasMappedVisualShell(
        subtreeIds,
        actual,
        elementHasBackgroundSettings
      );

      if (!hasMappedBackground) {
        issues.push(
          createIssue(
            "header-footer-background-mismatch",
            nodeId,
            "header/footer background mismatch",
            {
              severity: isClearlyDarkColor(node.style.backgroundColor) ? "blocking" : "critical",
              originalValue: node.style.backgroundColor
            }
          )
        );
        return;
      }

      const sourceBackground = node.style.backgroundColor;
      const mappedBackgrounds = collectMappedBackgroundColors(subtreeIds, actual);

      if (!sourceBackground || mappedBackgrounds.length === 0) {
        return;
      }

      const distances = mappedBackgrounds
        .map((candidate) => colorDistance(sourceBackground, candidate))
        .filter((distance): distance is number => typeof distance === "number");
      const closestDistance =
        distances.length > 0 ? Math.min(...distances) : undefined;
      const contrastLost =
        isClearlyDarkColor(sourceBackground) &&
        mappedBackgrounds.every((candidate) => isClearlyLightColor(candidate));

      if (
        contrastLost ||
        (typeof closestDistance === "number" &&
          closestDistance >= HEADER_FOOTER_BACKGROUND_DISTANCE)
      ) {
        issues.push(
          createIssue(
            "header-footer-background-mismatch",
            nodeId,
            "header/footer background mismatch",
            {
              severity: contrastLost ? "blocking" : "critical",
              originalValue: sourceBackground,
              convertedValue: mappedBackgrounds[0]
            }
          )
        );
      }
    });
  });

  (params.capture.inputAnalysis.diagnostics.resources ?? [])
    .filter((resource) => resource.critical && resource.nodeId)
    .forEach((resource) => {
      const nodeId = resource.nodeId as string;
      const subtreeIds = collectLayoutSubtreeIds(params.layout, nodeId);
      const matched =
        resource.kind === "background"
          ? nodeSetHasMappedVisualShell(subtreeIds, actual, elementHasBackgroundImage)
          : nodeSetHasMappedVisualShell(
              subtreeIds,
              actual,
              (element) => elementHasImageAsset(element) || elementHasBackgroundImage(element)
            );

      if (matched) {
        return;
      }

      issues.push(
        createIssue(
          resource.kind === "background" ? "background-mismatch" : "important-image-missing",
          nodeId,
          "important visual asset missing",
          {
            severity: resource.importance === "hero" ? "blocking" : "critical"
          }
        )
      );
    });

  pickPrimarySectionIds(params.layout).forEach((sectionId) => {
    const subtreeIds = collectLayoutSubtreeIds(params.layout, sectionId);
    const expectedContentCount = countMeaningfulSubtreeNodes(subtreeIds, nodeById);
    const representedNodes = countRepresentedNodes(subtreeIds, actual);

    if (expectedContentCount < 2) {
      return;
    }

    if (representedNodes === 0) {
      issues.push(
        createIssue("missing-section", sectionId, "Secao principal ausente", {
          severity: "blocking"
        })
      );
      return;
    }

    if (representedNodes <= 1 && expectedContentCount >= 3) {
      issues.push(
        createIssue("empty-section", sectionId, "Secao principal ausente ou vazia", {
          severity: "blocking"
        })
      );
    }
  });

  const finalIssues = dedupeIssues(issues).sort((left, right) => {
    const severityDelta =
      determineIssueSeverityWeight(right.severity) - determineIssueSeverityWeight(left.severity);

    if (severityDelta !== 0) {
      return severityDelta;
    }

    return left.message.localeCompare(right.message);
  });
  const highestSeverity = getHighestSeverity(finalIssues);
  const severityCounts = {
    warning: finalIssues.filter((issue) => issue.severity === "warning").length,
    critical: finalIssues.filter((issue) => issue.severity === "critical").length,
    blocking: finalIssues.filter((issue) => issue.severity === "blocking").length
  };
  const summaryMessages = [
    ...new Set(
      finalIssues
        .filter((issue) => issue.severity !== "warning")
        .map((issue) => issue.message.replace(/\.+$/, ""))
    )
  ].slice(0, 5);
  const blockingReason =
    highestSeverity === "blocking" || highestSeverity === "critical"
      ? `Conversao bloqueada pela auditoria visual: ${summaryMessages.join("; ")}.`
      : undefined;

  return {
    passed: highestSeverity === "none" || highestSeverity === "warning",
    mode: params.mode,
    issueCount: finalIssues.length,
    issues: finalIssues,
    severityCounts,
    highestSeverity,
    blockingReason,
    summaryMessages,
    auditMetrics: metrics,
    stats: {
      expectedTexts: expectedTexts.length,
      matchedTexts: textMatches.matched,
      expectedImages: expectedImages.length,
      matchedImages: imageMatches.matched,
      expectedButtons: expectedButtons.length,
      matchedButtons: buttonMatches.matched,
      expectedLinks: expectedLinks.length,
      matchedLinks: linkMatches.matched,
      expectedSections: expectedSections.length,
      matchedSections: expectedSections.length - missingSections.length,
      expectedCards: expectedCards.length,
      matchedCards: expectedCards.length - missingCards.length,
      expectedHeaders: expectedHeaders.length,
      matchedHeaders: expectedHeaders.length - missingHeaders.length,
      expectedFooters: expectedFooters.length,
      matchedFooters: expectedFooters.length - missingFooters.length,
      expectedPositionedNodes: expectedPositions.length,
      matchedPositionedNodes: expectedPositions.length - missingPositionNodes.length
    }
  };
}

export function assertValidElementorExport(params: {
  capture: PageCapture;
  layout: LayoutDocument;
  document: ElementorDocument;
  mode: OutputMode;
  previewHtml?: string;
}): VisualValidationReport {
  const report = validateElementorExport(params);

  if (!report.passed) {
    throw new VisualValidationError(report);
  }

  return report;
}
