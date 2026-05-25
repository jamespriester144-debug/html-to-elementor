export type LayoutNodeKind =
  | "page"
  | "section"
  | "container"
  | "text"
  | "image"
  | "button"
  | "badge";

export type ResponsiveViewportName = "desktop" | "tablet" | "mobile";

export type LayoutSemanticRole =
  | "page"
  | "header"
  | "hero"
  | "section"
  | "cta"
  | "faq"
  | "grid"
  | "card"
  | "button"
  | "image"
  | "footer"
  | "text"
  | "overlay";

export type LayoutVisualLayer = "background" | "content" | "overlay";

export type ResponsiveLayoutState = {
  isVisible: boolean;
  box: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
  layout: {
    display?: string;
    position?: string;
    flexDirection?: string;
    justifyContent?: string;
    alignItems?: string;
    gap?: string;
    gridTemplateColumns?: string;
    gridTemplateRows?: string;
  };
  spacing: {
    margin?: string;
    padding?: string;
  };
  style: {
    backgroundColor?: string;
    backgroundImage?: string;
    backgroundSize?: string;
    backgroundPosition?: string;
    color?: string;
    fontSize?: string;
    fontFamily?: string;
    fontWeight?: string;
    lineHeight?: string;
    textAlign?: string;
    borderRadius?: string;
    boxShadow?: string;
    objectFit?: string;
    objectPosition?: string;
    zIndex?: string;
  };
};

export type LayoutNode = {
  id: string;
  tag?: string;
  kind: LayoutNodeKind;
  parentId: string | null;
  children: string[];
  box: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  visualOrder: number;
  layout: {
    display?: string;
    position?: string;
    flexDirection?: string;
    justifyContent?: string;
    alignItems?: string;
    gap?: string;
    gridTemplateColumns?: string;
    gridTemplateRows?: string;
  };
  spacing: {
    margin?: string;
    padding?: string;
  };
  style: {
    backgroundColor?: string;
    backgroundImage?: string;
    backgroundSize?: string;
    backgroundPosition?: string;
    color?: string;
    fontSize?: string;
    fontFamily?: string;
    fontWeight?: string;
    lineHeight?: string;
    textAlign?: string;
    borderRadius?: string;
    boxShadow?: string;
    objectFit?: string;
    objectPosition?: string;
    zIndex?: string;
  };
  content: {
    text?: string;
    src?: string;
    href?: string;
    alt?: string;
  };
  flags: {
    decorative?: boolean;
    hidden?: boolean;
    responsiveVariant?: boolean;
  };
  visual?: {
    zIndex?: number;
    effectiveZIndex?: number;
    overlapIds?: string[];
    overlapCount?: number;
    layer?: LayoutVisualLayer;
    prominence?: number;
    dominantViewport?: ResponsiveViewportName;
  };
  detection?: {
    semanticRole?: LayoutSemanticRole;
    confidence?: number;
    landmark?: boolean;
    repeated?: boolean;
    containsHeading?: boolean;
    containsInteractive?: boolean;
    containsMedia?: boolean;
  };
  responsive: Partial<Record<ResponsiveViewportName, ResponsiveLayoutState>>;
};

export type DetectedSectionType =
  | "header"
  | "hero"
  | "section"
  | "cta"
  | "faq"
  | "grid"
  | "footer";

export type DetectedSection = {
  id: string;
  type: DetectedSectionType;
  confidence: number;
  childIds: string[];
  anchors: string[];
  contains: LayoutSemanticRole[];
  dominantPattern?: string;
};

export type LayoutDocument = {
  id: string;
  title: string;
  sourceKind: "raw-html" | "static-html-archive" | "lovable-react-source";
  rootNodeId: string;
  nodeCount: number;
  sectionIds: string[];
  semanticIndex: Partial<Record<LayoutSemanticRole, string[]>>;
  detectedSections: DetectedSection[];
  nodes: LayoutNode[];
};

export type OutputMode = "snapshot" | "pixel-perfect" | "hybrid" | "editable" | "theme";

export type ComplexityAnalysis = {
  score: number;
  overlappingGroups: number;
  gridContainers: number;
  flexContainers: number;
  absoluteNodes: number;
  decorativeNodes: number;
  interactiveNodes: number;
  selectedMode: OutputMode;
  reasons: string[];
};
