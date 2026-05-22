import type {
  DetectedSection,
  DetectedSectionType,
  LayoutDocument,
  LayoutNode,
  LayoutSemanticRole
} from "@/lib/converter-v3/contracts/layout";

type NodeMaps = {
  byId: Map<string, LayoutNode>;
  childrenByParent: Map<string | null, LayoutNode[]>;
};

function buildNodeMaps(layout: LayoutDocument): NodeMaps {
  const byId = new Map(layout.nodes.map((node) => [node.id, node]));
  const childrenByParent = new Map<string | null, LayoutNode[]>();

  for (const node of layout.nodes) {
    const siblings = childrenByParent.get(node.parentId) ?? [];
    siblings.push(node);
    childrenByParent.set(node.parentId, siblings);
  }

  return { byId, childrenByParent };
}

function collectSubtree(nodeId: string, byId: NodeMaps["byId"]): LayoutNode[] {
  const collected: LayoutNode[] = [];
  const queue = [nodeId];

  while (queue.length) {
    const currentId = queue.shift();

    if (!currentId) {
      continue;
    }

    const node = byId.get(currentId);

    if (!node) {
      continue;
    }

    collected.push(node);
    queue.push(...node.children);
  }

  return collected;
}

function firstRowColumnCount(children: LayoutNode[]): number {
  const visible = children
    .filter((child) => !child.flags.hidden && child.box.width > 0 && child.box.height > 0)
    .sort((left, right) => left.box.y - right.box.y || left.box.x - right.box.x);

  if (visible.length <= 1) {
    return visible.length;
  }

  const baseline = visible[0];
  const tolerance = Math.max(24, baseline.box.height * 0.5);

  return visible.filter((child) => Math.abs(child.box.y - baseline.box.y) <= tolerance).length;
}

function sizeVariance(children: LayoutNode[]): number {
  if (children.length <= 1) {
    return 0;
  }

  const areas = children.map((child) => Math.max(child.box.width, 1) * Math.max(child.box.height, 1));
  const average = areas.reduce((sum, area) => sum + area, 0) / areas.length;
  const maxDeviation = Math.max(...areas.map((area) => Math.abs(area - average)));

  return maxDeviation / average;
}

function nodeHasHeading(node: LayoutNode, byId: NodeMaps["byId"]): boolean {
  return collectSubtree(node.id, byId).some((candidate) => /^h[1-6]$/i.test(candidate.tag ?? ""));
}

function nodeHasButton(node: LayoutNode, byId: NodeMaps["byId"]): boolean {
  return collectSubtree(node.id, byId).some((candidate) => candidate.kind === "button");
}

function nodeHasImage(node: LayoutNode, byId: NodeMaps["byId"]): boolean {
  return collectSubtree(node.id, byId).some(
    (candidate) => candidate.kind === "image" || Boolean(candidate.style.backgroundImage)
  );
}

function nodeHasMultipleLinks(node: LayoutNode, byId: NodeMaps["byId"]): boolean {
  return collectSubtree(node.id, byId).filter((candidate) => candidate.kind === "button").length >= 2;
}

function isGridLike(node: LayoutNode, byId: NodeMaps["byId"]): boolean {
  const children = node.children
    .map((childId) => byId.get(childId))
    .filter((child): child is LayoutNode => Boolean(child));
  const primitiveChildren = children.filter((child) =>
    ["text", "button", "badge"].includes(child.kind)
  ).length;

  if (children.length < 2) {
    return false;
  }

  return (
    node.layout.display === "grid" ||
    Boolean(node.layout.gridTemplateColumns) ||
    (firstRowColumnCount(children) >= 2 && primitiveChildren === 0)
  );
}

function isCardLike(node: LayoutNode, byId: NodeMaps["byId"]): boolean {
  if (node.kind !== "container" && node.kind !== "section") {
    return false;
  }

  const hasPresentation =
    Boolean(node.style.backgroundColor) ||
    Boolean(node.style.borderRadius) ||
    Boolean(node.style.boxShadow);

  const hasContent = nodeHasHeading(node, byId) || nodeHasButton(node, byId) || nodeHasImage(node, byId);

  return hasPresentation && hasContent;
}

function detectRepeatedCards(node: LayoutNode, byId: NodeMaps["byId"]): string[] {
  const children = node.children
    .map((childId) => byId.get(childId))
    .filter((child): child is LayoutNode => Boolean(child))
    .filter((child) => !child.flags.hidden && (child.kind === "container" || child.kind === "section"));

  if (children.length < 2) {
    return [];
  }

  if (!isGridLike(node, byId) && firstRowColumnCount(children) < 2) {
    return [];
  }

  if (sizeVariance(children) > 0.45) {
    return [];
  }

  const cardIds = children.filter((child) => isCardLike(child, byId)).map((child) => child.id);
  return cardIds.length >= 2 ? cardIds : [];
}

