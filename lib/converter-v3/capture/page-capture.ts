import type {
  BoxSnapshotNode,
  CaptureArtifacts,
  CaptureSummary,
  DomSnapshotNode,
  PageCapture,
  ResponsiveSnapshotNode,
  StyleSnapshotNode
} from "@/lib/converter-v3/contracts/capture";
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
