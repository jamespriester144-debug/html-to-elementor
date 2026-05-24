import * as cheerio from "cheerio";

import type { PageCapture } from "@/lib/converter-v3/contracts/capture";
import type { LayoutDocument, LayoutNode, OutputMode } from "@/lib/converter-v3/contracts/layout";
import {
  type DerivedContainerLayout,
  createElementorResponsiveSettings,
  createResponsiveChildSettings,
  detectContainerPattern,
  detectContainerPreset,
  describePatternChildren,
  describePresetChildren,
  getOrderedChildIdsForPattern,
  deriveContainerLayout as deriveResponsiveContainerLayout,
  serializeResponsiveContainer,
  serializeResponsiveElement
} from "@/lib/converter-v3/emitters/elementor/responsive-layout";
import {
  getPresetContext,
  getPresetSemanticHint
} from "@/lib/converter-v3/emitters/elementor/preset-semantics";
import {
  getPresetContainerLayoutDefaults,
  sortElementsForPresetLayout
} from "@/lib/converter-v3/emitters/elementor/preset-layout";
import {
  getSectionBlueprintSummary,
  detectSectionComposition,
  getSectionEmitterStrategy,
  getSectionSlotSummary,
  getSectionStrategyProfile,
  getSectionStructureSummary,
  getSectionStructureContainerDefaults,
  getSectionCompositionDefaults,
  sortElementsForSectionComposition
} from "@/lib/converter-v3/emitters/elementor/section-layout";
import { buildSectionStrategyElements } from "@/lib/converter-v3/emitters/elementor/section-strategy";
import {
  getVisualOrderChildIds,
  shouldUseUniversalNeutralLayoutMode
} from "@/lib/converter-v3/emitters/elementor/universal-layout-mode";
import { applyPresetWidgetDefaults } from "@/lib/converter-v3/emitters/elementor/widget-defaults";
import type { ElementorDocument, ElementorElement } from "@/types/conversion";

type HybridEmitterResult = {
  document: ElementorDocument;
  usedHtmlFallbackNodeIds: string[];
  warnings: string[];
};

type NodeMaps = {
  layoutById: Map<string, LayoutNode>;
  captureById: Map<string, PageCapture["nodes"][number]>;
};

function createElementId(prefix: string, index: number) {
  return `${prefix}-${index.toString(16).padStart(6, "0")}`;
}

function sanitizeText(value: string | undefined) {
  return value?.replace(/\s+/g, " ").trim() || "";
}

function toSpacingObject(value?: string) {
  if (!value) {
    return undefined;
  }

  const parts = value.split(/\s+/).filter(Boolean);
  const [top, right = top, bottom = top, left = right] = parts;

  return {
    unit: "px",
    top: Number.parseFloat(top) || 0,
    right: Number.parseFloat(right) || 0,
    bottom: Number.parseFloat(bottom) || 0,
    left: Number.parseFloat(left) || 0,
    isLinked: parts.length === 1
  };
}

function buildNodeMaps(capture: PageCapture, layout: LayoutDocument): NodeMaps {
  return {
    layoutById: new Map(layout.nodes.map((node) => [node.id, node])),
    captureById: new Map(capture.nodes.map((node) => [node.id, node]))
  };
}

function getSubtreeNodeIds(rootId: string, layoutById: NodeMaps["layoutById"]): string[] {
  const ids: string[] = [];
  const queue = [rootId];

  while (queue.length) {
    const currentId = queue.shift();

    if (!currentId) {
      continue;
    }

    ids.push(currentId);
    const node = layoutById.get(currentId);

    if (node) {
      queue.push(...node.children);
    }
  }

  return ids;
}

function countSubtreeOverlaps(rootId: string, layoutById: NodeMaps["layoutById"]) {
  const ids = new Set(getSubtreeNodeIds(rootId, layoutById));
  const nodes = [...ids]
    .map((id) => layoutById.get(id))
    .filter((node): node is LayoutNode => Boolean(node))
    .filter((node) => !node.flags.hidden);
  let overlaps = 0;

  for (let index = 0; index < nodes.length; index += 1) {
    for (let nextIndex = index + 1; nextIndex < nodes.length; nextIndex += 1) {
      const left = nodes[index];
      const right = nodes[nextIndex];

      if (
        left.parentId === right.parentId &&
        left.box.width > 0 &&
        left.box.height > 0 &&
        right.box.width > 0 &&
        right.box.height > 0 &&
        !(
          left.box.x + left.box.width <= right.box.x ||
          right.box.x + right.box.width <= left.box.x ||
          left.box.y + left.box.height <= right.box.y ||
          right.box.y + right.box.height <= left.box.y
        )
      ) {
        overlaps += 1;
      }
    }
  }

  return overlaps;
}

