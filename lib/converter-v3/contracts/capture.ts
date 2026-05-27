import type { SourceKind } from "@/lib/converter-v3/contracts/source";
import type { InputPageAnalysis } from "@/lib/converter-v3/contracts/input-analysis";

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

export type CapturedBackgroundLayer = {
  index: number;
  type: "gradient" | "image" | "other";
  value: string;
  url?: string;
};

export type CapturedNodeAsset = {
  href?: string;
  src?: string;
  currentSrc?: string;
  srcsetCandidates?: string[];
  pictureSources?: string[];
  lazySources?: string[];
  alt?: string;
  poster?: string;
  backgroundImage?: string;
  backgroundUrls?: string[];
  backgroundLayers?: CapturedBackgroundLayer[];
  hasGradientBackground?: boolean;
};

export type CapturedPseudoElement = {
  pseudo: "::before" | "::after";
  content?: string;
  computedStyles: Record<string, string>;
  box: CapturedBox | null;
  isVisible: boolean;
  asset: CapturedNodeAsset;
};

export type ThemeMode = "dark" | "light" | "mixed" | "unknown";

export type ThemeColorSampleRole =
  | "page"
  | "body"
  | "main"
  | "section"
  | "card"
  | "header"
  | "footer"
  | "input"
  | "button"
  | "cta";

export type ThemeColorSample = {
  role: ThemeColorSampleRole;
  color: string;
  luminance: number;
  contrastAgainstText?: number;
  nodeId?: string;
  weight?: number;
};

export type ThemeDesignTokens = {
  globalBackground?: string;
  foreground?: string;
  cardBackground?: string;
  borderColor?: string;
  primaryButtonColor?: string;
  secondaryButtonColor?: string;
  accentColor?: string;
  mutedColor?: string;
  radius?: string;
  shadow?: string;
  fontFamily?: string;
  headingSize?: string;
  bodyTextSize?: string;
  averageSectionVerticalSpacing?: number;
};

export type ThemeStyleSignals = {
  hasStrongDarkTheme: boolean;
  hasStyledButtons: boolean;
  hasStyledInputs: boolean;
  hasElevatedCards: boolean;
};

export type ThemeAnalysis = {
  detectedTheme: ThemeMode;
  dominantBackgroundLuminance?: number;
  dominantContrast?: number;
  colorSamples: ThemeColorSample[];
  designTokens: ThemeDesignTokens;
  styleSignals?: ThemeStyleSignals;
  roleCounts: {
    cards: number;
    buttons: number;
    inputs: number;
    headers: number;
    footers: number;
    sections: number;
  };
  messages: string[];
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
  pseudoElements?: CapturedPseudoElement[];
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
  links?: number;
  images: number;
  buttons: number;
  textBlocks: number;
  visualContainers?: number;
  geometryGroups?: number;
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
  inputAnalysisPath?: string;
  pageCapturePath: string;
  visibleElementsPath?: string;
  geometryGroupsPath?: string;
  sectionArtifactsPath: string;
  screenshots: Partial<Record<CaptureViewportName, string>>;
};

export type SectionOverlayLink = {
  nodeId: string;
  href: string;
  text: string;
  ariaLabel?: string;
  title?: string;
  target?: string;
  rel?: string;
  isButton: boolean;
  zIndex?: number;
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
  captureBox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  invadingNodeIds?: string[];
  captureStrategy?: "expanded-clip" | "coordinate-clip" | "viewport-clip";
  linkOverlays: SectionOverlayLink[];
};

export type SectionCaptureImageAsset = {
  nodeId: string;
  tag: string;
  src: string;
  currentSrc?: string;
  srcsetCandidates?: string[];
  alt?: string;
  width: number;
  height: number;
  lazy?: boolean;
  status?: "loaded" | "failed" | "pending";
};

export type SectionCaptureBackgroundAsset = {
  nodeId: string;
  tag: string;
  backgroundImage: string;
  backgroundUrls?: string[];
  backgroundLayers?: CapturedBackgroundLayer[];
  hasGradient?: boolean;
  pseudo?: "::before" | "::after";
  status?: "loaded" | "failed" | "pending";
};

export type SectionCaptureFontAsset = {
  family: string;
  weight?: string;
  style?: string;
  status?: string;
};

export type SectionCaptureInteractiveAsset = {
  nodeId: string;
  tag: string;
  role?: string;
  href?: string;
  text: string;
  isButton: boolean;
};

export type SectionCapturePositionedAsset = {
  nodeId: string;
  tag: string;
  position: string;
  transform?: string;
  zIndex?: string;
  overlapsSection: boolean;
  insideSection: boolean;
};

export type SectionCaptureDebugInfo = {
  sectionBoundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  captureBoundingBox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  sectionWidth: number;
  sectionHeight: number;
  originalImages: SectionCaptureImageAsset[];
  cssBackgrounds: SectionCaptureBackgroundAsset[];
  loadedFonts: SectionCaptureFontAsset[];
  interactiveElements: SectionCaptureInteractiveAsset[];
  positionedElements: SectionCapturePositionedAsset[];
  unsafeSectionBoundary?: boolean;
  unsafeReasons?: string[];
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
  debug?: SectionCaptureDebugInfo;
};

export type PageCapture = {
  id: string;
  sourceKind: SourceKind;
  title: string;
  sourceHtml: string;
  renderedHtml: string;
  renderer: "browser" | "server";
  inputAnalysis: InputPageAnalysis;
  viewports: CaptureViewportProfile[];
  domSnapshot: DomSnapshotNode[];
  styleSnapshot: StyleSnapshotNode[];
  boxSnapshot: BoxSnapshotNode[];
  responsiveSnapshot: ResponsiveSnapshotNode[];
  nodes: CapturedNode[];
  sections?: SectionCapture[];
  themeAnalysis?: ThemeAnalysis;
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
