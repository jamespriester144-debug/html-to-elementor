import type { CapturedNode, CapturedNodeAsset } from "@/lib/converter-v3/contracts/capture";

export const CAPTURED_STYLE_PROPERTIES = [
  "display",
  "position",
  "width",
  "height",
  "max-width",
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
  "flex-direction",
  "align-items",
  "justify-content",
  "background",
  "background-color",
  "background-image",
  "background-size",
  "background-position",
  "color",
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "letter-spacing",
  "text-decoration",
  "border",
  "border-color",
  "border-radius",
  "box-shadow",
  "overflow",
  "object-fit",
  "object-position",
  "text-align",
  "cursor",
  "visibility",
  "opacity",
  "transform",
  "z-index"
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
  const normalized = Object.fromEntries(
    Object.entries(asset).filter(([, value]) => Boolean(value))
  ) as CapturedNodeAsset;

  return normalized;
}

export async function extractViewportNodes(
  page: {
    evaluate: <TArg, TResult>(fn: (arg: TArg) => TResult, arg: TArg) => Promise<TResult>;
  },
  properties: readonly string[] = CAPTURED_STYLE_PROPERTIES
): Promise<ExtractedViewportNode[]> {
  return page.evaluate((capturedProperties: readonly string[]) => {
    const elements = [document.body, ...Array.from(document.body.querySelectorAll<HTMLElement>("*"))];

    elements.forEach((element, index) => {
      if (!element.getAttribute("data-capture-id")) {
        element.setAttribute("data-capture-id", `capture-node-${index + 1}`);
      }
    });

    return elements.map((element, index) => {
      const computed = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const backgroundImage = computed.getPropertyValue("background-image").trim();
      const href = element instanceof HTMLAnchorElement ? element.href : element.getAttribute("href");
      const src =
        element instanceof HTMLImageElement
          ? element.currentSrc || element.src
          : element instanceof HTMLSourceElement
            ? element.srcset || element.getAttribute("src")
            : element.getAttribute("src");
      const asset = {
        href: href?.trim() || undefined,
        src: src?.trim() || undefined,
        alt: (element.getAttribute("alt") || "").trim() || undefined,
        poster: (element.getAttribute("poster") || "").trim() || undefined,
        backgroundImage:
          backgroundImage && backgroundImage !== "none" ? backgroundImage : undefined
      };
      const computedStyles = capturedProperties.reduce((acc: Record<string, string>, property: string) => {
        const value = computed.getPropertyValue(property);

        if (value) {
          acc[property] = value.trim();
        }

        return acc;
      }, {});
      const hasVisiblePixels = rect.width > 0 && rect.height > 0;
      const isVisible =
        computed.display !== "none" &&
        computed.visibility !== "hidden" &&
        computed.opacity !== "0" &&
        !element.hasAttribute("hidden") &&
        element.getAttribute("aria-hidden") !== "true" &&
        hasVisiblePixels;

      return {
        id: element.getAttribute("data-capture-id") || `capture-node-${index + 1}`,
        computedStyles,
        box: hasVisiblePixels
          ? {
              x: rect.x,
              y: rect.y,
              top: rect.top,
              right: rect.right,
              bottom: rect.bottom,
              left: rect.left,
              width: rect.width,
              height: rect.height,
              centerX: rect.left + rect.width / 2,
              centerY: rect.top + rect.height / 2
            }
          : null,
        isVisible,
        asset
      };
    });
  }, properties);
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
  const result = await page.evaluate((capturedProperties: readonly string[]) => {
    const elements = [document.body, ...Array.from(document.body.querySelectorAll<HTMLElement>("*"))];

    elements.forEach((element, index) => {
      if (!element.getAttribute("data-capture-id")) {
        element.setAttribute("data-capture-id", `capture-node-${index + 1}`);
      }
    });

    const nodes = elements.map((element, index) => {
      const computed = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const backgroundImage = computed.getPropertyValue("background-image").trim();
      const href = element instanceof HTMLAnchorElement ? element.href : element.getAttribute("href");
      const src =
        element instanceof HTMLImageElement
          ? element.currentSrc || element.src
          : element instanceof HTMLSourceElement
            ? element.srcset || element.getAttribute("src")
            : element.getAttribute("src");
      const asset = {
        href: href?.trim() || undefined,
        src: src?.trim() || undefined,
        alt: (element.getAttribute("alt") || "").trim() || undefined,
        poster: (element.getAttribute("poster") || "").trim() || undefined,
        backgroundImage:
          backgroundImage && backgroundImage !== "none" ? backgroundImage : undefined
      };
      const computedStyles = capturedProperties.reduce<Record<string, string>>((acc, property) => {
        const value = computed.getPropertyValue(property);

        if (value) {
          acc[property] = value.trim();
        }

        return acc;
      }, {});
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
              x: rect.x,
              y: rect.y,
              top: rect.top,
              right: rect.right,
              bottom: rect.bottom,
              left: rect.left,
              width: rect.width,
              height: rect.height,
              centerX: rect.left + rect.width / 2,
              centerY: rect.top + rect.height / 2
            }
          : null,
        viewportStates: {},
        visualOrder: index + 1,
        isVisible,
        asset
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
  }, properties);

  return {
    ...result,
    nodes: result.nodes.map((node) => ({
      ...node,
      asset: normalizeAsset(node.asset)
    }))
  };
}
