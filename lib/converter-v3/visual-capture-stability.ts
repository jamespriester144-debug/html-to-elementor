import type { BrowserPage } from "@/lib/converter-v3/browser-page";

type VisualCapturePreparationOptions = {
  timeoutMs?: number;
  scrollEntirePage?: boolean;
};

const DEFAULT_TIMEOUT_MS = 10000;

async function waitForBrowserSignals(page: BrowserPage, timeoutMs: number) {
  await page.setJavaScriptEnabled?.(true).catch(() => undefined);
  await page.waitForSelector?.("body", { timeout: timeoutMs }).catch(() => undefined);
  await page.waitForLoadState?.("domcontentloaded", { timeout: timeoutMs }).catch(() => undefined);
  await page.waitForLoadState?.("load", { timeout: timeoutMs }).catch(() => undefined);
  await page.waitForLoadState?.("networkidle", { timeout: timeoutMs }).catch(() => undefined);
  await page.waitForNetworkIdle?.({ idleTime: 750, timeout: timeoutMs }).catch(() => undefined);
}

export async function preparePageForVisualCapture(
  page: BrowserPage,
  options: VisualCapturePreparationOptions = {}
) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  await waitForBrowserSignals(page, timeoutMs);
  await page
    .evaluate(
      async ({
        timeoutMs,
        scrollEntirePage
      }: {
        timeoutMs: number;
        scrollEntirePage: boolean;
      }) => {
        const styleId = "converter-v3-visual-capture-lock";

        if (!document.getElementById(styleId)) {
          const style = document.createElement("style");
          style.id = styleId;
          style.textContent = `
            *,
            *::before,
            *::after {
              animation: none !important;
              transition: none !important;
              caret-color: transparent !important;
              scroll-behavior: auto !important;
            }
          `;
          document.head.appendChild(style);
        }

        const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
        const now = () => Date.now();
        const deadline = now() + timeoutMs;

        const boostLazyAssets = () => {
          Array.from(document.querySelectorAll<HTMLElement>("img,iframe,video,source")).forEach(
            (element) => {
              if ("loading" in element) {
                try {
                  (element as HTMLImageElement & { loading?: string }).loading = "eager";
                } catch {}
              }

              if ("decoding" in element) {
                try {
                  (element as HTMLImageElement & { decoding?: string }).decoding = "sync";
                } catch {}
              }

              const eagerSrc =
                element.getAttribute("data-src") ||
                element.getAttribute("data-lazy-src") ||
                element.getAttribute("data-original") ||
                element.getAttribute("data-url");
              const eagerSrcset =
                element.getAttribute("data-srcset") ||
                element.getAttribute("data-lazy-srcset");

              if (eagerSrc && !element.getAttribute("src")) {
                element.setAttribute("src", eagerSrc);
              }

              if (eagerSrcset && !element.getAttribute("srcset")) {
                element.setAttribute("srcset", eagerSrcset);
              }
            }
          );
        };

        const waitForFonts = async () => {
          try {
            if (!document.fonts?.ready) {
              return;
            }

            await Promise.race([
              document.fonts.ready,
              wait(Math.min(timeoutMs, 5000))
            ]);
          } catch {}
        };

        const scrollThroughPage = async () => {
          const root = document.documentElement;
          const totalHeight = Math.max(
            root?.scrollHeight ?? 0,
            document.body?.scrollHeight ?? 0,
            window.innerHeight
          );
          const step = Math.max(Math.floor(window.innerHeight * 0.75), 200);

          for (let y = 0; y < totalHeight; y += step) {
            window.scrollTo(0, y);
            await wait(60);
          }

          window.scrollTo(0, totalHeight);
          await wait(120);
          window.scrollTo(0, 0);
          await wait(120);
        };

        const waitForImages = async () => {
          while (now() < deadline) {
            const pendingImages = Array.from(document.images).filter(
              (image) => !image.complete || image.naturalWidth <= 0
            );

            if (!pendingImages.length) {
              return;
            }

            await wait(120);
          }
        };

        boostLazyAssets();
        await waitForFonts();

        if (scrollEntirePage) {
          await scrollThroughPage();
        }

        boostLazyAssets();
        await waitForImages();
        await waitForFonts();
      },
      {
        timeoutMs,
        scrollEntirePage: options.scrollEntirePage ?? true
      }
    )
    .catch(() => undefined);
  await waitForBrowserSignals(page, timeoutMs);
  await page.evaluate(() => document.fonts?.ready).catch(() => undefined);
}
