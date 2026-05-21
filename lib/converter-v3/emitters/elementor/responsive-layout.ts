import type { LayoutNode, ResponsiveLayoutState, ResponsiveViewportName } from "@/lib/converter-v3/contracts/layout";

export type DerivedContainerLayout = {
  flexDirection?: string;
  flexWrap?: string;
  justifyContent?: string;
  alignItems?: string;
  gap?: string;
  columnCount?: number;
  rowCount?: number;
  shouldStack?: boolean;
  childSettingsById: Map<string, Record<string, unknown>>;
};

export type ContainerPattern =
  | "freeform"
  | "stack"
  | "text-image-split"
  | "image-text-split"
  | "card-grid";

export type ContainerPreset =
  | "generic"
  | "pricing-cards"
  | "testimonial-cards"
  | "feature-cards";

export type ContainerPatternChildRole =
  | "item"
  | "stack-item"
  | "content"
  | "media"
  | "card";

export type PatternChildDescriptor = {
  role: ContainerPatternChildRole;
  index: number;
  pattern: ContainerPattern;
};

export type PresetChildDescriptor = {
  role: "pricing-card" | "testimonial-card" | "feature-card";
  index: number;
  preset: ContainerPreset;
};

type ResponsiveBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export const RESPONSIVE_VIEWPORTS: ResponsiveViewportName[] = [
  "desktop",
  "tablet",
  "mobile"
];

function getTemplateColumnCount(template?: string) {
  if (!template) {
    return undefined;
  }

  const repeatMatch = template.match(/repeat\(\s*(\d+)/i);

  if (repeatMatch) {
    return Number.parseInt(repeatMatch[1], 10);
  }

  const tokens = template
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);

  return tokens.length || undefined;
}

function toBox(box: LayoutNode["box"] | null): ResponsiveBox | null {
  if (!box) {
    return null;
  }

  return {
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height
  };
}

export function getViewportState(
  node: LayoutNode,
  viewport: ResponsiveViewportName
): ResponsiveLayoutState {
  const responsiveState = node.responsive[viewport];

  if (responsiveState) {
    return responsiveState;
  }

  return {
    isVisible: !node.flags.hidden,
    box: toBox(node.box),
    layout: {
      display: node.layout.display,
      position: node.layout.position,
      flexDirection: node.layout.flexDirection,
      justifyContent: node.layout.justifyContent,
      alignItems: node.layout.alignItems,
      gap: node.layout.gap,
      gridTemplateColumns: node.layout.gridTemplateColumns,
      gridTemplateRows: node.layout.gridTemplateRows
    },
    spacing: {
      margin: node.spacing.margin,
      padding: node.spacing.padding
    },
    style: {
      backgroundColor: node.style.backgroundColor,
      color: node.style.color,
      fontSize: node.style.fontSize,
      fontFamily: node.style.fontFamily,
      fontWeight: node.style.fontWeight,
      lineHeight: node.style.lineHeight,
      textAlign: node.style.textAlign,
      borderRadius: node.style.borderRadius,
      boxShadow: node.style.boxShadow,
      objectFit: node.style.objectFit,
      objectPosition: node.style.objectPosition,
      zIndex: node.style.zIndex
    }
  };
}

function sortNodesByVisualFlow(nodes: LayoutNode[], viewport: ResponsiveViewportName) {
  return [...nodes].sort((left, right) => {
    const leftBox = getViewportState(left, viewport).box;
    const rightBox = getViewportState(right, viewport).box;

    if (leftBox?.y !== rightBox?.y) {
      return (leftBox?.y ?? 0) - (rightBox?.y ?? 0);
    }

    if (leftBox?.x !== rightBox?.x) {
      return (leftBox?.x ?? 0) - (rightBox?.x ?? 0);
    }

    return left.visualOrder - right.visualOrder;
  });
}

