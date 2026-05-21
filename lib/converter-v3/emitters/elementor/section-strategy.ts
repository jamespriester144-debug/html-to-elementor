import type {
  SectionEmitterStrategy,
  SectionPresetRegion,
  SectionStrategyProfile
} from "@/lib/converter-v3/emitters/elementor/section-layout";
import type { ElementorElement } from "@/types/conversion";

export type SectionRegionShell = {
  region: SectionPresetRegion;
  regionOrder: number;
  mode: "generic" | "boxed-centered" | "stretch-grid";
  gap?: string;
  width: string;
  maxWidth?: string;
  boxedWidth?: string;
  alignItems: "center" | "stretch";
  justifyContent: "flex-start";
  childIds: string[];
  childRoles: string[];
  childSlots: string[];
  elements: ElementorElement[];
};

type BuildSectionStrategyElementsParams = {
  children: ElementorElement[];
  strategy: SectionEmitterStrategy | undefined;
  strategyProfile: SectionStrategyProfile | undefined;
  createId: (prefix: string, order: number) => string;
};

function getStringSetting(element: ElementorElement, key: string) {
  const value = element.settings[key];
  return typeof value === "string" ? value : undefined;
}

function parsePixelWidth(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  const numeric = Number.parseFloat(value);

  return Number.isFinite(numeric) ? numeric : undefined;
}

function formatPixelWidth(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value)
    ? `${Math.round(value)}px`
    : undefined;
}

function getShellGap(strategyName: SectionEmitterStrategy["name"], region: SectionPresetRegion) {
  if (strategyName !== "commerce-offer") {
    return undefined;
  }

  switch (region) {
    case "intro":
      return "18px";
    case "main":
      return "20px";
    case "proof":
      return "12px";
    case "support":
      return "14px";
    case "closing":
      return "12px";
    default:
      return undefined;
  }
}

function getRegionMode(
  children: ElementorElement[],
  region: SectionPresetRegion
): "generic" | "boxed-centered" | "stretch-grid" {
  const explicitMode = children
    .map((child) => getStringSetting(child, "converter_v3_section_region_mode"))
    .find(
      (
        value
      ): value is "generic" | "boxed-centered" | "stretch-grid" =>
        value === "generic" || value === "boxed-centered" || value === "stretch-grid"
    );

  if (explicitMode) {
    return explicitMode;
  }

  return region === "main" ? "stretch-grid" : "boxed-centered";
}

function getRegionWidthSettings(children: ElementorElement[]) {
  const widths = children
    .flatMap((child) => [
      getStringSetting(child, "boxed_width"),
      getStringSetting(child, "max_width")
    ])
    .map((value) => ({ raw: value, numeric: parsePixelWidth(value) }))
    .filter((entry): entry is { raw: string; numeric: number } => Boolean(entry.raw) && typeof entry.numeric === "number");

  if (!widths.length) {
    return {};
  }

  const widest = widths.reduce((left, right) => (right.numeric > left.numeric ? right : left));

  return {
    maxWidth: formatPixelWidth(widest.numeric),
    boxedWidth: formatPixelWidth(widest.numeric)
  };
}

