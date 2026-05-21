import { applyPresetWidgetDefaults } from "@/lib/converter-v3/emitters/elementor/widget-defaults";
import type { ElementorElement } from "@/types/conversion";

export type SectionComposition =
  | "generic"
  | "pricing-section"
  | "testimonial-section"
  | "feature-section";

export type SectionChildRole =
  | "section-header"
  | "section-grid"
  | "section-support"
  | "section-cta"
  | "section-body";

export type SectionPhase =
  | "body"
  | "intro"
  | "main"
  | "support"
  | "outro"
  | "cta";

export type SectionChildBlock =
  | "generic"
  | "primary-grid"
  | "support-row"
  | "badge-row"
  | "guarantee-strip"
  | "closing-stack"
  | "secondary-cta";

export type SectionBlockPreset =
  | "generic"
  | "section-intro-stack"
  | "section-outro-stack"
  | "primary-grid"
  | "support-inline"
  | "badge-list"
  | "guarantee-panel"
  | "secondary-cta-stack";

export type SectionStructurePreset =
  | "generic-section"
  | "commerce-offer-section"
  | "social-proof-section"
  | "benefits-showcase-section";

export type SectionPresetSlot =
  | "section-body"
  | "offer-intro"
  | "offer-grid"
  | "offer-proof"
  | "offer-guarantee"
  | "offer-support"
  | "offer-closing-cta"
  | "social-proof-intro"
  | "social-proof-grid"
  | "social-proof-outro"
  | "social-proof-support"
  | "social-proof-cta"
  | "benefits-intro"
  | "benefits-grid"
  | "benefits-outro"
  | "benefits-support"
  | "benefits-cta";

export type SectionPresetRegion =
  | "body"
  | "intro"
  | "main"
  | "proof"
  | "support"
  | "closing";

type SectionChildDescriptor = {
  role: SectionChildRole;
  block: SectionChildBlock;
  preset: SectionBlockPreset;
  phase: SectionPhase;
  index: number;
  composition: SectionComposition;
};

export type SectionStructureSummary = {
  preset: SectionStructurePreset;
  signature: string;
  phases: SectionPhase[];
};

export type SectionSlotSummary = {
  slots: SectionPresetSlot[];
  signature: string;
};

export type SectionBlueprintSummary = {
  preset: SectionStructurePreset;
  slots: SectionPresetSlot[];
  slotSignature: string;
  regions: SectionPresetRegion[];
  regionSignature: string;
  primarySlot?: SectionPresetSlot;
  closingSlot?: SectionPresetSlot;
};

export type SectionEmitterStrategyName =
  | "generic"
  | "commerce-offer"
  | "social-proof"
  | "benefits-showcase";

export type SectionEmitterStrategy = {
  name: SectionEmitterStrategyName;
  primarySlot?: SectionPresetSlot;
  closingSlot?: SectionPresetSlot;
  regionSequence: SectionPresetRegion[];
};

export type SectionStrategyProfile = {
  name: SectionEmitterStrategyName;
  layoutModel: "generic" | "stacked-offer" | "stacked-social-proof" | "stacked-benefits";
  rootGap?: string;
  rootAlignItems?: string;
  narrativeRegionMode: "generic" | "boxed-centered";
  mainRegionMode: "generic" | "stretch-grid";
};

type SectionStructureLayoutDefaults = {
  width?: string;
  max_width?: string;
  tablet_max_width?: string;
  mobile_max_width?: string;
  justify_content?: string;
  align_items?: string;
  gap?: string;
  layout?: string;
};

type SectionRegionContainerDefaults = {
  align_self?: string;
  mode: "generic" | "boxed-centered" | "stretch-grid";
};

type SectionWidgetSemantic =
  | "section-intro-eyebrow"
  | "section-intro-title"
  | "section-intro-support"
  | "section-intro-cta"
  | "section-outro-title"
  | "section-outro-support"
  | "section-outro-cta"
  | "section-badge"
  | "section-support-item"
  | "guarantee-title"
  | "guarantee-support"
  | "guarantee-cta"
  | "section-secondary-cta"
  | "section-secondary-support";

type SectionBlockMicroLayout =
  | "generic"
  | "intro-stack"
  | "outro-stack"
  | "badge-flow"
  | "support-inline"
  | "guarantee-stack"
  | "secondary-cta-stack";

type SectionBlockResponsiveProfile = {
  desktop?: Record<string, unknown>;
  tablet?: Record<string, unknown>;
  mobile?: Record<string, unknown>;
};

function isSectionWidgetSemantic(value: string): value is SectionWidgetSemantic {
  return (
    value === "section-intro-eyebrow" ||
    value === "section-intro-title" ||
    value === "section-intro-support" ||
    value === "section-intro-cta" ||
    value === "section-outro-title" ||
    value === "section-outro-support" ||
    value === "section-outro-cta" ||
    value === "section-badge" ||
    value === "section-support-item" ||
    value === "guarantee-title" ||
    value === "guarantee-support" ||
    value === "guarantee-cta" ||
    value === "section-secondary-cta" ||
    value === "section-secondary-support"
  );
}

function getElementPreset(element: ElementorElement) {
  const layout =
    element.settings.converter_v3_layout &&
    typeof element.settings.converter_v3_layout === "object"
      ? (element.settings.converter_v3_layout as Record<string, unknown>)
      : undefined;

  return typeof layout?.preset === "string" ? layout.preset : undefined;
}

function isSectionPreset(
  preset: string | undefined
): preset is "pricing-cards" | "testimonial-cards" | "feature-cards" {
  return (
    preset === "pricing-cards" ||
    preset === "testimonial-cards" ||
    preset === "feature-cards"
  );
}

function isPresetContainer(element: ElementorElement) {
  return element.elType === "container" && isSectionPreset(getElementPreset(element));
}

function getPresetPriority(element: ElementorElement) {
  const preset = getElementPreset(element);

  if (isSectionPreset(preset)) {
    return 1;
  }

  return 0;
}

export function detectSectionComposition(elements: ElementorElement[]) {
  const presetContainers = elements.filter(isPresetContainer);

  if (presetContainers.length !== 1) {
    return "generic" as SectionComposition;
  }

  const preset = getElementPreset(presetContainers[0]);

  if (preset === "pricing-cards") {
    return "pricing-section" as SectionComposition;
  }

  if (preset === "testimonial-cards") {
    return "testimonial-section" as SectionComposition;
  }

  if (preset === "feature-cards") {
    return "feature-section" as SectionComposition;
  }

  return "generic" as SectionComposition;
}

export function getSectionCompositionDefaults(composition: SectionComposition) {
  if (composition === "pricing-section") {
    return {
      flex_direction: "column",
      justify_content: "flex-start",
      align_items: "stretch",
      gap: "28px"
    };
  }

  if (composition === "testimonial-section" || composition === "feature-section") {
    return {
      flex_direction: "column",
      justify_content: "flex-start",
      align_items: "stretch",
      gap: "24px"
    };
  }

  return {};
}

