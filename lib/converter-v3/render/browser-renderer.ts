import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JSDOM } from "jsdom";

import type {
  CapturedNode,
  CaptureViewportName,
  CaptureViewportProfile,
  CapturedViewportState
} from "@/lib/converter-v3/contracts/capture";
import type { ResolvedSource } from "@/lib/converter-v3/contracts/source";
import { CAPTURE_VIEWPORTS } from "@/lib/converter-v3/render/viewport-profiles";
import { getLovableBaseCss, inlineLovableStyles } from "@/lib/tailwind";

const computedStyleProperties = [
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
  "border",
  "border-color",
  "border-radius",
  "box-shadow",
  "object-fit",
  "object-position",
  "text-align",
  "cursor",
  "visibility",
  "opacity",
  "z-index"
];

export type BrowserRenderArtifact = {
  title: string;
  renderedHtml: string;
  css: string;
  nodes: CapturedNode[];
  screenshots: Partial<Record<CaptureViewportName, string>>;
  viewports: CaptureViewportProfile[];
  renderer: "browser" | "server";
};

export type BrowserRenderOptions = {
  preferBrowser?: boolean;
};

type EvaluatedViewportNode = {
  id: string;
  computedStyles: Record<string, string>;
  box: CapturedNode["box"];
  isVisible: boolean;
};

function parseInlineStyle(style: string | null): Record<string, string> {
  if (!style) {
    return {};
  }

  return style
    .split(";")
    .map((declaration) => declaration.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((acc, declaration) => {
      const separatorIndex = declaration.indexOf(":");

      if (separatorIndex === -1) {
        return acc;
      }

      const property = declaration.slice(0, separatorIndex).trim().toLowerCase();
      const value = declaration.slice(separatorIndex + 1).trim();

      if (property && value) {
        acc[property] = value;
      }

      return acc;
    }, {});
}

function ensureRenderableDocument(html: string): string {
  const dom = new JSDOM(inlineLovableStyles(html));
  const document = dom.window.document;

  if (!document.querySelector("meta[charset]")) {
    const meta = document.createElement("meta");
    meta.setAttribute("charset", "utf-8");
    document.head.prepend(meta);
  }

  if (!document.querySelector('meta[name="viewport"]')) {
    const meta = document.createElement("meta");
    meta.setAttribute("name", "viewport");
    meta.setAttribute("content", "width=device-width, initial-scale=1");
    document.head.prepend(meta);
  }

  const style = document.createElement("style");
  style.setAttribute("data-converter-v3-base-css", "true");
  style.textContent = getLovableBaseCss().replace(/^<style>|<\/style>$/g, "");
  document.head.append(style);

  return dom.serialize();
}

function createViewportState(
  computedStyles: Record<string, string>,
  box: CapturedNode["box"],
  isVisible: boolean
): CapturedViewportState {
  return {
    computedStyles,
    box,
    isVisible
  };
}

async function evaluateViewportStates(
  page: any,
  properties: string[]
): Promise<EvaluatedViewportNode[]> {
  return page.evaluate((capturedProperties: string[]) => {
    const elements = [document.body, ...Array.from(document.body.querySelectorAll<HTMLElement>("*"))];

    elements.forEach((element, index) => {
      if (!element.getAttribute("data-capture-id")) {
        element.setAttribute("data-capture-id", `capture-node-${index + 1}`);
      }
    });

    return elements.map((element, index) => {
      const computed = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const computedStyles = capturedProperties.reduce((acc: Record<string, string>, property: string) => {
        const value = computed.getPropertyValue(property);

        if (value) {
          acc[property] = value.trim();
        }

        return acc;
      }, {} as Record<string, string>);

      return {
        id: element.getAttribute("data-capture-id") || `capture-node-${index + 1}`,
        computedStyles,
        box: {
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
        },
        isVisible:
          computed.display !== "none" &&
          computed.visibility !== "hidden" &&
          computed.opacity !== "0" &&
          rect.width >= 0 &&
          rect.height >= 0
      };
    });
  }, properties);
}

function collectFallbackNodes(html: string): Omit<BrowserRenderArtifact, "screenshots" | "viewports"> {
  const dom = new JSDOM(ensureRenderableDocument(html));
  const document = dom.window.document;
  const elements = [document.body, ...Array.from(document.body.querySelectorAll<HTMLElement>("*"))];

  const nodes = elements.map((element, index) => {
    const id = element.getAttribute("data-capture-id") || `capture-node-${index + 1}`;
    const text = [...element.childNodes]
      .filter((node) => node.nodeType === dom.window.Node.TEXT_NODE)
      .map((node) => node.textContent ?? "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    const attributes = [...element.attributes].reduce<Record<string, string>>((acc, attribute) => {
      acc[attribute.name] = attribute.value;
      return acc;
    }, {});
    const childIds = Array.from(element.children).map((child) => {
      const childIndex = elements.indexOf(child as HTMLElement);
      return child.getAttribute("data-capture-id") || `capture-node-${childIndex + 1}`;
    });

    element.setAttribute("data-capture-id", id);

    return {
      id,
      tag: element.tagName.toLowerCase(),
      text,
      attributes,
      parentId:
        element.parentElement?.getAttribute("data-capture-id") ??
        (element === document.body ? null : null),
      childIds,
      computedStyles: parseInlineStyle(element.getAttribute("style")),
      box: null,
      viewportStates: Object.fromEntries(
        CAPTURE_VIEWPORTS.map((viewport) => [
          viewport.name,
          createViewportState(parseInlineStyle(element.getAttribute("style")), null, true)
        ])
      ),
      visualOrder: index + 1,
      isVisible: true
    } satisfies CapturedNode;
  });

  return {
    title: document.title || "Untitled Capture",
    renderedHtml: document.documentElement.outerHTML,
    css: Array.from(document.querySelectorAll("style"))
      .map((element) => element.textContent ?? "")
      .join("\n"),
    nodes,
    renderer: "server"
  };
}