function applyDerivedChildSettings(
  children: ElementorElement[],
  node: LayoutNode,
  maps: NodeMaps,
  derivedLayout: DerivedContainerLayout,
  neutralLayoutMode = false
) {
  if (neutralLayoutMode) {
    return children.map((child) => {
      const sourceNodeId =
        typeof child.settings.converter_v3_source_node_id === "string"
          ? child.settings.converter_v3_source_node_id
          : undefined;

      if (!sourceNodeId) {
        return child;
      }

      const childSettings = derivedLayout.childSettingsById.get(sourceNodeId);

      if (!childSettings) {
        return child;
      }

      return {
        ...child,
        settings: {
          ...child.settings,
          ...childSettings,
          ...createResponsiveChildSettings(node, sourceNodeId, maps.layoutById),
          converter_v3_universal_neutral_mode: true
        }
      };
    });
  }

  const patternChildren = describePatternChildren(node, maps.layoutById, "desktop");
  const presetChildren = describePresetChildren(node, maps.layoutById, "desktop");

  return children.map((child) => {
    const sourceNodeId =
      typeof child.settings.converter_v3_source_node_id === "string"
        ? child.settings.converter_v3_source_node_id
        : undefined;

    if (!sourceNodeId) {
      return child;
    }

    const childSettings = derivedLayout.childSettingsById.get(sourceNodeId);

    if (!childSettings) {
      return child;
    }

    const responsiveChildSettings = createResponsiveChildSettings(
      node,
      sourceNodeId,
      maps.layoutById
    );
    const patternChild = patternChildren.get(sourceNodeId);
    const presetChild = presetChildren.get(sourceNodeId);
    const patternContainerDefaults =
      child.elType === "container"
        ? {
            flex_direction:
              child.settings.flex_direction ??
              (patternChild?.role === "card" || patternChild?.role === "content"
                ? "column"
                : undefined),
            justify_content:
              child.settings.justify_content ??
              (patternChild?.role === "card" || patternChild?.role === "content"
                ? "flex-start"
                : patternChild?.role === "media"
                  ? "center"
                  : undefined),
            align_items:
              child.settings.align_items ??
              (patternChild?.role === "card"
                ? "stretch"
                : patternChild?.role === "content"
                  ? "flex-start"
                  : patternChild?.role === "media"
                    ? "center"
                    : undefined)
          }
        : {};
    const presetContainerDefaults =
      child.elType === "container"
        ? {
            justify_content:
              child.settings.justify_content ??
              (presetChild?.role === "pricing-card"
                ? "space-between"
                : presetChild?.role === "testimonial-card" ||
                    presetChild?.role === "feature-card"
                  ? "flex-start"
                  : undefined),
            align_items:
              child.settings.align_items ??
              (presetChild?.role === "pricing-card" ||
                presetChild?.role === "testimonial-card" ||
                presetChild?.role === "feature-card"
                ? "stretch"
                : undefined)
          }
        : {};

    return {
      ...child,
      settings: {
        ...child.settings,
        ...childSettings,
        ...responsiveChildSettings,
        ...patternContainerDefaults,
        ...presetContainerDefaults,
        converter_v3_pattern_role: patternChild?.role,
        converter_v3_pattern_index: patternChild?.index,
        converter_v3_pattern: patternChild?.pattern,
        converter_v3_preset_role: presetChild?.role,
        converter_v3_preset_index: presetChild?.index,
        converter_v3_preset: presetChild?.preset
      }
    };
  });
}