function groupNodesByRow(nodes: LayoutNode[], viewport: ResponsiveViewportName) {
  const sorted = sortNodesByVisualFlow(nodes, viewport);
  const rows: LayoutNode[][] = [];

  for (const node of sorted) {
    const nodeBox = getViewportState(node, viewport).box;
    const lastRow = rows.at(-1);

    if (!lastRow?.length || !nodeBox) {
      rows.push([node]);
      continue;
    }

    const rowTop = getViewportState(lastRow[0], viewport).box?.y ?? 0;
    const rowHeight = getViewportState(lastRow[0], viewport).box?.height ?? 0;
    const tolerance = Math.max(24, Math.min(rowHeight, nodeBox.height || 0) * 0.45);

    if (Math.abs(nodeBox.y - rowTop) <= tolerance) {
      lastRow.push(node);
    } else {
      rows.push([node]);
    }
  }

  return rows.map((row) =>
    row.sort(
      (left, right) =>
        (getViewportState(left, viewport).box?.x ?? 0) -
        (getViewportState(right, viewport).box?.x ?? 0)
    )
  );
}

function estimateGap(rows: LayoutNode[][], viewport: ResponsiveViewportName, direction: "row" | "column") {
  const gaps: number[] = [];

  for (const row of rows) {
    if (direction === "row" && row.length > 1) {
      for (let index = 1; index < row.length; index += 1) {
        const previousBox = getViewportState(row[index - 1], viewport).box;
        const currentBox = getViewportState(row[index], viewport).box;

        if (!previousBox || !currentBox) {
          continue;
        }

        const gap = currentBox.x - (previousBox.x + previousBox.width);

        if (gap > 0) {
          gaps.push(gap);
        }
      }
    }
  }

  if (direction === "column") {
    const flattened = rows.flat();

    for (let index = 1; index < flattened.length; index += 1) {
      const previousBox = getViewportState(flattened[index - 1], viewport).box;
      const currentBox = getViewportState(flattened[index], viewport).box;

      if (!previousBox || !currentBox) {
        continue;
      }

      const gap = currentBox.y - (previousBox.y + previousBox.height);

      if (gap > 0) {
        gaps.push(gap);
      }
    }
  }

  if (!gaps.length) {
    return undefined;
  }

  const average = gaps.reduce((sum, value) => sum + value, 0) / gaps.length;
  return `${Math.round(average)}px`;
}

function getMaxVisualColumns(rows: LayoutNode[][]) {
  return rows.reduce((max, row) => Math.max(max, row.length), 0);
}

function getVisibleChildNodes(
  node: LayoutNode,
  layoutById: Map<string, LayoutNode>,
  viewport: ResponsiveViewportName
) {
  return node.children
    .map((childId) => layoutById.get(childId))
    .filter((child): child is LayoutNode => Boolean(child))
    .filter((child) => getViewportState(child, viewport).isVisible);
}

type NodeContentProfile = "media" | "textual" | "mixed" | "structural";

function classifyNodeContentProfile(
  node: LayoutNode,
  layoutById: Map<string, LayoutNode>,
  viewport: ResponsiveViewportName
): NodeContentProfile {
  if (node.kind === "image") {
    return "media";
  }

  if (node.kind === "text" || node.kind === "badge" || node.kind === "button") {
    return "textual";
  }

  let imageCount = 0;
  let textualCount = 0;
  const queue = [...node.children];

  while (queue.length) {
    const currentId = queue.shift();

    if (!currentId) {
      continue;
    }

    const current = layoutById.get(currentId);

    if (!current || !getViewportState(current, viewport).isVisible) {
      continue;
    }

    if (current.kind === "image") {
      imageCount += 1;
    } else if (
      current.kind === "text" ||
      current.kind === "badge" ||
      current.kind === "button"
    ) {
      textualCount += 1;
    }

    queue.push(...current.children);
  }

  if (imageCount > 0 && textualCount === 0) {
    return "media";
  }

  if (textualCount > 0 && imageCount === 0) {
    return "textual";
  }

  if (imageCount > 0 && textualCount > 0) {
    return "mixed";
  }

  return "structural";
}

function collectVisibleSubtreeNodes(
  node: LayoutNode,
  layoutById: Map<string, LayoutNode>,
  viewport: ResponsiveViewportName
) {
  const nodes: LayoutNode[] = [];
  const queue = [node.id];

  while (queue.length) {
    const currentId = queue.shift();

    if (!currentId) {
      continue;
    }

    const current = layoutById.get(currentId);

    if (!current || !getViewportState(current, viewport).isVisible) {
      continue;
    }

    nodes.push(current);
    queue.push(...current.children);
  }

  return nodes;
}

