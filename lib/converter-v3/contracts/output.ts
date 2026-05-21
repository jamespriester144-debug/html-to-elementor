import type { CaptureSummary, PageCapture } from "@/lib/converter-v3/contracts/capture";
import type { ComplexityAnalysis, LayoutDocument, OutputMode } from "@/lib/converter-v3/contracts/layout";
import type { SourceKind } from "@/lib/converter-v3/contracts/source";
import type { ElementorDocument } from "@/types/conversion";

export type ExportArtifactPaths = {
  elementorTemplatePath: string;
  reportPath: string;
};

export type ExportReport = {
  id: string;
  title: string;
  sourceKind: SourceKind;
  renderer: PageCapture["renderer"];
  selectedMode: OutputMode;
  emittedMode: OutputMode;
  fallbackReason?: string;
  summary: CaptureSummary;
  layout: {
    rootNodeId: string;
    nodeCount: number;
    sectionCount: number;
  };
  analysis: ComplexityAnalysis;
  warnings: string[];
};

export type ExportPipelineResult = {
  resolvedSource: {
    id: string;
    sourceKind: SourceKind;
    title: string;
  };
  capture: PageCapture;
  layout: LayoutDocument;
  analysis: ComplexityAnalysis;
  emittedMode: OutputMode;
  fallbackReason?: string;
  elementorDocument: ElementorDocument;
  report: ExportReport;
  artifacts: ExportArtifactPaths;
};
