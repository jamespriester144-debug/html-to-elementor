import type { PageCapture } from "@/lib/converter-v3/contracts/capture";
import type { LayoutDocument } from "@/lib/converter-v3/contracts/layout";

export function isLovableLikeSource(capture: PageCapture): boolean {
  return (
    capture.sourceKind === "lovable-react-source" ||
    capture.inputAnalysis.frameworkHints.includes("lovable") ||
    capture.inputAnalysis.layoutTypes.includes("lovable-export")
  );
}

export function shouldForceUniversalFullPageSnapshot(
  capture: PageCapture,
  layout: LayoutDocument
): boolean {
  const renderedInBrowser =
    capture.renderer === "browser" && capture.inputAnalysis.diagnostics.htmlRendered === true;

  if (!renderedInBrowser || !isLovableLikeSource(capture)) {
    return false;
  }

  const structure = capture.inputAnalysis.structure;
  const renderStrategy = capture.inputAnalysis.renderStrategy;
  const sectionCount =
    layout.detectedSections.length ||
    layout.sectionIds.length ||
    capture.inputAnalysis.sectionCandidates.length;

  if (!renderStrategy.safeSectionExtraction || sectionCount === 0) {
    return true;
  }

  if (renderStrategy.preferFullPageSnapshot && sectionCount <= 1) {
    return true;
  }

  return (
    (structure.absoluteFixedSticky ?? 0) >= 8 ||
    (structure.zIndexNodes ?? 0) >= 8 ||
    (structure.transformedElements ?? 0) >= 5 ||
    (structure.outOfFlowElements ?? 0) >= 10 ||
    structure.carousels > 0 ||
    structure.iframes > 0
  );
}
