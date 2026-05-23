import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";

import type {
  BrowserLocator,
  BrowserPage,
  BrowserScreenshotOptions,
  BrowserPageSessionWithLocator
} from "@/lib/converter-v3/browser-page";
import { installBrowserEvalShim } from "@/lib/converter-v3/browser-eval-shim";
import type {
  CaptureViewportProfile,
  PageCapture,
  SectionCaptureBackgroundAsset,
  SectionComplexity,
  SectionCapture,
  SectionCaptureDebugInfo,
  SectionCaptureFontAsset,
  SectionCaptureImageAsset,
  SectionCaptureInteractiveAsset,
  SectionCapturePositionedAsset,
  SectionOverlayLink
} from "@/lib/converter-v3/contracts/capture";
import type { LayoutDocument, LayoutNode } from "@/lib/converter-v3/contracts/layout";
import { preparePageForVisualCapture } from "@/lib/converter-v3/visual-capture-stability";

type BrowserSessionFactory = {
  createPageSession: (viewport: CaptureViewportProfile) => Promise<BrowserPageSessionWithLocator>;
  close: () => Promise<void>;
};

type PageWithOptionalLocator = BrowserPage & {
  goto?: BrowserPage["goto"];
  locator?: (selector: string) => unknown;
  $?: (selector: string) => Promise<{
    screenshot: (options?: BrowserScreenshotOptions) => Promise<Uint8Array>;
  } | null>;
  $$?: (selector: string) => Promise<unknown[]>;
};

type ExtractedSectionViewport = {
  box: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  captureBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  originalHtml: string;
  frozenHtmlMarkup: string;
  linkOverlays: SectionOverlayLink[];
  invadingNodeIds: string[];
  pseudoElementNodes: number;
  hasPseudoElements: boolean;
  transformedNodes: number;
  hasTransforms: boolean;
  overlayNodes: number;
  complexZIndexNodes: number;
  gradientNodes: number;
  animatedNodes: number;
  unsupportedCssNodes: number;
  carouselNodes: number;
  captureStrategy: "expanded-clip" | "coordinate-clip" | "viewport-clip";
  unsafeSectionBoundary: boolean;
  unsafeReasons: string[];
  originalImages: SectionCaptureImageAsset[];
  cssBackgrounds: SectionCaptureBackgroundAsset[];
  loadedFonts: SectionCaptureFontAsset[];
  interactiveElements: SectionCaptureInteractiveAsset[];
  positionedElements: SectionCapturePositionedAsset[];
};

const FROZEN_STYLE_PROPERTIES = [
  "display",
  "position",
  "top",
  "right",
  "bottom",
  "left",
  "z-index",
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
  "flex-wrap",
  "align-items",
  "justify-content",
  "align-self",
  "justify-self",
  "background",
  "background-color",
  "background-image",
  "background-size",
  "background-position",
  "background-repeat",
  "background-clip",
  "color",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "line-height",
  "letter-spacing",
  "text-align",
  "text-transform",
  "text-decoration",
  "white-space",
  "border",
  "border-color",
  "border-radius",
  "box-shadow",
  "overflow",
  "overflow-x",
  "overflow-y",
  "opacity",
  "visibility",
  "transform",
  "object-fit",
  "object-position",
  "pointer-events"
] as const;

function buildLayoutNodeMap(layout: LayoutDocument) {
  return new Map(layout.nodes.map((node) => [node.id, node]));
}

function isBrowserLocator(value: unknown): value is BrowserLocator {
  return (
    typeof value === "object" &&
    value !== null &&
    "count" in value &&
    typeof value.count === "function" &&
    "screenshot" in value &&
    typeof value.screenshot === "function"
  );
}

function createPageLocator(page: PageWithOptionalLocator, selector: string): BrowserLocator {
  return {
    count: async () => {
      const locator = page.locator?.(selector);

      if (isBrowserLocator(locator)) {
        return locator.count();
      }

      if (!page.$$) {
        throw new Error(`The active browser page does not support counting "${selector}".`);
      }

      const elements = await page.$$(selector);
      return elements.length;
    },
    screenshot: async (options) => {
      const locator = page.locator?.(selector);

      if (isBrowserLocator(locator)) {
        return locator.screenshot(options);
      }

      if (!page.$) {
        throw new Error(`The active browser page does not support screenshotting "${selector}".`);
      }

      const element = await page.$(selector);

      if (!element) {
        throw new Error(`Unable to find "${selector}" while capturing a section screenshot.`);
      }

      return element.screenshot(options);
    }
  };
}