function summarizeRepeatingChild(
  node: LayoutNode,
  layoutById: Map<string, LayoutNode>,
  viewport: ResponsiveViewportName
) {
  const subtree = collectVisibleSubtreeNodes(node, layoutById, viewport);
  const textValues = subtree
    .filter(
      (current) =>
        current.kind === "text" ||
        current.kind === "badge" ||
        current.kind === "button"
    )
    .map((current) => current.content.text?.trim() ?? "")
    .filter(Boolean);
  const priceLikeTexts = textValues.filter((value) =>
    /\$\s?\d|(?:usd|eur|gbp|brl)\s?\d|\d+(?:[.,]\d{2})/.test(value.toLowerCase())
  );
  const longTexts = textValues.filter((value) => value.length >= 60);
  const mediumTexts = textValues.filter((value) => value.length >= 24 && value.length < 60);
  const ctaTexts = textValues.filter((value) =>
    /\b(buy|order|shop|cart|save|get|claim|start|choose|subscribe)\b/i.test(value)
  );

  return {
    buttonCount: subtree.filter((current) => current.kind === "button").length,
    imageCount: subtree.filter((current) => current.kind === "image").length,
    badgeCount: subtree.filter((current) => current.kind === "badge").length,
    textCount: textValues.length,
    priceLikeCount: priceLikeTexts.length,
    longTextCount: longTexts.length,
    mediumTextCount: mediumTexts.length,
    ctaCount: ctaTexts.length
  };
}

export function deriveContainerLayout(
  node: LayoutNode,
  layoutById: Map<string, LayoutNode>,
  viewport: ResponsiveViewportName
): DerivedContainerLayout {
  const childNodes = getVisibleChildNodes(node, layoutById, viewport);
  const nodeState = getViewportState(node, viewport);
  const rows = groupNodesByRow(childNodes, viewport);
  const hasMultiColumnRow = rows.some((row) => row.length > 1);
  const explicitDisplay = nodeState.layout.display;
  const explicitDirection = nodeState.layout.flexDirection;
  const isGrid = explicitDisplay === "grid" || Boolean(nodeState.layout.gridTemplateColumns);
  const templateColumnCount = getTemplateColumnCount(nodeState.layout.gridTemplateColumns);
  const horizontalByDefault =
    explicitDisplay === "grid" ||
    explicitDirection === "row" ||
    (explicitDisplay === "flex" && explicitDirection !== "column");
  const maxVisualColumns = getMaxVisualColumns(rows);
  const columnCount =
    maxVisualColumns > 1
      ? maxVisualColumns
      : templateColumnCount ??
        (horizontalByDefault && childNodes.length > 1
          ? childNodes.length
          : 1);
  const direction =
    explicitDirection ||
    (explicitDisplay === "flex" || hasMultiColumnRow || columnCount > 1
      ? "row"
      : "column");
  const flexWrap = direction === "row" && (isGrid || rows.length > 1 || columnCount > 1)
    ? "wrap"
    : undefined;
  const childSettingsById = new Map<string, Record<string, unknown>>();
  const nodeWidth = nodeState.box?.width ?? 0;
  const rowCount = childNodes.length
    ? rows.some((row) => row.length > 1)
      ? rows.length
      : Math.ceil(childNodes.length / Math.max(1, columnCount))
    : 0;
  const shouldStack = direction === "column" || columnCount <= 1;

  if (nodeWidth > 0 && direction === "row") {
    for (const row of rows) {
      const inferredColumns = row.length > 1 ? row.length : columnCount;

      if (row.length <= 1 && inferredColumns <= 1) {
        continue;
      }

      for (const child of row) {
        const childBox = getViewportState(child, viewport).box;
        const widthPercent =
          childBox?.width && nodeWidth > 0
            ? Math.max(
                1,
                Math.min(100, Number(((childBox.width / nodeWidth) * 100).toFixed(2)))
              )
            : Math.max(1, Math.min(100, Number((100 / inferredColumns).toFixed(2))));

        childSettingsById.set(child.id, {
          width: `${widthPercent}%`,
          flex_basis: `${widthPercent}%`,
          max_width: `${widthPercent}%`
        });
      }
    }
  } else if (direction === "row") {
    for (const row of rows) {
      const inferredColumns = row.length > 1 ? row.length : columnCount;

      if (inferredColumns <= 1) {
        continue;
      }

      const widthPercent = Math.max(1, Math.min(100, Number((100 / inferredColumns).toFixed(2))));

      for (const child of row) {
        childSettingsById.set(child.id, {
          width: `${widthPercent}%`,
          flex_basis: `${widthPercent}%`,
          max_width: `${widthPercent}%`
        });
      }
    }
  }

  if (direction === "column") {
    for (const child of childNodes) {
      const childBox = getViewportState(child, viewport).box;
      childSettingsById.set(child.id, {
        width:
          childBox?.width && nodeWidth > 0 && childBox.width < nodeWidth
            ? `${Math.max(1, Math.min(100, Number(((childBox.width / nodeWidth) * 100).toFixed(2))))}%`
            : "100%"
      });
    }
  }

  return {
    flexDirection: direction,
    flexWrap,
    justifyContent: nodeState.layout.justifyContent,
    alignItems: nodeState.layout.alignItems,
    gap: nodeState.layout.gap || estimateGap(rows, viewport, direction === "row" ? "row" : "column"),
    columnCount,
    rowCount,
    shouldStack,
    childSettingsById
  };
}

