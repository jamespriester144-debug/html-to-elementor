import type {
  BoxSnapshotNode,
  CaptureArtifacts,
  CaptureSummary,
  DomSnapshotNode,
  PageCapture,
  ResponsiveSnapshotNode,
  StyleSnapshotNode
} from "@/lib/converter-v3/contracts/capture";
import { enrichInputPageAnalysis } from "@/lib/converter-v3/analyze/input-page-analyzer";
import type { ResolvedSource } from "@/lib/converter-v3/contracts/source";
import type { BrowserRenderArtifact } from "@/lib/converter-v3/render/browser-renderer";

function createSummary(rendered: BrowserRenderArtifact): CaptureSummary {
  return {
    totalNodes: rendered.nodes.length,
    visibleNodes: rendered.nodes.filter((node) => node.isVisible).length,
    images: rendered.nodes.filter((node) => node.tag === "img").length,
    buttons: rendered.nodes.filter((node) =>
      node.tag === "button" ||
      (node.tag === "a" && Boolean(node.attributes.href)) ||
      node.attributes.role === "button"
    ).length,
    textBlocks: rendered.nodes.filter((node) =>
      ["p", "span", "li", "blockquote"].includes(node.tag) && Boolean(node.text)
    ).length,
    sections: rendered.nodes.filter((node) =>
      ["section", "header", "footer", "main", "article"].includes(node.tag)
    ).length
  };
}

export function createEmptyArtifacts(outputDir: string): CaptureArtifacts {
  return {
    outputDir,
    resolvedSourcePath: "",
    renderedHtmlPath: "",
    domSnapshotPath: "",
    styleSnapshotPath: "",
    boxSnapshotPath: "",
    responsiveSnapshotPath: "",
    layoutPath: "",
    analysisPath: "",
    pageCapturePath: "",
    sectionArtifactsPath: "",
    screenshots: {}
  };
}

export function buildPageCapture(
  resolvedSource: ResolvedSource,
  rendered: BrowserRenderArtifact,
  outputDir: string
): PageCapture {
  const domSnapshot: DomSnapshotNode[] = rendered.nodes.map((node) => ({
    id: node.id,
    tag: node.tag,
    text: node.text,
    attributes: node.attributes,
    parentId: node.parentId,
    childIds: node.childIds,
    visualOrder: node.visualOrder,
    isVisible: node.isVisible
  }));
  const styleSnapshot: StyleSnapshotNode[] = rendered.nodes.map((node) => ({
    id: node.id,
    computedStyles: node.computedStyles
  }));
  const boxSnapshot: BoxSnapshotNode[] = rendered.nodes.map((node) => ({
    id: node.id,
    box: node.box
  }));
  const responsiveSnapshot: ResponsiveSnapshotNode[] = rendered.nodes.map((node) => ({
    id: node.id,
    viewportStates: node.viewportStates
  }));

  return {
    id: resolvedSource.id,
    sourceKind: resolvedSource.sourceKind,
    title: rendered.title || resolvedSource.title,
    sourceHtml: resolvedSource.html,
    renderedHtml: rendered.renderedHtml,
    renderer: rendered.renderer,
    inputAnalysis: enrichInputPageAnalysis(
      resolvedSource.inputAnalysis ??
        {
          fileName: resolvedSource.sourcePath ?? resolvedSource.entryFile ?? resolvedSource.title,
          sourceKind: resolvedSource.sourceKind,
          layoutTypes: ["static-html"],
          frameworkHints: [],
          structure: {
            totalElements: rendered.nodes.length,
            realSectionCount: 0,
            headers: 0,
            navbars: 0,
            heroSections: 0,
            cards: 0,
            grids: 0,
            buttons: 0,
            images: 0,
            backgrounds: 0,
            absoluteFixedSticky: 0,
            zIndexNodes: 0,
            iframes: 0,
            scripts: 0,
            lazyLoadElements: 0,
            externalAssets: 0,
            externalFonts: 0,
            links: 0,
            forms: 0,
            carousels: 0,
            transformedElements: 0,
            overflowHiddenElements: 0,
            outOfFlowElements: 0
          },
          sectionCandidates: [],
          assets: {
            found: [],
            total: 0,
            local: 0,
            external: 0,
            embedded: 0,
            images: 0,
            backgrounds: 0,
            stylesheets: 0,
            fonts: 0,
            scripts: 0,
            iframes: 0,
            lazy: 0,
            loaded: 0,
            failed: 0
          },
          renderStrategy: {
            requiresBrowserRender: rendered.renderer === "browser",
            preferVisualSnapshot: false,
            preferFullPageSnapshot: false,
            safeSectionExtraction: true,
            reasons: []
          },
          diagnostics: {
            errors: [],
            warnings: [],
            resources: []
          }
        },
      {
        renderer: rendered.renderer,
        htmlRendered: rendered.diagnostics.htmlRendered,
        cssLoaded: rendered.diagnostics.cssLoaded,
        imagesLoaded: rendered.diagnostics.imagesLoaded,
        relativeAssetsResolved: rendered.diagnostics.relativeAssetsResolved,
        viewportMatched: rendered.diagnostics.viewportMatched,
        sectionCroppingRisk: false,
        fullPageSnapshotFailed: false,
        resources: rendered.diagnostics.resources,
        warnings: rendered.diagnostics.warnings,
        errors: rendered.diagnostics.errors
      }
    ),
    viewports: rendered.viewports,
    domSnapshot,
    styleSnapshot,
    boxSnapshot,
    responsiveSnapshot,
    nodes: rendered.nodes,
    summary: createSummary(rendered),
    artifacts: {
      ...createEmptyArtifacts(outputDir),
      screenshots: rendered.screenshots
    }
  };
}