function isNodeSimpleEnough(rootId: string, maps: NodeMaps, neutralLayoutMode = false) {
  const rootNode = maps.layoutById.get(rootId);

  if (!rootNode) {
    return false;
  }

  const subtreeNodes = getSubtreeNodeIds(rootId, maps.layoutById)
    .map((id) => maps.layoutById.get(id))
    .filter((node): node is LayoutNode => Boolean(node))
    .filter((node) => !node.flags.hidden);
  const absoluteCount = subtreeNodes.filter((node) =>
    ["absolute", "fixed", "sticky"].includes(node.layout.position ?? "")
  ).length;
  const decorativeCount = subtreeNodes.filter((node) => node.flags.decorative).length;
  const responsiveVariants = subtreeNodes.filter((node) => node.flags.responsiveVariant).length;
  const nestedSections = subtreeNodes.filter(
    (node) => node.kind === "section" && node.id !== rootId
  ).length;
  const overlaps = countSubtreeOverlaps(rootId, maps.layoutById);

  if (neutralLayoutMode) {
    return (
      subtreeNodes.length <= 18 &&
      absoluteCount === 0 &&
      decorativeCount === 0 &&
      responsiveVariants === 0 &&
      nestedSections <= 4 &&
      overlaps === 0
    );
  }

  const desktopPattern = detectContainerPattern(rootNode, maps.layoutById, "desktop");
  const tabletPattern = detectContainerPattern(rootNode, maps.layoutById, "tablet");
  const mobilePattern = detectContainerPattern(rootNode, maps.layoutById, "mobile");
  const desktopPreset = detectContainerPreset(rootNode, maps.layoutById, "desktop");
  const tabletPreset = detectContainerPreset(rootNode, maps.layoutById, "tablet");
  const mobilePreset = detectContainerPreset(rootNode, maps.layoutById, "mobile");
  const isSplitPattern =
    desktopPattern === "text-image-split" ||
    desktopPattern === "image-text-split" ||
    tabletPattern === "text-image-split" ||
    tabletPattern === "image-text-split";
  const isCardGridPattern =
    desktopPattern === "card-grid" || tabletPattern === "card-grid";
  const isRecognizedStructuredPattern =
    isSplitPattern ||
    isCardGridPattern ||
    desktopPattern === "stack" ||
    tabletPattern === "stack" ||
    mobilePattern === "stack";
  const hasRecognizedPreset =
    desktopPreset !== "generic" ||
    tabletPreset !== "generic" ||
    mobilePreset !== "generic";

  if (isRecognizedStructuredPattern || hasRecognizedPreset) {
    return (
      subtreeNodes.length <= (isCardGridPattern || hasRecognizedPreset ? 64 : 36) &&
      absoluteCount === 0 &&
      decorativeCount === 0 &&
      responsiveVariants === 0 &&
      nestedSections <= (isCardGridPattern || hasRecognizedPreset ? 20 : 10) &&
      overlaps === 0
    );
  }

  return (
    subtreeNodes.length <= 24 &&
    absoluteCount === 0 &&
    decorativeCount === 0 &&
    responsiveVariants === 0 &&
    nestedSections <= 6 &&
    overlaps === 0
  );
}

