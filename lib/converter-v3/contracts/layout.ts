export type LayoutNodeKind =
  | "page"
  | "section"
  | "container"
  | "text"
  | "image"
  | "button"
  | "badge";

export type ResponsiveViewportName = "desktop" | "tablet" | "mobile";

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
  responsive: Partial<Record<ResponsiveViewportName, ResponsiveLayoutState>>;
};

export type LayoutDocument = {
  id: string;
  title: string;
  sourceKind: "raw-html" | "static-html-archive" | "lovable-react-source";
  rootNodeId: string;
  nodeCount: number;
  sectionIds: string[];
  nodes: LayoutNode[];
};

export type OutputMode = "pixel-perfect" | "hybrid" | "editable" | "theme";

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