function collectWidgetSemantics(element: ElementorElement): string[] {
  const semantics: string[] = [];
  const queue = [element];

  while (queue.length) {
    const current = queue.shift();

    if (!current) {
      continue;
    }

    const semantic =
      typeof current.settings.converter_v3_widget_semantic === "string"
        ? current.settings.converter_v3_widget_semantic
        : undefined;

    if (semantic) {
      semantics.push(semantic);
    }

    queue.push(...current.elements);
  }

  return semantics;
}

function collectWidgetTypes(element: ElementorElement) {
  const widgetTypes: string[] = [];
  const queue = [element];

  while (queue.length) {
    const current = queue.shift();

    if (!current) {
      continue;
    }

    if (current.elType === "widget" && current.widgetType) {
      widgetTypes.push(current.widgetType);
    }

    queue.push(...current.elements);
  }

  return widgetTypes;
}

function collectWidgetTexts(element: ElementorElement) {
  const values: string[] = [];
  const queue = [element];

  while (queue.length) {
    const current = queue.shift();

    if (!current) {
      continue;
    }

    const textCandidates = [
      current.settings.title,
      current.settings.editor,
      current.settings.blockquote_content,
      current.settings.text
    ];

    for (const candidate of textCandidates) {
      if (typeof candidate === "string" && candidate.trim()) {
        values.push(candidate.trim());
      }
    }

    queue.push(...current.elements);
  }

  return values;
}

function collectWidgets(element: ElementorElement) {
  const widgets: ElementorElement[] = [];
  const queue = [element];

  while (queue.length) {
    const current = queue.shift();

    if (!current) {
      continue;
    }

    if (current.elType === "widget" && current.widgetType) {
      widgets.push(current);
    }

    queue.push(...current.elements);
  }

  return widgets;
}

function hasVisualFraming(element: ElementorElement) {
  return Boolean(
    element.settings.background_color ||
      element.settings.border_radius ||
      element.settings.box_shadow
  );
}

function countHeadingLikeWidgets(element: ElementorElement) {
  const queue = [element];
  let count = 0;

  while (queue.length) {
    const current = queue.shift();

    if (!current) {
      continue;
    }

    if (current.elType === "widget" && current.widgetType === "heading") {
      count += 1;
    }

    queue.push(...current.elements);
  }

  return count;
}

function detectSupportBlock(element: ElementorElement) {
  const texts = collectWidgetTexts(element);
  const shortTextCount = texts.filter((text) => text.length <= 32).length;
  const headingCount = countHeadingLikeWidgets(element);
  const visualFraming = hasVisualFraming(element);
  const childCount = element.elements.length;
  const explicitDirection =
    typeof element.settings.flex_direction === "string"
      ? element.settings.flex_direction
      : undefined;
  const layout =
    element.settings.converter_v3_layout &&
    typeof element.settings.converter_v3_layout === "object"
      ? (element.settings.converter_v3_layout as Record<string, unknown>)
      : undefined;
  const pattern =
    typeof layout?.pattern === "string"
      ? layout.pattern
      : undefined;
  const columns =
    typeof layout?.columns === "number"
      ? layout.columns
      : undefined;

  if (
    visualFraming &&
    headingCount >= 1 &&
    texts.length >= 2 &&
    childCount <= 3
  ) {
    return "guarantee-strip" as SectionChildBlock;
  }

  if (
    texts.length >= 2 &&
    shortTextCount === texts.length &&
    (explicitDirection === "row" || pattern === "card-grid" || (columns ?? 0) > 1)
  ) {
    return childCount >= 3 ? "badge-row" as SectionChildBlock : "support-row" as SectionChildBlock;
  }

  return "support-row" as SectionChildBlock;
}

function getSectionBlockPreset(block: SectionChildBlock): SectionBlockPreset {
  if (block === "primary-grid") {
    return "primary-grid";
  }

  if (block === "badge-row") {
    return "badge-list";
  }

  if (block === "support-row") {
    return "support-inline";
  }

  if (block === "guarantee-strip") {
    return "guarantee-panel";
  }

  if (block === "secondary-cta") {
    return "secondary-cta-stack";
  }

  return "generic";
}

function getSectionBlockMicroLayout(
  descriptor: Pick<SectionChildDescriptor, "preset">
): SectionBlockMicroLayout {
  if (descriptor.preset === "section-intro-stack") {
    return "intro-stack";
  }

  if (descriptor.preset === "section-outro-stack") {
    return "outro-stack";
  }

  if (descriptor.preset === "badge-list") {
    return "badge-flow";
  }

  if (descriptor.preset === "support-inline") {
    return "support-inline";
  }

  if (descriptor.preset === "guarantee-panel") {
    return "guarantee-stack";
  }

  if (descriptor.preset === "secondary-cta-stack") {
    return "secondary-cta-stack";
  }

  return "generic";
}

function getSectionBlockResponsiveProfile(
  descriptor: Pick<SectionChildDescriptor, "preset">
): SectionBlockResponsiveProfile {
  if (descriptor.preset === "section-intro-stack") {
    return {
      desktop: {
        flex_direction: "column",
        gap: "14px"
      },
      tablet: {
        flex_direction: "column",
        align_items: "flex-start",
        gap: "14px"
      },
      mobile: {
        flex_direction: "column",
        align_items: "stretch",
        gap: "12px"
      }
    };
  }

  if (descriptor.preset === "section-outro-stack") {
    return {
      desktop: {
        flex_direction: "column",
        gap: "12px"
      },
      tablet: {
        flex_direction: "column",
        align_items: "flex-start",
        gap: "12px"
      },
      mobile: {
        flex_direction: "column",
        align_items: "stretch",
        gap: "10px"
      }
    };
  }

  if (descriptor.preset === "badge-list") {
    return {
      desktop: {
        flex_direction: "row",
        flex_wrap: "wrap",
        gap: "12px"
      },
      tablet: {
        flex_direction: "row",
        flex_wrap: "wrap",
        gap: "12px"
      },
      mobile: {
        flex_direction: "column",
        align_items: "stretch",
        gap: "10px"
      }
    };
  }

  if (descriptor.preset === "support-inline") {
    return {
      desktop: {
        flex_direction: "row",
        flex_wrap: "wrap",
        gap: "12px"
      },
      tablet: {
        flex_direction: "row",
        flex_wrap: "wrap",
        gap: "12px"
      },
      mobile: {
        flex_direction: "column",
        align_items: "stretch",
        gap: "10px"
      }
    };
  }

  if (descriptor.preset === "guarantee-panel") {
    return {
      desktop: {
        flex_direction: "column",
        gap: "10px"
      },
      tablet: {
        flex_direction: "column",
        align_items: "stretch",
        gap: "10px"
      },
      mobile: {
        flex_direction: "column",
        align_items: "stretch",
        gap: "10px"
      }
    };
  }

  if (descriptor.preset === "secondary-cta-stack") {
    return {
      desktop: {
        flex_direction: "column",
        gap: "10px"
      },
      tablet: {
        flex_direction: "column",
        align_items: "stretch",
        gap: "10px"
      },
      mobile: {
        flex_direction: "column",
        align_items: "stretch",
        gap: "10px"
      }
    };
  }

  return {};
}

