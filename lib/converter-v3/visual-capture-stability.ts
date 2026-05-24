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
            html {
              cursor: default !important;
            }

            *,
            *::before,
            *::after {
              animation: none !important;
              transition: none !important;
              caret-color: transparent !important;
              scroll-behavior: auto !important;
              cursor: default !important;
            }

            *:focus,
            *:focus-visible,
            *:active {
              outline: none !important;
              box-shadow: none !important;
            }

            *::selection {
              background: transparent !important;
              color: inherit !important;
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

        const freezeInteractiveMedia = () => {
          Array.from(document.querySelectorAll<HTMLVideoElement>("video")).forEach((video) => {
            try {
              video.pause();
              video.autoplay = false;
              video.loop = false;
              video.currentTime = 0;
              video.muted = true;
              video.removeAttribute("autoplay");
            } catch {}
          });

          Array.from(document.querySelectorAll<HTMLAudioElement>("audio")).forEach((audio) => {
            try {
              audio.pause();
              audio.autoplay = false;
              audio.loop = false;
              audio.muted = true;
              audio.removeAttribute("autoplay");
            } catch {}
          });

          document.activeElement instanceof HTMLElement
            ? document.activeElement.blur()
            : undefined;
          window.getSelection?.()?.removeAllRanges?.();
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

        const waitForBackgroundImages = async () => {
          const urls = Array.from(document.querySelectorAll<HTMLElement>("*"))
            .flatMap((element) => {
              const computed = window.getComputedStyle(element);
              const backgroundImage = computed.backgroundImage || "";
              return Array.from(backgroundImage.matchAll(/url\((['"]?)(.*?)\1\)/gi)).map(
                (match) => match[2]
              );
            })
            .filter((url) => Boolean(url) && !url.startsWith("data:"));

          const uniqueUrls = [...new Set(urls)];

          await Promise.allSettled(
            uniqueUrls.map(
              (url) =>
                new Promise<void>((resolve) => {
                  const image = new Image();
                  image.onload = () => resolve();
                  image.onerror = () => resolve();
                  image.src = url;
                })
            )
          );
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

        const hasMeaningfulContent = () => {
          const candidates = Array.from(document.body.querySelectorAll<HTMLElement>("*")).filter(
            (element) => {
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
                (text.length > 0 ||
                  element.tagName === "IMG" ||
                  element.tagName === "SVG" ||
                  element.tagName === "PICTURE" ||
                  element.tagName === "CANVAS" ||
                  element.tagName === "VIDEO" ||
                  element.tagName === "IFRAME" ||
                  element.tagName === "BUTTON" ||
                  (element.tagName === "A" && Boolean(element.getAttribute("href"))) ||
                  backgroundImage !== "none") &&
                (rect.width > 0 || rect.height > 0)
              );
            }
          );

          return candidates.length > 0;
        };

        const waitForMeaningfulContent = async () => {
          while (now() < deadline) {
            if (hasMeaningfulContent()) {
              return;
            }

            await wait(120);
          }
        };

        boostLazyAssets();
        freezeInteractiveMedia();
        await waitForFonts();
        await waitForBackgroundImages();

        if (scrollEntirePage) {
          await scrollThroughPage();
        }

        boostLazyAssets();
        freezeInteractiveMedia();
        await waitForImages();
        await waitForMeaningfulContent();
        await waitForBackgroundImages();
        await waitForFonts();
        await wait(120);
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
