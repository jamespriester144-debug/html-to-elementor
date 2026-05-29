import * as cheerio from "cheerio";
import type { Element } from "domhandler";

const colorVars: Record<string, string> = {
  background: "--background",
  foreground: "--foreground",
  card: "--card",
  "card-foreground": "--card-foreground",
  popover: "--popover",
  "popover-foreground": "--popover-foreground",
  primary: "--primary",
  "primary-foreground": "--primary-foreground",
  "primary-deep": "--primary-deep",
  "primary-glow": "--primary-glow",
  secondary: "--secondary",
  "secondary-foreground": "--secondary-foreground",
  muted: "--muted",
  "muted-foreground": "--muted-foreground",
  destructive: "--destructive",
  "destructive-foreground": "--destructive-foreground",
  border: "--border",
  input: "--input",
  ring: "--ring",
  cream: "--cream",
  gold: "--gold",
  accent: "--accent",
  "accent-foreground": "--accent-foreground"
};

const namedColors: Record<string, string> = {
  inherit: "inherit",
  current: "currentColor",
  transparent: "transparent",
  white: "#ffffff",
  black: "#000000",
  slate: "#64748b",
  "slate-50": "#f8fafc",
  "slate-100": "#f1f5f9",
  "slate-200": "#e2e8f0",
  "slate-300": "#cbd5e1",
  "slate-400": "#94a3b8",
  "slate-500": "#64748b",
  "slate-600": "#475569",
  "slate-700": "#334155",
  "slate-800": "#1e293b",
  "slate-900": "#0f172a",
  "slate-950": "#020617",
  gray: "#6b7280",
  "gray-50": "#f9fafb",
  "gray-100": "#f3f4f6",
  "gray-200": "#e5e7eb",
  "gray-300": "#d1d5db",
  "gray-400": "#9ca3af",
  "gray-500": "#6b7280",
  "gray-600": "#4b5563",
  "gray-700": "#374151",
  "gray-800": "#1f2937",
  "gray-900": "#111827",
  zinc: "#71717a",
  "zinc-50": "#fafafa",
  "zinc-100": "#f4f4f5",
  "zinc-200": "#e4e4e7",
  "zinc-300": "#d4d4d8",
  "zinc-400": "#a1a1aa",
  "zinc-500": "#71717a",
  "zinc-600": "#52525b",
  "zinc-700": "#3f3f46",
  "zinc-800": "#27272a",
  "zinc-900": "#18181b",
  neutral: "#737373",
  "neutral-50": "#fafafa",
  "neutral-100": "#f5f5f5",
  "neutral-200": "#e5e5e5",
  "neutral-300": "#d4d4d4",
  "neutral-400": "#a3a3a3",
  "neutral-500": "#737373",
  "neutral-600": "#525252",
  "neutral-700": "#404040",
  "neutral-800": "#262626",
  "neutral-900": "#171717",
  red: "#ef4444",
  "red-50": "#fef2f2",
  "red-100": "#fee2e2",
  "red-200": "#fecaca",
  "red-300": "#fca5a5",
  "red-400": "#f87171",
  "red-500": "#ef4444",
  "red-600": "#dc2626",
  "red-700": "#b91c1c",
  "red-800": "#991b1b",
  "red-900": "#7f1d1d",
  amber: "#f59e0b",
  "amber-50": "#fffbeb",
  "amber-100": "#fef3c7",
  "amber-200": "#fde68a",
  "amber-300": "#fcd34d",
  "amber-400": "#fbbf24",
  "amber-500": "#f59e0b",
  "amber-600": "#d97706",
  "amber-700": "#b45309",
  green: "#22c55e",
  "green-50": "#f0fdf4",
  "green-100": "#dcfce7",
  "green-200": "#bbf7d0",
  "green-300": "#86efac",
  "green-400": "#4ade80",
  "green-500": "#22c55e",
  "green-600": "#16a34a",
  "green-700": "#15803d",
  blue: "#3b82f6",
  "blue-50": "#eff6ff",
  "blue-100": "#dbeafe",
  "blue-200": "#bfdbfe",
  "blue-300": "#93c5fd",
  "blue-400": "#60a5fa",
  "blue-500": "#3b82f6",
  "blue-600": "#2563eb",
  "blue-700": "#1d4ed8",
  indigo: "#6366f1",
  "indigo-50": "#eef2ff",
  "indigo-100": "#e0e7ff",
  "indigo-200": "#c7d2fe",
  "indigo-300": "#a5b4fc",
  "indigo-400": "#818cf8",
  "indigo-500": "#6366f1",
  "indigo-600": "#4f46e5",
  "indigo-700": "#4338ca",
  violet: "#8b5cf6",
  "violet-50": "#f5f3ff",
  "violet-100": "#ede9fe",
  "violet-200": "#ddd6fe",
  "violet-300": "#c4b5fd",
  "violet-400": "#a78bfa",
  "violet-500": "#8b5cf6",
  "violet-600": "#7c3aed",
  "violet-700": "#6d28d9",
  purple: "#a855f7",
  "purple-50": "#faf5ff",
  "purple-100": "#f3e8ff",
  "purple-200": "#e9d5ff",
  "purple-300": "#d8b4fe",
  "purple-400": "#c084fc",
  "purple-500": "#a855f7",
  "purple-600": "#9333ea",
  "purple-700": "#7e22ce",
  pink: "#ec4899",
  "pink-50": "#fdf2f8",
  "pink-100": "#fce7f3",
  "pink-200": "#fbcfe8",
  "pink-300": "#f9a8d4",
  "pink-400": "#f472b6",
  "pink-500": "#ec4899",
  "pink-600": "#db2777",
  "pink-700": "#be185d",
  rose: "#f43f5e",
  "rose-50": "#fff1f2",
  "rose-100": "#ffe4e6",
  "rose-200": "#fecdd3",
  "rose-300": "#fda4af",
  "rose-400": "#fb7185",
  "rose-500": "#f43f5e",
  "rose-600": "#e11d48",
  "rose-700": "#be123c"
};

