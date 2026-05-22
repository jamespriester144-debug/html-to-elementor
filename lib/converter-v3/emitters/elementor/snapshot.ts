import * as cheerio from "cheerio";

import type { PageCapture, SectionCapture, SectionCaptureViewport } from "@/lib/converter-v3/contracts/capture";
import type { LayoutDocument, OutputMode } from "@/lib/converter-v3/contracts/layout";
import type {
  SnapshotSectionRenderMode,
  SnapshotSectionReport,
  SnapshotVisualSummary
} from "@/lib/converter-v3/contracts/output";
import { compareImagesPixelByPixel, renderHtmlToScreenshot } from "@/lib/converter-v3/visual-similarity";
import type { ElementorDocument, ElementorElement } from "@/types/conversion";

type SnapshotDecision = SnapshotSectionReport & {
  widgetHtml: string;
};

type SnapshotEmitterResult = {
  document: ElementorDocument;
  previewHtml: string;
  snapshot: SnapshotVisualSummary;
  warnings: string[];
};

const SECTION_SIMILARITY_THRESHOLD = 0.985;
const PAGE_SIMILARITY_THRESHOLD = 0.99;
const TABLET_BREAKPOINT = 1024;
const MOBILE_BREAKPOINT = 767;

function createElementId(prefix: string, index: number) {
  return `${prefix}-${index.toString(16).padStart(6, "0")}`;
}

function toPercent(value: number) {
  return `${(value * 100).toFixed(4)}%`;
}

function zeroSpacing() {
  return {
    unit: "px",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    isLinked: true
  };
}