function classifySectionType(params: {
  node: LayoutNode;
  index: number;
  lastIndex: number;
  maxBottom: number;
  byId: NodeMaps["byId"];
  gridNodeIds: Set<string>;
}): { type: DetectedSectionType; confidence: number } {
  const { node, index, lastIndex, maxBottom, byId, gridNodeIds } = params;
  const hasHeading = nodeHasHeading(node, byId);
  const hasButton = nodeHasButton(node, byId);
  const hasImage = nodeHasImage(node, byId);
  const multipleLinks = nodeHasMultipleLinks(node, byId);

  if (node.tag === "header" || (index === 0 && node.box.y <= 120 && multipleLinks)) {
    return { type: "header", confidence: node.tag === "header" ? 0.99 : 0.82 };
  }

  if (
    node.tag === "footer" ||
    (index === lastIndex && node.box.y + node.box.height >= maxBottom * 0.82 && multipleLinks)
  ) {
    return { type: "footer", confidence: node.tag === "footer" ? 0.99 : 0.84 };
  }

  if (gridNodeIds.has(node.id)) {
    return { type: "grid", confidence: 0.86 };
  }

  if (index <= 1 && hasHeading && (hasButton || hasImage) && node.box.height >= 280) {
    return { type: "hero", confidence: 0.9 };
  }

  return { type: "section", confidence: 0.72 };
}

function uniqueRoles(values: Array<LayoutSemanticRole | undefined>): LayoutSemanticRole[] {
  return [...new Set(values.filter((value): value is LayoutSemanticRole => Boolean(value)))];
}

export function classifySections(layout: LayoutDocument): LayoutDocument {
  const maps = buildNodeMaps(layout);
  const gridNodeIds = new Set<string>();
  const cardNodeIds = new Set<string>();

  for (const node of layout.nodes) {
    if (isGridLike(node, maps.byId)) {
      gridNodeIds.add(node.id);
    }

    for (const cardId of detectRepeatedCards(node, maps.byId)) {
      cardNodeIds.add(cardId);
      gridNodeIds.add(node.id);
    }
  }

  const sectionCandidates = (layout.sectionIds.length
    ? layout.sectionIds
    : layout.nodes
        .filter((node) => node.parentId === layout.rootNodeId)
        .map((node) => node.id))
    .map((id) => maps.byId.get(id))
    .filter((node): node is LayoutNode => Boolean(node))
    .filter((node) => !node.flags.hidden)
    .sort((left, right) => left.box.y - right.box.y || left.visualOrder - right.visualOrder);
  const maxBottom = Math.max(...sectionCandidates.map((node) => node.box.y + node.box.height), 0);
  const detectedSections: DetectedSection[] = [];
  const sectionTypeById = new Map<string, { type: DetectedSectionType; confidence: number }>();

  sectionCandidates.forEach((node, index) => {
    const classification = classifySectionType({
      node,
      index,
      lastIndex: sectionCandidates.length - 1,
      maxBottom,
      byId: maps.byId,
      gridNodeIds
    });

    sectionTypeById.set(node.id, classification);
  });

  const nodes = layout.nodes.map((node) => {
    const sectionType = sectionTypeById.get(node.id);
    let semanticRole: LayoutSemanticRole | undefined;
    let confidence = 0.6;

    if (node.kind === "page") {
      semanticRole = "page";
      confidence = 1;
    } else if (node.kind === "button") {
      semanticRole = "button";
      confidence = 0.98;
    } else if (node.kind === "image") {
      semanticRole = "image";
      confidence = 0.98;
    } else if (node.kind === "text" || node.kind === "badge") {
      semanticRole = "text";
      confidence = 0.9;
    } else if (cardNodeIds.has(node.id)) {
      semanticRole = "card";
      confidence = 0.88;
    } else if (sectionType) {
      semanticRole = sectionType.type;
      confidence = sectionType.confidence;
    } else if (gridNodeIds.has(node.id)) {
      semanticRole = "grid";
      confidence = 0.82;
    } else if (node.visual?.layer === "overlay") {
      semanticRole = "overlay";
      confidence = 0.76;
    } else if (node.kind === "section") {
      semanticRole = "section";
      confidence = 0.72;
    }

    const subtree = collectSubtree(node.id, maps.byId);

    return {
      ...node,
      detection: {
        ...node.detection,
        semanticRole,
        confidence,
        landmark: semanticRole === "header" || semanticRole === "hero" || semanticRole === "footer",
        repeated: cardNodeIds.has(node.id),
        containsHeading: subtree.some((candidate) => /^h[1-6]$/i.test(candidate.tag ?? "")),
        containsInteractive: subtree.some((candidate) => candidate.kind === "button"),
        containsMedia: subtree.some((candidate) => candidate.kind === "image")
      }
    };
  });

  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  for (const node of sectionCandidates) {
    const enrichedNode = nodeById.get(node.id);
    const sectionType = sectionTypeById.get(node.id);

    if (!enrichedNode || !sectionType) {
      continue;
    }

    const subtree = collectSubtree(node.id, nodeById);
    const anchors = subtree
      .filter((candidate) => candidate.kind === "button" && candidate.content.href)
      .map((candidate) => candidate.content.href as string);
    const contains = uniqueRoles(subtree.map((candidate) => candidate.detection?.semanticRole));

    detectedSections.push({
      id: node.id,
      type: sectionType.type,
      confidence: sectionType.confidence,
      childIds: enrichedNode.children,
      anchors,
      contains,
      dominantPattern:
        sectionType.type === "grid"
          ? "multi-column"
          : enrichedNode.detection?.containsMedia && enrichedNode.detection?.containsInteractive
            ? "cta-media"
            : "stack"
    });
  }

  const semanticIndex = nodes.reduce<LayoutDocument["semanticIndex"]>((acc, node) => {
    const role = node.detection?.semanticRole;

    if (!role) {
      return acc;
    }

    const ids = acc[role] ?? [];
    ids.push(node.id);
    acc[role] = ids;

    return acc;
  }, {});

  return {
    ...layout,
    nodes,
    detectedSections,
    semanticIndex
  };
}
