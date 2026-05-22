import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JSDOM } from "jsdom";

import type {
  BrowserPage,
  BrowserPageSession
} from "@/lib/converter-v3/browser-page";
import {
  CAPTURED_STYLE_PROPERTIES,
  extractRenderedDomNodes,
  extractViewportNodes
} from "@/lib/converter-v3/bounding-box-extractor";
import type {
  CapturedNode,
  CaptureViewportName,
  CaptureViewportProfile,
  CapturedViewportState
} from "@/lib/converter-v3/contracts/capture";
import type { ResolvedSource } from "@/lib/converter-v3/contracts/source";
import { CAPTURE_VIEWPORTS } from "@/lib/converter-v3/render/viewport-profiles";
import { getLovableBaseCss, inlineLovableStyles } from "@/lib/tailwind";

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

function createFallbackAsset(
  attributes: Record<string, string>,
  inlineStyles: Record<string, string>
) {
  const backgroundImage = inlineStyles["background-image"];

  return {
    href: attributes.href,
    src: attributes.src,
    alt: attributes.alt,
    backgroundImage:
      backgroundImage && backgroundImage !== "none" ? backgroundImage : undefined
  };
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
    const inlineStyles = parseInlineStyle(element.getAttribute("style"));
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
      computedStyles: inlineStyles,
      box: null,
      viewportStates: Object.fromEntries(
        CAPTURE_VIEWPORTS.map((viewport) => [
          viewport.name,
          createViewportState(inlineStyles, null, true)
        ])
      ),
      visualOrder: index + 1,
      isVisible: true,
      asset: createFallbackAsset(attributes, inlineStyles)
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

async function waitForStablePage(page: BrowserPage) {
  await page.setJavaScriptEnabled?.(true).catch(() => undefined);
  await page.waitForSelector?.("body", { timeout: 10000 }).catch(() => undefined);
  await page.waitForLoadState?.("domcontentloaded", { timeout: 10000 }).catch(() => undefined);
  await page.waitForLoadState?.("networkidle", { timeout: 5000 }).catch(() => undefined);
  await page.waitForNetworkIdle?.({ idleTime: 500, timeout: 5000 }).catch(() => undefined);
  await page.evaluate(() => document.fonts?.ready).catch(() => undefined);
}

async function captureUsingPageFactory(
  documentHtml: string,
  outputDir: string,
  createPageSession: (viewport: CaptureViewportProfile) => Promise<BrowserPageSession>
): Promise<BrowserRenderArtifact> {
  const desktopViewport = CAPTURE_VIEWPORTS[0];
  const desktopSession = await createPageSession(desktopViewport);

  await desktopSession.page.setContent(documentHtml, {
    waitUntil: "domcontentloaded",
    timeout: 20000
  });
  await waitForStablePage(desktopSession.page);

  const evaluated = await extractRenderedDomNodes(
    desktopSession.page,
    CAPTURED_STYLE_PROPERTIES
  );
  const screenshots: Partial<Record<CaptureViewportName, string>> = {};
  const viewportStateMaps = new Map<CaptureViewportName, Map<string, Awaited<ReturnType<typeof extractViewportNodes>>[number]>>();

  try {
    for (const viewport of CAPTURE_VIEWPORTS) {
      const session =
        viewport.name === "desktop"
          ? desktopSession
          : await createPageSession(viewport);

      if (viewport.name !== "desktop") {
        await session.page.setContent(documentHtml, {
          waitUntil: "domcontentloaded",
          timeout: 20000
        });
        await waitForStablePage(session.page);
      }

      const viewportStates = await extractViewportNodes(
        session.page,
        CAPTURED_STYLE_PROPERTIES
      );
      viewportStateMaps.set(
        viewport.name,
        new Map(viewportStates.map((state) => [state.id, state]))
      );

      const screenshotPath = join(outputDir, `screenshot-${viewport.name}.png`);
      await session.page.screenshot({ path: screenshotPath, fullPage: true });
      screenshots[viewport.name] = screenshotPath;

      if (viewport.name !== "desktop") {
        await session.close();
      }
    }
  } finally {
    await desktopSession.close().catch(() => undefined);
  }

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
}

async function tryRenderWithPlaywright(
  documentHtml: string,
  outputDir: string
): Promise<BrowserRenderArtifact> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    headless: true,
    timeout: 10000,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  try {
    return await captureUsingPageFactory(documentHtml, outputDir, async (viewport) => {
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
      } satisfies BrowserPageSession;
    });
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function tryRenderWithPuppeteer(
  documentHtml: string,
  outputDir: string,
  userDataDir: string
): Promise<BrowserRenderArtifact> {
  const puppeteer = await import("puppeteer");
  const browser = await puppeteer.launch({
    headless: true,
    timeout: 10000,
    userDataDir,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  try {
    return await captureUsingPageFactory(documentHtml, outputDir, async (viewport) => {
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
      } satisfies BrowserPageSession;
    });
  } finally {
    await browser.close().catch(() => undefined);
  }
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

  let userDataDir: string | null = null;

  try {
    await mkdir(outputDir, { recursive: true });
    const documentHtml = ensureRenderableDocument(resolvedSource.html);

    try {
      return await tryRenderWithPlaywright(documentHtml, outputDir);
    } catch {
      userDataDir = await mkdtemp(join(tmpdir(), "html-to-elementor-v3-"));
      return await tryRenderWithPuppeteer(documentHtml, outputDir, userDataDir);
    }
  } catch {
    return {
      ...collectFallbackNodes(resolvedSource.html),
      screenshots: {},
      viewports: CAPTURE_VIEWPORTS
    };
  } finally {
    if (userDataDir) {
      await rm(userDataDir, {
        recursive: true,
        force: true,
        maxRetries: 2
      }).catch(() => undefined);
    }
  }
}
