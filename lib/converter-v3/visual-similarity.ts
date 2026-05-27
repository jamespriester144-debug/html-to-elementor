import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BrowserPage } from "@/lib/converter-v3/browser-page";
import { installBrowserEvalShim } from "@/lib/converter-v3/browser-eval-shim";
import { preparePageForVisualCapture } from "@/lib/converter-v3/visual-capture-stability";

type BrowserSessionFactory = {
  withPage: <T>(
    viewport: { width: number; height: number },
    callback: (page: BrowserPage) => Promise<T>
  ) => Promise<T>;
  close: () => Promise<void>;
};

export type PixelComparisonResult = {
  passed: boolean;
  similarity: number;
  mismatchRatio: number;
  mismatchPixels: number;
  totalPixels: number;
  width: number;
  height: number;
  dimensionsDiffer: boolean;
  mismatchBounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  diffOutputPath?: string;
};

export type ParsedCssColor = {
  r: number;
  g: number;
  b: number;
  a: number;
};

export const VISUAL_DOMINANT_COLOR_CRITICAL_DISTANCE = 95;
export const VISUAL_DOMINANT_COLOR_BLOCKING_DISTANCE = 150;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function splitFunctionalColorArgs(value: string) {
  return value
    .replace(/\s*\/\s*/g, ",")
    .replace(/\s*,\s*/g, ",")
    .trim()
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function parsePercentChannel(value: string) {
  const normalized = value.trim();

  if (normalized.endsWith("%")) {
    return clamp((Number.parseFloat(normalized) / 100) * 255, 0, 255);
  }

  return clamp(Number.parseFloat(normalized), 0, 255);
}

function hueToRgb(p: number, q: number, t: number) {
  let nextT = t;

  if (nextT < 0) nextT += 1;
  if (nextT > 1) nextT -= 1;
  if (nextT < 1 / 6) return p + (q - p) * 6 * nextT;
  if (nextT < 1 / 2) return q;
  if (nextT < 2 / 3) return p + (q - p) * (2 / 3 - nextT) * 6;
  return p;
}

function hslToRgb(h: number, s: number, l: number) {
  const hue = (((h % 360) + 360) % 360) / 360;
  const saturation = clamp(s, 0, 100) / 100;
  const lightness = clamp(l, 0, 100) / 100;

  if (saturation === 0) {
    const value = Math.round(lightness * 255);
    return { r: value, g: value, b: value };
  }

  const q =
    lightness < 0.5
      ? lightness * (1 + saturation)
      : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;

  return {
    r: Math.round(hueToRgb(p, q, hue + 1 / 3) * 255),
    g: Math.round(hueToRgb(p, q, hue) * 255),
    b: Math.round(hueToRgb(p, q, hue - 1 / 3) * 255)
  };
}

export function parseCssColor(value?: string): ParsedCssColor | undefined {
  const normalized = (value ?? "").trim().toLowerCase();

  if (!normalized || normalized === "transparent" || normalized === "none") {
    return undefined;
  }

  if (normalized.startsWith("#")) {
    const hex = normalized.slice(1);

    if (hex.length === 3 || hex.length === 4) {
      const [r, g, b, a = "f"] = hex.split("");
      return {
        r: Number.parseInt(`${r}${r}`, 16),
        g: Number.parseInt(`${g}${g}`, 16),
        b: Number.parseInt(`${b}${b}`, 16),
        a: Number.parseInt(`${a}${a}`, 16) / 255
      };
    }

    if (hex.length === 6 || hex.length === 8) {
      return {
        r: Number.parseInt(hex.slice(0, 2), 16),
        g: Number.parseInt(hex.slice(2, 4), 16),
        b: Number.parseInt(hex.slice(4, 6), 16),
        a: hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1
      };
    }
  }

  const rgbMatch = normalized.match(/^rgba?\((.+)\)$/i);

  if (rgbMatch) {
    const parts = splitFunctionalColorArgs(rgbMatch[1]);

    if (parts.length >= 3) {
      return {
        r: Math.round(parsePercentChannel(parts[0])),
        g: Math.round(parsePercentChannel(parts[1])),
        b: Math.round(parsePercentChannel(parts[2])),
        a: parts[3] !== undefined ? clamp(Number.parseFloat(parts[3]), 0, 1) : 1
      };
    }
  }

  const hslMatch = normalized.match(/^hsla?\((.+)\)$/i);

  if (hslMatch) {
    const parts = splitFunctionalColorArgs(hslMatch[1]);

    if (parts.length >= 3) {
      const hue = Number.parseFloat(parts[0]);
      const saturation = Number.parseFloat(parts[1]);
      const lightness = Number.parseFloat(parts[2]);
      const rgb = hslToRgb(hue, saturation, lightness);

      return {
        ...rgb,
        a: parts[3] !== undefined ? clamp(Number.parseFloat(parts[3]), 0, 1) : 1
      };
    }
  }

  return undefined;
}

export function toCssColor(color?: ParsedCssColor) {
  if (!color) {
    return undefined;
  }

  return color.a < 1
    ? `rgba(${color.r}, ${color.g}, ${color.b}, ${Number.parseFloat(color.a.toFixed(3))})`
    : `rgb(${color.r}, ${color.g}, ${color.b})`;
}

export function relativeLuminance(color: ParsedCssColor) {
  const channels = [color.r, color.g, color.b].map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function resolveColorValue(color?: string | ParsedCssColor) {
  if (!color) {
    return undefined;
  }

  return typeof color === "string" ? parseCssColor(color) : color;
}

export function colorDistance(
  left?: string | ParsedCssColor,
  right?: string | ParsedCssColor
) {
  const resolvedLeft = resolveColorValue(left);
  const resolvedRight = resolveColorValue(right);

  if (!resolvedLeft || !resolvedRight) {
    return undefined;
  }

  const redDelta = resolvedLeft.r - resolvedRight.r;
  const greenDelta = resolvedLeft.g - resolvedRight.g;
  const blueDelta = resolvedLeft.b - resolvedRight.b;

  return Number.parseFloat(
    Math.sqrt(redDelta ** 2 + greenDelta ** 2 + blueDelta ** 2).toFixed(2)
  );
}

export function resolveDominantColorMismatchSeverity(distance?: number) {
  if (typeof distance !== "number") {
    return undefined;
  }

  if (distance >= VISUAL_DOMINANT_COLOR_BLOCKING_DISTANCE) {
    return "blocking" as const;
  }

  if (distance >= VISUAL_DOMINANT_COLOR_CRITICAL_DISTANCE) {
    return "critical" as const;
  }

  return undefined;
}

export function isClearlyLightColor(
  value?: string | ParsedCssColor,
  threshold = 0.72
) {
  const color = resolveColorValue(value);
  return Boolean(color && relativeLuminance(color) >= threshold);
}

export function isClearlyDarkColor(
  value?: string | ParsedCssColor,
  threshold = 0.32
) {
  const color = resolveColorValue(value);
  return Boolean(color && relativeLuminance(color) <= threshold);
}

function toDataUrlFromBuffer(buffer: Uint8Array, contentType = "image/png") {
  return `data:${contentType};base64,${Buffer.from(buffer).toString("base64")}`;
}

async function readImageInputAsDataUrl(source: string) {
  if (source.startsWith("data:")) {
    return source;
  }

  const buffer = await readFile(source);
  return toDataUrlFromBuffer(buffer);
}

export async function readImageDimensions(source: string) {
  const browserFactory = await createBrowserFactory();

  try {
    const imageDataUrl = await readImageInputAsDataUrl(source);

    return await browserFactory.withPage({ width: 16, height: 16 }, async (page) => {
      await page.setContent(
        "<!doctype html><html><head><meta charset='utf-8' /></head><body></body></html>",
        {
          waitUntil: "domcontentloaded",
          timeout: 20000
        }
      );
      await installBrowserEvalShim(page);

      return page.evaluate(async (imageSrc: string) => {
        const image = (await new Promise((resolve, reject) => {
          const nextImage = new Image();
          nextImage.onload = () => resolve(nextImage);
          nextImage.onerror = () => reject(new Error("Unable to load image for dimensions."));
          nextImage.src = imageSrc;
        })) as HTMLImageElement;

        return {
          width: Math.max(image.width, 1),
          height: Math.max(image.height, 1)
        };
      }, imageDataUrl);
    });
  } finally {
    await browserFactory.close().catch(() => undefined);
  }
}

async function createPlaywrightFactory(): Promise<BrowserSessionFactory> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    headless: true,
    timeout: 10000,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  return {
    withPage: async (viewport, callback) => {
      const context = await browser.newContext({
        viewport,
        deviceScaleFactor: 1
      });
      const page = await context.newPage();

      try {
        return await callback(page);
      } finally {
        await page.close().catch(() => undefined);
        await context.close().catch(() => undefined);
      }
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
    withPage: async (viewport, callback) => {
      const page = await browser.newPage();
      await page.setViewport({
        ...viewport,
        deviceScaleFactor: 1
      });

      try {
        return await callback(page);
      } finally {
        await page.close().catch(() => undefined);
      }
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
    let lastError: unknown;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      userDataDir = await mkdtemp(join(tmpdir(), "html-to-elementor-visual-"));

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
        lastError = error;

        if (userDataDir) {
          await rm(userDataDir, {
            recursive: true,
            force: true,
            maxRetries: 2
          }).catch(() => undefined);
        }
      }
    }

    throw lastError;
  }
}

export async function renderHtmlToScreenshot(params: {
  html: string;
  viewportWidth: number;
  viewportHeight: number;
  outputPath?: string;
  fullPage?: boolean;
}) {
  const browserFactory = await createBrowserFactory();

  try {
    const buffer = await browserFactory.withPage(
      {
        width: Math.max(Math.ceil(params.viewportWidth), 1),
        height: Math.max(Math.ceil(params.viewportHeight), 1)
      },
      async (page) => {
        await page.setContent(params.html, {
          waitUntil: "domcontentloaded",
          timeout: 20000
        });
        await installBrowserEvalShim(page);
        await preparePageForVisualCapture(page, {
          timeoutMs: 15000,
          scrollEntirePage: true
        });

        return (await page.screenshot({
          type: "png",
          fullPage: params.fullPage ?? true,
          scale: "css"
        })) as Buffer;
      }
    );

    if (params.outputPath) {
      await writeFile(params.outputPath, buffer);
    }

    return {
      dataUrl: toDataUrlFromBuffer(buffer),
      outputPath: params.outputPath
    };
  } finally {
    await browserFactory.close().catch(() => undefined);
  }
}

export async function compareImagesPixelByPixel(params: {
  reference: string;
  candidate: string;
  similarityThreshold: number;
  pixelChannelTolerance?: number;
  diffOutputPath?: string;
}) {
  const browserFactory = await createBrowserFactory();

  try {
    const referenceDataUrl = await readImageInputAsDataUrl(params.reference);
    const candidateDataUrl = await readImageInputAsDataUrl(params.candidate);

    return await browserFactory.withPage({ width: 32, height: 32 }, async (page) => {
      await page.setContent(
        "<!doctype html><html><head><meta charset='utf-8' /></head><body></body></html>",
        {
          waitUntil: "domcontentloaded",
          timeout: 20000
        }
      );
      await installBrowserEvalShim(page);

      const comparison = (await page.evaluate(
        async ({
          referenceSrc,
          candidateSrc,
          similarityThreshold,
          pixelChannelTolerance,
          withDiff
        }: {
          referenceSrc: string;
          candidateSrc: string;
          similarityThreshold: number;
          pixelChannelTolerance: number;
          withDiff: boolean;
        }) => {
          const run = new Function(
            "referenceSrc",
            "candidateSrc",
            "similarityThreshold",
            "pixelChannelTolerance",
            "withDiff",
            `
              return (async () => {
                const referenceImage = await new Promise((resolve, reject) => {
                  const image = new Image();
                  image.onload = () => resolve(image);
                  image.onerror = () => reject(new Error("Unable to load reference image."));
                  image.src = referenceSrc;
                });
                const candidateImage = await new Promise((resolve, reject) => {
                  const image = new Image();
                  image.onload = () => resolve(image);
                  image.onerror = () => reject(new Error("Unable to load candidate image."));
                  image.src = candidateSrc;
                });
                const width = Math.max(referenceImage.width, candidateImage.width, 1);
                const height = Math.max(referenceImage.height, candidateImage.height, 1);
                const referenceCanvas = document.createElement("canvas");
                const candidateCanvas = document.createElement("canvas");
                referenceCanvas.width = width;
                referenceCanvas.height = height;
                candidateCanvas.width = width;
                candidateCanvas.height = height;
                const referenceContext = referenceCanvas.getContext("2d");
                const candidateContext = candidateCanvas.getContext("2d");

                if (!referenceContext || !candidateContext) {
                  throw new Error("Canvas 2D context unavailable.");
                }

                referenceContext.fillStyle = "#ffffff";
                referenceContext.fillRect(0, 0, width, height);
                referenceContext.drawImage(referenceImage, 0, 0);

                candidateContext.fillStyle = "#ffffff";
                candidateContext.fillRect(0, 0, width, height);
                candidateContext.drawImage(candidateImage, 0, 0);

                const referenceData = referenceContext.getImageData(0, 0, width, height).data;
                const candidateData = candidateContext.getImageData(0, 0, width, height).data;
                const diffCanvas = withDiff ? document.createElement("canvas") : null;
                const diffContext = diffCanvas ? diffCanvas.getContext("2d") : null;
                const diffImageData = diffContext ? diffContext.createImageData(width, height) : null;
                let mismatchPixels = 0;
                const totalPixels = width * height;
                let minX = width;
                let minY = height;
                let maxX = -1;
                let maxY = -1;

                for (let index = 0; index < referenceData.length; index += 4) {
                  const redDiff = Math.abs(referenceData[index] - candidateData[index]);
                  const greenDiff = Math.abs(referenceData[index + 1] - candidateData[index + 1]);
                  const blueDiff = Math.abs(referenceData[index + 2] - candidateData[index + 2]);
                  const alphaDiff = Math.abs(referenceData[index + 3] - candidateData[index + 3]);
                  const isDifferent =
                    redDiff > pixelChannelTolerance ||
                    greenDiff > pixelChannelTolerance ||
                    blueDiff > pixelChannelTolerance ||
                    alphaDiff > pixelChannelTolerance;

                  if (isDifferent) {
                    mismatchPixels += 1;
                    const pixelIndex = index / 4;
                    const x = pixelIndex % width;
                    const y = Math.floor(pixelIndex / width);
                    minX = Math.min(minX, x);
                    minY = Math.min(minY, y);
                    maxX = Math.max(maxX, x);
                    maxY = Math.max(maxY, y);
                  }

                  if (diffImageData) {
                    diffImageData.data[index] = isDifferent ? 255 : 255;
                    diffImageData.data[index + 1] = isDifferent ? 0 : 255;
                    diffImageData.data[index + 2] = isDifferent ? 0 : 255;
                    diffImageData.data[index + 3] = 255;
                  }
                }

                const mismatchRatio = totalPixels === 0 ? 0 : mismatchPixels / totalPixels;
                const similarity = 1 - mismatchRatio;
                const mismatchBounds =
                  maxX >= minX && maxY >= minY
                    ? {
                        x: minX,
                        y: minY,
                        width: maxX - minX + 1,
                        height: maxY - minY + 1
                      }
                    : undefined;

                if (diffCanvas && diffContext && diffImageData) {
                  diffCanvas.width = width;
                  diffCanvas.height = height;
                  diffContext.putImageData(diffImageData, 0, 0);
                }

                return {
                  passed: similarity >= similarityThreshold,
                  similarity,
                  mismatchRatio,
                  mismatchPixels,
                  totalPixels,
                  width,
                  height,
                  dimensionsDiffer:
                    referenceImage.width !== candidateImage.width ||
                    referenceImage.height !== candidateImage.height,
                  mismatchBounds,
                  diffDataUrl: diffCanvas ? diffCanvas.toDataURL("image/png") : undefined
                };
              })();
            `
          );

          return await run(
            referenceSrc,
            candidateSrc,
            similarityThreshold,
            pixelChannelTolerance,
            withDiff
          );
        },
        {
          referenceSrc: referenceDataUrl,
          candidateSrc: candidateDataUrl,
          similarityThreshold: params.similarityThreshold,
          pixelChannelTolerance: params.pixelChannelTolerance ?? 20,
          withDiff: Boolean(params.diffOutputPath)
        }
      )) as PixelComparisonResult & { diffDataUrl?: string };

      if (params.diffOutputPath && comparison.diffDataUrl) {
        const buffer = Buffer.from(
          comparison.diffDataUrl.replace(/^data:image\/png;base64,/, ""),
          "base64"
        );
        await writeFile(params.diffOutputPath, buffer);
      }

      return {
        ...comparison,
        diffOutputPath: params.diffOutputPath
      };
    });
  } finally {
    await browserFactory.close().catch(() => undefined);
  }
}
