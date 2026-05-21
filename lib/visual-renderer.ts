import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JSDOM } from "jsdom";

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
  "z-index"
];

export type BrowserRenderedPage = {
  html: string;
  title: string;
  css: string;
  computedStyleMap: Record<string, Record<string, string>>;
  layoutMap: Record<string, VisualLayoutBox>;
  renderer: "puppeteer";
};

export type VisualLayoutBox = {
  x: number;
  y: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
};

function ensureHtmlDocument(html: string): string {
  const dom = new JSDOM(inlineLovableStyles(html));
  const document = dom.window.document;

  if (!document.querySelector("meta[charset]")) {
    const meta = document.createElement("meta");
    meta.setAttribute("charset", "utf-8");
    document.head.prepend(meta);
  }

  const style = document.createElement("style");
  style.setAttribute("data-visual-renderer", "base-css");
  style.textContent = getLovableBaseCss().replace(/^<style>|<\/style>$/g, "");
  document.head.append(style);

  return dom.serialize();
}

export async function renderHtmlWithPuppeteer(
  html: string
): Promise<BrowserRenderedPage | null> {
  let browser: Awaited<ReturnType<typeof import("puppeteer").launch>> | null = null;
  let userDataDir: string | null = null;

  try {
    const puppeteer = await import("puppeteer");
    userDataDir = await mkdtemp(join(tmpdir(), "html-to-elementor-chrome-"));

    browser = await puppeteer.launch({
      headless: true,
      timeout: 8000,
      userDataDir,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const page = await browser.newPage();

    await page.setViewport({ width: 1440, height: 1200, deviceScaleFactor: 1 });
    await page.setContent(ensureHtmlDocument(html), {
      waitUntil: "domcontentloaded",
      timeout: 20000
    });
    await page
      .waitForNetworkIdle({ idleTime: 500, timeout: 5000 })
      .catch(() => undefined);
    await page.evaluate(() => document.fonts?.ready);

    return await page.evaluate((properties) => {
      const computedStyleMap: Record<string, Record<string, string>> = {};
      const layoutMap: Record<string, VisualLayoutBox> = {};
      const elements = Array.from(document.body.querySelectorAll<HTMLElement>("*"));

      elements.forEach((element, index) => {
        const visualId = element.getAttribute("data-visual-id") || `browser-node-${index + 1}`;
        const computed = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const styles: Record<string, string> = {};

        element.setAttribute("data-visual-id", visualId);

        for (const property of properties) {
          const value = computed.getPropertyValue(property);

          if (value) {
            styles[property] = value.trim();
          }
        }

        computedStyleMap[visualId] = styles;
        layoutMap[visualId] = {
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
        };
        element.setAttribute("data-visual-order", String(index + 1));
        element.setAttribute("data-layout-x", String(Math.round(rect.x * 100) / 100));
        element.setAttribute("data-layout-y", String(Math.round(rect.y * 100) / 100));
        element.setAttribute("data-layout-width", String(Math.round(rect.width * 100) / 100));
        element.setAttribute("data-layout-height", String(Math.round(rect.height * 100) / 100));
        element.setAttribute(
          "data-layout-align",
          rect.left + rect.width / 2 < window.innerWidth * 0.4
            ? "left"
            : rect.left + rect.width / 2 > window.innerWidth * 0.6
              ? "right"
              : "center"
        );

        if (/^H[1-6]$/.test(element.tagName)) {
          element.setAttribute("data-visual-heading-level", element.tagName.toLowerCase());
          element.setAttribute("data-computed-font-size", styles["font-size"] || "");
          element.setAttribute("data-computed-line-height", styles["line-height"] || "");
          element.setAttribute("data-computed-font-weight", styles["font-weight"] || "");
          element.setAttribute("data-computed-margin", styles.margin || "");
        }

        if (element instanceof HTMLImageElement || element.tagName === "PICTURE") {
          const parent = element.closest<HTMLElement>(
            "article,section,header,footer,main,nav,[data-card],.card,[class*='card']"
          );
          const headings = Array.from(
            (parent || document.body).querySelectorAll<HTMLHeadingElement>(
              "h1,h2,h3,h4,h5,h6"
            )
          );
          const imageRect = element.getBoundingClientRect();
          const closest = headings
            .map((heading) => {
              const rect = heading.getBoundingClientRect();
              const distance =
                Math.abs(rect.top - imageRect.top) + Math.abs(rect.left - imageRect.left);

              return { heading, distance };
            })
            .sort((left, right) => left.distance - right.distance)[0]?.heading;

          element.setAttribute("data-visual-parent-id", parent?.getAttribute("data-visual-id") || "");
          element.setAttribute("data-nearest-heading", closest?.textContent?.trim() || "");
          element.setAttribute("data-computed-object-fit", styles["object-fit"] || "");
          element.setAttribute("data-computed-object-position", styles["object-position"] || "");

          if (element instanceof HTMLImageElement) {
            const signature = `${element.alt} ${element.className} ${parent?.className || ""}`.toLowerCase();
            const naturalWidth = element.naturalWidth || Number(element.getAttribute("width")) || rect.width;
            const naturalHeight = element.naturalHeight || Number(element.getAttribute("height")) || rect.height;
            const aspectRatio = naturalWidth && naturalHeight ? naturalWidth / naturalHeight : 0;
            const isCard = signature.includes("card") || parent?.matches("article,.card,[class*='card']");
            const isBanner = signature.includes("banner") || signature.includes("hero") || aspectRatio >= 2.2;
            const isLogo =
              signature.includes("logo") ||
              signature.includes("brand") ||
              (!isCard && !isBanner && rect.height <= 80);

            element.setAttribute("data-natural-width", String(Math.round(naturalWidth * 100) / 100));
            element.setAttribute("data-natural-height", String(Math.round(naturalHeight * 100) / 100));
            element.setAttribute("data-aspect-ratio", aspectRatio ? String(Math.round(aspectRatio * 10000) / 10000) : "");
            element.setAttribute(
              "data-image-kind",
              isLogo ? "logo" : isBanner ? "banner" : isCard ? "card" : "content"
            );
          }
        }

        element.setAttribute(
          "style",
          Object.entries(styles)
            .map(([property, value]) => `${property}:${value}`)
            .join(";")
        );
      });

      const css = Array.from(document.querySelectorAll("style"))
        .map((style) => style.textContent || "")
        .filter(Boolean)
        .join("\n");

      return {
        html: document.documentElement.outerHTML,
        title: document.title || "Elementor Page",
        css,
        computedStyleMap,
        layoutMap,
        renderer: "puppeteer" as const
      };
    }, computedStyleProperties);
  } catch (error) {
    console.warn("Puppeteer visual render failed, using server parser fallback.", error);
    return null;
  } finally {
    await browser?.close();
    if (userDataDir) {
      await rm(userDataDir, { recursive: true, force: true, maxRetries: 2 }).catch(
        () => undefined
      );
    }
  }
}
