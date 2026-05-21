import type { ElementorElement } from "@/types/conversion";

type PresetLayoutContext = {
  preset?: string;
  role?: string;
};

const SEMANTIC_PRIORITY: Record<string, number> = {
  "pricing-media": 0,
  "pricing-title": 1,
  price: 2,
  "pricing-support": 3,
  "pricing-cta": 4,
  "testimonial-media": 0,
  "testimonial-rating": 1,
  "testimonial-quote": 2,
  "testimonial-attribution": 3,
  "testimonial-support": 4,
  "testimonial-cta": 5,
  "feature-media": 0,
  "feature-eyebrow": 1,
  "feature-title": 2,
  "feature-support": 3,
  "feature-cta": 4
};

export function getPresetContainerLayoutDefaults(context: PresetLayoutContext) {
  if (context.role === "pricing-card") {
    return {
      flex_direction: "column",
      justify_content: "space-between",
      align_items: "stretch",
      gap: "12px"
    };
  }

  if (context.role === "testimonial-card") {
    return {
      flex_direction: "column",
      justify_content: "flex-start",
      align_items: "stretch",
      gap: "14px"
    };
  }

  if (context.role === "feature-card") {
    return {
      flex_direction: "column",
      justify_content: "flex-start",
      align_items: "stretch",
      gap: "14px"
    };
  }

  if (
    context.preset === "pricing-cards" ||
    context.preset === "testimonial-cards" ||
    context.preset === "feature-cards"
  ) {
    return {
      justify_content: "flex-start",
      align_items: "stretch"
    };
  }

  return {};
}

function getElementPriority(element: ElementorElement, index: number) {
  const semantic =
    typeof element.settings.converter_v3_widget_semantic === "string"
      ? element.settings.converter_v3_widget_semantic
      : undefined;
  const semanticPriority = semantic ? SEMANTIC_PRIORITY[semantic] : undefined;
  const presetIndex =
    typeof element.settings.converter_v3_preset_index === "number"
      ? element.settings.converter_v3_preset_index
      : undefined;
  const patternIndex =
    typeof element.settings.converter_v3_pattern_index === "number"
      ? element.settings.converter_v3_pattern_index
      : undefined;

  return {
    primary: semanticPriority ?? 1000,
    secondary: presetIndex ?? patternIndex ?? index,
    fallback: index
  };
}

export function sortElementsForPresetLayout(elements: ElementorElement[]) {
  return [...elements]
    .map((element, index) => ({
      element,
      priority: getElementPriority(element, index)
    }))
    .sort((left, right) => {
      if (left.priority.primary !== right.priority.primary) {
        return left.priority.primary - right.priority.primary;
      }

      if (left.priority.secondary !== right.priority.secondary) {
        return left.priority.secondary - right.priority.secondary;
      }

      return left.priority.fallback - right.priority.fallback;
    })
    .map((entry) => entry.element);
}
