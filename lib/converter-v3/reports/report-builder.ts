import type { PageCapture } from "@/lib/converter-v3/contracts/capture";
import type { ComplexityAnalysis, LayoutDocument, OutputMode } from "@/lib/converter-v3/contracts/layout";
import type { ExportReport, VisualValidationReport } from "@/lib/converter-v3/contracts/output";

export function buildExportReport(params: {
  capture: PageCapture;
  layout: LayoutDocument;
  analysis: ComplexityAnalysis;
  emittedMode: OutputMode;
  validation: VisualValidationReport;
  fallbackReason?: string;
  warnings?: string[];
}): ExportReport {
  const warnings = [
    ...(params.warnings ?? []),
    ...(params.fallbackReason ? [params.fallbackReason] : [])
  ];

  return {
    id: params.capture.id,
    title: params.capture.title,
    sourceKind: params.capture.sourceKind,
    renderer: params.capture.renderer,
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
    warnings
  };
}
