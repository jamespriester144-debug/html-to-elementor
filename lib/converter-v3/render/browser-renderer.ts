import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";

import { JSDOM } from "jsdom";

import type {
  BrowserPageSession
} from "@/lib/converter-v3/browser-page";
import { installBrowserEvalShim } from "@/lib/converter-v3/browser-eval-shim";
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
import { startLocalRenderServer } from "@/lib/converter-v3/render/local-render-server";
import { CAPTURE_VIEWPORTS } from "@/lib/converter-v3/render/viewport-profiles";
import { preparePageForVisualCapture } from "@/lib/converter-v3/visual-capture-stability";
import { getLovableBaseCss, inlineLovableStyles } from "@/lib/tailwind";

export type BrowserResourceStatus = {
  url: string;
  kind: string;
  status: "loaded" | "failed" | "pending" | "skipped";
  reason?: string;
  sourceTag?: string;
  sourceAttribute?: string;
  lazy?: boolean;
};

export type BrowserRenderDiagnostics = {
  htmlRendered: boolean;
  cssLoaded: boolean;
  imagesLoaded: boolean;
  relativeAssetsResolved: boolean;
  viewportMatched: boolean;
  warnings: string[];
  errors: string[];
  resources: BrowserResourceStatus[];
};

export type BrowserRenderArtifact = {
  title: string;
  renderedHtml: string;
  css: string;
  nodes: CapturedNode[];
  screenshots: Partial<Record<CaptureViewportName, string>>;
  viewports: CaptureViewportProfile[];
  renderer: "browser" | "server";
  diagnostics: BrowserRenderDiagnostics;
};

export type BrowserRenderOptions = {
  preferBrowser?: boolean;
};

type RenderTarget =
  | {
      kind: "html";
      html: string;
    }
  | {
      kind: "url";
      url: string;
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
    href: attributes.href || attributes["data-href"] || attributes["data-url"],
    src: attributes.src,
    alt: attributes.alt,
    poster: attributes.poster,
    backgroundImage:
      backgroundImage && backgroundImage !== "none" ? backgroundImage : undefined
  };
}

