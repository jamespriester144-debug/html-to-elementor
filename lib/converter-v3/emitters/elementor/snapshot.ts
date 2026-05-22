import * as cheerio from "cheerio";

import type {
  PageCapture,
  SectionCapture,
  SectionCaptureViewport
} from "@/lib/converter-v3/contracts/capture";
import type { LayoutDocument, OutputMode } from "@/lib/converter-v3/contracts/layout";
import type {
  SnapshotSectionRenderMode,
  SnapshotSectionReport,
  SnapshotVisualSummary
} from "@/lib/converter-v3/contracts/output";
import {
  HTML_BLOCK_SIMILARITY,
  HTML_TO_SNAPSHOT_SIMILARITY,
  PIXEL_PERFECT_SIMILARITY,
  createSectionStrategyLearningState,
  inferHealingIssues,
  learnFromSectionSimilarity,
  resolveSectionFidelityDecision,
  type SectionFidelityDecision,
  type SectionHealingIssue
} from "@/lib/converter-v3/section-fidelity-policy";
import {
  compareImagesPixelByPixel,
  renderHtmlToScreenshot
} from "@/lib/converter-v3/visual-similarity";
import type { ElementorDocument, ElementorElement } from "@/types/conversion";

type SnapshotDecision = SnapshotSectionReport & {
  widgetHtml: string;
  htmlSimilarity?: number;
  pixelPerfectRequired: boolean;
};

type SnapshotEmitterResult = {
  document: ElementorDocument;
  previewHtml: string;
  snapshot: SnapshotVisualSummary;
  warnings: string[];
};

type InitialDecisionResult = {
  decisions: SnapshotDecision[];
  learningNotes: string[];
  requiresPixelPerfect: boolean;
  pixelPerfectReason?: string;
};

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

function toPercentLabel(value: number) {
  return `${(value * 100).toFixed(2)}%`;
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
      positions: Partial<
        Record<
          "desktop" | "tablet" | "mobile",
          SectionCaptureViewport["linkOverlays"][number]["relativeBox"]
        >
      >;
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
    `aspect-ratio:${Math.max(Math.round(desktop.width), 1)} / ${Math.max(
      Math.round(desktop.height),
      1
    )}`,
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
    params.capture.viewports.find((viewport) => viewport.name === "desktop") ??
    params.capture.viewports[0];
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
    similarityThreshold: HTML_TO_SNAPSHOT_SIMILARITY
  });

  return comparison;
}

function describeHealingIssue(issue: SectionHealingIssue) {
  switch (issue) {
    case "image-out-of-place":
      return "Healing detectou imagem fora do lugar.";
    case "missing-button":
      return "Healing detectou CTA/botao com risco de sumir.";
    case "text-misaligned":
      return "Healing detectou risco de texto desalinhado.";
    case "broken-overlay":
      return "Healing detectou overlay/camada quebravel.";
    case "wrong-spacing":
      return "Healing detectou espacamento/layout instavel.";
    case "visual-overlap":
      return "Healing detectou overlap visual sensivel.";
    default:
      return "Healing detectou perda visual.";
  }
}

function buildSnapshotReason(params: {
  section: SectionCapture;
  decision: SectionFidelityDecision;
  similarity?: number;
}) {
  if (typeof params.similarity === "number") {
    if (params.similarity < PIXEL_PERFECT_SIMILARITY) {
      return `HTML congelado caiu para ${toPercentLabel(
        params.similarity
      )}; snapshot aplicado e export completo marcado para pixel-perfect.`;
    }

    if (params.similarity < HTML_BLOCK_SIMILARITY) {
      return `HTML congelado caiu para ${toPercentLabel(
        params.similarity
      )}; snapshot aplicado e HTML bloqueado para esse perfil visual.`;
    }

    return `HTML congelado caiu para ${toPercentLabel(
      params.similarity
    )}; snapshot aplicado automaticamente para preservar a aparencia.`;
  }

  if (params.decision.narrativeReasons.length > 0) {
    return `Secao instavel para Elementor nativo. ${params.decision.narrativeReasons.join(" ")}`;
  }

  return "Secao convertida diretamente para snapshot para preservar a aparencia.";
}