export function createBrowserPageWithLocator(
  page: PageWithOptionalLocator
): BrowserPageSessionWithLocator["page"] {
  return {
    close: () => page.close(),
    evaluate: page.evaluate.bind(page) as BrowserPageSessionWithLocator["page"]["evaluate"],
    goto: page.goto ? page.goto.bind(page) : undefined,
    screenshot: (options) => page.screenshot(options),
    setContent: (html, options) => page.setContent(html, options),
    setJavaScriptEnabled: page.setJavaScriptEnabled
      ? page.setJavaScriptEnabled.bind(page)
      : undefined,
    setViewport: page.setViewport ? page.setViewport.bind(page) : undefined,
    waitForLoadState: page.waitForLoadState
      ? page.waitForLoadState.bind(page)
      : undefined,
    waitForNetworkIdle: page.waitForNetworkIdle
      ? page.waitForNetworkIdle.bind(page)
      : undefined,
    waitForSelector: page.waitForSelector
      ? page.waitForSelector.bind(page)
      : undefined,
    locator: (selector) => createPageLocator(page, selector)
  };
}

function collectSubtreeNodeIds(rootId: string, nodeById: Map<string, LayoutNode>) {
  const ids: string[] = [];
  const queue = [rootId];

  while (queue.length) {
    const currentId = queue.shift();

    if (!currentId) {
      continue;
    }

    const node = nodeById.get(currentId);

    if (!node) {
      continue;
    }

    ids.push(node.id);
    queue.push(...node.children);
  }

  return ids;
}

function countSubtreeOverlaps(nodes: LayoutNode[]) {
  let overlaps = 0;

  for (let index = 0; index < nodes.length; index += 1) {
    for (let nextIndex = index + 1; nextIndex < nodes.length; nextIndex += 1) {
      const left = nodes[index];
      const right = nodes[nextIndex];

      if (
        left.parentId === right.parentId &&
        left.box.width > 0 &&
        left.box.height > 0 &&
        right.box.width > 0 &&
        right.box.height > 0 &&
        !(
          left.box.x + left.box.width <= right.box.x ||
          right.box.x + right.box.width <= left.box.x ||
          left.box.y + left.box.height <= right.box.y ||
          right.box.y + right.box.height <= left.box.y
        )
      ) {
        overlaps += 1;
      }
    }
  }

  return overlaps;
}

function isFlexGridContainer(node: LayoutNode) {
  return (
    node.layout.display === "flex" ||
    node.layout.display === "grid" ||
    Boolean(node.layout.gridTemplateColumns)
  );
}

function computeLayoutDepthMetrics(rootId: string, nodeById: Map<string, LayoutNode>) {
  let nestedFlexGridContainers = 0;
  let maxFlexGridDepth = 0;
  const queue = [{ id: rootId, depth: 0 }];

  while (queue.length) {
    const current = queue.shift();

    if (!current) {
      continue;
    }

    const node = nodeById.get(current.id);

    if (!node) {
      continue;
    }

    const nextDepth = isFlexGridContainer(node) ? current.depth + 1 : current.depth;

    if (isFlexGridContainer(node) && nextDepth > 1) {
      nestedFlexGridContainers += 1;
    }

    maxFlexGridDepth = Math.max(maxFlexGridDepth, nextDepth);

    node.children.forEach((childId) => {
      queue.push({
        id: childId,
        depth: nextDepth
      });
    });
  }

  return {
    nestedFlexGridContainers,
    maxFlexGridDepth
  };
}

function buildSectionNodeIds(layout: LayoutDocument) {
  const ids =
    layout.detectedSections.length > 0
      ? layout.detectedSections.map((section) => section.id)
      : layout.sectionIds;

  return [...new Set(ids)];
}

function toPngDataUrl(buffer: Uint8Array) {
  return `data:image/png;base64,${Buffer.from(buffer).toString("base64")}`;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildFrozenSectionDocument(params: {
  nodeId: string;
  width: number;
  minHeight: number;
  frozenHtmlMarkup: string;
}) {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      html, body {
        margin: 0;
        padding: 0;
        background: transparent;
      }

      *, *::before, *::after {
        box-sizing: border-box;
      }
    </style>
  </head>
  <body>
    <div data-converter-v3-frozen-section="${escapeHtml(params.nodeId)}" style="width:${Math.max(
      Math.round(params.width),
      1
    )}px;min-height:${Math.max(Math.round(params.minHeight), 1)}px;margin:0 auto;">
      ${params.frozenHtmlMarkup}
    </div>
  </body>
