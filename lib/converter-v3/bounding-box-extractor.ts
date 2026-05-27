import type { CapturedNode, CapturedNodeAsset } from "@/lib/converter-v3/contracts/capture";
import {
  buildCapturedBackgroundLayers,
  extractCssUrls,
  uniqueNonEmpty
} from "@/lib/converter-v3/visual-asset-utils";

export const CAPTURED_STYLE_PROPERTIES = [
  "display",
  "position",
  "top",
  "right",
  "bottom",
  "left",
  "inset",
  "width",
  "height",
  "min-width",
  "max-width",
  "min-height",
  "max-height",
  "aspect-ratio",
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
  "grid-auto-flow",
  "grid-auto-columns",
  "grid-auto-rows",
  "flex-direction",
  "flex-wrap",
  "flex-grow",
  "flex-shrink",
  "flex-basis",
  "align-items",
  "justify-content",
  "place-items",
  "place-content",
  "background",
  "background-color",
  "background-image",
  "background-size",
  "background-position",
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
  "text-align",
  "cursor",
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
  "pointer-events"
] as const;

export const CAPTURED_THEME_CUSTOM_PROPERTIES = [
  "--background",
  "--foreground",
  "--primary",
  "--secondary",
  "--accent",
  "--muted",
  "--card",
  "--border",
  "--radius",
  "--input",
  "--ring",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--destructive",
  "--destructive-foreground",
  "--tw-gradient-from",
  "--tw-gradient-to",
  "--tw-gradient-stops",
  "--tw-shadow",
  "--tw-shadow-colored",
  "--tw-ring-color",
  "--tw-ring-shadow"
] as const;

export type ExtractedViewportNode = {
  id: string;
  computedStyles: Record<string, string>;
  box: CapturedNode["box"];
  isVisible: boolean;
  asset: CapturedNodeAsset;
};

export type ExtractedDomNode = CapturedNode;

function normalizeAsset(asset: CapturedNodeAsset): CapturedNodeAsset {
  const backgroundLayers =
    asset.backgroundLayers && asset.backgroundLayers.length > 0
      ? asset.backgroundLayers
      : buildCapturedBackgroundLayers(asset.backgroundImage);
  const backgroundUrls =
    asset.backgroundUrls && asset.backgroundUrls.length > 0
      ? asset.backgroundUrls
      : extractCssUrls(asset.backgroundImage);
  const srcsetCandidates = uniqueNonEmpty(asset.srcsetCandidates ?? []);
  const pictureSources = uniqueNonEmpty(asset.pictureSources ?? []);
  const lazySources = uniqueNonEmpty(asset.lazySources ?? []);
  const normalized = Object.fromEntries(
    Object.entries({
      ...asset,
      srcsetCandidates,
      pictureSources,
      lazySources,
      backgroundLayers,
      backgroundUrls,
      hasGradientBackground:
        asset.hasGradientBackground ?? backgroundLayers.some((layer) => layer.type === "gradient")
    }).filter(([, value]) => {
      if (Array.isArray(value)) {
        return value.length > 0;
      }

      return Boolean(value);
    })
  ) as CapturedNodeAsset;

  return normalized;
}

function normalizeCustomStyles(styles: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(styles).filter(([, value]) => Boolean(value))
  ) as Record<string, string>;
}