function buildWidgetFromNode(
  node: LayoutNode,
  maps: NodeMaps,
  captureNode: PageCapture["nodes"][number] | undefined,
  index: number,
  neutralLayoutMode = false
): ElementorElement | null {
  if (node.flags.hidden) {
    return null;
  }

  const styles = {
    backgroundColor: node.style.backgroundColor,
    color: node.style.color,
    fontSize: node.style.fontSize,
    fontFamily: node.style.fontFamily,
    fontWeight: node.style.fontWeight,
    lineHeight: node.style.lineHeight,
    textAlign: node.style.textAlign,
    borderRadius: node.style.borderRadius,
    boxShadow: node.style.boxShadow
  };
  const commonSettings = {
    converter_v3_source_node_id: node.id,
    converter_v3_responsive: serializeResponsiveElement(node),
    ...createElementorResponsiveSettings(node),
    _padding: toSpacingObject(node.spacing.padding),
    _margin: toSpacingObject(node.spacing.margin),
    width: node.box.width ? `${Math.round(node.box.width)}px` : undefined,
    background_color: node.style.backgroundColor,
    color: node.style.color,
    font_size: node.style.fontSize,
    font_family: node.style.fontFamily,
    font_weight: node.style.fontWeight,
    line_height: node.style.lineHeight,
    align: node.style.textAlign,
    border_radius: node.style.borderRadius,
    box_shadow: node.style.boxShadow,
    converter_v3_styles: styles,
    converter_v3_visual_order: node.visualOrder
  };
  const tag = captureNode?.tag ?? "";
  const presetContext = neutralLayoutMode ? undefined : getPresetContext(node, maps);
  const widgetSemanticHint = neutralLayoutMode
    ? undefined
    : getPresetSemanticHint(node, maps, captureNode, presetContext);

  if (node.kind === "image" && node.content.src) {
    const imageSettings = applyPresetWidgetDefaults("image", widgetSemanticHint, {
      ...commonSettings,
      image: {
        url: node.content.src,
        alt: node.content.alt ?? ""
      },
      image_size: "full",
      object_fit: node.style.objectFit,
      object_position: node.style.objectPosition,
      converter_v3_widget_semantic: widgetSemanticHint
    });

    return {
      id: createElementId("image", index),
      elType: "widget",
      widgetType: "image",
      settings: imageSettings,
      elements: []
    };
  }

  if (node.kind === "button") {
    const buttonSettings = applyPresetWidgetDefaults("button", widgetSemanticHint, {
      ...commonSettings,
      text: sanitizeText(node.content.text) || sanitizeText(captureNode?.text) || "Button",
      link: {
        url: node.content.href ?? "",
        is_external: captureNode?.attributes.target === "_blank",
        nofollow: false
      },
      width:
        widgetSemanticHint === "pricing-cta"
          ? "100%"
          : node.box.width
            ? `${Math.round(node.box.width)}px`
            : undefined,
      converter_v3_widget_semantic: widgetSemanticHint
    });

    return {
      id: createElementId("button", index),
      elType: "widget",
      widgetType: "button",
      settings: buttonSettings,
      elements: []
    };
  }

  if (node.kind === "text" || node.kind === "badge") {
    const text = sanitizeText(node.content.text) || sanitizeText(captureNode?.text);

    if (!text) {
      return null;
    }

    if (/^h[1-6]$/.test(tag)) {
      const headingSettings = applyPresetWidgetDefaults("heading", widgetSemanticHint, {
        ...commonSettings,
        title: text,
        header_size: tag,
        converter_v3_widget_semantic: widgetSemanticHint
      });

      return {
        id: createElementId("heading", index),
        elType: "widget",
        widgetType: "heading",
        settings: headingSettings,
        elements: []
      };
    }

    if (widgetSemanticHint === "testimonial-quote") {
      const quoteSettings = applyPresetWidgetDefaults("blockquote", widgetSemanticHint, {
        ...commonSettings,
        blockquote_content: text,
        converter_v3_widget_semantic: widgetSemanticHint
      });

      return {
        id: createElementId("quote", index),
        elType: "widget",
        widgetType: "blockquote",
        settings: quoteSettings,
        elements: []
      };
    }

    if (widgetSemanticHint === "price") {
      const priceSettings = applyPresetWidgetDefaults("heading", widgetSemanticHint, {
        ...commonSettings,
        title: text,
        header_size: "h3",
        converter_v3_widget_semantic: widgetSemanticHint
      });

      return {
        id: createElementId("price", index),
        elType: "widget",
        widgetType: "heading",
        settings: priceSettings,
        elements: []
      };
    }

    if (widgetSemanticHint === "feature-title") {
      const featureTitleSettings = applyPresetWidgetDefaults("heading", widgetSemanticHint, {
        ...commonSettings,
        title: text,
        header_size: "h4",
        converter_v3_widget_semantic: widgetSemanticHint
      });

      return {
        id: createElementId("feature-heading", index),
        elType: "widget",
        widgetType: "heading",
        settings: featureTitleSettings,
        elements: []
      };
    }

    if (widgetSemanticHint === "testimonial-attribution") {
      const attributionSettings = applyPresetWidgetDefaults("heading", widgetSemanticHint, {
        ...commonSettings,
        title: text,
        header_size: "h6",
        converter_v3_widget_semantic: widgetSemanticHint
      });

      return {
        id: createElementId("testimonial-author", index),
        elType: "widget",
        widgetType: "heading",
        settings: attributionSettings,
        elements: []
      };
    }

    if (widgetSemanticHint === "testimonial-rating") {
      const ratingSettings = applyPresetWidgetDefaults("text-editor", widgetSemanticHint, {
        ...commonSettings,
        editor: text,
        converter_v3_widget_semantic: widgetSemanticHint
      });

      return {
        id: createElementId("testimonial-rating", index),
        elType: "widget",
        widgetType: "text-editor",
        settings: ratingSettings,
        elements: []
      };
    }

    if (widgetSemanticHint === "feature-eyebrow") {
      const eyebrowSettings = applyPresetWidgetDefaults("text-editor", widgetSemanticHint, {
        ...commonSettings,
        editor: text,
        converter_v3_widget_semantic: widgetSemanticHint
      });

      return {
        id: createElementId("feature-eyebrow", index),
        elType: "widget",
        widgetType: "text-editor",
        settings: eyebrowSettings,
        elements: []
      };
    }

    const textSettings = applyPresetWidgetDefaults("text-editor", widgetSemanticHint, {
      ...commonSettings,
      editor: text,
      converter_v3_widget_semantic: widgetSemanticHint
    });

    return {
      id: createElementId("text", index),
      elType: "widget",
      widgetType: "text-editor",
      settings: textSettings,
      elements: []
    };
  }

  return null;
}