</html>`;
}

async function createPlaywrightFactory(): Promise<BrowserSessionFactory> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    headless: true,
    timeout: 10000,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  return {
    createPageSession: async (viewport) => {
      const context = await browser.newContext({
        viewport: {
          width: viewport.width,
          height: viewport.height
        },
        deviceScaleFactor: 1
      });
      const page = await context.newPage();

      return {
        page: createBrowserPageWithLocator(page),
        close: async () => {
          await page.close().catch(() => undefined);
          await context.close().catch(() => undefined);
        }
      };
    },
    close: async () => {
      await browser.close().catch(() => undefined);
    }
  };
}

async function createPuppeteerFactory(_userDataDir: string): Promise<BrowserSessionFactory> {
  const puppeteer = await import("puppeteer");
  const browser = await puppeteer.launch({
    headless: true,
    timeout: 10000,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  return {
    createPageSession: async (viewport) => {
      const page = await browser.newPage();
      await page.setViewport({
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 1
      });

      return {
        page: createBrowserPageWithLocator(page),
        close: async () => {
          await page.close().catch(() => undefined);
        }
      };
    },
    close: async () => {
      await browser.close().catch(() => undefined);
    }
  };
}

async function createBrowserFactory(): Promise<BrowserSessionFactory> {
  let userDataDir: string | null = null;

  try {
    return await createPlaywrightFactory();
  } catch {
    userDataDir = await mkdtemp(join(tmpdir(), "html-to-elementor-sections-"));

    try {
      const factory = await createPuppeteerFactory(userDataDir);

      return {
        ...factory,
        close: async () => {
          await factory.close();

          if (userDataDir) {
            await rm(userDataDir, {
              recursive: true,
              force: true,
              maxRetries: 2
            }).catch(() => undefined);
          }
        }
      };
    } catch (error) {
      if (userDataDir) {
        await rm(userDataDir, {
          recursive: true,
          force: true,
          maxRetries: 2
        }).catch(() => undefined);
      }

      throw error;
    }
  }
}

async function extractViewportSectionData(params: {
  page: BrowserPage;
  nodeId: string;
  capturePadding?: number;
}) {
  return params.page.evaluate(
    ({
      nodeId,
      styleProperties,
      capturePadding
    }: {
      nodeId: string;
      styleProperties: readonly string[];
      capturePadding: number;
    }) => {
      const run = new Function(
        "nodeId",
        "styleProperties",
        "capturePadding",
        `
          const root = document.querySelector('[data-capture-id="' + nodeId + '"]');
          if (!root) {
            return null;
          }

          function toAbsoluteRect(rect) {
            return {
              x: rect.left + window.scrollX,
              y: rect.top + window.scrollY,
              width: Math.max(rect.width, 1),
              height: Math.max(rect.height, 1)
            };
          }

          function intersects(left, right) {
            return !(
              left.right <= right.left ||
              right.right <= left.left ||
              left.bottom <= right.top ||
              right.bottom <= left.top
            );
          }

          function serializeStyle(element) {
            const computed = window.getComputedStyle(element);
            return styleProperties
              .map((property) => {
                const value = computed.getPropertyValue(property).trim();
                return value ? property + ":" + value : "";
              })
              .filter(Boolean)
              .join(";");
          }

          function cloneNodeWithInlineStyles(node) {
            if (node.nodeType === window.Node.TEXT_NODE) {
              return document.createTextNode(node.textContent || "");
            }

            if (node.nodeType !== window.Node.ELEMENT_NODE) {
              return null;
            }

            const element = node;
            const tagName = element.tagName.toLowerCase();

            if (["script", "noscript"].includes(tagName)) {
              return null;
            }

            const clone = document.createElement(tagName);
            Array.from(element.attributes).forEach((attribute) => {
              if (attribute.name === "style" || attribute.name.startsWith("on")) {
                return;
              }

              clone.setAttribute(attribute.name, attribute.value);
            });

            const style = serializeStyle(element);
            if (style) {
              clone.setAttribute("style", style);
            }

            if (element instanceof HTMLImageElement) {
              const src = element.currentSrc || element.src || element.getAttribute("src") || "";
              if (src) {
                clone.setAttribute("src", src);
              }

              clone.removeAttribute("srcset");
              clone.removeAttribute("sizes");
              clone.removeAttribute("loading");
              clone.removeAttribute("decoding");
            }

            if (element instanceof HTMLAnchorElement) {
              const href = element.href || element.getAttribute("href") || "";
              if (href) {
                clone.setAttribute("href", href);
              }
            }

            Array.from(element.childNodes).forEach((child) => {
              const clonedChild = cloneNodeWithInlineStyles(child);
              if (clonedChild) {
                clone.appendChild(clonedChild);
              }
            });

            return clone;
          }

          function hasPseudoElement(element, pseudo) {
            const computed = window.getComputedStyle(element, pseudo);
            const content = computed.content;
            const width = Number.parseFloat(computed.width || "0");
            const height = Number.parseFloat(computed.height || "0");

            return (
              content !== "none" &&
              content !== "normal" &&
              (computed.display !== "none" || width > 0 || height > 0)
            );
          }

          function isTransitionAnimated(computed) {
            return (computed.transitionDuration || "")
              .split(",")
              .map((value) => Number.parseFloat(value) || 0)
              .some((value) => value > 0);
          }

          function isComplexGradient(computed) {
            const backgroundImage = computed.backgroundImage || "";
            if (!/gradient\\(/i.test(backgroundImage)) {
              return false;
            }

            const gradientSegments = backgroundImage.split(/,(?![^()]*\\))/);
            return (
              gradientSegments.length > 1 ||
              /conic-gradient|radial-gradient/i.test(backgroundImage)
            );
          }

          function usesUnsupportedCss(computed) {
            const filter = computed.filter || "";
            const backdropFilter = computed.getPropertyValue("backdrop-filter") || "";
            const clipPath = computed.clipPath || computed.getPropertyValue("clip-path") || "";
            const maskImage =
              computed.getPropertyValue("mask-image") ||
              computed.getPropertyValue("-webkit-mask-image") ||
              "";
            const mixBlendMode = computed.mixBlendMode || "";

            return (
              (filter && filter !== "none") ||
              (backdropFilter && backdropFilter !== "none") ||
              (clipPath && clipPath !== "none") ||
              (maskImage && maskImage !== "none") ||
              (mixBlendMode && mixBlendMode !== "normal")
            );
          }

          function isCarouselLike(element, computed) {
            const fingerprint = [
              element.getAttribute("class") || "",
              element.getAttribute("id") || "",
              element.getAttribute("role") || "",
              element.getAttribute("aria-roledescription") || "",
              element.getAttribute("aria-label") || "",
              element.getAttribute("data-slider") || "",
              element.getAttribute("data-carousel") || ""
            ]
              .join(" ")
              .toLowerCase();

            return (
              /carousel|slider|swiper|slick|glide|splide|flickity|embla|marquee/.test(fingerprint) ||
              (computed.scrollSnapType && computed.scrollSnapType !== "none") ||
              ((computed.overflowX === "auto" || computed.overflowX === "scroll") &&
                element.children.length > 1)
            );
          }

          function isVisibleElement(element) {
            const computed = window.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            const opacity = Number.parseFloat(computed.opacity || "1");

            return (
              computed.display !== "none" &&
              computed.visibility !== "hidden" &&
              opacity > 0 &&
              rect.width > 0 &&
              rect.height > 0
            );
          }

          function getNodeCaptureId(element) {
            return element.getAttribute("data-capture-id") || "";
          }

          function getAbsoluteRectSummary(element) {
            const rect = toAbsoluteRect(element.getBoundingClientRect());
            return {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height
            };
          }

          const rootRect = root.getBoundingClientRect();
          const invadingElements = Array.from(document.body.querySelectorAll("*")).filter((element) => {
            if (element === root || root.contains(element)) {
              return false;
            }

            if (!isVisibleElement(element)) {
              return false;
            }

            const tagName = element.tagName.toLowerCase();
            if (["script", "noscript", "style", "meta", "link"].includes(tagName)) {
              return false;
            }

            const computed = window.getComputedStyle(element);
            const zIndex = Number.parseInt(computed.zIndex || "0", 10);
            const isOverlayLike =
              computed.position === "absolute" ||
              computed.position === "fixed" ||
              computed.position === "sticky" ||
              zIndex > 1;

            if (!isOverlayLike) {
              return false;
            }

            return intersects(element.getBoundingClientRect(), rootRect);
          });

          const captureRect = invadingElements.reduce(
            (current, element) => {
              const rect = element.getBoundingClientRect();
              return {
                left: Math.min(current.left, rect.left),
                top: Math.min(current.top, rect.top),
                right: Math.max(current.right, rect.right),
                bottom: Math.max(current.bottom, rect.bottom)
              };
            },
            {
              left: rootRect.left,
              top: rootRect.top,
              right: rootRect.right,
              bottom: rootRect.bottom
            }
          );
          const documentWidth = Math.max(
            document.documentElement.scrollWidth,
            document.body.scrollWidth,
            window.innerWidth
          );
          const documentHeight = Math.max(
            document.documentElement.scrollHeight,
            document.body.scrollHeight,
            window.innerHeight
          );
          const captureBox = {
            x: Math.max(captureRect.left + window.scrollX - capturePadding, 0),
            y: Math.max(captureRect.top + window.scrollY - capturePadding, 0),
            width: 1,
            height: 1
          };
          captureBox.width = Math.min(
            Math.max(captureRect.right - captureRect.left + capturePadding * 2, 1),
            Math.max(documentWidth - captureBox.x, 1)
          );
          captureBox.height = Math.min(
            Math.max(captureRect.bottom - captureRect.top + capturePadding * 2, 1),
            Math.max(documentHeight - captureBox.y, 1)
          );
          const uniqueElements = [...new Set([root, ...Array.from(root.querySelectorAll("*")), ...invadingElements])];
          const frozenRoot = cloneNodeWithInlineStyles(root);
          let pseudoElementNodes = 0;
          let transformedNodes = 0;
          let overlayNodes = 0;
          let complexZIndexNodes = 0;
          let gradientNodes = 0;
          let animatedNodes = 0;
          let unsupportedCssNodes = 0;
          let carouselNodes = 0;
          const ancestorRisks = [];

          let ancestor = root.parentElement;
          while (ancestor) {
            const computed = window.getComputedStyle(ancestor);
            const overflowRisk =
              ["hidden", "clip", "scroll", "auto"].includes(computed.overflowX) ||
              ["hidden", "clip", "scroll", "auto"].includes(computed.overflowY);
            const transformRisk = computed.transform && computed.transform !== "none";
            const positionRisk = ["absolute", "fixed", "sticky"].includes(computed.position);

            if (overflowRisk || transformRisk || positionRisk) {
              ancestorRisks.push({
                nodeId: getNodeCaptureId(ancestor),
                position: computed.position,
                overflowX: computed.overflowX,
                overflowY: computed.overflowY,
                transform: computed.transform
              });
            }

            ancestor = ancestor.parentElement;
          }

          uniqueElements.forEach((element) => {
            const computed = window.getComputedStyle(element);
            const before = hasPseudoElement(element, "::before");
            const after = hasPseudoElement(element, "::after");
            const transform = computed.transform;
            const zIndex = Number.parseInt(computed.zIndex || "0", 10);

            if (before || after) {
              pseudoElementNodes += 1;
            }

            if (transform && transform !== "none") {
              transformedNodes += 1;
            }

            if (
              computed.position === "absolute" ||
              computed.position === "fixed" ||
              computed.position === "sticky" ||
              zIndex > 1
            ) {
              overlayNodes += 1;
            }

            if (zIndex > 1 && (computed.position !== "static" || zIndex >= 10)) {
              complexZIndexNodes += 1;
            }

            if (isComplexGradient(computed)) {
              gradientNodes += 1;
            }

            if (
              (computed.animationName && computed.animationName !== "none") ||
              isTransitionAnimated(computed)
            ) {
              animatedNodes += 1;
            }

            if (usesUnsupportedCss(computed)) {
              unsupportedCssNodes += 1;
            }

            if (isCarouselLike(element, computed)) {
              carouselNodes += 1;
            }
          });

          const originalImages = uniqueElements
            .filter((element) => element instanceof HTMLImageElement)
            .map((element) => ({
              nodeId: getNodeCaptureId(element),
              tag: element.tagName.toLowerCase(),
              src: element.currentSrc || element.src || element.getAttribute("src") || "",
              alt: element.getAttribute("alt") || undefined,
              width: Math.max(element.naturalWidth || element.clientWidth || 0, 0),
              height: Math.max(element.naturalHeight || element.clientHeight || 0, 0)
            }))
            .filter((image) => Boolean(image.src));

          const cssBackgrounds = uniqueElements
            .map((element) => {
              const computed = window.getComputedStyle(element);
              const backgroundImage = computed.backgroundImage || "";

              if (!backgroundImage || backgroundImage === "none") {
                return null;
              }

              return {
                nodeId: getNodeCaptureId(element),
                tag: element.tagName.toLowerCase(),
                backgroundImage
              };
            })
            .filter((item) => Boolean(item));

          const interactiveElements = uniqueElements
            .filter((element) => {
              if (!isVisibleElement(element)) {
                return false;
              }

              return (
                (element instanceof HTMLAnchorElement && Boolean(element.href)) ||
                element.tagName.toLowerCase() === "button" ||
                element.getAttribute("role") === "button"
              );
            })
            .map((element) => ({
              nodeId: getNodeCaptureId(element),
              tag: element.tagName.toLowerCase(),
              role: element.getAttribute("role") || undefined,
              href:
                element instanceof HTMLAnchorElement
                  ? element.href || undefined
                  : element.getAttribute("href") || undefined,
              text: (element.textContent || "").replace(/\\s+/g, " ").trim(),
              isButton:
                element.tagName.toLowerCase() === "button" ||
                element.getAttribute("role") === "button"
            }));

          const positionedElements = uniqueElements
            .map((element) => {
              const computed = window.getComputedStyle(element);
              const position = computed.position || "";
              const transform = computed.transform || "";
              const zIndex = computed.zIndex || "";
              const overlapsSection = intersects(element.getBoundingClientRect(), rootRect);
              const insideSection = root.contains(element) || element === root;

              if (
                !["absolute", "fixed", "sticky"].includes(position) &&
                (!transform || transform === "none")
              ) {
                return null;
              }

              return {
                nodeId: getNodeCaptureId(element),
                tag: element.tagName.toLowerCase(),
                position,
                transform: transform && transform !== "none" ? transform : undefined,
                zIndex: zIndex && zIndex !== "auto" ? zIndex : undefined,
                overlapsSection,
                insideSection
              };
            })
            .filter((item) => Boolean(item));

          const loadedFonts = Array.from(document.fonts || [])
            .map((font) => ({
              family: font.family || "",
              weight: font.weight || undefined,
              style: font.style || undefined,
              status: font.status || undefined
            }))
            .filter((font) => Boolean(font.family));

          const unsafeReasons = [];
          const rootComputed = window.getComputedStyle(root);
          const rootOverflowRisk =
            ["hidden", "clip"].includes(rootComputed.overflowX) ||
            ["hidden", "clip"].includes(rootComputed.overflowY);
          const hasOverlayInvasion = invadingElements.length > 0;
          const hasBoundaryTransform = transformedNodes > 0 || ancestorRisks.length > 0;
          const hasPositionedOverlap = positionedElements.some(
            (element) => element.overlapsSection && !element.insideSection
          );

          if (rootOverflowRisk) {
            unsafeReasons.push("root-overflow-clips-section");
          }

          if (ancestorRisks.length > 0) {
            unsafeReasons.push("ancestor-overflow-transform-or-absolute-context");
          }

          if (hasOverlayInvasion) {
            unsafeReasons.push("invading-overlay-expands-boundary");
          }

          if (hasBoundaryTransform) {
            unsafeReasons.push("transform-affects-section-boundary");
          }

          if (hasPositionedOverlap) {
            unsafeReasons.push("positioned-element-overlaps-section");
          }

          const captureStrategy =
            hasOverlayInvasion || hasPositionedOverlap
              ? "coordinate-clip"
              : ancestorRisks.length > 0 || transformedNodes > 0
                ? "viewport-clip"
                : "expanded-clip";

          const linkOverlays = Array.from(document.querySelectorAll("[href]"))
            .filter((element) => {
              if (!isVisibleElement(element)) {
                return false;
              }

              const rect = element.getBoundingClientRect();
              return intersects(rect, {
                left: captureBox.x - window.scrollX,
                top: captureBox.y - window.scrollY,
                right: captureBox.x - window.scrollX + captureBox.width,
                bottom: captureBox.y - window.scrollY + captureBox.height
              });
            })
            .map((element) => {
              const rect = element.getBoundingClientRect();
              const absoluteRect = toAbsoluteRect(rect);
              const href =
                element instanceof HTMLAnchorElement
                  ? element.href
                  : element.getAttribute("href") || "";

              if (!href) {
                return null;
              }

              const width = Math.max(absoluteRect.width, 1);
              const height = Math.max(absoluteRect.height, 1);
              const relativeX = absoluteRect.x - captureBox.x;
              const relativeY = absoluteRect.y - captureBox.y;
              const nodeCaptureId = element.getAttribute("data-capture-id") || nodeId;
              const computed = window.getComputedStyle(element);
              const parsedZIndex = Number.parseInt(computed.zIndex || "0", 10);

              return {
                nodeId: nodeCaptureId,
                href,
                text: (element.textContent || "").replace(/\\s+/g, " ").trim(),
                title: element.getAttribute("title") || undefined,
                target: element.getAttribute("target") || undefined,
                rel: element.getAttribute("rel") || undefined,
                isButton:
                  element.tagName.toLowerCase() === "button" ||
                  element.getAttribute("role") === "button",
                zIndex: Number.isFinite(parsedZIndex) ? parsedZIndex : undefined,
                box: absoluteRect,
                relativeBox: {
                  x: relativeX / Math.max(captureBox.width, 1),
                  y: relativeY / Math.max(captureBox.height, 1),
                  width: width / Math.max(captureBox.width, 1),
                  height: height / Math.max(captureBox.height, 1)
                }
              };
            })
            .filter((value) => Boolean(value));

          return {
            box: toAbsoluteRect(rootRect),
            captureBox,
            originalHtml: root.outerHTML,
            frozenHtmlMarkup: frozenRoot ? frozenRoot.outerHTML : root.outerHTML,
            linkOverlays,
            invadingNodeIds: invadingElements
              .map((element) => element.getAttribute("data-capture-id") || "")
              .filter(Boolean),
            pseudoElementNodes,
            hasPseudoElements: pseudoElementNodes > 0,
            transformedNodes,
            hasTransforms: transformedNodes > 0,
            overlayNodes,
            complexZIndexNodes,
            gradientNodes,
            animatedNodes,
            unsupportedCssNodes,
            carouselNodes,
            captureStrategy,
            unsafeSectionBoundary: unsafeReasons.length > 0,
            unsafeReasons,
            originalImages,
            cssBackgrounds,
            loadedFonts,
            interactiveElements,
            positionedElements
          };
        `
      );

      return run(nodeId, styleProperties, capturePadding);
    },
    {
      nodeId: params.nodeId,
      styleProperties: FROZEN_STYLE_PROPERTIES,
      capturePadding: Math.max(params.capturePadding ?? 0, 0)
    }
  );
}

function createSectionComplexity(
  sectionNode: LayoutNode,
  subtreeNodes: LayoutNode[],
  nodeById: Map<string, LayoutNode>
): SectionComplexity {
  const { nestedFlexGridContainers, maxFlexGridDepth } = computeLayoutDepthMetrics(
    sectionNode.id,
    nodeById
  );

  return {
    nodeCount: subtreeNodes.length,
    absoluteNodes: subtreeNodes.filter((node) =>
      ["absolute", "fixed", "sticky"].includes(node.layout.position ?? "")
    ).length,
    overlappingNodes: countSubtreeOverlaps(subtreeNodes),
    interactiveNodes: subtreeNodes.filter((node) => node.kind === "button").length,
    imageNodes: subtreeNodes.filter((node) => node.kind === "image").length,
    overlayNodes: subtreeNodes.filter(
      (node) =>
        node.detection?.semanticRole === "overlay" ||
        (node.visual?.effectiveZIndex ?? 0) > 1 ||
        (node.visual?.overlapCount ?? 0) > 0
    ).length,
    complexZIndexNodes: subtreeNodes.filter((node) => (node.visual?.effectiveZIndex ?? 0) > 1)
      .length,
    transformedNodes: 0,
    gradientNodes: 0,
    animatedNodes: 0,
    unsupportedCssNodes: 0,
    carouselNodes: 0,
    gridContainers: subtreeNodes.filter(
      (node) => node.layout.display === "grid" || Boolean(node.layout.gridTemplateColumns)
    ).length,
    flexContainers: subtreeNodes.filter((node) => node.layout.display === "flex").length,
    nestedFlexGridContainers,
    maxFlexGridDepth,
    pseudoElementNodes: 0,
    hasPseudoElements: false,
    hasTransforms: false,
    hasEmbeds: subtreeNodes.some((node) =>
      ["iframe", "video", "canvas", "svg"].includes(node.tag ?? "")
    )
  };
}

function appendUnsafeSectionReason(section: SectionCapture, reason: string) {
  const existingDebug = section.debug ?? {
    sectionBoundingBox: section.box,
    sectionWidth: section.box.width,
    sectionHeight: section.box.height,
    originalImages: [],
    cssBackgrounds: [],
    loadedFonts: [],
    interactiveElements: [],
    positionedElements: []
  };
  const nextReasons = [...new Set([...(existingDebug.unsafeReasons ?? []), reason])];

  section.debug = {
    ...existingDebug,
    unsafeSectionBoundary: true,
    unsafeReasons: nextReasons
  };
}

export async function buildVisualSectionCaptures(params: {
  capture: PageCapture;
  layout: LayoutDocument;
  outputDir: string;
  sectionNodeIds?: string[];
  capturePadding?: number;
  fileSuffix?: string;
}): Promise<SectionCapture[]> {
  if (params.capture.renderer !== "browser") {
    return [];
  }

  const nodeById = buildLayoutNodeMap(params.layout);
  const detectedSectionById = new Map(
    params.layout.detectedSections.map((section) => [section.id, section])
  );
  const requestedSectionIds = params.sectionNodeIds?.length
    ? new Set(params.sectionNodeIds)
    : null;
  const sectionNodeIds = buildSectionNodeIds(params.layout).filter(
    (sectionNodeId) => !requestedSectionIds || requestedSectionIds.has(sectionNodeId)
  );

  if (!sectionNodeIds.length) {
    return [];
  }

  const sectionsDir = path.join(params.outputDir, "sections");
  await mkdir(sectionsDir, { recursive: true });

  const sections: SectionCapture[] = [];

  sectionNodeIds.forEach((sectionNodeId, index) => {
    const sectionNode = nodeById.get(sectionNodeId);

    if (!sectionNode) {
      return;
    }

    const subtreeNodeIds = collectSubtreeNodeIds(sectionNode.id, nodeById);
    const subtreeNodes = subtreeNodeIds
      .map((nodeId) => nodeById.get(nodeId))
      .filter((node): node is LayoutNode => Boolean(node));
    const detectedSection = detectedSectionById.get(sectionNode.id);
    const name = `${detectedSection?.type ?? "section"}-${index + 1}`;
    sections.push({
      id: `section-capture-${index + 1}`,
      nodeId: sectionNode.id,
      name,
      type: String(detectedSection?.type ?? sectionNode.detection?.semanticRole ?? sectionNode.kind),
      box: {
        x: sectionNode.box.x,
        y: sectionNode.box.y,
        width: Math.max(sectionNode.box.width, 1),
        height: Math.max(sectionNode.box.height, 1)
      },
      subtreeNodeIds,
      originalHtml: "",
      htmlCandidate: "",
      complexity: createSectionComplexity(sectionNode, subtreeNodes, nodeById),
      viewports: {},
      debug: {
        sectionBoundingBox: {
          x: sectionNode.box.x,
          y: sectionNode.box.y,
          width: Math.max(sectionNode.box.width, 1),
          height: Math.max(sectionNode.box.height, 1)
        },
        sectionWidth: Math.max(sectionNode.box.width, 1),
        sectionHeight: Math.max(sectionNode.box.height, 1),
        originalImages: [],
        cssBackgrounds: [],
        loadedFonts: [],
        interactiveElements: [],
        positionedElements: []
      }
    });
  });

  const browserFactory = await createBrowserFactory();

  try {
    for (const viewport of params.capture.viewports) {
      const session = await browserFactory.createPageSession(viewport);

      try {
        await session.page.setContent(params.capture.renderedHtml, {
          waitUntil: "domcontentloaded",
          timeout: 20000
        });
        await installBrowserEvalShim(session.page);
        await preparePageForVisualCapture(session.page, {
          timeoutMs: 15000,
          scrollEntirePage: true
        });

        for (const section of sections) {
          const locator = session.page.locator(`[data-capture-id="${section.nodeId}"]`);

          if ((await locator.count()) === 0) {
            continue;
          }

          const extracted = (await extractViewportSectionData({
            page: session.page,
            nodeId: section.nodeId,
            capturePadding: params.capturePadding
          })) as ExtractedSectionViewport | null;

          if (!extracted) {
            continue;
          }

          if (extracted.captureBox.width <= 0 || extracted.captureBox.height <= 0) {
            appendUnsafeSectionReason(section, `capture-box-invalid-${viewport.name}`);
            continue;
          }

          let pngBuffer: Uint8Array;

          try {
            pngBuffer = await session.page.screenshot({
              type: "png",
              clip: {
                x: extracted.captureBox.x,
                y: extracted.captureBox.y,
                width: extracted.captureBox.width,
                height: extracted.captureBox.height
              }
            });
          } catch (error) {
            appendUnsafeSectionReason(
              section,
              error instanceof Error
                ? `capture-failed-${viewport.name}:${error.message}`
                : `capture-failed-${viewport.name}`
            );
            continue;
          }
          const suffix = params.fileSuffix ? `-${params.fileSuffix}` : "";
          const snapshotPath = join(
            sectionsDir,
            `${section.nodeId}-${viewport.name}${suffix}.png`
          );
          await writeFile(snapshotPath, pngBuffer);

          section.viewports[viewport.name] = {
            viewport: viewport.name,
            width: extracted.captureBox.width,
            height: extracted.captureBox.height,
            snapshotPath,
            snapshotDataUrl: toPngDataUrl(pngBuffer),
            captureBox: extracted.captureBox,
            invadingNodeIds: extracted.invadingNodeIds,
            captureStrategy: extracted.captureStrategy,
            linkOverlays: extracted.linkOverlays
          };

          if (viewport.name === "desktop") {
            section.box = extracted.box;
            section.originalHtml = extracted.originalHtml;
            section.htmlCandidate = buildFrozenSectionDocument({
              nodeId: section.nodeId,
              width: extracted.box.width,
              minHeight: extracted.box.height,
              frozenHtmlMarkup: extracted.frozenHtmlMarkup
            });
            section.complexity.pseudoElementNodes = extracted.pseudoElementNodes;
            section.complexity.hasPseudoElements = extracted.hasPseudoElements;
            section.complexity.transformedNodes = extracted.transformedNodes;
            section.complexity.hasTransforms = extracted.hasTransforms;
            section.complexity.overlayNodes = Math.max(
              section.complexity.overlayNodes,
              extracted.overlayNodes
            );
            section.complexity.complexZIndexNodes = Math.max(
              section.complexity.complexZIndexNodes,
              extracted.complexZIndexNodes
            );
            section.complexity.gradientNodes = extracted.gradientNodes;
            section.complexity.animatedNodes = extracted.animatedNodes;
            section.complexity.unsupportedCssNodes = extracted.unsupportedCssNodes;
            section.complexity.carouselNodes = extracted.carouselNodes;
            section.debug = {
              sectionBoundingBox: extracted.box,
              captureBoundingBox: extracted.captureBox,
              sectionWidth: extracted.box.width,
              sectionHeight: extracted.box.height,
              originalImages: extracted.originalImages,
              cssBackgrounds: extracted.cssBackgrounds,
              loadedFonts: extracted.loadedFonts,
              interactiveElements: extracted.interactiveElements,
              positionedElements: extracted.positionedElements,
              unsafeSectionBoundary: extracted.unsafeSectionBoundary,
              unsafeReasons: extracted.unsafeReasons
            } satisfies SectionCaptureDebugInfo;
          }
        }
      } finally {
        await session.close().catch(() => undefined);
      }
    }
  } finally {
    await browserFactory.close().catch(() => undefined);
  }

  return sections;
}
