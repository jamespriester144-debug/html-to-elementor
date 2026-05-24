import type { CapturedBox, CapturedNode, PageCapture } from "@/lib/converter-v3/contracts/capture";
import type {
  VisibleContentElement,
  VisibleContentMetrics,
  VisualGeometryGroup
} from "@/lib/converter-v3/contracts/geometry";

function normalizeText(value: string | undefined) {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function isMeaningfulTag(tag: string) {
  return !["html", "body", "script", "style", "noscript"].includes(tag);
}

function getNodeHref(node: CapturedNode) {
  return (
    node.asset.href ??
    node.attributes.href ??
    node.attributes["data-href"] ??
    undefined
  );
}

function getNodeSrc(node: CapturedNode) {
  return (
    node.asset.src ??
    node.attributes.src ??
    node.attributes["data-src"] ??
    node.attributes["data-lazy-src"] ??
    node.attributes["data-original"] ??
    undefined
  );
}

function getNodePoster(node: CapturedNode) {
  return node.attributes.poster ?? undefined;
}

function getNodeBackgroundImage(node: CapturedNode) {
  return (
    node.asset.backgroundImage ??
    node.computedStyles["background-image"] ??
    undefined
  );
}

function normalizeAssetToken(value: string | undefined) {
  return (value ?? "").replace(/^url\((['"]?)(.*?)\1\)$/i, "$2").trim();
}

export function isInteractiveNode(node: CapturedNode) {
  const type = (node.attributes.type ?? "").toLowerCase();
  return (
    node.tag === "button" ||
    (node.tag === "a" && Boolean(getNodeHref(node))) ||
    node.attributes.role === "button" ||
    (node.tag === "input" &&
      ["button", "submit", "reset", "image"].includes(type))
  );
}

export function isMediaNode(node: CapturedNode) {
  return (
    ["img", "picture", "svg", "canvas", "video", "iframe"].includes(node.tag) ||
    Boolean(getNodeSrc(node)) ||
    Boolean(getNodePoster(node)) ||
    Boolean(normalizeAssetToken(getNodeBackgroundImage(node)))
  );
}

export function hasVisibleText(node: CapturedNode) {
  return normalizeText(node.text).length > 0;
}

export function isVisualContainerNode(node: CapturedNode) {
  if (!node.box || !node.isVisible || !isMeaningfulTag(node.tag)) {
    return false;
  }

  const display = node.computedStyles.display ?? "";
  const hasLayout =
    display === "flex" ||
    display === "grid" ||
    Boolean(node.computedStyles["grid-template-columns"]) ||
    Boolean(node.computedStyles["flex-direction"]);
  const hasVisualDecoration =
    Boolean(normalizeAssetToken(getNodeBackgroundImage(node))) ||
    Boolean(node.computedStyles["background-color"]) ||
    Boolean(node.computedStyles["border-radius"]) ||
    Boolean(node.computedStyles["box-shadow"]);
  const hasChildren = node.childIds.length >= 2;

  return !hasVisibleText(node) && !isInteractiveNode(node) && !isMediaNode(node) && (
    hasLayout || (hasVisualDecoration && hasChildren)
  );
}

export function isMeaningfulVisibleNode(node: CapturedNode) {
  if (!node.isVisible || !node.box || !isMeaningfulTag(node.tag)) {
    return false;
  }

  return (
    hasVisibleText(node) ||
    isMediaNode(node) ||
    isInteractiveNode(node) ||
    isVisualContainerNode(node)
  );
}

export function toVisibleContentElement(node: CapturedNode): VisibleContentElement | null {
  if (!isMeaningfulVisibleNode(node) || !node.box) {
    return null;
  }

  const href = getNodeHref(node);
  const src = getNodeSrc(node);
  const poster = getNodePoster(node);
  const backgroundImage = normalizeAssetToken(getNodeBackgroundImage(node)) || undefined;
  const isInteractive = isInteractiveNode(node);
  const isLink = node.tag === "a" && Boolean(href);
  const isButton =
    node.tag === "button" ||
    node.attributes.role === "button" ||
    (node.tag === "input" &&
      ["button", "submit", "reset", "image"].includes(
        (node.attributes.type ?? "").toLowerCase()
      ));

  return {
    nodeId: node.id,
    parentId: node.parentId,
    childIds: node.childIds,
    tag: node.tag,
    text: normalizeText(node.text),
    href,
    src,
    poster,
    backgroundImage,
    box: node.box,
    zIndex: node.computedStyles["z-index"],
    fontSize: node.computedStyles["font-size"],
    color: node.computedStyles.color,
    background: node.computedStyles.background ?? node.computedStyles["background-color"],
    borderRadius: node.computedStyles["border-radius"],
    display: node.computedStyles.display,
    position: node.computedStyles.position,
    flexDirection: node.computedStyles["flex-direction"],
    gridTemplateColumns: node.computedStyles["grid-template-columns"],
    visualOrder: node.visualOrder,
    isText: hasVisibleText(node),
    isMedia: isMediaNode(node),
    isInteractive,
    isLink,
    isButton,
    isVisualContainer: isVisualContainerNode(node)
  };
}

export function extractVisibleContentElements(capture: PageCapture): VisibleContentElement[] {
  return capture.nodes
    .map((node) => toVisibleContentElement(node))
    .filter((node): node is VisibleContentElement => Boolean(node))
    .sort(
      (left, right) =>
        left.box.y - right.box.y ||
        left.box.x - right.box.x ||
        left.visualOrder - right.visualOrder
    );
}

export function summarizeVisibleContent(elements: VisibleContentElement[]): VisibleContentMetrics {
  return {
    visibleElements: elements.length,
    texts: elements.filter((element) => element.isText).length,
    images: elements.filter(
      (element) =>
        element.isMedia ||
        Boolean(element.backgroundImage) ||
        Boolean(element.poster)
    ).length,
    buttons: elements.filter((element) => element.isButton).length,
    links: elements.filter((element) => element.isLink).length,
    visualContainers: elements.filter((element) => element.isVisualContainer).length
  };
}

function horizontalOverlapRatio(left: CapturedBox, right: CapturedBox) {
  const overlap = Math.max(
    0,
    Math.min(left.right, right.right) - Math.max(left.left, right.left)
  );
  const minWidth = Math.max(Math.min(left.width, right.width), 1);
  return overlap / minWidth;
}

function unionBox(boxes: CapturedBox[]) {
  const left = Math.min(...boxes.map((box) => box.left));
  const top = Math.min(...boxes.map((box) => box.top));
  const right = Math.max(...boxes.map((box) => box.right));
  const bottom = Math.max(...boxes.map((box) => box.bottom));

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top
  };
}

export function groupVisibleContentByGeometry(
  elements: VisibleContentElement[],
  capture: Pick<PageCapture, "nodes">
): VisualGeometryGroup[] {
  if (!elements.length) {
    return [];
  }

  const nodeIdSet = new Set(elements.map((element) => element.nodeId));
  const groups: Array<{
    id: string;
    elements: VisibleContentElement[];
    box: {
      x: number;
      y: number;
      width: number;
      height: number;
      right: number;
      bottom: number;
    };
  }> = [];

  for (const element of elements) {
    const currentRight = element.box.x + element.box.width;
    const currentBottom = element.box.y + element.box.height;
    const group = groups[groups.length - 1];

    if (!group) {
      groups.push({
        id: `geometry-group-1`,
        elements: [element],
        box: {
          x: element.box.x,
          y: element.box.y,
          width: element.box.width,
          height: element.box.height,
          right: currentRight,
          bottom: currentBottom
        }
      });
      continue;
    }

    const verticalGap = element.box.y - group.box.bottom;
    const overlapRatio = horizontalOverlapRatio(element.box, {
      ...group.box,
      top: group.box.y,
      left: group.box.x
    } as CapturedBox);
    const aligned =
      overlapRatio >= 0.16 ||
      element.box.width >= group.box.width * 0.66 ||
      group.box.width >= element.box.width * 0.66;
    const sameBand =
      verticalGap <= Math.max(96, Math.min(element.box.height, group.box.height) * 0.75);

    if (sameBand && aligned) {
      group.elements.push(element);
      group.box.x = Math.min(group.box.x, element.box.x);
      group.box.y = Math.min(group.box.y, element.box.y);
      group.box.right = Math.max(group.box.right, currentRight);
      group.box.bottom = Math.max(group.box.bottom, currentBottom);
      group.box.width = group.box.right - group.box.x;
      group.box.height = group.box.bottom - group.box.y;
      continue;
    }

    groups.push({
      id: `geometry-group-${groups.length + 1}`,
      elements: [element],
      box: {
        x: element.box.x,
        y: element.box.y,
        width: element.box.width,
        height: element.box.height,
        right: currentRight,
        bottom: currentBottom
      }
    });
  }

  const parentById = new Map(capture.nodes.map((node) => [node.id, node.parentId]));

  return groups.map((group, index) => {
    const nodeIds = [...new Set(group.elements.map((element) => element.nodeId))];
    const topLevelNodeIds = nodeIds.filter((nodeId) => {
      const parentId = parentById.get(nodeId);
      return !parentId || !nodeIdSet.has(parentId) || !nodeIds.includes(parentId);
    });
    const boxes = group.elements.map((element) => element.box);
    const box = unionBox(boxes);

    return {
      id: group.id,
      name: `visual-group-${index + 1}`,
      nodeIds,
      topLevelNodeIds,
      box,
      textCount: group.elements.filter((element) => element.isText).length,
      imageCount: group.elements.filter(
        (element) =>
          element.isMedia ||
          Boolean(element.backgroundImage) ||
          Boolean(element.poster)
      ).length,
      buttonCount: group.elements.filter((element) => element.isButton).length,
      linkCount: group.elements.filter((element) => element.isLink).length,
      visualContainerCount: group.elements.filter((element) => element.isVisualContainer).length,
      reason:
        "Grupo visual gerado por proximidade geométrica usando caixas reais da renderização."
    };
  });
}
