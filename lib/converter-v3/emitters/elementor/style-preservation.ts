import * as cheerio from "cheerio";

import type { PageCapture } from "@/lib/converter-v3/contracts/capture";
import type { LayoutDocument, LayoutNode } from "@/lib/converter-v3/contracts/layout";

type CapturedNode = PageCapture["nodes"][number];
type CapturedPseudoElement = NonNullable<CapturedNode["pseudoElements"]>[number];
type RgbaColor = {
  r: number;
  g: number;
  b: number;
  a: number;
};

const STYLE_PROPERTY_ORDER = [
  "position",
  "inset",
  "top",
  "right",
  "bottom",
  "left",
  "display",
  "flex-direction",
  "flex-wrap",
  "justify-content",
  "align-items",
  "place-items",
  "place-content",
  "gap",
  "row-gap",
  "column-gap",
  "grid-template-columns",
  "grid-template-rows",
  "grid-auto-flow",
  "grid-auto-columns",
  "grid-auto-rows",
  "width",
  "height",
  "min-width",
  "max-width",
  "min-height",
  "max-height",
  "aspect-ratio",
  "margin",
  "padding",
  "background",
  "background-color",
  "background-image",
  "background-position",
  "background-size",
  "background-repeat",
  "background-clip",
  "background-blend-mode",
  "background-origin",
  "background-attachment",
  "color",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "line-height",
  "letter-spacing",
  "text-transform",
  "text-decoration",
  "white-space",
  "text-align",
  "border",
  "border-color",
  "border-width",
  "border-style",
  "border-radius",
  "box-shadow",
  "outline",
  "outline-offset",
  "text-shadow",
  "overflow",
  "overflow-x",
  "overflow-y",
  "object-fit",
  "object-position",
  "visibility",
  "opacity",
  "filter",
  "backdrop-filter",
  "mix-blend-mode",
  "isolation",
  "mask-image",
  "-webkit-mask-image",
  "transform",
  "z-index",
  "pointer-events",
  "cursor"
] as const;

const NUMERIC_BOX_STYLE_PROPERTIES = new Set([
  "width",
  "height",
  "min-width",
  "max-width",
  "min-height",
  "max-height"
]);

export const CLICKABLE_TEXT_DECORATION_RESET_STYLE =
  "text-decoration:none !important;text-decoration-line:none !important";

export const CLICKABLE_TEXT_DECORATION_RESET_SELECTORS = [
  'a[href]',
  "button",
  '[role="button"]',
  '[role="link"]',
  'input[type="button"]',
  'input[type="submit"]',
  'input[type="reset"]',
  ".elementor-button",
  ".elementor-widget-button a"
] as const;

export const CLICKABLE_TEXT_DECORATION_RESET_CSS = CLICKABLE_TEXT_DECORATION_RESET_SELECTORS
  .map(
    (selector) =>
      `${selector}{text-decoration:none !important;text-decoration-line:none !important;}`
  )
  .join("");

export function buildButtonTextDecorationCustomCss() {
  return [
    "selector .elementor-button",
    "selector .elementor-button:hover",
    "selector .elementor-button:focus",
    "selector .elementor-button:active",
    "selector .elementor-button:visited",
    "selector .elementor-button-content-wrapper",
    "selector .elementor-button-text"
  ]
    .join(",")
    .concat("{" + CLICKABLE_TEXT_DECORATION_RESET_STYLE + ";}");
}

function trimStyleValue(value?: string) {
  return value?.trim() || undefined;
}

function hasInlineTextDecorationStyle(value?: string) {
  return /\btext-decoration(?:-line|-style|-color)?\s*:/i.test(value ?? "");
}

function hasExplicitClickableTextDecorationSignal(captureNode?: CapturedNode) {
  const inlineStyle = captureNode?.attributes.style;

  if (hasInlineTextDecorationStyle(inlineStyle)) {
    return true;
  }

  const className = captureNode?.attributes.class ?? "";

  return /\b(?:underline|decoration-[\w-]+)\b/i.test(className);
}

function isClickableTextElement(tag?: string) {
  return ["a", "button"].includes((tag ?? "").toLowerCase());
}