function buildRegionShells(
  children: ElementorElement[],
  strategy: SectionEmitterStrategy
): SectionRegionShell[] {
  const supportedRegions =
    strategy.name === "commerce-offer"
      ? strategy.regionSequence.filter((region) => region !== "body")
      : [];

  if (!supportedRegions.length) {
    return [];
  }

  const groupedRegions: SectionRegionShell[] = [];

  supportedRegions.forEach((region, regionOrder) => {
    const regionChildren = children.filter(
      (child) => getStringSetting(child, "converter_v3_section_region") === region
    );

    if (!regionChildren.length) {
      return;
    }

    const mode = getRegionMode(regionChildren, region);
    const widthSettings = getRegionWidthSettings(regionChildren);

    groupedRegions.push({
      region,
      regionOrder,
      mode,
      gap: getShellGap(strategy.name, region),
      width: "100%",
      maxWidth: widthSettings.maxWidth,
      boxedWidth: widthSettings.boxedWidth,
      alignItems: mode === "stretch-grid" ? "stretch" : "center",
      justifyContent: "flex-start",
      childIds: regionChildren
        .map((child) => getStringSetting(child, "converter_v3_source_node_id"))
        .filter((value): value is string => Boolean(value)),
      childRoles: regionChildren
        .map((child) => getStringSetting(child, "converter_v3_section_role"))
        .filter((value): value is string => Boolean(value)),
      childSlots: regionChildren
        .map((child) => getStringSetting(child, "converter_v3_section_slot"))
        .filter((value): value is string => Boolean(value)),
      elements: regionChildren
    });
  });

  if (groupedRegions.length === children.length) {
    return groupedRegions;
  }

  const groupedIds = new Set(groupedRegions.flatMap((shell) => shell.childIds));
  const leftovers = children.filter((child) => {
    const childId = getStringSetting(child, "converter_v3_source_node_id");
    return childId ? !groupedIds.has(childId) : true;
  });

  if (!leftovers.length) {
    return groupedRegions;
  }

  const leftoverWidthSettings = getRegionWidthSettings(leftovers);

  return [
    ...groupedRegions,
    {
      region: "body",
      regionOrder: groupedRegions.length,
      mode: "generic",
      gap: undefined,
      width: "100%",
      maxWidth: leftoverWidthSettings.maxWidth,
      boxedWidth: leftoverWidthSettings.boxedWidth,
      alignItems: "stretch",
      justifyContent: "flex-start",
      childIds: leftovers
        .map((child) => getStringSetting(child, "converter_v3_source_node_id"))
        .filter((value): value is string => Boolean(value)),
      childRoles: leftovers
        .map((child) => getStringSetting(child, "converter_v3_section_role"))
        .filter((value): value is string => Boolean(value)),
      childSlots: leftovers
        .map((child) => getStringSetting(child, "converter_v3_section_slot"))
        .filter((value): value is string => Boolean(value)),
      elements: leftovers
    }
  ];
}

export function buildSectionStrategyElements({
  children,
  strategy,
  strategyProfile,
  createId
}: BuildSectionStrategyElementsParams) {
  if (!strategy || strategy.name === "generic") {
    return {
      elements: children,
      applied: false,
      shells: [] as SectionRegionShell[]
    };
  }

  const shells = buildRegionShells(children, strategy);

  if (!shells.length) {
    return {
      elements: children,
      applied: false,
      shells
    };
  }

  return {
    applied: true,
    shells,
    elements: shells.map((shell) => ({
      id: createId("section-region", shell.regionOrder),
      elType: "container" as const,
      settings: {
        content_width: shell.boxedWidth ? "boxed" : "full",
        width: shell.width,
        max_width: shell.maxWidth,
        boxed_width: shell.boxedWidth,
        flex_direction: "column",
        justify_content: shell.justifyContent,
        align_items: shell.alignItems,
        gap: shell.gap,
        converter_v3_section_region_shell: true,
        converter_v3_section_region: shell.region,
        converter_v3_section_region_order: shell.regionOrder,
        converter_v3_section_region_mode: shell.mode,
        converter_v3_section_strategy: strategy.name,
        converter_v3_section_strategy_profile: strategyProfile,
        converter_v3_section_region_children: shell.childIds,
        converter_v3_section_region_child_roles: shell.childRoles,
        converter_v3_section_region_child_slots: shell.childSlots,
        converter_v3_layout: {
          sectionRegionShell: true,
          sectionRegion: shell.region,
          sectionRegionMode: shell.mode,
          sectionStrategy: strategy.name,
          sectionStrategyProfile: strategyProfile,
          sectionRegionChildIds: shell.childIds,
          sectionRegionChildRoles: shell.childRoles,
          sectionRegionChildSlots: shell.childSlots
        }
      },
      elements: shell.elements
    }))
  };
}
