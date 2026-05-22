import type { SourceKind } from "@/lib/converter-v3/contracts/source";

export type CaptureViewportName = "desktop" | "tablet" | "mobile";

export type CaptureViewportProfile = {
  name: CaptureViewportName;
  width: number;
  height: number;
};

export type CapturedBox = {
  x: number;
  y: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
};

export type CapturedViewportState = {
  computedStyles: Record<string, string>;
  box: CapturedBox | null;
  isVisible: boolean;
};

export type CapturedNodeAsset = {
  href?: string;
  src?: string;
  alt?: string;
  backgroundImage?: string;
};

export type CapturedNode = {
  id: string;
  tag: string;
  text: string;
  attributes: Record<string, string>;
  parentId: string | null;
  childIds: string[];
  computedStyles: Record<string, string>;
  box: CapturedBox | null;
  viewportStates: Partial<Record<CaptureViewportName, CapturedViewportState>>;
  visualOrder: number;
  isVisible: boolean;
  asset: CapturedNodeAsset;
};

export type DomSnapshotNode = Pick<
  CapturedNode,
  "id" | "tag" | "text" | "attributes" | "parentId" | "childIds" | "visualOrder" | "isVisible"
>;

export type StyleSnapshotNode = {
  id: string;
  computedStyles: Record<string, string>;
};

export type BoxSnapshotNode = {
  id: string;
  box: CapturedBox | null;
};

export type ResponsiveSnapshotNode = {
  id: string;
  viewportStates: Partial<Record<CaptureViewportName, CapturedViewportState>>;
};

export type CaptureSummary = {
  totalNodes: number;
  visibleNodes: number;
  images: number;
  buttons: number;
  textBlocks: number;
  sections: number;
};

export type CaptureArtifacts = {
  outputDir: string;
  resolvedSourcePath: string;
  renderedHtmlPath: string;
  domSnapshotPath: string;
  styleSnapshotPath: string;
  boxSnapshotPath: string;
  responsiveSnapshotPath: string;
  layoutPath: string;
  analysisPath: string;
  pageCapturePath: string;
  sectionArtifactsPath: string;
  screenshots: Partial<Record<CaptureViewportName, string>>;
};

export type SectionOverlayLink = {
  nodeId: string;
  href: string;
  text: string;
  title?: string;
  target?: string;
  rel?: string;
  isButton: boolean;
  box: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  relativeBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};

export type SectionCaptureViewport = {
  viewport: CaptureViewportName;
  width: number;
  height: number;
  snapshotPath?: string;
  snapshotDataUrl?: string;
  linkOverlays: SectionOverlayLink[];
};

export type SectionInstabilityReason =
  | "absolute-positioning"
  | "complex-z-index"
  | "overlays"
  | "transforms"
  | "complex-gradients"
  | "pseudo-elements"
  | "fragile-grid"
  | "carousel"
  | "animations"
  | "unsupported-css"
  | "dense-dom"
  | "visual-overlap"
  | "complex-nested-layout";

export type SectionComplexity = {
  nodeCount: number;
  absoluteNodes: number;
  overlappingNodes: number;
  interactiveNodes: number;
  imageNodes: number;
  overlayNodes: number;
  complexZIndexNodes: number;
  transformedNodes: number;
  gradientNodes: number;
  animatedNodes: number;
  unsupportedCssNodes: number;
  carouselNodes: number;
  gridContainers: number;
  flexContainers: number;
  nestedFlexGridContainers: number;
  maxFlexGridDepth: number;
  pseudoElementNodes: number;
  hasPseudoElements: boolean;
  hasTransforms: boolean;
  hasEmbeds: boolean;
};

export type SectionCapture = {
  id: string;
  nodeId: string;
  name: string;
  type: string;
  box: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  subtreeNodeIds: string[];
  originalHtml: string;
  htmlCandidate: string;
  complexity: SectionComplexity;
  viewports: Partial<Record<CaptureViewportName, SectionCaptureViewport>>;
};

export type PageCapture = {
  id: string;
  sourceKind: SourceKind;
  title: string;
  sourceHtml: string;
  renderedHtml: string;
  renderer: "browser" | "server";
  viewports: CaptureViewportProfile[];
  domSnapshot: DomSnapshotNode[];
  styleSnapshot: StyleSnapshotNode[];
  boxSnapshot: BoxSnapshotNode[];
  responsiveSnapshot: ResponsiveSnapshotNode[];
  nodes: CapturedNode[];
  sections?: SectionCapture[];
  summary: CaptureSummary;
  artifacts: CaptureArtifacts;
};

export type CapturePipelineResult = {
  resolvedSource: {
    id: string;
    sourceKind: SourceKind;
    title: string;
  };
  capture: PageCapture;
  layout: import("@/lib/converter-v3/contracts/layout").LayoutDocument;
  analysis: import("@/lib/converter-v3/contracts/layout").ComplexityAnalysis;
};
