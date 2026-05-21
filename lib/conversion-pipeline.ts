import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

import * as cheerio from "cheerio";
import type { Element } from "domhandler";

import { getLovableBaseCss, inlineLovableStyles } from "@/lib/tailwind";
import type { ElementorDocument, ElementorElement } from "@/types/conversion";

type ViewportName = "desktop" | "tablet" | "mobile";

type ViewportDefinition = {
  name: ViewportName;
  width: number;
  height: number;
};

type VisualElementKind =
  | "text"
  | "heading"
  | "button"
  | "link"
  | "image"
  | "background-image"
  | "card"
  | "container"
  | "grid"
  | "flexbox"
  | "faq"
  | "table"
  | "list"
  | "icon"
  | "price"
  | "testimonial";

type VisualElementCapture = {
  id: string;
  tag: string;
  kind: VisualElementKind[];
  text: string;
  directText: string;
  src: string;
  href: string;
  alt: string;
  role: string;
  className: string;
  styles: Record<string, string>;
  rect: {
    x: number;
    y: number;
    top: number;
    left: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
  };
  visualOrder: number;
};

type VisualCapture = {
  html: string;
  title: string;
  elements: VisualElementCapture[];
  imagesNotLoaded: string[];
  screenshots: {
    original?: string;
    clean?: string;
    preview?: string;
    originalDesktop?: string;
    originalTablet?: string;
    originalMobile?: string;
    cleanDesktop?: string;
    cleanTablet?: string;
    cleanMobile?: string;
    previewDesktop?: string;
    previewTablet?: string;
    previewMobile?: string;
  };
  responsive: Record<
    ViewportName,
    {
      width: number;
      height: number;
      visibleElements: number;
      imagesNotLoaded: string[];
    }
  >;
  errors: string[];
};

export type ConversionReport = {
  totalTextosEncontrados: number;
  totalTextosConvertidos: number;
  totalImagensEncontradas: number;
  totalImagensConvertidas: number;
  totalBotoesEncontrados: number;
  totalBotoesConvertidos: number;
  totalHeadingsEncontrados: number;
  totalHeadingsConvertidos: number;
  totalElementosExportados: number;
  elementosPerdidos: Array<{
    type: "text" | "image" | "button" | "heading";
    value: string;
  }>;
  elementosRecuperados: Array<{
    type: "text" | "image" | "button" | "heading";
    value: string;
  }>;
  imagensNaoCarregadas: string[];
  warnings: string[];
  status: "success" | "warning" | "blocked";
  exportBlocked: boolean;
  screenshots: VisualCapture["screenshots"];
  visualComparison: Record<
    ViewportName,
    {
      originalScreenshot?: string;
      cleanScreenshot?: string;
      previewScreenshot?: string;
      originalBytes: number;
      cleanBytes: number;
      previewBytes: number;
      cleanSizeRatio: number;
      previewSizeRatio: number;
      passed: boolean;
    }
  >;
  captureFailed: boolean;
  errors: string[];
};

export type ConversionPipelineResult = {
  elementorJson: ElementorDocument;
  cleanHtml: string;
  previewHtml: string;
  report: ConversionReport;
  outputDir: string | null;
};

type PipelineOptions = {
  sourceUrl?: string;
  outputDir?: string;
  persistArtifacts?: boolean;
  blockOnValidationFailure?: boolean;
  rewriteAssetUrls?: boolean;
};

const STYLE_PROPERTIES = [
  "display",
  "position",
  "z-index",
  "width",
  "max-width",
  "min-width",
  "height",
  "min-height",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "gap",
  "row-gap",
  "column-gap",
  "grid-template-columns",
  "grid-template-rows",
  "align-items",
  "justify-content",
  "flex-direction",
  "flex-wrap",
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "letter-spacing",
  "text-align",
  "text-transform",
  "color",
  "background",
  "background-color",
  "background-image",
  "background-clip",
  "-webkit-background-clip",
  "background-size",
  "background-position",
  "background-repeat",
  "border",
  "border-color",
  "border-radius",
  "box-shadow",
  "opacity",
  "overflow",
  "object-fit",
  "object-position",
  "cursor"
];

const VIEWPORTS: ViewportDefinition[] = [
  { name: "desktop", width: 1440, height: 1400 },
  { name: "tablet", width: 768, height: 1200 },
  { name: "mobile", width: 390, height: 1000 }
];

function createId(prefix: string, index: number) {
  return `${prefix}-${index.toString(16).padStart(5, "0")}`;
}

function cleanText(value: string) {
  return value.replace(/\s+/g, " ").trim();
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

      if (property && value) styles[property] = value;
      return styles;
    }, {});
}

function normalizeJsonText(value: string) {
  return cleanText(
    value
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&nbsp;/gi, " ")
  ).toLowerCase();
}

