import { createEditableElementorDocumentV3 } from "@/lib/converter-v3/emitters/elementor/editable";
import { createHybridElementorDocumentV3 } from "@/lib/converter-v3/emitters/elementor/hybrid";
import { createPixelPerfectElementorDocumentV3 } from "@/lib/converter-v3/emitters/elementor/pixel-perfect";
import { createSnapshotElementorDocumentV3 } from "@/lib/converter-v3/emitters/elementor/snapshot";
import type { PageCapture } from "@/lib/converter-v3/contracts/capture";
import type { LayoutDocument, LayoutNode, OutputMode } from "@/lib/converter-v3/contracts/layout";
import type {
  SnapshotVisualSummary,
  VisualValidationReport
} from "@/lib/converter-v3/contracts/output";
import {
  VisualValidationError,
  validateElementorExport
} from "@/lib/converter-v3/visual-regression-validator";
import type { ElementorDocument, ElementorElement } from "@/types/conversion";

export type NativeExporterResult = {
  document: ElementorDocument;
  emittedMode: OutputMode;
  fallbackReason?: string;
  warnings: string[];
  validation: VisualValidationReport;
  previewHtml?: string;
  snapshot?: SnapshotVisualSummary;
};

type EmittedCandidate = {
  document: ElementorDocument;
  emittedMode: OutputMode;
  warnings: string[];
  fallbackReason?: string;
  previewHtml?: string;
  snapshot?: SnapshotVisualSummary;
};

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
    warnings: hybridResult.warnings
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
    warnings: params.fallbackReason ? [params.fallbackReason] : [],
    fallbackReason: params.fallbackReason
  };
}

function getCandidateModes(selectedMode: OutputMode): OutputMode[] {
  if (selectedMode === "snapshot") {
    return ["snapshot", "pixel-perfect"];
  }

  if (selectedMode === "pixel-perfect") {
    return ["pixel-perfect"];
  }

  if (selectedMode === "editable") {
    return ["editable", "hybrid", "pixel-perfect"];
  }

  if (selectedMode === "hybrid") {
    return ["hybrid", "pixel-perfect"];
  }

  return ["hybrid", "pixel-perfect"];
}

export async function createElementorNativeExport(params: {
  capture: PageCapture;
  layout: LayoutDocument;
  selectedMode: OutputMode;
  outputDir?: string;
}): Promise<NativeExporterResult> {
  const attemptedModes = getCandidateModes(params.selectedMode);
  const warnings: string[] = [];
  let lastValidation: VisualValidationReport | null = null;

  for (const mode of attemptedModes) {
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

    if (
      candidate.emittedMode === "snapshot" &&
      candidate.snapshot &&
      candidate.snapshot.requiresPixelPerfect
    ) {
      warnings.push(
        candidate.snapshot.pixelPerfectReason ??
          "Uma ou mais secoes exigiram pixel-perfect por perda critica de fidelidade visual."
      );
      continue;
    }

    if (
      candidate.emittedMode === "snapshot" &&
      candidate.snapshot &&
      candidate.snapshot.overallSimilarity < candidate.snapshot.threshold
    ) {
      warnings.push(
        `Modo snapshot ficou abaixo da similaridade minima (${(
          candidate.snapshot.overallSimilarity * 100
        ).toFixed(2)}% < ${(candidate.snapshot.threshold * 100).toFixed(
          2
        )}%); escalando para fallback mais seguro.`
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
