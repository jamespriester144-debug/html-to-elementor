import type {
  ResolvedAssetKind,
  ResolvedAssetLocation,
  SourceKind
} from "@/lib/converter-v3/contracts/source";

export type InputLayoutType =
  | "static-html"
  | "lovable-export"
  | "vite-react-export"
  | "react-runtime"
  | "inline-css"
  | "external-css"
  | "local-assets"
  | "remote-assets"
  | "tailwind"
  | "bootstrap"
  | "absolute-layout"
  | "flex-layout"
  | "grid-layout"
  | "scripted";

export type InputFrameworkHint =
  | "lovable"
  | "react"
  | "vite"
  | "tailwind"
  | "bootstrap";

export type InputAssetKind = ResolvedAssetKind | "background" | "iframe" | "link";

export type InputAssetReference = {
  url: string;
  originalUrl: string;
  kind: InputAssetKind;
  location: ResolvedAssetLocation;
  sourceTag: string;
  sourceAttribute: string;
  external: boolean;
  lazy: boolean;
};

export type InputAssetLoadStatus = {
  url: string;
  kind: InputAssetKind;
  status: "loaded" | "failed" | "pending" | "skipped";
  reason?: string;
  sourceTag?: string;
  sourceAttribute?: string;
  lazy?: boolean;
};

export type InputPageSectionCandidate = {
  key: string;
  tag: string;
  id?: string;
  role?: string;
  reason: string;
  depth: number;
  estimatedChildren: number;
};

export type InputPageStructureSummary = {
  totalElements: number;
  realSectionCount: number;
  headers: number;
  navbars: number;
  heroSections: number;
  cards: number;
  grids: number;
  buttons: number;
  images: number;
  backgrounds: number;
  absoluteFixedSticky: number;
  zIndexNodes: number;
  iframes: number;
  scripts: number;
  lazyLoadElements: number;
  externalAssets: number;
  externalFonts: number;
  links: number;
  forms: number;
  carousels: number;
  transformedElements: number;
  overflowHiddenElements: number;
  outOfFlowElements: number;
};

export type InputPageRenderStrategy = {
  requiresBrowserRender: boolean;
  preferVisualSnapshot: boolean;
  preferFullPageSnapshot: boolean;
  safeSectionExtraction: boolean;
  reasons: string[];
};

export type InputPageDiagnostics = {
  errors: string[];
  warnings: string[];
  rendererUsed?: "browser" | "server";
  htmlRendered?: boolean;
  cssLoaded?: boolean;
  imagesLoaded?: boolean;
  relativeAssetsResolved?: boolean;
  viewportMatched?: boolean;
  sectionCroppingRisk?: boolean;
  fullPageSnapshotFailed?: boolean;
  resources: InputAssetLoadStatus[];
};

export type InputPageAnalysis = {
  fileName: string;
  sourceKind: SourceKind;
  layoutTypes: InputLayoutType[];
  frameworkHints: InputFrameworkHint[];
  structure: InputPageStructureSummary;
  sectionCandidates: InputPageSectionCandidate[];
  assets: {
    found: InputAssetReference[];
    total: number;
    local: number;
    external: number;
    embedded: number;
    images: number;
    backgrounds: number;
    stylesheets: number;
    fonts: number;
    scripts: number;
    iframes: number;
    lazy: number;
    loaded: number;
    failed: number;
  };
  renderStrategy: InputPageRenderStrategy;
  diagnostics: InputPageDiagnostics;
};
