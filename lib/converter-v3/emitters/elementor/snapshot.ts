import { readFile } from "node:fs/promises";

import * as cheerio from "cheerio";

import type {
  PageCapture,
  SectionCapture,
  SectionCaptureViewport,
  SectionOverlayLink
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

type SnapshotMarkupViewport = Pick<SectionCaptureViewport, "width" | "height" | "linkOverlays"> & {
  snapshotDataUrl: string;
};

type SnapshotMarkupSource = {
  nodeId: string;
  desktop: SnapshotMarkupViewport;
  tablet?: SnapshotMarkupViewport;
  mobile?: SnapshotMarkupViewport;
};

type SnapshotSectionInfo = {
  nodeId: string;
  name: string;
  type: string;
};

type SectionSeparationIssue = SnapshotSectionInfo & {
  reason: string;
};

type SectionSeparationAssessment = {
  safe: boolean;
  issues: SectionSeparationIssue[];
  fallbackReason?: string;
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

async function readSnapshotDataUrl(source: string) {
  if (source.startsWith("data:")) {
    return source;
  }

  const buffer = await readFile(source);
  return `data:image/png;base64,${Buffer.from(buffer).toString("base64")}`;
}

function buildResponsiveSnapshotMarkup(snapshotSource: SnapshotMarkupSource) {
  const { desktop, tablet, mobile } = snapshotSource;
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
    const viewport =
      viewportName === "desktop"
        ? desktop
        : viewportName === "tablet"
          ? tablet
          : mobile;

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

  const scopeId = `converter-v3-snapshot-${snapshotSource.nodeId}`;
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
    snapshotSource.nodeId
  )}">
  <style>
    #${scopeId}{position:relative;width:100%;}
    #${scopeId} .converter-v3-snapshot-stage{${stageBaseStyles}}
    #${scopeId} .converter-v3-snapshot-link{
      position:absolute;
      display:block;
      z-index:2;
      background:transparent;
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

function buildSectionSnapshotMarkup(section: SectionCapture) {
  const desktop = section.viewports.desktop ?? Object.values(section.viewports)[0];

  if (!desktop?.snapshotDataUrl) {
    return extractWidgetHtmlFromFrozenDocument(section.htmlCandidate);
  }

  const tablet =
    section.viewports.tablet?.snapshotDataUrl
      ? {
          ...section.viewports.tablet,
          snapshotDataUrl: section.viewports.tablet.snapshotDataUrl
        }
      : undefined;
  const mobile =
    section.viewports.mobile?.snapshotDataUrl
      ? {
          ...section.viewports.mobile,
          snapshotDataUrl: section.viewports.mobile.snapshotDataUrl
        }
      : undefined;

  return buildResponsiveSnapshotMarkup({
    nodeId: section.nodeId,
    desktop: {
      ...desktop,
      snapshotDataUrl: desktop.snapshotDataUrl
    },
    tablet,
    mobile
  });
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

function getViewportProfile(capture: PageCapture, viewportName: "desktop" | "tablet" | "mobile") {
  return capture.viewports.find((viewport) => viewport.name === viewportName);
}

function resolveViewportPageHeight(
  capture: PageCapture,
  viewportName: "desktop" | "tablet" | "mobile"
) {
  const fallbackHeight = getViewportProfile(capture, viewportName)?.height ?? 1;
  const maxBottom = capture.nodes.reduce((highest, node) => {
    const state = node.viewportStates[viewportName];
    const bottom = state?.box ? state.box.y + state.box.height : 0;
    return Math.max(highest, bottom);
  }, 0);

  return Math.max(Math.ceil(maxBottom), fallbackHeight, 1);
}

function getOrderedSectionInfo(
  layout: LayoutDocument,
  sections: SectionCapture[]
): SnapshotSectionInfo[] {
  const sectionById = new Map(sections.map((section) => [section.nodeId, section]));
  const nodeById = new Map(layout.nodes.map((node) => [node.id, node]));
  const baseInfos =
    layout.detectedSections.length > 0
      ? layout.detectedSections.map((section, index) => ({
          nodeId: section.id,
          name: sectionById.get(section.id)?.name ?? `${section.type}-${index + 1}`,
          type: sectionById.get(section.id)?.type ?? section.type
        }))
      : layout.sectionIds.map((sectionId, index) => ({
          nodeId: sectionId,
          name: sectionById.get(sectionId)?.name ?? `section-${index + 1}`,
          type: sectionById.get(sectionId)?.type ?? nodeById.get(sectionId)?.kind ?? "section"
        }));

  const seen = new Set<string>();

  return baseInfos
    .filter((info) => {
      if (seen.has(info.nodeId)) {
        return false;
      }

      seen.add(info.nodeId);
      return true;
    })
    .sort((left, right) => {
      const leftBox = sectionById.get(left.nodeId)?.box ?? nodeById.get(left.nodeId)?.box;
      const rightBox = sectionById.get(right.nodeId)?.box ?? nodeById.get(right.nodeId)?.box;

      return (leftBox?.y ?? 0) - (rightBox?.y ?? 0) || (leftBox?.x ?? 0) - (rightBox?.x ?? 0);
    });
}

function assessSectionSeparation(params: {
  capture: PageCapture;
  layout: LayoutDocument;
  sections: SectionCapture[];
}): SectionSeparationAssessment {
  const expectedSections = getOrderedSectionInfo(params.layout, params.sections);
  const sectionById = new Map(params.sections.map((section) => [section.nodeId, section]));
  const issues: SectionSeparationIssue[] = [];

  if (!expectedSections.length) {
    return {
      safe: false,
      issues: [
        {
          nodeId: params.layout.rootNodeId,
          name: "page-snapshot",
          type: "page",
          reason: "Nenhuma secao confiavel foi detectada para snapshot isolado."
        }
      ],
      fallbackReason:
        "Separacao por secoes desativada: nenhuma secao confiavel foi detectada no layout."
    };
  }

  expectedSections.forEach((info) => {
    const section = sectionById.get(info.nodeId);

    if (!section) {
      issues.push({
        ...info,
        reason: "A secao nao foi capturada com seguranca no navegador."
      });
      return;
    }

    if (!section.originalHtml.trim() || !section.htmlCandidate.trim()) {
      issues.push({
        ...info,
        reason: "O HTML congelado da secao ficou incompleto."
      });
    }

    if (section.box.width < 8 || section.box.height < 8) {
      issues.push({
        ...info,
        reason: "A caixa visual da secao ficou invalida para recorte seguro."
      });
    }

    params.capture.viewports.forEach((viewport) => {
      if (!section.viewports[viewport.name]?.snapshotDataUrl) {
        issues.push({
          ...info,
          reason: `A secao ficou sem snapshot ${viewport.name}.`
        });
      }
    });
  });

  const orderedCapturedSections = expectedSections
    .map((info) => sectionById.get(info.nodeId))
    .filter((section): section is SectionCapture => Boolean(section))
    .sort((left, right) => left.box.y - right.box.y || left.box.x - right.box.x);
  let coveredHeight = 0;
  let lastBottom = 0;

  orderedCapturedSections.forEach((section) => {
    const info = expectedSections.find((candidate) => candidate.nodeId === section.nodeId) ?? {
      nodeId: section.nodeId,
      name: section.name,
      type: section.type
    };
    const top = Math.max(section.box.y, 0);
    const bottom = top + Math.max(section.box.height, 0);

    if (top < lastBottom - 8) {
      issues.push({
        ...info,
        reason: "A secao sobrepoe outra secao e nao pode ser recortada com seguranca."
      });
    }

    coveredHeight += Math.max(0, bottom - Math.max(top, lastBottom));
    lastBottom = Math.max(lastBottom, bottom);
  });

  const pageHeight = resolveViewportPageHeight(params.capture, "desktop");
  const coverageRatio = pageHeight > 0 ? coveredHeight / pageHeight : 0;

  if (orderedCapturedSections.length !== expectedSections.length) {
    issues.push({
      nodeId: params.layout.rootNodeId,
      name: "page-snapshot",
      type: "page",
      reason:
        "Nem todas as secoes detectadas receberam um recorte visual completo para o snapshot."
    });
  }

  if (coverageRatio < 0.8) {
    issues.push({
      nodeId: params.layout.rootNodeId,
      name: "page-snapshot",
      type: "page",
      reason: `As secoes cobriram apenas ${toPercentLabel(
        coverageRatio
      )} da altura da pagina no desktop.`
    });
  }

  return {
    safe: issues.length === 0,
    issues,
    fallbackReason:
      issues.length > 0
        ? `Separacao por secoes desativada: ${issues
            .map((issue) => `${issue.name} (${issue.nodeId}) - ${issue.reason}`)
            .join(" | ")}`
        : undefined
  };
}

function clampRatio(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(Math.max(value, 0), 1);
}

function buildPageOverlayLinks(
  capture: PageCapture,
  viewportName: "desktop" | "tablet" | "mobile"
): SectionOverlayLink[] {
  const viewport = getViewportProfile(capture, viewportName);

  if (!viewport) {
    return [];
  }

  const pageHeight = resolveViewportPageHeight(capture, viewportName);
  const seen = new Set<string>();

  return capture.nodes
    .filter((node) => Boolean(node.asset.href?.trim()))
    .sort((left, right) => left.visualOrder - right.visualOrder)
    .flatMap((node) => {
      const href = node.asset.href?.trim();
      const state = node.viewportStates[viewportName];
      const box = state?.box;

      if (!href || !state?.isVisible || !box || box.width <= 0 || box.height <= 0) {
        return [];
      }

      const key = `${node.id}:${href}`;

      if (seen.has(key)) {
        return [];
      }

      seen.add(key);

      return [
        {
          nodeId: node.id,
          href,
          text:
            node.text ||
            node.attributes["aria-label"] ||
            node.attributes.title ||
            href,
          title: node.attributes.title || undefined,
          target: node.attributes.target || undefined,
          rel: node.attributes.rel || undefined,
          isButton: node.tag === "button" || node.attributes.role === "button",
          box: {
            x: box.x,
            y: box.y,
            width: box.width,
            height: box.height
          },
          relativeBox: {
            x: clampRatio(box.x / viewport.width),
            y: clampRatio(box.y / pageHeight),
            width: clampRatio(box.width / viewport.width),
            height: clampRatio(box.height / pageHeight)
          }
        }
      ];
    });
}

async function buildFullPageSnapshotSource(
  capture: PageCapture,
  layout: LayoutDocument
): Promise<SnapshotMarkupSource | null> {
  const desktopPath = capture.artifacts.screenshots.desktop;
  const desktopViewport = getViewportProfile(capture, "desktop");

  if (!desktopPath || !desktopViewport) {
    return null;
  }

  const buildViewport = async (
    viewportName: "desktop" | "tablet" | "mobile"
  ): Promise<SnapshotMarkupViewport | undefined> => {
    const screenshotPath = capture.artifacts.screenshots[viewportName];
    const viewport = getViewportProfile(capture, viewportName);

    if (!screenshotPath || !viewport) {
      return undefined;
    }

    return {
      width: viewport.width,
      height: resolveViewportPageHeight(capture, viewportName),
      snapshotDataUrl: await readSnapshotDataUrl(screenshotPath),
      linkOverlays: buildPageOverlayLinks(capture, viewportName)
    };
  };

  const desktop = await buildViewport("desktop");

  if (!desktop) {
    return null;
  }

  return {
    nodeId: layout.rootNodeId,
    desktop,
    tablet: await buildViewport("tablet"),
    mobile: await buildViewport("mobile")
  };
}

function createSyntheticPageSection(
  capture: PageCapture,
  layout: LayoutDocument,
  snapshotSource: SnapshotMarkupSource
): SectionCapture {
  return {
    id: "page-snapshot-capture",
    nodeId: layout.rootNodeId,
    name: "page-snapshot",
    type: "page",
    box: {
      x: 0,
      y: 0,
      width: snapshotSource.desktop.width,
      height: snapshotSource.desktop.height
    },
    subtreeNodeIds: [layout.rootNodeId],
    originalHtml: capture.renderedHtml,
    htmlCandidate: capture.renderedHtml,
    complexity: {
      nodeCount: capture.nodes.length,
      absoluteNodes: 0,
      overlappingNodes: 0,
      interactiveNodes: buildPageOverlayLinks(capture, "desktop").length,
      imageNodes: 0,
      overlayNodes: 0,
      complexZIndexNodes: 0,
      transformedNodes: 0,
      gradientNodes: 0,
      animatedNodes: 0,
      unsupportedCssNodes: 0,
      carouselNodes: 0,
      gridContainers: 0,
      flexContainers: 0,
      nestedFlexGridContainers: 0,
      maxFlexGridDepth: 0,
      pseudoElementNodes: 0,
      hasPseudoElements: false,
      hasTransforms: false,
      hasEmbeds: false
    },
    viewports: {
      desktop: {
        viewport: "desktop",
        ...snapshotSource.desktop
      },
      tablet: snapshotSource.tablet
        ? {
            viewport: "tablet",
            ...snapshotSource.tablet
          }
        : undefined,
      mobile: snapshotSource.mobile
        ? {
            viewport: "mobile",
            ...snapshotSource.mobile
          }
        : undefined
    }
  };
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
      )}; snapshot aplicado e fallback da pagina inteira foi armado.`;
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
          ? "Score abaixo de 97%; snapshot da pagina inteira foi armado como fallback final."
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
  const convertedScreenshotPath = params.outputDir
    ? `${params.outputDir}/snapshot-preview.png`
    : undefined;
  const sectionSeparation = assessSectionSeparation({
    capture: params.capture,
    layout: params.layout,
    sections: orderedSections
  });
  const initial = sectionSeparation.safe
    ? await buildInitialDecisions(orderedSections)
    : {
        decisions: [] as SnapshotDecision[],
        learningNotes: sectionSeparation.issues.map(
          (issue) => `${issue.name} (${issue.nodeId}): ${issue.reason}`
        ),
        requiresPixelPerfect: false,
        pixelPerfectReason: undefined
      };
  let decisions = initial.decisions;
  let previewHtml = buildPreviewHtml({
    capture: params.capture,
    decisions
  });
  let overallSimilarity =
    decisions.length > 0
      ? await computeOverallSimilarity({
          capture: params.capture,
          previewHtml,
          convertedScreenshotPath
        })
      : {
          passed: false,
          similarity: 0
        };
  let usedFullPageSnapshot = false;
  let fullPageFallbackReason = sectionSeparation.fallbackReason;
  let syntheticPageSection: SectionCapture | null = null;
  const diagnosticWarnings = sectionSeparation.issues.map(
    (issue) =>
      `Snapshot por secao desativado para ${issue.name} (${issue.nodeId}): ${issue.reason}`
  );

  const switchToFullPageSnapshot = async (reason: string) => {
    const snapshotSource = await buildFullPageSnapshotSource(params.capture, params.layout);

    if (!snapshotSource) {
      fullPageFallbackReason = reason;
      return false;
    }

    usedFullPageSnapshot = true;
    fullPageFallbackReason = reason;
    syntheticPageSection = createSyntheticPageSection(params.capture, params.layout, snapshotSource);
    const pageLinkCount = getUniqueLinkCount(syntheticPageSection);

    decisions = [
      {
        nodeId: syntheticPageSection.nodeId,
        name: syntheticPageSection.name,
        type: syntheticPageSection.type,
        mode: "snapshot",
        reason,
        similarity: 1,
        fidelityScore: 1,
        riskScore: 0,
        htmlBlocked: true,
        instabilityReasons: undefined,
        healingIssues: [],
        healingSteps: [
          reason,
          "Snapshot responsivo da pagina inteira aplicado com overlays de links."
        ],
        preservedLinks: pageLinkCount,
        totalLinks: pageLinkCount,
        widgetHtml: buildResponsiveSnapshotMarkup(snapshotSource),
        pixelPerfectRequired: false
      }
    ];
    previewHtml = buildPreviewHtml({
      capture: params.capture,
      decisions
    });
    overallSimilarity = await computeOverallSimilarity({
      capture: params.capture,
      previewHtml,
      convertedScreenshotPath
    });
    return true;
  };

  if (!sectionSeparation.safe) {
    await switchToFullPageSnapshot(
      sectionSeparation.fallbackReason ??
        "Separacao por secoes falhou; snapshot da pagina inteira aplicado."
    );
  } else {
    while (!overallSimilarity.passed) {
      const weakestHtmlDecision = decisions
        .filter((candidate) => candidate.mode === "html")
        .sort((left, right) => left.similarity - right.similarity)[0];

      if (!weakestHtmlDecision) {
        await switchToFullPageSnapshot(
          `Snapshots por secao ficaram em ${toPercentLabel(
            overallSimilarity.similarity
          )}; snapshot da pagina inteira aplicado.`
        );
        break;
      }

      const section = orderedSections.find(
        (candidate) => candidate.nodeId === weakestHtmlDecision.nodeId
      );

      if (!section) {
        break;
      }

      weakestHtmlDecision.mode = "snapshot";
      weakestHtmlDecision.reason = `Secao ${weakestHtmlDecision.name} (${weakestHtmlDecision.nodeId}) rebaixada para snapshot apos validacao global da pagina.`;
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
        convertedScreenshotPath
      });
    }
  }

  const contentSections =
    usedFullPageSnapshot
      ? syntheticPageSection
        ? [syntheticPageSection]
        : []
      : orderedSections;
  const content = decisions.flatMap((decision, index) => {
    const section = contentSections[index];

    if (!section) {
      return [];
    }

    return [
      buildContainerElement({
        section,
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
    ];
  });
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
  const warnings = diagnosticWarnings
    .concat(
      usedFullPageSnapshot && fullPageFallbackReason
        ? [fullPageFallbackReason]
        : [],
      sectionReports
        .filter((section) => section.mode === "snapshot")
        .map((section) => `${section.name} (${section.nodeId}) exportada como snapshot.`),
      overallSimilarity.passed
        ? []
        : [
            `Similaridade final da pagina ficou em ${toPercentLabel(
              overallSimilarity.similarity
            )}, abaixo do minimo de ${toPercentLabel(PAGE_SIMILARITY_THRESHOLD)}.`
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
      renderStrategy: usedFullPageSnapshot ? "full-page-snapshot" : "section-snapshots",
      fullPageFallbackReason,
      overallSimilarity: overallSimilarity.similarity,
      threshold: PAGE_SIMILARITY_THRESHOLD,
      convertedScreenshotPath,
      originalScreenshotPath: params.capture.artifacts.screenshots.desktop,
      sectionReports,
      requiresPixelPerfect: false,
      pixelPerfectReason: undefined,
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
