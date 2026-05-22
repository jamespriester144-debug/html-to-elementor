import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";

import type {
  BrowserLocator,
  BrowserPage,
  BrowserScreenshotOptions,
  BrowserPageSessionWithLocator
} from "@/lib/converter-v3/browser-page";
import type {
  CaptureViewportProfile,
  PageCapture,
  SectionComplexity,
  SectionCapture,
  SectionOverlayLink
} from "@/lib/converter-v3/contracts/capture";
import type { LayoutDocument, LayoutNode } from "@/lib/converter-v3/contracts/layout";

type BrowserSessionFactory = {
  createPageSession: (viewport: CaptureViewportProfile) => Promise<BrowserPageSessionWithLocator>;
  close: () => Promise<void>;
};

type PageWithOptionalLocator = BrowserPage & {
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
  originalHtml: string;
  frozenHtmlMarkup: string;
  linkOverlays: SectionOverlayLink[];
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
};

type PreparedSectionCapture = SectionCapture & {
  linkNodeIds: string[];
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

async function waitForStablePage(page: BrowserPage) {
  await page.setJavaScriptEnabled?.(true).catch(() => undefined);
  await page.waitForSelector?.("body", { timeout: 10000 }).catch(() => undefined);
  await page.waitForLoadState?.("domcontentloaded", { timeout: 10000 }).catch(() => undefined);
  await page.waitForLoadState?.("networkidle", { timeout: 5000 }).catch(() => undefined);
  await page.waitForNetworkIdle?.({ idleTime: 500, timeout: 5000 }).catch(() => undefined);
  await page.evaluate(() => document.fonts?.ready).catch(() => undefined);
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

async function createPuppeteerFactory(userDataDir: string): Promise<BrowserSessionFactory> {
  const puppeteer = await import("puppeteer");
  const browser = await puppeteer.launch({
    headless: true,
    timeout: 10000,
    userDataDir,
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
  linkNodeIds: string[];
}) {
  return params.page.evaluate(
    ({
      nodeId,
      linkNodeIds,
      styleProperties
    }: {
      nodeId: string;
      linkNodeIds: string[];
      styleProperties: readonly string[];
    }) => {
      const run = new Function(
        "nodeId",
        "linkNodeIds",
        "styleProperties",
        `
          const root = document.querySelector('[data-capture-id="' + nodeId + '"]');

          if (!root) {
            return null;
          }

          const rootRect = root.getBoundingClientRect();
          const serializeStyle = function(element) {
            const computed = window.getComputedStyle(element);
            return styleProperties
              .map((property) => {
                const value = computed.getPropertyValue(property).trim();
                return value ? property + ":" + value : "";
              })
              .filter(Boolean)
              .join(";");
          };
          const cloneNodeWithInlineStyles = function(node) {
            if (node.nodeType === window.Node.TEXT_NODE) {
              return document.createTextNode(node.textContent || "");
            }

            if (node.nodeType !== window.Node.ELEMENT_NODE) {
              return null;
            }

            const element = node;
            const tagName = element.tagName.toLowerCase();

            if (tagName === "script" || tagName === "noscript") {
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
          };
          const hasPseudoElement = function(element, pseudo) {
            const computed = window.getComputedStyle(element, pseudo);
            const content = computed.content;
            const width = Number.parseFloat(computed.width || "0");
            const height = Number.parseFloat(computed.height || "0");

            return (
              content !== "none" &&
              content !== "normal" &&
              (computed.display !== "none" || width > 0 || height > 0)
            );
          };
          const isTransitionAnimated = function(computed) {
            const duration = (computed.transitionDuration || "")
              .split(",")
              .map((value) => Number.parseFloat(value) || 0);
            return duration.some((value) => value > 0);
          };
          const isComplexGradient = function(computed) {
            const backgroundImage = computed.backgroundImage || "";
            if (!/gradient\\(/i.test(backgroundImage)) {
              return false;
            }

            const gradientSegments = backgroundImage.split(/,(?![^()]*\\))/);
            return gradientSegments.length > 1 || /conic-gradient|radial-gradient/i.test(backgroundImage);
          };
          const usesUnsupportedCss = function(computed) {
            const filter = computed.filter || "";
            const backdropFilter = computed.getPropertyValue("backdrop-filter") || "";
            const clipPath = computed.clipPath || computed.getPropertyValue("clip-path") || "";
            const maskImage =
              computed.maskImage ||
              computed.webkitMaskImage ||
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
          };
          const isCarouselLike = function(element, computed) {
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
          };
          const elements = [root].concat(Array.from(root.querySelectorAll("*")));
          const frozenRoot = cloneNodeWithInlineStyles(root);
          let pseudoElementNodes = 0;
          let transformedNodes = 0;
          let overlayNodes = 0;
          let complexZIndexNodes = 0;
          let gradientNodes = 0;
          let animatedNodes = 0;
          let unsupportedCssNodes = 0;
          let carouselNodes = 0;

          elements.forEach((element) => {
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
          const linkOverlays = linkNodeIds
            .map((linkNodeId) => {
              const element =
                root.getAttribute("data-capture-id") === linkNodeId
                  ? root
                  : root.querySelector('[data-capture-id="' + linkNodeId + '"]');

              if (!element) {
                return null;
              }

              const rect = element.getBoundingClientRect();
              const href =
                element instanceof HTMLAnchorElement
                  ? element.href
                  : element.getAttribute("href") || "";

              if (!href) {
                return null;
              }

              const width = Math.max(rect.width, 1);
              const height = Math.max(rect.height, 1);
              const rootWidth = Math.max(rootRect.width, 1);
              const rootHeight = Math.max(rootRect.height, 1);
              const relativeX = rect.left - rootRect.left;
              const relativeY = rect.top - rootRect.top;

              return {
                nodeId: linkNodeId,
                href,
                text: (element.textContent || "").replace(/\\s+/g, " ").trim(),
                title: element.getAttribute("title") || undefined,
                target: element.getAttribute("target") || undefined,
                rel: element.getAttribute("rel") || undefined,
                isButton:
                  element.tagName.toLowerCase() === "button" ||
                  element.getAttribute("role") === "button",
                box: {
                  x: rect.left,
                  y: rect.top,
                  width,
                  height
                },
                relativeBox: {
                  x: relativeX / rootWidth,
                  y: relativeY / rootHeight,
                  width: width / rootWidth,
                  height: height / rootHeight
                }
              };
            })
            .filter(Boolean);

          return {
            box: {
              x: rootRect.left,
              y: rootRect.top,
              width: Math.max(rootRect.width, 1),
              height: Math.max(rootRect.height, 1)
            },
            originalHtml: root.outerHTML,
            frozenHtmlMarkup: frozenRoot ? frozenRoot.outerHTML : root.outerHTML,
            linkOverlays,
            pseudoElementNodes,
            hasPseudoElements: pseudoElementNodes > 0,
            transformedNodes,
            hasTransforms: transformedNodes > 0,
            overlayNodes,
            complexZIndexNodes,
            gradientNodes,
            animatedNodes,
            unsupportedCssNodes,
            carouselNodes
          };
        `
      );

      return run(nodeId, linkNodeIds, styleProperties);
    },
    {
      nodeId: params.nodeId,
      linkNodeIds: params.linkNodeIds,
      styleProperties: FROZEN_STYLE_PROPERTIES
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

export async function buildVisualSectionCaptures(params: {
  capture: PageCapture;
  layout: LayoutDocument;
  outputDir: string;
}): Promise<SectionCapture[]> {
  if (params.capture.renderer !== "browser") {
    return [];
  }

  const nodeById = buildLayoutNodeMap(params.layout);
  const detectedSectionById = new Map(
    params.layout.detectedSections.map((section) => [section.id, section])
  );
  const sectionNodeIds = buildSectionNodeIds(params.layout);

  if (!sectionNodeIds.length) {
    return [];
  }

  const sectionsDir = path.join(params.outputDir, "sections");
  await mkdir(sectionsDir, { recursive: true });

  const sections: PreparedSectionCapture[] = [];

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
    const linkNodeIds = subtreeNodes
      .filter((node) => Boolean(node.content.href?.trim()))
      .map((node) => node.id);

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
      linkNodeIds,
      viewports: {}
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
        await waitForStablePage(session.page);

        for (const section of sections) {
          const locator = session.page.locator(`[data-capture-id="${section.nodeId}"]`);

          if ((await locator.count()) === 0) {
            continue;
          }

          const extracted = (await extractViewportSectionData({
            page: session.page,
            nodeId: section.nodeId,
            linkNodeIds: section.linkNodeIds
          })) as ExtractedSectionViewport | null;

          if (!extracted) {
            continue;
          }

          const pngBuffer = await locator.screenshot({ type: "png" });
          const snapshotPath = join(sectionsDir, `${section.nodeId}-${viewport.name}.png`);
          await writeFile(snapshotPath, pngBuffer);

          section.viewports[viewport.name] = {
            viewport: viewport.name,
            width: extracted.box.width,
            height: extracted.box.height,
            snapshotPath,
            snapshotDataUrl: toPngDataUrl(pngBuffer),
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
          }
        }
      } finally {
        await session.close().catch(() => undefined);
      }
    }
  } finally {
    await browserFactory.close().catch(() => undefined);
  }

  return sections.map((section) => {
    const { linkNodeIds, ...result } = section;
    void linkNodeIds;
    return result;
  });
}