function getSectionHeaderPreset(composition: SectionComposition): SectionBlockPreset {
  if (composition === "testimonial-section" || composition === "feature-section") {
    return "section-intro-stack";
  }

  return "generic";
}

function isNarrativeSectionComposition(composition: SectionComposition) {
  return composition === "testimonial-section" || composition === "feature-section";
}

function getSectionHeaderWidgetSemantics(
  element: ElementorElement
) {
  const assignments = new Map<string, SectionWidgetSemantic>();
  const widgets = collectWidgets(element);

  if (!widgets.length) {
    return assignments;
  }

  const textLikeWidgets = widgets.filter((widget) =>
    widget.widgetType === "heading" ||
    widget.widgetType === "text-editor" ||
    widget.widgetType === "blockquote"
  );
  const titleWidget =
    textLikeWidgets.find((widget) => widget.widgetType === "heading") ??
    textLikeWidgets[0];
  const eyebrowWidget = textLikeWidgets.find((widget) => {
    if (widget.id === titleWidget?.id) {
      return false;
    }

    const value =
      typeof widget.settings.title === "string"
        ? widget.settings.title
        : typeof widget.settings.editor === "string"
          ? widget.settings.editor
          : typeof widget.settings.blockquote_content === "string"
            ? widget.settings.blockquote_content
            : undefined;

    if (!value) {
      return false;
    }

    const words = value.trim().split(/\s+/).filter(Boolean);
    return value.trim().length <= 32 && words.length <= 5;
  });

  if (eyebrowWidget) {
    assignments.set(eyebrowWidget.id, "section-intro-eyebrow");
  }

  if (titleWidget) {
    assignments.set(titleWidget.id, "section-intro-title");
  }

  for (const widget of widgets) {
    if (widget.widgetType === "button") {
      assignments.set(widget.id, "section-intro-cta");
      continue;
    }

    if (
      (widget.widgetType === "heading" ||
        widget.widgetType === "text-editor" ||
        widget.widgetType === "blockquote") &&
      !assignments.has(widget.id)
    ) {
      assignments.set(widget.id, "section-intro-support");
    }
  }

  return assignments;
}

function getSectionPhaseForDescriptor(
  descriptor: Pick<SectionChildDescriptor, "role" | "block" | "preset">
): SectionPhase {
  if (descriptor.role === "section-header") {
    return "intro";
  }

  if (descriptor.role === "section-grid" || descriptor.preset === "primary-grid") {
    return "main";
  }

  if (descriptor.preset === "section-outro-stack" || descriptor.block === "closing-stack") {
    return "outro";
  }

  if (descriptor.role === "section-cta" || descriptor.preset === "secondary-cta-stack") {
    return "cta";
  }

  if (
    descriptor.role === "section-support" ||
    descriptor.preset === "support-inline" ||
    descriptor.preset === "badge-list" ||
    descriptor.preset === "guarantee-panel"
  ) {
    return "support";
  }

  return "body";
}

function getSectionStructurePreset(
  composition: SectionComposition
): SectionStructurePreset {
  if (composition === "pricing-section") {
    return "commerce-offer-section";
  }

  if (composition === "testimonial-section") {
    return "social-proof-section";
  }

  if (composition === "feature-section") {
    return "benefits-showcase-section";
  }

  return "generic-section";
}

function getSectionPresetSlot(
  descriptor: Pick<SectionChildDescriptor, "role" | "block" | "phase">,
  composition: SectionComposition
): SectionPresetSlot {
  if (composition === "pricing-section") {
    if (descriptor.role === "section-header") {
      return "offer-intro";
    }

    if (descriptor.role === "section-grid") {
      return "offer-grid";
    }

    if (descriptor.block === "badge-row") {
      return "offer-proof";
    }

    if (descriptor.block === "guarantee-strip") {
      return "offer-guarantee";
    }

    if (descriptor.role === "section-cta") {
      return "offer-closing-cta";
    }

    if (descriptor.role === "section-support") {
      return "offer-support";
    }
  }

  if (composition === "testimonial-section") {
    if (descriptor.role === "section-header") {
      return "social-proof-intro";
    }

    if (descriptor.role === "section-grid") {
      return "social-proof-grid";
    }

    if (descriptor.phase === "outro") {
      return "social-proof-outro";
    }

    if (descriptor.role === "section-cta") {
      return "social-proof-cta";
    }

    if (descriptor.role === "section-support") {
      return "social-proof-support";
    }
  }

  if (composition === "feature-section") {
    if (descriptor.role === "section-header") {
      return "benefits-intro";
    }

    if (descriptor.role === "section-grid") {
      return "benefits-grid";
    }

    if (descriptor.phase === "outro") {
      return "benefits-outro";
    }

    if (descriptor.role === "section-cta") {
      return "benefits-cta";
    }

    if (descriptor.role === "section-support") {
      return "benefits-support";
    }
  }

  return "section-body";
}

function getSectionOutroWidgetSemantics(
  element: ElementorElement
) {
  const assignments = new Map<string, SectionWidgetSemantic>();
  const widgets = collectWidgets(element);

  if (!widgets.length) {
    return assignments;
  }

  const textLikeWidgets = widgets.filter((widget) =>
    widget.widgetType === "heading" ||
    widget.widgetType === "text-editor" ||
    widget.widgetType === "blockquote"
  );
  const titleWidget = textLikeWidgets.find((widget) => widget.widgetType === "heading");

  if (titleWidget) {
    assignments.set(titleWidget.id, "section-outro-title");
  }

  for (const widget of widgets) {
    if (widget.widgetType === "button") {
      assignments.set(widget.id, "section-outro-cta");
      continue;
    }

    if (
      (widget.widgetType === "heading" ||
        widget.widgetType === "text-editor" ||
        widget.widgetType === "blockquote") &&
      !assignments.has(widget.id)
    ) {
      assignments.set(widget.id, "section-outro-support");
    }
  }

  return assignments;
}