function buildFallbackDiagnostics(renderedHtml: string, error?: unknown): BrowserRenderDiagnostics {
  const hasStyles = /<style[\s>]|style=|<link[^>]+stylesheet/i.test(renderedHtml);
  const hasImages = /<img[\s>]|background-image\s*:/i.test(renderedHtml);
  const errorMessage = error instanceof Error ? error.message : undefined;

  return {
    htmlRendered: true,
    cssLoaded: hasStyles,
    imagesLoaded: !hasImages || /data:image\//i.test(renderedHtml),
    relativeAssetsResolved: false,
    viewportMatched: false,
    warnings: [
      "Renderizacao no navegador nao ficou disponivel; a analise usou somente o DOM estatico."
    ],
    errors: errorMessage ? [errorMessage] : [],
    resources: []
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

  const renderedHtml = document.documentElement.outerHTML;

  return {
    title: document.title || "Untitled Capture",
    renderedHtml,
    css: Array.from(document.querySelectorAll("style"))
      .map((element) => element.textContent ?? "")
      .join("\n"),
    nodes,
    renderer: "server",
    diagnostics: buildFallbackDiagnostics(renderedHtml)
  };
}

async function loadRenderTarget(
  session: BrowserPageSession,
  target: RenderTarget
) {
  if (target.kind === "url") {
    if (!session.page.goto) {
      throw new Error("The active browser page does not support URL navigation.");
    }

    await session.page.goto(target.url, {
      waitUntil: "domcontentloaded",
      timeout: 20000
    });
    return;
  }

  await session.page.setContent(target.html, {
    waitUntil: "domcontentloaded",
    timeout: 20000
  });
}

async function collectBrowserResourceDiagnostics(
  page: BrowserPageSession["page"]
): Promise<BrowserRenderDiagnostics> {
  return page.evaluate(() => {
    const absolute = (value: string | null | undefined) => {
      const nextValue = (value || "").trim();

      if (!nextValue) {
        return "";
      }

      try {
        return new URL(nextValue, window.location.href).href;
      } catch {
        return nextValue;
      }
    };

    const seen = new Set<string>();
    const resources: BrowserResourceStatus[] = [];
    const warnings: string[] = [];
    const errors: string[] = [];
    const performanceEntries = new Map(
      performance.getEntriesByType("resource").map((entry) => [entry.name, entry])
    );

    const pushResource = (resource: BrowserResourceStatus) => {
      const key = [
        resource.kind,
        resource.sourceTag,
        resource.sourceAttribute,
        resource.url
      ].join("|");

      if (!resource.url || seen.has(key)) {
        return;
      }

      seen.add(key);
      resources.push(resource);
    };

    const classifyUrl = (url: string) => {
      const lowerUrl = url.toLowerCase();

      if (
        lowerUrl.startsWith("data:image/") ||
        /\.(png|jpe?g|gif|webp|svg|avif)(?:$|[?#])/.test(lowerUrl)
      ) {
        return "image";
      }

      if (/\.(woff2?|ttf|otf|eot)(?:$|[?#])/.test(lowerUrl)) {
        return "font";
      }

      if (/\.(css)(?:$|[?#])/.test(lowerUrl)) {
        return "stylesheet";
      }

      if (/\.(js|mjs)(?:$|[?#])/.test(lowerUrl)) {
        return "script";
      }

      return "other";
    };

    const findResourceEntry = (url: string) => performanceEntries.has(url);

    Array.from(document.querySelectorAll<HTMLImageElement>("img")).forEach((image) => {
      const url = absolute(
        image.currentSrc ||
          image.getAttribute("src") ||
          image.getAttribute("data-src") ||
          image.getAttribute("data-lazy-src") ||
          image.getAttribute("data-original")
      );

      if (!url) {
        return;
      }

      const loaded = url.startsWith("data:") || (image.complete && image.naturalWidth > 0);
      const failed = image.complete && image.naturalWidth <= 0 && !url.startsWith("data:");
      const pending = !loaded && !failed;

      pushResource({
        url,
        kind: "image",
        status: loaded ? "loaded" : failed ? "failed" : pending ? "pending" : "skipped",
        reason: failed ? "img-naturalWidth-zero" : pending ? "img-not-complete" : undefined,
        sourceTag: "img",
        sourceAttribute: image.getAttribute("src") ? "src" : "data-src",
        lazy:
          image.loading === "lazy" ||
          Boolean(
            image.getAttribute("data-src") ||
              image.getAttribute("data-lazy-src") ||
              image.getAttribute("data-original")
          )
      });
    });

    Array.from(document.querySelectorAll<HTMLLinkElement>("link[href]")).forEach((link) => {
      const url = absolute(link.getAttribute("href"));

      if (!url) {
        return;
      }

      const isStylesheet = (link.rel || "").toLowerCase().includes("stylesheet");
      const loaded = isStylesheet
        ? Boolean(link.sheet)
        : findResourceEntry(url);

      pushResource({
        url,
        kind: isStylesheet ? "stylesheet" : "link",
        status: loaded ? "loaded" : "failed",
        reason: loaded ? undefined : isStylesheet ? "stylesheet-not-attached" : "link-not-fetched",
        sourceTag: "link",
        sourceAttribute: "href"
      });
    });

    Array.from(document.querySelectorAll<HTMLScriptElement>("script[src]")).forEach((script) => {
      const url = absolute(script.getAttribute("src"));

      if (!url) {
        return;
      }

      const loaded = url.startsWith("data:") || findResourceEntry(url);

      pushResource({
        url,
        kind: "script",
        status: loaded ? "loaded" : "failed",
        reason: loaded ? undefined : "script-not-fetched",
        sourceTag: "script",
        sourceAttribute: "src"
      });
    });

    Array.from(document.querySelectorAll<HTMLIFrameElement>("iframe[src]")).forEach((frame) => {
      const url = absolute(frame.getAttribute("src"));

      if (!url) {
        return;
      }

      const loaded = url.startsWith("data:") || findResourceEntry(url) || Boolean(frame.contentDocument);

      pushResource({
        url,
        kind: "iframe",
        status: loaded ? "loaded" : "failed",
        reason: loaded ? undefined : "iframe-not-loaded",
        sourceTag: "iframe",
        sourceAttribute: "src"
      });
    });

    const backgroundUrls = Array.from(document.querySelectorAll<HTMLElement>("*")).flatMap(
      (element) => {
        const computed = window.getComputedStyle(element);
        const backgroundImage = computed.backgroundImage || "";

        return [...backgroundImage.matchAll(/url\((['"]?)(.*?)\1\)/gi)].map((match) => absolute(match[2]));
      }
    );

    [...new Set(backgroundUrls)].forEach((url) => {
      const loaded = url.startsWith("data:") || findResourceEntry(url);

      pushResource({
        url,
        kind: "background",
        status: loaded ? "loaded" : "failed",
        reason: loaded ? undefined : "background-not-fetched",
        sourceTag: "style",
        sourceAttribute: "background-image"
      });
    });

    performanceEntries.forEach((_, url) => {
      pushResource({
        url,
        kind: classifyUrl(url),
        status: "loaded",
        sourceTag: "performance",
        sourceAttribute: "resource"
      });
    });

    const cssLoaded =
      document.styleSheets.length > 0 || document.querySelectorAll("[style]").length > 0;
    const allImages = Array.from(document.images);
    const imagesLoaded = allImages.every(
      (image) => image.complete && (image.naturalWidth > 0 || !image.currentSrc)
    );
    const meaningfulVisibleElements = Array.from(
      document.body.querySelectorAll<HTMLElement>("*")
    ).filter((element) => {
      if (["script", "style", "noscript"].includes(element.tagName.toLowerCase())) {
        return false;
      }

      const computed = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const text = (element.textContent || "").replace(/\s+/g, " ").trim();
      const backgroundImage = computed.backgroundImage || "";
      const isPlaceholderRoot =
        /^(root|app|__next)$/i.test(element.id) &&
        element.children.length === 0 &&
        text.length === 0;

      if (isPlaceholderRoot) {
        return false;
      }

      return (
        computed.display !== "none" &&
        computed.visibility !== "hidden" &&
        computed.opacity !== "0" &&
        (rect.width > 0 || rect.height > 0) &&
        (text.length > 0 ||
          element.tagName === "IMG" ||
          element.tagName === "SVG" ||
          element.tagName === "PICTURE" ||
          element.tagName === "CANVAS" ||
          element.tagName === "VIDEO" ||
          element.tagName === "IFRAME" ||
          element.tagName === "BUTTON" ||
          (element.tagName === "A" && Boolean(element.getAttribute("href"))) ||
          backgroundImage !== "none")
      );
    });
    const htmlRendered = meaningfulVisibleElements.length > 0;
    const pageOrigin = window.location.origin;
    const localResources = resources.filter(
      (resource) =>
        resource.status !== "skipped" &&
        !resource.url.startsWith("data:") &&
        (resource.url.startsWith(pageOrigin) || !/^https?:\/\//i.test(resource.url))
    );
    const relativeAssetsResolved = localResources.every((resource) => resource.status !== "failed");

    if (!htmlRendered) {
      errors.push("O HTML nao foi renderizado no browser.");
    }

    if (!cssLoaded) {
      warnings.push("O CSS nao carregou corretamente.");
    }

    if (!imagesLoaded) {
      warnings.push("Uma ou mais imagens nao carregaram completamente.");
    }

    if (!relativeAssetsResolved && localResources.length > 0) {
      warnings.push("Um ou mais assets relativos quebraram durante a renderizacao.");
    }

    return {
      htmlRendered,
      cssLoaded,
      imagesLoaded,
      relativeAssetsResolved,
      viewportMatched: true,
      warnings,
      errors,
      resources
    } satisfies BrowserRenderDiagnostics;
  });
}

async function captureUsingPageFactory(
  target: RenderTarget,
  outputDir: string,
  createPageSession: (viewport: CaptureViewportProfile) => Promise<BrowserPageSession>
): Promise<BrowserRenderArtifact> {
  const desktopViewport = CAPTURE_VIEWPORTS[0];
  const desktopSession = await createPageSession(desktopViewport);

  await loadRenderTarget(desktopSession, target);
  await installBrowserEvalShim(desktopSession.page);
  await preparePageForVisualCapture(desktopSession.page, {
    timeoutMs: 15000,
    scrollEntirePage: true
  });

  const evaluated = await extractRenderedDomNodes(
    desktopSession.page,
    CAPTURED_STYLE_PROPERTIES
  );
  const diagnostics = await collectBrowserResourceDiagnostics(desktopSession.page);
  const screenshots: Partial<Record<CaptureViewportName, string>> = {};
  const viewportStateMaps = new Map<CaptureViewportName, Map<string, Awaited<ReturnType<typeof extractViewportNodes>>[number]>>();

  try {
    for (const viewport of CAPTURE_VIEWPORTS) {
      const session =
        viewport.name === "desktop"
          ? desktopSession
          : await createPageSession(viewport);

      if (viewport.name !== "desktop") {
        await loadRenderTarget(session, target);
        await installBrowserEvalShim(session.page);
        await preparePageForVisualCapture(session.page, {
          timeoutMs: 15000,
          scrollEntirePage: true
        });
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
      await session.page.screenshot({
        path: screenshotPath,
        fullPage: true,
        scale: "css"
      });
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
    renderer: "browser",
    diagnostics
  };
}

async function tryRenderWithPlaywright(
  target: RenderTarget,
  outputDir: string
): Promise<BrowserRenderArtifact> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    headless: true,
    timeout: 10000,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  try {
    return await captureUsingPageFactory(target, outputDir, async (viewport) => {
      const context = await browser.newContext({
        viewport: {
          width: viewport.width,
          height: viewport.height
        },
        deviceScaleFactor: 1
      });
      const page = await context.newPage();

      return {
        page: {
          close: () => page.close(),
          evaluate: page.evaluate.bind(page),
          goto: page.goto.bind(page),
          screenshot: (options) => page.screenshot(options),
          setContent: (html, options) => page.setContent(html, options),
          setJavaScriptEnabled: undefined,
          setViewport: page.setViewportSize
            ? (viewportOptions) =>
                page.setViewportSize({
                  width: viewportOptions.width,
                  height: viewportOptions.height
                })
            : undefined,
          waitForLoadState: page.waitForLoadState.bind(page),
          waitForNetworkIdle: page.waitForLoadState
            ? (options) =>
                page.waitForLoadState("networkidle", {
                  timeout: options?.timeout
                })
            : undefined,
          waitForSelector: page.waitForSelector.bind(page)
        },
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
  target: RenderTarget,
  outputDir: string,
  _userDataDir: string
): Promise<BrowserRenderArtifact> {
  const puppeteer = await import("puppeteer");
  const browser = await puppeteer.launch({
    headless: true,
    timeout: 10000,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  try {
    return await captureUsingPageFactory(target, outputDir, async (viewport) => {
      const page = await browser.newPage();
      await page.setViewport({
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 1
      });

      return {
        page: {
          close: () => page.close(),
          evaluate: page.evaluate.bind(page),
          goto: page.goto.bind(page),
          screenshot: (options) => page.screenshot(options),
          setContent: (html, options) => page.setContent(html, options),
          setJavaScriptEnabled: page.setJavaScriptEnabled.bind(page),
          setViewport: page.setViewport.bind(page),
          waitForLoadState: undefined,
          waitForNetworkIdle: page.waitForNetworkIdle?.bind(page),
          waitForSelector: page.waitForSelector.bind(page)
        },
        close: async () => {
          await page.close().catch(() => undefined);
        }
      } satisfies BrowserPageSession;
    });
  } finally {
    await browser.close().catch(() => undefined);
  }
}

function buildRenderTarget(
  resolvedSource: ResolvedSource,
  localOrigin?: string
): RenderTarget {
  if (
    resolvedSource.renderContext?.mode === "local-server" &&
    localOrigin
  ) {
    const relativeEntryPath = resolvedSource.renderContext.entryPath
      .replace(/\\/g, "/")
      .replace(/^\/+/, "");

    return {
      kind: "url",
      url: `${localOrigin}/${relativeEntryPath}`
    };
  }

  return {
    kind: "html",
    html: ensureRenderableDocument(resolvedSource.html)
  };
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
  let localServer: Awaited<ReturnType<typeof startLocalRenderServer>> | null = null;
  let lastError: unknown;

  try {
    await mkdir(outputDir, { recursive: true });

    if (resolvedSource.renderContext?.mode === "local-server") {
      localServer = await startLocalRenderServer(resolvedSource.renderContext.documentRoot);
    }

    const target = buildRenderTarget(resolvedSource, localServer?.origin);

    try {
      return await tryRenderWithPlaywright(target, outputDir);
    } catch (playwrightError) {
      lastError = playwrightError;
      userDataDir = await mkdtemp(join(tmpdir(), "html-to-elementor-v3-"));
      try {
        return await tryRenderWithPuppeteer(target, outputDir, userDataDir);
      } catch (puppeteerError) {
        lastError = puppeteerError;
        throw puppeteerError;
      }
    }
  } catch (error) {
    lastError = error;
    const fallback = collectFallbackNodes(resolvedSource.html);
    return {
      ...fallback,
      screenshots: {},
      viewports: CAPTURE_VIEWPORTS,
      diagnostics: buildFallbackDiagnostics(fallback.renderedHtml, lastError)
    };
  } finally {
    if (localServer) {
      await localServer.close().catch(() => undefined);
    }

    if (userDataDir) {
      await rm(userDataDir, {
        recursive: true,
        force: true,
        maxRetries: 2
      }).catch(() => undefined);
    }
  }
}
