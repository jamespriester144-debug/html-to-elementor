import { JSDOM } from "jsdom";

import type {
  CapturedNode,
  PageCapture,
  ThemeAnalysis,
  ThemeColorSample,
  ThemeColorSampleRole,
  ThemeDesignTokens,
  ThemeMode,
  ThemeStyleSignals
} from "@/lib/converter-v3/contracts/capture";
import type { LayoutDocument, LayoutNode, OutputMode } from "@/lib/converter-v3/contracts/layout";
import type { ThemeAuditIssue, ThemeAuditReport } from "@/lib/converter-v3/contracts/output";

type RgbaColor = {
  r: number;
  g: number;
  b: number;
  a: number;
};

type ThemeDescriptor = {
  role: ThemeColorSampleRole;
  nodeId?: string;
  tag?: string;
  backgroundColor?: string;
  textColor?: string;
  borderColor?: string;
  borderRadius?: string;
  boxShadow?: string;
  fontFamily?: string;
  fontSize?: string;
  weight: number;
};

type ThemeInspection = {
  analysis: ThemeAnalysis;
  descriptors: ThemeDescriptor[];
};

const THEME_CUSTOM_PROPERTY_MAP = {
  globalBackground: ["--background"],
  foreground: ["--foreground"],
  cardBackground: ["--card"],
  borderColor: ["--border"],
  accentColor: ["--accent", "--primary"],
  mutedColor: ["--muted", "--secondary"]
} as const;