function getSectionBlockWidgetSemantics(
  element: ElementorElement,
  descriptor: SectionChildDescriptor
) {
  const assignments = new Map<string, SectionWidgetSemantic>();
  const widgets = collectWidgets(element);

  if (!widgets.length) {
    return assignments;
  }

  if (descriptor.preset === "section-intro-stack") {
    return getSectionHeaderWidgetSemantics(element);
  }

  if (descriptor.preset === "section-outro-stack") {
    return getSectionOutroWidgetSemantics(element);
  }

  if (descriptor.block === "badge-row") {
    for (const widget of widgets) {
      if (widget.widgetType === "heading" || widget.widgetType === "text-editor") {
        assignments.set(widget.id, "section-badge");
      }
    }

    return assignments;
  }

  if (descriptor.block === "support-row") {
    for (const widget of widgets) {
      if (
        widget.widgetType === "heading" ||
        widget.widgetType === "text-editor" ||
        widget.widgetType === "blockquote"
      ) {
        assignments.set(widget.id, "section-support-item");
      }
    }

    return assignments;
  }

  if (descriptor.block === "guarantee-strip") {
    let hasGuaranteeTitle = false;

    for (const widget of widgets) {
      if (!hasGuaranteeTitle && widget.widgetType === "heading") {
        assignments.set(widget.id, "guarantee-title");
        hasGuaranteeTitle = true;
        continue;
      }

      if (widget.widgetType === "button") {
        assignments.set(widget.id, "guarantee-cta");
        continue;
      }

      if (
        widget.widgetType === "heading" ||
        widget.widgetType === "text-editor" ||
        widget.widgetType === "blockquote"
      ) {
        assignments.set(widget.id, "guarantee-support");
      }
    }

    return assignments;
  }

  if (descriptor.block === "secondary-cta") {
    for (const widget of widgets) {
      if (widget.widgetType === "button") {
        assignments.set(widget.id, "section-secondary-cta");
      } else if (
        widget.widgetType === "heading" ||
        widget.widgetType === "text-editor" ||
        widget.widgetType === "blockquote"
      ) {
        assignments.set(widget.id, "section-secondary-support");
      }
    }
  }

  return assignments;
}

const SECTION_BLOCK_WIDGET_PRIORITY: Partial<Record<SectionWidgetSemantic, number>> = {
  "section-intro-eyebrow": 0,
  "section-intro-title": 1,
  "section-intro-support": 2,
  "section-intro-cta": 3,
  "section-outro-title": 0,
  "section-outro-support": 1,
  "section-outro-cta": 2,
  "guarantee-title": 0,
  "guarantee-support": 1,
  "guarantee-cta": 2,
  "section-secondary-cta": 0,
  "section-secondary-support": 1
};

function getSectionBlockWidgetLayoutDefaults(
  descriptor: Pick<SectionChildDescriptor, "preset">,
  widgetSemantic: SectionWidgetSemantic,
  widgetType: string
) {
  if (descriptor.preset === "badge-list") {
    return {
      tablet_width: "48%",
      mobile_width: "100%",
      converter_v3_section_block_micro_layout: "badge-flow",
      converter_v3_section_block_widget_responsive: {
        tablet_width: "48%",
        mobile_width: "100%"
      }
    };
  }

  if (descriptor.preset === "section-intro-stack") {
    return {
      width:
        widgetSemantic === "section-intro-cta" && widgetType === "button"
          ? "100%"
          : undefined,
      mobile_width:
        widgetSemantic === "section-intro-cta" && widgetType === "button"
          ? "100%"
          : undefined,
      converter_v3_section_block_micro_layout: "intro-stack",
      converter_v3_section_block_widget_responsive: {
        mobile_width:
          widgetSemantic === "section-intro-cta" && widgetType === "button"
            ? "100%"
            : undefined
      }
    };
  }

  if (descriptor.preset === "section-outro-stack") {
    return {
      width:
        widgetSemantic === "section-outro-cta" && widgetType === "button"
          ? "100%"
          : undefined,
      tablet_width: "100%",
      mobile_width: "100%",
      converter_v3_section_block_micro_layout: "outro-stack",
      converter_v3_section_block_widget_responsive: {
        tablet_width: "100%",
        mobile_width: "100%"
      }
    };
  }

  if (descriptor.preset === "support-inline") {
    return {
      tablet_width: "48%",
      mobile_width: "100%",
      converter_v3_section_block_micro_layout: "support-inline",
      converter_v3_section_block_widget_responsive: {
        tablet_width: "48%",
        mobile_width: "100%"
      }
    };
  }

  if (descriptor.preset === "guarantee-panel") {
    return {
      width:
        widgetSemantic === "guarantee-cta" && widgetType === "button"
          ? "100%"
          : undefined,
      tablet_width: "100%",
      mobile_width: "100%",
      converter_v3_section_block_micro_layout: "guarantee-stack",
      converter_v3_section_block_widget_responsive: {
        tablet_width: "100%",
        mobile_width: "100%"
      }
    };
  }

  if (descriptor.preset === "secondary-cta-stack") {
    return {
      width:
        widgetSemantic === "section-secondary-cta" && widgetType === "button"
          ? "100%"
          : undefined,
      tablet_width: "100%",
      mobile_width: "100%",
      converter_v3_section_block_micro_layout: "secondary-cta-stack",
      converter_v3_section_block_widget_responsive: {
        tablet_width: "100%",
        mobile_width: "100%"
      }
    };
  }

  return {
    converter_v3_section_block_micro_layout: "generic"
  };
}

function sortSectionBlockElements(
  elements: ElementorElement[],
  descriptor: SectionChildDescriptor
) {
  if (
    descriptor.preset !== "section-intro-stack" &&
    descriptor.preset !== "section-outro-stack" &&
    descriptor.preset !== "guarantee-panel" &&
    descriptor.preset !== "secondary-cta-stack"
  ) {
    return elements;
  }

  return [...elements]
    .map((element, index) => {
      const semantic =
        typeof element.settings.converter_v3_widget_semantic === "string"
          ? (element.settings.converter_v3_widget_semantic as SectionWidgetSemantic)
          : undefined;

      return {
        element,
        index,
        priority: semantic ? SECTION_BLOCK_WIDGET_PRIORITY[semantic] ?? 100 : 100
      };
    })
    .sort((left, right) => {
      if (left.priority !== right.priority) {
        return left.priority - right.priority;
      }

      return left.index - right.index;
    })
    .map((entry) => entry.element);
}

function applySectionBlockWidgetSemantics(
  element: ElementorElement,
  descriptor: SectionChildDescriptor
): ElementorElement {
  const assignments = getSectionBlockWidgetSemantics(element, descriptor);

  if (!assignments.size) {
    return element;
  }

  const visit = (current: ElementorElement): ElementorElement => {
    const elements = current.elements.map(visit);
    const existingSemantic =
      typeof current.settings.converter_v3_widget_semantic === "string"
        ? current.settings.converter_v3_widget_semantic
        : undefined;
    const inferredSemantic = assignments.get(current.id);
    const widgetSemantic =
      existingSemantic && isSectionWidgetSemantic(existingSemantic)
        ? existingSemantic
        : inferredSemantic;
    let settings: Record<string, unknown> = {
      ...current.settings,
      converter_v3_section_block: descriptor.block
    };

    if (current.elType === "widget" && current.widgetType && widgetSemantic) {
      const layoutDefaults = getSectionBlockWidgetLayoutDefaults(
        descriptor,
        widgetSemantic,
        current.widgetType
      );
      settings = applyPresetWidgetDefaults(current.widgetType, widgetSemantic, {
        ...settings,
        ...layoutDefaults,
        converter_v3_widget_semantic: widgetSemantic
      });
    }

    return {
      ...current,
      settings,
      elements:
        current.id === element.id
          ? sortSectionBlockElements(elements, descriptor)
          : elements
    };
  };

  return visit(element);
}