const spacing: Record<string, string> = {
  "0": "0",
  "0.5": "0.125rem",
  "1": "0.25rem",
  "1.5": "0.375rem",
  "2": "0.5rem",
  "2.5": "0.625rem",
  "3": "0.75rem",
  "3.5": "0.875rem",
  "4": "1rem",
  "5": "1.25rem",
  "6": "1.5rem",
  "7": "1.75rem",
  "8": "2rem",
  "10": "2.5rem",
  "12": "3rem",
  "14": "3.5rem",
  "16": "4rem",
  "20": "5rem",
  "24": "6rem",
  "28": "7rem",
  "32": "8rem",
  "36": "9rem",
  "40": "10rem",
  "44": "11rem",
  "48": "12rem",
  "52": "13rem",
  "56": "14rem",
  "60": "15rem",
  "64": "16rem",
  "72": "18rem",
  "80": "20rem",
  "96": "24rem"
};

const negativeSpacing: Record<string, string> = Object.fromEntries(
  Object.entries(spacing).map(([key, value]) => [key, value === "0" ? "0" : `-${value}`])
);

const textSizes: Record<string, string> = {
  xs: "0.75rem",
  sm: "0.875rem",
  base: "1rem",
  lg: "1.125rem",
  xl: "1.25rem",
  "2xl": "1.5rem",
  "3xl": "1.875rem",
  "4xl": "2.25rem",
  "5xl": "3rem",
  "6xl": "3.75rem",
  "7xl": "4.5rem",
  "8xl": "6rem",
  "9xl": "8rem"
};

const fontWeights: Record<string, string> = {
  normal: "400",
  medium: "500",
  semibold: "600",
  bold: "700",
  extrabold: "800"
};

const radius: Record<string, string> = {
  md: "0.375rem",
  lg: "0.5rem",
  xl: "0.75rem",
  "2xl": "1rem",
  "3xl": "1.5rem",
  full: "9999px"
};

const responsiveBreakpoints: Record<string, string> = {
  sm: "640px",
  md: "768px",
  lg: "1024px",
  xl: "1280px"
};

const fractionLengths: Record<string, string> = {
  "1/2": "50%",
  "1/3": "33.333333%",
  "2/3": "66.666667%",
  "1/4": "25%",
  "2/4": "50%",
  "3/4": "75%",
  "1/5": "20%",
  "2/5": "40%",
  "3/5": "60%",
  "4/5": "80%",
  "1/6": "16.666667%",
  "5/6": "83.333333%",
  full: "100%"
};

function add(style: Record<string, string>, property: string, value?: string) {
  if (value) {
    style[property] = value;
  }
}

