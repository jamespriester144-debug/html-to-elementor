import type {
  LayoutDocument,
  LayoutNode,
  LayoutVisualLayer,
  ResponsiveViewportName
} from "@/lib/converter-v3/contracts/layout";

function parseZIndex(value?: string): number {
  if (!value || value === "auto") {
    return 0;
  }

  const numeric = Number.parseInt(value, 10);
  return Number.isFinite(numeric) ? numeric : 0;
}

function getViewportArea(node: LayoutNode, viewport: ResponsiveViewportName): number {
  const box = node.responsive[viewport]?.box;

  if (!box || !node.responsive[viewport]?.isVisible) {
    return 0;
  }

  return Math.max(box.width, 0) * Math.max(box.height, 0);
}

function getDominantViewport(node: LayoutNode): ResponsiveViewportName {
  const viewports: ResponsiveViewportName[] = ["desktop", "tablet", "mobile"];
  let winner: ResponsiveViewportName = "desktop";
  let maxArea = -1;

  for (const viewport of viewports) {
    const area = getViewportArea(node, viewport);

    if (area > maxArea) {
      maxArea = area;
      winner = viewport;
    }
  }

  return winner;
}

function boxesOverlap(left: LayoutNode, right: LayoutNode): boolean {
  if (!left.box.width || !left.box.height || !right.box.width || !right.box.height) {
    return false;
  }

  return !(
    left.box.x + left.box.width <= right.box.x ||
    right.box.x + right.box.width <= left.box.x ||
    left.box.y + left.box.height <= right.box.y ||
    right.box.y + right.box.height <= left.box.y
  );
}

function resolveVisualLayer(node: LayoutNode, zIndex: number, overlapCount: number): LayoutVisualLayer {
  if (
    zIndex > 0 ||
    overlapCount > 0 ||
    ["absolute", "fixed", "sticky"].includes(node.layout.position ?? "")
  ) {
    return "overlay";
  }

  if (
    node.flags.decorative ||
    (!node.content.text && !node.content.href && !node.content.src && node.kind === "container")
  ) {
    return "background";
  }

  return "content";
}

function calculateProminence(node: LayoutNode): number {
  const area = Math.max(node.box.width, 0) * Math.max(node.box.height, 0);
  const textWeight = node.content.text ? Math.min(node.content.text.length, 140) * 6 : 0;
  const interactiveWeight = node.kind === "button" ? 12000 : 0;
  const mediaWeight = node.kind === "image" ? 18000 : 0;
  const sectionWeight = node.kind === "section" ? 22000 : 0;

  return area + textWeight + interactiveWeight + mediaWeight + sectionWeight;
}

export function buildVisualHierarchy(layout: LayoutDocument): LayoutDocument {
  const nodes = layout.nodes.map((node) => {
    const overlapIds = layout.nodes
      .filter((candidate) => candidate.id !== node.id && !candidate.flags.hidden)
      .filter((candidate) => boxesOverlap(node, candidate))
      .map((candidate) => candidate.id)
      .sort();
    const zIndex = parseZIndex(node.style.zIndex);
    const effectiveZIndex =
      zIndex +
      (["absolute", "fixed", "sticky"].includes(node.layout.position ?? "") ? 1 : 0);

    return {
      ...node,
      visual: {
        ...node.visual,
        zIndex,
        effectiveZIndex,
        overlapIds,
        overlapCount: overlapIds.length,
        layer: resolveVisualLayer(node, effectiveZIndex, overlapIds.length),
        prominence: calculateProminence(node),
        dominantViewport: getDominantViewport(node)
      }
    };
  });

  return {
    ...layout,
    nodes
  };
}