function escapeHtmlAttribute(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeCssValue(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function getDesktopViewport(section: SectionCapture) {
  return section.viewports.desktop ?? Object.values(section.viewports)[0];
}

function getUniqueLinkCount(section: SectionCapture) {
  const unique = new Set<string>();

  Object.values(section.viewports).forEach((viewport) => {
    viewport?.linkOverlays.forEach((overlay) => {
      unique.add(`${overlay.nodeId}:${overlay.href}`);
    });
  });

  return unique.size;
}

function shouldAttemptHtml(section: SectionCapture) {
  const desktopViewport = getDesktopViewport(section);

  if (!desktopViewport?.snapshotDataUrl || !section.htmlCandidate.trim()) {
    return false;
  }

  if (section.complexity.hasEmbeds || section.complexity.hasPseudoElements || section.complexity.hasTransforms) {
    return false;
  }

  if (section.complexity.absoluteNodes > 1 || section.complexity.overlappingNodes > 0) {
    return false;
  }

  return section.complexity.nodeCount <= 40;
}

function extractWidgetHtmlFromFrozenDocument(documentHtml: string) {
  const $ = cheerio.load(documentHtml);
  const bodyHtml = $("body").html()?.trim();

  return bodyHtml && bodyHtml.length > 0 ? bodyHtml : documentHtml;
}

function buildSectionSnapshotMarkup(section: SectionCapture) {
  const desktop = section.viewports.desktop ?? Object.values(section.viewports)[0];

  if (!desktop?.snapshotDataUrl) {
    return extractWidgetHtmlFromFrozenDocument(section.htmlCandidate);
  }

  const tablet = section.viewports.tablet;
  const mobile = section.viewports.mobile;
  const mergedLinks = new Map<
    string,
    {
      nodeId: string;
      href: string;
      text: string;
      title?: string;
      target?: string;
      rel?: string;
      isButton: boolean;
      positions: Partial<Record<"desktop" | "tablet" | "mobile", SectionCaptureViewport["linkOverlays"][number]["relativeBox"]>>;
    }
  >();

  for (const viewportName of ["desktop", "tablet", "mobile"] as const) {
    const viewport = section.viewports[viewportName];

    viewport?.linkOverlays.forEach((overlay) => {
      const key = `${overlay.nodeId}:${overlay.href}`;
      const existing = mergedLinks.get(key) ?? {
        nodeId: overlay.nodeId,
        href: overlay.href,
        text: overlay.text,
        title: overlay.title,
        target: overlay.target,
        rel: overlay.rel,
        isButton: overlay.isButton,
        positions: {}
      };

      existing.positions[viewportName] = overlay.relativeBox;
      mergedLinks.set(key, existing);
    });
  }

  const scopeId = `converter-v3-snapshot-${section.nodeId}`;
  const stageBaseStyles = [
    "position:relative",
    "display:block",
    "width:100%",
    `max-width:${Math.round(desktop.width)}px`,
    "margin:0 auto",
    `aspect-ratio:${Math.max(Math.round(desktop.width), 1)} / ${Math.max(Math.round(desktop.height), 1)}`,
    `background-image:url("${escapeCssValue(desktop.snapshotDataUrl)}")`,
    "background-size:100% 100%",
    "background-position:center top",
    "background-repeat:no-repeat"
  ].join(";");
  const stageTabletStyles =
    tablet?.snapshotDataUrl
      ? [
          `max-width:${Math.round(tablet.width)}px`,
          `aspect-ratio:${Math.max(Math.round(tablet.width), 1)} / ${Math.max(
            Math.round(tablet.height),
            1
          )}`,
          `background-image:url("${escapeCssValue(tablet.snapshotDataUrl)}")`
        ].join(";")
      : "";
  const stageMobileStyles =
    mobile?.snapshotDataUrl
      ? [
          `max-width:${Math.round(mobile.width)}px`,
          `aspect-ratio:${Math.max(Math.round(mobile.width), 1)} / ${Math.max(
            Math.round(mobile.height),
            1
          )}`,
          `background-image:url("${escapeCssValue(mobile.snapshotDataUrl)}")`
        ].join(";")
      : "";
  const linkStyles = [...mergedLinks.values()]
    .map((link, index) => {
      const desktopPosition =
        link.positions.desktop ?? link.positions.tablet ?? link.positions.mobile;

      if (!desktopPosition) {
        return "";
      }

      const selector = `#${scopeId} .converter-v3-snapshot-link-${index + 1}`;
      const rules = [
        `${selector}{left:${toPercent(desktopPosition.x)};top:${toPercent(
          desktopPosition.y
        )};width:${toPercent(desktopPosition.width)};height:${toPercent(
          desktopPosition.height
        )};}`
      ];

      if (tablet?.snapshotDataUrl && link.positions.tablet) {
        rules.push(
          `@media (max-width:${TABLET_BREAKPOINT}px){${selector}{left:${toPercent(
            link.positions.tablet.x
          )};top:${toPercent(link.positions.tablet.y)};width:${toPercent(
            link.positions.tablet.width
          )};height:${toPercent(link.positions.tablet.height)};}}`
        );
      }

      if (mobile?.snapshotDataUrl && link.positions.mobile) {
        rules.push(
          `@media (max-width:${MOBILE_BREAKPOINT}px){${selector}{left:${toPercent(
            link.positions.mobile.x
          )};top:${toPercent(link.positions.mobile.y)};width:${toPercent(
            link.positions.mobile.width
          )};height:${toPercent(link.positions.mobile.height)};}}`
        );
      }

      return rules.join("");
    })
    .join("");
  const linksHtml = [...mergedLinks.values()]
    .map((link, index) => {
      const label = link.text || link.title || link.href;

      return `<a class="converter-v3-snapshot-link converter-v3-snapshot-link-${index + 1}" href="${escapeHtmlAttribute(
        link.href
      )}"${
        link.target ? ` target="${escapeHtmlAttribute(link.target)}"` : ""
      }${link.rel ? ` rel="${escapeHtmlAttribute(link.rel)}"` : ""} aria-label="${escapeHtmlAttribute(
        label
      )}" title="${escapeHtmlAttribute(label)}">${escapeHtmlAttribute(label)}</a>`;
    })
    .join("");

  return `<div id="${scopeId}" class="converter-v3-snapshot-section" data-converter-v3-snapshot-section="${escapeHtmlAttribute(
    section.nodeId
  )}">
  <style>
    #${scopeId}{position:relative;width:100%;}
    #${scopeId} .converter-v3-snapshot-stage{${stageBaseStyles}}
    #${scopeId} .converter-v3-snapshot-link{
      position:absolute;
      display:block;
      z-index:2;
      background:rgba(255,255,255,0.001);
      color:transparent;
      font-size:0;
      line-height:0;
      text-decoration:none;
    }
    ${
      stageTabletStyles
        ? `@media (max-width:${TABLET_BREAKPOINT}px){#${scopeId} .converter-v3-snapshot-stage{${stageTabletStyles}}}`
        : ""
    }
    ${
      stageMobileStyles
        ? `@media (max-width:${MOBILE_BREAKPOINT}px){#${scopeId} .converter-v3-snapshot-stage{${stageMobileStyles}}}`
        : ""
    }
    ${linkStyles}
  </style>
  <div class="converter-v3-snapshot-stage">${linksHtml}</div>
</div>`;
}

function buildPreviewHtml(params: {
  capture: PageCapture;
  decisions: SnapshotDecision[];
}) {
  const desktopViewport =
    params.capture.viewports.find((viewport) => viewport.name === "desktop") ?? params.capture.viewports[0];
  const pageWidth = desktopViewport?.width ?? 1440;
  const sectionsHtml = params.decisions
    .map(
      (decision) => `<section data-converter-v3-preview-section="${escapeHtmlAttribute(
        decision.nodeId
      )}" style="margin:0;padding:0;">${decision.widgetHtml}</section>`
    )
    .join("");

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      html, body {
        margin: 0;
        padding: 0;
        background: #ffffff;
      }

      *, *::before, *::after {
        box-sizing: border-box;
      }

      .converter-v3-preview-page {
        width: ${Math.max(pageWidth, 1)}px;
        max-width: 100%;
        margin: 0 auto;
      }
    </style>
  </head>
  <body>
    <main class="converter-v3-preview-page">${sectionsHtml}</main>
  </body>