const GLOBAL_BACKGROUND_MISMATCH_DISTANCE = 55;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function parsePx(value?: string) {
  const normalized = (value ?? "").trim().toLowerCase();

  if (!normalized || normalized === "auto") {
    return undefined;
  }

  const match = normalized.match(/^(-?\d+(?:\.\d+)?)px$/);

  if (match) {
    return Number.parseFloat(match[1]);
  }

  const numeric = Number.parseFloat(normalized);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function parsePercentChannel(value: string) {
  const normalized = value.trim();

  if (normalized.endsWith("%")) {
    return clamp((Number.parseFloat(normalized) / 100) * 255, 0, 255);
  }

  return clamp(Number.parseFloat(normalized), 0, 255);
}

function splitFunctionalColorArgs(value: string) {
  return value
    .replace(/\s*\/\s*/g, ",")
    .replace(/\s*,\s*/g, ",")
    .trim()
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function hueToRgb(p: number, q: number, t: number) {
  let nextT = t;

  if (nextT < 0) nextT += 1;
  if (nextT > 1) nextT -= 1;
  if (nextT < 1 / 6) return p + (q - p) * 6 * nextT;
  if (nextT < 1 / 2) return q;
  if (nextT < 2 / 3) return p + (q - p) * (2 / 3 - nextT) * 6;
  return p;
}

function hslToRgb(h: number, s: number, l: number) {
  const hue = (((h % 360) + 360) % 360) / 360;
  const saturation = clamp(s, 0, 100) / 100;
  const lightness = clamp(l, 0, 100) / 100;

  if (saturation === 0) {
    const value = Math.round(lightness * 255);
    return { r: value, g: value, b: value };
  }

  const q =
    lightness < 0.5
      ? lightness * (1 + saturation)
      : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;

  return {
    r: Math.round(hueToRgb(p, q, hue + 1 / 3) * 255),
    g: Math.round(hueToRgb(p, q, hue) * 255),
    b: Math.round(hueToRgb(p, q, hue - 1 / 3) * 255)
  };
}

function parseThemeTokenColor(value?: string): RgbaColor | undefined {
  const normalized = (value ?? "").trim();

  if (!normalized) {
    return undefined;
  }

  if (/^\d+(?:\.\d+)?\s+\d+(?:\.\d+)?%\s+\d+(?:\.\d+)?%(?:\s*\/\s*\d+(?:\.\d+)?)?$/i.test(normalized)) {
    return parseColor(`hsl(${normalized})`);
  }

  return parseColor(normalized);
}

function parseColor(value?: string): RgbaColor | undefined {
  const normalized = (value ?? "").trim().toLowerCase();

  if (!normalized || normalized === "transparent" || normalized === "none") {
    return undefined;
  }

  if (normalized.startsWith("#")) {
    const hex = normalized.slice(1);

    if (hex.length === 3 || hex.length === 4) {
      const [r, g, b, a = "f"] = hex.split("");
      return {
        r: Number.parseInt(`${r}${r}`, 16),
        g: Number.parseInt(`${g}${g}`, 16),
        b: Number.parseInt(`${b}${b}`, 16),
        a: Number.parseInt(`${a}${a}`, 16) / 255
      };
    }

    if (hex.length === 6 || hex.length === 8) {
      return {
        r: Number.parseInt(hex.slice(0, 2), 16),
        g: Number.parseInt(hex.slice(2, 4), 16),
        b: Number.parseInt(hex.slice(4, 6), 16),
        a: hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1
      };
    }
  }

  const rgbMatch = normalized.match(/^rgba?\((.+)\)$/i);

  if (rgbMatch) {
    const parts = splitFunctionalColorArgs(rgbMatch[1]);

    if (parts.length >= 3) {
      return {
        r: Math.round(parsePercentChannel(parts[0])),
        g: Math.round(parsePercentChannel(parts[1])),
        b: Math.round(parsePercentChannel(parts[2])),
        a: parts[3] !== undefined ? clamp(Number.parseFloat(parts[3]), 0, 1) : 1
      };
    }
  }

  const hslMatch = normalized.match(/^hsla?\((.+)\)$/i);

  if (hslMatch) {
    const parts = splitFunctionalColorArgs(hslMatch[1]);

    if (parts.length >= 3) {
      const hue = Number.parseFloat(parts[0]);
      const saturation = Number.parseFloat(parts[1]);
      const lightness = Number.parseFloat(parts[2]);
      const rgb = hslToRgb(hue, saturation, lightness);

      return {
        ...rgb,
        a: parts[3] !== undefined ? clamp(Number.parseFloat(parts[3]), 0, 1) : 1
      };
    }
  }

  return undefined;
}

function toCssColor(color: RgbaColor) {
  return color.a < 1
    ? `rgba(${color.r}, ${color.g}, ${color.b}, ${Number.parseFloat(color.a.toFixed(3))})`
    : `rgb(${color.r}, ${color.g}, ${color.b})`;
}

function isMeaningfulColorValue(value?: string) {
  const parsed = parseColor(value);
  return Boolean(parsed && parsed.a > 0.03);
}

function relativeLuminance(color: RgbaColor) {
  const channels = [color.r, color.g, color.b].map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(background: RgbaColor, foreground: RgbaColor) {
  const left = relativeLuminance(background);
  const right = relativeLuminance(foreground);
  const lighter = Math.max(left, right);
  const darker = Math.min(left, right);

  return (lighter + 0.05) / (darker + 0.05);
}

function colorSaturation(color: RgbaColor) {
  const max = Math.max(color.r, color.g, color.b);
  const min = Math.min(color.r, color.g, color.b);
  return max - min;
}

function isClearlyLightColor(value?: string) {
  const parsed = parseColor(value);
  return Boolean(parsed && relativeLuminance(parsed) >= 0.72);
}

function isClearlyDarkColor(value?: string) {
  const parsed = parseColor(value);
  return Boolean(parsed && relativeLuminance(parsed) <= 0.32);
}

function colorDistance(left?: string, right?: string) {
  const source = parseColor(left);
  const converted = parseColor(right);

  if (!source || !converted) {
    return undefined;
  }

  return Math.sqrt(
    (source.r - converted.r) ** 2 +
      (source.g - converted.g) ** 2 +
      (source.b - converted.b) ** 2
  );
}

function normalizeFontFamily(value?: string) {
  const normalized = (value ?? "").trim();

  if (!normalized) {
    return undefined;
  }

  return normalized.split(",")[0]?.replace(/^['"]|['"]$/g, "").trim() || normalized;
}

function hasMeaningfulShadow(value?: string) {
  const normalized = (value ?? "").trim().toLowerCase();
  return Boolean(normalized && normalized !== "none");
}

function hasRoundedCorners(value?: string, minimum = 8) {
  const radius = parsePx(value);
  return typeof radius === "number" && radius >= minimum;
}

function hasSurfaceTreatment(descriptor: ThemeDescriptor) {
  return (
    isMeaningfulColorValue(descriptor.backgroundColor) ||
    hasRoundedCorners(descriptor.borderRadius) ||
    hasMeaningfulShadow(descriptor.boxShadow) ||
    isMeaningfulColorValue(descriptor.borderColor)
  );
}

function isRoleMatch(descriptor: ThemeDescriptor, roles: ThemeColorSampleRole[]) {
  return roles.includes(descriptor.role);
}

function pushWeightedValue(
  store: Map<string, number>,
  value: string | undefined,
  weight: number
) {
  if (!value) {
    return;
  }

  store.set(value, (store.get(value) ?? 0) + weight);
}

function pickWeightedValue(store: Map<string, number>) {
  return [...store.entries()].sort((left, right) => right[1] - left[1])[0]?.[0];
}

function pickWeightedColor(
  descriptors: ThemeDescriptor[],
  selector: (descriptor: ThemeDescriptor) => string | undefined
) {
  const weights = new Map<string, number>();

  descriptors.forEach((descriptor) => {
    const value = selector(descriptor);

    if (!isMeaningfulColorValue(value)) {
      return;
    }

    const parsed = parseColor(value);

    if (!parsed || parsed.a <= 0.03) {
      return;
    }

    pushWeightedValue(weights, toCssColor(parsed), descriptor.weight);
  });

  return pickWeightedValue(weights);
}

function pickTopDistinctColors(
  descriptors: ThemeDescriptor[],
  selector: (descriptor: ThemeDescriptor) => string | undefined
) {
  const weights = new Map<string, number>();

  descriptors.forEach((descriptor) => {
    const value = selector(descriptor);

    if (!isMeaningfulColorValue(value)) {
      return;
    }

    const parsed = parseColor(value);

    if (!parsed || parsed.a <= 0.03) {
      return;
    }

    pushWeightedValue(weights, toCssColor(parsed), descriptor.weight);
  });

  return [...weights.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([value]) => value);
}

function pickDominantSize(
  descriptors: ThemeDescriptor[],
  selector: (descriptor: ThemeDescriptor) => string | undefined
) {
  const weights = new Map<string, number>();

  descriptors.forEach((descriptor) => {
    const value = selector(descriptor);

    if (value) {
      pushWeightedValue(weights, value, descriptor.weight);
    }
  });

  return pickWeightedValue(weights);
}

function pickAccentColor(descriptors: ThemeDescriptor[], fallback?: string) {
  const candidates = descriptors
    .flatMap((descriptor) => [
      descriptor.backgroundColor,
      descriptor.borderColor,
      descriptor.textColor
    ])
    .map((value) => value && parseColor(value))
    .filter((value): value is RgbaColor => Boolean(value && value.a > 0.03))
    .sort((left, right) => colorSaturation(right) - colorSaturation(left));

  if (candidates.length === 0) {
    return fallback;
  }

  return toCssColor(candidates[0]);
}

function extractTokenFromCustomProperties(
  nodes: Array<{ computedStyles: Record<string, string> }>,
  keys: readonly string[]
) {
  for (const node of nodes) {
    for (const key of keys) {
      const value = node.computedStyles[key];
      const parsed = parseThemeTokenColor(value);

      if (parsed && parsed.a > 0.03) {
        return toCssColor(parsed);
      }
    }
  }

  return undefined;
}

function extractAverageSectionSpacing(layout: LayoutDocument) {
  const nodeById = new Map(layout.nodes.map((node) => [node.id, node]));
  const sections = (layout.detectedSections.length > 0
    ? layout.detectedSections.map((section) => nodeById.get(section.id))
    : layout.sectionIds.map((sectionId) => nodeById.get(sectionId)))
    .filter((node): node is LayoutNode => Boolean(node))
    .sort((left, right) => left.box.y - right.box.y);
  const gaps = sections
    .slice(1)
    .map((section, index) => section.box.y - (sections[index]?.box.y ?? 0) - (sections[index]?.box.height ?? 0))
    .filter((gap) => gap > 0);

  if (gaps.length === 0) {
    return undefined;
  }

  return Number.parseFloat((gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length).toFixed(2));
}

function finalizeThemeAnalysis(params: {
  descriptors: ThemeDescriptor[];
  layout?: LayoutDocument;
  tokenOverrides?: Partial<ThemeDesignTokens>;
}) {
  const roleCounts = {
    cards: params.descriptors.filter((descriptor) => descriptor.role === "card").length,
    buttons: params.descriptors.filter(
      (descriptor) => descriptor.role === "button" || descriptor.role === "cta"
    ).length,
    inputs: params.descriptors.filter((descriptor) => descriptor.role === "input").length,
    headers: params.descriptors.filter((descriptor) => descriptor.role === "header").length,
    footers: params.descriptors.filter((descriptor) => descriptor.role === "footer").length,
    sections: params.descriptors.filter(
      (descriptor) =>
        descriptor.role === "section" ||
        descriptor.role === "main" ||
        descriptor.role === "body" ||
        descriptor.role === "page"
    ).length
  };
  const pageDescriptors = params.descriptors.filter((descriptor) =>
    isRoleMatch(descriptor, ["body", "page", "main", "section", "header", "footer"])
  );
  const textDescriptors = params.descriptors.filter((descriptor) => Boolean(descriptor.textColor));
  const cardDescriptors = params.descriptors.filter((descriptor) => descriptor.role === "card");
  const buttonDescriptors = params.descriptors.filter((descriptor) =>
    isRoleMatch(descriptor, ["button", "cta"])
  );
  const inputDescriptors = params.descriptors.filter((descriptor) => descriptor.role === "input");
  const borderDescriptors = params.descriptors.filter(
    (descriptor) =>
      descriptor.role === "card" ||
      descriptor.role === "button" ||
      descriptor.role === "input" ||
      descriptor.role === "section"
  );
  const primaryButtonColors = pickTopDistinctColors(
    buttonDescriptors,
    (descriptor) => descriptor.backgroundColor
  );
  const styleSignals: ThemeStyleSignals = {
    hasStrongDarkTheme: false,
    hasStyledButtons: buttonDescriptors.some((descriptor) => hasSurfaceTreatment(descriptor)),
    hasStyledInputs: inputDescriptors.some((descriptor) => hasSurfaceTreatment(descriptor)),
    hasElevatedCards: cardDescriptors.some(
      (descriptor) =>
        isMeaningfulColorValue(descriptor.backgroundColor) &&
        (hasRoundedCorners(descriptor.borderRadius) || hasMeaningfulShadow(descriptor.boxShadow))
    )
  };
  const designTokens: ThemeDesignTokens = {
    globalBackground:
      params.tokenOverrides?.globalBackground ??
      pickWeightedColor(pageDescriptors, (descriptor) => descriptor.backgroundColor),
    foreground:
      params.tokenOverrides?.foreground ??
      pickWeightedColor(textDescriptors, (descriptor) => descriptor.textColor),
    cardBackground:
      params.tokenOverrides?.cardBackground ??
      pickWeightedColor(cardDescriptors, (descriptor) => descriptor.backgroundColor),
    borderColor:
      params.tokenOverrides?.borderColor ??
      pickWeightedColor(borderDescriptors, (descriptor) => descriptor.borderColor),
    primaryButtonColor:
      params.tokenOverrides?.primaryButtonColor ?? primaryButtonColors[0],
    secondaryButtonColor:
      params.tokenOverrides?.secondaryButtonColor ?? primaryButtonColors[1],
    accentColor:
      params.tokenOverrides?.accentColor ??
      pickAccentColor(buttonDescriptors.length > 0 ? buttonDescriptors : params.descriptors, primaryButtonColors[0]),
    mutedColor:
      params.tokenOverrides?.mutedColor ??
      pickWeightedColor(
        textDescriptors.filter((descriptor) => descriptor.weight <= 100000),
        (descriptor) => descriptor.textColor
      ),
    radius:
      params.tokenOverrides?.radius ??
      pickDominantSize(
        params.descriptors.filter(
          (descriptor) =>
            descriptor.role === "card" ||
            descriptor.role === "button" ||
            descriptor.role === "input"
        ),
        (descriptor) => descriptor.borderRadius
      ),
    shadow:
      params.tokenOverrides?.shadow ??
      pickDominantSize(
        params.descriptors.filter(
          (descriptor) =>
            descriptor.role === "card" ||
            descriptor.role === "button" ||
            descriptor.role === "input"
        ),
        (descriptor) => descriptor.boxShadow
      ),
    fontFamily:
      params.tokenOverrides?.fontFamily ??
      pickDominantSize(textDescriptors, (descriptor) => normalizeFontFamily(descriptor.fontFamily)),
    headingSize:
      params.tokenOverrides?.headingSize ??
      pickDominantSize(
        params.descriptors.filter((descriptor) => /^h[1-6]$/i.test(descriptor.tag ?? "")),
        (descriptor) => descriptor.fontSize
      ),
    bodyTextSize:
      params.tokenOverrides?.bodyTextSize ??
      pickDominantSize(
        params.descriptors.filter(
          (descriptor) =>
            ["p", "span", "small", "label", "button", "a", "input", "textarea"].includes(
              (descriptor.tag ?? "").toLowerCase()
            )
        ),
        (descriptor) => descriptor.fontSize
      ),
    averageSectionVerticalSpacing:
      params.tokenOverrides?.averageSectionVerticalSpacing ??
      (params.layout ? extractAverageSectionSpacing(params.layout) : undefined)
  };
  const backgroundColor = parseColor(designTokens.globalBackground);
  const foregroundColor = parseColor(designTokens.foreground);
  const dominantBackgroundLuminance = backgroundColor
    ? relativeLuminance(backgroundColor)
    : undefined;
  const dominantContrast =
    backgroundColor && foregroundColor
      ? Number.parseFloat(contrastRatio(backgroundColor, foregroundColor).toFixed(2))
      : undefined;
  const darkVotes = [
    designTokens.globalBackground,
    designTokens.cardBackground,
    ...pageDescriptors.slice(0, 4).map((descriptor) => descriptor.backgroundColor)
  ].filter((value) => isClearlyDarkColor(value)).length;
  const lightVotes = [
    designTokens.globalBackground,
    designTokens.cardBackground,
    ...pageDescriptors.slice(0, 4).map((descriptor) => descriptor.backgroundColor)
  ].filter((value) => isClearlyLightColor(value)).length;
  let detectedTheme: ThemeMode = "unknown";

  if (dominantBackgroundLuminance !== undefined) {
    if (dominantBackgroundLuminance <= 0.42 || darkVotes > lightVotes + 1) {
      detectedTheme = "dark";
    } else if (dominantBackgroundLuminance >= 0.62 || lightVotes > darkVotes + 1) {
      detectedTheme = "light";
    } else {
      detectedTheme = "mixed";
    }
  }
  styleSignals.hasStrongDarkTheme =
    detectedTheme === "dark" &&
    (dominantBackgroundLuminance ?? 1) <= 0.2 &&
    (dominantContrast ?? 0) >= 4.5;

  const colorSamples: ThemeColorSample[] = params.descriptors
    .filter((descriptor) => isMeaningfulColorValue(descriptor.backgroundColor))
    .slice(0, 24)
    .map((descriptor) => {
      const background = parseColor(descriptor.backgroundColor);
      const text = parseColor(descriptor.textColor);

      return {
        role: descriptor.role,
        color: descriptor.backgroundColor as string,
        luminance: background ? Number.parseFloat(relativeLuminance(background).toFixed(4)) : 0,
        contrastAgainstText:
          background && text
            ? Number.parseFloat(contrastRatio(background, text).toFixed(2))
            : undefined,
        nodeId: descriptor.nodeId,
        weight: descriptor.weight
      };
    });
  const messages = [
    detectedTheme === "dark"
      ? "dark theme detected"
      : detectedTheme === "light"
        ? "light theme detected"
        : detectedTheme === "mixed"
          ? "mixed theme detected"
          : "theme could not be determined"
  ];

  return {
    analysis: {
      detectedTheme,
      dominantBackgroundLuminance:
        dominantBackgroundLuminance !== undefined
          ? Number.parseFloat(dominantBackgroundLuminance.toFixed(4))
          : undefined,
      dominantContrast,
      colorSamples,
      designTokens,
      styleSignals,
      roleCounts,
      messages
    },
    descriptors: params.descriptors
  } satisfies ThemeInspection;
}

function resolveCaptureRole(node: CapturedNode, layoutNode?: LayoutNode): ThemeColorSampleRole | undefined {
  const tag = node.tag.toLowerCase();
  const className = node.attributes.class ?? "";
  const semanticRole = layoutNode?.detection?.semanticRole ?? "";

  if (tag === "html" || node.parentId === null) return "page";
  if (tag === "body") return "body";
  if (tag === "main" || /(^|[\s_-])(main|app|root|page)([\s_-]|$)/i.test(className)) return "main";
  if (semanticRole === "header" || tag === "header") return "header";
  if (semanticRole === "footer" || tag === "footer") return "footer";
  if (semanticRole === "card" || /(^|[\s_-])card([\s_-]|$)/i.test(className)) return "card";
  if (["input", "textarea", "select"].includes(tag)) return "input";
  if (semanticRole === "button" || tag === "button") return "button";
  if (tag === "a" && Boolean(node.attributes.href)) {
    return /(^|[\s_-])(cta|button|btn)([\s_-]|$)/i.test(className) ? "cta" : "button";
  }
  if (layoutNode?.kind === "section" || ["section", "article", "aside", "nav"].includes(tag)) {
    return "section";
  }

  return undefined;
}

function buildCaptureDescriptors(capture: PageCapture, layout: LayoutDocument) {
  const layoutById = new Map(layout.nodes.map((node) => [node.id, node]));

  return capture.nodes
    .filter((node) => node.isVisible)
    .flatMap((node) => {
      const role = resolveCaptureRole(node, layoutById.get(node.id));
      const weight = Math.max(
        1,
        Math.round((node.box?.width ?? 1) * (node.box?.height ?? 1))
      );

      if (!role) {
        return [];
      }

      return [
        {
          role,
          nodeId: node.id,
          tag: node.tag,
          backgroundColor: node.computedStyles["background-color"],
          textColor: node.computedStyles.color,
          borderColor: node.computedStyles["border-color"],
          borderRadius: node.computedStyles["border-radius"],
          boxShadow: node.computedStyles["box-shadow"],
          fontFamily: node.computedStyles["font-family"],
          fontSize: node.computedStyles["font-size"],
          weight:
            role === "body"
              ? Math.max(weight, 2_500_000)
              : role === "main"
                ? Math.max(weight, 2_000_000)
                : weight
        } satisfies ThemeDescriptor
      ];
    });
}

function resolvePreviewRole(element: Element): ThemeColorSampleRole | undefined {
  const tag = element.tagName.toLowerCase();
  const className = element.getAttribute("class") ?? "";

  if (tag === "html") return "page";
  if (tag === "body") return "body";
  if (tag === "main") return "main";
  if (tag === "header") return "header";
  if (tag === "footer") return "footer";
  if (["input", "textarea", "select"].includes(tag)) return "input";
  if (tag === "button") return "button";
  if (tag === "a" && Boolean(element.getAttribute("href"))) {
    return /(^|[\s_-])(cta|button|btn)([\s_-]|$)/i.test(className) ? "cta" : "button";
  }
  if (/(^|[\s_-])card([\s_-]|$)/i.test(className)) return "card";
  if (["section", "article", "aside", "nav", "div"].includes(tag)) {
    return "section";
  }

  return undefined;
}

function buildPreviewDescriptors(previewHtml: string) {
  const dom = new JSDOM(previewHtml);
  const { document } = dom.window;
  const elements = [
    document.documentElement,
    document.body,
    ...Array.from(document.body.querySelectorAll<HTMLElement>("*"))
  ];

  return elements.flatMap((element) => {
    const role = resolvePreviewRole(element);

    if (!role) {
      return [];
    }

    const computed = dom.window.getComputedStyle(element);
    const width = parsePx(computed.width) ?? parsePx(element.getAttribute("width") ?? undefined) ?? 1;
    const height = parsePx(computed.height) ?? parsePx(element.getAttribute("height") ?? undefined) ?? 1;
    const weight =
      role === "body"
        ? 2_500_000
        : role === "main"
          ? 2_000_000
          : Math.max(1, Math.round(width * height));

    return [
      {
        role,
        tag: element.tagName.toLowerCase(),
        backgroundColor: computed.backgroundColor,
        textColor: computed.color,
        borderColor: computed.borderColor,
        borderRadius: computed.borderRadius,
        boxShadow: computed.boxShadow,
        fontFamily: computed.fontFamily,
        fontSize: computed.fontSize,
        weight
      } satisfies ThemeDescriptor
    ];
  });
}

export function analyzeCaptureTheme(capture: PageCapture, layout: LayoutDocument): ThemeAnalysis {
  const descriptors = buildCaptureDescriptors(capture, layout);
  const baseInspection = finalizeThemeAnalysis({
    descriptors,
    layout
  });
  const tokenOverrides: Partial<ThemeDesignTokens> = {};
  const bodyLikeNodes = capture.nodes.filter((node) =>
    node.tag === "html" || node.tag === "body" || node.tag === "main" || node.parentId === null
  );

  (
    Object.entries(THEME_CUSTOM_PROPERTY_MAP) as Array<
      [keyof typeof THEME_CUSTOM_PROPERTY_MAP, readonly string[]]
    >
  ).forEach(([tokenKey, customProperties]) => {
    const value = extractTokenFromCustomProperties(bodyLikeNodes, customProperties);
    const baselineValue = baseInspection.analysis.designTokens[tokenKey];

    if (value && !baselineValue) {
      tokenOverrides[tokenKey] = value;
    }
  });

  return finalizeThemeAnalysis({
    descriptors,
    layout,
    tokenOverrides
  }).analysis;
}

export function analyzePreviewTheme(previewHtml: string): ThemeAnalysis {
  return finalizeThemeAnalysis({
    descriptors: buildPreviewDescriptors(previewHtml)
  }).analysis;
}

function createThemeAuditIssue(
  type: ThemeAuditIssue["type"],
  message: string,
  originalValue?: string,
  convertedValue?: string
): ThemeAuditIssue {
  return {
    type,
    severity: "critical",
    message,
    originalValue,
    convertedValue
  };
}

export function auditThemeConsistency(params: {
  sourceThemeAnalysis?: ThemeAnalysis;
  previewHtml?: string;
  emittedMode?: OutputMode;
}): ThemeAuditReport | undefined {
  const source = params.sourceThemeAnalysis;

  if (!source) {
    return undefined;
  }

  if (params.emittedMode === "pixel-perfect") {
    return {
      passed: true,
      sourceTheme: source.detectedTheme,
      convertedTheme: source.detectedTheme,
      sourceTokens: source.designTokens,
      convertedTokens: source.designTokens,
      issues: [],
      messages: [...source.messages]
    };
  }

  const convertedInspection = params.previewHtml
    ? finalizeThemeAnalysis({
        descriptors: buildPreviewDescriptors(params.previewHtml)
      })
    : {
        analysis: {
        detectedTheme: "unknown",
        dominantBackgroundLuminance: undefined,
        dominantContrast: undefined,
        colorSamples: [],
        designTokens: {} as ThemeDesignTokens,
        roleCounts: {
          cards: 0,
          buttons: 0,
          inputs: 0,
          headers: 0,
          footers: 0,
          sections: 0
        },
        messages: ["theme could not be determined"]
        } satisfies ThemeAnalysis,
        descriptors: []
      } satisfies ThemeInspection;
  const converted = convertedInspection.analysis;
  const convertedButtonBackgrounds = convertedInspection.descriptors
    .filter((descriptor) => descriptor.role === "button" || descriptor.role === "cta")
    .map((descriptor) => descriptor.backgroundColor)
    .filter((value): value is string => Boolean(value && isMeaningfulColorValue(value)));
  const convertedInputBackgrounds = convertedInspection.descriptors
    .filter((descriptor) => descriptor.role === "input")
    .map((descriptor) => descriptor.backgroundColor)
    .filter((value): value is string => Boolean(value && isMeaningfulColorValue(value)));
  const issues: ThemeAuditIssue[] = [];
  const messages = [...new Set([...source.messages, ...converted.messages])];
  const sourceStyledButtons =
    source.styleSignals?.hasStyledButtons === true ||
    (source.roleCounts.buttons > 0 &&
      (Boolean(source.designTokens.primaryButtonColor) ||
        hasRoundedCorners(source.designTokens.radius) ||
        hasMeaningfulShadow(source.designTokens.shadow)));
  const sourceStyledInputs =
    source.styleSignals?.hasStyledInputs === true ||
    (source.roleCounts.inputs > 0 &&
      (Boolean(source.designTokens.cardBackground) ||
        Boolean(source.designTokens.borderColor) ||
        hasRoundedCorners(source.designTokens.radius)));
  const globalBackgroundDistance = colorDistance(
    source.designTokens.globalBackground,
    converted.designTokens.globalBackground
  );

  if (source.detectedTheme === "dark") {
    if (
      converted.detectedTheme === "light" ||
      isClearlyLightColor(converted.designTokens.globalBackground)
    ) {
      const themeMismatchMessage = "dark theme lost";
      issues.push(
        createThemeAuditIssue(
          "theme-mismatch",
          themeMismatchMessage,
          source.designTokens.globalBackground,
          converted.designTokens.globalBackground
        )
      );
      messages.push(themeMismatchMessage);
    }

    if (
      isClearlyDarkColor(source.designTokens.cardBackground) &&
      isClearlyLightColor(
        converted.designTokens.cardBackground ?? converted.designTokens.globalBackground
      )
    ) {
      issues.push(
        createThemeAuditIssue(
          "card-background-mismatch",
          "card background mismatch",
          source.designTokens.cardBackground,
          converted.designTokens.cardBackground ?? converted.designTokens.globalBackground
        )
      );
      messages.push("card background mismatch");
    }
  }

  if (
    globalBackgroundDistance !== undefined &&
    globalBackgroundDistance >= GLOBAL_BACKGROUND_MISMATCH_DISTANCE &&
    !issues.some((issue) => issue.type === "theme-mismatch")
  ) {
    issues.push(
      createThemeAuditIssue(
        "theme-mismatch",
        "theme mismatch",
        source.designTokens.globalBackground,
        converted.designTokens.globalBackground
      )
    );
    messages.push("theme mismatch");
  }

  if (
    sourceStyledButtons &&
    (
      convertedButtonBackgrounds.length === 0 ||
      !converted.designTokens.primaryButtonColor ||
      (
        source.detectedTheme === "dark" &&
        convertedButtonBackgrounds.every((value) => isClearlyLightColor(value))
      )
    )
  ) {
    issues.push(
      createThemeAuditIssue(
        "default-button-style-detected",
        "default button style detected",
        source.designTokens.primaryButtonColor,
        converted.designTokens.primaryButtonColor
      )
    );
    messages.push("default button style detected");
  }

  if (
    sourceStyledInputs &&
    (
      convertedInputBackgrounds.length === 0 ||
      (
        source.detectedTheme === "dark" &&
        (
          convertedInputBackgrounds.every((value) => isClearlyLightColor(value)) ||
          (
            !converted.designTokens.cardBackground &&
            isClearlyLightColor(converted.designTokens.globalBackground)
          )
        )
      )
    )
  ) {
    issues.push(
      createThemeAuditIssue(
        "default-input-style-detected",
        "default input style detected",
        source.designTokens.cardBackground,
        converted.designTokens.cardBackground
      )
    );
    messages.push("default input style detected");
  }

  return {
    passed: issues.length === 0,
    sourceTheme: source.detectedTheme,
    convertedTheme: converted.detectedTheme,
    sourceTokens: source.designTokens,
    convertedTokens: converted.designTokens,
    issues,
    messages: [...new Set(messages)]
  };
}