export function detectContainerPattern(
  node: LayoutNode,
  layoutById: Map<string, LayoutNode>,
  viewport: ResponsiveViewportName
): ContainerPattern {
  const childNodes = getVisibleChildNodes(node, layoutById, viewport);
  const derived = deriveContainerLayout(node, layoutById, viewport);

  if (childNodes.length <= 1) {
    return "freeform";
  }

  if (derived.shouldStack) {
    return "stack";
  }

  if (derived.columnCount === 2 && derived.rowCount === 1 && childNodes.length === 2) {
    const [firstChild, secondChild] = sortNodesByVisualFlow(childNodes, viewport);
    const firstProfile = classifyNodeContentProfile(firstChild, layoutById, viewport);
    const secondProfile = classifyNodeContentProfile(secondChild, layoutById, viewport);

    if (firstProfile === "textual" && secondProfile === "media") {
      return "text-image-split";
    }

    if (firstProfile === "media" && secondProfile === "textual") {
      return "image-text-split";
    }
  }

  if ((derived.columnCount ?? 1) > 1 && childNodes.length >= (derived.columnCount ?? 1)) {
    return "card-grid";
  }

  return "freeform";
}

export function detectContainerPreset(
  node: LayoutNode,
  layoutById: Map<string, LayoutNode>,
  viewport: ResponsiveViewportName
): ContainerPreset {
  const pattern = detectContainerPattern(node, layoutById, viewport);

  if (pattern !== "card-grid") {
    return "generic";
  }

  const childNodes = sortNodesByVisualFlow(
    getVisibleChildNodes(node, layoutById, viewport),
    viewport
  );

  if (childNodes.length < 2) {
    return "generic";
  }

  const summaries = childNodes.map((child) =>
    summarizeRepeatingChild(child, layoutById, viewport)
  );
  const threshold = Math.max(2, Math.ceil(childNodes.length * 0.6));
  const pricingMatches = summaries.filter(
    (summary) =>
      summary.buttonCount > 0 &&
      (summary.priceLikeCount > 0 || summary.ctaCount > 0) &&
      summary.textCount >= 2
  ).length;
  const testimonialMatches = summaries.filter(
    (summary) =>
      summary.longTextCount > 0 &&
      summary.buttonCount === 0 &&
      summary.priceLikeCount === 0
  ).length;
  const featureMatches = summaries.filter(
    (summary) =>
      summary.textCount >= 2 &&
      summary.buttonCount <= 1 &&
      summary.priceLikeCount === 0 &&
      summary.longTextCount === 0
  ).length;

  if (pricingMatches >= threshold) {
    return "pricing-cards";
  }

  if (testimonialMatches >= threshold) {
    return "testimonial-cards";
  }

  if (featureMatches >= threshold) {
    return "feature-cards";
  }

  return "generic";
}

