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
import { isForceVisualSnapshotEnabled } from "@/lib/env";
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

const STRUCTURAL_VISUAL_SIMILARITY_THRESHOLD = 0.99;

function parseBackgroundUrl(value?: string): string | undefined {
  if (!value || value === "none") {
    return undefined;
  }

  const match = value.match(/url\((['"]?)(.*?)\1\)/i);
  return match?.[2]?.trim() || undefined;
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

function applySourceNodeMetadata(
  element: ElementorElement,
  nodeById: Map<string, LayoutNode>
): ElementorElement {
  const sourceNodeId =
    typeof element.settings.converter_v3_source_node_id === "string"
      ? element.settings.converter_v3_source_node_id
      : undefined;
  const node = sourceNodeId ? nodeById.get(sourceNodeId) : undefined;
  const backgroundImageUrl = parseBackgroundUrl(node?.style.backgroundImage);

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

  if (backgroundImageUrl && nextElement.elType === "container") {
    nextElement.settings.background_background = "classic";
    nextElement.settings.background_image = {
      url: backgroundImageUrl
    };
    nextElement.settings.background_position = node.style.backgroundPosition;
    nextElement.settings.background_size = normalizeBackgroundSize(node.style.backgroundSize);
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
  forceVisualSnapshot: boolean;
  renderer: PageCapture["renderer"];
}): InternalCandidateMode[] {
  const { selectedMode, forceVisualSnapshot, renderer } = params;

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

export async function createElementorNativeExport(params: {
  capture: PageCapture;
  layout: LayoutDocument;
  selectedMode: OutputMode;
  outputDir?: string;
}): Promise<NativeExporterResult> {
  const forceVisualSnapshot = isForceVisualSnapshotEnabled();
  const attemptedModes = getCandidateModes({
    selectedMode: params.selectedMode,
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
      warnings.push(
        `Modo ${candidate.emittedMode} ficou em ${(
          structuralVisualAssessment.similarity * 100
        ).toFixed(2)}% de similaridade visual, abaixo do minimo de ${(
          STRUCTURAL_VISUAL_SIMILARITY_THRESHOLD * 100
        ).toFixed(2)}%; escalando para fallback mais fiel.`
      );
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