export async function extractViewportNodes(
  page: {
    evaluate: <TArg, TResult>(fn: (arg: TArg) => TResult, arg: TArg) => Promise<TResult>;
  },
  properties: readonly string[] = CAPTURED_STYLE_PROPERTIES
): Promise<ExtractedViewportNode[]> {
  return page.evaluate(({ capturedProperties, themeProperties }: {
    capturedProperties: readonly string[];
    themeProperties: readonly string[];
  }) => {
    const elements = [document.body, ...Array.from(document.body.querySelectorAll<HTMLElement>("*"))];
    const htmlComputed = window.getComputedStyle(document.documentElement);
    const backgroundFallbackProperties = [
      "background",
      "background-image",
      "background-size",
      "background-position",
      "background-repeat",
      "background-clip",
      "background-blend-mode",
      "background-origin",
      "background-attachment"
    ];
    const themePropertyMatcher =
      /^--(?:(?:tw-(?:gradient|shadow|ring))|background|foreground|primary|secondary|accent|muted|card|border|radius|ring|input|surface|theme|brand|hero|header|footer|overlay|shadow|gradient|color)/i;
    const parsePixel = (value: string | null | undefined) => {
      const normalized = (value || "").trim().toLowerCase();

      if (!normalized || normalized === "auto") {
        return undefined;
      }

      const match = normalized.match(/^(-?\d+(?:\.\d+)?)px$/);

      if (match) {
        return Number.parseFloat(match[1]);
      }

      const numeric = Number.parseFloat(normalized);
      return Number.isFinite(numeric) ? numeric : undefined;
    };
    const resolveBodyBackgroundValue = (element: HTMLElement, property: string, fallbackValue: string) => {
      if (element !== document.body) {
        return fallbackValue;
      }

      if (property === "background-color") {
        const normalized = fallbackValue.replace(/\s+/g, "").toLowerCase();

        if (
          !fallbackValue ||
          normalized === "transparent" ||
          normalized === "rgba(0,0,0,0)" ||
          normalized === "none"
        ) {
          return htmlComputed.getPropertyValue(property).trim();
        }
      }

      if (
        backgroundFallbackProperties.includes(property) &&
        (!fallbackValue || fallbackValue === "none")
      ) {
        return htmlComputed.getPropertyValue(property).trim();
      }

      if (property.startsWith("--") && !fallbackValue) {
        return htmlComputed.getPropertyValue(property).trim();
      }

      return fallbackValue;
    };
    const shouldKeepCustomProperty = (name: string, value: string) => {
      if (!value) {
        return false;
      }

      if (themeProperties.includes(name)) {
        return true;
      }

      return themePropertyMatcher.test(name);
    };
    const extractCustomProperties = (
      element: HTMLElement,
      computed: CSSStyleDeclaration
    ) => {
      const names = new Set<string>(themeProperties);

      for (let index = 0; index < computed.length; index += 1) {
        const propertyName = computed.item(index);

        if (propertyName?.startsWith("--")) {
          names.add(propertyName);
        }
      }

      return [...names].reduce<Record<string, string>>((acc, property) => {
        const value = resolveBodyBackgroundValue(
          element,
          property,
          computed.getPropertyValue(property).trim()
        );

        if (shouldKeepCustomProperty(property, value)) {
          acc[property] = value;
        }

        return acc;
      }, {});
    };
    const splitBackgroundLayers = (value: string) => {
      const layers: string[] = [];
      let current = "";
      let depth = 0;
      let quote: '"' | "'" | null = null;

      for (let index = 0; index < value.length; index += 1) {
        const char = value[index];
        const previous = index > 0 ? value[index - 1] : "";

        if (quote) {
          current += char;

          if (char === quote && previous !== "\\") {
            quote = null;
          }

          continue;
        }

        if (char === '"' || char === "'") {
          quote = char;
          current += char;
          continue;
        }

        if (char === "(") {
          depth += 1;
          current += char;
          continue;
        }

        if (char === ")") {
          depth = Math.max(depth - 1, 0);
          current += char;
          continue;
        }

        if (char === "," && depth === 0) {
          const trimmed = current.trim();

          if (trimmed) {
            layers.push(trimmed);
          }

          current = "";
          continue;
        }

        current += char;
      }

      const trimmed = current.trim();

      if (trimmed) {
        layers.push(trimmed);
      }

      return layers;
    };
    const extractCssUrls = (value: string) =>
      splitBackgroundLayers(value).flatMap((layer) =>
        [...layer.matchAll(/url\((['"]?)(.*?)\1\)/gi)]
          .map((match) => match[2]?.trim())
          .filter((item): item is string => Boolean(item))
      );
    const buildBackgroundLayers = (value: string) =>
      splitBackgroundLayers(value).map((layer, index) => {
        const url = [...layer.matchAll(/url\((['"]?)(.*?)\1\)/gi)]
          .map((match) => match[2]?.trim())
          .find((item): item is string => Boolean(item));
        const normalized = layer.trim();
        const type: "gradient" | "image" | "other" =
          /(?:^|[^-])(linear|radial|conic)-gradient\(/i.test(normalized)
            ? "gradient"
            : url
              ? "image"
              : "other";

        return {
          index,
          type,
          value: normalized,
          url
        };
      });
    const extractSrcsetCandidates = (value: string | null | undefined) => {
      const input = value || "";
      const candidates: string[] = [];
      let index = 0;

      while (index < input.length) {
        while (index < input.length && /[\s,]/.test(input[index] || "")) {
          index += 1;
        }

        if (index >= input.length) {
          break;
        }

        const isDataUrl = input.slice(index, index + 5).toLowerCase() === "data:";
        let candidate = "";

        while (index < input.length) {
          const char = input[index] || "";

          if (/\s/.test(char) || (!isDataUrl && char === ",")) {
            break;
          }

          candidate += char;
          index += 1;
        }

        const normalizedCandidate = candidate.trim();

        if (normalizedCandidate) {
          candidates.push(normalizedCandidate);
        }

        while (index < input.length && input[index] !== ",") {
          index += 1;
        }

        if (input[index] === ",") {
          index += 1;
        }
      }

      return candidates;
    };
    const uniqueValues = (values: Array<string | null | undefined>) => {
      const seen = new Set<string>();
      const result: string[] = [];

      values.forEach((value) => {
        const normalized = value?.trim();

        if (!normalized || seen.has(normalized)) {
          return;
        }

        seen.add(normalized);
        result.push(normalized);
      });

      return result;
    };
    const resolveAssetFromBackgroundImage = (backgroundImage: string) =>
      backgroundImage && backgroundImage !== "none" ? backgroundImage : undefined;
    const resolveElementAsset = (element: HTMLElement) => {
      const computed = window.getComputedStyle(element);
      const backgroundImage = resolveBodyBackgroundValue(
        element,
        "background-image",
        computed.getPropertyValue("background-image").trim()
      );
      const srcsetCandidates = uniqueValues([
        ...extractSrcsetCandidates(element.getAttribute("srcset")),
        ...extractSrcsetCandidates(element.getAttribute("data-srcset")),
        ...extractSrcsetCandidates(element.getAttribute("data-lazy-srcset"))
      ]);
      const lazySources = uniqueValues([
        element.getAttribute("data-src"),
        element.getAttribute("data-lazy-src"),
        element.getAttribute("data-original"),
        element.getAttribute("data-url")
      ]);
      const pictureSources = uniqueValues(
        element.tagName.toLowerCase() === "picture"
          ? Array.from(element.querySelectorAll("source")).flatMap((source) => [
              ...extractSrcsetCandidates(source.getAttribute("srcset")),
              ...extractSrcsetCandidates(source.getAttribute("data-srcset")),
              ...extractSrcsetCandidates(source.getAttribute("data-lazy-srcset"))
            ])
          : []
      );
      const href =
        element instanceof HTMLAnchorElement
          ? element.href
          : element.getAttribute("href") ||
            element.getAttribute("data-href") ||
            element.getAttribute("data-url");
      const currentSrc =
        element instanceof HTMLImageElement
          ? element.currentSrc || element.src || undefined
          : element.tagName.toLowerCase() === "picture"
            ? element.querySelector("img")?.currentSrc ||
              element.querySelector("img")?.getAttribute("src") ||
              undefined
            : undefined;
      const src =
        currentSrc ||
        (element instanceof HTMLSourceElement
          ? srcsetCandidates[0] || element.getAttribute("src") || undefined
          : element.tagName.toLowerCase() === "picture"
            ? element.querySelector("img")?.getAttribute("src") ||
              pictureSources[0] ||
              undefined
            : element instanceof SVGSVGElement
              ? "data:image/svg+xml;base64," +
                window.btoa(unescape(encodeURIComponent(new XMLSerializer().serializeToString(element))))
              : element.getAttribute("src") ||
                srcsetCandidates[0] ||
                lazySources[0] ||
                undefined);
      const backgroundLayers = buildBackgroundLayers(backgroundImage);

      return {
        href: href?.trim() || undefined,
        src: src?.trim() || undefined,
        currentSrc: currentSrc?.trim() || undefined,
        srcsetCandidates,
        pictureSources,
        lazySources,
        alt:
          (element.getAttribute("alt") ||
            element.getAttribute("aria-label") ||
            element.getAttribute("title") ||
            "").trim() || undefined,
        poster: (element.getAttribute("poster") || "").trim() || undefined,
        backgroundImage: resolveAssetFromBackgroundImage(backgroundImage),
        backgroundUrls: extractCssUrls(backgroundImage),
        backgroundLayers,
        hasGradientBackground: backgroundLayers.some((layer) => layer.type === "gradient")
      };
    };
    const normalizePseudoContent = (value: string) => {
      const normalized = (value || "").trim();

      if (!normalized || normalized === "none" || normalized === "normal") {
        return undefined;
      }

      return normalized.replace(/^['"]|['"]$/g, "");
    };
    const hasVisibleColor = (value: string | undefined) => {
      const normalized = (value || "").replace(/\s+/g, "").toLowerCase();
      return Boolean(
        normalized &&
          normalized !== "transparent" &&
          normalized !== "rgba(0,0,0,0)" &&
          normalized !== "none"
      );
    };
    const hasVisibleBorder = (value: string | undefined) => {
      const normalized = (value || "").replace(/\s+/g, " ").trim().toLowerCase();

      if (!normalized || normalized === "none") {
        return false;
      }

      return !/^0(?:px)?\s+none\b/.test(normalized);
    };
    const hasPseudoVisualContent = (styles: Record<string, string>, content: string | undefined) => {
      return (
        Boolean(content) ||
        hasVisibleColor(styles["background-color"]) ||
        Boolean(styles["background-image"] && styles["background-image"] !== "none") ||
        hasVisibleBorder(styles.border) ||
        Boolean(styles["box-shadow"] && styles["box-shadow"] !== "none")
      );
    };
    const resolvePseudoBox = (
      rect: DOMRect,
      styles: Record<string, string>
    ) => {
      const width = parsePixel(styles.width);
      const height = parsePixel(styles.height);

      if (!(width && width > 0) || !(height && height > 0)) {
        return null;
      }

      const left = parsePixel(styles.left);
      const right = parsePixel(styles.right);
      const top = parsePixel(styles.top);
      const bottom = parsePixel(styles.bottom);

      const absoluteLeft =
        left !== undefined
          ? rect.left + window.scrollX + left
          : right !== undefined
            ? rect.left + window.scrollX + rect.width - right - width
            : rect.left + window.scrollX;
      const absoluteTop =
        top !== undefined
          ? rect.top + window.scrollY + top
          : bottom !== undefined
            ? rect.top + window.scrollY + rect.height - bottom - height
            : rect.top + window.scrollY;

      return {
        x: absoluteLeft,
        y: absoluteTop,
        top: absoluteTop,
        right: absoluteLeft + width,
        bottom: absoluteTop + height,
        left: absoluteLeft,
        width,
        height,
        centerX: absoluteLeft + width / 2,
        centerY: absoluteTop + height / 2
      };
    };
    const extractPseudoElements = (element: HTMLElement, rect: DOMRect) => {
      return (["::before", "::after"] as const).flatMap((pseudo) => {
        const computed = window.getComputedStyle(element, pseudo);
        const customProperties = extractCustomProperties(element, computed);
        const computedStyles = capturedProperties.reduce<Record<string, string>>((acc, property) => {
          const value = computed.getPropertyValue(property).trim();

          if (value) {
            acc[property] = value;
          }

          return acc;
        }, {});
        const content = normalizePseudoContent(computed.getPropertyValue("content"));
        const pseudoStyles = {
          ...computedStyles,
          ...customProperties
        };
        const opacity = Number.parseFloat(computed.opacity || "1");
        const box = resolvePseudoBox(rect, pseudoStyles);
        const isVisible =
          computed.display !== "none" &&
          computed.visibility !== "hidden" &&
          opacity > 0 &&
          Boolean(box);

        if (!hasPseudoVisualContent(pseudoStyles, content) || !isVisible) {
          return [];
        }

        return [
          {
            pseudo,
            content,
            computedStyles: pseudoStyles,
            box,
            isVisible: true,
            asset: {
              backgroundImage: resolveAssetFromBackgroundImage(
                pseudoStyles["background-image"] || ""
              ),
              backgroundUrls: extractCssUrls(pseudoStyles["background-image"] || ""),
              backgroundLayers: buildBackgroundLayers(pseudoStyles["background-image"] || ""),
              hasGradientBackground: buildBackgroundLayers(
                pseudoStyles["background-image"] || ""
              ).some((layer) => layer.type === "gradient")
            }
          }
        ];
      });
    };

    elements.forEach((element, index) => {
      if (!element.getAttribute("data-capture-id")) {
        element.setAttribute("data-capture-id", `capture-node-${index + 1}`);
      }
    });

    return elements.map((element, index) => {
      const computed = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const asset = resolveElementAsset(element);
      const computedStyles = capturedProperties.reduce((acc: Record<string, string>, property: string) => {
        const rawValue = computed.getPropertyValue(property);
        const value = resolveBodyBackgroundValue(element, property, rawValue).trim();

        if (value) {
          acc[property] = value;
        }

        return acc;
      }, {});
      Object.assign(computedStyles, extractCustomProperties(element, computed));
      const hasVisiblePixels = rect.width > 0 && rect.height > 0;
      const isVisible =
        computed.display !== "none" &&
        computed.visibility !== "hidden" &&
        computed.opacity !== "0" &&
        !element.hasAttribute("hidden") &&
        element.getAttribute("aria-hidden") !== "true" &&
        hasVisiblePixels;

      const absoluteLeft = rect.left + window.scrollX;
      const absoluteTop = rect.top + window.scrollY;
      const width = Math.max(rect.width, 0);
      const height = Math.max(rect.height, 0);
      const absoluteRight = absoluteLeft + width;
      const absoluteBottom = absoluteTop + height;

      return {
        id: element.getAttribute("data-capture-id") || `capture-node-${index + 1}`,
        computedStyles,
        box: hasVisiblePixels
          ? {
              x: absoluteLeft,
              y: absoluteTop,
              top: absoluteTop,
              right: absoluteRight,
              bottom: absoluteBottom,
              left: absoluteLeft,
              width,
              height,
              centerX: absoluteLeft + width / 2,
              centerY: absoluteTop + height / 2
            }
          : null,
        isVisible,
        asset,
        pseudoElements: extractPseudoElements(element, rect)
      };
    });
  }, {
    capturedProperties: properties,
    themeProperties: CAPTURED_THEME_CUSTOM_PROPERTIES
  });
}

export async function extractRenderedDomNodes(
  page: {
    evaluate: <TArg, TResult>(fn: (arg: TArg) => TResult, arg: TArg) => Promise<TResult>;
  },
  properties: readonly string[] = CAPTURED_STYLE_PROPERTIES
): Promise<{
  title: string;
  renderedHtml: string;
  css: string;
  nodes: ExtractedDomNode[];
}> {
  const result = await page.evaluate(({
    capturedProperties,
    themeProperties
  }: {
    capturedProperties: readonly string[];
    themeProperties: readonly string[];
  }) => {
    const elements = [document.body, ...Array.from(document.body.querySelectorAll<HTMLElement>("*"))];
    const htmlComputed = window.getComputedStyle(document.documentElement);
    const backgroundFallbackProperties = [
      "background",
      "background-image",
      "background-size",
      "background-position",
      "background-repeat",
      "background-clip",
      "background-blend-mode",
      "background-origin",
      "background-attachment"
    ];
    const themePropertyMatcher =
      /^--(?:(?:tw-(?:gradient|shadow|ring))|background|foreground|primary|secondary|accent|muted|card|border|radius|ring|input|surface|theme|brand|hero|header|footer|overlay|shadow|gradient|color)/i;
    const parsePixel = (value: string | null | undefined) => {
      const normalized = (value || "").trim().toLowerCase();

      if (!normalized || normalized === "auto") {
        return undefined;
      }

      const match = normalized.match(/^(-?\d+(?:\.\d+)?)px$/);

      if (match) {
        return Number.parseFloat(match[1]);
      }

      const numeric = Number.parseFloat(normalized);
      return Number.isFinite(numeric) ? numeric : undefined;
    };
    const resolveBodyBackgroundValue = (element: HTMLElement, property: string, fallbackValue: string) => {
      if (element !== document.body) {
        return fallbackValue;
      }

      if (property === "background-color") {
        const normalized = fallbackValue.replace(/\s+/g, "").toLowerCase();

        if (
          !fallbackValue ||
          normalized === "transparent" ||
          normalized === "rgba(0,0,0,0)" ||
          normalized === "none"
        ) {
          return htmlComputed.getPropertyValue(property).trim();
        }
      }

      if (
        backgroundFallbackProperties.includes(property) &&
        (!fallbackValue || fallbackValue === "none")
      ) {
        return htmlComputed.getPropertyValue(property).trim();
      }

      if (property.startsWith("--") && !fallbackValue) {
        return htmlComputed.getPropertyValue(property).trim();
      }

      return fallbackValue;
    };
    const shouldKeepCustomProperty = (name: string, value: string) => {
      if (!value) {
        return false;
      }

      if (themeProperties.includes(name)) {
        return true;
      }

      return themePropertyMatcher.test(name);
    };
    const extractCustomProperties = (
      element: HTMLElement,
      computed: CSSStyleDeclaration
    ) => {
      const names = new Set<string>(themeProperties);

      for (let index = 0; index < computed.length; index += 1) {
        const propertyName = computed.item(index);

        if (propertyName?.startsWith("--")) {
          names.add(propertyName);
        }
      }

      return [...names].reduce<Record<string, string>>((acc, property) => {
        const value = resolveBodyBackgroundValue(
          element,
          property,
          computed.getPropertyValue(property).trim()
        );

        if (shouldKeepCustomProperty(property, value)) {
          acc[property] = value;
        }

        return acc;
      }, {});
    };
    const splitBackgroundLayers = (value: string) => {
      const layers: string[] = [];
      let current = "";
      let depth = 0;
      let quote: '"' | "'" | null = null;

      for (let index = 0; index < value.length; index += 1) {
        const char = value[index];
        const previous = index > 0 ? value[index - 1] : "";

        if (quote) {
          current += char;

          if (char === quote && previous !== "\\") {
            quote = null;
          }

          continue;
        }

        if (char === '"' || char === "'") {
          quote = char;
          current += char;
          continue;
        }

        if (char === "(") {
          depth += 1;
          current += char;
          continue;
        }

        if (char === ")") {
          depth = Math.max(depth - 1, 0);
          current += char;
          continue;
        }

        if (char === "," && depth === 0) {
          const trimmed = current.trim();

          if (trimmed) {
            layers.push(trimmed);
          }

          current = "";
          continue;
        }

        current += char;
      }

      const trimmed = current.trim();

      if (trimmed) {
        layers.push(trimmed);
      }

      return layers;
    };
    const extractCssUrls = (value: string) =>
      splitBackgroundLayers(value).flatMap((layer) =>
        [...layer.matchAll(/url\((['"]?)(.*?)\1\)/gi)]
          .map((match) => match[2]?.trim())
          .filter((item): item is string => Boolean(item))
      );
    const buildBackgroundLayers = (value: string) =>
      splitBackgroundLayers(value).map((layer, index) => {
        const url = [...layer.matchAll(/url\((['"]?)(.*?)\1\)/gi)]
          .map((match) => match[2]?.trim())
          .find((item): item is string => Boolean(item));
        const normalized = layer.trim();
        const type: "gradient" | "image" | "other" =
          /(?:^|[^-])(linear|radial|conic)-gradient\(/i.test(normalized)
            ? "gradient"
            : url
              ? "image"
              : "other";

        return {
          index,
          type,
          value: normalized,
          url
        };
      });
    const extractSrcsetCandidates = (value: string | null | undefined) => {
      const input = value || "";
      const candidates: string[] = [];
      let index = 0;

      while (index < input.length) {
        while (index < input.length && /[\s,]/.test(input[index] || "")) {
          index += 1;
        }

        if (index >= input.length) {
          break;
        }

        const isDataUrl = input.slice(index, index + 5).toLowerCase() === "data:";
        let candidate = "";

        while (index < input.length) {
          const char = input[index] || "";

          if (/\s/.test(char) || (!isDataUrl && char === ",")) {
            break;
          }

          candidate += char;
          index += 1;
        }

        const normalizedCandidate = candidate.trim();

        if (normalizedCandidate) {
          candidates.push(normalizedCandidate);
        }

        while (index < input.length && input[index] !== ",") {
          index += 1;
        }

        if (input[index] === ",") {
          index += 1;
        }
      }

      return candidates;
    };
    const uniqueValues = (values: Array<string | null | undefined>) => {
      const seen = new Set<string>();
      const result: string[] = [];

      values.forEach((value) => {
        const normalized = value?.trim();

        if (!normalized || seen.has(normalized)) {
          return;
        }

        seen.add(normalized);
        result.push(normalized);
      });

      return result;
    };
    const resolveAssetFromBackgroundImage = (backgroundImage: string) =>
      backgroundImage && backgroundImage !== "none" ? backgroundImage : undefined;
    const resolveElementAsset = (element: HTMLElement) => {
      const computed = window.getComputedStyle(element);
      const backgroundImage = resolveBodyBackgroundValue(
        element,
        "background-image",
        computed.getPropertyValue("background-image").trim()
      );
      const srcsetCandidates = uniqueValues([
        ...extractSrcsetCandidates(element.getAttribute("srcset")),
        ...extractSrcsetCandidates(element.getAttribute("data-srcset")),
        ...extractSrcsetCandidates(element.getAttribute("data-lazy-srcset"))
      ]);
      const lazySources = uniqueValues([
        element.getAttribute("data-src"),
        element.getAttribute("data-lazy-src"),
        element.getAttribute("data-original"),
        element.getAttribute("data-url")
      ]);
      const pictureSources = uniqueValues(
        element.tagName.toLowerCase() === "picture"
          ? Array.from(element.querySelectorAll("source")).flatMap((source) => [
              ...extractSrcsetCandidates(source.getAttribute("srcset")),
              ...extractSrcsetCandidates(source.getAttribute("data-srcset")),
              ...extractSrcsetCandidates(source.getAttribute("data-lazy-srcset"))
            ])
          : []
      );
      const href =
        element instanceof HTMLAnchorElement
          ? element.href
          : element.getAttribute("href") ||
            element.getAttribute("data-href") ||
            element.getAttribute("data-url");
      const currentSrc =
        element instanceof HTMLImageElement
          ? element.currentSrc || element.src || undefined
          : element.tagName.toLowerCase() === "picture"
            ? element.querySelector("img")?.currentSrc ||
              element.querySelector("img")?.getAttribute("src") ||
              undefined
            : undefined;
      const src =
        currentSrc ||
        (element instanceof HTMLSourceElement
          ? srcsetCandidates[0] || element.getAttribute("src") || undefined
          : element.tagName.toLowerCase() === "picture"
            ? element.querySelector("img")?.getAttribute("src") ||
              pictureSources[0] ||
              undefined
            : element instanceof SVGSVGElement
              ? "data:image/svg+xml;base64," +
                window.btoa(unescape(encodeURIComponent(new XMLSerializer().serializeToString(element))))
              : element.getAttribute("src") ||
                srcsetCandidates[0] ||
                lazySources[0] ||
                undefined);
      const backgroundLayers = buildBackgroundLayers(backgroundImage);

      return {
        href: href?.trim() || undefined,
        src: src?.trim() || undefined,
        currentSrc: currentSrc?.trim() || undefined,
        srcsetCandidates,
        pictureSources,
        lazySources,
        alt:
          (element.getAttribute("alt") ||
            element.getAttribute("aria-label") ||
            element.getAttribute("title") ||
            "").trim() || undefined,
        poster: (element.getAttribute("poster") || "").trim() || undefined,
        backgroundImage: resolveAssetFromBackgroundImage(backgroundImage),
        backgroundUrls: extractCssUrls(backgroundImage),
        backgroundLayers,
        hasGradientBackground: backgroundLayers.some((layer) => layer.type === "gradient")
      };
    };
    const normalizePseudoContent = (value: string) => {
      const normalized = (value || "").trim();

      if (!normalized || normalized === "none" || normalized === "normal") {
        return undefined;
      }

      return normalized.replace(/^['"]|['"]$/g, "");
    };
    const hasVisibleColor = (value: string | undefined) => {
      const normalized = (value || "").replace(/\s+/g, "").toLowerCase();
      return Boolean(
        normalized &&
          normalized !== "transparent" &&
          normalized !== "rgba(0,0,0,0)" &&
          normalized !== "none"
      );
    };
    const hasVisibleBorder = (value: string | undefined) => {
      const normalized = (value || "").replace(/\s+/g, " ").trim().toLowerCase();

      if (!normalized || normalized === "none") {
        return false;
      }

      return !/^0(?:px)?\s+none\b/.test(normalized);
    };
    const hasPseudoVisualContent = (styles: Record<string, string>, content: string | undefined) => {
      return (
        Boolean(content) ||
        hasVisibleColor(styles["background-color"]) ||
        Boolean(styles["background-image"] && styles["background-image"] !== "none") ||
        hasVisibleBorder(styles.border) ||
        Boolean(styles["box-shadow"] && styles["box-shadow"] !== "none")
      );
    };
    const resolvePseudoBox = (
      rect: DOMRect,
      styles: Record<string, string>
    ) => {
      const width = parsePixel(styles.width);
      const height = parsePixel(styles.height);

      if (!(width && width > 0) || !(height && height > 0)) {
        return null;
      }

      const left = parsePixel(styles.left);
      const right = parsePixel(styles.right);
      const top = parsePixel(styles.top);
      const bottom = parsePixel(styles.bottom);

      const absoluteLeft =
        left !== undefined
          ? rect.left + window.scrollX + left
          : right !== undefined
            ? rect.left + window.scrollX + rect.width - right - width
            : rect.left + window.scrollX;
      const absoluteTop =
        top !== undefined
          ? rect.top + window.scrollY + top
          : bottom !== undefined
            ? rect.top + window.scrollY + rect.height - bottom - height
            : rect.top + window.scrollY;

      return {
        x: absoluteLeft,
        y: absoluteTop,
        top: absoluteTop,
        right: absoluteLeft + width,
        bottom: absoluteTop + height,
        left: absoluteLeft,
        width,
        height,
        centerX: absoluteLeft + width / 2,
        centerY: absoluteTop + height / 2
      };
    };
    const extractPseudoElements = (element: HTMLElement, rect: DOMRect) => {
      return (["::before", "::after"] as const).flatMap((pseudo) => {
        const computed = window.getComputedStyle(element, pseudo);
        const customProperties = extractCustomProperties(element, computed);
        const computedStyles = capturedProperties.reduce<Record<string, string>>((acc, property) => {
          const value = computed.getPropertyValue(property).trim();

          if (value) {
            acc[property] = value;
          }

          return acc;
        }, {});
        const content = normalizePseudoContent(computed.getPropertyValue("content"));
        const pseudoStyles = {
          ...computedStyles,
          ...customProperties
        };
        const opacity = Number.parseFloat(computed.opacity || "1");
        const box = resolvePseudoBox(rect, pseudoStyles);
        const isVisible =
          computed.display !== "none" &&
          computed.visibility !== "hidden" &&
          opacity > 0 &&
          Boolean(box);

        if (!hasPseudoVisualContent(pseudoStyles, content) || !isVisible) {
          return [];
        }

        return [
          {
            pseudo,
            content,
            computedStyles: pseudoStyles,
            box,
            isVisible: true,
            asset: {
              backgroundImage: resolveAssetFromBackgroundImage(
                pseudoStyles["background-image"] || ""
              ),
              backgroundUrls: extractCssUrls(pseudoStyles["background-image"] || ""),
              backgroundLayers: buildBackgroundLayers(pseudoStyles["background-image"] || ""),
              hasGradientBackground: buildBackgroundLayers(
                pseudoStyles["background-image"] || ""
              ).some((layer) => layer.type === "gradient")
            }
          }
        ];
      });
    };

    elements.forEach((element, index) => {
      if (!element.getAttribute("data-capture-id")) {
        element.setAttribute("data-capture-id", `capture-node-${index + 1}`);
      }
    });

    const nodes = elements.map((element, index) => {
      const computed = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const asset = resolveElementAsset(element);
      const computedStyles = capturedProperties.reduce<Record<string, string>>((acc, property) => {
        const rawValue = computed.getPropertyValue(property);
        const value = resolveBodyBackgroundValue(element, property, rawValue).trim();

        if (value) {
          acc[property] = value;
        }

        return acc;
      }, {});
      Object.assign(computedStyles, extractCustomProperties(element, computed));
      const text = Array.from(element.childNodes)
        .filter((node) => node.nodeType === window.Node.TEXT_NODE)
        .map((node) => node.textContent ?? "")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      const attributes = Array.from(element.attributes).reduce<Record<string, string>>(
        (acc, attribute) => {
          acc[attribute.name] = attribute.value;
          return acc;
        },
        {}
      );
      const hasVisiblePixels = rect.width > 0 && rect.height > 0;
      const isVisible =
        computed.display !== "none" &&
        computed.visibility !== "hidden" &&
        computed.opacity !== "0" &&
        !element.hasAttribute("hidden") &&
        element.getAttribute("aria-hidden") !== "true" &&
        hasVisiblePixels;

      const absoluteLeft = rect.left + window.scrollX;
      const absoluteTop = rect.top + window.scrollY;
      const width = Math.max(rect.width, 0);
      const height = Math.max(rect.height, 0);
      const absoluteRight = absoluteLeft + width;
      const absoluteBottom = absoluteTop + height;

      return {
        id: element.getAttribute("data-capture-id") || `capture-node-${index + 1}`,
        tag: element.tagName.toLowerCase(),
        text,
        attributes,
        parentId: element.parentElement?.getAttribute("data-capture-id") ?? null,
        childIds: Array.from(element.children).map(
          (child) => child.getAttribute("data-capture-id") || ""
        ),
        computedStyles,
        box: hasVisiblePixels
          ? {
              x: absoluteLeft,
              y: absoluteTop,
              top: absoluteTop,
              right: absoluteRight,
              bottom: absoluteBottom,
              left: absoluteLeft,
              width,
              height,
              centerX: absoluteLeft + width / 2,
              centerY: absoluteTop + height / 2
            }
          : null,
        viewportStates: {},
        visualOrder: index + 1,
        isVisible,
        asset,
        pseudoElements: extractPseudoElements(element, rect)
      };
    });

    return {
      title: document.title || "Untitled Capture",
      renderedHtml: document.documentElement.outerHTML,
      css: Array.from(document.querySelectorAll("style"))
        .map((element) => element.textContent ?? "")
        .join("\n"),
      nodes
    };
  }, {
    capturedProperties: properties,
    themeProperties: CAPTURED_THEME_CUSTOM_PROPERTIES
  });

  return {
    ...result,
    nodes: result.nodes.map((node) => ({
      ...node,
      asset: normalizeAsset(node.asset),
      pseudoElements: node.pseudoElements?.map((pseudo) => ({
        ...pseudo,
        computedStyles: normalizeCustomStyles(pseudo.computedStyles),
        asset: normalizeAsset(pseudo.asset)
      }))
    }))
  };
}