export function describePatternChildren(
  node: LayoutNode,
  layoutById: Map<string, LayoutNode>,
  viewport: ResponsiveViewportName
) {
  const childNodes = sortNodesByVisualFlow(
    getVisibleChildNodes(node, layoutById, viewport),
    viewport
  );
  const pattern = detectContainerPattern(node, layoutById, viewport);
  const childRoles = new Map<
    string,
    { role: ContainerPatternChildRole; index: number; pattern: ContainerPattern }
  >();

  childNodes.forEach((child, index) => {
    let role: ContainerPatternChildRole = "item";

    if (pattern === "stack") {
      role = "stack-item";
    } else if (pattern === "card-grid") {
      role = "card";
    } else if (pattern === "text-image-split" || pattern === "image-text-split") {
      const profile = classifyNodeContentProfile(child, layoutById, viewport);

      if (profile === "media") {
        role = "media";
      } else if (profile === "textual") {
        role = "content";
      } else {
        role = index === 0
          ? pattern === "image-text-split"
            ? "media"
            : "content"
          : pattern === "image-text-split"
            ? "content"
            : "media";
      }
    }

    childRoles.set(child.id, { role, index, pattern });
  });

  return childRoles;
}

export function describePresetChildren(
  node: LayoutNode,
  layoutById: Map<string, LayoutNode>,
  viewport: ResponsiveViewportName
) {
  const preset = detectContainerPreset(node, layoutById, viewport);

  if (preset === "generic") {
    return new Map<string, PresetChildDescriptor>();
  }

  const orderedChildIds = getOrderedChildIdsForPattern(node, layoutById, viewport);
  const role =
    preset === "pricing-cards"
      ? "pricing-card"
      : preset === "testimonial-cards"
        ? "testimonial-card"
        : "feature-card";

  return new Map(
    orderedChildIds.map((childId, index) => [
      childId,
      {
        role,
        index,
        preset
      }
    ])
  );
}

export function getOrderedChildIdsForPattern(
  node: LayoutNode,
  layoutById: Map<string, LayoutNode>,
  viewport: ResponsiveViewportName
) {
  const patternChildren = describePatternChildren(node, layoutById, viewport);

  if (!patternChildren.size) {
    return node.children.filter((childId) => {
      const child = layoutById.get(childId);
      return Boolean(child && getViewportState(child, viewport).isVisible);
    });
  }

  return [...patternChildren.entries()]
    .sort((left, right) => left[1].index - right[1].index)
    .map(([childId]) => childId);
}

export function serializeResponsiveElement(node: LayoutNode) {
  return Object.fromEntries(
    RESPONSIVE_VIEWPORTS.map((viewport) => {
      const state = getViewportState(node, viewport);

      return [
        viewport,
        {
          isVisible: state.isVisible,
          width: state.box?.width ? `${Math.round(state.box.width)}px` : undefined,
          height: state.box?.height ? `${Math.round(state.box.height)}px` : undefined,
          display: state.layout.display,
          gap: state.layout.gap,
          fontSize: state.style.fontSize,
          textAlign: state.style.textAlign
        }
      ];
    })
  );
}

export function serializeResponsiveContainer(
  node: LayoutNode,
  layoutById: Map<string, LayoutNode>
) {
  return Object.fromEntries(
    RESPONSIVE_VIEWPORTS.map((viewport) => {
      const state = getViewportState(node, viewport);
      const derived = deriveContainerLayout(node, layoutById, viewport);

      return [
        viewport,
        {
          isVisible: state.isVisible,
          width: state.box?.width ? `${Math.round(state.box.width)}px` : undefined,
          height: state.box?.height ? `${Math.round(state.box.height)}px` : undefined,
          display: state.layout.display,
          flexDirection: derived.flexDirection,
          flexWrap: derived.flexWrap,
          justifyContent: derived.justifyContent,
          alignItems: derived.alignItems,
          gap: derived.gap,
          columns: derived.columnCount,
          rows: derived.rowCount,
          stacked: derived.shouldStack,
          pattern: detectContainerPattern(node, layoutById, viewport),
          preset: detectContainerPreset(node, layoutById, viewport),
          gridTemplateColumns: state.layout.gridTemplateColumns,
          childWidths: Object.fromEntries(derived.childSettingsById)
        }
      ];
    })
  );
}

