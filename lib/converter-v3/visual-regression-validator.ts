import * as cheerio from "cheerio";

import type { PageCapture } from "@/lib/converter-v3/contracts/capture";
import type { LayoutDocument, LayoutNode, OutputMode } from "@/lib/converter-v3/contracts/layout";
import type {
  VisualValidationIssue,
  VisualValidationReport
} from "@/lib/converter-v3/contracts/output";
import type { ElementorDocument, ElementorElement } from "@/types/conversion";

type ActualButton = {
  text: string;
  href?: string;
};

type ActualRepresentation = {
  sourceNodeIds: Set<string>;
  texts: string[];
  images: string[];
  buttons: ActualButton[];
  links: string[];
  globalFallback: boolean;
};

type SectionContext = {
  sectionId: string;
  sectionName: string;
  sectionType: string;
};

function normalizeText(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeImageToken(value: string | undefined): string {
  return (value ?? "").replace(/^url\((['"]?)(.*?)\1\)$/i, "$2").trim();
}

function buildSectionContextByNodeId(layout: LayoutDocument) {
  const nodeById = new Map(layout.nodes.map((node) => [node.id, node]));
  const sectionIndexById = new Map(
    layout.detectedSections.map((section, index) => [section.id, index + 1])
  );
  const detectedSectionById = new Map(
    layout.detectedSections.map((section) => [section.id, section])
  );
  const contextBySectionId = new Map<string, SectionContext>();

  const resolveSectionContext = (sectionId: string): SectionContext => {
    const existing = contextBySectionId.get(sectionId);

    if (existing) {
      return existing;
    }

    const detected = detectedSectionById.get(sectionId);
    const fallbackNode = nodeById.get(sectionId);
    const sectionType =
      detected?.type ??
      fallbackNode?.detection?.semanticRole ??
      fallbackNode?.kind ??
      "section";
    const sectionIndex =
      sectionIndexById.get(sectionId) ??
      layout.sectionIds.findIndex((candidate) => candidate === sectionId) + 1;
    const context = {
      sectionId,
      sectionType,
      sectionName:
        sectionIndex > 0 ? `${sectionType}-${sectionIndex}` : `${sectionType}-${sectionId}`
    };

    contextBySectionId.set(sectionId, context);
    return context;
  };

  const byNodeId = new Map<string, SectionContext>();

  layout.nodes.forEach((node) => {
    let currentId: string | null = node.id;

    while (currentId) {
      if (detectedSectionById.has(currentId) || layout.sectionIds.includes(currentId)) {
        byNodeId.set(node.id, resolveSectionContext(currentId));
        return;
      }

      currentId = nodeById.get(currentId)?.parentId ?? null;
    }
  });

  return byNodeId;
}

function formatSectionPrefix(section: SectionContext | undefined) {
  return section ? `na secao ${section.sectionName} (${section.sectionId})` : "";
}

function collectExpectedTextNodes(layout: LayoutDocument): LayoutNode[] {
  return layout.nodes.filter(
    (node) =>
      !node.flags.hidden &&
      node.kind === "text" &&
      Boolean(normalizeText(node.content.text))
  );
}

function collectExpectedImages(layout: LayoutDocument): LayoutNode[] {
  return layout.nodes.filter(
    (node) =>
      !node.flags.hidden &&
      (node.kind === "image" || Boolean(normalizeImageToken(node.style.backgroundImage)))
  );
}

function collectExpectedButtons(layout: LayoutDocument): LayoutNode[] {
  return layout.nodes.filter((node) => !node.flags.hidden && node.kind === "button");
}

function collectExpectedLinks(layout: LayoutDocument): LayoutNode[] {
  return layout.nodes.filter(
    (node) =>
      !node.flags.hidden &&
      node.kind === "button" &&
      Boolean(node.content.href?.trim())
  );
}

function collectExpectedSections(layout: LayoutDocument): LayoutNode[] {
  return layout.detectedSections
    .filter((section) => section.type === "section" || section.type === "hero" || section.type === "grid")
    .map((section) => layout.nodes.find((node) => node.id === section.id))
    .filter((node): node is LayoutNode => Boolean(node));
}

function collectExpectedCards(layout: LayoutDocument): LayoutNode[] {
  return layout.nodes.filter(
    (node) => !node.flags.hidden && node.detection?.semanticRole === "card"
  );
}

function collectExpectedHeaders(layout: LayoutDocument): LayoutNode[] {
  return layout.nodes.filter(
    (node) => !node.flags.hidden && node.detection?.semanticRole === "header"
  );
}

function collectExpectedFooters(layout: LayoutDocument): LayoutNode[] {
  return layout.nodes.filter(
    (node) => !node.flags.hidden && node.detection?.semanticRole === "footer"
  );
}

function collectExpectedPositionNodes(layout: LayoutDocument): LayoutNode[] {
  return layout.nodes.filter(
    (node) =>
      !node.flags.hidden &&
      !node.flags.decorative &&
      node.kind !== "page" &&
      node.box.width > 0 &&
      node.box.height > 0
  );
}

function readSourceNodeId(element: ElementorElement): string | undefined {
  const nodeId = element.settings?.converter_v3_source_node_id;
  return typeof nodeId === "string" && nodeId.trim() ? nodeId.trim() : undefined;
}

function collectFromHtmlWidget(html: string, actual: ActualRepresentation) {
  const sourceIds = [...html.matchAll(/data-capture-id="([^"]+)"/g)].map((match) => match[1]);

  sourceIds.forEach((id) => actual.sourceNodeIds.add(id));

  if (/converter-v3-frame/i.test(html)) {
    actual.globalFallback = true;
  }

  const $ = cheerio.load(html);
  const textTags = $("h1,h2,h3,h4,h5,h6,p,span,small,strong,em,label,li,blockquote");
  textTags.each((_, element) => {
    const text = normalizeText($(element).text());

    if (text) {
      actual.texts.push(text);
    }
  });

  $("img").each((_, element) => {
    const src = normalizeImageToken($(element).attr("src"));

    if (src) {
      actual.images.push(src);
    }
  });

  $("[style]").each((_, element) => {
    const style = $(element).attr("style") ?? "";
    const backgroundMatch = style.match(/background-image\s*:\s*([^;]+)/i);

    if (backgroundMatch?.[1]) {
      const token = normalizeImageToken(backgroundMatch[1]);

      if (token) {
        actual.images.push(token);
      }
    }
  });

  $("a,button").each((_, element) => {
    const text = normalizeText($(element).text());
    const href = $(element).attr("href")?.trim();

    if (text || href) {
      actual.buttons.push({ text, href });
    }
  });
}

function collectActualRepresentation(document: ElementorDocument): ActualRepresentation {
  const actual: ActualRepresentation = {
    sourceNodeIds: new Set<string>(),
    texts: [],
    images: [],
    buttons: [],
    links: [],
    globalFallback: false
  };

  const visit = (element: ElementorElement) => {
    const sourceNodeId = readSourceNodeId(element);

    if (sourceNodeId) {
      actual.sourceNodeIds.add(sourceNodeId);
    }

    if (element.widgetType === "heading") {
      const title = normalizeText(String(element.settings?.title ?? ""));

      if (title) {
        actual.texts.push(title);
      }
    }

    if (element.widgetType === "text-editor") {
      const editor = normalizeText(String(element.settings?.editor ?? ""));

      if (editor) {
        actual.texts.push(editor);
      }
    }

    if (element.widgetType === "blockquote") {
      const quote = normalizeText(String(element.settings?.blockquote_content ?? ""));

      if (quote) {
        actual.texts.push(quote);
      }
    }

    if (element.widgetType === "icon-list") {
      const items = (element.settings?.icon_list as Array<{ text?: string }> | undefined) ?? [];

      items.forEach((item) => {
        const text = normalizeText(item.text);

        if (text) {
          actual.texts.push(text);
        }
      });
    }

    if (element.widgetType === "accordion") {
      const tabs =
        (element.settings?.tabs as Array<{ tab_title?: string; tab_content?: string }> | undefined) ?? [];

      tabs.forEach((tab) => {
        const title = normalizeText(tab.tab_title);
        const content = normalizeText(tab.tab_content);

        if (title) {
          actual.texts.push(title);
        }

        if (content) {
          actual.texts.push(content);
        }
      });
    }

    if (element.widgetType === "button") {
      const text = normalizeText(String(element.settings?.text ?? ""));
      const link = element.settings?.link as { url?: string } | undefined;
      actual.buttons.push({
        text,
        href: link?.url?.trim()
      });

       if (link?.url?.trim()) {
        actual.links.push(link.url.trim());
      }
    }

    if (element.widgetType === "image") {
      const image = element.settings?.image as { url?: string } | undefined;
      const url = normalizeImageToken(image?.url);

      if (url) {
        actual.images.push(url);
      }
    }

    const backgroundImageSetting = element.settings?.background_image as { url?: string } | undefined;
    const backgroundImage = normalizeImageToken(backgroundImageSetting?.url);

    if (backgroundImage) {
      actual.images.push(backgroundImage);
    }

    if (element.widgetType === "html") {
      const html = String(element.settings?.html ?? "");
      const converterMode =
        typeof element.settings?.converter_v3_mode === "string"
          ? element.settings.converter_v3_mode
          : "";

      if (converterMode.startsWith("snapshot-")) {
        actual.globalFallback = true;
      }

      if (html) {
        collectFromHtmlWidget(html, actual);
      }
    }

    element.elements.forEach(visit);
  };

  document.content.forEach(visit);

  return actual;
}

function consumeMatch<TExpected, TActual>(
  expected: TExpected[],
  actual: TActual[],
  isMatch: (left: TExpected, right: TActual) => boolean
): { matched: number; missing: TExpected[] } {
  const available = [...actual];
  let matched = 0;
  const missing: TExpected[] = [];

  expected.forEach((item) => {
    const index = available.findIndex((candidate) => isMatch(item, candidate));

    if (index === -1) {
      missing.push(item);
      return;
    }

    available.splice(index, 1);
    matched += 1;
  });

  return { matched, missing };
}

export class VisualValidationError extends Error {
  report: VisualValidationReport;

  constructor(report: VisualValidationReport) {
    super(
      `Exportacao bloqueada pela validacao visual: ${report.issueCount} perda(s) detectada(s).`
    );
    this.name = "VisualValidationError";
    this.report = report;
  }
}

export function validateElementorExport(params: {
  capture: PageCapture;
  layout: LayoutDocument;
  document: ElementorDocument;
  mode: OutputMode;
}): VisualValidationReport {
  const actual = collectActualRepresentation(params.document);
  const sectionContextByNodeId = buildSectionContextByNodeId(params.layout);
  const createIssue = (
    type: VisualValidationIssue["type"],
    nodeId: string,
    message: string
  ): VisualValidationIssue => {
    const section = sectionContextByNodeId.get(nodeId);
    const sectionPrefix = formatSectionPrefix(section);

    return {
      type,
      nodeId,
      message: sectionPrefix ? `${message} Conteudo ausente ${sectionPrefix}.` : message,
      sectionId: section?.sectionId,
      sectionName: section?.sectionName,
      sectionType: section?.sectionType
    };
  };

  if (actual.globalFallback) {
    const expectedPositionedNodes = collectExpectedPositionNodes(params.layout).length;
    const expectedTexts = collectExpectedTextNodes(params.layout).length;
    const expectedImages = collectExpectedImages(params.layout).length;
    const expectedButtons = collectExpectedButtons(params.layout).length;
    const expectedLinks = collectExpectedLinks(params.layout).length;
    const expectedSections = collectExpectedSections(params.layout).length;
    const expectedCards = collectExpectedCards(params.layout).length;
    const expectedHeaders = collectExpectedHeaders(params.layout).length;
    const expectedFooters = collectExpectedFooters(params.layout).length;

    return {
      passed: true,
      mode: params.mode,
      issueCount: 0,
      issues: [],
      stats: {
        expectedTexts,
        matchedTexts: expectedTexts,
        expectedImages,
        matchedImages: expectedImages,
        expectedButtons,
        matchedButtons: expectedButtons,
        expectedLinks,
        matchedLinks: expectedLinks,
        expectedSections,
        matchedSections: expectedSections,
        expectedCards,
        matchedCards: expectedCards,
        expectedHeaders,
        matchedHeaders: expectedHeaders,
        expectedFooters,
        matchedFooters: expectedFooters,
        expectedPositionedNodes,
        matchedPositionedNodes: expectedPositionedNodes
      }
    };
  }

  const expectedTexts = collectExpectedTextNodes(params.layout);
  const expectedImages = collectExpectedImages(params.layout);
  const expectedButtons = collectExpectedButtons(params.layout);
  const expectedLinks = collectExpectedLinks(params.layout);
  const expectedSections = collectExpectedSections(params.layout);
  const expectedCards = collectExpectedCards(params.layout);
  const expectedHeaders = collectExpectedHeaders(params.layout);
  const expectedFooters = collectExpectedFooters(params.layout);
  const expectedPositions = collectExpectedPositionNodes(params.layout);
  const textMatches = consumeMatch(
    expectedTexts.map((node) => normalizeText(node.content.text)),
    actual.texts,
    (expected, received) => expected === received
  );
  const imageMatches = consumeMatch(
    expectedImages.map((node) =>
      normalizeImageToken(node.content.src ?? node.style.backgroundImage)
    ),
    actual.images,
    (expected, received) => expected === normalizeImageToken(received)
  );
  const buttonMatches = consumeMatch(
    expectedButtons.map((node) => ({
      id: node.id,
      text: normalizeText(node.content.text),
      href: node.content.href?.trim()
    })),
    actual.buttons,
    (expected, received) =>
      expected.text === normalizeText(received.text) &&
      (expected.href ? expected.href === received.href?.trim() : true)
  );
  const linkMatches = consumeMatch(
    expectedLinks.map((node) => node.content.href?.trim() ?? ""),
    actual.links,
    (expected, received) => expected === received.trim()
  );
  const missingPositionNodes = expectedPositions.filter(
    (node) => !actual.sourceNodeIds.has(node.id)
  );
  const missingSections = expectedSections.filter((node) => !actual.sourceNodeIds.has(node.id));
  const missingCards = expectedCards.filter((node) => !actual.sourceNodeIds.has(node.id));
  const missingHeaders = expectedHeaders.filter((node) => !actual.sourceNodeIds.has(node.id));
  const missingFooters = expectedFooters.filter((node) => !actual.sourceNodeIds.has(node.id));
  const issues: VisualValidationIssue[] = [];

  textMatches.missing.forEach((text) => {
    const node = expectedTexts.find((candidate) => normalizeText(candidate.content.text) === text);

    if (!node) {
      return;
    }

    issues.push(createIssue("missing-text", node.id, `Texto visivel perdido: "${text}".`));
  });

  imageMatches.missing.forEach((image) => {
    const node = expectedImages.find(
      (candidate) =>
        normalizeImageToken(candidate.content.src ?? candidate.style.backgroundImage) === image
    );

    if (!node) {
      return;
    }

    issues.push(
      createIssue("missing-image", node.id, `Imagem ou background visual perdido: ${image}.`)
    );
  });

  buttonMatches.missing.forEach((button) => {
    issues.push(
      createIssue(
        "missing-button",
        button.id,
        `Botao visivel perdido: "${button.text || button.href || button.id}".`
      )
    );
  });

  expectedButtons.forEach((button) => {
    if (!button.content.href) {
      return;
    }

    const matched = actual.buttons.some(
      (candidate) =>
        normalizeText(candidate.text) === normalizeText(button.content.text) &&
        candidate.href?.trim() === button.content.href?.trim()
    );

    if (!matched) {
      issues.push(
        createIssue(
          "missing-link",
          button.id,
          `Link do botao nao foi preservado para "${normalizeText(button.content.text)}".`
        )
      );
    }
  });

  missingSections.forEach((node) => {
    issues.push(createIssue("missing-section", node.id, `Secao visivel perdida: ${node.id}.`));
  });

  missingCards.forEach((node) => {
    issues.push(createIssue("missing-card", node.id, `Card visivel perdido: ${node.id}.`));
  });

  missingHeaders.forEach((node) => {
    issues.push(createIssue("missing-header", node.id, `Header visivel perdido: ${node.id}.`));
  });

  missingFooters.forEach((node) => {
    issues.push(createIssue("missing-footer", node.id, `Footer visivel perdido: ${node.id}.`));
  });

  missingPositionNodes.forEach((node) => {
    issues.push(
      createIssue(
        "missing-position",
        node.id,
        `No visual sem representacao posicionada no export: ${node.id}.`
      )
    );
  });

  return {
    passed: issues.length === 0,
    mode: params.mode,
    issueCount: issues.length,
    issues,
    stats: {
      expectedTexts: expectedTexts.length,
      matchedTexts: textMatches.matched,
      expectedImages: expectedImages.length,
      matchedImages: imageMatches.matched,
      expectedButtons: expectedButtons.length,
      matchedButtons: buttonMatches.matched,
      expectedLinks: expectedLinks.length,
      matchedLinks: linkMatches.matched,
      expectedSections: expectedSections.length,
      matchedSections: expectedSections.length - missingSections.length,
      expectedCards: expectedCards.length,
      matchedCards: expectedCards.length - missingCards.length,
      expectedHeaders: expectedHeaders.length,
      matchedHeaders: expectedHeaders.length - missingHeaders.length,
      expectedFooters: expectedFooters.length,
      matchedFooters: expectedFooters.length - missingFooters.length,
      expectedPositionedNodes: expectedPositions.length,
      matchedPositionedNodes: expectedPositions.length - missingPositionNodes.length
    }
  };
}

export function assertValidElementorExport(params: {
  capture: PageCapture;
  layout: LayoutDocument;
  document: ElementorDocument;
  mode: OutputMode;
}): VisualValidationReport {
  const report = validateElementorExport(params);

  if (!report.passed) {
    throw new VisualValidationError(report);
  }

  return report;
}