function getComparableTextVariants(value: string) {
  const normalized = cleanText(value);
  const withoutWrappingQuotes = normalized
    .replace(/^["'“”‘’]\s*/, "")
    .replace(/\s*["'“”‘’]$/, "");

  return [...new Set([normalized, withoutWrappingQuotes])]
    .map((variant) => normalizeJsonText(variant))
    .filter(Boolean);
}

function jsonIncludesAnyTextVariant(jsonText: string, value: string) {
  const variants = getComparableTextVariants(value);

  return variants.some((variant) => {
    if (jsonText.includes(variant)) {
      return true;
    }

    const words = variant.match(/[\p{L}\p{N}$&.]+/gu) ?? [];
    if (words.length < 3) {
      return false;
    }

    let cursor = 0;

    for (const word of words) {
      const index = jsonText.indexOf(word, cursor);

      if (index === -1) {
        return false;
      }

      cursor = index + word.length;
    }

    return true;
  });
}

function numberFromPx(value: string | undefined) {
  if (!value) return undefined;
  const match = value.match(/^(-?\d+(?:\.\d+)?)px$/);
  return match ? Number(match[1]) : undefined;
}

function toElementorSize(value: string | undefined) {
  const numeric = numberFromPx(value);

  if (numeric === undefined) return undefined;

  return {
    unit: "px",
    size: numeric,
    sizes: []
  };
}

function toElementorBox(style: Record<string, string>, prefix: string) {
  const top = numberFromPx(style[`${prefix}-top`]);
  const right = numberFromPx(style[`${prefix}-right`]);
  const bottom = numberFromPx(style[`${prefix}-bottom`]);
  const left = numberFromPx(style[`${prefix}-left`]);

  if ([top, right, bottom, left].every((value) => value === undefined)) {
    return undefined;
  }

  return {
    unit: "px",
    top: top ?? 0,
    right: right ?? 0,
    bottom: bottom ?? 0,
    left: left ?? 0,
    isLinked: top === right && right === bottom && bottom === left
  };
}

function getBackgroundUrl(backgroundImage: string | undefined) {
  if (!backgroundImage || backgroundImage === "none") return undefined;
  return extractCssUrls(backgroundImage)[0];
}

function mapCommonElementorStyles(styles: Record<string, string>) {
  const padding = toElementorBox(styles, "padding");
  const margin = toElementorBox(styles, "margin");
  const borderRadius = toElementorBox(
    {
      "border-radius-top": styles["border-top-left-radius"] || styles["border-radius"],
      "border-radius-right": styles["border-top-right-radius"] || styles["border-radius"],
      "border-radius-bottom": styles["border-bottom-right-radius"] || styles["border-radius"],
      "border-radius-left": styles["border-bottom-left-radius"] || styles["border-radius"]
    },
    "border-radius"
  );
  const mapped: Record<string, unknown> = {};

  if (padding) mapped._padding = padding;
  if (margin) mapped._margin = margin;
  if (borderRadius) mapped._border_radius = borderRadius;
  if (styles.width && styles.width !== "auto") mapped.width = styles.width;
  if (styles["max-width"] && styles["max-width"] !== "none") mapped.max_width = styles["max-width"];
  if (styles["min-height"] && styles["min-height"] !== "0px") mapped.min_height = styles["min-height"];
  if (styles["box-shadow"]) mapped.box_shadow_box_shadow = styles["box-shadow"];
  if (styles["z-index"] && styles["z-index"] !== "auto") mapped.z_index = styles["z-index"];
  if (styles["text-align"]) mapped.align = styles["text-align"];

  return mapped;
}

function mapTypographyStyles(styles: Record<string, string>) {
  const mapped: Record<string, unknown> = {};
  const fontSize = toElementorSize(styles["font-size"]);

  if (styles.color) mapped.title_color = styles.color;
  if (styles.color) mapped.text_color = styles.color;
  if (styles["font-family"]) mapped.typography_font_family = styles["font-family"];
  if (fontSize) mapped.typography_font_size = fontSize;
  if (styles["font-weight"]) mapped.typography_font_weight = styles["font-weight"];
  if (styles["line-height"]) mapped.typography_line_height = styles["line-height"];
  if (styles["letter-spacing"]) mapped.typography_letter_spacing = styles["letter-spacing"];
  if (styles["text-align"]) mapped.align = styles["text-align"];

  return mapped;
}

function mapContainerStyles(styles: Record<string, string>) {
  const backgroundUrl = getBackgroundUrl(styles["background-image"]);
  const isGrid = styles.display?.includes("grid");
  const isFlex = styles.display?.includes("flex");
  const mapped: Record<string, unknown> = {
    ...mapCommonElementorStyles(styles)
  };

  if (isFlex) {
    mapped.container_type = "flex";
    mapped.flex_direction = styles["flex-direction"] || "row";
    mapped.flex_justify_content = styles["justify-content"] || "flex-start";
    mapped.flex_align_items = styles["align-items"] || "stretch";
    mapped.flex_wrap = styles["flex-wrap"] || "nowrap";
  }
  if (isGrid) {
    mapped.container_type = "flex";
    mapped.flex_direction = "row";
    mapped.flex_wrap = "wrap";
    mapped.flex_justify_content = styles["justify-content"] || "center";
    mapped.flex_align_items = styles["align-items"] || "stretch";
    mapped.display = "grid";
    mapped.grid_template_columns = styles["grid-template-columns"];
    mapped.grid_template_rows = styles["grid-template-rows"];
  }
  if (styles["flex-direction"]) mapped.flex_direction = styles["flex-direction"];
  if (styles["align-items"]) mapped.align_items = styles["align-items"];
  if (styles["justify-content"]) mapped.justify_content = styles["justify-content"];
  if (styles.gap) {
    mapped.gap = styles.gap;
    mapped.flex_gap = { unit: "px", size: numberFromPx(styles.gap) ?? styles.gap, sizes: [] };
  }
  if (styles["row-gap"]) mapped.row_gap = styles["row-gap"];
  if (styles["column-gap"]) mapped.column_gap = styles["column-gap"];
  if (styles["grid-template-columns"]) mapped.grid_template_columns = styles["grid-template-columns"];
  if (styles["background-color"] && !styles["background-color"].includes("rgba(0, 0, 0, 0)")) {
    mapped.background_color = styles["background-color"];
    mapped._background_color = styles["background-color"];
    mapped._background_background = "classic";
  }
  if (backgroundUrl) {
    mapped._background_background = "classic";
    mapped._background_image = { url: backgroundUrl };
    mapped._background_size = styles["background-size"] || "cover";
    mapped._background_position = styles["background-position"] || "center center";
    mapped._background_repeat = styles["background-repeat"] || "no-repeat";
  }

  mapped.lovable_layout_engine = isGrid ? "grid" : isFlex ? "flex" : "block";

  return mapped;
}

function mapButtonStyles(styles: Record<string, string>) {
  return {
    ...mapCommonElementorStyles(styles),
    ...mapTypographyStyles(styles),
    background_color: styles["background-color"] || styles.background,
    button_text_color: styles.color,
    border_radius: styles["border-radius"],
    border_color: styles["border-color"],
    border_width: styles.border
  };
}

function mapImageStyles(styles: Record<string, string>) {
  return {
    ...mapCommonElementorStyles(styles),
    width: styles.width || "100%",
    max_width: styles["max-width"] || "100%",
    height: styles.height === "auto" ? "auto" : styles.height,
    object_fit: styles["object-fit"] || "cover",
    object_position: styles["object-position"] || "center center"
  };
}

function createResponsiveSettings(styles: Record<string, string>) {
  return {
    desktop: {
      ...mapCommonElementorStyles(styles),
      display: styles.display,
      width: styles.width,
      max_width: styles["max-width"],
      min_height: styles["min-height"],
      gap: styles.gap,
      flex_direction: styles["flex-direction"],
      grid_template_columns: styles["grid-template-columns"]
    },
    tablet: {
      width: styles.width,
      max_width: styles["max-width"],
      gap: styles.gap,
      flex_direction: styles["flex-direction"],
      grid_template_columns: styles["grid-template-columns"]
    },
    mobile: {
      width: styles.width && styles.width !== "auto" ? "100%" : styles.width,
      max_width: "100%",
      gap: styles.gap,
      flex_direction: "column"
    }
  };
}

function getLayoutNumber(node: cheerio.Cheerio<Element>, attribute: string) {
  const value = node.attr(attribute);

  return value ? Number(value) : undefined;
}

function createElementorLayoutSize(value: number | undefined) {
  if (!Number.isFinite(value)) return undefined;

  return {
    unit: "px",
    size: Math.round((value ?? 0) * 100) / 100,
    sizes: []
  };
}

function createElementLayoutMetadata(node: cheerio.Cheerio<Element>) {
  const x = getLayoutNumber(node, "data-layout-x");
  const y = getLayoutNumber(node, "data-layout-y");
  const width = getLayoutNumber(node, "data-layout-width");
  const height = getLayoutNumber(node, "data-layout-height");

  return {
    x,
    y,
    width,
    height,
    visualOrder: Number(node.attr("data-visual-order") ?? 0)
  };
}

function inferGridColumns(styles: Record<string, string>, className = "") {
  const repeatMatch = styles["grid-template-columns"]?.match(/repeat\((\d+),/);
  if (repeatMatch) return Number(repeatMatch[1]);

  const classMatch =
    className.match(/\blg:grid-cols-(\d+)\b/) ||
    className.match(/\bmd:grid-cols-(\d+)\b/) ||
    className.match(/\bsm:grid-cols-(\d+)\b/) ||
    className.match(/\bgrid-cols-(\d+)\b/);

  return classMatch ? Number(classMatch[1]) : 0;
}

function createPercentSize(percent: number) {
  return {
    unit: "%",
    size: Math.round(percent * 100) / 100,
    sizes: []
  };
}

function applyDirectChildLayout(
  children: ElementorElement[],
  styles: Record<string, string>,
  className: string
) {
  const columns = inferGridColumns(styles, className);

  if (!columns || columns < 2) {
    return children;
  }

  const gap = numberFromPx(styles.gap || styles["column-gap"]) ?? 0;
  const width = (100 - (gap > 0 ? 0 : 0)) / columns;

  return children.map((child) => ({
    ...child,
    settings: {
      ...child.settings,
      _width: createPercentSize(width),
      width: `${width}%`,
      flex_basis: `${width}%`,
      lovable_grid_column_span: 1,
      lovable_grid_parent_columns: columns
    }
  }));
}

function mapElementorPositionAndSize(node: cheerio.Cheerio<Element>) {
  const styles = parseStyle(node.attr("style"));
  const layout = createElementLayoutMetadata(node);
  const mapped: Record<string, unknown> = {};
  const width = toElementorSize(styles.width) ?? createElementorLayoutSize(layout.width);
  const height = toElementorSize(styles.height) ?? createElementorLayoutSize(layout.height);

  if (styles.position && styles.position !== "static") mapped._position = styles.position;
  if (styles.order && styles.order !== "0") mapped.order = styles.order;
  if (width) mapped._width = width;
  if (height && styles.height !== "auto") mapped._height = height;
  if (styles["object-fit"]) mapped.object_fit = styles["object-fit"];
  if (styles["object-position"]) mapped.object_position = styles["object-position"];

  mapped.lovable_layout = layout;

  return mapped;
}

function getUrlFilename(source: string, fallbackExt = "bin") {
  const cleanSource = source.split("#")[0].split("?")[0];
  const baseName = cleanSource.split("/").filter(Boolean).at(-1) ?? "";
  const extension = baseName.includes(".") ? baseName.split(".").at(-1) ?? fallbackExt : fallbackExt;
  const safeExt = extension.replace(/[^a-z0-9]/gi, "").slice(0, 8) || fallbackExt;
  const hash = crypto.createHash("sha1").update(source).digest("hex").slice(0, 12);

  return `${hash}.${safeExt}`;
}

function extractCssUrls(value: string) {
  return [...value.matchAll(/url\((['"]?)(.*?)\1\)/g)]
    .map((match) => match[2].trim())
    .filter(Boolean);
}

function isRemoteOrDataUrl(source: string) {
  return /^https?:\/\//i.test(source) || source.startsWith("data:");
}

function getMimeExtension(mime: string) {
  if (mime.includes("png")) return "png";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("svg")) return "svg";
  if (mime.includes("gif")) return "gif";
  if (mime.includes("avif")) return "avif";
  return "bin";
}

async function saveAsset(source: string, assetsDir: string) {
  if (!isRemoteOrDataUrl(source)) {
    return { publicPath: source, failed: true };
  }

  try {
    if (source.startsWith("data:")) {
      const match = source.match(/^data:([^;,]+)?(;base64)?,(.*)$/);
      if (!match) return { publicPath: source, failed: true };

      const mime = match[1] || "application/octet-stream";
      const extension = getMimeExtension(mime);
      const fileName = getUrlFilename(source, extension);
      const filePath = path.join(assetsDir, fileName);
      const data = match[2]
        ? Buffer.from(match[3], "base64")
        : Buffer.from(decodeURIComponent(match[3]));

      await writeFile(filePath, data);
      return { publicPath: `assets/${fileName}`, failed: false };
    }

    const response = await fetch(source);

    if (!response.ok) {
      return { publicPath: source, failed: true };
    }

    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    const fileName = getUrlFilename(source, getMimeExtension(contentType));
    const filePath = path.join(assetsDir, fileName);
    const buffer = Buffer.from(await response.arrayBuffer());

    await writeFile(filePath, buffer);
    return { publicPath: `assets/${fileName}`, failed: false };
  } catch {
    return { publicPath: source, failed: true };
  }
}

async function waitForImages(page: import("playwright").Page) {
  await page.evaluate(`
    (async () => {
      const timeout = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

      for (const image of Array.from(document.images)) {
        const lazySource =
          image.getAttribute("data-src") ||
          image.getAttribute("data-lazy-src") ||
          image.getAttribute("data-original");
        const lazySourceSet = image.getAttribute("data-srcset");

        if (lazySource && (!image.getAttribute("src") || image.getAttribute("src") === image.currentSrc)) {
          image.setAttribute("src", lazySource);
        }
        if (lazySourceSet && !image.getAttribute("srcset")) {
          image.setAttribute("srcset", lazySourceSet);
        }
      }

      const images = Array.from(document.images);
      await Promise.all(
        images.map((image) =>
          image.complete ||
          Promise.race([
            new Promise((resolve) => {
              image.addEventListener("load", resolve, { once: true });
              image.addEventListener("error", resolve, { once: true });
            }),
            timeout(5000)
          ])
        )
      );
    })()
  `);
}

async function waitForCssAndFonts(page: import("playwright").Page) {
  await page
    .evaluate(`
      (async () => {
        const stylesheets = Array.from(document.querySelectorAll('link[rel="stylesheet"][href]'));

        await Promise.all(
          stylesheets.map((link) =>
            link.sheet ||
            new Promise((resolve) => {
              link.addEventListener("load", resolve, { once: true });
              link.addEventListener("error", resolve, { once: true });
              setTimeout(resolve, 3000);
            })
          )
        );

        await Promise.race([
          document.fonts?.ready ?? Promise.resolve(),
          new Promise((resolve) => setTimeout(resolve, 3000))
        ]);
      })()
    `)
    .catch(() => undefined);
}

function prepareHtmlForRendering(html: string) {
  const inlined = inlineLovableStyles(html);
  const $ = cheerio.load(inlined);

  if (!$("head").length) {
    $("html").prepend("<head></head>");
  }

  $("head").prepend(getLovableBaseCss());

  return $.html();
}

async function preparePage(
  browser: import("playwright").Browser,
  html: string,
  options: PipelineOptions,
  viewport: ViewportDefinition
) {
  const page = await browser.newPage({
    viewport: { width: viewport.width, height: viewport.height }
  });

  if (options.sourceUrl) {
    await page.goto(options.sourceUrl, { waitUntil: "networkidle", timeout: 45000 });
  } else {
    await page.setContent(prepareHtmlForRendering(html), { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined);
  }

  await waitForCssAndFonts(page);
  await waitForImages(page);
  await waitForCssAndFonts(page);
  return page;
}

async function getViewportSummary(page: import("playwright").Page) {
  return (await page.evaluate(`
    (() => ({
      visibleElements: Array.from(document.body.querySelectorAll("*")).filter((element) => {
        const computed = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();

        return (
          computed.display !== "none" &&
          computed.visibility !== "hidden" &&
          computed.opacity !== "0" &&
          (rect.width > 0 || rect.height > 0 || (element.textContent || "").trim().length > 0)
        );
      }).length,
      imagesNotLoaded: Array.from(document.images)
        .filter((image) => !image.complete || image.naturalWidth === 0)
        .map((image) => image.currentSrc || image.src || image.alt || "unknown image")
    }))()
  `)) as {
    visibleElements: number;
    imagesNotLoaded: string[];
  };
}

async function captureVisualPage(
  html: string,
  options: PipelineOptions,
  outputDir: string | null
): Promise<VisualCapture> {
  const errors: string[] = [];
  const screenshots: VisualCapture["screenshots"] = {};
  const responsive = VIEWPORTS.reduce<VisualCapture["responsive"]>(
    (acc, viewport) => {
      acc[viewport.name] = {
        width: viewport.width,
        height: viewport.height,
        visibleElements: 0,
        imagesNotLoaded: []
      };
      return acc;
    },
    {
      desktop: { width: 0, height: 0, visibleElements: 0, imagesNotLoaded: [] },
      tablet: { width: 0, height: 0, visibleElements: 0, imagesNotLoaded: [] },
      mobile: { width: 0, height: 0, visibleElements: 0, imagesNotLoaded: [] }
    }
  );

  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    const desktop = VIEWPORTS[0];
    const page = await preparePage(browser, html, options, desktop);
    responsive.desktop = {
      ...responsive.desktop,
      ...(await getViewportSummary(page))
    };

    if (outputDir) {
      screenshots.original = path.join(outputDir, "original.png");
      screenshots.originalDesktop = path.join(outputDir, "original-desktop.png");
      await page.screenshot({ path: screenshots.original, fullPage: true });
      await page.screenshot({ path: screenshots.originalDesktop, fullPage: true });
    }

    const result = (await page.evaluate(`
      (() => {
        const styleProperties = ${JSON.stringify(STYLE_PROPERTIES)};
        const elements = Array.from(document.body.querySelectorAll("*"));
        const imagesNotLoaded = Array.from(document.images)
          .filter((image) => !image.complete || image.naturalWidth === 0)
          .map((image) => image.currentSrc || image.src || image.alt || "unknown image");

        function isVisible(element) {
          const computed = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return (
            computed.display !== "none" &&
            computed.visibility !== "hidden" &&
            computed.opacity !== "0" &&
            (rect.width > 0 || rect.height > 0 || (element.textContent || "").trim().length > 0)
          );
        }

        function directText(element) {
          return Array.from(element.childNodes)
            .filter((node) => node.nodeType === Node.TEXT_NODE)
            .map((node) => node.textContent || "")
            .join(" ")
            .replace(/\\s+/g, " ")
            .trim();
        }

        function elementKinds(element, computed) {
          const tag = element.tagName.toLowerCase();
          const className = element.className.toString().toLowerCase();
          const role = element.getAttribute("role") || "";
          const text = (element.textContent || "").trim();
          const kinds = new Set();

          if (/^h[1-6]$/.test(tag)) kinds.add("heading");
          if (tag === "a") kinds.add("link");
          if (
            tag === "button" ||
            role === "button" ||
            element.getAttribute("type") === "submit" ||
            element.hasAttribute("onclick") ||
            computed.cursor === "pointer"
          ) {
            kinds.add("button");
          }
          if (
            tag === "img" ||
            tag === "picture" ||
            tag === "source" ||
            element.hasAttribute("data-src") ||
            element.hasAttribute("data-lazy-src") ||
            element.hasAttribute("data-srcset")
          ) {
            kinds.add("image");
          }
          if (computed.backgroundImage && computed.backgroundImage !== "none") kinds.add("background-image");
          if (tag === "section" || tag === "main" || tag === "header" || tag === "footer" || tag === "article" || tag === "div") kinds.add("container");
          if (computed.display.includes("grid")) kinds.add("grid");
          if (computed.display.includes("flex")) kinds.add("flexbox");
          if (tag === "details" || className.includes("faq") || text.includes("?")) kinds.add("faq");
          if (tag === "table") kinds.add("table");
          if (tag === "ul" || tag === "ol" || tag === "li") kinds.add("list");
          if (className.includes("card") || tag === "article") kinds.add("card");
          if (className.includes("icon") || tag === "svg") kinds.add("icon");
          if (/\\$\\s?\\d|R\\$\\s?\\d|US\\$\\s?\\d|\\d+[,.]\\d{2}/i.test(text) || className.includes("price")) kinds.add("price");
          if (className.includes("testimonial") || className.includes("review") || className.includes("depoimento")) kinds.add("testimonial");
          if (directText(element)) kinds.add("text");

          return Array.from(kinds);
        }

        const captured = elements.filter(isVisible).map((element, index) => {
          const computed = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          const id = element.getAttribute("data-pipeline-id") || "pipeline-node-" + (index + 1);
          const styles = Object.fromEntries(
            styleProperties.map((property) => [property, computed.getPropertyValue(property)])
          );

          element.setAttribute("data-pipeline-id", id);
          element.setAttribute("data-visual-order", String(index));
          element.setAttribute("data-layout-x", String(Math.round(rect.x * 100) / 100));
          element.setAttribute("data-layout-y", String(Math.round(rect.y * 100) / 100));
          element.setAttribute("data-layout-width", String(Math.round(rect.width * 100) / 100));
          element.setAttribute("data-layout-height", String(Math.round(rect.height * 100) / 100));
          element.setAttribute(
            "style",
            Object.entries(styles)
              .filter((entry) => entry[1] && entry[1] !== "none" && entry[1] !== "normal")
              .map((entry) => entry[0] + ":" + entry[1])
              .join(";")
          );

          return {
            id,
            tag: element.tagName.toLowerCase(),
            kind: elementKinds(element, computed),
            text: (element.textContent || "").replace(/\\s+/g, " ").trim(),
            directText: directText(element),
            src:
              element.getAttribute("src") ||
              element.getAttribute("data-src") ||
              element.getAttribute("data-lazy-src") ||
              element.getAttribute("data-original") ||
              element.getAttribute("srcset") ||
              element.getAttribute("data-srcset") ||
              element.currentSrc ||
              "",
            href: element.getAttribute("href") || "",
            alt: element.getAttribute("alt") || "",
            role: element.getAttribute("role") || "",
            className: element.className.toString(),
            styles,
            rect: {
              x: rect.x,
              y: rect.y,
              top: rect.top,
              left: rect.left,
              right: rect.right,
              bottom: rect.bottom,
              width: rect.width,
              height: rect.height
            },
            visualOrder: index
          };
        });

        return {
          html: document.documentElement.outerHTML,
          title: document.title || "Elementor Page",
          elements: captured,
          imagesNotLoaded
        };
      })()
    `)) as Omit<VisualCapture, "screenshots" | "errors">;

    for (const viewport of VIEWPORTS.slice(1)) {
      const viewportPage = await preparePage(browser, html, options, viewport);
      responsive[viewport.name] = {
        width: viewport.width,
        height: viewport.height,
        ...(await getViewportSummary(viewportPage))
      };

      if (outputDir) {
        const key = `original${viewport.name[0].toUpperCase()}${viewport.name.slice(1)}` as keyof VisualCapture["screenshots"];
        screenshots[key] = path.join(outputDir, `original-${viewport.name}.png`);
        await viewportPage.screenshot({ path: screenshots[key], fullPage: true });
      }

      await viewportPage.close();
    }

    await browser.close();

    return {
      ...result,
      screenshots,
      responsive,
      errors
    } as VisualCapture;
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "Playwright capture failed");

    return {
      html,
      title: "Elementor Page",
      elements: [],
      imagesNotLoaded: [],
      screenshots,
      responsive,
      errors
    };
  }
}

function removeExternalRuntimeDependencies($: cheerio.CheerioAPI) {
  $("script,noscript").remove();
  $('link[rel="modulepreload"], link[href*="tailwind"], link[href*="lovable"], link[href*="vite"]').remove();
  $("[data-reactroot],[data-react-helmet],[data-lovable]").removeAttr(
    "data-reactroot data-react-helmet data-lovable"
  );
}

function serializeStyle(style: Record<string, string>) {
  return Object.entries(style)
    .filter(([, value]) => value)
    .map(([property, value]) => `${property}:${value}`)
    .join(";");
}

function normalizeCleanHtmlStyles($: cheerio.CheerioAPI) {
  $("body").css("font-family", "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif");

  $("[style]").each((_, element) => {
    const node = $(element as Element);
    const tag = (element as Element).name.toLowerCase();
    const style = parseStyle(node.attr("style"));
    const className = node.attr("class") ?? "";
    const isMedia = ["img", "video", "canvas", "svg", "picture", "source"].includes(tag);
    const isText = /^(h[1-6]|p|span|small|strong|em|a|button|li)$/.test(tag);

    if (/\bmx-auto\b/.test(className)) {
      style["margin-left"] = "auto";
      style["margin-right"] = "auto";
    }

    if (/\bmax-w-(md|lg|xl|2xl|3xl|4xl|5xl|6xl)\b/.test(className)) {
      style.width = "100%";
    }

    if (isText && /rgba?\(\s*0\s*,\s*0\s*,\s*0\s*(?:,\s*0\s*)?\)|transparent/i.test(style.color ?? "")) {
      style.color = "var(--primary)";
    }

    if (tag === "img") {
      style.display = "block";
      style["vertical-align"] = "middle";
    }

    if (!isMedia) {
      if (/^\d+(?:\.\d+)?px$/.test(style.width ?? "")) delete style.width;
      if (/^\d+(?:\.\d+)?px$/.test(style.height ?? "")) delete style.height;
    }

    if (style["font-family"]?.includes("Times New Roman")) {
      style["font-family"] = "Inter, ui-sans-serif, system-ui, sans-serif";
    }

    if (isText && style["line-height"] === "normal") {
      delete style["line-height"];
    }

    if (/^h[1-6]$/.test(tag)) {
      if (!style["line-height"] || style["line-height"] === "normal") {
        style["line-height"] = "1.15";
      }
      delete style["text-wrap"];
    }

    if (isMedia) {
      style["max-width"] = style["max-width"] && style["max-width"] !== "none" ? style["max-width"] : "100%";
      style.height = style.height && style.height !== "auto" && tag !== "img" ? style.height : "auto";
    }

    const normalized = serializeStyle(style);

    if (normalized) node.attr("style", normalized);
    else node.removeAttr("style");
  });
}

async function createCleanHtml(
  capturedHtml: string,
  outputDir: string | null,
  rewriteAssetUrls: boolean
): Promise<{ cleanHtml: string; unloadedImages: string[] }> {
  const $ = cheerio.load(capturedHtml);
  const unloadedImages: string[] = [];
  const replacements = new Map<string, string>();
  const assetsDir = outputDir ? path.join(outputDir, "assets") : null;

  removeExternalRuntimeDependencies($);
  normalizeCleanHtmlStyles($);

  if (assetsDir) {
    await mkdir(assetsDir, { recursive: true });
  }

  async function resolveAsset(source: string) {
    if (!source || source.startsWith("#") || source.startsWith("mailto:") || source.startsWith("tel:")) {
      return source;
    }

    if (replacements.has(source)) return replacements.get(source) ?? source;

    if (!assetsDir) {
      replacements.set(source, source);
      return source;
    }

    const asset = await saveAsset(source, assetsDir);

    if (asset.failed) {
      unloadedImages.push(source);
    }

    const finalSource = rewriteAssetUrls && !asset.failed ? asset.publicPath : source;
    replacements.set(source, finalSource);
    return finalSource;
  }

  for (const element of $("img[src], img[data-src], img[data-lazy-src], img[data-original], source[src], video[poster]").toArray()) {
    const node = $(element);
    const source =
      node.attr("src") ||
      node.attr("data-src") ||
      node.attr("data-lazy-src") ||
      node.attr("data-original") ||
      node.attr("poster");

    if (source) {
      const resolved = await resolveAsset(source);

      if (node.attr("poster") !== undefined && !node.attr("src")) {
        node.attr("poster", resolved);
      } else {
        node.attr("src", resolved);
      }

      node.removeAttr("data-src");
      node.removeAttr("data-lazy-src");
      node.removeAttr("data-original");
    }
  }

  for (const element of $("[srcset], [data-srcset]").toArray()) {
    const node = $(element);
    const srcset = node.attr("srcset") || node.attr("data-srcset");

    if (!srcset) continue;

    const resolved = await Promise.all(
      srcset.split(",").map(async (item) => {
        const [source, ...descriptor] = item.trim().split(/\s+/);
        const publicPath = await resolveAsset(source);
        return [publicPath, ...descriptor].join(" ");
      })
    );

    node.attr("srcset", resolved.join(", "));
    node.removeAttr("data-srcset");
  }

  for (const element of $("[style]").toArray()) {
    const node = $(element);
    let style = node.attr("style") ?? "";

    for (const source of extractCssUrls(style)) {
      style = style.replace(source, await resolveAsset(source));
    }

    node.attr("style", style);
  }

  for (const styleElement of $("style").toArray()) {
    const node = $(styleElement);
    let css = node.html() ?? "";

    for (const source of extractCssUrls(css)) {
      css = css.replace(source, await resolveAsset(source));
    }

    node.text(css);
  }

  return {
    cleanHtml: $.html(),
    unloadedImages
  };
}

function createContainer(
  id: string,
  element: cheerio.Cheerio<Element>,
  elements: ElementorElement[]
): ElementorElement {
  const styles = parseStyle(element.attr("style"));
  const backgroundImage = styles["background-image"];
  const className = element.attr("class") || "";
  const isGrid = styles.display?.includes("grid");
  const isFlex = styles.display?.includes("flex");
  const laidOutElements = applyDirectChildLayout(elements, styles, className);

  return {
    id,
    elType: "container",
    settings: {
      ...mapContainerStyles(styles),
      ...mapElementorPositionAndSize(element),
      _css_classes: element.attr("class") || undefined,
      lovable_tag: element.prop("tagName")?.toLowerCase(),
      lovable_pipeline_id: element.attr("data-pipeline-id") || undefined,
      lovable_visual_order: element.attr("data-visual-order") || undefined,
      lovable_styles: styles,
      lovable_layout_parser: {
        display: styles.display || "block",
        isFlex,
        isGrid,
        flexDirection: styles["flex-direction"] || "row",
        justifyContent: styles["justify-content"] || "flex-start",
        alignItems: styles["align-items"] || "stretch",
        gap: styles.gap || styles["row-gap"] || styles["column-gap"] || "0px",
        gridTemplateColumns: styles["grid-template-columns"],
        className
      },
      lovable_responsive_settings: createResponsiveSettings(styles),
      lovable_layout: {
        x: element.attr("data-layout-x"),
        y: element.attr("data-layout-y"),
        width: element.attr("data-layout-width"),
        height: element.attr("data-layout-height")
      },
      content_width: "full",
      width: styles.width || "100%",
      max_width: styles["max-width"] || undefined,
      min_height: styles["min-height"] || undefined,
      flex_direction: styles["flex-direction"] || undefined,
      gap: styles.gap || styles["row-gap"] || undefined,
      _background_background: backgroundImage ? "classic" : undefined,
      _background_image: backgroundImage
        ? {
            url: extractCssUrls(backgroundImage)[0] ?? backgroundImage
          }
        : undefined
    },
    elements: laidOutElements
  };
}

function createHeadingWidget(
  node: cheerio.Cheerio<Element>,
  index: number
): ElementorElement {
  const tag = node.prop("tagName")?.toLowerCase() ?? "h2";
  const styles = parseStyle(node.attr("style"));

  return {
    id: createId("heading", index),
    elType: "widget",
    widgetType: "heading",
    settings: {
      ...mapCommonElementorStyles(styles),
      ...mapTypographyStyles(styles),
      ...mapElementorPositionAndSize(node),
      title: cleanText(node.text()),
      header_size: tag,
      lovable_styles: styles,
      lovable_responsive_settings: createResponsiveSettings(styles),
      lovable_visual_order: node.attr("data-visual-order") || undefined
    },
    elements: []
  };
}

function createTextWidget(
  node: cheerio.Cheerio<Element>,
  index: number,
  text = cleanText(node.text())
): ElementorElement {
  const styles = parseStyle(node.attr("style"));

  return {
    id: createId("text", index),
    elType: "widget",
    widgetType: "text-editor",
    settings: {
      ...mapCommonElementorStyles(styles),
      ...mapTypographyStyles(styles),
      ...mapElementorPositionAndSize(node),
      editor: text,
      lovable_tag: node.prop("tagName")?.toLowerCase(),
      lovable_styles: styles,
      lovable_responsive_settings: createResponsiveSettings(styles),
      lovable_visual_order: node.attr("data-visual-order") || undefined
    },
    elements: []
  };
}

function createButtonWidget(
  node: cheerio.Cheerio<Element>,
  index: number
): ElementorElement {
  const text =
    cleanText(node.text()) ||
    node.attr("value") ||
    node.attr("aria-label") ||
    "Button";

  return {
    id: createId("button", index),
    elType: "widget",
    widgetType: "button",
    settings: {
      ...mapButtonStyles(parseStyle(node.attr("style"))),
      ...mapElementorPositionAndSize(node),
      text,
      link: {
        url: node.attr("href") || "",
        is_external: node.attr("target") === "_blank",
        nofollow: false
      },
      button_type: "default",
      size: "sm",
      lovable_styles: parseStyle(node.attr("style")),
      lovable_responsive_settings: createResponsiveSettings(parseStyle(node.attr("style"))),
      lovable_href: node.attr("href") || undefined,
      lovable_target: node.attr("target") || undefined,
      lovable_aria_label: node.attr("aria-label") || undefined,
      lovable_onclick: node.attr("onclick") || undefined,
      lovable_visual_order: node.attr("data-visual-order") || undefined
    },
    elements: []
  };
}

function createImageWidget(
  node: cheerio.Cheerio<Element>,
  index: number
): ElementorElement {
  const styles = parseStyle(node.attr("style"));
  const source =
    node.attr("src") ||
    node.attr("data-src") ||
    node.attr("data-lazy-src") ||
    node.attr("data-original") ||
    node.attr("srcset")?.split(",")[0]?.trim().split(/\s+/)[0] ||
    node.attr("data-srcset")?.split(",")[0]?.trim().split(/\s+/)[0] ||
    "";

  return {
    id: createId("image", index),
    elType: "widget",
    widgetType: "image",
    settings: {
      image: {
        url: source,
        alt: node.attr("alt") || ""
      },
      image_size: "full",
      ...mapImageStyles(styles),
      ...mapElementorPositionAndSize(node),
      lovable_styles: {
        ...styles,
        width: styles.width || "100%",
        height: styles.height === "auto" ? "auto" : styles.height,
        "object-fit": styles["object-fit"] || "cover",
        "object-position": styles["object-position"] || "center center"
      },
      lovable_layout: {
        width: node.attr("data-layout-width"),
        height: node.attr("data-layout-height")
      },
      lovable_responsive_settings: createResponsiveSettings(styles),
      lovable_visual_order: node.attr("data-visual-order") || undefined
    },
    elements: []
  };
}

function createAccordionWidget(
  $: cheerio.CheerioAPI,
  node: cheerio.Cheerio<Element>,
  index: number
): ElementorElement {
  const details = node.is("details") ? node : node.find("details");
  const tabs = details.toArray().map((element, tabIndex) => {
    const detail = $(element);
    const title = cleanText(detail.find("summary").first().text()) || `Item ${tabIndex + 1}`;
    const content = cleanText(detail.clone().find("summary").remove().end().text());

    return {
      tab_title: title,
      tab_content: content
    };
  });

  return {
    id: createId("faq", index),
    elType: "widget",
    widgetType: "accordion",
    settings: {
      tabs,
      ...mapCommonElementorStyles(parseStyle(node.attr("style"))),
      lovable_styles: parseStyle(node.attr("style")),
      lovable_responsive_settings: createResponsiveSettings(parseStyle(node.attr("style")))
    },
    elements: []
  };
}

function createIconListWidget(
  $: cheerio.CheerioAPI,
  node: cheerio.Cheerio<Element>,
  index: number
): ElementorElement {
  const items = node
    .children("li")
    .toArray()
    .map((element) => ({
      text: cleanText($(element).text()),
      selected_icon: {
        value: "fas fa-check",
        library: "fa-solid"
      }
    }))
    .filter((item) => item.text);

  return {
    id: createId("list", index),
    elType: "widget",
    widgetType: "icon-list",
    settings: {
      icon_list: items,
      ...mapCommonElementorStyles(parseStyle(node.attr("style"))),
      ...mapTypographyStyles(parseStyle(node.attr("style"))),
      lovable_styles: parseStyle(node.attr("style")),
      lovable_responsive_settings: createResponsiveSettings(parseStyle(node.attr("style")))
    },
    elements: []
  };
}

function isButtonLike(node: cheerio.Cheerio<Element>) {
  const tag = node.prop("tagName")?.toLowerCase();
  const style = node.attr("style") ?? "";
  const className = node.attr("class") ?? "";
  const role = node.attr("role") ?? "";

  return (
    tag === "a" ||
    tag === "button" ||
    role === "button" ||
    node.attr("type") === "submit" ||
    node.attr("onclick") !== undefined ||
    /cursor\s*:\s*pointer/i.test(style) ||
    /\b(btn|button|cta|checkout|buy|cart)\b/i.test(className)
  );
}

function isContainerLike(node: cheerio.Cheerio<Element>) {
  const tag = node.prop("tagName")?.toLowerCase();
  const styles = parseStyle(node.attr("style"));
  const className = node.attr("class") ?? "";

  return (
    ["section", "main", "header", "footer", "article", "nav", "aside", "div"].includes(tag ?? "") ||
    styles.display?.includes("grid") ||
    styles.display?.includes("flex") ||
    className.toLowerCase().includes("card")
  );
}

function hasDirectVisibleText(node: cheerio.Cheerio<Element>) {
  const contents = node.contents().toArray();

  return contents.some((child) => child.type === "text" && cleanText(child.data ?? ""));
}

function getVisualOrder(element: Element) {
  const value = element.attribs?.["data-visual-order"];

  return value ? Number(value) : Number.MAX_SAFE_INTEGER;
}

function sortByVisualOrder(elements: Element[]) {
  return [...elements].sort((left, right) => getVisualOrder(left) - getVisualOrder(right));
}

function convertElementToElementor(
  $: cheerio.CheerioAPI,
  element: Element,
  counter: { value: number }
): ElementorElement[] {
  const node = $(element);
  const tag = element.name.toLowerCase();
  const children = node
    .children()
    .toArray()
    .filter((child): child is Element => child.type === "tag");
  const visualChildren = sortByVisualOrder(children);
  const directText = node
    .contents()
    .toArray()
    .filter((child) => child.type === "text")
    .map((child) => cleanText(child.data ?? ""))
    .filter(Boolean)
    .join(" ");

  counter.value += 1;
  const index = counter.value;

  if (/^h[1-6]$/.test(tag)) return [createHeadingWidget(node, index)];
  if (isButtonLike(node)) return [createButtonWidget(node, index)];
  if (tag === "img") return [createImageWidget(node, index)];
  if (tag === "details" || node.find("details").length > 0) {
    return [createAccordionWidget($, node, index)];
  }
  if ((tag === "ul" || tag === "ol") && node.children("li").length > 0) {
    return [createIconListWidget($, node, index)];
  }
  if (tag === "table" || tag === "svg" || tag === "canvas" || tag === "iframe") {
    return [
      {
        id: createId("html", index),
        elType: "widget",
        widgetType: "html",
        settings: {
          html: $.html(element),
          lovable_preserved_complex_element: tag
        },
        elements: []
      }
    ];
  }

  if (isContainerLike(node)) {
    const childElements = visualChildren.flatMap((child) =>
      convertElementToElementor($, child, counter)
    );

    if (directText) {
      childElements.unshift(createTextWidget(node, index + 100000, directText));
    }

    if (!childElements.length && cleanText(node.text())) {
      childElements.push(createTextWidget(node, index + 200000));
    }

    return [createContainer(createId("container", index), node, childElements)];
  }

  if (children.length) {
    const childElements = visualChildren.flatMap((child) =>
      convertElementToElementor($, child, counter)
    );

    if (directText) {
      childElements.unshift(createTextWidget(node, index + 300000, directText));
    }

    return childElements;
  }

  if (hasDirectVisibleText(node) || cleanText(node.text())) {
    return [createTextWidget(node, index)];
  }

  return [];
}

export function convertCleanHtmlToElementor(
  cleanHtml: string,
  title = "Elementor Page"
): ElementorDocument {
  const $ = cheerio.load(cleanHtml);
  let roots = $("body")
    .children()
    .toArray()
    .filter((element): element is Element => element.type === "tag");

  if (roots.length === 1) {
    const wrapperChildren = $(roots[0])
      .children("header,main,section,footer,article,nav")
      .toArray()
      .filter((element): element is Element => element.type === "tag");

    if (wrapperChildren.length > 1) {
      roots = wrapperChildren;
    }
  }

  const counter = { value: 0 };
  const content = roots.flatMap((element) => convertElementToElementor($, element, counter));

  return {
    version: "1.0",
    title: cleanText($("title").first().text()) || title,
    type: "page",
    content
  };
}

function escapeHtmlAttribute(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function estimateDocumentHeight($: cheerio.CheerioAPI) {
  const bottoms = $("[data-layout-y][data-layout-height]")
    .toArray()
    .map((element) => {
      const node = $(element);
      const y = Number(node.attr("data-layout-y") ?? 0);
      const height = Number(node.attr("data-layout-height") ?? 0);

      return y + height;
    })
    .filter((value) => Number.isFinite(value));

  return Math.max(900, Math.ceil(Math.max(...bottoms, 0) + 40));
}

function createPixelPerfectElementorDocument(
  cleanHtml: string,
  title = "Elementor Page"
): ElementorDocument {
  const $ = cheerio.load(cleanHtml);
  const height = estimateDocumentHeight($);
  const srcdoc = escapeHtmlAttribute(cleanHtml);
  const html = `<iframe
  class="lovable-pixel-perfect-frame"
  title="${escapeHtmlAttribute(cleanText($("title").first().text()) || title)}"
  srcdoc="${srcdoc}"
  loading="eager"
  style="display:block;width:100%;max-width:100%;height:${height}px;border:0;margin:0;padding:0;overflow:hidden;background:#faf6f1;"
></iframe>
<script>
(function(){
  var frame = document.currentScript && document.currentScript.previousElementSibling;
  if (!frame || frame.tagName !== 'IFRAME') return;
  function resize(){
    try {
      var doc = frame.contentDocument || frame.contentWindow.document;
      var body = doc.body;
      var root = doc.documentElement;
      var height = Math.max(
        body ? body.scrollHeight : 0,
        root ? root.scrollHeight : 0,
        body ? body.offsetHeight : 0,
        root ? root.offsetHeight : 0
      );
      if (height) frame.style.height = (height + 20) + 'px';
    } catch (error) {}
  }
  frame.addEventListener('load', resize);
  setTimeout(resize, 300);
  setTimeout(resize, 1200);
})();
</script>`;

  return {
    version: "0.4",
    title: cleanText($("title").first().text()) || title,
    type: "page",
    content: [
      {
        id: createId("section", 1),
        elType: "section",
        settings: {
          layout: "full_width",
          content_width: "full",
          gap: "no",
          stretch_section: "section-stretched",
          _padding: { unit: "px", top: 0, right: 0, bottom: 0, left: 0, isLinked: true },
          _margin: { unit: "px", top: 0, right: 0, bottom: 0, left: 0, isLinked: true },
          _css_classes: "lovable-elementor-clone-section"
        },
        elements: [
          {
            id: createId("column", 1),
            elType: "column",
            settings: {
              _column_size: 100,
              _inline_size: null,
              _padding: { unit: "px", top: 0, right: 0, bottom: 0, left: 0, isLinked: true },
              _margin: { unit: "px", top: 0, right: 0, bottom: 0, left: 0, isLinked: true }
            },
            elements: [
              {
                id: createId("html-clone", 1),
                elType: "widget",
                widgetType: "html",
                settings: {
                  html,
                  lovable_clone_mode: "iframe_srcdoc_pixel_perfect",
                  lovable_clone_note:
                    "HTML completo isolado em iframe srcdoc para impedir que CSS do Elementor/tema quebre o layout visual.",
                  _padding: { unit: "px", top: 0, right: 0, bottom: 0, left: 0, isLinked: true },
                  _margin: { unit: "px", top: 0, right: 0, bottom: 0, left: 0, isLinked: true }
                },
                elements: []
              }
            ]
          }
        ]
      }
    ]
  };
}

function countExportedElements(elementorJson: ElementorDocument): number {
  function count(elements: ElementorElement[]): number {
    return elements.reduce((total, element) => total + 1 + count(element.elements), 0);
  }

  return count(elementorJson.content);
}

function flattenElementorElements(elements: ElementorElement[]): ElementorElement[] {
  return elements.flatMap((element) => [
    element,
    ...flattenElementorElements(element.elements)
  ]);
}

function countWidgets(elementorJson: ElementorDocument, widgetType: string) {
  return flattenElementorElements(elementorJson.content).filter(
    (element) => element.widgetType === widgetType
  ).length;
}

function getImageSourceFromCapture(element: VisualElementCapture) {
  const source = element.src || extractCssUrls(element.styles["background-image"] ?? "")[0] || "";

  return source.split(",")[0]?.trim().split(/\s+/)[0] ?? source;
}

function createRecoveredContainer(recoveredElements: ElementorElement[]): ElementorElement {
  return {
    id: createId("recovered-container", 99999),
    elType: "container",
    settings: {
      _css_classes: "lovable-recovered-content",
      lovable_recovered_content: true,
      content_width: "full"
    },
    elements: recoveredElements
  };
}

function recoverMissingContent(
  elementorJson: ElementorDocument,
  capture: VisualCapture
): {
  elementorJson: ElementorDocument;
  recovered: ConversionReport["elementosRecuperados"];
} {
  let jsonText = normalizeJsonText(JSON.stringify(elementorJson));
  const recovered: ConversionReport["elementosRecuperados"] = [];
  const recoveredElements: ElementorElement[] = [];
  const seen = new Set<string>();

  function addRecovered(type: "text" | "image" | "button" | "heading", value: string, element: ElementorElement) {
    const key = `${type}:${normalizeJsonText(value)}`;

    if (!value || seen.has(key)) return;

    seen.add(key);
    recovered.push({ type, value });
    recoveredElements.push(element);
    jsonText += ` ${normalizeJsonText(JSON.stringify(element))}`;
  }

  for (const element of [...capture.elements].sort((left, right) => left.visualOrder - right.visualOrder)) {
    const directText = element.directText || "";
    const fullText = element.text || "";
    const textToCheck = normalizeJsonText(directText || fullText);
    const commonSettings = {
      lovable_recovered: true,
      lovable_visual_order: element.visualOrder,
      lovable_styles: element.styles,
      lovable_layout: element.rect
    };

    if (element.kind.includes("button") || element.kind.includes("link")) {
      const buttonText = cleanText(directText || fullText || element.href || element.alt);

      if (buttonText && !jsonIncludesAnyTextVariant(jsonText, buttonText)) {
        addRecovered("button", buttonText, {
          id: createId("recovered-button", recoveredElements.length + 1),
          elType: "widget",
          widgetType: "button",
          settings: {
            ...mapButtonStyles(element.styles),
            ...commonSettings,
            text: buttonText,
            link: {
              url: element.href,
              is_external: false,
              nofollow: false
            }
          },
          elements: []
        });
      }

      continue;
    }

    if (element.kind.includes("heading")) {
      const headingText = cleanText(directText || fullText);

      if (headingText && !jsonIncludesAnyTextVariant(jsonText, headingText)) {
        addRecovered("heading", headingText, {
          id: createId("recovered-heading", recoveredElements.length + 1),
          elType: "widget",
          widgetType: "heading",
          settings: {
            ...mapCommonElementorStyles(element.styles),
            ...mapTypographyStyles(element.styles),
            ...commonSettings,
            title: headingText,
            header_size: /^h[1-6]$/.test(element.tag) ? element.tag : "h3"
          },
          elements: []
        });
      }

      continue;
    }

    if (element.kind.includes("image") || element.kind.includes("background-image")) {
      const source = getImageSourceFromCapture(element);
      const signature = normalizeJsonText(source.split("/").filter(Boolean).at(-1) ?? source);

      if (source && signature && !jsonText.includes(signature)) {
        addRecovered("image", source, {
          id: createId("recovered-image", recoveredElements.length + 1),
          elType: "widget",
          widgetType: "image",
          settings: {
            ...mapImageStyles(element.styles),
            ...commonSettings,
            image: {
              url: source,
              alt: element.alt
            },
            image_size: "full"
          },
          elements: []
        });
      }

      continue;
    }

    if (element.kind.includes("text") && textToCheck && !jsonIncludesAnyTextVariant(jsonText, directText || fullText)) {
      const text = cleanText(directText || fullText);

      addRecovered("text", text, {
        id: createId("recovered-text", recoveredElements.length + 1),
        elType: "widget",
        widgetType: "text-editor",
        settings: {
          ...mapCommonElementorStyles(element.styles),
          ...mapTypographyStyles(element.styles),
          ...commonSettings,
          editor: text
        },
        elements: []
      });
    }
  }

  if (!recoveredElements.length) {
    return { elementorJson, recovered };
  }

  return {
    elementorJson: {
      ...elementorJson,
      content: [...elementorJson.content, createRecoveredContainer(recoveredElements)]
    },
    recovered
  };
}

function createPreviewHtml(cleanHtml: string, elementorJson: ElementorDocument) {
  return `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Preview convertido</title>
    <style>
      body { margin: 0; font-family: Arial, sans-serif; background: #f5f5f5; color: #111; }
      .preview-shell { display: grid; grid-template-columns: minmax(0, 1fr) 360px; min-height: 100vh; }
      .preview-frame { background: #fff; overflow: auto; }
      .preview-report { border-left: 1px solid #ddd; padding: 20px; overflow: auto; }
      pre { white-space: pre-wrap; word-break: break-word; font-size: 12px; }
      @media (max-width: 900px) { .preview-shell { grid-template-columns: 1fr; } .preview-report { border-left: 0; border-top: 1px solid #ddd; } }
    </style>
  </head>
  <body>
    <main class="preview-shell">
      <section class="preview-frame">${cleanHtml}</section>
      <aside class="preview-report">
        <h1>Elementor JSON</h1>
        <pre>${JSON.stringify(elementorJson, null, 2).replace(/</g, "&lt;")}</pre>
      </aside>
    </main>
  </body>
</html>`;
}

async function screenshotStaticHtml(
  html: string,
  outputPath: string,
  viewport: ViewportDefinition = VIEWPORTS[0]
) {
  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: viewport.width, height: viewport.height }
    });

    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined);
    await waitForImages(page);
    await page.screenshot({ path: outputPath, fullPage: true });
    await browser.close();
    return true;
  } catch {
    // Screenshots are validation artifacts; conversion can still continue and report the capture error.
    return false;
  }
}

async function getFileSize(filePath: string | undefined) {
  if (!filePath) return 0;

  try {
    return (await stat(filePath)).size;
  } catch {
    return 0;
  }
}

async function compareScreenshots(
  screenshots: VisualCapture["screenshots"]
): Promise<ConversionReport["visualComparison"]> {
  const entries = await Promise.all(
    VIEWPORTS.map(async (viewport) => {
      const suffix = viewport.name[0].toUpperCase() + viewport.name.slice(1);
      const original = screenshots[
        `original${suffix}` as keyof VisualCapture["screenshots"]
      ];
      const clean = screenshots[
        `clean${suffix}` as keyof VisualCapture["screenshots"]
      ];
      const preview = screenshots[
        `preview${suffix}` as keyof VisualCapture["screenshots"]
      ];
      const originalBytes = await getFileSize(original);
      const cleanBytes = await getFileSize(clean);
      const previewBytes = await getFileSize(preview);
      const cleanSizeRatio = originalBytes ? cleanBytes / originalBytes : 0;
      const previewSizeRatio = originalBytes ? previewBytes / originalBytes : 0;

      return [
        viewport.name,
        {
          originalScreenshot: original,
          cleanScreenshot: clean,
          previewScreenshot: preview,
          originalBytes,
          cleanBytes,
          previewBytes,
          cleanSizeRatio,
          previewSizeRatio,
          passed:
            originalBytes > 0 &&
            cleanBytes > 0 &&
            previewBytes > 0 &&
            cleanSizeRatio >= 0.2 &&
            cleanSizeRatio <= 5 &&
            previewSizeRatio >= 0.05 &&
            previewSizeRatio <= 50
        }
      ] as const;
    })
  );

  return Object.fromEntries(entries) as ConversionReport["visualComparison"];
}

function validateConversion(
  capture: VisualCapture,
  elementorJson: ElementorDocument,
  unloadedImages: string[],
  blockOnValidationFailure: boolean,
  visualComparison: ConversionReport["visualComparison"],
  recovered: ConversionReport["elementosRecuperados"]
): ConversionReport {
  const jsonText = normalizeJsonText(JSON.stringify(elementorJson));
  const textElements = capture.elements.filter((element) =>
    element.kind.includes("text") && element.directText
  );
  const imageElements = capture.elements.filter((element) =>
    element.kind.includes("image") || element.kind.includes("background-image")
  );
  const buttonElements = capture.elements.filter((element) =>
    element.kind.includes("button") || element.kind.includes("link")
  );
  const headingElements = capture.elements.filter((element) =>
    element.kind.includes("heading")
  );
  const elementosPerdidos: ConversionReport["elementosPerdidos"] = [];

  for (const element of textElements) {
    if (element.directText && !jsonIncludesAnyTextVariant(jsonText, element.directText)) {
      elementosPerdidos.push({ type: "text", value: element.directText });
    }
  }

  for (const element of headingElements) {
    const text = element.directText || element.text;
    if (text && !jsonIncludesAnyTextVariant(jsonText, text)) {
      elementosPerdidos.push({ type: "heading", value: element.directText || element.text });
    }
  }

  for (const element of buttonElements) {
    const text = element.directText || element.text || element.href;
    if (text && !jsonIncludesAnyTextVariant(jsonText, text)) {
      elementosPerdidos.push({ type: "button", value: element.directText || element.text || element.href });
    }
  }

  for (const element of imageElements) {
    const value = element.src || extractCssUrls(element.styles["background-image"] ?? "")[0] || element.alt;
    const signature = value.split("/").filter(Boolean).at(-1) ?? element.alt;

    if (signature && !jsonText.includes(normalizeJsonText(signature))) {
      elementosPerdidos.push({ type: "image", value });
    }
  }

  const uniqueLost = elementosPerdidos.filter((item, index, items) =>
    items.findIndex((candidate) => candidate.type === item.type && candidate.value === item.value) === index
  );
  const imagensNaoCarregadas = [...new Set([...capture.imagesNotLoaded, ...unloadedImages])];
  const captureFailed = capture.errors.length > 0 || capture.elements.length === 0;
  const visualComparisonFailed = Object.values(visualComparison).some(
    (comparison) =>
      (comparison.originalBytes > 0 || comparison.cleanBytes > 0 || comparison.previewBytes > 0) &&
      !comparison.passed
  );
  const totalElementosExportados = countExportedElements(elementorJson);
  const hasPixelPerfectClone = jsonText.includes("iframe_srcdoc_pixel_perfect");
  const totalTextosConvertidos =
    hasPixelPerfectClone
      ? textElements.length + headingElements.length
      : countWidgets(elementorJson, "text-editor") + countWidgets(elementorJson, "heading");
  const totalImagensEncontradas = imageElements.length;
  const totalImagensConvertidas = hasPixelPerfectClone
    ? totalImagensEncontradas
    : countWidgets(elementorJson, "image");
  const totalBotoesEncontrados = buttonElements.length;
  const totalBotoesConvertidos = hasPixelPerfectClone
    ? totalBotoesEncontrados
    : countWidgets(elementorJson, "button");
  const totalHeadingsConvertidos = hasPixelPerfectClone
    ? headingElements.length
    : countWidgets(elementorJson, "heading");
  const isCompletelyBroken =
    totalElementosExportados === 0 ||
    !Array.isArray(elementorJson.content) ||
    elementorJson.content.length === 0;
  const warnings = [
    ...uniqueLost.map((item) => `Item possivelmente nao convertido (${item.type}): ${item.value}`),
    ...recovered.map((item) => `Item recuperado automaticamente (${item.type}): ${item.value}`),
    ...imagensNaoCarregadas.map((image) => `Imagem nao carregada: ${image}`),
    ...(captureFailed ? ["Captura visual falhou ou nao retornou elementos visiveis."] : []),
    ...(visualComparisonFailed ? ["Comparacao visual gerou diferencas; revisar screenshots."] : [])
  ];
  const missingCriticalContent = uniqueLost.length > 0;
  const exportBlocked =
    blockOnValidationFailure &&
    (isCompletelyBroken || missingCriticalContent);

  return {
    totalTextosEncontrados: textElements.length,
    totalTextosConvertidos,
    totalImagensEncontradas,
    totalImagensConvertidas,
    totalBotoesEncontrados,
    totalBotoesConvertidos,
    totalHeadingsEncontrados: headingElements.length,
    totalHeadingsConvertidos,
    totalElementosExportados,
    elementosPerdidos: uniqueLost.slice(0, 100),
    elementosRecuperados: recovered.slice(0, 100),
    imagensNaoCarregadas,
    warnings: warnings.slice(0, 200),
    status: exportBlocked ? "blocked" : warnings.length ? "warning" : "success",
    exportBlocked,
    screenshots: capture.screenshots,
    visualComparison,
    captureFailed,
    errors: capture.errors
  };
}

export async function runConversionPipeline(
  html: string,
  options: PipelineOptions = {}
): Promise<ConversionPipelineResult> {
  const persistArtifacts = options.persistArtifacts ?? true;
  const outputDir = persistArtifacts
    ? options.outputDir ?? path.join(process.cwd(), ".conversion-output", crypto.randomUUID())
    : null;

  if (outputDir) {
    await mkdir(outputDir, { recursive: true });
  }

  const capture = await captureVisualPage(html, options, outputDir);
  const { cleanHtml, unloadedImages } = await createCleanHtml(
    capture.html,
    outputDir,
    options.rewriteAssetUrls ?? false
  );
  const structuralElementorJson = convertCleanHtmlToElementor(cleanHtml, capture.title);
  const repaired = recoverMissingContent(structuralElementorJson, capture);
  const elementorJson = createPixelPerfectElementorDocument(cleanHtml, capture.title);
  const editableStructuralElementorJson = repaired.elementorJson;
  const previewHtml = createPreviewHtml(cleanHtml, elementorJson);

  if (outputDir) {
    await writeFile(path.join(outputDir, "clean-output.html"), cleanHtml, "utf8");
    await writeFile(
      path.join(outputDir, "elementor-editable-structural-template.json"),
      JSON.stringify(editableStructuralElementorJson, null, 2),
      "utf8"
    );
    await writeFile(
      path.join(outputDir, "elementor-template.json"),
      JSON.stringify(elementorJson, null, 2),
      "utf8"
    );
    await writeFile(path.join(outputDir, "preview.html"), previewHtml, "utf8");

    capture.screenshots.clean = path.join(outputDir, "clean-output.png");
    capture.screenshots.preview = path.join(outputDir, "preview.png");

    for (const viewport of VIEWPORTS) {
      const suffix = viewport.name[0].toUpperCase() + viewport.name.slice(1);
      const cleanKey = `clean${suffix}` as keyof VisualCapture["screenshots"];
      const previewKey = `preview${suffix}` as keyof VisualCapture["screenshots"];

      capture.screenshots[cleanKey] = path.join(
        outputDir,
        `clean-output-${viewport.name}.png`
      );
      capture.screenshots[previewKey] = path.join(
        outputDir,
        `preview-${viewport.name}.png`
      );

      const cleanOk = await screenshotStaticHtml(
        cleanHtml,
        capture.screenshots[cleanKey] ?? "",
        viewport
      );
      const previewOk = await screenshotStaticHtml(
        previewHtml,
        capture.screenshots[previewKey] ?? "",
        viewport
      );

      if (!cleanOk) {
        capture.errors.push(`Falha ao gerar screenshot clean ${viewport.name}.`);
      }
      if (!previewOk) {
        capture.errors.push(`Falha ao gerar screenshot preview ${viewport.name}.`);
      }
    }

    capture.screenshots.clean = capture.screenshots.cleanDesktop;
    capture.screenshots.preview = capture.screenshots.previewDesktop;
  }

  const visualComparison = await compareScreenshots(capture.screenshots);
  const report = validateConversion(
    capture,
    elementorJson,
    unloadedImages,
    options.blockOnValidationFailure ?? true,
    visualComparison,
    repaired.recovered
  );

  if (outputDir) {
    await writeFile(
      path.join(outputDir, "conversion-report.json"),
      JSON.stringify(report, null, 2),
      "utf8"
    );
  }

  return {
    elementorJson,
    cleanHtml,
    previewHtml,
    report,
    outputDir
  };
}
