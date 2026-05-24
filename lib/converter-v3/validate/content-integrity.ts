import { access } from "node:fs/promises";

import * as cheerio from "cheerio";

import type { PageCapture } from "@/lib/converter-v3/contracts/capture";
import type { LayoutDocument, OutputMode } from "@/lib/converter-v3/contracts/layout";
import type {
  ContentIntegrityReport,
  SnapshotVisualSummary,
  UniversalVisualMode
} from "@/lib/converter-v3/contracts/output";
import { isForceVisualSnapshotEnabled } from "@/lib/env";
import type { ElementorDocument, ElementorElement } from "@/types/conversion";
import { readImageDimensions } from "@/lib/converter-v3/visual-similarity";

type OriginalMetrics = {
  textCount: number;
  imageCount: number;
  buttonCount: number;
  linkCount: number;
  sectionCount: number;
  visibleHeight: number;
  visibleContentDetected: boolean;
};

type ConvertedMetrics = {
  textCount: number;
  imageCount: number;
  buttonCount: number;
  linkCount: number;
  sectionCount: number;
  visibleHeight: number;
  visibleContentDetected: boolean;
  convertedBodyEmpty: boolean;
  hasRealWidgets: boolean;
  snapshotGenerated: boolean;
  overlaysGenerated: boolean;
  visualEmbeds: number;
};

type ValidateContentIntegrityParams = {
  capture: PageCapture;
  layout: LayoutDocument;
  document: ElementorDocument;
  emittedMode: OutputMode;
  previewHtml?: string;
  snapshot?: SnapshotVisualSummary;
  outputFile: string;
  failureStage?: string;
};