function buildContainerFromNode(
  node: LayoutNode,
  maps: NodeMaps,
  children: ElementorElement[],
  index: number,
  options: {
    neutralLayoutMode?: boolean;
  } = {}
): ElementorElement {
  const neutralLayoutMode = options.neutralLayoutMode === true;
  const derivedLayout = deriveResponsiveContainerLayout(node, maps.layoutById, "desktop");
  const desktopPattern = detectContainerPattern(node, maps.layoutById, "desktop");
  const desktopPreset = neutralLayoutMode
    ? "generic"
    : detectContainerPreset(node, maps.layoutById, "desktop");
  const presetContext = neutralLayoutMode ? undefined : getPresetContext(node, maps);
  const presetLayoutDefaults = getPresetContainerLayoutDefaults({
    preset: desktopPreset,
    role: presetContext?.role
  });
  const sectionComposition = node.kind === "section"
    ? neutralLayoutMode
      ? "generic"
      : detectSectionComposition(children)
    : "generic";
  const sectionLayoutDefaults = getSectionCompositionDefaults(sectionComposition);
  const laidOutChildren = neutralLayoutMode
    ? applyDerivedChildSettings(children, node, maps, derivedLayout, true)
    : (node.kind === "section"
        ? sortElementsForSectionComposition
        : sortElementsForPresetLayout)(
        applyDerivedChildSettings(children, node, maps, derivedLayout)
      );
  const sectionStructure =
    node.kind === "section" && !neutralLayoutMode
      ? getSectionStructureSummary(laidOutChildren, sectionComposition)
      : undefined;
  const sectionBlueprint =
    node.kind === "section" && !neutralLayoutMode
      ? getSectionBlueprintSummary(laidOutChildren, sectionComposition)
      : undefined;
  const sectionStrategy =
    node.kind === "section" && !neutralLayoutMode
      ? getSectionEmitterStrategy(sectionBlueprint)
      : undefined;
  const sectionStrategyProfile =
    node.kind === "section" && !neutralLayoutMode
      ? getSectionStrategyProfile(sectionStrategy)
      : undefined;
  const sectionSlots =
    node.kind === "section" && !neutralLayoutMode
      ? getSectionSlotSummary(laidOutChildren, sectionComposition)
      : undefined;
  const sectionStructureDefaults =
    node.kind === "section" && !neutralLayoutMode
      ? getSectionStructureContainerDefaults(sectionStructure)
      : {};
  const sectionStrategyElements =
    node.kind === "section" && !neutralLayoutMode
      ? buildSectionStrategyElements({
          children: laidOutChildren,
          strategy: sectionStrategy,
          strategyProfile: sectionStrategyProfile,
          createId: (prefix, order) => `${createElementId(prefix, index)}-${order.toString(16)}`
        })
      : { elements: laidOutChildren, applied: false, shells: [] };
  const justifyContent =
    sectionStructureDefaults.justify_content ??
    sectionLayoutDefaults.justify_content ??
    presetLayoutDefaults.justify_content ??
    derivedLayout.justifyContent ??
    (desktopPattern === "text-image-split" || desktopPattern === "image-text-split"
      ? "space-between"
      : desktopPattern === "card-grid"
        ? "flex-start"
        : undefined);
  const alignItems =
    sectionStrategyProfile?.rootAlignItems ??
    sectionStructureDefaults.align_items ??
    sectionLayoutDefaults.align_items ??
    presetLayoutDefaults.align_items ??
    derivedLayout.alignItems ??
    (desktopPattern === "text-image-split" || desktopPattern === "image-text-split"
      ? "center"
      : desktopPattern === "card-grid"
        ? "stretch"
        : undefined);
  const flexDirection =
    sectionLayoutDefaults.flex_direction ??
    presetLayoutDefaults.flex_direction ??
    derivedLayout.flexDirection;
  const gap =
    sectionStrategyProfile?.rootGap ??
    sectionStructureDefaults.gap ??
    sectionLayoutDefaults.gap ??
    presetLayoutDefaults.gap ??
    derivedLayout.gap;

  return {
    id: createElementId(node.kind === "section" ? "section" : "container", index),
    elType: node.kind === "section" ? "container" : "container",
    settings: {
      content_width: "full",
      converter_v3_source_node_id: node.id,
      converter_v3_universal_neutral_mode: neutralLayoutMode || undefined,
      width: node.box.width ? `${Math.round(node.box.width)}px` : undefined,
      max_width: sectionStructureDefaults.max_width,
      min_height: node.box.height ? `${Math.round(node.box.height)}px` : undefined,
      flex_direction: flexDirection,
      flex_wrap: derivedLayout.flexWrap,
      justify_content: justifyContent,
      align_items: alignItems,
      gap,
      grid_template_columns: node.layout.gridTemplateColumns,
      grid_template_rows: node.layout.gridTemplateRows,
      background_color: node.style.backgroundColor,
      border_radius: node.style.borderRadius,
      box_shadow: node.style.boxShadow,
      _padding: toSpacingObject(node.spacing.padding),
      _margin: toSpacingObject(node.spacing.margin),
      converter_v3_tag: node.kind,
      converter_v3_responsive: serializeResponsiveContainer(node, maps.layoutById),
      ...createElementorResponsiveSettings(node, maps.layoutById),
      converter_v3_section_preset: sectionStructure?.preset,
      converter_v3_section_signature: sectionStructure?.signature,
      converter_v3_section_phases: sectionStructure?.phases,
      converter_v3_section_slots: sectionSlots?.slots,
      converter_v3_section_slot_signature: sectionSlots?.signature,
      converter_v3_section_regions: sectionBlueprint?.regions,
      converter_v3_section_region_signature: sectionBlueprint?.regionSignature,
      converter_v3_section_blueprint: sectionBlueprint,
      converter_v3_section_strategy: sectionStrategy?.name,
      converter_v3_section_strategy_profile: sectionStrategyProfile,
      converter_v3_section_strategy_structure: sectionStrategyElements.applied
        ? "region-shells"
        : "flat",
      converter_v3_section_strategy_regions: sectionStrategyElements.shells.map((shell) => ({
        region: shell.region,
        mode: shell.mode,
        roles: shell.childRoles,
        slots: shell.childSlots
      })),
      converter_v3_section_preset_layout: sectionStructureDefaults.layout,
      converter_v3_layout: {
        display: node.layout.display,
        position: node.layout.position,
        pattern: desktopPattern,
        preset: desktopPreset,
        universalNeutralMode: neutralLayoutMode,
        sectionComposition,
        sectionPreset: sectionStructure?.preset,
        sectionSignature: sectionStructure?.signature,
        sectionPhases: sectionStructure?.phases,
        sectionSlots: sectionSlots?.slots,
        sectionSlotSignature: sectionSlots?.signature,
        sectionRegions: sectionBlueprint?.regions,
        sectionRegionSignature: sectionBlueprint?.regionSignature,
        sectionBlueprint,
        sectionStrategy: sectionStrategy?.name,
        sectionStrategyProfile,
        sectionStrategyStructure: sectionStrategyElements.applied ? "region-shells" : "flat",
        sectionStrategyRegions: sectionStrategyElements.shells.map((shell) => ({
          region: shell.region,
          mode: shell.mode,
          roles: shell.childRoles,
          slots: shell.childSlots
        })),
        sectionPresetLayout: sectionStructureDefaults.layout,
        presetRole: presetContext?.role,
        flexDirection,
        flexWrap: derivedLayout.flexWrap,
        justifyContent,
        alignItems,
        gap,
        columns: derivedLayout.columnCount,
        rows: derivedLayout.rowCount,
        stacked: derivedLayout.shouldStack,
        gridTemplateColumns: node.layout.gridTemplateColumns,
        gridTemplateRows: node.layout.gridTemplateRows
      }
    },
    elements: sectionStrategyElements.elements
  };
}