function removeInlineTextDecorationStyles(value?: string) {
  return (value ?? "")
    .split(";")
    .map((declaration) => declaration.trim())
    .filter(Boolean)
    .filter((declaration) => !/^text-decoration(?:-[a-z-]+)?\s*:/i.test(declaration))
    .join(";");
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function splitColorFunctionArgs(value: string) {
  const parts = value
    .trim()
    .replace(/,/g, " ")
    .replace(/\s*\/\s*/g, " / ")
    .split(/\s+/)
    .filter(Boolean);
  const slashIndex = parts.indexOf("/");

  if (slashIndex >= 0) {
    return {
      channels: parts.slice(0, slashIndex),
      alpha: parts[slashIndex + 1]
    };
  }

  return {
    channels: parts.slice(0, 3),
    alpha: parts[3]
  };
}

function parseAlphaValue(value?: string) {
  if (!value) {
    return 1;
  }

  return value.endsWith("%")
    ? clamp(Number.parseFloat(value) / 100, 0, 1)
    : clamp(Number.parseFloat(value), 0, 1);
}

function parseRgbChannel(value: string) {
  return value.endsWith("%")
    ? clamp((Number.parseFloat(value) / 100) * 255, 0, 255)
    : clamp(Number.parseFloat(value), 0, 255);
}

function parseHueValue(value: string) {
  const normalized = value.trim().toLowerCase();
  const amount = Number.parseFloat(normalized);

  if (!Number.isFinite(amount)) {
    return 0;
  }

  if (normalized.endsWith("turn")) {
    return amount * 360;
  }

  if (normalized.endsWith("rad")) {
    return (amount * 180) / Math.PI;
  }

  return amount;
}

function parsePercentValue(value: string) {
  const amount = Number.parseFloat(value);
  return value.trim().endsWith("%") ? amount : amount * 100;
}

function hueToRgb(p: number, q: number, t: number) {
  let next = t;

  if (next < 0) {
    next += 1;
  }

  if (next > 1) {
    next -= 1;
  }

  if (next < 1 / 6) {
    return p + (q - p) * 6 * next;
  }

  if (next < 1 / 2) {
    return q;
  }

  if (next < 2 / 3) {
    return p + (q - p) * (2 / 3 - next) * 6;
  }

  return p;
}

function hslToRgb(hue: number, saturation: number, lightness: number) {
  const h = (((hue % 360) + 360) % 360) / 360;
  const s = clamp(saturation / 100, 0, 1);
  const l = clamp(lightness / 100, 0, 1);

  if (s === 0) {
    const channel = Math.round(l * 255);
    return { r: channel, g: channel, b: channel };
  }

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;

  return {
    r: Math.round(hueToRgb(p, q, h + 1 / 3) * 255),
    g: Math.round(hueToRgb(p, q, h) * 255),
    b: Math.round(hueToRgb(p, q, h - 1 / 3) * 255)
  };
}

function parseOklchLightness(value: string) {
  return value.trim().endsWith("%")
    ? clamp(Number.parseFloat(value) / 100, 0, 1)
    : clamp(Number.parseFloat(value), 0, 1);
}

function parseOklchChroma(value: string) {
  return value.trim().endsWith("%")
    ? clamp((Number.parseFloat(value) / 100) * 0.4, 0, 0.4)
    : Math.max(Number.parseFloat(value), 0);
}

function linearSrgbToByte(value: number) {
  const normalized = clamp(value, 0, 1);
  const srgb =
    normalized <= 0.0031308
      ? normalized * 12.92
      : 1.055 * normalized ** (1 / 2.4) - 0.055;

  return Math.round(clamp(srgb, 0, 1) * 255);
}

function oklchToRgb(lightness: number, chroma: number, hue: number) {
  const hueRadians = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(hueRadians);
  const b = chroma * Math.sin(hueRadians);
  const lPrime = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mPrime = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sPrime = lightness - 0.0894841775 * a - 1.291485548 * b;
  const l = lPrime ** 3;
  const m = mPrime ** 3;
  const s = sPrime ** 3;

  return {
    r: linearSrgbToByte(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: linearSrgbToByte(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: linearSrgbToByte(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)
  };
}

function parseCssColor(value?: string): RgbaColor | undefined {
  const normalized = trimStyleValue(value)?.toLowerCase();

  if (!normalized || normalized === "transparent" || normalized === "none") {
    return undefined;
  }

  if (normalized === "white") {
    return { r: 255, g: 255, b: 255, a: 1 };
  }

  if (normalized === "black") {
    return { r: 0, g: 0, b: 0, a: 1 };
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
    const { channels, alpha } = splitColorFunctionArgs(rgbMatch[1]);

    if (channels.length >= 3) {
      return {
        r: Math.round(parseRgbChannel(channels[0])),
        g: Math.round(parseRgbChannel(channels[1])),
        b: Math.round(parseRgbChannel(channels[2])),
        a: parseAlphaValue(alpha)
      };
    }
  }

  const hslMatch = normalized.match(/^hsla?\((.+)\)$/i);

  if (hslMatch) {
    const { channels, alpha } = splitColorFunctionArgs(hslMatch[1]);

    if (channels.length >= 3) {
      const rgb = hslToRgb(
        parseHueValue(channels[0]),
        parsePercentValue(channels[1]),
        parsePercentValue(channels[2])
      );

      return {
        ...rgb,
        a: parseAlphaValue(alpha)
      };
    }
  }

  const oklchMatch = normalized.match(/^oklch\((.+)\)$/i);

  if (oklchMatch) {
    const { channels, alpha } = splitColorFunctionArgs(oklchMatch[1]);

    if (channels.length >= 3) {
      const rgb = oklchToRgb(
        parseOklchLightness(channels[0]),
        parseOklchChroma(channels[1]),
        parseHueValue(channels[2])
      );

      return {
        ...rgb,
        a: parseAlphaValue(alpha)
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

export function normalizeElementorColorValue(value?: string) {
  const normalized = trimStyleValue(value);

  if (!normalized) {
    return undefined;
  }

  const colorCandidate = extractVisibleColorFromBackground(normalized) ?? normalized;

  if (
    /var\(/i.test(colorCandidate) ||
    /^(?:inherit|current|currentcolor|initial|transparent|unset|revert)$/i.test(colorCandidate)
  ) {
    return undefined;
  }

  const parsed = parseCssColor(colorCandidate);

  if (parsed) {
    return toCssColor(parsed);
  }

  if (/^(?:rgba?|hsla?|oklch|oklab|lch|lab|color|(?:repeating-)?(?:linear|radial|conic)-gradient)\(/i.test(colorCandidate)) {
    return undefined;
  }

  return colorCandidate;
}

function isTransparentColor(value?: string) {
  const normalized = (value ?? "").replace(/\s+/g, "").toLowerCase();
  if (
    !normalized ||
    normalized === "transparent" ||
    normalized === "rgba(0,0,0,0)" ||
    normalized === "rgb(0,0,0,0)" ||
    normalized === "hsla(0,0%,0%,0)"
  ) {
    return true;
  }

  const parsed = parseCssColor(value);
  return Boolean(parsed && parsed.a <= 0.03);
}

function resolveBackgroundColorCandidate(styleMap: Record<string, string>) {
  if (hasVisibleBackgroundColorValue(styleMap["background-color"])) {
    return trimStyleValue(styleMap["background-color"]);
  }

  const background = trimStyleValue(styleMap.background);

  if (!background) {
    return undefined;
  }

  if (/url\(|gradient\(/i.test(background)) {
    return undefined;
  }

  return extractVisibleColorFromBackground(background);
}

function hasVisibleBackgroundColorValue(value?: string) {
  return shouldKeepStyle("background-color", value);
}

function hasVisibleBackgroundImageValue(value?: string) {
  return shouldKeepStyle("background-image", value);
}

function looksLikeDefaultCanvasBackground(value?: string) {
  const normalized = (value ?? "").trim().toLowerCase();
  const compact = normalized.replace(/\s+/g, "");

  return (
    compact === "#fff" ||
    compact === "#ffffff" ||
    compact === "rgb(255,255,255)" ||
    compact === "rgba(255,255,255,1)" ||
    compact === "hsl(0,0%,100%)" ||
    /^hsl\(\s*0(?:deg)?(?:\s+|,\s*)0%\s*(?:,|\s)\s*100%\s*\)$/i.test(normalized)
  );
}

function isZeroLengthValue(value?: string) {
  const normalized = (value ?? "").trim().toLowerCase();

  if (!normalized) {
    return true;
  }

  if (normalized === "0" || normalized === "0px" || normalized === "0%" || normalized === "0rem") {
    return true;
  }

  return normalized
    .split(/\s+/)
    .every((part) => ["0", "0px", "0%", "0rem"].includes(part));
}

function isInvisibleShadowValue(value?: string) {
  const normalized = (value ?? "").trim().toLowerCase();

  if (!normalized || normalized === "none" || normalized === "transparent") {
    return true;
  }

  const compact = normalized.replace(/\s+/g, "");

  if (
    compact === "rgba(0,0,0,0)" ||
    compact === "rgb(0,0,0,0)" ||
    compact === "hsla(0,0%,0%,0)"
  ) {
    return true;
  }

  const withoutTransparentColors = compact
    .replace(/rgba\([^)]*,0(?:\.0+)?\)/g, "")
    .replace(/hsla\([^)]*,0(?:\.0+)?\)/g, "")
    .replace(/transparent/g, "")
    .replace(/inset/g, "");

  if (!withoutTransparentColors) {
    return true;
  }

  return withoutTransparentColors
    .split(/[,/]/)
    .join("")
    .split(/\s+/)
    .filter(Boolean)
    .every((part) => /^-?(?:0|0px|0rem|0em|0%|0vh|0vw)$/.test(part));
}

function shouldKeepStyle(property: string, value?: string): boolean {
  const normalized = trimStyleValue(value);

  if (!normalized) {
    return false;
  }

  if (normalized === "initial" || normalized === "normal") {
    return false;
  }

  switch (property) {
    case "background":
      return (
        !/rgba\(0,\s*0,\s*0,\s*0\)/i.test(normalized) &&
        normalized.toLowerCase() !== "none" &&
        !(/var\(/i.test(normalized) && !/url\(|gradient\(/i.test(normalized)) &&
        !(
          normalized.toLowerCase().includes("transparent") &&
          !/url\(|gradient\(/i.test(normalized) &&
          !extractVisibleColorFromBackground(normalized)
        )
      );
    case "background-color":
      return !/var\(/i.test(normalized) && !isTransparentColor(normalized);
    case "background-image":
    case "filter":
    case "backdrop-filter":
    case "mask-image":
    case "-webkit-mask-image":
    case "transform":
      return normalized.toLowerCase() !== "none";
    case "box-shadow":
    case "text-shadow":
      return !isInvisibleShadowValue(normalized);
    case "background-size":
      return normalized.toLowerCase() !== "auto";
    case "background-position":
      return normalized.toLowerCase() !== "0% 0%" && normalized.toLowerCase() !== "0px 0px";
    case "background-repeat":
      return normalized.toLowerCase() !== "repeat";
    case "border":
      return !/^0(?:px)?\s+none\b/i.test(normalized) && normalized.toLowerCase() !== "none";
    case "border-color":
      return !isTransparentColor(normalized);
    case "border-width":
    case "border-radius":
    case "outline-offset":
      return !isZeroLengthValue(normalized);
    case "border-style":
      return normalized.toLowerCase() !== "none";
    case "margin":
    case "padding":
      return !isZeroLengthValue(normalized);
    case "overflow":
    case "overflow-x":
    case "overflow-y":
      return normalized.toLowerCase() !== "visible";
    case "visibility":
      return normalized.toLowerCase() !== "visible";
    case "opacity":
      return normalized !== "1";
    case "z-index":
      return normalized.toLowerCase() !== "auto" && normalized !== "0";
    case "pointer-events":
      return normalized.toLowerCase() !== "auto";
    default:
      if (NUMERIC_BOX_STYLE_PROPERTIES.has(property)) {
        return normalized.toLowerCase() !== "auto" && !isZeroLengthValue(normalized);
      }

      return true;
  }
}

function readFunctionalColorToken(value: string, startIndex: number): string | undefined {
  let depth = 0;

  for (let index = startIndex; index < value.length; index += 1) {
    const character = value[index];

    if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;

      if (depth === 0) {
        return value.slice(startIndex, index + 1).trim();
      }
    }
  }

  return undefined;
}

function extractVisibleColorFromBackground(value: string): string | undefined {
  const normalized = value.trim();

  if (!normalized || normalized.toLowerCase() === "transparent") {
    return undefined;
  }

  const functionalColorMatch = normalized.match(
    /\b(?:rgba?|hsla?|oklch|oklab|lch|lab|color)\(/i
  );

  if (functionalColorMatch?.index !== undefined) {
    const token = readFunctionalColorToken(normalized, functionalColorMatch.index);

    return shouldKeepStyle("background-color", token) ? token : undefined;
  }

  const hexColor = normalized.match(/#[0-9a-f]{3,8}\b/i)?.[0];

  if (hexColor) {
    return shouldKeepStyle("background-color", hexColor) ? hexColor : undefined;
  }

  return undefined;
}

function mergeExistingStyle(existingStyle: string | undefined, nextStyle: string) {
  const existing = (existingStyle ?? "").trim().replace(/;+\s*$/, "");
  const incoming = nextStyle.trim().replace(/;+\s*$/, "");

  if (!existing) {
    return incoming;
  }

  if (!incoming) {
    return existing;
  }

  return `${existing};${incoming}`;
}

function escapeCssValue(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function applyIfMissing(
  target: Record<string, string>,
  property: string,
  value?: string
) {
  const normalized = trimStyleValue(value);

  if (!normalized || trimStyleValue(target[property])) {
    return;
  }

  target[property] = normalized;
}

function applyVisibleBackgroundIfMissing(
  target: Record<string, string>,
  property: "background" | "background-color" | "background-image",
  value?: string
) {
  const normalized = trimStyleValue(value);

  if (!normalized || trimStyleValue(target[property])) {
    return;
  }

  if (property === "background-color" && !hasVisibleBackgroundColorValue(normalized)) {
    return;
  }

  if (property === "background-image" && !hasVisibleBackgroundImageValue(normalized)) {
    return;
  }

  if (
    property === "background" &&
    !shouldKeepStyle("background", normalized) &&
    !extractVisibleColorFromBackground(normalized)
  ) {
    return;
  }

  target[property] = normalized;
}

function inferBoxLength(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? `${Math.max(Math.round(value), 1)}px`
    : undefined;
}

function normalizeBoxUnit(value: string) {
  const match = value.trim().match(/^(-?\d+(?:\.\d+)?)([a-z%]*)$/i);

  if (!match) {
    return undefined;
  }

  const size = Number.parseFloat(match[1]);

  if (!Number.isFinite(size)) {
    return undefined;
  }

  return {
    size,
    unit: match[2] || "px"
  };
}

function toBoxObject(value?: string) {
  if (!value) {
    return undefined;
  }

  const parts = value.split(/\s+/).filter(Boolean);
  const [top = parts[0], right = top, bottom = top, left = right] = parts;
  const normalizedTop = normalizeBoxUnit(top);
  const normalizedRight = normalizeBoxUnit(right);
  const normalizedBottom = normalizeBoxUnit(bottom);
  const normalizedLeft = normalizeBoxUnit(left);
  const referenceUnit = normalizedTop?.unit ?? "px";

  if (!normalizedTop || !normalizedRight || !normalizedBottom || !normalizedLeft) {
    return undefined;
  }

  if (
    normalizedRight.unit !== referenceUnit ||
    normalizedBottom.unit !== referenceUnit ||
    normalizedLeft.unit !== referenceUnit
  ) {
    return undefined;
  }

  return {
    unit: referenceUnit,
    top: normalizedTop.size,
    right: normalizedRight.size,
    bottom: normalizedBottom.size,
    left: normalizedLeft.size,
    isLinked:
      normalizedTop.size === normalizedRight.size &&
      normalizedRight.size === normalizedBottom.size &&
      normalizedBottom.size === normalizedLeft.size
  };
}

export function toSpacingObject(value?: string) {
  return toBoxObject(value);
}

export function resolveStyleMapBackgroundColor(styleMap: Record<string, string>) {
  return normalizeElementorColorValue(resolveBackgroundColorCandidate(styleMap));
}

export function resolveStyleMapBackgroundValue(styleMap: Record<string, string>) {
  const background = trimStyleValue(styleMap.background);

  if (shouldKeepStyle("background", background)) {
    return background && /url\(|gradient\(/i.test(background)
      ? background
      : normalizeElementorColorValue(background) ?? background;
  }

  const backgroundImage = trimStyleValue(styleMap["background-image"]);

  if (shouldKeepStyle("background-image", backgroundImage)) {
    return backgroundImage;
  }

  return resolveStyleMapBackgroundColor(styleMap);
}

export function buildDetectedPageBackgroundCssVariables(
  styleMap: Record<string, string>
) {
  const declarations: string[] = [];
  const background = resolveStyleMapBackgroundValue(styleMap);
  const backgroundColor = normalizeElementorColorValue(
    trimStyleValue(styleMap["background-color"]) ?? resolveBackgroundColorCandidate(styleMap)
  );

  if (background) {
    declarations.push(`--detected-page-background:${escapeCssValue(background)};`);
  }

  if (backgroundColor) {
    declarations.push(`--detected-page-background-color:${escapeCssValue(backgroundColor)};`);
  }

  for (const [property, variableName] of [
    ["background-image", "--detected-page-background-image"],
    ["background-size", "--detected-page-background-size"],
    ["background-position", "--detected-page-background-position"],
    ["background-repeat", "--detected-page-background-repeat"],
    ["background-attachment", "--detected-page-background-attachment"],
    ["background-origin", "--detected-page-background-origin"],
    ["background-clip", "--detected-page-background-clip"],
    ["background-blend-mode", "--detected-page-background-blend-mode"],
    ["color", "--detected-page-foreground"],
    ["font-family", "--detected-page-font-family"]
  ] as const) {
    const value = trimStyleValue(styleMap[property]);

    if (!value) {
      continue;
    }

    declarations.push(`${variableName}:${escapeCssValue(value)};`);
  }

  return declarations.join("");
}

export type PageShellVisualContext = {
  shouldWrap: boolean;
  sourceNodeId?: string;
  captureNodeId?: string;
  styleMap: Record<string, string>;
  detectedPageBackground?: string;
  minHeight?: string;
};

function buildCaptureShellStyleMap(node?: CapturedNode) {
  if (!node) {
    return {};
  }

  const styleMap: Record<string, string> = {};

  applyVisibleBackgroundIfMissing(styleMap, "background", node.computedStyles.background);
  applyVisibleBackgroundIfMissing(styleMap, "background-color", node.computedStyles["background-color"]);
  applyVisibleBackgroundIfMissing(styleMap, "background-image", node.asset.backgroundImage);
  applyVisibleBackgroundIfMissing(styleMap, "background-image", node.computedStyles["background-image"]);
  applyIfMissing(styleMap, "background-size", node.computedStyles["background-size"]);
  applyIfMissing(styleMap, "background-position", node.computedStyles["background-position"]);
  applyIfMissing(styleMap, "background-repeat", node.computedStyles["background-repeat"]);
  applyIfMissing(styleMap, "background-clip", node.computedStyles["background-clip"]);
  applyIfMissing(styleMap, "background-blend-mode", node.computedStyles["background-blend-mode"]);
  applyIfMissing(styleMap, "background-origin", node.computedStyles["background-origin"]);
  applyIfMissing(styleMap, "background-attachment", node.computedStyles["background-attachment"]);
  applyIfMissing(styleMap, "color", node.computedStyles.color);
  applyIfMissing(styleMap, "font-family", node.computedStyles["font-family"]);

  return styleMap;
}

function hasAnyGlobalBackground(styleMap: Record<string, string>) {
  return Boolean(
    shouldKeepStyle("background", styleMap.background) ||
      hasVisibleBackgroundImageValue(styleMap["background-image"]) ||
      hasVisibleBackgroundColorValue(styleMap["background-color"]) ||
      resolveBackgroundColorCandidate(styleMap)
  );
}

function isLargeVisibleShellCandidate(
  node: CapturedNode,
  pageWidth: number,
  pageHeight: number,
  rootIds: Set<string>
) {
  const tag = node.tag.toLowerCase();

  if (!["main", "div", "section"].includes(tag)) {
    return false;
  }

  if (!node.isVisible || !rootIds.has(node.parentId ?? "")) {
    return false;
  }

  const box = node.viewportStates.desktop?.box ?? node.box;

  if (!box) {
    return false;
  }

  return (
    box.width >= pageWidth * 0.55 &&
    box.height >= pageHeight * 0.24 &&
    box.width * box.height >= pageWidth * pageHeight * 0.18
  );
}

function getPageShellCaptureNode(capture: PageCapture, layout: LayoutDocument) {
  const visibleOrRoot = (node: CapturedNode, tag: string) =>
    node.tag.toLowerCase() === tag && (node.isVisible || tag === "body" || tag === "html");
  const bodyNode = capture.nodes.find((node) => visibleOrRoot(node, "body"));
  const htmlNode = capture.nodes.find((node) => visibleOrRoot(node, "html"));
  const rootCaptureNode = capture.nodes.find((node) => node.id === layout.rootNodeId);
  const mainNode =
    capture.nodes
      .filter((node) => node.tag.toLowerCase() === "main" && node.isVisible)
      .sort((left, right) => {
        const leftBox = left.viewportStates.desktop?.box ?? left.box;
        const rightBox = right.viewportStates.desktop?.box ?? right.box;
        return (rightBox?.width ?? 0) * (rightBox?.height ?? 0) - (leftBox?.width ?? 0) * (leftBox?.height ?? 0);
      })[0];
  const desktopViewport =
    capture.viewports.find((viewport) => viewport.name === "desktop") ?? capture.viewports[0];
  const pageWidth = desktopViewport?.width ?? 1440;
  const pageHeight = capture.nodes.reduce((maxHeight, node) => {
    const box = node.viewportStates.desktop?.box ?? node.box;
    return Math.max(maxHeight, box ? box.y + box.height : 0);
  }, desktopViewport?.height ?? 1200);
  const rootIds = new Set<string>(
    [bodyNode?.id, htmlNode?.id, layout.rootNodeId].filter(
      (value): value is string => typeof value === "string" && value.length > 0
    )
  );
  const largeWrapperNode =
    capture.nodes
      .filter((node) => isLargeVisibleShellCandidate(node, pageWidth, pageHeight, rootIds))
      .sort((left, right) => {
        const leftBox = left.viewportStates.desktop?.box ?? left.box;
        const rightBox = right.viewportStates.desktop?.box ?? right.box;
        return (rightBox?.width ?? 0) * (rightBox?.height ?? 0) - (leftBox?.width ?? 0) * (leftBox?.height ?? 0);
      })[0];
  const candidates = [
    { node: bodyNode, role: "body" as const },
    { node: htmlNode, role: "html" as const },
    { node: rootCaptureNode, role: "layout-root" as const },
    { node: mainNode, role: "main" as const },
    { node: largeWrapperNode, role: "large-wrapper" as const }
  ].filter(
    (candidate): candidate is { node: CapturedNode; role: "body" | "html" | "layout-root" | "main" | "large-wrapper" } =>
      Boolean(candidate.node)
  );

  const scored = candidates
    .map((candidate) => {
      const styleMap = buildCaptureShellStyleMap(candidate.node);
      const box = candidate.node.viewportStates.desktop?.box ?? candidate.node.box;
      const fallbackCoverageRatio =
        candidate.role === "body" || candidate.role === "html" ? 0.72 : 0.6;
      const widthRatio = box
        ? Math.min(box.width / pageWidth, 1)
        : fallbackCoverageRatio;
      const heightRatio = box
        ? Math.min(box.height / Math.max(pageHeight, 1), 1)
        : fallbackCoverageRatio;
      const areaRatio = box
        ? Math.min((box.width * box.height) / Math.max(pageWidth * Math.max(pageHeight, 1), 1), 1)
        : fallbackCoverageRatio;
      const backgroundColor =
        resolveBackgroundColorCandidate(styleMap) ??
        (hasVisibleBackgroundColorValue(styleMap["background-color"])
          ? trimStyleValue(styleMap["background-color"])
          : undefined);
      const roleWeight =
        candidate.role === "body"
          ? 95
          : candidate.role === "main"
            ? 88
            : candidate.role === "layout-root"
              ? 82
              : candidate.role === "large-wrapper"
                ? 78
                : 74;
      const imageWeight =
        hasVisibleBackgroundImageValue(styleMap["background-image"]) ||
        /url\(|gradient\(/i.test(styleMap.background ?? "")
          ? 40
          : 0;
      const colorWeight = backgroundColor
        ? looksLikeDefaultCanvasBackground(backgroundColor)
          ? 6
          : 24
        : 0;

      return {
        node: candidate.node,
        score:
          roleWeight +
          imageWeight +
          colorWeight +
          widthRatio * 12 +
          heightRatio * 18 +
          areaRatio * 30,
        hasBackground: hasAnyGlobalBackground(styleMap)
      };
    })
    .sort((left, right) => right.score - left.score);

  return scored.find((candidate) => candidate.hasBackground)?.node ?? bodyNode ?? htmlNode ?? rootCaptureNode ?? mainNode;
}

export function resolvePageShellVisualContext(params: {
  capture: PageCapture;
  layout: LayoutDocument;
}) : PageShellVisualContext {
  const rootNode = params.layout.nodes.find((node) => node.id === params.layout.rootNodeId);
  const captureNode = getPageShellCaptureNode(params.capture, params.layout);
  const styleMap: Record<string, string> = {};

  if (captureNode) {
    applyVisibleBackgroundIfMissing(styleMap, "background", captureNode.computedStyles.background);
    applyVisibleBackgroundIfMissing(styleMap, "background-color", captureNode.computedStyles["background-color"]);
    applyVisibleBackgroundIfMissing(styleMap, "background-image", captureNode.asset.backgroundImage);
    applyVisibleBackgroundIfMissing(styleMap, "background-image", captureNode.computedStyles["background-image"]);
    applyIfMissing(styleMap, "background-size", captureNode.computedStyles["background-size"]);
    applyIfMissing(styleMap, "background-position", captureNode.computedStyles["background-position"]);
    applyIfMissing(styleMap, "background-repeat", captureNode.computedStyles["background-repeat"]);
    applyIfMissing(styleMap, "background-attachment", captureNode.computedStyles["background-attachment"]);
    applyIfMissing(styleMap, "background-origin", captureNode.computedStyles["background-origin"]);
    applyIfMissing(styleMap, "background-clip", captureNode.computedStyles["background-clip"]);
    applyIfMissing(styleMap, "background-blend-mode", captureNode.computedStyles["background-blend-mode"]);
    applyIfMissing(styleMap, "color", captureNode.computedStyles.color);
    applyIfMissing(styleMap, "font-family", captureNode.computedStyles["font-family"]);
  }

  applyVisibleBackgroundIfMissing(styleMap, "background", rootNode?.style.background);
  applyVisibleBackgroundIfMissing(styleMap, "background-color", rootNode?.style.backgroundColor);
  applyVisibleBackgroundIfMissing(styleMap, "background-image", rootNode?.style.backgroundImage);
  applyIfMissing(styleMap, "background-size", rootNode?.style.backgroundSize);
  applyIfMissing(styleMap, "background-position", rootNode?.style.backgroundPosition);
  applyIfMissing(styleMap, "background-repeat", rootNode?.style.backgroundRepeat);
  applyIfMissing(styleMap, "background-attachment", rootNode?.style.backgroundAttachment);
  applyIfMissing(styleMap, "background-origin", rootNode?.style.backgroundOrigin);
  applyIfMissing(styleMap, "background-clip", rootNode?.style.backgroundClip);
  applyIfMissing(styleMap, "background-blend-mode", rootNode?.style.backgroundBlendMode);
  applyIfMissing(styleMap, "color", rootNode?.style.color);
  applyIfMissing(styleMap, "font-family", rootNode?.style.fontFamily);

  applyIfMissing(styleMap, "background-color", params.capture.themeAnalysis?.designTokens.globalBackground);
  applyIfMissing(styleMap, "color", params.capture.themeAnalysis?.designTokens.foreground);
  applyIfMissing(styleMap, "font-family", params.capture.themeAnalysis?.designTokens.fontFamily);

  const screenshotHeight = params.capture.viewports.find((viewport) => viewport.name === "desktop")?.height;
  const minHeight =
    typeof screenshotHeight === "number" && screenshotHeight > 0
      ? `${Math.round(screenshotHeight)}px`
      : undefined;
  const hasMeaningfulGlobalBackgroundColor =
    hasVisibleBackgroundColorValue(styleMap["background-color"]) &&
    !looksLikeDefaultCanvasBackground(styleMap["background-color"]);
  const detectedPageBackground = resolveStyleMapBackgroundValue(styleMap);
  const shouldWrap =
    hasMeaningfulGlobalBackgroundColor ||
    hasVisibleBackgroundImageValue(styleMap["background-image"]) ||
    params.capture.themeAnalysis?.styleSignals?.hasStrongDarkTheme === true;

  return {
    shouldWrap,
    sourceNodeId: params.layout.rootNodeId,
    captureNodeId: captureNode?.id,
    styleMap: Object.fromEntries(
      Object.entries(styleMap).filter(([, value]) => trimStyleValue(value))
    ) as Record<string, string>,
    detectedPageBackground,
    minHeight
  };
}

export function buildPreservedComputedStyleMap(params: {
  node?: LayoutNode;
  captureNode?: CapturedNode;
}) {
  const computedStyles = params.captureNode?.computedStyles ?? {};
  const styleMap: Record<string, string> = {};

  STYLE_PROPERTY_ORDER.forEach((property) => {
    const value = trimStyleValue(computedStyles[property]);

    if (value) {
      styleMap[property] = value;
    }
  });

  const node = params.node;
  const captureNode = params.captureNode;

  if (node) {
    applyIfMissing(styleMap, "display", node.layout.display);
    applyIfMissing(styleMap, "position", node.layout.position);
    applyIfMissing(styleMap, "flex-direction", node.layout.flexDirection);
    applyIfMissing(styleMap, "flex-wrap", node.layout.flexWrap);
    applyIfMissing(styleMap, "justify-content", node.layout.justifyContent);
    applyIfMissing(styleMap, "align-items", node.layout.alignItems);
    applyIfMissing(styleMap, "gap", node.layout.gap);
    applyIfMissing(styleMap, "grid-template-columns", node.layout.gridTemplateColumns);
    applyIfMissing(styleMap, "grid-template-rows", node.layout.gridTemplateRows);

    applyIfMissing(styleMap, "margin", node.spacing.margin);
    applyIfMissing(styleMap, "padding", node.spacing.padding);

    applyIfMissing(styleMap, "background-color", node.style.backgroundColor);
    applyIfMissing(styleMap, "background-image", node.style.backgroundImage);
    applyIfMissing(styleMap, "background-size", node.style.backgroundSize);
    applyIfMissing(styleMap, "background-position", node.style.backgroundPosition);
    applyIfMissing(styleMap, "background-repeat", node.style.backgroundRepeat);
    applyIfMissing(styleMap, "color", node.style.color);
    applyIfMissing(styleMap, "font-family", node.style.fontFamily);
    applyIfMissing(styleMap, "font-size", node.style.fontSize);
    applyIfMissing(styleMap, "font-style", node.style.fontStyle);
    applyIfMissing(styleMap, "font-weight", node.style.fontWeight);
    applyIfMissing(styleMap, "line-height", node.style.lineHeight);
    applyIfMissing(styleMap, "letter-spacing", node.style.letterSpacing);
    applyIfMissing(styleMap, "text-transform", node.style.textTransform);
    applyIfMissing(styleMap, "text-decoration", node.style.textDecoration);
    applyIfMissing(styleMap, "white-space", node.style.whiteSpace);
    applyIfMissing(styleMap, "text-align", node.style.textAlign);
    applyIfMissing(styleMap, "border", node.style.border);
    applyIfMissing(styleMap, "border-color", node.style.borderColor);
    applyIfMissing(styleMap, "border-width", node.style.borderWidth);
    applyIfMissing(styleMap, "border-style", node.style.borderStyle);
    applyIfMissing(styleMap, "border-radius", node.style.borderRadius);
    applyIfMissing(styleMap, "box-shadow", node.style.boxShadow);
    applyIfMissing(styleMap, "text-shadow", node.style.textShadow);
    applyIfMissing(styleMap, "object-fit", node.style.objectFit);
    applyIfMissing(styleMap, "object-position", node.style.objectPosition);
    applyIfMissing(styleMap, "opacity", node.style.opacity);
    applyIfMissing(styleMap, "overflow", node.style.overflow);
    applyIfMissing(styleMap, "overflow-x", node.style.overflowX);
    applyIfMissing(styleMap, "overflow-y", node.style.overflowY);
    applyIfMissing(styleMap, "transform", node.style.transform);
    applyIfMissing(styleMap, "filter", node.style.filter);
    applyIfMissing(styleMap, "backdrop-filter", node.style.backdropFilter);
    applyIfMissing(styleMap, "mix-blend-mode", node.style.mixBlendMode);
    applyIfMissing(styleMap, "isolation", node.style.isolation);
    applyIfMissing(styleMap, "mask-image", node.style.maskImage);
    applyIfMissing(styleMap, "-webkit-mask-image", node.style.webkitMaskImage);
    applyIfMissing(styleMap, "pointer-events", node.style.pointerEvents);
    applyIfMissing(styleMap, "cursor", node.style.cursor);
    applyIfMissing(styleMap, "z-index", node.style.zIndex);
    applyIfMissing(styleMap, "width", node.style.width ?? inferBoxLength(node.box.width));
    applyIfMissing(styleMap, "height", node.style.height);
    applyIfMissing(styleMap, "min-height", node.style.minHeight);
    applyIfMissing(styleMap, "min-width", node.style.minWidth);
    applyIfMissing(styleMap, "max-width", node.style.maxWidth);
    applyIfMissing(styleMap, "max-height", node.style.maxHeight);
    applyIfMissing(styleMap, "top", node.style.top);
    applyIfMissing(styleMap, "right", node.style.right);
    applyIfMissing(styleMap, "bottom", node.style.bottom);
    applyIfMissing(styleMap, "left", node.style.left);
    applyIfMissing(styleMap, "inset", node.style.inset);

    if (!trimStyleValue(styleMap["min-height"]) && node.kind !== "text" && node.box.height > 32) {
      styleMap["min-height"] = inferBoxLength(node.box.height) ?? "";
    }

    if (!trimStyleValue(styleMap.height) && node.kind === "image") {
      applyIfMissing(styleMap, "height", inferBoxLength(node.box.height));
    }
  }

  const captureTag = (captureNode?.tag ?? node?.tag ?? "").toLowerCase();
  const hasExplicitClickableTextDecoration =
    hasExplicitClickableTextDecorationSignal(captureNode);

  if (
    captureNode &&
    isClickableTextElement(captureTag) &&
    !hasExplicitClickableTextDecoration &&
    /underline/i.test(trimStyleValue(styleMap["text-decoration"]) ?? "")
  ) {
    styleMap["text-decoration"] = "none";
  }

  return Object.fromEntries(
    Object.entries(styleMap).filter(([, value]) => trimStyleValue(value))
  ) as Record<string, string>;
}

export function buildInlineStyleFromComputedStyleMap(
  styleMap: Record<string, string>,
  options: {
    width?: string;
    height?: string;
    minHeight?: string;
  } = {}
) {
  const merged = {
    ...styleMap
  };

  applyIfMissing(merged, "width", options.width);
  applyIfMissing(merged, "height", options.height);
  applyIfMissing(merged, "min-height", options.minHeight);

  return STYLE_PROPERTY_ORDER
    .filter((property) => shouldKeepStyle(property, merged[property]))
    .map((property) => `${property}:${escapeCssValue(merged[property])}`)
    .join(";");
}

export function buildNodeInlineStyleAttribute(params: {
  node?: LayoutNode;
  captureNode?: CapturedNode;
}) {
  const styleMap = buildPreservedComputedStyleMap(params);

  return buildInlineStyleFromComputedStyleMap(styleMap, {
    width:
      params.node?.kind === "image"
        ? inferBoxLength(params.node.box.width)
        : undefined,
    height:
      params.node?.kind === "image"
        ? inferBoxLength(params.node.box.height)
        : undefined,
    minHeight:
      params.node && params.node.kind !== "text" && params.node.box.height > 32
        ? inferBoxLength(params.node.box.height)
        : undefined
  });
}

export function buildElementorStyleBridgeSettings(params: {
  node: LayoutNode;
  captureNode?: CapturedNode;
  isButton?: boolean;
}) {
  const styleMap = buildPreservedComputedStyleMap(params);

  const borderRadius = trimStyleValue(styleMap["border-radius"]);
  const boxShadow = trimStyleValue(styleMap["box-shadow"]);
  const backgroundColor = normalizeElementorColorValue(resolveBackgroundColorCandidate(styleMap));
  const textColor = normalizeElementorColorValue(styleMap.color);
  const rawTextDecoration = trimStyleValue(styleMap["text-decoration"]);
  const textDecoration =
    rawTextDecoration && /underline/i.test(rawTextDecoration)
      ? "underline"
      : "none";
  const width = trimStyleValue(styleMap.width) ?? inferBoxLength(params.node.box.width);
  const height = trimStyleValue(styleMap.height);
  const minHeight =
    trimStyleValue(styleMap["min-height"]) ??
    (params.node.kind !== "text" && params.node.box.height > 32
      ? inferBoxLength(params.node.box.height)
      : undefined);
  const zIndex = trimStyleValue(styleMap["z-index"]);
  const numericZIndex = zIndex && zIndex !== "auto" ? Number.parseInt(zIndex, 10) : undefined;
  const borderRadiusBox = toBoxObject(borderRadius);
  const settings: Record<string, unknown> = {
    _padding: toSpacingObject(styleMap.padding ?? params.node.spacing.padding),
    _margin: toSpacingObject(styleMap.margin ?? params.node.spacing.margin),
    width,
    max_width: trimStyleValue(styleMap["max-width"]),
    height,
    min_height: minHeight,
    background_color: backgroundColor,
    _background_color: backgroundColor,
    color: textColor,
    text_color: textColor,
    title_color: textColor,
    font_size: trimStyleValue(styleMap["font-size"]),
    font_family: trimStyleValue(styleMap["font-family"]),
    font_weight: trimStyleValue(styleMap["font-weight"]),
    font_style: trimStyleValue(styleMap["font-style"]),
    line_height: trimStyleValue(styleMap["line-height"]),
    align: trimStyleValue(styleMap["text-align"]),
    border: trimStyleValue(styleMap.border),
    border_color: trimStyleValue(styleMap["border-color"]),
    border_width: trimStyleValue(styleMap["border-width"]) ?? trimStyleValue(styleMap.border),
    border_style: trimStyleValue(styleMap["border-style"]),
    border_radius: borderRadius,
    _border_radius: borderRadiusBox,
    box_shadow: boxShadow,
    box_shadow_box_shadow: boxShadow,
    text_shadow: trimStyleValue(styleMap["text-shadow"]),
    opacity: trimStyleValue(styleMap.opacity),
    overflow: trimStyleValue(styleMap.overflow),
    overflow_x: trimStyleValue(styleMap["overflow-x"]),
    overflow_y: trimStyleValue(styleMap["overflow-y"]),
    display: trimStyleValue(styleMap.display),
    text_decoration: params.isButton ? textDecoration : undefined,
    typography_typography: params.isButton ? "custom" : undefined,
    typography_text_decoration: params.isButton ? textDecoration : undefined,
    _typography_text_decoration: params.isButton ? textDecoration : undefined,
    button_text_decoration: params.isButton ? textDecoration : undefined,
    button_typography_typography: params.isButton ? "custom" : undefined,
    button_typography_text_decoration: params.isButton ? textDecoration : undefined,
    button_hover_text_decoration: params.isButton ? textDecoration : undefined,
    custom_css:
      params.isButton && textDecoration !== "underline"
        ? buildButtonTextDecorationCustomCss()
        : undefined,
    converter_v3_styles: styleMap,
    converter_v3_inline_style: buildInlineStyleFromComputedStyleMap(styleMap, {
      width,
      height,
      minHeight
    }),
    converter_v3_visual_order: params.node.visualOrder
  };

  if (typeof numericZIndex === "number" && Number.isFinite(numericZIndex)) {
    settings.z_index = numericZIndex;
  }

  if (params.isButton) {
    settings.button_text_color = textColor;
  }

  return Object.fromEntries(
    Object.entries(settings).filter(([, value]) => value !== undefined)
  );
}

export function hasVisualShellStyles(styleMap: Record<string, string>) {
  return (
    shouldKeepStyle("background-color", styleMap["background-color"]) ||
    shouldKeepStyle("background-image", styleMap["background-image"]) ||
    shouldKeepStyle("border", styleMap.border) ||
    shouldKeepStyle("border-color", styleMap["border-color"]) ||
    shouldKeepStyle("border-width", styleMap["border-width"]) ||
    shouldKeepStyle("border-radius", styleMap["border-radius"]) ||
    shouldKeepStyle("box-shadow", styleMap["box-shadow"]) ||
    shouldKeepStyle("padding", styleMap.padding)
  );
}

export function captureNodeHasVisiblePseudoStyles(captureNode?: CapturedNode) {
  return Boolean(
    captureNode?.pseudoElements?.some((pseudo) => {
      if (!pseudo.isVisible) {
        return false;
      }

      return (
        Boolean(trimStyleValue(pseudo.content)) ||
        hasVisualShellStyles(pseudo.computedStyles) ||
        shouldKeepStyle("opacity", pseudo.computedStyles.opacity) ||
        shouldKeepStyle("transform", pseudo.computedStyles.transform)
      );
    })
  );
}

export function shouldPreserveNodeAsHtmlWidget(params: {
  node: LayoutNode;
  captureNode?: CapturedNode;
}) {
  const tag = (params.captureNode?.tag ?? params.node.tag ?? "").toLowerCase();
  const inputType = (params.captureNode?.attributes.type ?? "").toLowerCase();
  const styleMap = buildPreservedComputedStyleMap(params);

  if (["table", "svg", "canvas", "iframe", "video", "form"].includes(tag)) {
    return true;
  }

  if (["input", "textarea", "select"].includes(tag)) {
    return true;
  }

  if (inputType === "search") {
    return true;
  }

  if (params.node.kind === "badge" && hasVisualShellStyles(styleMap)) {
    return true;
  }

  if (
    params.node.kind === "button" &&
    (
      shouldKeepStyle("background-image", styleMap["background-image"]) ||
      shouldKeepStyle("text-shadow", styleMap["text-shadow"]) ||
      shouldKeepStyle("opacity", styleMap.opacity) ||
      shouldKeepStyle("transform", styleMap.transform)
    )
  ) {
    return true;
  }

  return false;
}

function buildPseudoCssRule(nodeId: string, pseudo: CapturedPseudoElement) {
  const styleMap = Object.fromEntries(
    Object.entries(pseudo.computedStyles ?? {}).filter(([, value]) => trimStyleValue(value))
  ) as Record<string, string>;
  const style = buildInlineStyleFromComputedStyleMap(styleMap, {
    width: inferBoxLength(pseudo.box?.width),
    height: inferBoxLength(pseudo.box?.height)
  });

  if (!style) {
    return "";
  }

  const content = typeof pseudo.content === "string" ? pseudo.content : "";
  return `[data-capture-id="${escapeCssValue(nodeId)}"]${pseudo.pseudo}{content:${JSON.stringify(content)};${style}}`;
}

function inlineSvgToDataUrl(svgHtml: string) {
  return `data:image/svg+xml;base64,${Buffer.from(svgHtml, "utf8").toString("base64")}`;
}

function convertInlineSvgElementsToImages($: cheerio.CheerioAPI) {
  $("svg").each((_, element) => {
    const svg = $(element);

    if (!svg.attr("xmlns")) {
      svg.attr("xmlns", "http://www.w3.org/2000/svg");
    }

    const svgHtml = $.html(element);

    if (!svgHtml.trim()) {
      return;
    }

    const image = $("<img />");
    const alt =
      svg.attr("aria-label")?.trim() ||
      svg.attr("data-lovable-icon")?.trim() ||
      svg.find("title").first().text().trim() ||
      "";

    [
      "class",
      "style",
      "width",
      "height",
      "data-capture-id",
      "data-lovable-icon",
      "data-converter-v3-node"
    ].forEach((attribute) => {
      const value = svg.attr(attribute);

      if (value) {
        image.attr(attribute, value);
      }
    });

    image.attr("src", inlineSvgToDataUrl(svgHtml));
    image.attr("alt", alt);
    image.attr("decoding", "async");
    image.attr("loading", "eager");
    image.attr("data-converter-v3-inline-svg", "true");
    svg.replaceWith(image);
  });
}

export function normalizeClickableTextDecorationStyles($: cheerio.CheerioAPI) {
  $(CLICKABLE_TEXT_DECORATION_RESET_SELECTORS.join(",")).each((_, element) => {
    const clickable = $(element);
    const currentStyle = clickable.attr("style") ?? "";
    const hasUnderline = /text-decoration(?:-[a-z-]+)?\s*:[^;]*underline/i.test(currentStyle);
    const isCapturedNode = clickable.is("[data-capture-id]");
    const hasExplicitInlineDecoration =
      clickable.attr("data-converter-v3-inline-text-decoration") === "true";
    const cleanedStyle = removeInlineTextDecorationStyles(currentStyle);

    const decorationStyle =
      hasUnderline && (!isCapturedNode || hasExplicitInlineDecoration)
        ? "text-decoration:underline !important;text-decoration-line:underline !important"
        : CLICKABLE_TEXT_DECORATION_RESET_STYLE;

    clickable.attr(
      "style",
      mergeExistingStyle(cleanedStyle, decorationStyle)
    );
    clickable.removeAttr("data-converter-v3-inline-text-decoration");
  });
}

export function buildStyledHtmlFragment(params: {
  html: string;
  captureById: Map<string, CapturedNode>;
  layoutById?: Map<string, LayoutNode>;
}) {
  const $ = cheerio.load(params.html);
  const pseudoRules: string[] = [];
  const pseudoSeen = new Set<string>();
  const clickableSelector = CLICKABLE_TEXT_DECORATION_RESET_SELECTORS.join(",");

  $("[data-capture-id]").each((_, element) => {
    const nodeId = $(element).attr("data-capture-id")?.trim();

    if (!nodeId) {
      return;
    }

    const originalStyle = $(element).attr("style") ?? "";
    const className = $(element).attr("class") ?? "";

    if (
      $(element).is(clickableSelector) &&
      (hasInlineTextDecorationStyle(originalStyle) ||
        /\b(?:underline|decoration-[\w-]+)\b/i.test(className))
    ) {
      $(element).attr("data-converter-v3-inline-text-decoration", "true");
    }

    const captureNode = params.captureById.get(nodeId);
    const layoutNode = params.layoutById?.get(nodeId);
    const inlineStyle = buildNodeInlineStyleAttribute({
      node: layoutNode,
      captureNode
    });

    if (inlineStyle) {
      $(element).attr(
        "style",
        mergeExistingStyle($(element).attr("style"), inlineStyle)
      );
    }

    if (!captureNode?.pseudoElements?.length) {
      return;
    }

    captureNode.pseudoElements.forEach((pseudo) => {
      if (!pseudo.isVisible) {
        return;
      }

      const pseudoKey = `${nodeId}:${pseudo.pseudo}`;

      if (pseudoSeen.has(pseudoKey)) {
        return;
      }

      const rule = buildPseudoCssRule(nodeId, pseudo);

      if (rule) {
        pseudoSeen.add(pseudoKey);
        pseudoRules.push(rule);
      }
    });
  });

  convertInlineSvgElementsToImages($);
  normalizeClickableTextDecorationStyles($);

  const fragment = $.root()
    .children()
    .toArray()
    .map((node) => $.html(node))
    .join("");

  if (!pseudoRules.length) {
    return fragment;
  }

  return `<style>${pseudoRules.join("")}</style>${fragment}`;
}
