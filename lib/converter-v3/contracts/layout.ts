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
    flexWrap?: string;
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
    background?: string;
    backgroundColor?: string;
    backgroundImage?: string;
    backgroundSize?: string;
    backgroundPosition?: string;
    backgroundRepeat?: string;
    backgroundClip?: string;
    backgroundBlendMode?: string;
    backgroundOrigin?: string;
    backgroundAttachment?: string;
    color?: string;
    fontSize?: string;
    fontFamily?: string;
    fontStyle?: string;
    fontWeight?: string;
    lineHeight?: string;
    letterSpacing?: string;
    textTransform?: string;
    textDecoration?: string;
    whiteSpace?: string;
    textAlign?: string;
    border?: string;
    borderColor?: string;
    borderWidth?: string;
    borderStyle?: string;
    borderRadius?: string;
    boxShadow?: string;
    textShadow?: string;
    width?: string;
    height?: string;
    minWidth?: string;
    maxWidth?: string;
    minHeight?: string;
    maxHeight?: string;
    top?: string;
    right?: string;
    bottom?: string;
    left?: string;
    inset?: string;
    overflow?: string;
    overflowX?: string;
    overflowY?: string;
    objectFit?: string;
    objectPosition?: string;
    opacity?: string;
    filter?: string;
    backdropFilter?: string;
    mixBlendMode?: string;
    isolation?: string;
    maskImage?: string;
    webkitMaskImage?: string;
    transform?: string;
    zIndex?: string;
    pointerEvents?: string;
    cursor?: string;
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
    flexWrap?: string;
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
    background?: string;
    backgroundColor?: string;
    backgroundImage?: string;
    backgroundSize?: string;
    backgroundPosition?: string;
    backgroundRepeat?: string;
    backgroundClip?: string;
    backgroundBlendMode?: string;
    backgroundOrigin?: string;
    backgroundAttachment?: string;
    color?: string;
    fontSize?: string;
    fontFamily?: string;
    fontStyle?: string;
    fontWeight?: string;
    lineHeight?: string;
    letterSpacing?: string;
    textTransform?: string;
    textDecoration?: string;
    whiteSpace?: string;
    textAlign?: string;
    border?: string;
    borderColor?: string;
    borderWidth?: string;
    borderStyle?: string;
    borderRadius?: string;
    boxShadow?: string;
    textShadow?: string;
    width?: string;
    height?: string;
    minWidth?: string;
    maxWidth?: string;
    minHeight?: string;
    maxHeight?: string;
    top?: string;
    right?: string;
    bottom?: string;
    left?: string;
    inset?: string;
    overflow?: string;
    overflowX?: string;
    overflowY?: string;
    objectFit?: string;
    objectPosition?: string;
    opacity?: string;
    filter?: string;
    backdropFilter?: string;
    mixBlendMode?: string;
    isolation?: string;
    maskImage?: string;
    webkitMaskImage?: string;
    transform?: string;
    zIndex?: string;
    pointerEvents?: string;
    cursor?: string;
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