function normalizeResponsiveStateSettings(state: ReturnType<typeof getViewportState>) {
  return {
    width: state.box?.width ? `${Math.round(state.box.width)}px` : undefined,
    height: state.box?.height ? `${Math.round(state.box.height)}px` : undefined,
    display: state.layout.display,
    position: state.layout.position,
    gap: state.layout.gap,
    flex_direction: state.layout.flexDirection,
    justify_content: state.layout.justifyContent,
    align_items: state.layout.alignItems,
    grid_template_columns: state.layout.gridTemplateColumns,
    font_size: state.style.fontSize,
    text_align: state.style.textAlign,
    visible: state.isVisible
  };
}

export function createElementorResponsiveSettings(
  node: LayoutNode,
  layoutById?: Map<string, LayoutNode>
) {
  const desktopState = getViewportState(node, "desktop");
  const tabletState = getViewportState(node, "tablet");
  const mobileState = getViewportState(node, "mobile");
  const desktopContainer = layoutById ? deriveContainerLayout(node, layoutById, "desktop") : undefined;
  const tabletContainer = layoutById ? deriveContainerLayout(node, layoutById, "tablet") : undefined;
  const mobileContainer = layoutById ? deriveContainerLayout(node, layoutById, "mobile") : undefined;
  const desktop = {
    ...normalizeResponsiveStateSettings(desktopState),
    flex_direction: desktopContainer?.flexDirection ?? desktopState.layout.flexDirection,
    flex_wrap: desktopContainer?.flexWrap,
    justify_content: desktopContainer?.justifyContent ?? desktopState.layout.justifyContent,
    align_items: desktopContainer?.alignItems ?? desktopState.layout.alignItems,
    gap: desktopContainer?.gap ?? desktopState.layout.gap,
    columns: desktopContainer?.columnCount,
    rows: desktopContainer?.rowCount,
    stacked: desktopContainer?.shouldStack,
    pattern: layoutById ? detectContainerPattern(node, layoutById, "desktop") : undefined,
    preset: layoutById ? detectContainerPreset(node, layoutById, "desktop") : undefined
  };
  const tablet = {
    ...normalizeResponsiveStateSettings(tabletState),
    flex_direction: tabletContainer?.flexDirection ?? tabletState.layout.flexDirection,
    flex_wrap: tabletContainer?.flexWrap,
    justify_content: tabletContainer?.justifyContent ?? tabletState.layout.justifyContent,
    align_items: tabletContainer?.alignItems ?? tabletState.layout.alignItems,
    gap: tabletContainer?.gap ?? tabletState.layout.gap,
    columns: tabletContainer?.columnCount,
    rows: tabletContainer?.rowCount,
    stacked: tabletContainer?.shouldStack,
    pattern: layoutById ? detectContainerPattern(node, layoutById, "tablet") : undefined,
    preset: layoutById ? detectContainerPreset(node, layoutById, "tablet") : undefined
  };
  const mobile = {
    ...normalizeResponsiveStateSettings(mobileState),
    flex_direction: mobileContainer?.flexDirection ?? mobileState.layout.flexDirection,
    flex_wrap: mobileContainer?.flexWrap,
    justify_content: mobileContainer?.justifyContent ?? mobileState.layout.justifyContent,
    align_items: mobileContainer?.alignItems ?? mobileState.layout.alignItems,
    gap: mobileContainer?.gap ?? mobileState.layout.gap,
    columns: mobileContainer?.columnCount,
    rows: mobileContainer?.rowCount,
    stacked: mobileContainer?.shouldStack,
    pattern: layoutById ? detectContainerPattern(node, layoutById, "mobile") : undefined,
    preset: layoutById ? detectContainerPreset(node, layoutById, "mobile") : undefined
  };

  return {
    converter_v3_elementor_responsive: {
      desktop,
      tablet,
      mobile
    },
    tablet_width: tablet.width,
    mobile_width: mobile.width,
    tablet_height: tablet.height,
    mobile_height: mobile.height,
    tablet_gap: tablet.gap,
    mobile_gap: mobile.gap,
    tablet_flex_direction: tablet.flex_direction,
    mobile_flex_direction: mobile.flex_direction,
    tablet_flex_wrap: tablet.flex_wrap,
    mobile_flex_wrap: mobile.flex_wrap,
    columns: desktop.columns,
    rows: desktop.rows,
    stacked: desktop.stacked,
    tablet_columns: tablet.columns,
    mobile_columns: mobile.columns,
    tablet_rows: tablet.rows,
    mobile_rows: mobile.rows,
    tablet_stacked: tablet.stacked,
    mobile_stacked: mobile.stacked,
    pattern: desktop.pattern,
    tablet_pattern: tablet.pattern,
    mobile_pattern: mobile.pattern,
    preset: desktop.preset,
    tablet_preset: tablet.preset,
    mobile_preset: mobile.preset,
    tablet_justify_content: tablet.justify_content,
    mobile_justify_content: mobile.justify_content,
    tablet_align_items: tablet.align_items,
    mobile_align_items: mobile.align_items,
    tablet_grid_template_columns: tablet.grid_template_columns,
    mobile_grid_template_columns: mobile.grid_template_columns,
    tablet_font_size: tablet.font_size,
    mobile_font_size: mobile.font_size,
    tablet_text_align: tablet.text_align,
    mobile_text_align: mobile.text_align
  };
}

