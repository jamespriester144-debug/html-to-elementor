import path from "node:path";

import { auditThemeConsistency } from "@/lib/converter-v3/analyze/theme-detector";
import { createEditableElementorDocumentV3 } from "@/lib/converter-v3/emitters/elementor/editable";
import { createGeometryElementorDocumentV3 } from "@/lib/converter-v3/emitters/elementor/geometry";
import { createHybridElementorDocumentV3 } from "@/lib/converter-v3/emitters/elementor/hybrid";
import { createPixelPerfectElementorDocumentV3 } from "@/lib/converter-v3/emitters/elementor/pixel-perfect";
import { createSnapshotElementorDocumentV3 } from "@/lib/converter-v3/emitters/elementor/snapshot";
import {
  buildElementorStyleBridgeSettings,
  normalizeElementorColorValue,
  resolvePageShellVisualContext
} from "@/lib/converter-v3/emitters/elementor/style-preservation";
import type { PageCapture } from "@/lib/converter-v3/contracts/capture";
import type { LayoutDocument, LayoutNode, OutputMode } from "@/lib/converter-v3/contracts/layout";
import type {
  SnapshotVisualSummary,
  VisualValidationReport
} from "@/lib/converter-v3/contracts/output";
import { buildConvertedPreviewHtml } from "@/lib/converter-v3/debug/conversion-debug";
import {
  VisualValidationError,
  validateElementorExport
} from "@/lib/converter-v3/visual-regression-validator";
import {
  compareImagesPixelByPixel,
  renderHtmlToScreenshot
} from "@/lib/converter-v3/visual-similarity";
import {
  VISUAL_REASON_DARK_THEME,
  VISUAL_REASON_FALLBACK_PIXEL_PERFECT,
  VISUAL_REASON_FALLBACK_SNAPSHOT,
  VISUAL_REASON_HERO_BACKGROUND,
  VISUAL_REASON_STRUCTURAL_AUDIT,
  shouldForceUniversalFullPageSnapshot
} from "@/lib/converter-v3/visual-clone-policy";
import { isForceFullPageSnapshotEnabled, isForceVisualSnapshotEnabled } from "@/lib/env";
import type { ElementorDocument, ElementorElement } from "@/types/conversion";

export type NativeExporterResult = {
  document: ElementorDocument;
  emittedMode: OutputMode;
  exportStage: string;
  fallbackReason?: string;
  warnings: string[];
  validation: VisualValidationReport;
  previewHtml?: string;
  snapshot?: SnapshotVisualSummary;
};

type EmittedCandidate = {
  document: ElementorDocument;
  emittedMode: OutputMode;
  exportStage: string;
  warnings: string[];
  fallbackReason?: string;
  previewHtml?: string;
  snapshot?: SnapshotVisualSummary;
};

type InternalCandidateMode = OutputMode | "geometry";
type StructuralVisualAssessment = {
  passed: boolean;
  similarity: number;
  previewHtml: string;
  convertedScreenshotPath?: string;
  diffScreenshotPath?: string;
};

type StructuralVisualAudit = {
  passed: boolean;
  reasons: string[];
};

type ParsedGradient = {
  type: "linear" | "radial";
  colorA: string;
  colorB: string;
  colorStopA: number;
  colorStopB: number;
  angle?: number;
  position?: string;
};

type ParsedBackgroundStyle = {
  imageUrl?: string;
  imageLayerIndex?: number;
  gradient?: ParsedGradient;
};