function describeSectionChild(
  element: ElementorElement,
  index: number,
  gridIndex: number,
  composition: SectionComposition
): SectionChildDescriptor {
  if (isPresetContainer(element)) {
    const descriptor = {
      role: "section-grid",
      block: "primary-grid",
      preset: "primary-grid",
      index,
      composition
    } satisfies Omit<SectionChildDescriptor, "phase">;

    return {
      ...descriptor,
      phase: getSectionPhaseForDescriptor(descriptor)
    };
  }

  if (gridIndex < 0) {
    const descriptor = {
      role: "section-body",
      block: "generic",
      preset: "generic",
      index,
      composition
    } satisfies Omit<SectionChildDescriptor, "phase">;

    return {
      ...descriptor,
      phase: getSectionPhaseForDescriptor(descriptor)
    };
  }

  const semantics = collectWidgetSemantics(element);
  const widgetTypes = collectWidgetTypes(element);
  const buttonCount = widgetTypes.filter((widgetType) => widgetType === "button").length;
  const textWidgetCount = widgetTypes.filter((widgetType) =>
    widgetType === "text-editor" || widgetType === "heading" || widgetType === "blockquote"
  ).length;
  const supportSemanticCount = semantics.filter((semantic) => semantic.endsWith("-support")).length;
  const ctaSemanticCount = semantics.filter((semantic) => semantic.endsWith("-cta")).length;

  if (index < gridIndex) {
    const descriptor = {
      role: "section-header",
      block: "generic",
      preset: getSectionHeaderPreset(composition),
      index,
      composition
    } satisfies Omit<SectionChildDescriptor, "phase">;

    return {
      ...descriptor,
      phase: getSectionPhaseForDescriptor(descriptor)
    };
  }

  if (index > gridIndex) {
    const explicitDirection =
      typeof element.settings.flex_direction === "string"
        ? element.settings.flex_direction
        : undefined;
    const layout =
      element.settings.converter_v3_layout &&
      typeof element.settings.converter_v3_layout === "object"
        ? (element.settings.converter_v3_layout as Record<string, unknown>)
        : undefined;
    const pattern =
      typeof layout?.pattern === "string"
        ? layout.pattern
        : undefined;
    const columns =
      typeof layout?.columns === "number"
        ? layout.columns
        : undefined;
    const looksInline =
      explicitDirection === "row" || pattern === "card-grid" || (columns ?? 0) > 1;

    if (
      buttonCount > 0 &&
      ((buttonCount === widgetTypes.length && (ctaSemanticCount > 0 || buttonCount === 1)) ||
        (buttonCount >= 1 && textWidgetCount <= 1))
    ) {
      const descriptor = {
        role: "section-cta",
        block: "secondary-cta",
        preset: getSectionBlockPreset("secondary-cta"),
        index,
        composition
      } satisfies Omit<SectionChildDescriptor, "phase">;

      return {
        ...descriptor,
        phase: getSectionPhaseForDescriptor(descriptor)
      };
    }

    const supportBlock = detectSupportBlock(element);

    if (
      isNarrativeSectionComposition(composition) &&
      !looksInline &&
      textWidgetCount >= 1 &&
      supportBlock !== "guarantee-strip"
    ) {
      const descriptor = {
        role: buttonCount > 0 ? "section-cta" : "section-support",
        block: "closing-stack",
        preset: "section-outro-stack",
        index,
        composition
      } satisfies Omit<SectionChildDescriptor, "phase">;

      return {
        ...descriptor,
        phase: getSectionPhaseForDescriptor(descriptor)
      };
    }

    if (
      supportSemanticCount > 0 ||
      (buttonCount === 0 && textWidgetCount >= 2) ||
      (buttonCount > 0 && ctaSemanticCount === 0 && textWidgetCount > 0)
    ) {
      const descriptor = {
        role: "section-support",
        block: supportBlock,
        preset: getSectionBlockPreset(supportBlock),
        index,
        composition
      } satisfies Omit<SectionChildDescriptor, "phase">;

      return {
        ...descriptor,
        phase: getSectionPhaseForDescriptor(descriptor)
      };
    }
  }

  const descriptor = {
    role: "section-body",
    block: "generic",
    preset: "generic",
    index,
    composition
  } satisfies Omit<SectionChildDescriptor, "phase">;

  return {
    ...descriptor,
    phase: getSectionPhaseForDescriptor(descriptor)
  };
}

export function describeSectionChildren(
  elements: ElementorElement[],
  composition: SectionComposition
) {
  const gridIndex = elements.findIndex(isPresetContainer);

  return new Map(
    elements.map((element, index) => [
      element.id,
      describeSectionChild(element, index, gridIndex, composition)
    ])
  );
}

export function getSectionStructureSummary(
  elements: ElementorElement[],
  composition: SectionComposition
): SectionStructureSummary {
  const descriptors = [...describeSectionChildren(elements, composition).values()]
    .sort((left, right) => left.index - right.index);
  const phases = descriptors
    .map((descriptor) => descriptor.phase)
    .filter((phase, index, values) => values.indexOf(phase) === index && phase !== "body");

  return {
    preset: getSectionStructurePreset(composition),
    signature: phases.length ? phases.join("-") : "body",
    phases
  };
}

export function getSectionSlotSummary(
  elements: ElementorElement[],
  composition: SectionComposition
): SectionSlotSummary {
  const descriptors = [...describeSectionChildren(elements, composition).values()]
    .sort((left, right) => left.index - right.index);
  const slots = descriptors
    .map((descriptor) => getSectionPresetSlot(descriptor, composition))
    .filter((slot, index, values) => values.indexOf(slot) === index);

  return {
    slots,
    signature: slots.join("-") || "section-body"
  };
}

function getSectionRegionForSlot(slot: SectionPresetSlot): SectionPresetRegion {
  switch (slot) {
    case "offer-intro":
    case "social-proof-intro":
    case "benefits-intro":
      return "intro";
    case "offer-grid":
    case "social-proof-grid":
    case "benefits-grid":
      return "main";
    case "offer-proof":
      return "proof";
    case "offer-guarantee":
    case "offer-support":
    case "social-proof-support":
    case "benefits-support":
      return "support";
    case "offer-closing-cta":
    case "social-proof-cta":
    case "benefits-cta":
    case "social-proof-outro":
    case "benefits-outro":
      return "closing";
    default:
      return "body";
  }
}