function buildHtmlWidgetFromNode(
  nodeId: string,
  $: cheerio.CheerioAPI,
  index: number
): ElementorElement | null {
  const element = $(`[data-capture-id="${nodeId}"]`).first();

  if (!element.length) {
    return null;
  }

  return {
    id: createElementId("html", index),
    elType: "widget",
    widgetType: "html",
    settings: {
      html: element.toString(),
      converter_v3_html_fallback: true,
      converter_v3_source_node_id: nodeId
    },
    elements: []
  };
}

function buildHtmlFallbackElementFromNode(params: {
  node: LayoutNode;
  maps: NodeMaps;
  $: cheerio.CheerioAPI;
  counter: { value: number };
  htmlFallbacks: Set<string>;
  neutralLayoutMode?: boolean;
}): ElementorElement | null {
  params.htmlFallbacks.add(params.node.id);
  params.counter.value += 1;
  const htmlWidget = buildHtmlWidgetFromNode(params.node.id, params.$, params.counter.value);

  if (!htmlWidget) {
    return null;
  }

  if (params.node.kind !== "section" && params.node.kind !== "container") {
    return htmlWidget;
  }

  params.counter.value += 1;
  const container = buildContainerFromNode(
    params.node,
    params.maps,
    [htmlWidget],
    params.counter.value,
    {
      neutralLayoutMode: params.neutralLayoutMode
    }
  );

  return {
    ...container,
    settings: {
      converter_v3_html_fallback_container: true,
      ...container.settings
    }
  };
}

