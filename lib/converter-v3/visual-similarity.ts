import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type BrowserSessionFactory = {
  withPage: <T>(
    viewport: { width: number; height: number },
    callback: (page: any) => Promise<T>
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
};

function toDataUrlFromBuffer(buffer: Buffer, contentType = "image/png") {
  return `data:${contentType};base64,${buffer.toString("base64")}`;
}

async function readImageInputAsDataUrl(source: string) {
  if (source.startsWith("data:")) {
    return source;
  }

  const buffer = await readFile(source);
  return toDataUrlFromBuffer(buffer);
}

async function waitForStablePage(page: any) {
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
        await waitForStablePage(page);

        return (await page.screenshot({
          type: "png",
          fullPage: params.fullPage ?? true
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

      return (await page.evaluate(
        async ({
          referenceSrc,
          candidateSrc,
          similarityThreshold,
          pixelChannelTolerance
        }: {
          referenceSrc: string;
          candidateSrc: string;
          similarityThreshold: number;
          pixelChannelTolerance: number;
        }) => {
          const run = new Function(
            "referenceSrc",
            "candidateSrc",
            "similarityThreshold",
            "pixelChannelTolerance",
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
                let mismatchPixels = 0;
                const totalPixels = width * height;

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
                  }
                }

                const mismatchRatio = totalPixels === 0 ? 0 : mismatchPixels / totalPixels;
                const similarity = 1 - mismatchRatio;

                return {
                  passed: similarity >= similarityThreshold,
                  similarity,
                  mismatchRatio,
                  mismatchPixels,
                  totalPixels,
                  width,
                  height
                };
              })();
            `
          );

          return await run(
            referenceSrc,
            candidateSrc,
            similarityThreshold,
            pixelChannelTolerance
          );
        },
        {
          referenceSrc: referenceDataUrl,
          candidateSrc: candidateDataUrl,
          similarityThreshold: params.similarityThreshold,
          pixelChannelTolerance: params.pixelChannelTolerance ?? 20
        }
      )) as PixelComparisonResult;
    });
  } finally {
    await browserFactory.close().catch(() => undefined);
  }
}