export function getSectionBlueprintSummary(
  elements: ElementorElement[],
  composition: SectionComposition
): SectionBlueprintSummary {
  const structure = getSectionStructureSummary(elements, composition);
  const slots = getSectionSlotSummary(elements, composition);
  const regions = slots.slots
    .map((slot) => getSectionRegionForSlot(slot))
    .filter((region, index, values) => values.indexOf(region) === index);
  const primarySlot = slots.slots.find((slot) => slot !== "section-body");
  const closingSlot = [...slots.slots]
    .reverse()
    .find((slot) => getSectionRegionForSlot(slot) === "closing");

  return {
    preset: structure.preset,
    slots: slots.slots,
    slotSignature: slots.signature,
    regions,
    regionSignature: regions.join("-") || "body",
    primarySlot,
    closingSlot
  };
}

export function getSectionEmitterStrategy(
  blueprint: SectionBlueprintSummary | undefined
): SectionEmitterStrategy {
  if (!blueprint || blueprint.preset === "generic-section") {
    return {
      name: "generic",
      regionSequence: ["body"]
    };
  }

  return {
    name:
      blueprint.preset === "commerce-offer-section"
        ? "commerce-offer"
        : blueprint.preset === "social-proof-section"
          ? "social-proof"
          : "benefits-showcase",
    primarySlot: blueprint.primarySlot,
    closingSlot: blueprint.closingSlot,
    regionSequence: blueprint.regions
  };
}

export function getSectionStrategyProfile(
  strategy: SectionEmitterStrategy | undefined
): SectionStrategyProfile {
  if (!strategy || strategy.name === "generic") {
    return {
      name: "generic",
      layoutModel: "generic",
      narrativeRegionMode: "generic",
      mainRegionMode: "generic"
    };
  }

  if (strategy.name === "commerce-offer") {
    return {
      name: strategy.name,
      layoutModel: "stacked-offer",
      rootGap: "32px",
      rootAlignItems: "center",
      narrativeRegionMode: "boxed-centered",
      mainRegionMode: "stretch-grid"
    };
  }

  if (strategy.name === "social-proof") {
    return {
      name: strategy.name,
      layoutModel: "stacked-social-proof",
      rootGap: "28px",
      rootAlignItems: "center",
      narrativeRegionMode: "boxed-centered",
      mainRegionMode: "stretch-grid"
    };
  }

  return {
    name: strategy.name,
    layoutModel: "stacked-benefits",
    rootGap: "28px",
    rootAlignItems: "center",
    narrativeRegionMode: "boxed-centered",
    mainRegionMode: "stretch-grid"
  };
}

export function getSectionStructureContainerDefaults(
  summary: SectionStructureSummary | undefined
): SectionStructureLayoutDefaults {
  if (!summary || summary.preset === "generic-section") {
    return {};
  }

  return {
    align_items: "center",
    layout:
      summary.preset === "commerce-offer-section"
        ? "commerce-narrative"
        : summary.preset === "social-proof-section"
          ? "social-proof-narrative"
          : "benefits-narrative"
  };
}

function getSectionStructureChildLayoutDefaults(
  summary: SectionStructureSummary | undefined,
  descriptor: Pick<SectionChildDescriptor, "role" | "block" | "phase">
): SectionStructureLayoutDefaults {
  if (!summary || summary.preset === "generic-section") {
    return {};
  }

  if (summary.preset === "commerce-offer-section") {
    if (descriptor.role === "section-header") {
      return {
        width: "100%",
        max_width: "720px",
        align_items: "center",
        layout: "offer-intro"
      };
    }

    if (descriptor.role === "section-grid") {
      return {
        width: "100%",
        max_width: "1200px",
        layout: "offer-grid"
      };
    }

    if (descriptor.block === "badge-row") {
      return {
        width: "100%",
        max_width: "960px",
        justify_content: "center",
        layout: "offer-proof-row"
      };
    }

    if (descriptor.block === "guarantee-strip") {
      return {
        width: "100%",
        max_width: "720px",
        align_items: "center",
        layout: "offer-guarantee"
      };
    }

    if (descriptor.role === "section-cta") {
      return {
        width: "100%",
        max_width: "520px",
        align_items: "center",
        layout: "offer-closing-cta"
      };
    }

    if (descriptor.role === "section-support") {
      return {
        width: "100%",
        max_width: "760px",
        layout: "offer-support"
      };
    }
  }

  if (summary.preset === "social-proof-section") {
    if (descriptor.role === "section-header") {
      return {
        width: "100%",
        max_width: "720px",
        align_items: "center",
        layout: "social-proof-intro"
      };
    }

    if (descriptor.role === "section-grid") {
      return {
        width: "100%",
        max_width: "1040px",
        layout: "social-proof-grid"
      };
    }

    if (descriptor.phase === "outro" || descriptor.role === "section-cta") {
      return {
        width: "100%",
        max_width: "680px",
        align_items: "center",
        layout: "social-proof-outro"
      };
    }
  }

  if (summary.preset === "benefits-showcase-section") {
    if (descriptor.role === "section-header") {
      return {
        width: "100%",
        max_width: "760px",
        align_items: "center",
        layout: "benefits-intro"
      };
    }

    if (descriptor.role === "section-grid") {
      return {
        width: "100%",
        max_width: "1180px",
        layout: "benefits-grid"
      };
    }

    if (descriptor.phase === "outro" || descriptor.role === "section-cta") {
      return {
        width: "100%",
        max_width: "720px",
        align_items: "center",
        layout: "benefits-outro"
      };
    }
  }

  return {};
}

function shouldCenterWidgetsForSectionStructure(
  summary: SectionStructureSummary | undefined,
  descriptor: Pick<SectionChildDescriptor, "role" | "block" | "phase">
) {
  if (!summary || summary.preset === "generic-section") {
    return false;
  }

  if (summary.preset === "commerce-offer-section") {
    return (
      descriptor.role === "section-header" ||
      descriptor.role === "section-cta" ||
      descriptor.block === "guarantee-strip"
    );
  }

  return (
    descriptor.role === "section-header" ||
    descriptor.phase === "outro" ||
    descriptor.role === "section-cta"
  );
}

function applySectionStructureWidgetDefaults(
  element: ElementorElement,
  summary: SectionStructureSummary | undefined,
  descriptor: SectionChildDescriptor
): ElementorElement {
  if (!shouldCenterWidgetsForSectionStructure(summary, descriptor)) {
    return element;
  }

  const visit = (current: ElementorElement): ElementorElement => {
    const elements = current.elements.map(visit);

    if (current.elType !== "widget") {
      return {
        ...current,
        elements
      };
    }

    const shouldCenter =
      current.widgetType === "heading" ||
      current.widgetType === "text-editor" ||
      current.widgetType === "blockquote" ||
      current.widgetType === "button";

    return {
      ...current,
      settings: {
        ...current.settings,
        ...(shouldCenter ? { align: "center" } : {})
      },
      elements
    };
  };

  return visit(element);
}

