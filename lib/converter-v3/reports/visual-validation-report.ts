import type {
  ExportPipelineResult,
  UniversalVisualMode,
  UniversalVisualValidationReport
} from "@/lib/converter-v3/contracts/output";

function resolveUniversalMode(result: ExportPipelineResult): UniversalVisualMode {
  if (result.emittedMode === "snapshot") {
    return result.snapshot?.renderStrategy === "full-page-snapshot"
      ? "full-page-snapshot"
      : "section-snapshot";
  }

  if (
    result.emittedMode === "editable" ||
    result.emittedMode === "hybrid" ||
    result.emittedMode === "pixel-perfect"
  ) {
    return result.emittedMode;
  }

  return "editable";
}

function resolveFinalSimilarity(result: ExportPipelineResult) {
  if (result.emittedMode === "pixel-perfect") {
    return 1;
  }

  return result.snapshot?.overallSimilarity ?? 0;
}

function resolveLinksPreserved(result: ExportPipelineResult) {
  return result.snapshot?.totals.preservedLinks ?? 0;
}

export function buildUniversalVisualValidationReport(
  result: ExportPipelineResult
): UniversalVisualValidationReport {
  const sectionsDetected =
    result.layout.detectedSections.length > 0
      ? result.layout.detectedSections.map((section) => ({
          id: section.id,
          type: section.type,
          confidence: section.confidence
        }))
      : result.layout.sectionIds.map((sectionId) => ({
          id: sectionId,
          type: "section"
        }));

  return {
    fileAnalyzed:
      result.capture.inputAnalysis.fileName ||
      result.resolvedSource.title ||
      result.resolvedSource.id,
    title: result.resolvedSource.title,
    sourceKind: result.resolvedSource.sourceKind,
    renderer: result.capture.renderer,
    layoutTypesDetected: result.capture.inputAnalysis.layoutTypes,
    assetsFound: result.capture.inputAnalysis.assets.found,
    assetsLoaded: result.capture.inputAnalysis.diagnostics.resources,
    sectionsDetected,
    modeUsed: resolveUniversalMode(result),
    fallbackReason:
      result.snapshot?.fullPageFallbackReason ??
      result.fallbackReason ??
      result.report.fallbackReason,
    linksPreserved: resolveLinksPreserved(result),
    finalSimilarity: resolveFinalSimilarity(result),
    viewportSimilarities:
      result.snapshot?.viewportSimilarities ??
      result.snapshot?.visualValidationReport?.viewportResults.reduce<
        Partial<Record<"desktop" | "tablet" | "mobile", number>>
      >((acc, viewportResult) => {
        acc[viewportResult.viewport] = viewportResult.similarity;
        return acc;
      }, {}),
    htmlRendered: result.capture.inputAnalysis.diagnostics.htmlRendered ?? false,
    cssLoaded: result.capture.inputAnalysis.diagnostics.cssLoaded ?? false,
    imagesLoaded: result.capture.inputAnalysis.diagnostics.imagesLoaded ?? false,
    relativeAssetsResolved:
      result.capture.inputAnalysis.diagnostics.relativeAssetsResolved ?? false,
    viewportMatched: result.capture.inputAnalysis.diagnostics.viewportMatched ?? false,
    sectionCroppingRisk:
      result.capture.inputAnalysis.diagnostics.sectionCroppingRisk ?? false,
    fullPageSnapshotFailed:
      result.capture.inputAnalysis.diagnostics.fullPageSnapshotFailed ?? false,
    visualIssues: result.report.visualIssues,
    learningNotes: result.report.learningNotes,
    logs: result.report.visualLogs,
    errors: [
      ...result.capture.inputAnalysis.diagnostics.errors,
      ...result.capture.inputAnalysis.diagnostics.warnings,
      ...(result.snapshot?.visualValidationReport?.blockingReason
        ? [result.snapshot.visualValidationReport.blockingReason]
        : [])
    ]
  };
}