async function waitForStablePage(page: Awaited<ReturnType<typeof import("puppeteer").launch>> extends infer _T ? any : never) {
  await page.setJavaScriptEnabled(true);
  await page.waitForSelector("body", { timeout: 10000 }).catch(() => undefined);
  await page.waitForNetworkIdle({ idleTime: 500, timeout: 5000 }).catch(() => undefined);
  await page.evaluate(() => document.fonts?.ready).catch(() => undefined);
}

export async function renderResolvedSourceForCapture(
  resolvedSource: ResolvedSource,
  outputDir: string,
  options: BrowserRenderOptions = {}
): Promise<BrowserRenderArtifact> {
  if (options.preferBrowser === false) {
    return {
      ...collectFallbackNodes(resolvedSource.html),
      screenshots: {},
      viewports: CAPTURE_VIEWPORTS
    };
  }

  let browser: Awaited<ReturnType<typeof import("puppeteer").launch>> | null = null;
  let userDataDir: string | null = null;

  try {
    await mkdir(outputDir, { recursive: true });
    const puppeteer = await import("puppeteer");
    const documentHtml = ensureRenderableDocument(resolvedSource.html);

    userDataDir = await mkdtemp(join(tmpdir(), "html-to-elementor-v3-"));
    browser = await puppeteer.launch({
      headless: true,
      timeout: 10000,
      userDataDir,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const desktopViewport = CAPTURE_VIEWPORTS[0];
    const desktopPage = await browser.newPage();
    await desktopPage.setViewport({
      width: desktopViewport.width,
      height: desktopViewport.height,
      deviceScaleFactor: 1
    });
    await desktopPage.setContent(documentHtml, {
      waitUntil: "domcontentloaded",
      timeout: 20000
    });
    await waitForStablePage(desktopPage);

    const evaluated = await desktopPage.evaluate((properties) => {
      const elements = [document.body, ...Array.from(document.body.querySelectorAll<HTMLElement>("*"))];

      elements.forEach((element, index) => {
        if (!element.getAttribute("data-capture-id")) {
          element.setAttribute("data-capture-id", `capture-node-${index + 1}`);
        }
      });

      const nodes = elements.map((element, index) => {
        const computed = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const computedStyles = properties.reduce<Record<string, string>>((acc, property) => {
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
          box: {
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
          },
          viewportStates: {},
          visualOrder: index + 1,
          isVisible:
            computed.display !== "none" &&
            computed.visibility !== "hidden" &&
            computed.opacity !== "0" &&
            rect.width >= 0 &&
            rect.height >= 0
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
    }, computedStyleProperties);

    const screenshots: Partial<Record<CaptureViewportName, string>> = {};
    const viewportStateMaps = new Map<CaptureViewportName, Map<string, EvaluatedViewportNode>>();

    for (const viewport of CAPTURE_VIEWPORTS) {
      const page =
        viewport.name === "desktop"
          ? desktopPage
          : await browser.newPage();

      if (viewport.name !== "desktop") {
        await page.setViewport({
          width: viewport.width,
          height: viewport.height,
          deviceScaleFactor: 1
        });
        await page.setContent(documentHtml, {
          waitUntil: "domcontentloaded",
          timeout: 20000
        });
        await waitForStablePage(page);
      }

      const viewportStates = await evaluateViewportStates(page, computedStyleProperties);
      viewportStateMaps.set(
        viewport.name,
        new Map(viewportStates.map((state) => [state.id, state]))
      );

      const screenshotPath = join(outputDir, `screenshot-${viewport.name}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      screenshots[viewport.name] = screenshotPath;

      if (viewport.name !== "desktop") {
        await page.close();
      }
    }

    await desktopPage.close();

    const nodes = evaluated.nodes.map((node) => ({
      ...node,
      viewportStates: Object.fromEntries(
        CAPTURE_VIEWPORTS.map((viewport) => {
          const state = viewportStateMaps.get(viewport.name)?.get(node.id);

          return [
            viewport.name,
            state
              ? createViewportState(state.computedStyles, state.box, state.isVisible)
              : createViewportState(
                  viewport.name === "desktop" ? node.computedStyles : {},
                  viewport.name === "desktop" ? node.box : null,
                  viewport.name === "desktop" ? node.isVisible : false
                )
          ];
        })
      )
    }));

    return {
      ...evaluated,
      nodes,
      screenshots,
      viewports: CAPTURE_VIEWPORTS,
      renderer: "browser"
    };
  } catch {
    return {
      ...collectFallbackNodes(resolvedSource.html),
      screenshots: {},
      viewports: CAPTURE_VIEWPORTS
    };
  } finally {
    await browser?.close().catch(() => undefined);

    if (userDataDir) {
      await rm(userDataDir, {
        recursive: true,
        force: true,
        maxRetries: 2
      }).catch(() => undefined);
    }
  }
}