function spacingValue(value: string) {
  return spacing[value] ?? value;
}

function asHslColor(variableName: string) {
  return `hsl(var(${variableName}))`;
}

function semanticColorValue(name: string, variableName: string) {
  return `var(--color-${name}, ${asHslColor(variableName)})`;
}

function colorValue(value: string) {
  const [name, alpha] = value.split("/");
  const variableName = colorVars[name];
  const color = variableName ? semanticColorValue(name, variableName) : namedColors[name] ?? name;
  const alphaNumber = Number(alpha);
  const alphaValue = Number.isFinite(alphaNumber) ? alphaNumber / 100 : undefined;

  if (!alpha) {
    return color;
  }

  if (variableName && typeof alphaValue === "number") {
    return `color-mix(in srgb, ${color} ${alphaNumber}%, transparent)`;
  }

  if (typeof alphaValue === "number") {
    return `color-mix(in srgb, ${color} ${alphaNumber}%, transparent)`;
  }

  return color;
}

function lengthValue(value: string) {
  if (spacing[value]) {
    return spacingValue(value);
  }

  if (fractionLengths[value]) {
    return fractionLengths[value];
  }

  if (value === "auto") {
    return "auto";
  }

  if (value === "screen") {
    return "100vw";
  }

  if (value === "svw") {
    return "100svw";
  }

  if (value === "screen-h") {
    return "100vh";
  }

  if (value === "px") {
    return "1px";
  }

  if (value === "none") {
    return "none";
  }

  return value;
}

function parseArbitraryClass(token: string, style: Record<string, string>) {
  const match = token.match(/^\[(.+):(.+)\]$/);

  if (!match) {
    return;
  }

  style[match[1]] = match[2].replace(/_/g, " ");
}

function appendTransform(
  style: Record<string, string>,
  transformValue: string
) {
  if (!style.transform) {
    style.transform = transformValue;
    return;
  }

  if (!style.transform.includes(transformValue)) {
    style.transform = `${style.transform} ${transformValue}`.trim();
  }
}

function parseResponsiveToken(token: string) {
  const match = token.match(/^(sm|md|lg|xl):(.*)$/);

  if (!match) {
    return null;
  }

  return {
    breakpoint: match[1],
    token: match[2]
  };
}

function escapeCssClassName(token: string) {
  return token.replace(/(^[^a-zA-Z_]|[^a-zA-Z0-9_-])/g, (match) => `\\${match}`);
}

