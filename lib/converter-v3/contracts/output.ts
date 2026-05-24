import type {
  CaptureSummary,
  CaptureViewportName,
  PageCapture
} from "@/lib/converter-v3/contracts/capture";
import type {
  InputAssetLoadStatus,
  InputAssetReference,
  InputLayoutType
} from "@/lib/converter-v3/contracts/input-analysis";
import type { ComplexityAnalysis, LayoutDocument, OutputMode } from "@/lib/converter-v3/contracts/layout";
import type { SourceKind } from "@/lib/converter-v3/contracts/source";
import type { ElementorDocument } from "@/types/conversion";

export type ExportArtifactPaths = {
  elementorTemplatePath: string;
  reportPath: string;
  previewHtmlPath?: string;
  convertedScreenshotPath?: string;
  snapshotSectionsPath?: string;
  visualValidationReportPath?: string;
  contentIntegrityReportPath?: string;
  debugConversionDir?: string;
};

export type UniversalVisualMode =
  | "editable"
  | "hybrid"
  | "pixel-perfect"
  | "section-snapshot"
  | "full-page-snapshot";

export type SnapshotSectionRenderMode = "html" | "snapshot";

export type SnapshotSectionReport = {
  nodeId: string;
  name: string;
  type: string;
  mode: SnapshotSectionRenderMode;
  reason: string;
  similarity: number;
  fidelityScore?: number;
  riskScore?: number;
  htmlBlocked?: boolean;
  instabilityReasons?: string[];
  healingIssues?: string[];
  healingSteps?: string[];
  preservedLinks: number;
  totalLinks: number;
};

