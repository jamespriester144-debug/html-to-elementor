import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";

import type {
  CaptureViewportProfile,
  PageCapture,
  SectionCapture,
  SectionOverlayLink
} from "@/lib/converter-v3/contracts/capture";
import type { LayoutDocument, LayoutNode } from "@/lib/converter-v3/contracts/layout";

type PageSession = {
  page: any;
  close: () => Promise<void>;
};

type BrowserSessionFactory = {
  createPageSession: (viewport: CaptureViewportProfile) => Promise<PageSession>;
  close: () => Promise<void>;
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
  hasPseudoElements: boolean;
  hasTransforms: boolean;
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

function buildSectionNodeIds(layout: LayoutDocument) {
  const ids =
    layout.detectedSections.length > 0
      ? layout.detectedSections.map((section) => section.id)
      : layout.sectionIds;

  return [...new Set(ids)];
}

function toPngDataUrl(buffer: Buffer) {
  return `data:image/png;base64,${buffer.toString("base64")}`;
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

async function waitForStablePage(page: PageSession["page"]) {
  await page.setJavaScriptEnabled?.(true).catch(() => undefined);
  await page.waitForSelector?.("body", { timeout: 10000 }).catch(() => undefined);
  await page.waitForLoadState?.("domcontentloaded", { timeout: 10000 }).catch(() => undefined);
  await page.waitForLoadState?.("networkidle", { timeout: 5000 }).catch(() => undefined);
  await page.waitForNetworkIdle?.({ idleTime: 500, timeout: 5000 }).catch(() => undefined);
  await page.evaluate(() => document.fonts?.ready, undefined).catch(() => undefined);
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
        page,
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
        page,
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
  page: PageSession["page"];
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
          const elements = [root].concat(Array.from(root.querySelectorAll("*")));
          const frozenRoot = cloneNodeWithInlineStyles(root);
          const hasPseudoElements = elements.some(
            (element) => hasPseudoElement(element, "::before") || hasPseudoElement(element, "::after")
          );
          const hasTransforms = elements.some((element) => {
            const transform = window.getComputedStyle(element).transform;
            return transform && transform !== "none";
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
            hasPseudoElements,
            hasTransforms
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

function createSectionComplexity(sectionNode: LayoutNode, subtreeNodes: LayoutNode[]) {
  return {
    nodeCount: subtreeNodes.length,
    absoluteNodes: subtreeNodes.filter((node) =>
      ["absolute", "fixed", "sticky"].includes(node.layout.position ?? "")
    ).length,
    overlappingNodes: countSubtreeOverlaps(subtreeNodes),
    interactiveNodes: subtreeNodes.filter((node) => node.kind === "button").length,
    imageNodes: subtreeNodes.filter((node) => node.kind === "image").length,
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
      .filter((node) => node.kind === "button" && Boolean(node.content.href?.trim()))
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
      complexity: createSectionComplexity(sectionNode, subtreeNodes),
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
            section.complexity.hasPseudoElements = extracted.hasPseudoElements;
            section.complexity.hasTransforms = extracted.hasTransforms;
          }
        }
      } finally {
        await session.close().catch(() => undefined);
      }
    }
  } finally {
    await browserFactory.close().catch(() => undefined);
  }

  return sections.map(({ linkNodeIds, ...section }) => section);
}