function classToStyle(token: string, className = ""): Record<string, string> {
  const style: Record<string, string> = {};

  parseArbitraryClass(token, style);

  if (token === "relative") add(style, "position", "relative");
  if (token === "absolute") add(style, "position", "absolute");
  if (token === "sticky") add(style, "position", "sticky");
  if (token === "container") {
    add(style, "width", "100%");
    add(style, "margin-left", "auto");
    add(style, "margin-right", "auto");
  }
  if (token === "top-0") add(style, "top", "0");
  if (token === "right-0") add(style, "right", "0");
  if (token === "bottom-0") add(style, "bottom", "0");
  if (token === "left-0") add(style, "left", "0");
  if (token === "top-1/2") add(style, "top", "50%");
  if (token === "right-1/2") add(style, "right", "50%");
  if (token === "bottom-1/2") add(style, "bottom", "50%");
  if (token === "inset-0") add(style, "inset", "0");
  if (token === "-inset-4") add(style, "inset", "-1rem");
  if (token === "-inset-8") add(style, "inset", "-2rem");
  if (token === "-top-3") add(style, "top", "-0.75rem");
  if (token === "left-1/2") add(style, "left", "50%");
  if (token === "translate-x-1/2") appendTransform(style, "translateX(50%)");
  if (token === "-translate-x-1/2") appendTransform(style, "translateX(-50%)");
  if (token === "translate-y-1/2") appendTransform(style, "translateY(50%)");
  if (token === "-translate-y-1/2") appendTransform(style, "translateY(-50%)");
  if (token === "hidden" && !/\b(?:sm|md|lg|xl):(?:flex|grid|block|inline-flex)\b/.test(className)) {
    add(style, "display", "none");
  }
  if (token === "block") add(style, "display", "block");
  if (token === "inline") add(style, "display", "inline");
  if (token === "inline-block") add(style, "display", "inline-block");
  if (token === "inline-flex") add(style, "display", "inline-flex");
  if (token === "flex") add(style, "display", "flex");
  if (token === "flex-1") add(style, "flex", "1 1 0%");
  if (token === "flex-col") add(style, "flex-direction", "column");
  if (token === "flex-wrap") add(style, "flex-wrap", "wrap");
  if (token === "grid") add(style, "display", "grid");
  if (token === "contents") add(style, "display", "contents");
  if (token === "overflow-hidden") add(style, "overflow", "hidden");
  if (token === "overflow-auto") add(style, "overflow", "auto");
  if (token === "overflow-visible") add(style, "overflow", "visible");
  if (token === "grow") add(style, "flex-grow", "1");
  if (token === "grow-0") add(style, "flex-grow", "0");
  if (token === "shrink-0") add(style, "flex-shrink", "0");
  if (token === "aspect-square") add(style, "aspect-ratio", "1 / 1");
  if (token === "float-right") add(style, "float", "right");
  if (token === "whitespace-nowrap") add(style, "white-space", "nowrap");
  if (token === "cursor-pointer") add(style, "cursor", "pointer");
  if (token === "pointer-events-none") add(style, "pointer-events", "none");
  if (token === "pointer-events-auto") add(style, "pointer-events", "auto");
  if (token === "blur-2xl") add(style, "filter", "blur(40px)");
  if (token === "blur-3xl") add(style, "filter", "blur(64px)");
  if (token === "drop-shadow-2xl") add(style, "filter", "drop-shadow(0 25px 25px rgba(0,0,0,0.15))");
  if (token === "w-full") add(style, "width", "100%");
  if (token === "w-screen") add(style, "width", "100vw");
  if (token === "w-auto") add(style, "width", "auto");
  if (token === "min-w-0") add(style, "min-width", "0");
  if (token === "min-w-full") add(style, "min-width", "100%");
  if (token === "max-w-none") add(style, "max-width", "none");
  if (token === "h-full") add(style, "height", "100%");
  if (token === "h-screen") add(style, "height", "100vh");
  if (token === "h-auto") add(style, "height", "auto");
  if (token === "min-h-screen") add(style, "min-height", "100vh");
  if (token === "max-h-none") add(style, "max-height", "none");
  if (token === "mx-auto") {
    add(style, "margin-left", "auto");
    add(style, "margin-right", "auto");
  }
  if (token === "items-center") add(style, "align-items", "center");
  if (token === "items-start") add(style, "align-items", "flex-start");
  if (token === "items-end") add(style, "align-items", "flex-end");
  if (token === "items-stretch") add(style, "align-items", "stretch");
  if (token === "items-baseline") add(style, "align-items", "baseline");
  if (token === "self-center") add(style, "align-self", "center");
  if (token === "self-start") add(style, "align-self", "flex-start");
  if (token === "self-end") add(style, "align-self", "flex-end");
  if (token === "self-stretch") add(style, "align-self", "stretch");
  if (token === "justify-start") add(style, "justify-content", "flex-start");
  if (token === "justify-center") add(style, "justify-content", "center");
  if (token === "justify-between") add(style, "justify-content", "space-between");
  if (token === "justify-end") add(style, "justify-content", "flex-end");
  if (token === "place-items-center") add(style, "place-items", "center");
  if (token === "text-center") add(style, "text-align", "center");
  if (token === "text-left") add(style, "text-align", "left");
  if (token === "uppercase") add(style, "text-transform", "uppercase");
  if (token === "tracking-tight") add(style, "letter-spacing", "-0.025em");
  if (token === "tracking-wider") add(style, "letter-spacing", "0.05em");
  if (token === "leading-none") add(style, "line-height", "1");
  if (token === "leading-tight") add(style, "line-height", "1.25");
  if (token === "leading-relaxed") add(style, "line-height", "1.625");
  if (token === "object-cover") add(style, "object-fit", "cover");
  if (token === "object-contain") add(style, "object-fit", "contain");
  if (token === "backdrop-blur-md") add(style, "backdrop-filter", "blur(12px)");
  if (token === "transition") add(style, "transition", "all 150ms ease");
  if (token === "bg-gradient-to-r") {
    add(
      style,
      "background-image",
      `linear-gradient(to right, var(--converter-gradient-from, ${asHslColor("--primary")}), var(--converter-gradient-to, ${asHslColor("--primary-glow")}))`
    );
  }
  if (token === "bg-clip-text") add(style, "-webkit-background-clip", "text");
  if (token === "bg-clip-text") add(style, "background-clip", "text");
  if (token === "text-transparent") add(style, "color", "transparent");
  if (token === "text-balance") add(style, "text-wrap", "balance");

  const maxWidth = token.match(/^max-w-(md|lg|xl|2xl|3xl|4xl|5xl|6xl)$/);
  if (maxWidth) {
    const values: Record<string, string> = {
      md: "28rem",
      lg: "32rem",
      xl: "36rem",
      "2xl": "42rem",
      "3xl": "48rem",
      "4xl": "56rem",
      "5xl": "64rem",
      "6xl": "72rem"
    };
    add(style, "max-width", values[maxWidth[1]]);
  }

  const arbitraryTracking = token.match(/^tracking-\[(.+)\]$/);
  if (arbitraryTracking) add(style, "letter-spacing", arbitraryTracking[1]);

  const arbitraryLeading = token.match(/^leading-\[(.+)\]$/);
  if (arbitraryLeading) add(style, "line-height", arbitraryLeading[1]);

  const arbitraryWidth = token.match(/^w-\[(.+)\]$/);
  if (arbitraryWidth) add(style, "width", arbitraryWidth[1]);

  const arbitraryMinWidth = token.match(/^min-w-\[(.+)\]$/);
  if (arbitraryMinWidth) add(style, "min-width", arbitraryMinWidth[1]);

  const arbitraryHeight = token.match(/^h-\[(.+)\]$/);
  if (arbitraryHeight) add(style, "height", arbitraryHeight[1]);

  const arbitrarySize = token.match(/^size-\[(.+)\]$/);
  if (arbitrarySize) {
    add(style, "width", arbitrarySize[1]);
    add(style, "height", arbitrarySize[1]);
  }

  const arbitraryMaxWidth = token.match(/^max-w-\[(.+)\]$/);
  if (arbitraryMaxWidth) add(style, "max-width", arbitraryMaxWidth[1]);

  const arbitraryMaxHeight = token.match(/^max-h-\[(.+)\]$/);
  if (arbitraryMaxHeight) add(style, "max-height", arbitraryMaxHeight[1]);

  const arbitraryMinHeight = token.match(/^min-h-\[(.+)\]$/);
  if (arbitraryMinHeight) add(style, "min-height", arbitraryMinHeight[1]);

  const arbitraryText = token.match(/^text-\[(.+)\]$/);
  if (arbitraryText) {
    const value = arbitraryText[1].replace(/_/g, " ");

    if (/^#|^(?:rgb|hsl)a?\(|^var\(|^[a-z-]+$/i.test(value)) {
      add(style, "color", value);
    } else {
      add(style, "font-size", value);
    }
  }

  const arbitraryBackground = token.match(/^bg-\[(.+)\]$/);
  if (arbitraryBackground) add(style, "background", arbitraryBackground[1].replace(/_/g, " "));

  const arbitraryTranslateY = token.match(/^translate-y-\[(.+)\]$/);
  if (arbitraryTranslateY) appendTransform(style, `translateY(${arbitraryTranslateY[1]})`);

  const arbitraryTranslateX = token.match(/^translate-x-\[(.+)\]$/);
  if (arbitraryTranslateX) appendTransform(style, `translateX(${arbitraryTranslateX[1]})`);

  const opacity = token.match(/^opacity-(\d{1,3})$/);
  if (opacity) add(style, "opacity", String(Number(opacity[1]) / 100));

  const width = token.match(/^w-(.+)$/);
  if (width) {
    const widthValue = lengthValue(width[1]);

    if (widthValue !== width[1] || spacing[width[1]]) {
      add(style, "width", widthValue);
    }
  }

  const height = token.match(/^h-(.+)$/);
  if (height) {
    const heightValue = lengthValue(height[1]);

    if (heightValue !== height[1] || spacing[height[1]]) {
      add(style, "height", heightValue);
    }
  }

  const minWidth = token.match(/^min-w-(.+)$/);
  if (minWidth) {
    const minWidthValue = lengthValue(minWidth[1]);

    if (minWidthValue !== minWidth[1] || spacing[minWidth[1]]) {
      add(style, "min-width", minWidthValue);
    }
  }

  const minHeight = token.match(/^min-h-(.+)$/);
  if (minHeight) {
    const minHeightValue = lengthValue(minHeight[1]);

    if (minHeightValue !== minHeight[1] || spacing[minHeight[1]]) {
      add(style, "min-height", minHeightValue);
    }
  }

  const maxHeight = token.match(/^max-h-(.+)$/);
  if (maxHeight) {
    const maxHeightValue = lengthValue(maxHeight[1]);

    if (maxHeightValue !== maxHeight[1] || spacing[maxHeight[1]]) {
      add(style, "max-height", maxHeightValue);
    }
  }

  const gap = token.match(/^gap(?:-([xy]))?-(.+)$/);
  if (gap) {
    if (gap[1] === "x") add(style, "column-gap", spacingValue(gap[2]));
    else if (gap[1] === "y") add(style, "row-gap", spacingValue(gap[2]));
    else add(style, "gap", spacingValue(gap[2]));
  }

  const padding = token.match(/^p([tblrxy]?)-(.+)$/);
  if (padding) {
    const value = spacingValue(padding[2]);
    if (padding[1] === "") add(style, "padding", value);
    if (padding[1] === "t") add(style, "padding-top", value);
    if (padding[1] === "b") add(style, "padding-bottom", value);
    if (padding[1] === "l") add(style, "padding-left", value);
    if (padding[1] === "r") add(style, "padding-right", value);
    if (padding[1] === "x") {
      add(style, "padding-left", value);
      add(style, "padding-right", value);
    }
    if (padding[1] === "y") {
      add(style, "padding-top", value);
      add(style, "padding-bottom", value);
    }
  }

  const margin = token.match(/^m([tblrxy]?)-(.+)$/);
  if (margin) {
    const value = margin[2].startsWith("-")
      ? negativeSpacing[margin[2].slice(1)] ?? `-${spacingValue(margin[2].slice(1))}`
      : spacingValue(margin[2]);
    const side = margin[1];
    if (side === "") add(style, "margin", value);
    if (side === "t") add(style, "margin-top", value);
    if (side === "b") add(style, "margin-bottom", value);
    if (side === "l") add(style, "margin-left", value);
    if (side === "r") add(style, "margin-right", value);
    if (side === "x") {
      add(style, "margin-left", value);
      add(style, "margin-right", value);
    }
    if (side === "y") {
      add(style, "margin-top", value);
      add(style, "margin-bottom", value);
    }
  }

  const text = token.match(/^text-(.+)$/);
  if (text) {
    if (textSizes[text[1]]) add(style, "font-size", textSizes[text[1]]);
    else if (text[1] === "transparent") add(style, "color", "transparent");
    else add(style, "color", colorValue(text[1]));
  }

  const bg = token.match(/^bg-(.+)$/);
  if (bg && token !== "bg-gradient-to-r" && token !== "bg-clip-text") {
    add(style, "background", colorValue(bg[1]));
  }

  const gradientFrom = token.match(/^from-(.+)$/);
  if (gradientFrom) add(style, "--converter-gradient-from", colorValue(gradientFrom[1]));

  const gradientTo = token.match(/^to-(.+)$/);
  if (gradientTo) add(style, "--converter-gradient-to", colorValue(gradientTo[1]));

  const rounded = token.match(/^rounded(?:-(.+))?$/);
  if (rounded) add(style, "border-radius", radius[rounded[1] ?? "md"] ?? "0.375rem");

  const font = token.match(/^font-(.+)$/);
  if (font) {
    if (font[1] === "sans") add(style, "font-family", "var(--font-sans, Inter, system-ui, sans-serif)");
    else if (font[1] === "serif" || font[1] === "display") {
      add(style, "font-family", 'var(--font-display, "Playfair Display", Georgia, serif)');
    }
    else add(style, "font-weight", fontWeights[font[1]]);
  }

  const borderColor = token.match(/^border-(?![tblr]$)(.+)$/);
  if (borderColor) {
    add(style, "border-color", colorValue(borderColor[1]));
  }

  const border = token.match(/^border(?:-([tblr]))?$/);
  if (border) {
    add(style, "border-style", "solid");
    add(
      style,
      "border-width",
      border[1] === "b"
        ? "0 0 1px 0"
        : border[1] === "t"
          ? "1px 0 0 0"
          : border[1] === "l"
            ? "0 0 0 1px"
            : border[1] === "r"
              ? "0 1px 0 0"
              : "1px"
    );
    add(style, "border-color", "var(--border)");
  }

  const shadow = token.match(/^shadow(?:-(.+))?$/);
  if (shadow) {
    add(
      style,
      "box-shadow",
      shadow[1] === "elegant"
        ? "var(--shadow-elegant, 0 30px 80px -20px rgba(150, 50, 50, 0.25))"
        : "var(--shadow-soft, 0 10px 40px -10px rgba(150, 50, 50, 0.15))"
    );
  }

  const gridCols = token.match(/^grid-cols-(\d+)$/);
  if (gridCols) add(style, "grid-template-columns", `repeat(${gridCols[1]}, minmax(0, 1fr))`);

  const colSpan = token.match(/^col-span-(\d+|full)$/);
  if (colSpan) {
    add(
      style,
      "grid-column",
      colSpan[1] === "full" ? "1 / -1" : `span ${colSpan[1]} / span ${colSpan[1]}`
    );
  }

  const fill = token.match(/^fill-(.+)$/);
  if (fill) add(style, "fill", colorValue(fill[1]));

  const stroke = token.match(/^stroke-(.+)$/);
  if (stroke) {
    if (/^\[.+\]$/.test(stroke[1])) {
      add(style, "stroke-width", stroke[1].slice(1, -1));
    } else if (/^(?:0|1|2)$/.test(stroke[1])) {
      add(style, "stroke-width", stroke[1]);
    } else {
      add(style, "stroke", colorValue(stroke[1]));
    }
  }

  const zIndex = token.match(/^z-(\d+)$/);
  if (zIndex) add(style, "z-index", zIndex[1]);

  const size = token.match(/^size-(.+)$/);
  if (size) {
    const sizeValue = lengthValue(size[1]);

    if (sizeValue !== size[1] || spacing[size[1]]) {
      add(style, "width", sizeValue);
      add(style, "height", sizeValue);
    }
  }

  return style;
}

