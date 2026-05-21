import * as cheerio from "cheerio";
import type { Element } from "domhandler";

const colorVars: Record<string, string> = {
  background: "var(--background)",
  foreground: "var(--foreground)",
  card: "var(--card)",
  "card-foreground": "var(--card-foreground)",
  primary: "var(--primary)",
  "primary-foreground": "var(--primary-foreground)",
  "primary-deep": "var(--primary-deep)",
  "primary-glow": "var(--primary-glow)",
  muted: "var(--muted)",
  "muted-foreground": "var(--muted-foreground)",
  border: "var(--border)",
  cream: "var(--cream)",
  gold: "var(--gold)",
  accent: "var(--accent)"
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
  "28": "7rem"
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
  "8xl": "6rem"
};

const fontWeights: Record<string, string> = {
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

function add(style: Record<string, string>, property: string, value?: string) {
  if (value) {
    style[property] = value;
  }
}

function spacingValue(value: string) {
  return spacing[value] ?? value;
}

function colorValue(value: string) {
  const [name, alpha] = value.split("/");
  const color = colorVars[name] ?? name;

  if (!alpha) {
    return color;
  }

  return `color-mix(in oklab, ${color} ${Number(alpha)}%, transparent)`;
}

function parseArbitraryClass(token: string, style: Record<string, string>) {
  const match = token.match(/^\[(.+):(.+)\]$/);

  if (!match) {
    return;
  }

  style[match[1]] = match[2].replace(/_/g, " ");
}

function classToStyle(token: string, className = ""): Record<string, string> {
  const style: Record<string, string> = {};

  parseArbitraryClass(token, style);

  if (token === "relative") add(style, "position", "relative");
  if (token === "absolute") add(style, "position", "absolute");
  if (token === "sticky") add(style, "position", "sticky");
  if (token === "top-0") add(style, "top", "0");
  if (token === "inset-0") add(style, "inset", "0");
  if (token === "-inset-4") add(style, "inset", "-1rem");
  if (token === "-inset-8") add(style, "inset", "-2rem");
  if (token === "-top-3") add(style, "top", "-0.75rem");
  if (token === "left-1/2") add(style, "left", "50%");
  if (token === "-translate-x-1/2") add(style, "transform", "translateX(-50%)");
  if (token === "z-50") add(style, "z-index", "50");
  if (token === "hidden" && !/\b(?:sm|md|lg|xl):(?:flex|grid|block|inline-flex)\b/.test(className)) {
    add(style, "display", "none");
  }
  if (token === "block") add(style, "display", "block");
  if (token === "inline-flex") add(style, "display", "inline-flex");
  if (token === "flex") add(style, "display", "flex");
  if (token === "flex-col") add(style, "flex-direction", "column");
  if (token === "flex-wrap") add(style, "flex-wrap", "wrap");
  if (token === "grid") add(style, "display", "grid");
  if (token === "contents") add(style, "display", "contents");
  if (token === "overflow-hidden") add(style, "overflow", "hidden");
  if (token === "shrink-0") add(style, "flex-shrink", "0");
  if (token === "aspect-square") add(style, "aspect-ratio", "1 / 1");
  if (token === "float-right") add(style, "float", "right");
  if (token === "opacity-30") add(style, "opacity", "0.3");
  if (token === "blur-2xl") add(style, "filter", "blur(40px)");
  if (token === "blur-3xl") add(style, "filter", "blur(64px)");
  if (token === "drop-shadow-2xl") add(style, "filter", "drop-shadow(0 25px 25px rgba(0,0,0,0.15))");
  if (token === "w-full") add(style, "width", "100%");
  if (token === "w-auto") add(style, "width", "auto");
  if (token === "h-full") add(style, "height", "100%");
  if (token === "h-auto") add(style, "height", "auto");
  if (token === "min-h-screen") add(style, "min-height", "100vh");
  if (token === "mx-auto") {
    add(style, "margin-left", "auto");
    add(style, "margin-right", "auto");
  }
  if (token === "items-center") add(style, "align-items", "center");
  if (token === "items-start") add(style, "align-items", "flex-start");
  if (token === "items-baseline") add(style, "align-items", "baseline");
  if (token === "justify-center") add(style, "justify-content", "center");
  if (token === "justify-between") add(style, "justify-content", "space-between");
  if (token === "text-center") add(style, "text-align", "center");
  if (token === "text-left") add(style, "text-align", "left");
  if (token === "uppercase") add(style, "text-transform", "uppercase");
  if (token === "tracking-tight") add(style, "letter-spacing", "-0.025em");
  if (token === "tracking-wider") add(style, "letter-spacing", "0.05em");
  if (token === "leading-tight") add(style, "line-height", "1.25");
  if (token === "leading-relaxed") add(style, "line-height", "1.625");
  if (token === "object-cover") add(style, "object-fit", "cover");
  if (token === "backdrop-blur-md") add(style, "backdrop-filter", "blur(12px)");
  if (token === "transition") add(style, "transition", "all 150ms ease");
  if (token === "bg-gradient-to-r") add(style, "background-image", "linear-gradient(to right, var(--primary), var(--primary-glow))");
  if (token === "bg-clip-text") add(style, "-webkit-background-clip", "text");
  if (token === "bg-clip-text") add(style, "background-clip", "text");
  if (token === "text-transparent") add(style, "color", "var(--primary)");

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

  const width = token.match(/^w-(.+)$/);
  if (width && spacing[width[1]]) add(style, "width", spacingValue(width[1]));

  const height = token.match(/^h-(.+)$/);
  if (height && spacing[height[1]]) add(style, "height", spacingValue(height[1]));

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
    else if (text[1] === "transparent") add(style, "color", "var(--primary)");
    else add(style, "color", colorValue(text[1]));
  }

  const bg = token.match(/^bg-(.+)$/);
  if (bg) add(style, "background", colorValue(bg[1]));

  const rounded = token.match(/^rounded(?:-(.+))?$/);
  if (rounded) add(style, "border-radius", radius[rounded[1] ?? "md"] ?? "0.375rem");

  const font = token.match(/^font-(.+)$/);
  if (font) {
    if (font[1] === "sans") add(style, "font-family", "Inter, system-ui, sans-serif");
    else if (font[1] === "serif" || font[1] === "display") add(style, "font-family", "Georgia, serif");
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
        ? "0 30px 80px -20px rgba(150, 50, 50, 0.25)"
        : "0 10px 40px -10px rgba(150, 50, 50, 0.15)"
    );
  }

  const gridCols = token.match(/^grid-cols-(\d+)$/);
  if (gridCols) add(style, "grid-template-columns", `repeat(${gridCols[1]}, minmax(0, 1fr))`);

  return style;
}