const STRUCTURAL_VISUAL_SIMILARITY_THRESHOLD = 0.99;

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

  const match = value.trim().match(/^url\((['"]?)(.*?)\1\)$/i);
  return match?.[2]?.trim() || undefined;
}

function parseCssAngle(value: string) {
  const match = value.trim().toLowerCase().match(/^(-?\d+(?:\.\d+)?)(deg|turn|rad)$/i);

  if (!match) {
    return undefined;
  }

  const amount = Number.parseFloat(match[1]);

  if (!Number.isFinite(amount)) {
    return undefined;
  }

  const unit = match[2].toLowerCase();
  let degrees = amount;

  if (unit === "turn") {
    degrees = amount * 360;
  } else if (unit === "rad") {
    degrees = (amount * 180) / Math.PI;
  }

  const normalized = ((degrees % 360) + 360) % 360;
  return Number.parseFloat(normalized.toFixed(2));
}

function parseLinearGradientDirection(value: string) {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");

  switch (normalized) {
    case "to top":
      return 0;
    case "to top right":
    case "to right top":
      return 45;
    case "to right":
      return 90;
    case "to bottom right":
    case "to right bottom":
      return 135;
    case "to bottom":
      return 180;
    case "to bottom left":
    case "to left bottom":
      return 225;
    case "to left":
      return 270;
    case "to top left":
    case "to left top":
      return 315;
    default:
      return undefined;
  }
}

function normalizeGradientPosition(value?: string) {
  const normalized = value?.trim().replace(/\s+/g, " ");

  if (!normalized) {
    return undefined;
  }

  switch (normalized.toLowerCase()) {
    case "center":
      return "center center";
    case "left":
      return "left center";
    case "right":
      return "right center";
    case "top":
      return "center top";
    case "bottom":
      return "center bottom";
    default:
      return normalized;
  }
}

function parseGradientColorStop(value: string) {
  const trimmed = value.trim();

  if (!trimmed) {
    return undefined;
  }

  const match = trimmed.match(/^(.*?)(?:\s+(-?\d+(?:\.\d+)?)%)?$/);

  if (!match?.[1]?.trim()) {
    return undefined;
  }

  const stopValue = match[2] !== undefined ? Number.parseFloat(match[2]) : undefined;

  return {
    color: match[1].trim(),
    stop: Number.isFinite(stopValue) ? stopValue : undefined
  };
}

function looksLikeRadialGradientDescriptor(value: string) {
  const normalized = value.trim().toLowerCase();
  return (
    /\bat\b/.test(normalized) ||
    /\bcircle\b/.test(normalized) ||
    /\bellipse\b/.test(normalized) ||
    /\bclosest-side\b/.test(normalized) ||
    /\bfarthest-side\b/.test(normalized) ||
    /\bclosest-corner\b/.test(normalized) ||
    /\bfarthest-corner\b/.test(normalized)
  );
}

function parseCssGradient(value: string): ParsedGradient | undefined {
  const match = value.trim().match(/^(linear|radial)-gradient\((.*)\)$/i);

  if (!match) {
    return undefined;
  }

  const type = match[1].toLowerCase() as ParsedGradient["type"];
  const segments = splitCssSegments(match[2]);

  if (segments.length < 2) {
    return undefined;
  }

  let cursor = 0;
  let angle: number | undefined;
  let position: string | undefined;

  if (type === "linear") {
    angle = parseCssAngle(segments[0]) ?? parseLinearGradientDirection(segments[0]);

    if (angle !== undefined) {
      cursor = 1;
    }
  } else if (looksLikeRadialGradientDescriptor(segments[0])) {
    const descriptor = segments[0];
    const positionMatch = descriptor.match(/\bat\s+(.+)$/i);
    position = normalizeGradientPosition(positionMatch?.[1] ?? "center center");
    cursor = 1;
  }

  const colorStops = segments
    .slice(cursor)
    .map(parseGradientColorStop)
    .filter((stop): stop is NonNullable<ReturnType<typeof parseGradientColorStop>> => Boolean(stop));

  if (colorStops.length < 2) {
    return undefined;
  }

  const firstStop = colorStops[0];
  const lastStop = colorStops[colorStops.length - 1];

  if (!firstStop || !lastStop) {
    return undefined;
  }

  return {
    type,
    colorA: normalizeElementorColorValue(firstStop.color) ?? firstStop.color,
    colorB: normalizeElementorColorValue(lastStop.color) ?? lastStop.color,
    colorStopA: firstStop.stop ?? 0,
    colorStopB: lastStop.stop ?? 100,
    angle,
    position
  };
}

function parseBackgroundStyle(value?: string): ParsedBackgroundStyle {
  if (!value || value === "none") {
    return {};
  }

  const layers = splitCssSegments(value);
  let imageUrl: string | undefined;
  let imageLayerIndex: number | undefined;
  let gradient: ParsedGradient | undefined;

  layers.forEach((layer, index) => {
    const parsedUrl = parseBackgroundUrl(layer);

    if (parsedUrl) {
      imageUrl = parsedUrl;
      imageLayerIndex = index;
      return;
    }

    gradient = gradient ?? parseCssGradient(layer);
  });

  return {
    imageUrl,
    imageLayerIndex,
    gradient
  };
}

function pickCssLayerValue(value: string | undefined, layerIndex: number | undefined) {
  if (!value) {
    return undefined;
  }

  const layers = splitCssSegments(value);

  if (!layers.length) {
    return undefined;
  }

  return layers[layerIndex ?? layers.length - 1] ?? layers[layers.length - 1];
}

function buildNodeMap(layout: LayoutDocument) {
  return new Map(layout.nodes.map((node) => [node.id, node]));
}

function normalizeBackgroundSize(value?: string) {
  if (!value || value === "auto") {
    return undefined;
  }

  if (/cover|contain/i.test(value)) {
    return value.toLowerCase();
  }

  return undefined;
}

function hasMeaningfulBackgroundColor(value?: string) {
  if (!value) {
    return false;
  }

  const normalized = value.replace(/\s+/g, "").toLowerCase();
  return normalized !== "transparent" && normalized !== "rgba(0,0,0,0)" && normalized !== "none";
}

function createElementorUnitValue(unit: "%" | "deg", size: number) {
  return {
    unit,
    size: Number.parseFloat(size.toFixed(2)),
    sizes: []
  };
}

function setMirroredSetting(
  settings: ElementorElement["settings"],
  key: string,
  value: unknown
) {
  if (value === undefined) {
    return;
  }

  settings[key] = value;
  settings[`_${key}`] = value;
}

function applyGradientSettings(
  settings: ElementorElement["settings"],
  keyPrefix: "background" | "background_overlay",
  gradient: ParsedGradient
) {
  setMirroredSetting(settings, `${keyPrefix}_background`, "gradient");
  setMirroredSetting(settings, `${keyPrefix}_color`, gradient.colorA);
  setMirroredSetting(settings, `${keyPrefix}_color_b`, gradient.colorB);
  setMirroredSetting(
    settings,
    `${keyPrefix}_color_stop`,
    createElementorUnitValue("%", gradient.colorStopA)
  );
  setMirroredSetting(
    settings,
    `${keyPrefix}_color_b_stop`,
    createElementorUnitValue("%", gradient.colorStopB)
  );
  setMirroredSetting(settings, `${keyPrefix}_gradient_type`, gradient.type);

  if (typeof gradient.angle === "number") {
    setMirroredSetting(
      settings,
      `${keyPrefix}_gradient_angle`,
      createElementorUnitValue("deg", gradient.angle)
    );
  }

  if (gradient.position) {
    setMirroredSetting(
      settings,
      `${keyPrefix}_gradient_position`,
      normalizeGradientPosition(gradient.position)
    );
  }
}

function applySourceNodeMetadata(
  element: ElementorElement,
  nodeById: Map<string, LayoutNode>,
  captureById: Map<string, PageCapture["nodes"][number]>
): ElementorElement {
  const sourceNodeId =
    typeof element.settings.converter_v3_source_node_id === "string"
      ? element.settings.converter_v3_source_node_id
      : undefined;
  const pageShellCaptureNodeId =
    typeof element.settings.converter_v3_page_shell_capture_node_id === "string"
      ? element.settings.converter_v3_page_shell_capture_node_id
      : undefined;
  const node = sourceNodeId ? nodeById.get(sourceNodeId) : undefined;
  const captureNode = sourceNodeId ? captureById.get(sourceNodeId) : undefined;
  const pageShellCaptureNode = pageShellCaptureNodeId
    ? captureById.get(pageShellCaptureNodeId)
    : undefined;
  const styleBridge =
    (element.settings.converter_v3_styles as Record<string, string> | undefined) ?? {};
  const nextElement = {
    ...element,
    settings: {
      ...element.settings
    },
    elements: element.elements.map((child) => applySourceNodeMetadata(child, nodeById, captureById))
  };
  const isPageShell = nextElement.settings.converter_v3_page_shell === true;

  if (!node) {
    return nextElement;
  }

  const sourceBackgroundImage = isPageShell
    ? styleBridge["background-image"] ??
      pageShellCaptureNode?.asset.backgroundImage ??
      pageShellCaptureNode?.computedStyles["background-image"] ??
      node?.style.backgroundImage ??
      captureNode?.asset.backgroundImage ??
      captureNode?.computedStyles["background-image"]
    : node?.style.backgroundImage ??
      captureNode?.asset.backgroundImage ??
      captureNode?.computedStyles["background-image"] ??
      pageShellCaptureNode?.asset.backgroundImage ??
      pageShellCaptureNode?.computedStyles["background-image"] ??
      styleBridge["background-image"];
  const backgroundStyle = parseBackgroundStyle(sourceBackgroundImage);
  const backgroundImageUrl = backgroundStyle.imageUrl;

  const bridgeSettings = buildElementorStyleBridgeSettings({
    node,
    captureNode,
    isButton: nextElement.widgetType === "button"
  });

  Object.entries(bridgeSettings).forEach(([key, value]) => {
    if (value === undefined || nextElement.settings[key] !== undefined) {
      return;
    }

    nextElement.settings[key] = value;
  });

  nextElement.settings.converter_v3_semantic_role = node.detection?.semanticRole;
  nextElement.settings.converter_v3_visual_layer = node.visual?.layer;
  nextElement.settings.converter_v3_overlap_ids = node.visual?.overlapIds;
  nextElement.settings.converter_v3_z_index = node.visual?.effectiveZIndex;

  const existingBackgroundColor = hasMeaningfulBackgroundColor(
    String(nextElement.settings.background_color ?? "")
  )
    ? String(nextElement.settings.background_color)
    : undefined;
  const sourceBackgroundColor =
    (hasMeaningfulBackgroundColor(node.style.backgroundColor)
      ? node.style.backgroundColor
      : undefined) ??
    (hasMeaningfulBackgroundColor(captureNode?.computedStyles["background-color"])
      ? captureNode?.computedStyles["background-color"]
      : undefined);
  const shellBackgroundColor =
    (hasMeaningfulBackgroundColor(pageShellCaptureNode?.computedStyles["background-color"])
      ? pageShellCaptureNode?.computedStyles["background-color"]
      : undefined) ??
    (hasMeaningfulBackgroundColor(styleBridge["background-color"])
      ? styleBridge["background-color"]
      : undefined);
  const resolvedBackgroundColorRaw = isPageShell
    ? existingBackgroundColor ?? shellBackgroundColor ?? sourceBackgroundColor
    : sourceBackgroundColor ?? shellBackgroundColor ?? existingBackgroundColor;
  const resolvedBackgroundColor = normalizeElementorColorValue(resolvedBackgroundColorRaw);
  const existingTextColor =
    typeof nextElement.settings.color === "string" && nextElement.settings.color.trim()
      ? nextElement.settings.color.trim()
      : typeof nextElement.settings.text_color === "string" && nextElement.settings.text_color.trim()
        ? nextElement.settings.text_color.trim()
        : typeof nextElement.settings.title_color === "string" &&
            nextElement.settings.title_color.trim()
          ? nextElement.settings.title_color.trim()
          : undefined;
  const sourceTextColor = node.style.color || captureNode?.computedStyles.color;
  const shellTextColor = pageShellCaptureNode?.computedStyles.color || styleBridge.color;
  const resolvedTextColorRaw = isPageShell
    ? existingTextColor ?? shellTextColor ?? sourceTextColor
    : sourceTextColor ?? shellTextColor ?? existingTextColor;
  const resolvedTextColor = normalizeElementorColorValue(resolvedTextColorRaw);

  if (typeof node.visual?.effectiveZIndex === "number" && node.visual.effectiveZIndex > 0) {
    nextElement.settings.z_index = node.visual.effectiveZIndex;
  }

  if ((nextElement.elType === "container" || nextElement.elType === "section") && resolvedBackgroundColor) {
    setMirroredSetting(nextElement.settings, "background_color", resolvedBackgroundColor);
    setMirroredSetting(
      nextElement.settings,
      "background_background",
      nextElement.settings.background_background ?? "classic"
    );
  }

  if (resolvedTextColor) {
    setMirroredSetting(nextElement.settings, "color", resolvedTextColor);
    setMirroredSetting(nextElement.settings, "text_color", resolvedTextColor);
    setMirroredSetting(nextElement.settings, "title_color", resolvedTextColor);
  }

  if (backgroundImageUrl && (nextElement.elType === "container" || nextElement.elType === "section")) {
    const backgroundPosition = pickCssLayerValue(
      node.style.backgroundPosition ||
        captureNode?.computedStyles["background-position"] ||
        pageShellCaptureNode?.computedStyles["background-position"] ||
        styleBridge["background-position"],
      backgroundStyle.imageLayerIndex
    );
    const backgroundSize = pickCssLayerValue(
      node.style.backgroundSize ||
        captureNode?.computedStyles["background-size"] ||
        pageShellCaptureNode?.computedStyles["background-size"] ||
        styleBridge["background-size"],
      backgroundStyle.imageLayerIndex
    );

    setMirroredSetting(nextElement.settings, "background_background", "classic");
    setMirroredSetting(nextElement.settings, "background_image", {
      url: backgroundImageUrl
    });
    setMirroredSetting(nextElement.settings, "background_position", backgroundPosition);
    setMirroredSetting(
      nextElement.settings,
      "background_size",
      normalizeBackgroundSize(backgroundSize)
    );
  }

  if (
    backgroundStyle.gradient &&
    (nextElement.elType === "container" || nextElement.elType === "section")
  ) {
    applyGradientSettings(
      nextElement.settings,
      backgroundImageUrl ? "background_overlay" : "background",
      backgroundStyle.gradient
    );
  }

  if (node.detection?.semanticRole === "header") {
    nextElement.settings.html_tag = "header";
  } else if (node.detection?.semanticRole === "footer") {
    nextElement.settings.html_tag = "footer";
  } else if (node.kind === "section") {
    nextElement.settings.html_tag = "section";
  }

  return nextElement;
}

function enrichDocument(
  document: ElementorDocument,
  layout: LayoutDocument,
  capture: PageCapture
): ElementorDocument {
  const nodeById = buildNodeMap(layout);
  const captureById = new Map(capture.nodes.map((node) => [node.id, node]));

  return {
    ...document,
    content: document.content.map((element) => applySourceNodeMetadata(element, nodeById, captureById))
  };
}

function buildEditableCandidate(params: {
  capture: PageCapture;
  layout: LayoutDocument;
  selectedMode: OutputMode;
}): EmittedCandidate {
  const editableResult = createEditableElementorDocumentV3(params);
  const emittedMode = editableResult.usedHtmlFallbackNodeIds.length === 0 ? "editable" : "hybrid";
  const fallbackReason =
    editableResult.usedHtmlFallbackNodeIds.length > 0
      ? "Exportador nativo precisou preservar parte do layout em HTML para manter a fidelidade visual; exportando em hybrid."
      : undefined;

  return {
    document: editableResult.document,
    emittedMode,
    exportStage: emittedMode === "hybrid" ? "editable-emitter:html-fallback" : "editable-emitter",
    warnings: editableResult.warnings,
    fallbackReason
  };
}

function buildHybridCandidate(params: {
  capture: PageCapture;
  layout: LayoutDocument;
  selectedMode: OutputMode;
}): EmittedCandidate {
  const hybridResult = createHybridElementorDocumentV3(params);

  return {
    document: hybridResult.document,
    emittedMode: "hybrid",
    exportStage: "hybrid-emitter",
    warnings: hybridResult.warnings
  };
}

function buildGeometryCandidate(params: {
  capture: PageCapture;
  layout: LayoutDocument;
}): EmittedCandidate {
  const geometryResult = createGeometryElementorDocumentV3(params);

  return {
    document: geometryResult.document,
    emittedMode: "hybrid",
    exportStage: "geometry-emitter",
    warnings: geometryResult.warnings,
    fallbackReason:
      geometryResult.groups.length > 0
        ? "Fallback generico por geometria visual preservou grupos do DOM renderizado em HTML estruturado."
        : "Fallback generico por geometria visual nao encontrou grupos suficientes."
  };
}

async function buildSnapshotCandidate(params: {
  capture: PageCapture;
  layout: LayoutDocument;
  selectedMode: OutputMode;
  outputDir?: string;
}): Promise<EmittedCandidate> {
  const sections = params.capture.sections ?? [];
  const snapshotResult = await createSnapshotElementorDocumentV3({
    capture: params.capture,
    layout: params.layout,
    sections,
    selectedMode: params.selectedMode,
    outputDir: params.outputDir
  });

  return {
    document: snapshotResult.document,
    emittedMode: "snapshot",
    exportStage:
      snapshotResult.snapshot?.renderStrategy === "full-page-snapshot"
        ? "full-page-snapshot"
        : "section-snapshot",
    warnings: snapshotResult.warnings,
    previewHtml: snapshotResult.previewHtml,
    snapshot: snapshotResult.snapshot
  };
}

function buildPixelPerfectCandidate(params: {
  capture: PageCapture;
  layout: LayoutDocument;
  selectedMode: OutputMode;
  fallbackReason?: string;
}): EmittedCandidate {
  const pageShell = resolvePageShellVisualContext({
    capture: params.capture,
    layout: params.layout
  });
  const shellStyleMap = pageShell.shouldWrap ? pageShell.styleMap : undefined;

  return {
    document: createPixelPerfectElementorDocumentV3(params.capture.renderedHtml, {
      title: params.capture.title,
      selectedMode: params.selectedMode,
      fallbackReason: params.fallbackReason,
      shellStyleMap
    }),
    emittedMode: "pixel-perfect",
    exportStage: "pixel-perfect-emitter",
    warnings: params.fallbackReason ? [params.fallbackReason] : [],
    fallbackReason: params.fallbackReason
  };
}

function getCandidateModes(params: {
  selectedMode: OutputMode;
  forceFullPageSnapshot: boolean;
  forceVisualSnapshot: boolean;
  renderer: PageCapture["renderer"];
}): InternalCandidateMode[] {
  const { selectedMode, forceFullPageSnapshot, forceVisualSnapshot, renderer } = params;

  if (renderer !== "browser" && (selectedMode === "pixel-perfect" || selectedMode === "snapshot")) {
    return ["pixel-perfect"];
  }

  if (forceFullPageSnapshot) {
    return ["snapshot", "pixel-perfect"];
  }

  if (forceVisualSnapshot) {
    return ["snapshot", "pixel-perfect"];
  }

  if (selectedMode === "snapshot") {
    return ["snapshot", "pixel-perfect"];
  }

  if (renderer !== "browser") {
    if (selectedMode === "editable") {
      return ["editable", "hybrid", "geometry", "pixel-perfect"];
    }

    if (selectedMode === "hybrid") {
      return ["hybrid", "geometry", "pixel-perfect"];
    }

    return ["geometry", "pixel-perfect"];
  }

  if (selectedMode === "editable") {
    return ["editable", "hybrid", "geometry", "snapshot", "pixel-perfect"];
  }

  if (selectedMode === "hybrid") {
    return ["hybrid", "geometry", "snapshot", "pixel-perfect"];
  }

  if (selectedMode === "pixel-perfect") {
    return ["hybrid", "geometry", "snapshot", "pixel-perfect"];
  }

  return ["hybrid", "geometry", "snapshot", "pixel-perfect"];
}

function appendFallbackContinuationWarning(
  warnings: string[],
  attemptedModes: InternalCandidateMode[],
  index: number
) {
  const nextMode = attemptedModes[index + 1];

  if (nextMode === "snapshot") {
    warnings.push(VISUAL_REASON_FALLBACK_SNAPSHOT);
  } else if (nextMode === "pixel-perfect") {
    warnings.push(VISUAL_REASON_FALLBACK_PIXEL_PERFECT);
  }
}

async function assessStructuralVisualFidelity(params: {
  capture: PageCapture;
  document: ElementorDocument;
  emittedMode: OutputMode;
  outputDir?: string;
  previewHtml?: string;
}): Promise<StructuralVisualAssessment | null> {
  const originalScreenshotPath = params.capture.artifacts.screenshots.desktop;
  const desktopViewport =
    params.capture.viewports.find((viewport) => viewport.name === "desktop") ??
    params.capture.viewports[0];

  if (!originalScreenshotPath || !desktopViewport) {
    return null;
  }

  const previewHtml =
    params.previewHtml ??
    buildConvertedPreviewHtml({
      capture: params.capture,
      document: params.document
    });
  const outputBasePath = params.outputDir
    ? path.join(params.outputDir, `structural-visual-${params.emittedMode}`)
    : undefined;

  try {
    const rendered = await renderHtmlToScreenshot({
      html: previewHtml,
      viewportWidth: desktopViewport.width,
      viewportHeight: desktopViewport.height,
      outputPath: outputBasePath ? `${outputBasePath}.png` : undefined,
      fullPage: true
    });
    const comparison = await compareImagesPixelByPixel({
      reference: originalScreenshotPath,
      candidate: rendered.outputPath ?? rendered.dataUrl,
      similarityThreshold: STRUCTURAL_VISUAL_SIMILARITY_THRESHOLD,
      diffOutputPath: outputBasePath ? `${outputBasePath}-diff.png` : undefined
    });

    return {
      passed: comparison.passed,
      similarity: comparison.similarity,
      previewHtml,
      convertedScreenshotPath: rendered.outputPath,
      diffScreenshotPath: comparison.diffOutputPath
    };
  } catch {
    return {
      passed: false,
      similarity: 0,
      previewHtml
    };
  }
}

function buildSnapshotValidationFailure(
  rootNodeId: string,
  baseValidation: VisualValidationReport,
  snapshot: SnapshotVisualSummary
): VisualValidationReport {
  const issues: VisualValidationReport["issues"] =
    snapshot.visualValidationReport?.issues?.map((issue) => ({
      type: "missing-position" as const,
      nodeId: issue.sectionId ?? rootNodeId,
      message: issue.message,
      severity: issue.severity === "critical" ? ("critical" as const) : ("warning" as const),
      sectionId: issue.sectionId,
      sectionName: issue.sectionName,
      sectionType: issue.sectionType,
      sectionTypeLabel: issue.sectionTypeLabel,
      viewport: issue.viewport,
      similarity: issue.similarity,
      similarityPercent: issue.similarityPercent,
      lossType: issue.lossType,
      estimatedLossCount: issue.estimatedLossCount,
      estimatedLosses: issue.estimatedLosses,
      bbox: issue.bbox,
      originalScreenshotPath: issue.originalScreenshotPath,
      convertedScreenshotPath: issue.convertedScreenshotPath,
      diffScreenshotPath: issue.diffScreenshotPath
    })) ?? [];
  const blockingReason =
    snapshot.visualValidationReport?.blockingReason ??
    `Similaridade visual final ficou em ${(
      snapshot.overallSimilarity * 100
    ).toFixed(2)}%, abaixo do minimo de ${(snapshot.threshold * 100).toFixed(2)}%.`;
  const resolvedIssues =
    issues.length > 0
      ? issues
      : [
          {
            type: "missing-position" as const,
            nodeId: rootNodeId,
            message: blockingReason,
            severity: "critical" as const
          }
        ];

  return {
    ...baseValidation,
    passed: false,
    issueCount: resolvedIssues.length,
    severityCounts: {
      warning: resolvedIssues.filter((issue) => issue.severity === "warning").length,
      critical: resolvedIssues.filter((issue) => issue.severity === "critical").length,
      blocking: 0
    },
    highestSeverity: resolvedIssues.some((issue) => issue.severity === "critical") ? "critical" : "warning",
    blockingReason,
    summaryMessages: [blockingReason],
    issues: resolvedIssues
  };
}

function readSourceNodeId(element: ElementorElement) {
  const value = element.settings?.converter_v3_source_node_id;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readMappedSourceNodeIds(element: ElementorElement) {
  const ids = new Set<string>();
  const sourceNodeId = readSourceNodeId(element);
  const pageShellCaptureNodeId = element.settings?.converter_v3_page_shell_capture_node_id;

  if (sourceNodeId) {
    ids.add(sourceNodeId);
  }

  if (typeof pageShellCaptureNodeId === "string" && pageShellCaptureNodeId.trim().length > 0) {
    ids.add(pageShellCaptureNodeId.trim());
  }

  return [...ids];
}

function collectDocumentSourceIndex(document: ElementorDocument) {
  const elementsBySourceNodeId = new Map<string, ElementorElement[]>();
  const htmlPreservedNodeIds = new Set<string>();
  const queue = [...document.content];

  while (queue.length > 0) {
    const element = queue.shift();

    if (!element) {
      continue;
    }

    readMappedSourceNodeIds(element).forEach((sourceNodeId) => {
      const elements = elementsBySourceNodeId.get(sourceNodeId) ?? [];
      elements.push(element);
      elementsBySourceNodeId.set(sourceNodeId, elements);
    });

    if (element.widgetType === "html") {
      const html = String(element.settings?.html ?? "");

      [...html.matchAll(/data-capture-id="([^"]+)"/g)].forEach((match) => {
        if (match[1]) {
          htmlPreservedNodeIds.add(match[1]);
        }
      });
    }

    queue.push(...element.elements);
  }

  return {
    elementsBySourceNodeId,
    htmlPreservedNodeIds
  };
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

function hasBackgroundSettings(element: ElementorElement) {
  return (
    hasMeaningfulBackgroundColor(String(element.settings?.background_color ?? "")) ||
    hasBackgroundAsset(element.settings?.background_image) ||
    hasGradientSetting(element.settings, "background") ||
    hasGradientSetting(element.settings, "background_overlay") ||
    hasMeaningfulBackgroundColor(String(element.settings?.background_overlay_color ?? ""))
  );
}

function hasRadiusSettings(element: ElementorElement) {
  const value = element.settings?.border_radius;

  if (typeof value === "string") {
    const numeric = Number.parseFloat(value);
    return Number.isFinite(numeric) && numeric > 0;
  }

  if (typeof value === "number") {
    return value > 0;
  }

  return false;
}

function hasShadowSettings(element: ElementorElement) {
  const value = String(element.settings?.box_shadow ?? "").trim().toLowerCase();
  return Boolean(value && value !== "none");
}

function sourceNodeHasVisualBackground(node: LayoutNode) {
  return (
    hasMeaningfulBackgroundColor(node.style.backgroundColor) ||
    Boolean(parseBackgroundStyle(node.style.backgroundImage).imageUrl) ||
    Boolean(parseBackgroundStyle(node.style.backgroundImage).gradient)
  );
}

function nodeSetHasMappedVisualShell(
  nodeIds: Set<string>,
  elementsBySourceNodeId: Map<string, ElementorElement[]>,
  htmlPreservedNodeIds: Set<string>,
  matcher: (element: ElementorElement) => boolean
) {
  for (const nodeId of nodeIds) {
    if (htmlPreservedNodeIds.has(nodeId)) {
      return true;
    }

    const elements = elementsBySourceNodeId.get(nodeId) ?? [];

    if (elements.some(matcher)) {
      return true;
    }
  }

  return false;
}

function auditStructuralVisualFidelity(params: {
  capture: PageCapture;
  layout: LayoutDocument;
  document: ElementorDocument;
  emittedMode: OutputMode;
  previewHtml?: string;
}): StructuralVisualAudit {
  if (
    params.emittedMode === "snapshot" ||
    params.emittedMode === "pixel-perfect" ||
    params.capture.renderer !== "browser"
  ) {
    return {
      passed: true,
      reasons: []
    };
  }

  const { elementsBySourceNodeId, htmlPreservedNodeIds } = collectDocumentSourceIndex(params.document);
  const nodeById = new Map(params.layout.nodes.map((node) => [node.id, node]));
  const reasons: string[] = [];
  const themeAudit = auditThemeConsistency({
    sourceThemeAnalysis: params.capture.themeAnalysis,
    previewHtml: params.previewHtml,
    emittedMode: params.emittedMode
  });

  if (themeAudit?.issues.some((issue) => issue.type === "theme-mismatch")) {
    reasons.push(VISUAL_REASON_DARK_THEME);
  }

  if (themeAudit?.issues.some((issue) => issue.type === "default-button-style-detected")) {
    reasons.push("buttons default");
  }

  if (themeAudit?.issues.some((issue) => issue.type === "default-input-style-detected")) {
    reasons.push("inputs default");
  }

  if (themeAudit?.issues.some((issue) => issue.type === "card-background-mismatch")) {
    reasons.push("cards lost background/radius/shadow");
  }

  const heroSectionIds = [
    ...new Set([
      ...params.layout.detectedSections
        .filter((section) => section.type === "hero")
        .map((section) => section.id),
      ...(params.layout.semanticIndex.hero ?? [])
    ])
  ];

  const heroLostBackground = heroSectionIds.some((heroId) => {
    const subtreeIds = collectLayoutSubtreeIds(params.layout, heroId);
    const visualHeroNodeIds = new Set(
      [...subtreeIds].filter((nodeId) => {
        const node = nodeById.get(nodeId);
        return Boolean(
          node &&
            (
              sourceNodeHasVisualBackground(node) ||
              node.detection?.semanticRole === "overlay" ||
              node.visual?.layer === "overlay"
            )
        );
      })
    );

    if (visualHeroNodeIds.size === 0) {
      return false;
    }

    return !nodeSetHasMappedVisualShell(
      visualHeroNodeIds,
      elementsBySourceNodeId,
      htmlPreservedNodeIds,
      hasBackgroundSettings
    );
  });

  if (heroLostBackground) {
    reasons.push(VISUAL_REASON_HERO_BACKGROUND);
  }

  const cardNodes = params.layout.nodes.filter((node) => node.detection?.semanticRole === "card");
  const cardsLostShell = cardNodes.some((cardNode) => {
    const expectsBackground = sourceNodeHasVisualBackground(cardNode);
    const expectsRadius = Boolean(cardNode.style.borderRadius?.trim()) && cardNode.style.borderRadius !== "0px";
    const expectsShadow = Boolean(cardNode.style.boxShadow?.trim()) && cardNode.style.boxShadow !== "none";

    if (!expectsBackground && !expectsRadius && !expectsShadow) {
      return false;
    }

    const subtreeIds = collectLayoutSubtreeIds(params.layout, cardNode.id);

    return !nodeSetHasMappedVisualShell(
      subtreeIds,
      elementsBySourceNodeId,
      htmlPreservedNodeIds,
      (element) =>
        (!expectsBackground || hasBackgroundSettings(element)) &&
        (!expectsRadius || hasRadiusSettings(element)) &&
        (!expectsShadow || hasShadowSettings(element))
    );
  });

  if (cardsLostShell) {
    reasons.push("cards lost background/radius/shadow");
  }

  const headerFooterBackgroundLost = (["header", "footer"] as const).flatMap((role) => {
    const roleNodeIds =
      params.layout.semanticIndex[role] ??
      params.layout.nodes
        .filter((node) => node.detection?.semanticRole === role)
        .map((node) => node.id);

    return roleNodeIds.filter((nodeId) => {
      const node = nodeById.get(nodeId);

      if (!node || !sourceNodeHasVisualBackground(node)) {
        return false;
      }

      const subtreeIds = collectLayoutSubtreeIds(params.layout, nodeId);

      return !nodeSetHasMappedVisualShell(
        subtreeIds,
        elementsBySourceNodeId,
        htmlPreservedNodeIds,
        hasBackgroundSettings
      );
    });
  });

  if (headerFooterBackgroundLost.length > 0) {
    reasons.push("header/footer background lost");
  }

  return {
    passed: reasons.length === 0,
    reasons: [...new Set(reasons)]
  };
}

export async function createElementorNativeExport(params: {
  capture: PageCapture;
  layout: LayoutDocument;
  selectedMode: OutputMode;
  outputDir?: string;
}): Promise<NativeExporterResult> {
  const forceFullPageSnapshot =
    isForceFullPageSnapshotEnabled() ||
    shouldForceUniversalFullPageSnapshot(params.capture, params.layout);
  const forceVisualSnapshot = isForceVisualSnapshotEnabled();
  const attemptedModes = getCandidateModes({
    selectedMode: params.selectedMode,
    forceFullPageSnapshot,
    forceVisualSnapshot,
    renderer: params.capture.renderer
  });
  const warnings: string[] = [];
  let lastValidation: VisualValidationReport | null = null;
  let lastAttempt: NativeExporterResult | null = null;

  for (const [index, mode] of attemptedModes.entries()) {
    const hasMoreModes = index < attemptedModes.length - 1;
    const candidate =
      mode === "snapshot"
        ? await buildSnapshotCandidate({
            ...params,
            outputDir: params.outputDir
          })
        : mode === "editable"
          ? buildEditableCandidate(params)
        : mode === "hybrid"
          ? buildHybridCandidate(params)
          : mode === "geometry"
            ? buildGeometryCandidate(params)
            : buildPixelPerfectCandidate({
                capture: params.capture,
                layout: params.layout,
                selectedMode: params.selectedMode,
                fallbackReason:
                  `${VISUAL_REASON_FALLBACK_PIXEL_PERFECT}: fallback final em iframe por perda detectada nas exportacoes nativas.`
              });
    const enrichedDocument =
      candidate.emittedMode === "pixel-perfect"
        ? candidate.document
        : enrichDocument(candidate.document, params.layout, params.capture);
    const structuralPreviewHtml =
      candidate.emittedMode !== "snapshot" && candidate.emittedMode !== "pixel-perfect"
        ? candidate.previewHtml ??
          buildConvertedPreviewHtml({
            capture: params.capture,
            document: enrichedDocument
          })
        : candidate.previewHtml;

    if (structuralPreviewHtml && !candidate.previewHtml) {
      candidate.previewHtml = structuralPreviewHtml;
    }

    const validation = validateElementorExport({
      capture: params.capture,
      layout: params.layout,
      document: enrichedDocument,
      mode: candidate.emittedMode,
      previewHtml: candidate.previewHtml
    });

    warnings.push(...candidate.warnings);
    lastValidation = validation;
    lastAttempt = {
      document: enrichedDocument,
      emittedMode: candidate.emittedMode,
      exportStage: candidate.exportStage,
      fallbackReason: candidate.fallbackReason,
      warnings: [...warnings],
      validation,
      previewHtml: candidate.previewHtml,
      snapshot: candidate.snapshot
    };

    const structuralVisualAssessment =
      params.capture.renderer === "browser" &&
      candidate.emittedMode !== "snapshot" &&
      candidate.emittedMode !== "pixel-perfect"
        ? await assessStructuralVisualFidelity({
            capture: params.capture,
            document: enrichedDocument,
            emittedMode: candidate.emittedMode,
            outputDir: params.outputDir,
            previewHtml: candidate.previewHtml
          })
        : null;

    if (structuralVisualAssessment?.previewHtml) {
      candidate.previewHtml = structuralVisualAssessment.previewHtml;
      lastAttempt.previewHtml = structuralVisualAssessment.previewHtml;
    }

    const structuralVisualAudit =
      candidate.emittedMode !== "snapshot" && candidate.emittedMode !== "pixel-perfect"
        ? auditStructuralVisualFidelity({
            capture: params.capture,
            layout: params.layout,
            document: enrichedDocument,
            emittedMode: candidate.emittedMode,
            previewHtml: structuralPreviewHtml
          })
        : null;

    if (structuralVisualAudit && !structuralVisualAudit.passed) {
      warnings.push(VISUAL_REASON_STRUCTURAL_AUDIT, ...structuralVisualAudit.reasons);

      if (hasMoreModes) {
        appendFallbackContinuationWarning(warnings, attemptedModes, index);
        continue;
      }
    }

    if (
      candidate.emittedMode === "snapshot" &&
      candidate.snapshot?.visualValidationReport?.status === "blocked" &&
      !candidate.snapshot.requiresPixelPerfect
    ) {
      lastValidation = buildSnapshotValidationFailure(
        params.layout.rootNodeId,
        validation,
        candidate.snapshot
      );
      warnings.push(
        candidate.snapshot.visualValidationReport.blockingReason ??
          "Snapshot visual falhou na auditoria final; escalando para fallback mais seguro."
      );

      if (hasMoreModes) {
        appendFallbackContinuationWarning(warnings, attemptedModes, index);
        continue;
      }

      if (forceVisualSnapshot) {
        return {
          document: enrichedDocument,
          emittedMode: candidate.emittedMode,
          exportStage: candidate.exportStage,
          fallbackReason: candidate.fallbackReason,
          warnings,
          validation: lastValidation,
          previewHtml: candidate.previewHtml,
          snapshot: candidate.snapshot
        };
      }
    }

    if (
      forceFullPageSnapshot &&
      candidate.emittedMode === "snapshot" &&
      candidate.snapshot?.requiresPixelPerfect
    ) {
      const pixelPerfectReason =
        candidate.snapshot.pixelPerfectReason ??
        `${VISUAL_REASON_FALLBACK_PIXEL_PERFECT}: snapshot da pagina inteira nao pode ser gerado; fallback emergencial para pixel-perfect.`;
      warnings.push(pixelPerfectReason);

      const pixelPerfectCandidate = buildPixelPerfectCandidate({
        capture: params.capture,
        layout: params.layout,
        selectedMode: params.selectedMode,
        fallbackReason: pixelPerfectReason
      });
      const pixelPerfectValidation = validateElementorExport({
        capture: params.capture,
        layout: params.layout,
        document: pixelPerfectCandidate.document,
        mode: pixelPerfectCandidate.emittedMode
      });

      return {
        document: pixelPerfectCandidate.document,
        emittedMode: pixelPerfectCandidate.emittedMode,
        exportStage: pixelPerfectCandidate.exportStage,
        fallbackReason: pixelPerfectReason,
        warnings: [...warnings, ...pixelPerfectCandidate.warnings],
        validation: pixelPerfectValidation,
        previewHtml: pixelPerfectCandidate.previewHtml,
        snapshot: candidate.snapshot
      };
    }

    if (
      candidate.emittedMode === "snapshot" &&
      candidate.snapshot &&
      candidate.snapshot.requiresPixelPerfect
    ) {
      warnings.push(
        candidate.snapshot.pixelPerfectReason ??
          "Uma ou mais secoes exigiram pixel-perfect por perda critica de fidelidade visual."
      );

      if (hasMoreModes) {
        appendFallbackContinuationWarning(warnings, attemptedModes, index);
        continue;
      }
    }

    if (
      candidate.emittedMode === "snapshot" &&
      candidate.snapshot &&
      candidate.snapshot.overallSimilarity < candidate.snapshot.threshold
    ) {
      lastValidation = buildSnapshotValidationFailure(
        params.layout.rootNodeId,
        validation,
        candidate.snapshot
      );
      warnings.push(
        `Modo snapshot ficou abaixo da similaridade minima (${(
          candidate.snapshot.overallSimilarity * 100
        ).toFixed(2)}% < ${(candidate.snapshot.threshold * 100).toFixed(
          2
        )}%); escalando para fallback mais seguro.`
      );

      if (forceVisualSnapshot && !hasMoreModes) {
        return {
          document: enrichedDocument,
          emittedMode: candidate.emittedMode,
          exportStage: candidate.exportStage,
          fallbackReason: candidate.fallbackReason,
          warnings,
          validation: lastValidation,
          previewHtml: candidate.previewHtml,
          snapshot: candidate.snapshot
        };
      }

      if (hasMoreModes) {
        appendFallbackContinuationWarning(warnings, attemptedModes, index);
        continue;
      }
    }

    if (structuralVisualAssessment && !structuralVisualAssessment.passed) {
      warnings.push(
        `Modo ${candidate.emittedMode} ficou em ${(
          structuralVisualAssessment.similarity * 100
        ).toFixed(2)}% de similaridade visual, abaixo do minimo de ${(
          STRUCTURAL_VISUAL_SIMILARITY_THRESHOLD * 100
        ).toFixed(2)}%; escalando para fallback mais fiel.`
      );
      appendFallbackContinuationWarning(warnings, attemptedModes, index);
      continue;
    }

    if (validation.passed) {
      const fallbackReason =
        candidate.fallbackReason ??
        (candidate.emittedMode !== params.selectedMode
          ? `Exportacao final emitida em ${candidate.emittedMode} para preservar o layout detectado.`
          : undefined);

      return {
        document: enrichedDocument,
        emittedMode: candidate.emittedMode,
        exportStage: candidate.exportStage,
        fallbackReason,
        warnings,
        validation,
        previewHtml: candidate.previewHtml,
        snapshot: candidate.snapshot
      };
    }

    warnings.push(
      `Modo ${candidate.emittedMode} reprovado na validacao visual (${validation.issueCount} perda(s)); escalando para fallback mais seguro.`
    );

    appendFallbackContinuationWarning(warnings, attemptedModes, index);

    if (forceVisualSnapshot && candidate.emittedMode === "snapshot" && !hasMoreModes) {
      return {
        document: enrichedDocument,
        emittedMode: candidate.emittedMode,
        exportStage: candidate.exportStage,
        fallbackReason: candidate.fallbackReason,
        warnings,
        validation,
        previewHtml: candidate.previewHtml,
        snapshot: candidate.snapshot
      };
    }
  }

  if (lastAttempt) {
    return lastAttempt;
  }

  throw new VisualValidationError(
    lastValidation ?? {
      passed: false,
      mode: params.selectedMode,
      issueCount: 1,
      issues: [
        {
          type: "missing-position",
          nodeId: params.layout.rootNodeId,
          message: "Nao foi possivel validar nenhuma estrategia de exportacao."
        }
      ],
      stats: {
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
      }
    }
  );
}