function normalizeText(value: string | undefined) {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeImageToken(value: string | undefined) {
  return (value ?? "").replace(/^url\((['"]?)(.*?)\1\)$/i, "$2").trim();
}

function resolveModeUsed(
  emittedMode: OutputMode,
  snapshot?: SnapshotVisualSummary
): UniversalVisualMode {
  if (emittedMode === "snapshot") {
    return snapshot?.renderStrategy === "full-page-snapshot"
      ? "full-page-snapshot"
      : "section-snapshot";
  }

  if (
    emittedMode === "editable" ||
    emittedMode === "hybrid" ||
    emittedMode === "pixel-perfect"
  ) {
    return emittedMode;
  }

  return "editable";
}

function collectOriginalMetrics(capture: PageCapture, layout: LayoutDocument): OriginalMetrics {
  const visibleNodes = capture.nodes.filter(
    (node) =>
      node.isVisible &&
      node.tag !== "script" &&
      node.tag !== "style" &&
      node.tag !== "noscript"
  );
  const textCount = visibleNodes.filter((node) => normalizeText(node.text).length > 0).length;
  const imageCount = visibleNodes.filter(
    (node) =>
      Boolean(normalizeImageToken(node.asset.src)) ||
      Boolean(normalizeImageToken(node.asset.backgroundImage)) ||
      node.tag === "svg" ||
      node.tag === "picture"
  ).length;
  const buttonCount = visibleNodes.filter(
    (node) =>
      node.tag === "button" ||
      node.attributes.role === "button" ||
      (node.tag === "a" && Boolean(node.attributes.href))
  ).length;
  const linkCount = visibleNodes.filter(
    (node) => node.tag === "a" && Boolean(node.attributes.href)
  ).length;
  const sectionCount = layout.detectedSections.length || layout.sectionIds.length;
  const maxNodeBottom = visibleNodes.reduce(
    (max, node) => Math.max(max, node.box?.bottom ?? 0),
    0
  );
  const screenshotHeight = capture.nodes[0]?.viewportStates.desktop?.box?.height ?? 0;
  const visibleHeight = Math.max(
    Math.round(maxNodeBottom),
    capture.inputAnalysis.structure.realSectionCount > 0 ? screenshotHeight : 0
  );

  return {
    textCount,
    imageCount,
    buttonCount,
    linkCount,
    sectionCount,
    visibleHeight,
    visibleContentDetected:
      textCount > 0 || imageCount > 0 || buttonCount > 0 || linkCount > 0 || visibleHeight > 80
  };
}

function countHtmlWidgetContent(html: string) {
  const $ = cheerio.load(html);
  const textCount = $("h1,h2,h3,h4,h5,h6,p,span,small,strong,em,label,li,blockquote")
    .toArray()
    .filter((element) => normalizeText($(element).text()).length > 0).length;
  const imageCount =
    $("img,picture,svg").length +
    $("[style*='background-image' i]")
      .toArray()
      .filter((element) => /background-image\s*:/i.test($(element).attr("style") ?? "")).length;
  const buttonCount =
    $("button,[role='button'],input[type='button'],input[type='submit']").length +
    $("a[href]").toArray().filter((element) => normalizeText($(element).text()).length > 0).length;
  const linkCount = $("a[href]").length;
  const iframeCount = $("iframe").length;
  const snapshotGenerated =
    $(".converter-v3-snapshot-section,.converter-v3-snapshot-stage,.converter-v3-snapshot-image")
      .length > 0;
  const overlaysGenerated =
    $(".converter-v3-snapshot-link,[data-converter-v3-snapshot-section]").length > 0;

  return {
    textCount,
    imageCount,
    buttonCount,
    linkCount,
    iframeCount,
    snapshotGenerated,
    overlaysGenerated
  };
}

function collectConvertedMetrics(
  document: ElementorDocument,
  layout: LayoutDocument,
  snapshot: SnapshotVisualSummary | undefined
): ConvertedMetrics {
  let textCount = 0;
  let imageCount = 0;
  let buttonCount = 0;
  let linkCount = 0;
  let sectionCount = 0;
  let hasRealWidgets = false;
  let snapshotGenerated = snapshot?.totals.snapshotSections
    ? snapshot.totals.snapshotSections > 0
    : false;
  let overlaysGenerated = snapshot?.totals.preservedLinks
    ? snapshot.totals.preservedLinks > 0
    : false;
  let visualEmbeds = 0;
  const contributingNodeIds = new Set<string>();

  const visit = (element: ElementorElement) => {
    if (element.elType === "section" || element.elType === "container") {
      if (element.elements.length > 0 || Object.keys(element.settings ?? {}).length > 0) {
        sectionCount += 1;
      }
    }

    const sourceNodeId = element.settings?.converter_v3_source_node_id;
    if (typeof sourceNodeId === "string" && sourceNodeId.trim()) {
      contributingNodeIds.add(sourceNodeId.trim());
    }

    if (element.elType === "widget") {
      hasRealWidgets = true;
    }

    if (element.widgetType === "heading") {
      if (normalizeText(String(element.settings?.title ?? "")).length > 0) {
        textCount += 1;
        hasRealWidgets = true;
      }
    }

    if (element.widgetType === "text-editor") {
      if (normalizeText(String(element.settings?.editor ?? "")).length > 0) {
        textCount += 1;
        hasRealWidgets = true;
      }
    }

    if (element.widgetType === "blockquote") {
      if (normalizeText(String(element.settings?.blockquote_content ?? "")).length > 0) {
        textCount += 1;
        hasRealWidgets = true;
      }
    }

    if (element.widgetType === "icon-list") {
      const items = (element.settings?.icon_list as Array<{ text?: string }> | undefined) ?? [];
      textCount += items.filter((item) => normalizeText(item.text).length > 0).length;
      hasRealWidgets ||= items.length > 0;
    }

    if (element.widgetType === "accordion") {
      const tabs =
        (element.settings?.tabs as Array<{ tab_title?: string; tab_content?: string }> | undefined) ??
        [];
      textCount += tabs.filter(
        (tab) =>
          normalizeText(tab.tab_title).length > 0 || normalizeText(tab.tab_content).length > 0
      ).length;
      hasRealWidgets ||= tabs.length > 0;
    }

    if (element.widgetType === "button") {
      const buttonText = normalizeText(String(element.settings?.text ?? ""));
      const link = element.settings?.link as { url?: string } | undefined;
      if (buttonText || link?.url?.trim()) {
        buttonCount += 1;
        hasRealWidgets = true;
      }
      if (buttonText) {
        textCount += 1;
      }
      if (link?.url?.trim()) {
        linkCount += 1;
      }
    }

    if (element.widgetType === "image") {
      const image = element.settings?.image as { url?: string } | undefined;
      if (normalizeImageToken(image?.url)) {
        imageCount += 1;
        hasRealWidgets = true;
      }
    }

    const backgroundImage = normalizeImageToken(
      (element.settings?.background_image as { url?: string } | undefined)?.url
    );
    if (backgroundImage) {
      imageCount += 1;
    }

    if (element.widgetType === "html") {
      const html = String(element.settings?.html ?? "");
      const htmlMetrics = countHtmlWidgetContent(html);
      textCount += htmlMetrics.textCount;
      imageCount += htmlMetrics.imageCount;
      buttonCount += htmlMetrics.buttonCount;
      linkCount += htmlMetrics.linkCount;
      visualEmbeds += htmlMetrics.iframeCount;
      snapshotGenerated ||= htmlMetrics.snapshotGenerated;
      overlaysGenerated ||= htmlMetrics.overlaysGenerated;
      hasRealWidgets ||= html.trim().length > 0;
    }

    element.elements.forEach(visit);
  };

  document.content.forEach(visit);

  const layoutNodeById = new Map(layout.nodes.map((node) => [node.id, node]));
  const visibleHeight = [...contributingNodeIds].reduce(
    (max, nodeId) => {
      const box = layoutNodeById.get(nodeId)?.box;
      return Math.max(max, box ? box.y + box.height : 0);
    },
    0
  );
  const convertedBodyEmpty =
    !Array.isArray(document.content) ||
    document.content.length === 0 ||
    (!hasRealWidgets &&
      textCount === 0 &&
      imageCount === 0 &&
      buttonCount === 0 &&
      linkCount === 0 &&
      visualEmbeds === 0 &&
      sectionCount === 0);

  return {
    textCount,
    imageCount,
    buttonCount,
    linkCount,
    sectionCount,
    visibleHeight: Math.round(visibleHeight),
    visibleContentDetected:
      textCount > 0 ||
      imageCount > 0 ||
      buttonCount > 0 ||
      linkCount > 0 ||
      visualEmbeds > 0 ||
      snapshotGenerated,
    convertedBodyEmpty,
    hasRealWidgets,
    snapshotGenerated,
    overlaysGenerated,
    visualEmbeds
  };
}

async function fileExists(filePath: string | undefined) {
  if (!filePath) {
    return false;
  }

  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveOriginalVisibleHeight(capture: PageCapture, fallbackHeight: number) {
  const screenshotPath = capture.artifacts.screenshots.desktop;

  if (!(await fileExists(screenshotPath))) {
    return fallbackHeight;
  }

  try {
    const dimensions = await readImageDimensions(screenshotPath as string);
    return Math.max(fallbackHeight, Math.round(dimensions.height));
  } catch {
    return fallbackHeight;
  }
}

async function resolveConvertedVisibleHeight(params: {
  converted: ConvertedMetrics;
  snapshot?: SnapshotVisualSummary;
}) {
  const screenshotPath = params.snapshot?.convertedScreenshotPath;

  if (!(await fileExists(screenshotPath))) {
    return params.converted.visibleHeight;
  }

  try {
    const dimensions = await readImageDimensions(screenshotPath as string);
    return Math.max(params.converted.visibleHeight, Math.round(dimensions.height));
  } catch {
    return params.converted.visibleHeight;
  }
}

function buildRecommendation(params: {
  capture: PageCapture;
  modeUsed: UniversalVisualMode;
  converted: ConvertedMetrics;
  snapshotRequired: boolean;
  fullPageSnapshotFailed: boolean;
  snapshotGenerated: boolean;
}) {
  if (!params.capture.inputAnalysis.diagnostics.htmlRendered) {
    return "Renderize a pagina em browser/headless, aguarde scripts e extraia o DOM final antes da conversao.";
  }

  if (!params.capture.inputAnalysis.diagnostics.cssLoaded) {
    return "Verifique o carregamento de CSS externo, inline e caminhos relativos antes de exportar.";
  }

  if (!params.capture.inputAnalysis.diagnostics.imagesLoaded) {
    return "Confirme src, srcset, data-src e background-image; aguarde lazy-load antes da captura.";
  }

  if (!params.capture.inputAnalysis.diagnostics.relativeAssetsResolved) {
    return "Corrija assets relativos e /assets para que a pagina renderizada nao perca imagens, CSS e fontes.";
  }

  if (params.fullPageSnapshotFailed || (params.modeUsed === "full-page-snapshot" && !params.snapshotGenerated)) {
    return "Refaca o full-page snapshot apos estabilizar viewport, assets, fontes e a renderizacao visual da pagina original.";
  }

  if (
    params.snapshotRequired &&
    !params.snapshotGenerated &&
    params.modeUsed !== "pixel-perfect"
  ) {
    return "Quando FORCE_VISUAL_SNAPSHOT estiver ativo, gere ao menos um snapshot visual valido antes de exportar o JSON do Elementor.";
  }

  if (!params.converted.hasRealWidgets) {
    return "Revise a montagem do Elementor JSON para garantir secoes e widgets reais antes da escrita final.";
  }

  return "Revise a etapa indicada em failureStage e confirme que ela produz conteudo visual real antes da exportacao.";
}

function resolveFailureStage(params: {
  capture: PageCapture;
  modeUsed: UniversalVisualMode;
  failureStage?: string;
  converted: ConvertedMetrics;
  snapshotRequired: boolean;
}) {
  if (
    params.snapshotRequired &&
    !params.converted.snapshotGenerated &&
    params.modeUsed === "full-page-snapshot"
  ) {
    return "full-page-snapshot";
  }

  if (!params.capture.inputAnalysis.diagnostics.htmlRendered) {
    return "browser-render";
  }

  if (!params.converted.hasRealWidgets) {
    return params.failureStage ?? "elementor-document-build";
  }

  if (params.converted.convertedBodyEmpty) {
    return params.failureStage ?? "elementor-document-body";
  }

  if (!params.converted.visibleContentDetected) {
    return params.failureStage ?? "output-assembly";
  }

  return params.failureStage;
}

function buildFailureReasons(params: {
  capture: PageCapture;
  modeUsed: UniversalVisualMode;
  original: OriginalMetrics;
  converted: ConvertedMetrics;
  outputSize: number;
  snapshotRequired: boolean;
}) {
  const reasons: string[] = [];
  const visualFallbackSatisfied =
    params.converted.snapshotGenerated || params.modeUsed === "pixel-perfect";
  const interactiveFallbackSatisfied =
    params.converted.overlaysGenerated || params.modeUsed === "pixel-perfect";

  if (params.converted.convertedBodyEmpty) {
    reasons.push("O body convertido ficou vazio.");
  }

  if (!params.converted.hasRealWidgets) {
    reasons.push("O Elementor JSON foi gerado sem secoes/widgets reais.");
  }

  if (!params.converted.visibleContentDetected) {
    reasons.push("Nenhum conteudo visivel foi detectado no output convertido.");
  }

  if (params.original.sectionCount > 0 && params.converted.sectionCount === 0) {
    reasons.push("A conversao removeu todas as secoes detectadas.");
  }

  if (params.original.textCount > 0 && params.converted.textCount === 0 && !visualFallbackSatisfied) {
    reasons.push("Os textos do original nao chegaram ao output final.");
  }

  if (params.original.imageCount > 0 && params.converted.imageCount === 0 && !visualFallbackSatisfied) {
    reasons.push("As imagens do original nao chegaram ao output final.");
  }

  if (params.original.linkCount > 0 && params.converted.linkCount === 0 && !interactiveFallbackSatisfied) {
    reasons.push("Os links do original nao foram preservados no output final.");
  }

  if (
    params.snapshotRequired &&
    !params.converted.snapshotGenerated &&
    params.modeUsed !== "pixel-perfect"
  ) {
    reasons.push("Nenhum snapshot visual foi gerado apesar do fallback visual ser obrigatorio.");
  }

  if (params.modeUsed === "full-page-snapshot" && !params.converted.snapshotGenerated) {
    reasons.push(
      "Falha no full-page snapshot: nao foi possivel capturar conteudo visual da pagina original."
    );
  }

  if (
    params.outputSize <= 256 &&
    (params.converted.convertedBodyEmpty || !params.converted.visibleContentDetected)
  ) {
    reasons.push("O tamanho total do output gerado ficou pequeno demais para conter conteudo real.");
  }

  return reasons;
}

export class ContentIntegrityError extends Error {
  report: ContentIntegrityReport;

  constructor(report: ContentIntegrityReport) {
    const message =
      report.failureStage === "full-page-snapshot"
        ? "Falha no full-page snapshot: não foi possível capturar conteúdo visual da página original."
        : "Exportação bloqueada: saída convertida sem conteúdo detectável.";
    super(message);
    this.name = "ContentIntegrityError";
    this.report = report;
  }
}

export async function validateContentIntegrity(
  params: ValidateContentIntegrityParams
): Promise<ContentIntegrityReport> {
  const modeUsed = resolveModeUsed(params.emittedMode, params.snapshot);
  const original = collectOriginalMetrics(params.capture, params.layout);
  const converted = collectConvertedMetrics(params.document, params.layout, params.snapshot);
  const snapshotRequired = isForceVisualSnapshotEnabled() || params.emittedMode === "snapshot";
  const elementorJsonSize = Buffer.byteLength(JSON.stringify(params.document), "utf8");
  const previewHtmlSize = Buffer.byteLength(params.previewHtml ?? "", "utf8");
  const outputSize = elementorJsonSize + previewHtmlSize;
  const originalVisibleHeight = await resolveOriginalVisibleHeight(
    params.capture,
    original.visibleHeight
  );
  const convertedVisibleHeight = await resolveConvertedVisibleHeight({
    converted,
    snapshot: params.snapshot
  });
  const failureStage = resolveFailureStage({
    capture: params.capture,
    modeUsed,
    failureStage: params.failureStage,
    converted,
    snapshotRequired
  });
  const failureReasons = buildFailureReasons({
    capture: params.capture,
    modeUsed,
    original,
    converted: {
      ...converted,
      visibleHeight: convertedVisibleHeight
    },
    outputSize,
    snapshotRequired
  });
  const blocked = failureReasons.length > 0;
  const recommendation = buildRecommendation({
    capture: params.capture,
    modeUsed,
    converted,
    snapshotRequired,
    fullPageSnapshotFailed: failureStage === "full-page-snapshot",
    snapshotGenerated: converted.snapshotGenerated
  });

  return {
    status: blocked ? "blocked" : "passed",
    inputFile:
      params.capture.inputAnalysis.fileName ||
      params.capture.title ||
      params.capture.id,
    outputFile: params.outputFile,
    sourceHtmlSize: Buffer.byteLength(params.capture.sourceHtml ?? "", "utf8"),
    originalHtmlSize: Buffer.byteLength(params.capture.renderedHtml ?? "", "utf8"),
    renderedHtmlSize: Buffer.byteLength(params.capture.renderedHtml ?? "", "utf8"),
    outputSize,
    elementorJsonSize,
    previewHtmlSize,
    originalTextCount: original.textCount,
    outputTextCount: converted.textCount,
    originalImageCount: original.imageCount,
    outputImageCount: converted.imageCount,
    originalButtonCount: original.buttonCount,
    outputButtonCount: converted.buttonCount,
    originalLinkCount: original.linkCount,
    outputLinkCount: converted.linkCount,
    originalSectionCount: original.sectionCount,
    outputSectionCount: converted.sectionCount,
    originalVisibleHeight,
    convertedVisibleHeight,
    visibleContentDetected: converted.visibleContentDetected || converted.visualEmbeds > 0,
    convertedBodyEmpty: converted.convertedBodyEmpty,
    hasRealWidgets: converted.hasRealWidgets,
    snapshotGenerated: converted.snapshotGenerated,
    overlaysGenerated: converted.overlaysGenerated,
    modeUsed,
    failureStage,
    failureReason: blocked ? failureReasons.join(" ") : undefined,
    recommendation,
    errorsFound: [
      ...failureReasons,
      ...params.capture.inputAnalysis.diagnostics.errors,
      ...params.capture.inputAnalysis.diagnostics.warnings
    ],
    debugArtifacts: {
      renderedHtmlPath: params.capture.artifacts.renderedHtmlPath,
      pageCapturePath: params.capture.artifacts.pageCapturePath,
      visibleElementsPath: params.capture.artifacts.visibleElementsPath,
      geometryGroupsPath: params.capture.artifacts.geometryGroupsPath,
      originalScreenshotPath: params.capture.artifacts.screenshots.desktop,
      convertedScreenshotPath: params.snapshot?.convertedScreenshotPath
    }
  };
}

export function assertContentIntegrity(report: ContentIntegrityReport) {
  if (report.status === "blocked") {
    throw new ContentIntegrityError(report);
  }
}