function buildContainerElement(params: {
  section: SectionCapture;
  widgetHtml: string;
  mode: SnapshotSectionRenderMode;
  similarity: number;
  fidelityScore: number | undefined;
  riskScore: number | undefined;
  htmlBlocked: boolean | undefined;
  instabilityReasons: string[] | undefined;
  healingSteps: string[] | undefined;
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
      converter_v3_section_fidelity_score: params.fidelityScore,
      converter_v3_section_risk_score: params.riskScore,
      converter_v3_section_html_blocked: params.htmlBlocked,
      converter_v3_section_instability_reasons: params.instabilityReasons,
      converter_v3_section_healing_steps: params.healingSteps,
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

async function buildInitialDecisions(sections: SectionCapture[]): Promise<InitialDecisionResult> {
  const learning = createSectionStrategyLearningState();
  const decisions: SnapshotDecision[] = [];
  let requiresPixelPerfect = false;
  let pixelPerfectReason: string | undefined;

  for (const section of sections) {
    const totalLinks = getUniqueLinkCount(section);
    const decision = resolveSectionFidelityDecision(section, learning);
    const desktopViewport = getDesktopViewport(section);
    const snapshotWidget = buildSectionSnapshotMarkup(section);
    const baseReport = {
      nodeId: section.nodeId,
      name: section.name,
      type: section.type,
      preservedLinks: totalLinks,
      totalLinks,
      fidelityScore: 1,
      riskScore: decision.riskScore,
      htmlBlocked: decision.htmlBlocked,
      instabilityReasons: decision.narrativeReasons
    };

    if (!desktopViewport?.snapshotDataUrl || !section.htmlCandidate.trim()) {
      decisions.push({
        ...baseReport,
        mode: "snapshot",
        reason:
          "Secao sem captura segura para HTML congelado; snapshot aplicado automaticamente.",
        similarity: 1,
        healingIssues: [],
        healingSteps: [
          "Captura visual indisponivel para validar HTML congelado.",
          "Snapshot aplicado automaticamente."
        ],
        widgetHtml: snapshotWidget,
        pixelPerfectRequired: false
      });
      continue;
    }

    if (decision.forcePixelPerfect) {
      requiresPixelPerfect = true;
      pixelPerfectReason ??= `Secao ${section.name} exige pixel-perfect por risco visual critico.`;
    }

    if (!decision.htmlAllowed) {
      decisions.push({
        ...baseReport,
        mode: "snapshot",
        reason: buildSnapshotReason({ section, decision }),
        similarity: 1,
        healingIssues: [],
        healingSteps: [
          ...decision.narrativeReasons,
          "Snapshot aplicado automaticamente para evitar reconstrucao nativa instavel."
        ],
        widgetHtml: snapshotWidget,
        pixelPerfectRequired: decision.forcePixelPerfect
      });
      continue;
    }

    const htmlValidation = await validateHtmlSection(section);
    const htmlSimilarity = htmlValidation.similarity;
    const healingIssues = inferHealingIssues(section, decision, htmlSimilarity);
    const healingSteps = [
      `HTML congelado validado por secao em ${toPercentLabel(htmlSimilarity)}.`,
      ...healingIssues.map((issue) => describeHealingIssue(issue))
    ];
    learnFromSectionSimilarity({
      decision,
      learning,
      similarity: htmlSimilarity
    });

    if (htmlValidation.passed) {
      decisions.push({
        ...baseReport,
        mode: "html",
        reason: `Secao preservada em HTML congelado com similaridade ${toPercentLabel(
          htmlSimilarity
        )}.`,
        similarity: htmlSimilarity,
        fidelityScore: htmlSimilarity,
        healingIssues: [],
        healingSteps,
        widgetHtml: extractWidgetHtmlFromFrozenDocument(section.htmlCandidate),
        htmlSimilarity,
        pixelPerfectRequired: false
      });
      continue;
    }

    const htmlBlocked = htmlSimilarity < HTML_BLOCK_SIMILARITY ? true : decision.htmlBlocked;
    const pixelPerfectRequired = htmlSimilarity < PIXEL_PERFECT_SIMILARITY;

    if (pixelPerfectRequired) {
      requiresPixelPerfect = true;
      pixelPerfectReason ??= `Secao ${section.name} caiu para ${toPercentLabel(
        htmlSimilarity
      )}; pixel-perfect global exigido.`;
    }

    decisions.push({
      ...baseReport,
      mode: "snapshot",
      reason: buildSnapshotReason({
        section,
        decision,
        similarity: htmlSimilarity
      }),
      similarity: 1,
      fidelityScore: 1,
      htmlBlocked,
      healingIssues,
      healingSteps: [
        ...healingSteps,
        htmlSimilarity < HTML_BLOCK_SIMILARITY
          ? "HTML congelado bloqueado automaticamente para esse perfil visual."
          : "Secao re-renderizada como snapshot.",
        pixelPerfectRequired
          ? "Score abaixo de 97%; fallback final em pixel-perfect foi armado."
          : ""
      ].filter(Boolean),
      widgetHtml: snapshotWidget,
      htmlSimilarity,
      pixelPerfectRequired
    });
  }

  return {
    decisions,
    learningNotes: learning.notes,
    requiresPixelPerfect,
    pixelPerfectReason
  };
}

async function computeOverallSimilarity(params: {
  capture: PageCapture;
  previewHtml: string;
  convertedScreenshotPath?: string;
}) {
  const desktopViewport =
    params.capture.viewports.find((viewport) => viewport.name === "desktop") ??
    params.capture.viewports[0];
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
}): Promise<SnapshotEmitterResult> {
  const orderedSections = [...params.sections].sort(
    (left, right) => left.box.y - right.box.y || left.box.x - right.box.x
  );
  const initial = await buildInitialDecisions(orderedSections);
  const decisions = initial.decisions;
  let requiresPixelPerfect = initial.requiresPixelPerfect;
  let pixelPerfectReason = initial.pixelPerfectReason;
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
      .filter((candidate) => candidate.mode === "html")
      .sort((left, right) => left.similarity - right.similarity)[0];

    if (!weakestHtmlDecision) {
      requiresPixelPerfect = true;
      pixelPerfectReason ??= `Mesmo apos snapshots por secao, a pagina ficou em ${toPercentLabel(
        overallSimilarity.similarity
      )}; fallback final em pixel-perfect exigido.`;
      break;
    }

    const section = orderedSections.find(
      (candidate) => candidate.nodeId === weakestHtmlDecision.nodeId
    );

    if (!section) {
      break;
    }

    weakestHtmlDecision.mode = "snapshot";
    weakestHtmlDecision.reason =
      "Secao rebaixada para snapshot apos validacao da pagina completa para manter a fidelidade visual global.";
    weakestHtmlDecision.similarity = 1;
    weakestHtmlDecision.fidelityScore = 1;
    weakestHtmlDecision.htmlBlocked = true;
    weakestHtmlDecision.healingSteps = [
      ...(weakestHtmlDecision.healingSteps ?? []),
      `Validacao da pagina completa caiu para ${toPercentLabel(overallSimilarity.similarity)}.`,
      "Secao re-renderizada como snapshot."
    ];
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
      fidelityScore: decision.fidelityScore,
      riskScore: decision.riskScore,
      htmlBlocked: decision.htmlBlocked,
      instabilityReasons: decision.instabilityReasons,
      healingSteps: decision.healingSteps,
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
    fidelityScore: decision.fidelityScore,
    riskScore: decision.riskScore,
    htmlBlocked: decision.htmlBlocked,
    instabilityReasons: decision.instabilityReasons,
    healingIssues: decision.healingIssues,
    healingSteps: decision.healingSteps,
    preservedLinks: decision.preservedLinks,
    totalLinks: decision.totalLinks
  }));
  const warnings = sectionReports
    .filter((section) => section.mode === "snapshot")
    .map((section) => `${section.name} (${section.nodeId}) exportada como snapshot.`)
    .concat(
      requiresPixelPerfect && pixelPerfectReason ? [pixelPerfectReason] : [],
      overallSimilarity.passed
        ? []
        : [
            `Similaridade final da pagina ficou em ${toPercentLabel(
              overallSimilarity.similarity
            )} mesmo apos os fallbacks por secao.`
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
      requiresPixelPerfect,
      pixelPerfectReason,
      learningNotes: initial.learningNotes,
      totals: {
        htmlSections: sectionReports.filter((section) => section.mode === "html").length,
        snapshotSections: sectionReports.filter((section) => section.mode === "snapshot").length,
        pixelPerfectRequiredSections: decisions.filter((decision) => decision.pixelPerfectRequired)
          .length,
        preservedLinks: sectionReports.reduce(
          (sum, section) => sum + section.preservedLinks,
          0
        ),
        totalLinks: sectionReports.reduce((sum, section) => sum + section.totalLinks, 0)
      }
    },
    warnings
  };
}