function buildElementFromNode(params: {
  nodeId: string;
  maps: NodeMaps;
  $: cheerio.CheerioAPI;
  counter: { value: number };
  htmlFallbacks: Set<string>;
  neutralLayoutMode: boolean;
}): ElementorElement | null {
  const node = params.maps.layoutById.get(params.nodeId);

  if (!node || node.flags.hidden) {
    return null;
  }

  const captureNode = params.maps.captureById.get(node.id);

  if (node.kind === "text" || node.kind === "badge" || node.kind === "image" || node.kind === "button") {
    params.counter.value += 1;
    return buildWidgetFromNode(
      node,
      params.maps,
      captureNode,
      params.counter.value,
      params.neutralLayoutMode
    );
  }

  if (!isNodeSimpleEnough(node.id, params.maps, params.neutralLayoutMode)) {
    return buildHtmlFallbackElementFromNode({
      node,
      maps: params.maps,
      $: params.$,
      counter: params.counter,
      htmlFallbacks: params.htmlFallbacks,
      neutralLayoutMode: params.neutralLayoutMode
    });
  }

  const orderedChildIds = params.neutralLayoutMode
    ? getVisualOrderChildIds(node, params.maps.layoutById)
    : getOrderedChildIdsForPattern(node, params.maps.layoutById, "desktop");
  const children = orderedChildIds
    .map((childId) =>
      buildElementFromNode({
        ...params,
        nodeId: childId
      })
    )
    .filter((element): element is ElementorElement => Boolean(element));

  params.counter.value += 1;
  return buildContainerFromNode(node, params.maps, children, params.counter.value, {
    neutralLayoutMode: params.neutralLayoutMode
  });
}

function getTopLevelNodeIds(layout: LayoutDocument) {
  if (layout.sectionIds.length) {
    return layout.sectionIds;
  }

  return layout.nodes
    .filter((node) => node.parentId === layout.rootNodeId)
    .map((node) => node.id);
}

export function createHybridElementorDocumentV3(params: {
  capture: PageCapture;
  layout: LayoutDocument;
  selectedMode: OutputMode;
}): HybridEmitterResult {
  const neutralLayoutMode = shouldUseUniversalNeutralLayoutMode(
    params.capture,
    params.layout
  );
  const maps = buildNodeMaps(params.capture, params.layout);
  const $ = cheerio.load(params.capture.renderedHtml);
  const counter = { value: 0 };
  const htmlFallbacks = new Set<string>();
  const topLevelNodeIds = getTopLevelNodeIds(params.layout);
  const content = topLevelNodeIds
    .map((nodeId) =>
      buildElementFromNode({
        nodeId,
        maps,
        $,
        counter,
        htmlFallbacks,
        neutralLayoutMode
      })
    )
    .filter((element): element is ElementorElement => Boolean(element));
  const warnings = [...htmlFallbacks].map(
    (nodeId) => `No ${nodeId} exportado como HTML preservado por complexidade local.`
  );

  return {
    document: {
      version: "1.0",
      title: params.capture.title,
      type: "page",
      content
    },
    usedHtmlFallbackNodeIds: [...htmlFallbacks],
    warnings
  };
}