function getSectionRolePriority(role: SectionChildRole) {
  if (role === "section-header") {
    return 0;
  }

  if (role === "section-grid") {
    return 1;
  }

  if (role === "section-support") {
    return 2;
  }

  if (role === "section-cta") {
    return 3;
  }

  return 4;
}

function getSectionSlotPriority(slot: SectionPresetSlot) {
  switch (slot) {
    case "offer-intro":
    case "social-proof-intro":
    case "benefits-intro":
      return 0;
    case "offer-grid":
    case "social-proof-grid":
    case "benefits-grid":
      return 1;
    case "offer-proof":
      return 2;
    case "offer-guarantee":
      return 3;
    case "offer-support":
    case "social-proof-support":
    case "benefits-support":
      return 4;
    case "offer-closing-cta":
    case "social-proof-cta":
    case "benefits-cta":
    case "social-proof-outro":
    case "benefits-outro":
      return 5;
    default:
      return 100;
  }
}

function getSectionRegionPriority(region: SectionPresetRegion) {
  switch (region) {
    case "intro":
      return 0;
    case "main":
      return 1;
    case "proof":
      return 2;
    case "support":
      return 3;
    case "closing":
      return 4;
    default:
      return 100;
  }
}

function getSectionRegionContainerDefaults(
  strategy: SectionEmitterStrategy,
  region: SectionPresetRegion
): SectionRegionContainerDefaults {
  if (strategy.name === "generic") {
    return {
      mode: "generic"
    };
  }

  if (region === "main") {
    return {
      align_self: "stretch",
      mode: "stretch-grid"
    };
  }

  if (
    region === "intro" ||
    region === "closing" ||
    region === "proof" ||
    region === "support"
  ) {
    return {
      align_self: "center",
      mode: "boxed-centered"
    };
  }

  return {
    mode: "generic"
  };
}

function getSectionChildLayoutDefaults(
  descriptor: Pick<SectionChildDescriptor, "role" | "block" | "preset">,
  composition: SectionComposition
) {
  if (descriptor.role === "section-header") {
    return {
      flex_direction: "column",
      justify_content: "flex-start",
      align_items: "flex-start",
      gap: descriptor.preset === "section-intro-stack"
        ? composition === "feature-section"
          ? "14px"
          : "16px"
        : composition === "pricing-section"
          ? "12px"
          : "14px"
    };
  }

  if (descriptor.role === "section-support" && descriptor.block === "guarantee-strip") {
    return {
      flex_direction: "column",
      justify_content: "flex-start",
      align_items: "flex-start",
      gap: "10px"
    };
  }

  if (descriptor.role === "section-support" && descriptor.preset === "section-outro-stack") {
    return {
      flex_direction: "column",
      justify_content: "flex-start",
      align_items: "flex-start",
      gap: "12px"
    };
  }

  if (descriptor.role === "section-support" && descriptor.block === "badge-row") {
    return {
      flex_direction: "row",
      justify_content: "flex-start",
      align_items: "center",
      gap: "12px"
    };
  }

  if (descriptor.role === "section-support") {
    return {
      flex_direction: "row",
      justify_content: "flex-start",
      align_items: "center",
      gap: "12px"
    };
  }

  if (descriptor.role === "section-cta") {
    return {
      flex_direction: "column",
      justify_content: "flex-start",
      align_items: "flex-start",
      gap:
        descriptor.preset === "section-outro-stack"
          ? "12px"
          : descriptor.block === "secondary-cta"
            ? "10px"
            : undefined
    };
  }

  return {};
}

function getSectionBlockResponsiveDefaults(
  descriptor: Pick<SectionChildDescriptor, "preset">
) {
  const profile = getSectionBlockResponsiveProfile(descriptor);

  return {
    flex_wrap: profile.desktop?.flex_wrap,
    tablet_flex_direction: profile.tablet?.flex_direction,
    tablet_flex_wrap: profile.tablet?.flex_wrap,
    tablet_align_items: profile.tablet?.align_items,
    tablet_gap: profile.tablet?.gap,
    mobile_flex_direction: profile.mobile?.flex_direction,
    mobile_align_items: profile.mobile?.align_items,
    mobile_gap: profile.mobile?.gap
  };
}

function shouldForceSectionBlockPreset(
  descriptor: Pick<SectionChildDescriptor, "preset">
) {
  return descriptor.preset !== "generic" && descriptor.preset !== "primary-grid";
}