function styleToString(style: Record<string, string>) {
  return Object.entries(style)
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}:${value}`)
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

  $("[class]").each((_, element) => {
    const node = $(element as Element);
    const className = node.attr("class") ?? "";
    const normalizedClassName = className
      .replace(/&amp;/g, "&")
      .replace(/&gt;/g, ">");
    const style = className
      .split(/\s+/)
      .filter(Boolean)
      .filter((token) => !token.includes(":"))
      .reduce<Record<string, string>>((acc, token) => {
        Object.assign(acc, classToStyle(token, className));
        return acc;
      }, {});

    if (normalizedClassName.includes("md:[&>div:first-child]:order-2")) {
      node.attr("data-first-child-order-md", "2");
    }

    const mergedStyle = mergeStyle(node.attr("style"), style);

    if (mergedStyle) node.attr("style", mergedStyle);
  });

  return $.html();
}

export function getLovableBaseCss() {
  return `<style>
:root {
  --font-sans: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --font-display: "Playfair Display", Georgia, serif;
  --background: #faf6f1;
  --foreground: #331f1d;
  --card: #fffaf5;
  --card-foreground: #331f1d;
  --primary: #b43f3c;
  --primary-foreground: #fffaf5;
  --primary-deep: #7d2928;
  --primary-glow: #df7168;
  --muted: #f4ebe4;
  --muted-foreground: #715b56;
  --border: #e5d6cc;
  --cream: #f7efd9;
  --gold: #d5a030;
  --accent: #fff2f4;
  --gradient-hero: linear-gradient(135deg, #ffd4df 0%, #ffbccd 50%, #ffadbf 100%);
}
img, video {
  display: block;
  vertical-align: middle;
  max-width: 100%;
  height: auto;
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
@media (min-width: 768px) {
  [data-first-child-order-md="2"] > :first-child { order: 2; }
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
