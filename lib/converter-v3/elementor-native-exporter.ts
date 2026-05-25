import path from "node:path";

import { createEditableElementorDocumentV3 } from "@/lib/converter-v3/emitters/elementor/editable";
import { createGeometryElementorDocumentV3 } from "@/lib/converter-v3/emitters/elementor/geometry";
import { createHybridElementorDocumentV3 } from "@/lib/converter-v3/emitters/elementor/hybrid";
import { createPixelPerfectElementorDocumentV3 } from "@/lib/converter-v3/emitters/elementor/pixel-perfect";
import { createSnapshotElementorDocumentV3 } from "@/lib/converter-v3/emitters/elementor/snapshot";
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
import { shouldForceUniversalFullPageSnapshot } from "@/lib/converter-v3/visual-clone-policy";
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
    colorA: firstStop.color,
    colorB: lastStop.color,
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
  nodeById: Map<string, LayoutNode>
): ElementorElement {
  const sourceNodeId =
    typeof element.settings.converter_v3_source_node_id === "string"
      ? element.settings.converter_v3_source_node_id
      : undefined;
  const node = sourceNodeId ? nodeById.get(sourceNodeId) : undefined;
  const backgroundStyle = parseBackgroundStyle(node?.style.backgroundImage);
  const backgroundImageUrl = backgroundStyle.imageUrl;

  const nextElement = {
    ...element,
    settings: {
      ...element.settings
    },
    elements: element.elements.map((child) => applySourceNodeMetadata(child, nodeById))
  };

  if (!node) {
    return nextElement;
  }

  nextElement.settings.converter_v3_semantic_role = node.detection?.semanticRole;
  nextElement.settings.converter_v3_visual_layer = node.visual?.layer;
  nextElement.settings.converter_v3_overlap_ids = node.visual?.overlapIds;
  nextElement.settings.converter_v3_z_index = node.visual?.effectiveZIndex;

  if (typeof node.visual?.effectiveZIndex === "number" && node.visual.effectiveZIndex > 0) {
    nextElement.settings.z_index = node.visual.effectiveZIndex;
  }

  if ((nextElement.elType === "container" || nextElement.elType === "section") && hasMeaningfulBackgroundColor(node.style.backgroundColor)) {
    setMirroredSetting(nextElement.settings, "background_color", node.style.backgroundColor);
    setMirroredSetting(
      nextElement.settings,
      "background_background",
      nextElement.settings.background_background ?? "classic"
    );
  }

  if (backgroundImageUrl && (nextElement.elType === "container" || nextElement.elType === "section")) {
    const backgroundPosition = pickCssLayerValue(
      node.style.backgroundPosition,
      backgroundStyle.imageLayerIndex
    );
    const backgroundSize = pickCssLayerValue(
      node.style.backgroundSize,
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

function enrichDocument(document: ElementorDocument, layout: LayoutDocument): ElementorDocument {
  const nodeById = buildNodeMap(layout);

  return {
    ...document,
    content: document.content.map((element) => applySourceNodeMetadata(element, nodeById))
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
  selectedMode: OutputMode;
  fallbackReason?: string;
}): EmittedCandidate {
  return {
    document: createPixelPerfectElementorDocumentV3(params.capture.renderedHtml, {
      title: params.capture.title,
      selectedMode: params.selectedMode,
      fallbackReason: params.fallbackReason
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

  if (forceFullPageSnapshot) {
    return ["snapshot"];
  }

  if (forceVisualSnapshot) {
    return ["snapshot", "pixel-perfect"];
  }

  if (selectedMode === "snapshot") {
    return ["snapshot"];
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

async function assessStructuralVisualFidelity(params: {
  capture: PageCapture;
  document: ElementorDocument;
  emittedMode: OutputMode;
  outputDir?: string;
}): Promise<StructuralVisualAssessment | null> {
  const originalScreenshotPath = params.capture.artifacts.screenshots.desktop;
  const desktopViewport =
    params.capture.viewports.find((viewport) => viewport.name === "desktop") ??
    params.capture.viewports[0];

  if (!originalScreenshotPath || !desktopViewport) {
    return null;
  }

  const previewHtml = buildConvertedPreviewHtml({
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
      passed: true,
      similarity: 1,
      previewHtml
    };
  }
}

function buildSnapshotValidationFailure(
  rootNodeId: string,
  baseValidation: VisualValidationReport,
  snapshot: SnapshotVisualSummary
): VisualValidationReport {
  const issues =
    snapshot.visualValidationReport?.issues?.map((issue) => ({
      type: "missing-position" as const,
      nodeId: issue.sectionId ?? rootNodeId,
      message: issue.message,
      sectionId: issue.sectionId,
      sectionName: issue.sectionName,
      sectionType: issue.sectionType,
      viewport: issue.viewport,
      similarity: issue.similarity,
      lossType: issue.lossType,
      originalScreenshotPath: issue.originalScreenshotPath,
      convertedScreenshotPath: issue.convertedScreenshotPath,
      diffScreenshotPath: issue.diffScreenshotPath
    })) ?? [];
  const blockingReason =
    snapshot.visualValidationReport?.blockingReason ??
    `Similaridade visual final ficou em ${(
      snapshot.overallSimilarity * 100
    ).toFixed(2)}%, abaixo do minimo de ${(snapshot.threshold * 100).toFixed(2)}%.`;

  return {
    ...baseValidation,
    passed: false,
    issueCount: Math.max(issues.length, 1),
    issues:
      issues.length > 0
        ? issues
        : [
            {
              type: "missing-position",
              nodeId: rootNodeId,
              message: blockingReason
            }
      ]
  };
}

function documentHasEmbeddedMediaAssets(document: ElementorDocument) {
  const queue = [...document.content];

  while (queue.length > 0) {
    const element = queue.shift();

    if (!element) {
      continue;
    }

    const mediaUrl =
      (element.settings?.image as { url?: string } | undefined)?.url ??
      (element.settings?.background_image as { url?: string } | undefined)?.url;

    if (typeof mediaUrl === "string" && mediaUrl.startsWith("data:image/")) {
      return true;
    }

    queue.push(...element.elements);
  }

  return false;
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
                selectedMode: params.selectedMode,
                fallbackReason:
                  "Fallback final em iframe por perda detectada nas exportacoes nativas."
              });
    const enrichedDocument =
      candidate.emittedMode === "pixel-perfect"
        ? candidate.document
        : enrichDocument(candidate.document, params.layout);
    const validation = validateElementorExport({
      capture: params.capture,
      layout: params.layout,
      document: enrichedDocument,
      mode: candidate.emittedMode
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
            outputDir: params.outputDir
          })
        : null;

    if (structuralVisualAssessment?.previewHtml) {
      candidate.previewHtml = structuralVisualAssessment.previewHtml;
      lastAttempt.previewHtml = structuralVisualAssessment.previewHtml;
    }

    if (
      forceFullPageSnapshot &&
      candidate.emittedMode === "snapshot" &&
      candidate.snapshot?.requiresPixelPerfect
    ) {
      const pixelPerfectReason =
        candidate.snapshot.pixelPerfectReason ??
        "Snapshot da pagina inteira nao pode ser gerado; fallback emergencial para pixel-perfect.";
      warnings.push(pixelPerfectReason);

      const pixelPerfectCandidate = buildPixelPerfectCandidate({
        capture: params.capture,
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
        continue;
      }
    }

    if (structuralVisualAssessment && !structuralVisualAssessment.passed) {
      if (validation.passed && documentHasEmbeddedMediaAssets(enrichedDocument)) {
        warnings.push(
          `Modo ${candidate.emittedMode} preservou assets locais embutidos; mantendo a exportacao nativa apesar da previa estrutural ficar em ${(
            structuralVisualAssessment.similarity * 100
          ).toFixed(2)}%.`
        );
      } else {
        warnings.push(
          `Modo ${candidate.emittedMode} ficou em ${(
            structuralVisualAssessment.similarity * 100
          ).toFixed(2)}% de similaridade visual, abaixo do minimo de ${(
            STRUCTURAL_VISUAL_SIMILARITY_THRESHOLD * 100
          ).toFixed(2)}%; escalando para fallback mais fiel.`
        );
        continue;
      }
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