export type SnapshotVisualSummary = {
  renderStrategy?: "section-snapshots" | "full-page-snapshot";
  fullPageFallbackReason?: string;
  overallSimilarity: number;
  threshold: number;
  convertedScreenshotPath?: string;
  originalScreenshotPath?: string;
  viewportSimilarities?: Partial<Record<CaptureViewportName, number>>;
  sectionReports: SnapshotSectionReport[];
  requiresPixelPerfect?: boolean;
  pixelPerfectReason?: string;
  learningNotes?: string[];
  visualValidationReport?: SnapshotVisualValidationReport;
  totals: {
    htmlSections: number;
    snapshotSections: number;
    pixelPerfectRequiredSections?: number;
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
  sectionId?: string;
  sectionName?: string;
  sectionType?: string;
  viewport?: CaptureViewportName;
  similarity?: number;
  lossType?: SnapshotValidationLossType;
  originalScreenshotPath?: string;
  convertedScreenshotPath?: string;
  diffScreenshotPath?: string;
};

export type SnapshotValidationLossType =
  | "text"
  | "image"
  | "button"
  | "background"
  | "position"
  | "size"
  | "link";

export type SnapshotValidationMode =
  | "section-snapshot"
  | "section-fallback"
  | "full-page-snapshot";

export type SnapshotViewportValidation = {
  viewport: CaptureViewportName;
  passed: boolean;
  similarity: number;
  originalScreenshotPath?: string;
  convertedScreenshotPath?: string;
  diffScreenshotPath?: string;
};

export type SnapshotSectionValidationEntry = {
  nodeId: string;
  name: string;
  type: string;
  similarity: number;
  viewportSimilarities: Partial<Record<CaptureViewportName, number>>;
  fallbackStage?: "section-recapture" | "pure-snapshot" | "full-page-snapshot";
  preservedLinks: number;
  totalLinks: number;
};

export type SnapshotVisualValidationIssue = {
  viewport: CaptureViewportName;
  sectionId?: string;
  sectionName?: string;
  sectionType?: string;
  similarity: number;
  lossType: SnapshotValidationLossType;
  fallbackStage:
    | "section-snapshot"
    | "section-recapture"
    | "pure-snapshot"
    | "full-page-snapshot";
  fallbackUsed:
    | "section-snapshot"
    | "section-recapture"
    | "pure-snapshot"
    | "full-page-snapshot";
  originalScreenshotPath?: string;
  convertedScreenshotPath?: string;
  diffScreenshotPath?: string;
  message: string;
};

export type SnapshotVisualValidationReport = {
  status: "passed" | "blocked";
  modeUsed: SnapshotValidationMode;
  viewportsTested: CaptureViewportName[];
  sectionsApproved: SnapshotSectionValidationEntry[];
  sectionsWithFallback: SnapshotSectionValidationEntry[];
  linksPreserved: number;
  totalLinks: number;
  similarityFinal: number;
  viewportResults: SnapshotViewportValidation[];
  issues: SnapshotVisualValidationIssue[];
  diagnosticSummary?: string[];
  debugArtifacts?: string[];
  blockingReason?: string;
};

export type VisualValidationIssueSummary = {
  sectionId?: string;
  sectionName?: string;
  sectionType?: string;
  viewport?: CaptureViewportName;
  similarity?: number;
  lossType?: SnapshotValidationLossType;
  fallbackStage?:
    | "section-snapshot"
    | "section-recapture"
    | "pure-snapshot"
    | "full-page-snapshot";
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
  snapshotEnabled: boolean;
  snapshotReason: string;
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
  contentMetrics: {
    detectedTexts: number;
    detectedImages: number;
    detectedButtons: number;
    detectedLinks: number;
    detectedVisualContainers: number;
    detectedGeometryGroups: number;
    createdSections: number;
  };
  viewportSimilarities?: Partial<Record<CaptureViewportName, number>>;
  visualIssues: VisualValidationIssueSummary[];
  visualLogs: string[];
  learningNotes: string[];
  fallbackTrail: string[];
  snapshot?: SnapshotVisualSummary;
};

export type UniversalVisualValidationReport = {
  fileAnalyzed: string;
  title: string;
  sourceKind: SourceKind;
  renderer: PageCapture["renderer"];
  layoutTypesDetected: InputLayoutType[];
  assetsFound: InputAssetReference[];
  assetsLoaded: InputAssetLoadStatus[];
  sectionsDetected: Array<{
    id: string;
    type: string;
    confidence?: number;
  }>;
  modeUsed: UniversalVisualMode;
  fallbackReason?: string;
  linksPreserved: number;
  finalSimilarity: number;
  viewportSimilarities?: Partial<Record<CaptureViewportName, number>>;
  htmlRendered: boolean;
  cssLoaded: boolean;
  imagesLoaded: boolean;
  relativeAssetsResolved: boolean;
  viewportMatched: boolean;
  sectionCroppingRisk: boolean;
  fullPageSnapshotFailed: boolean;
  visualIssues: VisualValidationIssueSummary[];
  learningNotes: string[];
  logs: string[];
  errors: string[];
};

export type ContentIntegrityStatus = "passed" | "blocked";

export type ContentIntegrityReport = {
  status: ContentIntegrityStatus;
  inputFile: string;
  outputFile: string;
  sourceHtmlSize: number;
  originalHtmlSize: number;
  renderedHtmlSize: number;
  outputSize: number;
  elementorJsonSize: number;
  previewHtmlSize: number;
  originalTextCount: number;
  outputTextCount: number;
  originalImageCount: number;
  outputImageCount: number;
  originalButtonCount: number;
  outputButtonCount: number;
  originalLinkCount: number;
  outputLinkCount: number;
  originalSectionCount: number;
  outputSectionCount: number;
  originalVisibleHeight: number;
  convertedVisibleHeight: number;
  visibleContentDetected: boolean;
  convertedBodyEmpty: boolean;
  hasRealWidgets: boolean;
  snapshotGenerated: boolean;
  overlaysGenerated: boolean;
  modeUsed: UniversalVisualMode;
  failureStage?: string;
  failureReason?: string;
  recommendation: string;
  errorsFound: string[];
  debugArtifacts?: {
    renderedHtmlPath?: string;
    pageCapturePath?: string;
    visibleElementsPath?: string;
    geometryGroupsPath?: string;
    originalScreenshotPath?: string;
    convertedScreenshotPath?: string;
    debugConversionDir?: string;
    extractedElementsPath?: string;
    detectedSectionsPath?: string;
    lostElementsPath?: string;
    conversionReportPath?: string;
  };
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
  contentIntegrity: ContentIntegrityReport;
  artifacts: ExportArtifactPaths;
};
