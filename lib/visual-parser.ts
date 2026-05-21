import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import postcss from "postcss";

import { getLovableBaseCss, inlineLovableStyles } from "@/lib/tailwind";
import type { BrowserRenderedPage, VisualLayoutBox } from "@/lib/visual-renderer";

export type VisualAsset = {
  type: "image" | "font" | "stylesheet";
  source: string;
  location: "external" | "local" | "embedded";
  alt?: string;
  usage: "content" | "background" | "font" | "stylesheet";
};

export type VisualTokens = {
  colors: string[];
  gradients: string[];
  fonts: string[];
  spacing: string[];
};

export type RenderedDomNode = {
  id: string;
  tag: string;
  attributes: Record<string, string>;
  className: string;
  text: string;
  layout: VisualLayoutBox | null;
  computedStyles: Record<string, string>;
  children: RenderedDomNode[];
};

export type VisualImageGroup = {
  parentId: string;
  parentTag: string;
  parentClassName: string;
  childOrder: string[];
  images: Array<{
    id: string;
    source: string;
    alt: string;
    childIndex: number;
    nearestHeading: string;
    imageKind: string;
    aspectRatio: string;
    layout: VisualLayoutBox | null;
  }>;
};

export type VisualBlock = {
  id: string;
  tag: string;
  role: string;
  className: string;
  inlineStyle: string;
  html: string;
  normalizedHtml: string;
  text: string;
  layout: VisualLayoutBox | null;
  images: VisualAsset[];
  imageGroups: VisualImageGroup[];
  styles: Record<string, string>;
  computedStyles: Record<string, string>;
  dom: RenderedDomNode;
};

export type VisualDocument = {
  title: string;
  html: string;
  renderedHtml: string;
  normalizedHtml: string;
  baseCss: string;
  globalCss: string;
  assets: VisualAsset[];
  tokens: VisualTokens;
  blocks: VisualBlock[];
  pipeline: string[];
  renderer: "puppeteer" | "server";
};

type CssRule = {
  selectors: string[];
  styles: Record<string, string>;
  specificity: number;
  order: number;
};

type RenderedVisualDom = {
  $: cheerio.CheerioAPI;
  renderedHtml: string;
  globalCss: string;
  rules: CssRule[];
  layoutMap: Record<string, VisualLayoutBox>;
};