function styleToString(style: Record<string, string>, important = false) {
  return Object.entries(style)
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}:${value}${important ? " !important" : ""}`)
    .join(";");
}

function mergeStyle(existing: string | undefined, additions: Record<string, string>) {
  const additionString = styleToString(additions);

  if (!additionString) return existing ?? "";
  if (!existing) return additionString;

  return `${existing};${additionString}`;
}

export function inlineLovableStyles(html: string): string {
  const $ = cheerio.load(html);
  const responsiveRules: Record<string, Set<string>> = {
    sm: new Set<string>(),
    md: new Set<string>(),
    lg: new Set<string>(),
    xl: new Set<string>()
  };

  $("[class]").each((_, element) => {
    const node = $(element as Element);
    const className = node.attr("class") ?? "";
    const normalizedClassName = className
      .replace(/&amp;/g, "&")
      .replace(/&gt;/g, ">");
    const style = className
      .split(/\s+/)
      .filter(Boolean)
      .reduce<Record<string, string>>((acc, token) => {
        const responsiveToken = parseResponsiveToken(token);

        if (responsiveToken) {
          const responsiveStyle = classToStyle(responsiveToken.token, className);
          const responsiveDeclaration = styleToString(responsiveStyle, true);

          if (responsiveDeclaration) {
            responsiveRules[responsiveToken.breakpoint].add(
              `.${escapeCssClassName(token)}{${responsiveDeclaration}}`
            );
          }

          return acc;
        }

        if (token.includes(":") && !token.startsWith("[")) {
          return acc;
        }

        Object.assign(acc, classToStyle(token, className));
        return acc;
      }, {});

    if (normalizedClassName.includes("md:[&>div:first-child]:order-2")) {
      node.attr("data-first-child-order-md", "2");
    }

    const mergedStyle = mergeStyle(node.attr("style"), style);

    if (mergedStyle) node.attr("style", mergedStyle);
  });

  const generatedResponsiveCss = Object.entries(responsiveRules)
    .map(([breakpoint, rules]) => {
      if (rules.size === 0) {
        return "";
      }

      return `@media (min-width: ${responsiveBreakpoints[breakpoint]}) {\n${[
        ...rules
      ].join("\n")}\n}`;
    })
    .filter(Boolean)
    .join("\n");

  if (generatedResponsiveCss) {
    if (!$("html").length) {
      $.root().append("<html><head></head><body></body></html>");
    }

    if (!$("head").length) {
      $("html").prepend("<head></head>");
    }

    $("head").append(
      `<style data-converter-v3-generated-responsive>${generatedResponsiveCss}</style>`
    );
  }

  return $.html();
}

export function getLovableBaseCss() {
  return `<style>
