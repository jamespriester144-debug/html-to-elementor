import * as cheerio from "cheerio";

import type { PageCapture } from "@/lib/converter-v3/contracts/capture";
import type { LayoutDocument } from "@/lib/converter-v3/contracts/layout";
import type { VisualGeometryGroup } from "@/lib/converter-v3/contracts/geometry";
import {
  extractVisibleContentElements,
  groupVisibleContentByGeometry
} from "@/lib/converter-v3/universal-content";
import type { ElementorDocument, ElementorElement } from "@/types/conversion";

type GeometryEmitterResult = {
  document: ElementorDocument;
  groups: VisualGeometryGroup[];
  warnings: string[];
};

function createElementId(prefix: string, index: number) {
  return `${prefix}-${index.toString(16).padStart(6, "0")}`;
}

function zeroSpacing() {
  return {
    unit: "px",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    isLinked: true
  };
}

function buildParentMap(capture: PageCapture) {
  return new Map(capture.nodes.map((node) => [node.id, node.parentId]));
}

function buildNodeMap(capture: PageCapture) {
  return new Map(capture.nodes.map((node) => [node.id, node]));
}

function buildChildrenMap(capture: PageCapture) {
  return new Map(capture.nodes.map((node) => [node.id, node.childIds]));
}

function collectAncestors(nodeId: string, parentById: Map<string, string | null>) {
  const ancestors: string[] = [];
  let currentId: string | null | undefined = nodeId;

  while (currentId) {
    ancestors.push(currentId);
    currentId = parentById.get(currentId) ?? null;
  }

  return ancestors;
}

function findDeepestCommonAncestor(
  nodeIds: string[],
  parentById: Map<string, string | null>
) {
  if (!nodeIds.length) {
    return undefined;
  }

  const ancestorChains = nodeIds.map((nodeId) => collectAncestors(nodeId, parentById));
  const first = ancestorChains[0];

  return first.find((candidateId) =>
    ancestorChains.every((chain) => chain.includes(candidateId))
  );
}

function collectSubtreeNodeIds(
  rootId: string,
  childrenById: Map<string, string[]>
) {
  const collected = new Set<string>();
  const queue = [rootId];

  while (queue.length) {
    const currentId = queue.shift();

    if (!currentId || collected.has(currentId)) {
      continue;
    }

    collected.add(currentId);
    queue.push(...(childrenById.get(currentId) ?? []));
  }

  return collected;
}

function selectFragmentNodeIds(
  group: VisualGeometryGroup,
  capture: PageCapture
) {
  const parentById = buildParentMap(capture);
  const nodeById = buildNodeMap(capture);
  const childrenById = buildChildrenMap(capture);
  const commonAncestorId = findDeepestCommonAncestor(group.nodeIds, parentById);
  const commonAncestor = commonAncestorId ? nodeById.get(commonAncestorId) : undefined;

  if (commonAncestor && !["body", "html"].includes(commonAncestor.tag)) {
    const subtree = collectSubtreeNodeIds(commonAncestor.id, childrenById);
    const overlapCount = group.nodeIds.filter((nodeId) => subtree.has(nodeId)).length;
    const overlapRatio = overlapCount / Math.max(group.nodeIds.length, 1);

    if (overlapRatio >= 0.6) {
      return [commonAncestor.id];
    }
  }

  return group.topLevelNodeIds.length > 0 ? group.topLevelNodeIds : group.nodeIds;
}

function buildGroupHtml(
  $: cheerio.CheerioAPI,
  group: VisualGeometryGroup,
  capture: PageCapture
) {
  const fragmentNodeIds = selectFragmentNodeIds(group, capture);
  const fragments = fragmentNodeIds
    .map((nodeId) => $(`[data-capture-id="${nodeId}"]`).first())
    .filter((element) => element.length > 0)
    .map((element) => element.toString());

  if (!fragments.length) {
    return "";
  }

  if (fragments.length === 1) {
    return fragments[0];
  }

  return `<div data-converter-v3-geometry-group="${group.id}">${fragments.join("")}</div>`;
}

function buildContainerFromGroup(
  group: VisualGeometryGroup,
  html: string,
  index: number
): ElementorElement {
  return {
    id: createElementId("geometry-container", index + 1),
    elType: "container",
    settings: {
      content_width: "full",
      min_height: `${Math.max(Math.round(group.box.height), 1)}px`,
      width: `${Math.max(Math.round(group.box.width), 1)}px`,
      _padding: zeroSpacing(),
      _margin: zeroSpacing(),
      converter_v3_geometry_group_id: group.id,
      converter_v3_geometry_reason: group.reason,
      converter_v3_geometry_texts: group.textCount,
      converter_v3_geometry_images: group.imageCount,
      converter_v3_geometry_buttons: group.buttonCount,
      converter_v3_geometry_links: group.linkCount
    },
    elements: [
      {
        id: createElementId("geometry-html", index + 1),
        elType: "widget",
        widgetType: "html",
        settings: {
          html,
          converter_v3_mode: "geometry-fallback",
          converter_v3_geometry_group_id: group.id
        },
        elements: []
      }
    ]
  };
}

export function createGeometryElementorDocumentV3(params: {
  capture: PageCapture;
  layout: LayoutDocument;
}): GeometryEmitterResult {
  const visibleElements = extractVisibleContentElements(params.capture);
  const groups = groupVisibleContentByGeometry(visibleElements, params.capture);
  const $ = cheerio.load(params.capture.renderedHtml);
  const content = groups
    .map((group, index) => {
      const html = buildGroupHtml($, group, params.capture);

      if (!html.trim()) {
        return null;
      }

      return buildContainerFromGroup(group, html, index);
    })
    .filter((element): element is ElementorElement => Boolean(element));

  return {
    document: {
      version: "1.0",
      title: params.capture.title,
      type: "page",
      content
    },
    groups,
    warnings:
      groups.length > 0
        ? [
            `Fallback por geometria gerou ${groups.length} grupo(s) visuais a partir do DOM renderizado.`
          ]
        : ["Fallback por geometria nao encontrou grupos visuais utilizaveis."]
  };
}