</html>`;
}

async function validateHtmlSection(section: SectionCapture) {
  const desktopViewport = getDesktopViewport(section);

  if (!desktopViewport?.snapshotDataUrl) {
    return {
      passed: false,
      similarity: 0
    };
  }

  const screenshot = await renderHtmlToScreenshot({
    html: section.htmlCandidate,
    viewportWidth: desktopViewport.width,
    viewportHeight: desktopViewport.height,
    fullPage: true
  });
  const comparison = await compareImagesPixelByPixel({
    reference: desktopViewport.snapshotDataUrl,
    candidate: screenshot.dataUrl,
    similarityThreshold: SECTION_SIMILARITY_THRESHOLD
  });

  return comparison;
}

function buildContainerElement(params: {
  section: SectionCapture;
  widgetHtml: string;
  mode: SnapshotSectionRenderMode;
  similarity: number;
  index: number;
}) {
  const desktopViewport = getDesktopViewport(params.section);

  return {
    id: createElementId("section", params.index + 1),
    elType: "container",
    settings: {
      content_width: "full",
      width: "100%",
      min_height: desktopViewport ? `${Math.round(desktopViewport.height)}px` : undefined,
      _padding: zeroSpacing(),
      _margin: zeroSpacing(),
      converter_v3_source_node_id: params.section.nodeId,
      converter_v3_section_name: params.section.name,
      converter_v3_section_type: params.section.type,
      converter_v3_section_render_mode: params.mode,
      converter_v3_section_similarity: params.similarity,
      html_to_elementor_strategy: "snapshot-elementor"
    },
    elements: [
      {
        id: createElementId("html", params.index + 1),
        elType: "widget",
        widgetType: "html",
        settings: {
          html: params.widgetHtml,
          converter_v3_source_node_id: params.section.nodeId,
          converter_v3_mode: `snapshot-${params.mode}`
        },
        elements: []
      }
    ]
  } satisfies ElementorElement;
}

async function buildInitialDecisions(sections: SectionCapture[]) {
  const decisions: SnapshotDecision[] = [];

  for (const section of sections) {
    const totalLinks = getUniqueLinkCount(section);

    if (!shouldAttemptHtml(section)) {
      decisions.push({
        nodeId: section.nodeId,
        name: section.name,
        type: section.type,
        mode: "snapshot",
        reason:
          "Secao complexa para HTML congelado; mantendo snapshot para preservar a aparencia.",
        similarity: 1,
        preservedLinks: totalLinks,
        totalLinks,
        widgetHtml: buildSectionSnapshotMarkup(section)
      });
      continue;
    }

    const htmlValidation = await validateHtmlSection(section);
    const htmlWidget = extractWidgetHtmlFromFrozenDocument(section.htmlCandidate);

    if (htmlValidation.passed) {
      decisions.push({
        nodeId: section.nodeId,
        name: section.name,
        type: section.type,
        mode: "html",
        reason: `Secao preservada em HTML congelado com similaridade ${(htmlValidation.similarity * 100).toFixed(
          2
        )}%.`,
        similarity: htmlValidation.similarity,
        preservedLinks: totalLinks,
        totalLinks,
        widgetHtml: htmlWidget
      });
      continue;
    }

    decisions.push({
      nodeId: section.nodeId,
      name: section.name,
      type: section.type,
      mode: "snapshot",
      reason: `HTML congelado ficou abaixo do limite visual (${(htmlValidation.similarity * 100).toFixed(
        2
      )}%); usando snapshot fiel da secao.`,
      similarity: 1,
      preservedLinks: totalLinks,
      totalLinks,
      widgetHtml: buildSectionSnapshotMarkup(section)
    });
  }

  return decisions;
}

async function computeOverallSimilarity(params: {
  capture: PageCapture;
  previewHtml: string;
  convertedScreenshotPath?: string;
}) {
  const desktopViewport =
    params.capture.viewports.find((viewport) => viewport.name === "desktop") ?? params.capture.viewports[0];
  const originalScreenshotPath = params.capture.artifacts.screenshots.desktop;

  if (!originalScreenshotPath || !desktopViewport) {
    return {
      passed: false,
      similarity: 0
    };
  }

  const converted = await renderHtmlToScreenshot({
    html: params.previewHtml,
    viewportWidth: desktopViewport.width,
    viewportHeight: desktopViewport.height,
    outputPath: params.convertedScreenshotPath,
    fullPage: true
  });

  return compareImagesPixelByPixel({
    reference: originalScreenshotPath,
    candidate: converted.dataUrl,
    similarityThreshold: PAGE_SIMILARITY_THRESHOLD
  });
}

export async function createSnapshotElementorDocumentV3(params: {
  capture: PageCapture;
  layout: LayoutDocument;
  sections: SectionCapture[];
  selectedMode: OutputMode;
  outputDir?: string;
}) : Promise<SnapshotEmitterResult> {
  const orderedSections = [...params.sections].sort(
    (left, right) => left.box.y - right.box.y || left.box.x - right.box.x
  );
  const decisions = await buildInitialDecisions(orderedSections);
  let previewHtml = buildPreviewHtml({
    capture: params.capture,
    decisions
  });
  let overallSimilarity = await computeOverallSimilarity({
    capture: params.capture,
    previewHtml,
    convertedScreenshotPath: params.outputDir
      ? `${params.outputDir}/snapshot-preview.png`
      : undefined
  });

  while (!overallSimilarity.passed) {
    const weakestHtmlDecision = decisions
      .filter((decision) => decision.mode === "html")
      .sort((left, right) => left.similarity - right.similarity)[0];

    if (!weakestHtmlDecision) {
      break;
    }

    const section = orderedSections.find((candidate) => candidate.nodeId === weakestHtmlDecision.nodeId);

    if (!section) {
      break;
    }

    weakestHtmlDecision.mode = "snapshot";
    weakestHtmlDecision.reason =
      "Secao rebaixada para snapshot apos validacao da pagina completa para manter a fidelidade visual global.";
    weakestHtmlDecision.similarity = 1;
    weakestHtmlDecision.widgetHtml = buildSectionSnapshotMarkup(section);
    previewHtml = buildPreviewHtml({
      capture: params.capture,
      decisions
    });
    overallSimilarity = await computeOverallSimilarity({
      capture: params.capture,
      previewHtml,
      convertedScreenshotPath: params.outputDir
        ? `${params.outputDir}/snapshot-preview.png`
        : undefined
    });
  }

  const content = decisions.map((decision, index) =>
    buildContainerElement({
      section: orderedSections[index],
      widgetHtml: decision.widgetHtml,
      mode: decision.mode,
      similarity: decision.similarity,
      index
    })
  );
  const sectionReports = decisions.map<SnapshotSectionReport>((decision) => ({
    nodeId: decision.nodeId,
    name: decision.name,
    type: decision.type,
    mode: decision.mode,
    reason: decision.reason,
    similarity: decision.similarity,
    preservedLinks: decision.preservedLinks,
    totalLinks: decision.totalLinks
  }));
  const warnings = sectionReports
    .filter((section) => section.mode === "snapshot")
    .map((section) => `${section.name} (${section.nodeId}) exportada como snapshot.`)
    .concat(
      overallSimilarity.passed
        ? []
        : [
            `Similaridade final da pagina ficou em ${(overallSimilarity.similarity * 100).toFixed(
              2
            )}% mesmo apos os fallbacks por secao.`
          ]
    );

  return {
    document: {
      version: "1.0",
      title: params.capture.title,
      type: "page",
      content
    },
    previewHtml,
    snapshot: {
      overallSimilarity: overallSimilarity.similarity,
      threshold: PAGE_SIMILARITY_THRESHOLD,
      convertedScreenshotPath: params.outputDir
        ? `${params.outputDir}/snapshot-preview.png`
        : undefined,
      originalScreenshotPath: params.capture.artifacts.screenshots.desktop,
      sectionReports,
      totals: {
        htmlSections: sectionReports.filter((section) => section.mode === "html").length,
        snapshotSections: sectionReports.filter((section) => section.mode === "snapshot").length,
        preservedLinks: sectionReports.reduce((sum, section) => sum + section.preservedLinks, 0),
        totalLinks: sectionReports.reduce((sum, section) => sum + section.totalLinks, 0)
      }
    },
    warnings
  };
}