export function applySectionCompositionSettings(
  elements: ElementorElement[],
  composition: SectionComposition
) {
  const descriptors = describeSectionChildren(elements, composition);
  const structureSummary = getSectionStructureSummary(elements, composition);
  const sectionBlueprint = getSectionBlueprintSummary(elements, composition);
  const sectionStrategy = getSectionEmitterStrategy(sectionBlueprint);

  return [...elements]
    .map((element, index) => ({
      element,
      descriptor:
        descriptors.get(element.id) ??
        ({
          role: "section-body",
          block: "generic",
          preset: "generic",
          phase: "body",
          index,
          composition
        } satisfies SectionChildDescriptor),
      priority: getPresetPriority(element),
      index
    }))
    .sort((left, right) => {
      const leftRolePriority = getSectionRolePriority(left.descriptor.role);
      const rightRolePriority = getSectionRolePriority(right.descriptor.role);

      if (leftRolePriority !== rightRolePriority) {
        return leftRolePriority - rightRolePriority;
      }

      const leftSlotPriority = getSectionSlotPriority(
        getSectionPresetSlot(left.descriptor, composition)
      );
      const rightSlotPriority = getSectionSlotPriority(
        getSectionPresetSlot(right.descriptor, composition)
      );

      if (leftSlotPriority !== rightSlotPriority) {
        return leftSlotPriority - rightSlotPriority;
      }

      const leftRegionPriority = getSectionRegionPriority(
        getSectionRegionForSlot(getSectionPresetSlot(left.descriptor, composition))
      );
      const rightRegionPriority = getSectionRegionPriority(
        getSectionRegionForSlot(getSectionPresetSlot(right.descriptor, composition))
      );

      if (leftRegionPriority !== rightRegionPriority) {
        return leftRegionPriority - rightRegionPriority;
      }

      if (left.priority !== right.priority) {
        return left.priority - right.priority;
      }

      return left.index - right.index;
    })
    .map((entry) => {
      const sectionSlot = getSectionPresetSlot(entry.descriptor, composition);
      const sectionRegion = getSectionRegionForSlot(sectionSlot);
      const regionDefaults = getSectionRegionContainerDefaults(
        sectionStrategy,
        sectionRegion
      );
      const defaults = getSectionChildLayoutDefaults(entry.descriptor, composition);
      const structureDefaults = getSectionStructureChildLayoutDefaults(
        structureSummary,
        entry.descriptor
      );
      const responsiveDefaults = getSectionBlockResponsiveDefaults(entry.descriptor);
      const responsiveProfile = getSectionBlockResponsiveProfile(entry.descriptor);
      const forcePresetDefaults = shouldForceSectionBlockPreset(entry.descriptor);
      const elementWithBlockSemantics = applySectionBlockWidgetSemantics(
        entry.element,
        entry.descriptor
      );
      const elementWithStructureSemantics = applySectionStructureWidgetDefaults(
        elementWithBlockSemantics,
        structureSummary,
        entry.descriptor
      );

      return {
        ...elementWithStructureSemantics,
        settings: {
          ...elementWithStructureSemantics.settings,
          ...(elementWithStructureSemantics.elType === "container"
            ? {
                flex_direction:
                  forcePresetDefaults && defaults.flex_direction
                    ? defaults.flex_direction
                    : elementWithStructureSemantics.settings.flex_direction ?? defaults.flex_direction,
                justify_content:
                  structureDefaults.justify_content ??
                  (forcePresetDefaults && defaults.justify_content
                    ? defaults.justify_content
                    : elementWithStructureSemantics.settings.justify_content ?? defaults.justify_content),
                align_items:
                  structureDefaults.align_items ??
                  (forcePresetDefaults && defaults.align_items
                    ? defaults.align_items
                    : elementWithStructureSemantics.settings.align_items ?? defaults.align_items),
                gap:
                  structureDefaults.gap ??
                  (forcePresetDefaults && defaults.gap
                    ? defaults.gap
                    : elementWithStructureSemantics.settings.gap ?? defaults.gap),
                width:
                  structureDefaults.width ??
                  elementWithStructureSemantics.settings.width,
                max_width:
                  structureDefaults.max_width ??
                  elementWithStructureSemantics.settings.max_width,
                content_width:
                  structureDefaults.max_width
                    ? "boxed"
                    : elementWithStructureSemantics.settings.content_width,
                boxed_width:
                  structureDefaults.max_width ??
                  elementWithStructureSemantics.settings.boxed_width,
                align_self:
                  regionDefaults.align_self ??
                  elementWithStructureSemantics.settings.align_self,
                tablet_max_width:
                  structureDefaults.tablet_max_width ??
                  elementWithStructureSemantics.settings.tablet_max_width,
                mobile_max_width:
                  structureDefaults.mobile_max_width ??
                  elementWithStructureSemantics.settings.mobile_max_width,
                flex_wrap:
                  forcePresetDefaults && responsiveDefaults.flex_wrap
                    ? responsiveDefaults.flex_wrap
                    : elementWithStructureSemantics.settings.flex_wrap ?? responsiveDefaults.flex_wrap,
                tablet_flex_direction:
                  forcePresetDefaults && responsiveDefaults.tablet_flex_direction
                    ? responsiveDefaults.tablet_flex_direction
                    : elementWithStructureSemantics.settings.tablet_flex_direction ??
                      responsiveDefaults.tablet_flex_direction,
                tablet_flex_wrap:
                  forcePresetDefaults && responsiveDefaults.tablet_flex_wrap
                    ? responsiveDefaults.tablet_flex_wrap
                    : elementWithStructureSemantics.settings.tablet_flex_wrap ??
                      responsiveDefaults.tablet_flex_wrap,
                tablet_align_items:
                  forcePresetDefaults && responsiveDefaults.tablet_align_items
                    ? responsiveDefaults.tablet_align_items
                    : elementWithStructureSemantics.settings.tablet_align_items ??
                      responsiveDefaults.tablet_align_items,
                tablet_gap:
                  forcePresetDefaults && responsiveDefaults.tablet_gap
                    ? responsiveDefaults.tablet_gap
                    : elementWithStructureSemantics.settings.tablet_gap ??
                      responsiveDefaults.tablet_gap,
                mobile_flex_direction:
                  forcePresetDefaults && responsiveDefaults.mobile_flex_direction
                    ? responsiveDefaults.mobile_flex_direction
                    : elementWithStructureSemantics.settings.mobile_flex_direction ??
                      responsiveDefaults.mobile_flex_direction,
                mobile_align_items:
                  forcePresetDefaults && responsiveDefaults.mobile_align_items
                    ? responsiveDefaults.mobile_align_items
                    : elementWithStructureSemantics.settings.mobile_align_items ??
                      responsiveDefaults.mobile_align_items,
                mobile_gap:
                  forcePresetDefaults && responsiveDefaults.mobile_gap
                    ? responsiveDefaults.mobile_gap
                    : elementWithStructureSemantics.settings.mobile_gap ??
                      responsiveDefaults.mobile_gap,
                converter_v3_section_preset_layout: structureDefaults.layout
              }
            : {}),
          converter_v3_section_role: entry.descriptor.role,
          converter_v3_section_block: entry.descriptor.block,
          converter_v3_section_block_preset: entry.descriptor.preset,
          converter_v3_section_block_micro_layout: getSectionBlockMicroLayout(entry.descriptor),
          converter_v3_section_block_responsive: responsiveProfile,
          converter_v3_section_slot: sectionSlot,
          converter_v3_section_slot_order: getSectionSlotPriority(sectionSlot),
          converter_v3_section_region: sectionRegion,
          converter_v3_section_region_order: getSectionRegionPriority(sectionRegion),
          converter_v3_section_region_mode: regionDefaults.mode,
          converter_v3_section_strategy: sectionStrategy.name,
          converter_v3_section_phase: entry.descriptor.phase,
          converter_v3_section_index: entry.descriptor.index,
          converter_v3_section_composition: composition,
          converter_v3_layout:
            elementWithStructureSemantics.settings.converter_v3_layout &&
            typeof elementWithStructureSemantics.settings.converter_v3_layout === "object"
              ? {
                  ...(elementWithStructureSemantics.settings.converter_v3_layout as Record<string, unknown>),
                  sectionRole: entry.descriptor.role,
                  sectionBlock: entry.descriptor.block,
                  sectionBlockPreset: entry.descriptor.preset,
                  sectionBlockMicroLayout: getSectionBlockMicroLayout(entry.descriptor),
                  sectionBlockResponsive: responsiveProfile,
                  sectionSlot,
                  sectionRegion,
                  sectionRegionMode: regionDefaults.mode,
                  sectionStrategy: sectionStrategy.name,
                  sectionPhase: entry.descriptor.phase,
                  sectionPresetLayout: structureDefaults.layout
                }
              : elementWithStructureSemantics.settings.converter_v3_layout
        }
      };
    });
}

export function sortElementsForSectionComposition(elements: ElementorElement[]) {
  return applySectionCompositionSettings(
    elements,
    detectSectionComposition(elements)
  );
}
