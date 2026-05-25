import type { PageCapture } from "@/lib/converter-v3/contracts/capture";
import type { LayoutDocument, LayoutNode } from "@/lib/converter-v3/contracts/layout";
import { isLovableLikeSource } from "@/lib/converter-v3/visual-clone-policy";

export function shouldUseUniversalNeutralLayoutMode(
  capture: PageCapture,
  layout: LayoutDocument
) : boolean {
  const renderedInBrowser =
    capture.renderer === "browser" && capture.inputAnalysis.diagnostics.htmlRendered === true;
  const modernUtilityLayout =
    capture.inputAnalysis.frameworkHints.includes("tailwind") ||
    (capture.summary.visualContainers ?? 0) > 0 ||
    (capture.summary.geometryGroups ?? 0) > 0 ||
    layout.nodeCount > 24;

  return renderedInBrowser && isLovableLikeSource(capture) && modernUtilityLayout;
}

export function getVisualOrderChildIds(
  node: Pick<LayoutNode, "children">,
  layoutById: Map<string, LayoutNode>
) : string[] {
  return [...node.children].sort((leftId, rightId) => {
    const left = layoutById.get(leftId);
    const right = layoutById.get(rightId);

    if (!left || !right) {
      return leftId.localeCompare(rightId);
    }

    return (
      left.visualOrder - right.visualOrder ||
      left.box.y - right.box.y ||
      left.box.x - right.box.x ||
      leftId.localeCompare(rightId)
    );
  });
}