:root {
  --font-sans: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --font-display: "Playfair Display", Georgia, serif;
  --background: 0 0% 100%;
  --foreground: 222.2 84% 4.9%;
  --card: 0 0% 100%;
  --card-foreground: 222.2 84% 4.9%;
  --popover: 0 0% 100%;
  --popover-foreground: 222.2 84% 4.9%;
  --primary: 222.2 47.4% 11.2%;
  --primary-foreground: 210 40% 98%;
  --primary-deep: 222.2 47.4% 11.2%;
  --primary-glow: 224.3 76.3% 48%;
  --secondary: 210 40% 96.1%;
  --secondary-foreground: 222.2 47.4% 11.2%;
  --muted: 210 40% 96.1%;
  --muted-foreground: 215.4 16.3% 46.9%;
  --destructive: 0 84.2% 60.2%;
  --destructive-foreground: 210 40% 98%;
  --border: 214.3 31.8% 91.4%;
  --input: 214.3 31.8% 91.4%;
  --ring: 215 20.2% 65.1%;
  --cream: 44 100% 96%;
  --gold: 43 96% 56%;
  --accent: 210 40% 96.1%;
  --accent-foreground: 222.2 47.4% 11.2%;
  --gradient-hero: linear-gradient(135deg, #ffd4df 0%, #ffbccd 50%, #ffadbf 100%);
  --shadow-elegant: 0 30px 80px -20px rgba(150, 50, 50, 0.25);
  --shadow-soft: 0 10px 40px -10px rgba(150, 50, 50, 0.15);
}
html, body {
  margin: 0;
  padding: 0;
  width: 100%;
  min-height: 100%;
}
img, video {
  display: block;
  vertical-align: middle;
  max-width: 100%;
  height: auto;
}
svg {
  display: block;
  flex: none;
}
body {
  font-family: var(--font-sans);
  background-color: var(--color-background, hsl(var(--background)));
  color: var(--color-foreground, hsl(var(--foreground)));
}
.container {
  width: 100%;
  margin-left: auto;
  margin-right: auto;
}
.hidden { display: none; }
.space-y-3 > :not([hidden]) ~ :not([hidden]) { margin-top: 0.75rem; }
.space-y-20 > :not([hidden]) ~ :not([hidden]) { margin-top: 5rem; }
.divide-y > :not([hidden]) ~ :not([hidden]) { border-top: 1px solid var(--border); }
.md\\:flex { display: flex; }
.md\\:grid-cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.md\\:grid-cols-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.sm\\:grid-cols-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.lg\\:grid-cols-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.md\\:items-center { align-items: center; }
.md\\:py-28 { padding-top: 7rem; padding-bottom: 7rem; }
.md\\:h-16 { height: 4rem; }
.md\\:h-24 { height: 6rem; }
.md\\:text-5xl { font-size: 3rem; }
.md\\:text-6xl { font-size: 3.75rem; }
.md\\:text-7xl { font-size: 4.5rem; }
.md\\:text-4xl { font-size: 2.25rem; }
.lg\\:text-8xl { font-size: 6rem; }
@media (min-width: 640px) {
  .container { max-width: 640px; }
}
@media (min-width: 768px) {
  .container { max-width: 768px; }
  [data-first-child-order-md="2"] > :first-child { order: 2; }
}
@media (min-width: 1024px) {
  .container { max-width: 1024px; }
}
@media (min-width: 1280px) {
  .container { max-width: 1280px; }
}
@media (min-width: 1536px) {
  .container { max-width: 1536px; }
}
@media (max-width: 767px) {
  .hidden.md\\:flex { display: none; }
  .md\\:flex { display: none; }
  .md\\:grid-cols-2, .md\\:grid-cols-3 { grid-template-columns: 1fr; }
  .sm\\:grid-cols-3, .lg\\:grid-cols-4 { grid-template-columns: 1fr; }
  .md\\:text-5xl, .md\\:text-6xl, .md\\:text-7xl, .lg\\:text-8xl { font-size: clamp(2rem, 12vw, 3.5rem); }
  [data-first-child-order-md="2"] > :first-child { order: 0; }
}
</style>`;
}
