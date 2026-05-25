import type { CapturedNode, PageCapture } from "@/lib/converter-v3/contracts/capture";
import type { LayoutDocument, LayoutNode, LayoutNodeKind } from "@/lib/converter-v3/contracts/layout";
import { orderSiblingNodesByVisualFlow } from "@/lib/converter-v3/normalize/visual-order";

function pickText(value: string): string | undefined {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function pickStyle(
  styles: Record<string, string>,
  property: string
): string | undefined {
  const value = styles[property];
  return value && value !== "initial" && value !== "normal" && value !== "none"
    ? value
    : undefined;
}

function getLayoutNodeKind(node: CapturedNode): LayoutNodeKind {
  if (node.tag === "body") return "page";
  if (node.tag === "img") return "image";
  if (node.tag === "button" || (node.tag === "a" && Boolean(node.attributes.href))) {
    return "button";
  }
  if (["header", "footer", "section", "main", "article", "nav"].includes(node.tag)) {
    return "section";
  }
  if (
    ["span", "small"].includes(node.tag) &&
    /badge|pill|tag|eyebrow|label/i.test(node.attributes.class ?? "")
  ) {
    return "badge";
  }
  if (
    /^(h[1-6]|p|span|small|strong|em|label|li|blockquote)$/.test(node.tag) &&
    Boolean(pickText(node.text))
  ) {
    return "text";
  }

  return "container";
}

function isDecorativeNode(node: CapturedNode, kind: LayoutNodeKind): boolean {
  const className = node.attributes.class ?? "";
  const hasMeaningfulText = Boolean(pickText(node.text));
  const hasMedia = kind === "image";
  const hasAction = kind === "button";
  const backgroundImage = pickStyle(node.computedStyles, "background-image");
  const hasBackgroundImageAsset = Boolean(backgroundImage) && /url\(/i.test(backgroundImage ?? "");
  const hasBackground =
    Boolean(pickStyle(node.computedStyles, "background")) ||
    Boolean(pickStyle(node.computedStyles, "background-color")) ||
    Boolean(backgroundImage);
  const isAbsolute =
    pickStyle(node.computedStyles, "position") === "absolute" ||
    pickStyle(node.computedStyles, "position") === "fixed";

  if (hasMeaningfulText || hasMedia || hasAction || hasBackgroundImageAsset) {
    return false;
  }

  return (
    isAbsolute ||
    /blur|glow|overlay|decoration|ornament/i.test(className) ||
    (hasBackground && !node.childIds.length)
  );
}

function isResponsiveVariant(node: CapturedNode): boolean {
  const className = node.attributes.class ?? "";
  return /\b(?:sm|md|lg|xl|2xl):/.test(className);
}

function buildLayoutNode(
  node: CapturedNode,
  orderedChildIds: string[]
): LayoutNode {
  const kind = getLayoutNodeKind(node);
  const text = pickText(node.text);

  return {
    id: node.id,
    tag: node.tag,
    kind,
    parentId: node.parentId,
    children: orderedChildIds,
    box: {
      x: node.box?.x ?? 0,
      y: node.box?.y ?? 0,
      width: node.box?.width ?? 0,
      height: node.box?.height ?? 0
    },
    visualOrder: node.visualOrder,
    layout: {
      display: pickStyle(node.computedStyles, "display"),
      position: pickStyle(node.computedStyles, "position"),
      flexDirection: pickStyle(node.computedStyles, "flex-direction"),
      justifyContent: pickStyle(node.computedStyles, "justify-content"),
      alignItems: pickStyle(node.computedStyles, "align-items"),
      gap: pickStyle(node.computedStyles, "gap"),
      gridTemplateColumns: pickStyle(node.computedStyles, "grid-template-columns"),
      gridTemplateRows: pickStyle(node.computedStyles, "grid-template-rows")
    },
    spacing: {
      margin: pickStyle(node.computedStyles, "margin"),
      padding: pickStyle(node.computedStyles, "padding")
    },
    style: {
      backgroundColor: pickStyle(node.computedStyles, "background-color"),
      backgroundImage: pickStyle(node.computedStyles, "background-image"),
      backgroundSize: pickStyle(node.computedStyles, "background-size"),
      backgroundPosition: pickStyle(node.computedStyles, "background-position"),
      color: pickStyle(node.computedStyles, "color"),
      fontSize: pickStyle(node.computedStyles, "font-size"),
      fontFamily: pickStyle(node.computedStyles, "font-family"),
      fontWeight: pickStyle(node.computedStyles, "font-weight"),
      lineHeight: pickStyle(node.computedStyles, "line-height"),
      textAlign: pickStyle(node.computedStyles, "text-align"),
      borderRadius: pickStyle(node.computedStyles, "border-radius"),
      boxShadow: pickStyle(node.computedStyles, "box-shadow"),
      objectFit: pickStyle(node.computedStyles, "object-fit"),
      objectPosition: pickStyle(node.computedStyles, "object-position"),
      zIndex: pickStyle(node.computedStyles, "z-index")
    },
    content: {
      text,
      src: node.tag === "img" ? node.asset.src ?? node.attributes.src : undefined,
      href:
        node.tag === "a" || node.tag === "button"
          ? node.asset.href ?? node.attributes.href
          : undefined,
      alt: node.tag === "img" ? node.asset.alt ?? node.attributes.alt : undefined
    },
    flags: {
      decorative: isDecorativeNode(node, kind),
      hidden: !node.isVisible,
      responsiveVariant: isResponsiveVariant(node)
    },
    responsive: Object.fromEntries(
      Object.entries(node.viewportStates).map(([viewportName, viewportState]) => [
        viewportName,
        {
          isVisible: viewportState.isVisible,
          box: viewportState.box
            ? {
                x: viewportState.box.x,
                y: viewportState.box.y,
                width: viewportState.box.width,
                height: viewportState.box.height
              }
            : null,
          layout: {
            display: pickStyle(viewportState.computedStyles, "display"),
            position: pickStyle(viewportState.computedStyles, "position"),
            flexDirection: pickStyle(viewportState.computedStyles, "flex-direction"),
            justifyContent: pickStyle(viewportState.computedStyles, "justify-content"),
            alignItems: pickStyle(viewportState.computedStyles, "align-items"),
            gap: pickStyle(viewportState.computedStyles, "gap"),
            gridTemplateColumns: pickStyle(viewportState.computedStyles, "grid-template-columns"),
            gridTemplateRows: pickStyle(viewportState.computedStyles, "grid-template-rows")
          },
          spacing: {
            margin: pickStyle(viewportState.computedStyles, "margin"),
            padding: pickStyle(viewportState.computedStyles, "padding")
          },
          style: {
            backgroundColor: pickStyle(viewportState.computedStyles, "background-color"),
            backgroundImage: pickStyle(viewportState.computedStyles, "background-image"),
            backgroundSize: pickStyle(viewportState.computedStyles, "background-size"),
            backgroundPosition: pickStyle(viewportState.computedStyles, "background-position"),
            color: pickStyle(viewportState.computedStyles, "color"),
            fontSize: pickStyle(viewportState.computedStyles, "font-size"),
            fontFamily: pickStyle(viewportState.computedStyles, "font-family"),
            fontWeight: pickStyle(viewportState.computedStyles, "font-weight"),
            lineHeight: pickStyle(viewportState.computedStyles, "line-height"),
            textAlign: pickStyle(viewportState.computedStyles, "text-align"),
            borderRadius: pickStyle(viewportState.computedStyles, "border-radius"),
            boxShadow: pickStyle(viewportState.computedStyles, "box-shadow"),
            objectFit: pickStyle(viewportState.computedStyles, "object-fit"),
            objectPosition: pickStyle(viewportState.computedStyles, "object-position"),
            zIndex: pickStyle(viewportState.computedStyles, "z-index")
          }
        }
      ])
    )
  };
}

function orderChildrenPerParent(nodes: CapturedNode[]): Map<string | null, string[]> {
  const grouped = new Map<string | null, CapturedNode[]>();

  for (const node of nodes) {
    const siblings = grouped.get(node.parentId) ?? [];
    siblings.push(node);
    grouped.set(node.parentId, siblings);
  }

  return new Map(
    [...grouped.entries()].map(([parentId, siblings]) => [
      parentId,
      orderSiblingNodesByVisualFlow(siblings).map((node) => node.id)
    ])
  );
}

function normalizeParentId(node: CapturedNode, nodeIds: Set<string>, rootNodeId: string): string | null {
  if (!node.parentId) {
    return node.id === rootNodeId ? null : rootNodeId;
  }

  return nodeIds.has(node.parentId) ? node.parentId : rootNodeId;
}

function collectSubtreeNodes(nodeId: string, layoutById: Map<string, LayoutNode>) {
  const nodes: LayoutNode[] = [];
  const queue = [nodeId];

  while (queue.length) {
    const currentId = queue.shift();

    if (!currentId) {
      continue;
    }

    const node = layoutById.get(currentId);

    if (!node) {
      continue;
    }

    nodes.push(node);
    queue.push(...node.children);
  }

  return nodes;
}

function containsHeading(node: LayoutNode, layoutById: Map<string, LayoutNode>) {
  return collectSubtreeNodes(node.id, layoutById).some((candidate) =>
    /^h[1-6]$/i.test(candidate.tag ?? "")
  );
}

function containsMedia(node: LayoutNode, layoutById: Map<string, LayoutNode>) {
  return collectSubtreeNodes(node.id, layoutById).some(
    (candidate) =>
      candidate.kind === "image" ||
      (Boolean(candidate.style.backgroundImage) && /url\(/i.test(candidate.style.backgroundImage ?? "")) ||
      ["video", "iframe", "canvas", "svg"].includes(candidate.tag ?? "")
  );
}

function containsInteractive(node: LayoutNode, layoutById: Map<string, LayoutNode>) {
  return collectSubtreeNodes(node.id, layoutById).some((candidate) => candidate.kind === "button");
}

function isLikelySectionNode(
  node: LayoutNode,
  layoutById: Map<string, LayoutNode>,
  rootWidth: number
) {
  if (node.flags.hidden || node.flags.decorative) {
    return false;
  }

  const landmarkTag = ["header", "nav", "main", "section", "article", "footer"].includes(
    node.tag ?? ""
  );
  const hasBackground = Boolean(node.style.backgroundColor || node.style.backgroundImage);
  const hasLayoutStructure =
    node.layout.display === "flex" ||
    node.layout.display === "grid" ||
    Boolean(node.layout.gridTemplateColumns) ||
    node.children.length >= 2;
  const hasNarrativeContent =
    containsHeading(node, layoutById) || containsMedia(node, layoutById) || containsInteractive(node, layoutById);
  const significantHeight = node.box.height >= 180;
  const significantWidth = rootWidth <= 0 ? node.box.width > 0 : node.box.width >= rootWidth * 0.55;

  if (landmarkTag) {
    return true;
  }

  if (significantHeight && significantWidth && (hasLayoutStructure || hasNarrativeContent)) {
    return true;
  }

  if (hasBackground && significantWidth && node.children.length >= 1) {
    return true;
  }

  return false;
}

function findPrimaryContentContainer(layoutNodes: LayoutNode[], rootNodeId: string) {
  const topLevelNodes = layoutNodes.filter((node) => node.parentId === rootNodeId);
  const mainNode = topLevelNodes.find((node) => node.tag === "main");

  if (mainNode) {
    return mainNode;
  }

  return topLevelNodes
    .filter((node) => node.kind === "container" || node.kind === "section")
    .sort((left, right) => right.box.height - left.box.height || left.visualOrder - right.visualOrder)
    .find((node) => node.children.length >= 2 && node.box.height >= 320);
}

function detectSectionIds(layoutNodes: LayoutNode[], rootNodeId: string) {
  const layoutById = new Map(layoutNodes.map((node) => [node.id, node]));
  const rootNode = layoutById.get(rootNodeId);
  const rootWidth = rootNode?.box.width ?? 0;
  const primaryContainer = findPrimaryContentContainer(layoutNodes, rootNodeId);
  const candidateParentIds = new Set<string>([rootNodeId]);

  if (primaryContainer && primaryContainer.id !== rootNodeId) {
    candidateParentIds.add(primaryContainer.id);
  }

  const detected = layoutNodes
    .filter((node) => candidateParentIds.has(node.parentId ?? ""))
    .filter((node) => isLikelySectionNode(node, layoutById, rootWidth))
    .sort((left, right) => left.box.y - right.box.y || left.visualOrder - right.visualOrder);

  if (detected.length > 0) {
    return [...new Set(detected.map((node) => node.id))];
  }

  return layoutNodes
    .filter((node) => node.parentId === rootNodeId)
    .filter((node) => !node.flags.hidden && node.box.height >= 120)
    .sort((left, right) => left.box.y - right.box.y || left.visualOrder - right.visualOrder)
    .map((node) => node.id);
}

export function normalizeCaptureToLayoutDocument(capture: PageCapture): LayoutDocument {
  const retainedNodes = capture.nodes.filter(
    (node) =>
      node.tag !== "script" &&
      node.tag !== "noscript" &&
      node.tag !== "style"
  );
  const bodyNode = retainedNodes.find((node) => node.tag === "body") ?? retainedNodes[0];
  const rootNodeId = bodyNode?.id ?? "layout-root";
  const nodeIds = new Set(retainedNodes.map((node) => node.id));
  const normalizedNodes = retainedNodes.map((node) => ({
    ...node,
    parentId: normalizeParentId(node, nodeIds, rootNodeId)
  }));
  const normalizedNodeById = new Map(normalizedNodes.map((node) => [node.id, node]));
  const orderedChildrenByParent = orderChildrenPerParent(normalizedNodes);
  const layoutNodes = retainedNodes
    .map((node) =>
      buildLayoutNode(
        normalizedNodeById.get(node.id) ?? node,
        orderedChildrenByParent.get(node.id) ?? []
      )
    )
    .sort((left, right) => left.visualOrder - right.visualOrder);
  const sectionIds = detectSectionIds(layoutNodes, rootNodeId);

  return {
    id: capture.id,
    title: capture.title,
    sourceKind: capture.sourceKind,
    rootNodeId,
    nodeCount: layoutNodes.length,
    sectionIds,
    semanticIndex: {},
    detectedSections: [],
    nodes: layoutNodes
  };
}