function cleanText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function getLocation(source: string): VisualAsset["location"] {
  if (source.startsWith("data:")) return "embedded";
  if (/^https?:\/\//i.test(source) || source.startsWith("//")) return "external";
  return "local";
}

function parseStyle(style: string | undefined): Record<string, string> {
  if (!style) return {};

  return style
    .split(";")
    .map((declaration) => declaration.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((styles, declaration) => {
      const separator = declaration.indexOf(":");

      if (separator === -1) return styles;

      const property = declaration.slice(0, separator).trim().toLowerCase();
      const value = declaration.slice(separator + 1).trim();

      if (property && value) {
        styles[property] = value;
      }

      return styles;
    }, {});
}

function styleToString(style: Record<string, string>): string {
  return Object.entries(style)
    .filter(([, value]) => value)
    .map(([property, value]) => `${property}:${value}`)
    .join(";");
}

function normalizeComputedStyleForElementor(
  tag: string,
  className: string,
  style: Record<string, string>,
  attributes: Record<string, string> = {}
): Record<string, string> {
  const normalized = { ...style };
  const classes = new Set(className.split(/\s+/).filter(Boolean));
  const isMedia = ["img", "video", "svg", "canvas", "picture"].includes(tag);
  const isHeading = /^h[1-6]$/.test(tag);

  if (!isMedia) {
    delete normalized.width;
    delete normalized.height;
  }

  if (normalized["max-width"] === "none") delete normalized["max-width"];
  if (normalized["min-height"] === "0px" || normalized["min-height"] === "auto") {
    delete normalized["min-height"];
  }

  if (classes.has("min-h-screen")) {
    normalized["min-height"] = "100vh";
  }

  if (classes.has("w-full")) {
    normalized.width = "100%";
  }

  if (classes.has("w-auto")) {
    normalized.width = "auto";
  }

  const heightClass = [...classes].find((token) => /^h-(?:\d+(?:\.\d+)?|full|auto)$/.test(token));
  if (heightClass) {
    const value = heightClass.replace(/^h-/, "");

    if (value === "full") normalized.height = "100%";
    else if (value === "auto") normalized.height = "auto";
    else normalized.height = spacingToRem(value);
  }

  if (
    normalized["grid-template-columns"]?.includes("px") &&
    [...classes].some((token) => token.includes("grid-cols-"))
  ) {
    delete normalized["grid-template-columns"];
  }

  if (normalized["grid-template-rows"] === "none" || normalized["grid-template-rows"]?.includes("px")) {
    delete normalized["grid-template-rows"];
  }

  if (normalized["font-family"] === '"Times New Roman"' || normalized["font-family"] === "Times New Roman") {
    delete normalized["font-family"];
  }

  if (isHeading) {
    normalizeHeadingStyles(tag, normalized, attributes);
  }

  if (isMedia) {
    normalizeImageStyles(normalized, attributes, classes);
  }

  for (const property of Object.keys(normalized)) {
    if (normalized[property] === "normal" || normalized[property] === "none") {
      if (["gap", "row-gap", "column-gap", "box-shadow"].includes(property)) {
        delete normalized[property];
      }
    }
  }

  return normalized;
}

function normalizeImageStyles(
  style: Record<string, string>,
  attributes: Record<string, string>,
  classes: Set<string>
): void {
  const imageKind = getImageKind(attributes, classes);
  const aspectRatio =
    attributes["data-aspect-ratio"] || getAspectRatioFromAttributes(attributes);
  const layoutWidth = parseNumber(attributes["data-layout-width"]);
  const computedMaxWidth = style["max-width"];
  const isLogoOrIcon = imageKind === "logo" || imageKind === "icon";

  if (aspectRatio) {
    style["aspect-ratio"] = aspectRatio;
  }

  if (isLogoOrIcon) {
    style.width = classes.has("w-full") ? "100%" : "auto";
    style.height = style.height && style.height !== "auto" ? style.height : "auto";
    style["object-fit"] = "contain";

    if (!computedMaxWidth || computedMaxWidth === "none") {
      style["max-width"] = layoutWidth ? `${Math.round(layoutWidth)}px` : "100%";
    }
  } else {
    style.width = "100%";
    style.height = "auto";
    style["object-fit"] = imageKind === "banner" || imageKind === "card" ? "cover" : "contain";

    if (!computedMaxWidth || computedMaxWidth === "none") {
      style["max-width"] = "100%";
    }
  }

  if (!style["object-position"] || style["object-position"] === "50% 50%") {
    style["object-position"] = attributes["data-computed-object-position"] || "center center";
  }

  // Keep responsive proportions: never lock both browser-computed width and height.
  if (style.width !== "auto" && style.height !== "auto") {
    style.height = "auto";
  }

  delete style.margin;
  delete style["margin-left"];
  delete style["margin-right"];
}

function getImageKind(
  attributes: Record<string, string>,
  classes: Set<string>
): string {
  if (attributes["data-image-kind"]) return attributes["data-image-kind"];

  const signature = `${attributes.alt ?? ""} ${attributes.class ?? ""}`.toLowerCase();
  const aspectRatio =
    parseNumber(attributes["data-aspect-ratio"]) ??
    parseNumber(getAspectRatioFromAttributes(attributes));

  if (signature.includes("logo") || signature.includes("brand") || classes.has("h-14")) {
    return "logo";
  }

  if (signature.includes("icon")) {
    return "icon";
  }

  if (signature.includes("banner") || signature.includes("hero") || (aspectRatio ?? 0) >= 2.2) {
    return "banner";
  }

  if (signature.includes("card")) {
    return "card";
  }

  return "content";
}

function getAspectRatioFromAttributes(attributes: Record<string, string>): string {
  const naturalWidth = parseNumber(attributes["data-natural-width"] || attributes.width);
  const naturalHeight = parseNumber(attributes["data-natural-height"] || attributes.height);

  if (!naturalWidth || !naturalHeight) return "";

  return String(Math.round((naturalWidth / naturalHeight) * 10000) / 10000);
}

function parseNumber(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeHeadingStyles(
  tag: string,
  style: Record<string, string>,
  attributes: Record<string, string>
): void {
  const maxFontSizes: Record<string, number> = {
    h1: 64,
    h2: 48,
    h3: 36,
    h4: 30,
    h5: 24,
    h6: 20
  };
  const computedFontSize = attributes["data-computed-font-size"] || style["font-size"];
  const computedLineHeight = attributes["data-computed-line-height"] || style["line-height"];
  const computedFontWeight = attributes["data-computed-font-weight"] || style["font-weight"];
  const computedMargin = attributes["data-computed-margin"] || style.margin;
  const fontSizePx = parsePx(computedFontSize);
  const max = maxFontSizes[tag] ?? 36;

  if (fontSizePx) {
    style["font-size"] = `${Math.min(fontSizePx, max)}px`;
  }

  if (computedLineHeight && computedLineHeight !== "normal") {
    style["line-height"] = computedLineHeight;
  } else if (fontSizePx) {
    style["line-height"] = "1.1";
  }

  if (computedFontWeight) {
    style["font-weight"] = computedFontWeight;
  }

  if (computedMargin && computedMargin !== "0px") {
    style.margin = computedMargin;
  }
}

function parsePx(value: string | undefined): number | null {
  if (!value) return null;
  const match = value.match(/^([\d.]+)px$/);

  return match ? Number(match[1]) : null;
}

function spacingToRem(value: string): string {
  const numeric = Number(value);

  if (Number.isFinite(numeric)) {
    return `${numeric / 4}rem`;
  }

  return value;
}

function getElementAttributes(node: cheerio.Cheerio<Element>): Record<string, string> {
  const attributes: Record<string, string> = {};
  const rawAttributes = node.get(0)?.attribs ?? {};

  for (const [key, value] of Object.entries(rawAttributes)) {
    attributes[key] = value;
  }

  return attributes;
}

function getLayoutFromAttributes(
  attributes: Record<string, string>
): VisualLayoutBox | null {
  const width = Number(attributes["data-layout-width"]);
  const height = Number(attributes["data-layout-height"]);
  const x = Number(attributes["data-layout-x"]);
  const y = Number(attributes["data-layout-y"]);

  if (![width, height, x, y].every(Number.isFinite)) {
    return null;
  }

  return {
    x,
    y,
    top: y,
    left: x,
    right: x + width,
    bottom: y + height,
    width,
    height,
    centerX: x + width / 2,
    centerY: y + height / 2
  };
}

function getElementLayout(
  node: cheerio.Cheerio<Element>,
  layoutMap: Record<string, VisualLayoutBox>
): VisualLayoutBox | null {
  const visualId = node.attr("data-visual-id");

  if (visualId && layoutMap[visualId]) {
    return layoutMap[visualId];
  }

  return getLayoutFromAttributes(getElementAttributes(node));
}

function getRootElements($: cheerio.CheerioAPI): Element[] {
  if ($("body").length) {
    return $("body")
      .children()
      .toArray()
      .filter((element): element is Element => element.type === "tag");
  }

  return $.root()
    .children()
    .toArray()
    .filter((element): element is Element => element.type === "tag");
}

function getVisualSections($: cheerio.CheerioAPI): Element[] {
  const bodyChildren = getRootElements($);

  if (bodyChildren.length === 1) {
    const wrapper = $(bodyChildren[0]);
    const semanticSections = wrapper
      .children("header,main,section,footer,article,nav")
      .toArray()
      .filter((element): element is Element => element.type === "tag");

    if (semanticSections.length) {
      return semanticSections;
    }

    const visualChildren = wrapper
      .children()
      .toArray()
      .filter((element): element is Element => element.type === "tag");

    if (visualChildren.length > 1) {
      return visualChildren;
    }
  }

  return bodyChildren;
}

function extractUrls(value: string): string[] {
  return [...value.matchAll(/url\((['"]?)(.*?)\1\)/g)]
    .map((match) => match[2].trim())
    .filter(Boolean);
}

function extractGlobalCss($: cheerio.CheerioAPI): string {
  const styleCss = $("style")
    .toArray()
    .map((element) => $(element).html() ?? "")
    .filter(Boolean)
    .join("\n");

  const stylesheetLinks = $('link[rel="stylesheet"][href]')
    .toArray()
    .map((element) => {
      const href = $(element).attr("href");
      return href ? `@import url("${href}");` : "";
    })
    .filter(Boolean)
    .join("\n");

  return [stylesheetLinks, styleCss].filter(Boolean).join("\n");
}

function parseCssRules(css: string): CssRule[] {
  const rules: CssRule[] = [];
  let order = 0;

  try {
    const root = postcss.parse(css);

    root.walkRules((rule) => {
      const styles: Record<string, string> = {};

      rule.walkDecls((declaration) => {
        styles[declaration.prop.toLowerCase()] = declaration.value;
      });

      const selectors = rule.selectors
        .map((selector) => selector.trim())
        .filter(Boolean);

      if (!selectors.length || !Object.keys(styles).length) {
        return;
      }

      rules.push({
        selectors,
        styles,
        specificity: Math.max(...selectors.map(getSelectorSpecificity)),
        order
      });
      order += 1;
    });
  } catch {
    const cleanedCss = css
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/@media[^{]+\{([\s\S]*?)\}\s*\}/g, "$1");
    const matches = cleanedCss.matchAll(/([^{}@]+)\{([^{}]+)\}/g);

    for (const match of matches) {
      const selectors = match[1]
        .split(",")
        .map((selector) => selector.trim())
        .filter(Boolean);
      const styles = parseStyle(match[2]);

      if (!selectors.length || !Object.keys(styles).length) {
        continue;
      }

      rules.push({
        selectors,
        styles,
        specificity: Math.max(...selectors.map(getSelectorSpecificity)),
        order
      });
      order += 1;
    }
  }

  return rules;
}

function getSelectorSpecificity(selector: string): number {
  const idCount = selector.match(/#[\w-]+/g)?.length ?? 0;
  const classCount = selector.match(/\.[\w-]+|\[[^\]]+\]/g)?.length ?? 0;
  const tagCount = selector
    .replace(/#[\w-]+|\.[\w-]+|\[[^\]]+\]|:[\w-]+(?:\([^)]*\))?/g, " ")
    .split(/\s+/)
    .filter((part) => /^[a-z][\w-]*$/i.test(part)).length;

  return idCount * 100 + classCount * 10 + tagCount;
}

function matchesSelector(node: cheerio.Cheerio<Element>, selector: string): boolean {
  const simpleSelector = selector
    .replace(/::?[\w-]+(?:\([^)]*\))?/g, "")
    .trim()
    .split(/\s+/)
    .at(-1);

  if (!simpleSelector || simpleSelector === "*") {
    return true;
  }

  const tagMatch = simpleSelector.match(/^[a-z][\w-]*/i);
  const idMatches = [...simpleSelector.matchAll(/#([\w-]+)/g)].map((match) => match[1]);
  const classMatches = [...simpleSelector.matchAll(/\.([\w-]+)/g)].map((match) => match[1]);
  const nodeTag = node.prop("tagName")?.toLowerCase();
  const nodeId = node.attr("id");
  const nodeClasses = new Set((node.attr("class") ?? "").split(/\s+/).filter(Boolean));

  if (tagMatch && tagMatch[0].toLowerCase() !== nodeTag) {
    return false;
  }

  if (idMatches.some((id) => id !== nodeId)) {
    return false;
  }

  return classMatches.every((className) => nodeClasses.has(className));
}

function computeElementStyles(
  node: cheerio.Cheerio<Element>,
  rules: CssRule[]
): Record<string, string> {
  const matchedRules = rules
    .filter((rule) => rule.selectors.some((selector) => matchesSelector(node, selector)))
    .sort((left, right) => left.specificity - right.specificity || left.order - right.order);
  const computedStyles: Record<string, string> = {};

  for (const rule of matchedRules) {
    Object.assign(computedStyles, rule.styles);
  }

  Object.assign(computedStyles, parseStyle(node.attr("style")));

  return normalizeComputedStyleForElementor(
    node.prop("tagName")?.toLowerCase() ?? "div",
    node.attr("class") ?? "",
    computedStyles,
    getElementAttributes(node)
  );
}

function renderVisualDom(
  html: string
): RenderedVisualDom {
  const inlinedHtml = inlineLovableStyles(html);
  const $ = cheerio.load(inlinedHtml);
  const globalCss = extractGlobalCss($);
  const rules = parseCssRules(globalCss);

  $("*").each((index, element) => {
    if (element.type !== "tag") return;

    const node = $(element as Element);
    const computedStyles = computeElementStyles(node, rules);

    node.attr("data-visual-id", `visual-node-${index + 1}`);

    if (Object.keys(computedStyles).length) {
      node.attr("style", styleToString(computedStyles));
    }
  });

  return {
    $,
    renderedHtml: $.html(),
    globalCss,
    rules,
    layoutMap: {}
  };
}

function normalizeRenderedDocument($: cheerio.CheerioAPI): string {
  $("script,noscript").remove();
  $("style").remove();
  normalizeElementStyles($);

  return $.html();
}

function normalizeElementStyles($: cheerio.CheerioAPI): void {
  $("[data-visual-id]").each((_, element) => {
    const node = $(element as Element);
    const rawStyle = parseStyle(node.attr("style"));

    if (/^h[1-6]$/.test(element.name.toLowerCase())) {
      node.attr("data-visual-heading-level", element.name.toLowerCase());
      if (rawStyle["font-size"] && !node.attr("data-computed-font-size")) {
        node.attr("data-computed-font-size", rawStyle["font-size"]);
      }
      if (rawStyle["line-height"] && !node.attr("data-computed-line-height")) {
        node.attr("data-computed-line-height", rawStyle["line-height"]);
      }
      if (rawStyle["font-weight"] && !node.attr("data-computed-font-weight")) {
        node.attr("data-computed-font-weight", rawStyle["font-weight"]);
      }
      if (rawStyle.margin && !node.attr("data-computed-margin")) {
        node.attr("data-computed-margin", rawStyle.margin);
      }
    }

    const style = normalizeComputedStyleForElementor(
      element.name.toLowerCase(),
      node.attr("class") ?? "",
      rawStyle,
      getElementAttributes(node)
    );
    const normalizedStyle = styleToString(style);

    if (normalizedStyle) {
      node.attr("style", normalizedStyle);
    } else {
      node.removeAttr("style");
    }
  });
}

export function groupImagesWithOriginalContainers(
  $: cheerio.CheerioAPI
): VisualImageGroup[] {
  const groups = new Map<string, VisualImageGroup>();

  $("img[src],picture").each((_, element) => {
    const image = $(element as Element);
    const parent = image.parent();

    if (!parent.length) return;

    const parentElement = parent.get(0);

    if (!parentElement || parentElement.type !== "tag") return;

    const parentId =
      parent.attr("data-visual-id") ||
      parent.attr("id") ||
      `image-parent-${groups.size + 1}`;
    const imageId =
      image.attr("data-visual-id") ||
      image.attr("id") ||
      `${parentId}-image-${groups.size + 1}`;
    const childOrder = parent
      .children()
      .toArray()
      .filter((child): child is Element => child.type === "tag")
      .map((child, childIndex) => {
        const childNode = $(child);
        const childId =
          childNode.attr("data-visual-id") ||
          childNode.attr("id") ||
          `${parentId}-child-${childIndex + 1}`;

        childNode.attr("data-original-parent-id", parentId);
        childNode.attr("data-original-child-index", String(childIndex));

        return childId;
      });
    const childIndex = childOrder.indexOf(imageId);

    parent.attr("data-image-group-parent", "true");
    parent.attr("data-visual-id", parentId);
    image.attr("data-original-parent-id", parentId);
    image.attr("data-original-child-index", String(Math.max(childIndex, 0)));

    const group =
      groups.get(parentId) ??
      {
        parentId,
        parentTag: parentElement.name.toLowerCase(),
        parentClassName: parent.attr("class") ?? "",
        childOrder,
        images: []
      };

    group.images.push({
      id: imageId,
      source: image.attr("src") ?? "",
      alt: image.attr("alt") ?? "",
      childIndex: Math.max(childIndex, 0),
      nearestHeading: image.attr("data-nearest-heading") ?? "",
      imageKind: image.attr("data-image-kind") ?? "",
      aspectRatio: image.attr("data-aspect-ratio") ?? "",
      layout: getElementLayout(image, {})
    });

    groups.set(parentId, group);
  });

  return [...groups.values()];
}

function getRole(tag: string, node: cheerio.Cheerio<Element>): string {
  const className = node.attr("class") ?? "";
  const id = node.attr("id") ?? "";
  const signature = `${tag} ${id} ${className}`.toLowerCase();

  if (tag === "header" || signature.includes("header") || signature.includes("nav")) {
    return "header";
  }

  if (tag === "footer") return "footer";
  if (signature.includes("hero")) return "hero";
  if (signature.includes("card")) return "cards";
  if (signature.includes("feature")) return "features";
  if (signature.includes("testimonial")) return "testimonials";
  if (signature.includes("pricing")) return "pricing";
  if (signature.includes("contact")) return "contact";

  return tag === "section" || tag === "main" || tag === "article"
    ? tag
    : "container";
}

function collectImageAssets(
  $: cheerio.CheerioAPI,
  scope?: cheerio.Cheerio<Element>
): VisualAsset[] {
  const assets: VisualAsset[] = [];

  const images = scope ? scope.find("img[src]") : $("img[src]");
  const sources = scope ? scope.find("source[srcset]") : $("source[srcset]");
  const styled = scope ? scope.find("[style]").add(scope.filter("[style]")) : $("[style]");

  images.each((_, element) => {
    const node = $(element as Element);
    const source = node.attr("src");

    if (!source) return;

    assets.push({
      type: "image",
      source,
      location: getLocation(source),
      alt: node.attr("alt") ?? undefined,
      usage: "content"
    });
  });

  sources.each((_, element) => {
    const sourceSet = $(element as Element).attr("srcset");
    const source = sourceSet?.split(",")[0]?.trim().split(/\s+/)[0];

    if (!source) return;

    assets.push({
      type: "image",
      source,
      location: getLocation(source),
      usage: "content"
    });
  });

  styled.each((_, element) => {
    const node = $(element as Element);
    const styles = parseStyle(node.attr("style"));
    const backgroundSources = [
      styles.background,
      styles["background-image"]
    ].flatMap((value) => (value ? extractUrls(value) : []));

    for (const source of backgroundSources) {
      assets.push({
        type: "image",
        source,
        location: getLocation(source),
        usage: "background"
      });
    }
  });

  return assets;
}

function collectFontAssets($: cheerio.CheerioAPI): VisualAsset[] {
  const links = $('link[href*="fonts"], link[href*="font"]')
    .toArray()
    .map((element) => $(element).attr("href"))
    .filter((href): href is string => Boolean(href))
    .map<VisualAsset>((source) => ({
      type: "font",
      source,
      location: getLocation(source),
      usage: "font"
    }));

  const imports = extractGlobalCss($)
    .match(/@import\s+url\((['"]?)(.*?)\1\)/g)
    ?.map((rule) => rule.replace(/^@import\s+url\((['"]?)/, "").replace(/(['"]?)\)$/, ""))
    .filter((source) => source.includes("font")) ?? [];

  return [
    ...links,
    ...imports.map<VisualAsset>((source) => ({
      type: "font",
      source,
      location: getLocation(source),
      usage: "font"
    }))
  ];
}

function collectStylesheetAssets($: cheerio.CheerioAPI): VisualAsset[] {
  return $('link[rel="stylesheet"][href]')
    .toArray()
    .map((element) => $(element).attr("href"))
    .filter((href): href is string => Boolean(href))
    .map((source) => ({
      type: "stylesheet",
      source,
      location: getLocation(source),
      usage: "stylesheet"
    }));
}

function collectTokens($: cheerio.CheerioAPI, globalCss: string): VisualTokens {
  const colors: string[] = [];
  const gradients: string[] = [];
  const fonts: string[] = [];
  const spacing: string[] = [];

  const cssText = [
    globalCss,
    $("[style]")
      .toArray()
      .map((element) => $(element).attr("style") ?? "")
      .join(";")
  ].join("\n");

  colors.push(...(cssText.match(/#[0-9a-f]{3,8}\b/gi) ?? []));
  colors.push(...(cssText.match(/rgba?\([^)]+\)/gi) ?? []));
  colors.push(...(cssText.match(/hsla?\([^)]+\)/gi) ?? []));
  gradients.push(...(cssText.match(/(?:linear|radial|conic)-gradient\([^)]+\)/gi) ?? []));

  $("[style]").each((_, element) => {
    const styles = parseStyle($(element as Element).attr("style"));

    if (styles["font-family"]) fonts.push(styles["font-family"]);

    for (const property of ["padding", "padding-top", "padding-bottom", "margin", "margin-top", "margin-bottom", "gap"]) {
      if (styles[property]) spacing.push(styles[property]);
    }
  });

  $('link[href*="family="]').each((_, element) => {
    const href = $(element as Element).attr("href") ?? "";
    const family = href.match(/[?&]family=([^:&]+)/)?.[1];

    if (family) {
      fonts.push(decodeURIComponent(family).replace(/\+/g, " "));
    }
  });

  return {
    colors: unique(colors),
    gradients: unique(gradients),
    fonts: unique(fonts),
    spacing: unique(spacing)
  };
}

function createVisualBlock(
  $: cheerio.CheerioAPI,
  element: Element,
  index: number,
  rules: CssRule[],
  layoutMap: Record<string, VisualLayoutBox>
): VisualBlock {
  const node = $(element);
  const tag = element.name.toLowerCase();
  const html = $.html(element);
  const blockImages = collectImageAssets($, node);
  const blockImageGroups = groupImagesWithOriginalContainersForScope($, node);
  const computedStyles = computeElementStyles(node, rules);
  const dom = createRenderedDomNode($, element, rules, layoutMap);

  return {
    id: node.attr("id") || `visual-block-${index + 1}`,
    tag,
    role: getRole(tag, node),
    className: node.attr("class") ?? "",
    inlineStyle: node.attr("style") ?? "",
    html,
    normalizedHtml: html,
    text: cleanText(node.text()),
    layout: getElementLayout(node, layoutMap),
    images: blockImages,
    imageGroups: blockImageGroups,
    styles: parseStyle(node.attr("style")),
    computedStyles,
    dom
  };
}

function groupImagesWithOriginalContainersForScope(
  $: cheerio.CheerioAPI,
  scope: cheerio.Cheerio<Element>
): VisualImageGroup[] {
  const imageParentIds = new Set(
    scope
      .find("img[data-original-parent-id],picture[data-original-parent-id]")
      .toArray()
      .map((element) => $(element as Element).attr("data-original-parent-id"))
      .filter((id): id is string => Boolean(id))
  );

  return groupImagesWithOriginalContainers($).filter((group) =>
    imageParentIds.has(group.parentId)
  );
}

function createRenderedDomNode(
  $: cheerio.CheerioAPI,
  element: Element,
  rules: CssRule[],
  layoutMap: Record<string, VisualLayoutBox>
): RenderedDomNode {
  const node = $(element);
  const children = node
    .children()
    .toArray()
    .filter((child): child is Element => child.type === "tag")
    .map((child) => createRenderedDomNode($, child, rules, layoutMap));

  return {
    id: node.attr("data-visual-id") ?? node.attr("id") ?? "",
    tag: element.name.toLowerCase(),
    attributes: getElementAttributes(node),
    className: node.attr("class") ?? "",
    text: cleanText(node.clone().children().remove().end().text()),
    layout: getElementLayout(node, layoutMap),
    computedStyles: computeElementStyles(node, rules),
    children
  };
}

export function parseVisualDocument(
  html: string,
  browserRenderedPage?: BrowserRenderedPage | null
): VisualDocument {
  const rendered = browserRenderedPage
    ? {
        $: cheerio.load(browserRenderedPage.html),
        renderedHtml: browserRenderedPage.html,
        globalCss: extractGlobalCss(cheerio.load(browserRenderedPage.html)) || browserRenderedPage.css,
        rules: parseCssRules(browserRenderedPage.css),
        layoutMap: browserRenderedPage.layoutMap
      }
    : renderVisualDom(html);
  const $ = rendered.$;
  const title = cleanText($("title").first().text()) || "Elementor Page";
  normalizeElementStyles($);
  groupImagesWithOriginalContainers($);
  const blocks = getVisualSections($).map((element, index) =>
    createVisualBlock($, element, index, rendered.rules, rendered.layoutMap)
  );
  const imageAssets = collectImageAssets($);
  const fontAssets = collectFontAssets($);
  const stylesheetAssets = collectStylesheetAssets($);
  const normalizedHtml = normalizeRenderedDocument(cheerio.load(rendered.renderedHtml));

  return {
    title,
    html,
    renderedHtml: rendered.renderedHtml,
    normalizedHtml,
    baseCss: getLovableBaseCss(),
    globalCss: rendered.globalCss,
    assets: uniqueAssets([...imageAssets, ...fontAssets, ...stylesheetAssets]),
    tokens: collectTokens($, rendered.globalCss),
    blocks,
    pipeline: [
      "lovable_html",
      browserRenderedPage ? "puppeteer_visual_renderer" : "server_visual_renderer",
      browserRenderedPage ? "real_computed_dom_capture" : "estimated_computed_dom_capture",
      "normalization",
      "elementor_json"
    ],
    renderer: browserRenderedPage ? "puppeteer" : "server"
  };
}

function uniqueAssets(assets: VisualAsset[]): VisualAsset[] {
  const seen = new Set<string>();

  return assets.filter((asset) => {
    const key = `${asset.type}:${asset.usage}:${asset.source}`;

    if (seen.has(key)) return false;

    seen.add(key);
    return true;
  });
}
