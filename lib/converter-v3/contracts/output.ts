import type { CaptureSummary, PageCapture } from "@/lib/converter-v3/contracts/capture";
import type { ComplexityAnalysis, LayoutDocument, OutputMode } from "@/lib/converter-v3/contracts/layout";
import type { SourceKind } from "@/lib/converter-v3/contracts/source";
import type { ElementorDocument } from "@/types/conversion";

export type ExportArtifactPaths = {
  elementorTemplatePath: string;
  reportPath: string;
  previewHtmlPath?: string;
  convertedScreenshotPath?: string;
  snapshotSectionsPath?: string;
};

export type SnapshotSectionRenderMode = "html" | "snapshot";

export type SnapshotSectionReport = {
  nodeId: string;
  name: string;
  type: string;
  mode: SnapshotSectionRenderMode;
  reason: string;
  similarity: number;
  preservedLinks: number;
  totalLinks: number;
};

export type SnapshotVisualSummary = {
  overallSimilarity: number;
  threshold: number;
  convertedScreenshotPath?: string;
  originalScreenshotPath?: string;
  sectionReports: SnapshotSectionReport[];
  totals: {
    htmlSections: number;
    snapshotSections: number;
    preservedLinks: number;
    totalLinks: number;
  };
};

export type VisualValidationIssueType =
  | "missing-text"
  | "missing-image"
  | "missing-button"
  | "missing-position"
  | "missing-link"
  | "missing-section"
  | "missing-card"
  | "missing-header"
  | "missing-footer";

export type VisualValidationIssue = {
  type: VisualValidationIssueType;
  nodeId: string;
  message: string;
};

export type VisualValidationReport = {
  passed: boolean;
  mode: OutputMode;
  issueCount: number;
  issues: VisualValidationIssue[];
  stats: {
    expectedTexts: number;
    matchedTexts: number;
    expectedImages: number;
    matchedImages: number;
    expectedButtons: number;
    matchedButtons: number;
    expectedLinks: number;
    matchedLinks: number;
    expectedSections: number;
    matchedSections: number;
    expectedCards: number;
    matchedCards: number;
    expectedHeaders: number;
    matchedHeaders: number;
    expectedFooters: number;
    matchedFooters: number;
    expectedPositionedNodes: number;
    matchedPositionedNodes: number;
  };
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
  validation: VisualValidationReport;
  warnings: string[];
  snapshot?: SnapshotVisualSummary;
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
  validation: VisualValidationReport;
  report: ExportReport;
  snapshot?: SnapshotVisualSummary;
  artifacts: ExportArtifactPaths;
};
