import type { PageCapture } from "@/lib/converter-v3/contracts/capture";
import type { ComplexityAnalysis, LayoutDocument, OutputMode } from "@/lib/converter-v3/contracts/layout";
import type {
  ExportReport,
  SnapshotVisualSummary,
  VisualValidationIssueSummary,
  VisualValidationReport
} from "@/lib/converter-v3/contracts/output";

function formatPercent(value: number) {
  return `${(value * 100).toFixed(2)}%`;
}

function buildVisualIssues(snapshot?: SnapshotVisualSummary): VisualValidationIssueSummary[] {
  return (
    snapshot?.visualValidationReport?.issues.map((issue) => ({
      sectionId: issue.sectionId,
      sectionName: issue.sectionName,
      sectionType: issue.sectionType,
      viewport: issue.viewport,
      similarity: issue.similarity,
      lossType: issue.lossType,
      fallbackStage: issue.fallbackStage,
      message: issue.message
    })) ?? []
  );
}

function buildVisualLogs(params: {
  capture: PageCapture;
  emittedMode: OutputMode;
  validation: VisualValidationReport;
  snapshotEnabled: boolean;
  snapshot?: SnapshotVisualSummary;
  fallbackReason?: string;
}) {
  const logs: string[] = [];
  const resourceStatuses = params.capture.inputAnalysis.diagnostics.resources ?? [];
  const loadedAssets = resourceStatuses.filter((resource) => resource.status === "loaded").length;
  const failedAssets = resourceStatuses.filter((resource) => resource.status === "failed").length;

  if (params.snapshotEnabled && params.snapshot) {
    params.snapshot.sectionReports.forEach((section, index) => {
      if (section.mode !== "snapshot") {
        return;
      }

      logs.push(
        `[VISUAL SNAPSHOT] Secao ${(index + 1).toString().padStart(2, "0")} (${section.name}) capturada com sucesso`
      );
    });
  }

  if (resourceStatuses.length > 0) {
    logs.push(`[ASSET] ${loadedAssets} recursos carregados com sucesso`);

    if (failedAssets > 0) {
      logs.push(`[ASSET] ${failedAssets} recursos falharam durante a renderizacao`);
    }
  }

  if (params.snapshot?.totals.preservedLinks || params.capture.summary.links) {
    logs.push(
      `[LINK OVERLAY] ${params.snapshot?.totals.preservedLinks ?? 0} links preservados`
    );
  }

  Object.entries(
    params.snapshot?.viewportSimilarities ??
      params.snapshot?.visualValidationReport?.viewportResults.reduce<
        Partial<Record<"desktop" | "tablet" | "mobile", number>>
      >((acc, result) => {
        acc[result.viewport] = result.similarity;
        return acc;
      }, {}) ??
      {}
  ).forEach(([viewport, similarity]) => {
    if (typeof similarity === "number") {
      logs.push(`[VALIDATION] similaridade ${viewport}: ${formatPercent(similarity)}`);
    }
  });

  if (params.fallbackReason) {
    logs.push(`[FALLBACK] ${params.fallbackReason}`);
  }

  logs.push(
    params.validation.passed
      ? "[EXPORT] aprovado"
      : `[EXPORT] bloqueado: ${params.validation.issueCount} perda(s) detectada(s)`
  );

  return logs;
}

export function buildExportReport(params: {
  capture: PageCapture;
  layout: LayoutDocument;
  analysis: ComplexityAnalysis;
  emittedMode: OutputMode;
  validation: VisualValidationReport;
  snapshotEnabled: boolean;
  snapshotReason: string;
  fallbackReason?: string;
  warnings?: string[];
  snapshot?: SnapshotVisualSummary;
}): ExportReport {
  const warnings = [
    ...(params.warnings ?? []),
    ...(params.fallbackReason ? [params.fallbackReason] : [])
  ];
  const visualIssues = buildVisualIssues(params.snapshot);
  const visualLogs = buildVisualLogs({
    capture: params.capture,
    emittedMode: params.emittedMode,
    validation: params.validation,
    snapshotEnabled: params.snapshotEnabled,
    snapshot: params.snapshot,
    fallbackReason: params.fallbackReason
  });

  return {
    id: params.capture.id,
    title: params.capture.title,
    sourceKind: params.capture.sourceKind,
    renderer: params.capture.renderer,
    snapshotEnabled: params.snapshotEnabled,
    snapshotReason: params.snapshotReason,
    selectedMode: params.analysis.selectedMode,
    emittedMode: params.emittedMode,
    fallbackReason: params.fallbackReason,
    summary: params.capture.summary,
    layout: {
      rootNodeId: params.layout.rootNodeId,
      nodeCount: params.layout.nodeCount,
      sectionCount: params.layout.sectionIds.length
    },
    analysis: params.analysis,
    validation: params.validation,
    warnings,
    contentMetrics: {
      detectedTexts: params.capture.summary.textBlocks,
      detectedImages: params.capture.summary.images,
      detectedButtons: params.capture.summary.buttons,
      detectedLinks: params.capture.summary.links ?? 0,
      detectedVisualContainers: params.capture.summary.visualContainers ?? 0,
      detectedGeometryGroups: params.capture.summary.geometryGroups ?? 0,
      createdSections:
        params.snapshot?.totals.snapshotSections ??
        (params.layout.detectedSections.length || params.layout.sectionIds.length)
    },
    viewportSimilarities:
      params.snapshot?.viewportSimilarities ??
      params.snapshot?.visualValidationReport?.viewportResults.reduce<
        Partial<Record<"desktop" | "tablet" | "mobile", number>>
      >((acc, result) => {
        acc[result.viewport] = result.similarity;
        return acc;
      }, {}),
    visualIssues,
    visualLogs,
    learningNotes: params.snapshot?.learningNotes ?? [],
    fallbackTrail: [
      `selected:${params.analysis.selectedMode}`,
      `emitted:${params.emittedMode}`,
      ...(params.fallbackReason ? [`fallback:${params.fallbackReason}`] : []),
      ...(params.snapshot?.learningNotes ?? []),
      ...warnings,
      ...visualLogs
    ],
    snapshot: params.snapshot
  };
}
