import type { ComplexityAnalysis, LayoutDocument, LayoutNode } from "@/lib/converter-v3/contracts/layout";

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

function countOverlappingSiblingGroups(layout: LayoutDocument): number {
  const byParent = new Map<string | null, LayoutNode[]>();

  for (const node of layout.nodes) {
    const siblings = byParent.get(node.parentId) ?? [];
    siblings.push(node);
    byParent.set(node.parentId, siblings);
  }

  let overlaps = 0;

  for (const siblings of byParent.values()) {
    for (let index = 0; index < siblings.length; index += 1) {
      for (let nextIndex = index + 1; nextIndex < siblings.length; nextIndex += 1) {
        if (boxesOverlap(siblings[index], siblings[nextIndex])) {
          overlaps += 1;
        }
      }
    }
  }

  return overlaps;
}

export function analyzeLayoutComplexity(layout: LayoutDocument): ComplexityAnalysis {
  const gridContainers = layout.nodes.filter(
    (node) =>
      node.layout.display === "grid" ||
      Boolean(node.layout.gridTemplateColumns)
  ).length;
  const flexContainers = layout.nodes.filter(
    (node) => node.layout.display === "flex"
  ).length;
  const absoluteNodes = layout.nodes.filter((node) =>
    ["absolute", "fixed", "sticky"].includes(node.layout.position ?? "")
  ).length;
  const decorativeNodes = layout.nodes.filter((node) => node.flags.decorative).length;
  const interactiveNodes = layout.nodes.filter((node) => node.kind === "button").length;
  const overlappingGroups = countOverlappingSiblingGroups(layout);

  let score = 0;
  const reasons: string[] = [];

  score += Math.min(gridContainers * 2, 8);
  score += Math.min(flexContainers, 6);
  score += Math.min(absoluteNodes * 2, 8);
  score += Math.min(decorativeNodes, 4);
  score += Math.min(interactiveNodes > 6 ? 2 : interactiveNodes > 2 ? 1 : 0, 2);
  score += Math.min(overlappingGroups * 3, 9);
  score += layout.nodeCount > 120 ? 4 : layout.nodeCount > 60 ? 2 : layout.nodeCount > 24 ? 1 : 0;
  score += layout.sectionIds.length > 8 ? 1 : 0;
  score += layout.sourceKind === "lovable-react-source" ? 1 : 0;

  if (gridContainers > 0) {
    reasons.push(`Detectados ${gridContainers} containers em grid.`);
  }
  if (absoluteNodes > 0) {
    reasons.push(`Detectados ${absoluteNodes} elementos absolutos/fixos.`);
  }
  if (decorativeNodes > 0) {
    reasons.push(`Detectados ${decorativeNodes} elementos decorativos.`);
  }
  if (overlappingGroups > 0) {
    reasons.push(`Detectados ${overlappingGroups} grupos com sobreposicao visual.`);
  }
  if (layout.nodeCount > 60) {
    reasons.push(`Documento com ${layout.nodeCount} nos visuais.`);
  }

  let selectedMode: ComplexityAnalysis["selectedMode"] = "editable";

  if (
    score >= 11 ||
    overlappingGroups >= 2 ||
    (absoluteNodes >= 3 && gridContainers >= 2)
  ) {
    selectedMode = "pixel-perfect";
  } else if (score >= 5 || gridContainers >= 1 || absoluteNodes >= 1) {
    selectedMode = "hybrid";
  }

  if (!reasons.length) {
    reasons.push("Layout simples, sem sinais fortes de complexidade estrutural.");
  }

  return {
    score,
    overlappingGroups,
    gridContainers,
    flexContainers,
    absoluteNodes,
    decorativeNodes,
    interactiveNodes,
    selectedMode,
    reasons
  };
}
