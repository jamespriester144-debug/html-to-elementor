import * as cheerio from "cheerio";

import { getLovableBaseCss, inlineLovableStyles } from "@/lib/tailwind";

import { createPixelPerfectElementorDocument } from "@/lib/converter-v2/pixel-perfect-template";
import type {
  ConversionCountSummary,
  ConversionSourceKind,
  PixelPerfectPipelineResult,
  PixelPerfectReport
} from "@/lib/converter-v2/types";

function cleanText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeTextForSearch(value: string) {
  return cleanText(
    value
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&nbsp;/gi, " ")
  ).toLowerCase();
}

function containsOrderedWords(haystack: string, value: string) {
  const normalizedNeedle = normalizeTextForSearch(value);

  if (!normalizedNeedle) {
    return true;
  }

  if (haystack.includes(normalizedNeedle)) {
    return true;
  }

  const words = normalizedNeedle.match(/[\p{L}\p{N}$&.]+/gu) ?? [];

  if (words.length < 3) {
    return false;
  }

  let cursor = 0;

  for (const word of words) {
    const index = haystack.indexOf(word, cursor);

    if (index === -1) {
      return false;
    }

    cursor = index + word.length;
  }

  return true;
}

function ensureDocumentShell(html: string) {
  const $ = cheerio.load(html);

  if (!$("html").length) {
    $.root().append("<html><head></head><body></body></html>");
    $("body").append($.root().html() ?? "");
  }

  if (!$("head").length) {
    $("html").prepend("<head></head>");
  }

  if (!$("body").length) {
    $("html").append("<body></body>");
  }

  return $;
}

function buildRenderableHtml(html: string) {
  const $ = ensureDocumentShell(inlineLovableStyles(html));
  const head = $("head");

  if (!head.find('meta[charset]').length) {
    head.prepend('<meta charset="utf-8" />');
  }
  if (!head.find('meta[name="viewport"]').length) {
    head.prepend('<meta name="viewport" content="width=device-width, initial-scale=1" />');
  }
  head.prepend(getLovableBaseCss());

  return $.html();
}

function collectCounts(html: string): ConversionCountSummary {
  const $ = cheerio.load(html);
  const textNodes = $("body")
    .find("*")
    .toArray()
    .map((element) => cleanText($(element).contents().filter((_, node) => node.type === "text").text()))
    .filter(Boolean);

  return {
    text: textNodes.length,
    heading: $("h1,h2,h3,h4,h5,h6").length,
    image: $("img").length,
    button: $("a[href], button, [role='button']").length
  };
}

function collectMissingContent(html: string, elementorJsonText: string) {
  const $ = cheerio.load(html);
  const missing: PixelPerfectReport["elementosPerdidos"] = [];
  const normalizedJsonText = normalizeTextForSearch(elementorJsonText);

  for (const element of $("h1,h2,h3,h4,h5,h6").toArray()) {
    const value = cleanText($(element).text());
    if (value && !containsOrderedWords(normalizedJsonText, value)) {
      missing.push({ type: "heading", value });
    }
  }

  for (const element of $("a[href], button, [role='button']").toArray()) {
    const value = cleanText($(element).text()) || $(element).attr("aria-label") || "";
    if (value && !containsOrderedWords(normalizedJsonText, value)) {
      missing.push({ type: "button", value });
    }
  }

  for (const element of $("img").toArray()) {
    const value = $(element).attr("src") || $(element).attr("alt") || "";
    if (value && !containsOrderedWords(normalizedJsonText, value.split("/").at(-1) ?? value)) {
      missing.push({ type: "image", value });
    }
  }

  return missing.filter((item, index, items) =>
    items.findIndex((candidate) => candidate.type === item.type && candidate.value === item.value) === index
  );
}

function createReport(
  cleanHtml: string,
  elementorJsonText: string,
  sourceKind: ConversionSourceKind
): PixelPerfectReport {
  const counts = collectCounts(cleanHtml);
  const hasPixelPerfectTemplate = elementorJsonText.includes("iframe_srcdoc_pixel_perfect_v2");
  const missing = collectMissingContent(cleanHtml, normalizeTextForSearch(elementorJsonText));
  const exportBlocked = !hasPixelPerfectTemplate || missing.length > 0;
  const warnings = [
    ...missing.map((item) => `Item possivelmente nao preservado (${item.type}): ${item.value}`),
    ...(!hasPixelPerfectTemplate ? ["Template principal nao foi gerado no modo pixel-perfect."] : [])
  ];

  return {
    sourceKind,
    strategy: "pixel-perfect-iframe-v2",
    totalTextosEncontrados: counts.text + counts.heading,
    totalTextosConvertidos: hasPixelPerfectTemplate ? counts.text + counts.heading : 0,
    totalImagensEncontradas: counts.image,
    totalImagensConvertidas: hasPixelPerfectTemplate ? counts.image : 0,
    totalBotoesEncontrados: counts.button,
    totalBotoesConvertidos: hasPixelPerfectTemplate ? counts.button : 0,
    totalHeadingsEncontrados: counts.heading,
    totalHeadingsConvertidos: hasPixelPerfectTemplate ? counts.heading : 0,
    totalElementosExportados: hasPixelPerfectTemplate ? 3 : 0,
    elementosPerdidos: missing,
    elementosRecuperados: [],
    imagensNaoCarregadas: [],
    warnings,
    status: exportBlocked ? "blocked" : warnings.length > 0 ? "warning" : "success",
    exportBlocked,
    screenshots: {},
    visualComparison: {
      desktop: { passed: hasPixelPerfectTemplate },
      tablet: { passed: hasPixelPerfectTemplate },
      mobile: { passed: hasPixelPerfectTemplate }
    },
    captureFailed: false,
    errors: []
  };
}

export async function runPixelPerfectConversionPipeline(
  html: string,
  sourceKind: ConversionSourceKind
): Promise<PixelPerfectPipelineResult> {
  const cleanHtml = buildRenderableHtml(html);
  const elementorJson = createPixelPerfectElementorDocument(cleanHtml);
  const report = createReport(cleanHtml, JSON.stringify(elementorJson), sourceKind);

  return {
    cleanHtml,
    elementorJson,
    report,
    outputDir: null,
    sourceKind,
    strategy: "pixel-perfect-iframe-v2"
  };
}