export function createResponsiveChildSettings(
  parentNode: LayoutNode,
  childNodeId: string,
  layoutById: Map<string, LayoutNode>
) {
  const desktopLayout = deriveContainerLayout(parentNode, layoutById, "desktop");
  const tabletLayout = deriveContainerLayout(parentNode, layoutById, "tablet");
  const mobileLayout = deriveContainerLayout(parentNode, layoutById, "mobile");
  const desktopSettings = desktopLayout.childSettingsById.get(childNodeId) ?? {};
  const tabletSettings = tabletLayout.childSettingsById.get(childNodeId) ?? {};
  const mobileSettings = mobileLayout.childSettingsById.get(childNodeId) ?? {};

  return {
    converter_v3_elementor_responsive_child: {
      desktop: desktopSettings,
      tablet: tabletSettings,
      mobile: mobileSettings
    },
    width:
      typeof desktopSettings.width === "string"
        ? desktopSettings.width
        : undefined,
    flex_basis:
      typeof desktopSettings.flex_basis === "string"
        ? desktopSettings.flex_basis
        : undefined,
    max_width:
      typeof desktopSettings.max_width === "string"
        ? desktopSettings.max_width
        : undefined,
    tablet_width:
      typeof tabletSettings.width === "string"
        ? tabletSettings.width
        : typeof desktopSettings.width === "string"
          ? desktopSettings.width
          : undefined,
    tablet_flex_basis:
      typeof tabletSettings.flex_basis === "string"
        ? tabletSettings.flex_basis
        : typeof desktopSettings.flex_basis === "string"
          ? desktopSettings.flex_basis
          : undefined,
    tablet_max_width:
      typeof tabletSettings.max_width === "string"
        ? tabletSettings.max_width
        : typeof desktopSettings.max_width === "string"
          ? desktopSettings.max_width
          : undefined,
    mobile_width:
      typeof mobileSettings.width === "string"
        ? mobileSettings.width
        : typeof tabletSettings.width === "string"
          ? tabletSettings.width
          : typeof desktopSettings.width === "string"
            ? desktopSettings.width
            : undefined,
    mobile_flex_basis:
      typeof mobileSettings.flex_basis === "string"
        ? mobileSettings.flex_basis
        : typeof tabletSettings.flex_basis === "string"
          ? tabletSettings.flex_basis
          : typeof desktopSettings.flex_basis === "string"
            ? desktopSettings.flex_basis
            : undefined,
    mobile_max_width:
      typeof mobileSettings.max_width === "string"
        ? mobileSettings.max_width
        : typeof tabletSettings.max_width === "string"
          ? tabletSettings.max_width
          : typeof desktopSettings.max_width === "string"
            ? desktopSettings.max_width
            : undefined
  };
}
