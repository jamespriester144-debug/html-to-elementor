import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import * as cheerio from "cheerio";

import type {
  CaptureViewportName,
  PageCapture,
  SectionCapture,
  SectionCaptureViewport,
  SectionOverlayLink
} from "@/lib/converter-v3/contracts/capture";
import type { LayoutDocument, OutputMode } from "@/lib/converter-v3/contracts/layout";
import type {
  SnapshotSectionValidationEntry,
  SnapshotSectionRenderMode,
  SnapshotSectionReport,
  SnapshotValidationLossType,
  SnapshotViewportValidation,
  SnapshotVisualSummary,
  SnapshotVisualValidationIssue,
  SnapshotVisualValidationReport
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
  readImageDimensions,
  renderHtmlToScreenshot
} from "@/lib/converter-v3/visual-similarity";
import { buildVisualSectionCaptures } from "@/lib/converter-v3/sections/visual-section-capture";
import { isForceVisualSnapshotEnabled, isVisualDebugEnabled } from "@/lib/env";
import type { ElementorDocument, ElementorElement } from "@/types/conversion";

type SnapshotDecision = SnapshotSectionReport & {
  widgetHtml: string;
  htmlSimilarity?: number;
  pixelPerfectRequired: boolean;
};

type ForceSnapshotDecision = SnapshotDecision & {
  fallbackStage?: "section-recapture" | "pure-snapshot" | "full-page-snapshot";
  viewportSimilarities?: Partial<Record<CaptureViewportName, number>>;
};

type ForceSectionValidationResult = {
  decision: ForceSnapshotDecision;
  passed: boolean;
  similarity: number;
  viewportResults: SnapshotViewportValidation[];
  issues: SnapshotVisualValidationIssue[];
};

type PageViewportValidationResult = SnapshotViewportValidation;

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

function describeFallbackStage(
  stage:
    | "section-snapshot"
    | "section-recapture"
    | "pure-snapshot"
    | "full-page-snapshot"
) {
  switch (stage) {
    case "section-recapture":
      return "section-recapture";
    case "pure-snapshot":
      return "pure-snapshot";
    case "full-page-snapshot":
      return "full-page-snapshot";
    default:
      return "section-snapshot";
  }
}

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

function shouldWriteVisualDebugArtifacts() {
  return isVisualDebugEnabled();
}

function buildDebugArtifactPath(outputDir: string | undefined, fileName: string) {
  if (!outputDir || !shouldWriteVisualDebugArtifacts()) {
    return undefined;
  }

  return path.join(outputDir, fileName);
}

async function copyDebugArtifact(
  sourcePath: string | undefined,
  outputDir: string | undefined,
  fileName: string
) {
  const targetPath = buildDebugArtifactPath(outputDir, fileName);

  if (!sourcePath || !targetPath) {
    return undefined;
  }

  if (sourcePath.startsWith("data:")) {
    const base64Payload = sourcePath.replace(/^data:[^;]+;base64,/, "");
    await writeFile(targetPath, Buffer.from(base64Payload, "base64")).catch(() => undefined);
    return targetPath;
  }

  if (path.resolve(sourcePath) === path.resolve(targetPath)) {
    return targetPath;
  }

  await copyFile(sourcePath, targetPath).catch(() => undefined);
  return targetPath;
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
      zIndex: number;
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
        zIndex: Math.max(overlay.zIndex ?? 0, 3),
        positions: {}
      };

      existing.positions[viewportName] = overlay.relativeBox;
      existing.zIndex = Math.max(existing.zIndex, overlay.zIndex ?? 0, 3);
      mergedLinks.set(key, existing);
    });
  }

  const scopeId = `converter-v3-snapshot-${snapshotSource.nodeId}`;
  const stageBaseStyles = [
    "position:relative",
    "display:block",
    "width:100%",
    `max-width:${Math.round(desktop.width)}px`,
    "margin:0 auto"
  ].join(";");
  const stageTabletStyles =
    tablet?.snapshotDataUrl
      ? [`max-width:${Math.round(tablet.width)}px`].join(";")
      : "";
  const stageMobileStyles =
    mobile?.snapshotDataUrl
      ? [`max-width:${Math.round(mobile.width)}px`].join(";")
      : "";
  const imageMarkup = [
    `<img class="converter-v3-snapshot-image converter-v3-snapshot-image-desktop" src="${escapeHtmlAttribute(
      desktop.snapshotDataUrl
    )}" alt="" width="${Math.max(Math.round(desktop.width), 1)}" height="${Math.max(
      Math.round(desktop.height),
      1
    )}" />`,
    tablet?.snapshotDataUrl
      ? `<img class="converter-v3-snapshot-image converter-v3-snapshot-image-tablet" src="${escapeHtmlAttribute(
          tablet.snapshotDataUrl
        )}" alt="" width="${Math.max(Math.round(tablet.width), 1)}" height="${Math.max(
          Math.round(tablet.height),
          1
        )}" />`
      : "",
    mobile?.snapshotDataUrl
      ? `<img class="converter-v3-snapshot-image converter-v3-snapshot-image-mobile" src="${escapeHtmlAttribute(
          mobile.snapshotDataUrl
        )}" alt="" width="${Math.max(Math.round(mobile.width), 1)}" height="${Math.max(
          Math.round(mobile.height),
          1
        )}" />`
      : ""
  ]
    .filter(Boolean)
    .join("");
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
        )};z-index:${Math.max(link.zIndex, 3)};}`
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
    #${scopeId} .converter-v3-snapshot-image{
      display:block;
      width:100%;
      height:auto;
      margin:0;
      padding:0;
      border:none;
    }
    #${scopeId} .converter-v3-snapshot-image-tablet,
    #${scopeId} .converter-v3-snapshot-image-mobile{
      display:none;
    }
    #${scopeId} .converter-v3-snapshot-link{
      position:absolute;
      display:block;
      background:transparent !important;
      border:none !important;
      box-shadow:none !important;
      outline:none !important;
      color:transparent !important;
      font-size:0 !important;
      line-height:0 !important;
      text-decoration:none !important;
      padding:0 !important;
      margin:0 !important;
      opacity:0 !important;
      appearance:none !important;
      pointer-events:auto !important;
      overflow:hidden;
    }
    ${
      stageTabletStyles
        ? `@media (max-width:${TABLET_BREAKPOINT}px){#${scopeId} .converter-v3-snapshot-stage{${stageTabletStyles}}#${scopeId} .converter-v3-snapshot-image-desktop{display:none;}#${scopeId} .converter-v3-snapshot-image-tablet{display:block;}#${scopeId} .converter-v3-snapshot-image-mobile{display:none;}}`
        : ""
    }
    ${
      stageMobileStyles
        ? `@media (max-width:${MOBILE_BREAKPOINT}px){#${scopeId} .converter-v3-snapshot-stage{${stageMobileStyles}}#${scopeId} .converter-v3-snapshot-image-desktop{display:none;}#${scopeId} .converter-v3-snapshot-image-tablet{display:none;}#${scopeId} .converter-v3-snapshot-image-mobile{display:block;}}`
        : ""
    }
    ${linkStyles}
  </style>
  <div class="converter-v3-snapshot-stage">${imageMarkup}${linksHtml}</div>
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
  if (
    params.capture.inputAnalysis.renderStrategy.preferFullPageSnapshot ||
    !params.capture.inputAnalysis.renderStrategy.safeSectionExtraction
  ) {
    return {
      safe: false,
      issues: [
        {
          nodeId: params.layout.rootNodeId,
          name: "page-snapshot",
          type: "page",
          reason:
            params.capture.inputAnalysis.renderStrategy.reasons.join(" ") ||
            "A analise universal marcou a divisao por secoes como insegura."
        }
      ],
      fallbackReason:
        params.capture.inputAnalysis.renderStrategy.reasons.join(" ") ||
        "A analise universal marcou a divisao por secoes como insegura; fallback para pagina inteira."
    };
  }

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

    if (section.debug?.unsafeSectionBoundary) {
      issues.push({
        ...info,
        reason: `unsafe-section-boundary: ${(section.debug.unsafeReasons ?? []).join(", ")}`
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
  viewportName: "desktop" | "tablet" | "mobile",
  pageSize?: {
    width: number;
    height: number;
  }
): SectionOverlayLink[] {
  const viewport = getViewportProfile(capture, viewportName);

  if (!viewport) {
    return [];
  }

  const pageHeight = pageSize?.height ?? resolveViewportPageHeight(capture, viewportName);
  const pageWidth = pageSize?.width ?? viewport.width;
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
          zIndex: Number.parseInt(node.computedStyles["z-index"] || "0", 10) || undefined,
          box: {
            x: box.x,
            y: box.y,
            width: box.width,
            height: box.height
          },
          relativeBox: {
            x: clampRatio(box.x / pageWidth),
            y: clampRatio(box.y / pageHeight),
            width: clampRatio(box.width / pageWidth),
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

    const dimensions = await readImageDimensions(screenshotPath);

    return {
      width: dimensions.width,
      height: dimensions.height,
      snapshotDataUrl: await readSnapshotDataUrl(screenshotPath),
      linkOverlays: buildPageOverlayLinks(capture, viewportName, dimensions)
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

function sanitizeFileSegment(value: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || "snapshot";
}

function buildStandaloneSectionPreviewHtml(params: {
  widgetHtml: string;
  viewportWidth: number;
}) {
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

      .converter-v3-standalone-snapshot {
        width: ${Math.max(Math.round(params.viewportWidth), 1)}px;
        max-width: 100%;
        margin: 0 auto;
      }
    </style>
  </head>
  <body>
    <div class="converter-v3-standalone-snapshot">${params.widgetHtml}</div>
  </body>
</html>`;
}

function inferSnapshotLossType(
  section: SectionCapture | null,
  viewport: SectionCaptureViewport | undefined,
  dimensionsDiffer: boolean
): SnapshotValidationLossType {
  if (dimensionsDiffer) {
    return "size";
  }

  if ((viewport?.linkOverlays.length ?? 0) > 0) {
    return section?.complexity.interactiveNodes ? "button" : "link";
  }

  if ((section?.complexity.imageNodes ?? 0) > 0) {
    return "image";
  }

  if (/background/i.test(section?.originalHtml ?? "")) {
    return "background";
  }

  const textOnly = (section?.originalHtml ?? "").replace(/<[^>]+>/g, " ").trim();
  if (textOnly) {
    return "text";
  }

  return "position";
}

function buildSnapshotValidationMessage(params: {
  viewport: CaptureViewportName;
  section?: SectionCapture | null;
  similarity: number;
  lossType: SnapshotValidationLossType;
  fallbackStage: SnapshotVisualValidationIssue["fallbackStage"];
}) {
  const label = params.section
    ? `${params.section.name} (${params.section.nodeId})`
    : "pagina inteira";

  return `Viewport ${params.viewport}; secao ${label}; similaridade ${toPercentLabel(
    params.similarity
  )}; perda detectada: ${params.lossType}; fallback usado: ${describeFallbackStage(
    params.fallbackStage
  )}.`;
}

function buildSectionDiagnosticSummary(
  section: SectionCapture | null | undefined,
  lossType: SnapshotValidationLossType,
  dimensionsDiffer: boolean
) {
  const diagnostics: string[] = [];

  if (dimensionsDiffer) {
    diagnostics.push("altura/largura da captura diferem da referencia");
    diagnostics.push("escala ou aspect-ratio do snapshot nao bate com a captura original");
  }

  if (lossType === "image") {
    diagnostics.push("imagem ausente ou renderizada fora da escala esperada");
  }

  if (lossType === "background") {
    diagnostics.push("background CSS presente na secao pode nao ter carregado ou foi recortado");
  }

  if (lossType === "button" || lossType === "link") {
    diagnostics.push("links ou botoes podem estar deslocados em relacao ao snapshot");
  }

  if (lossType === "position") {
    diagnostics.push("conteudo cortado, deslocado ou com bbox instavel");
  }

  if (!section && lossType === "position") {
    diagnostics.push("pagina inteira pode conter scrollbar, borda extra ou elemento fixed/sticky divergente");
  }

  if (!section && (lossType === "button" || lossType === "link")) {
    diagnostics.push("overlays de links podem estar fora da posicao sobre o snapshot full-page");
  }

  if (section?.debug?.unsafeSectionBoundary) {
    diagnostics.push(
      `secao marcada como unsafe-section-boundary: ${(section.debug.unsafeReasons ?? []).join(
        ", "
      )}`
    );
  }

  if ((section?.debug?.positionedElements.length ?? 0) > 0) {
    diagnostics.push("ha elementos absolute/fixed/sticky/transform dentro ou sobrepondo a secao");
  }

  if ((section?.debug?.cssBackgrounds.length ?? 0) > 0) {
    diagnostics.push("a secao usa backgrounds CSS que precisam ser preservados na captura");
  }

  if ((section?.debug?.loadedFonts.length ?? 0) > 0) {
    diagnostics.push("a secao depende de fontes carregadas em runtime");
  }

  return [...new Set(diagnostics)];
}

async function writeSectionVisualDebugReport(params: {
  section: SectionCapture;
  outputDir?: string;
  stage: "section-snapshot" | "section-recapture" | "pure-snapshot";
  viewportName: CaptureViewportName;
  similarity: number;
  lossType?: SnapshotValidationLossType;
  originalScreenshotPath?: string;
  convertedScreenshotPath?: string;
  diffScreenshotPath?: string;
  dimensionsDiffer?: boolean;
}) {
  if (!shouldWriteVisualDebugArtifacts() || !params.outputDir || params.viewportName !== "desktop") {
    return;
  }

  const debugJsonPath = buildDebugArtifactPath(
    params.outputDir,
    `${params.section.nodeId}-debug.json`
  );

  const copiedOriginalPath = await copyDebugArtifact(
    params.originalScreenshotPath,
    params.outputDir,
    `${params.section.nodeId}-original.png`
  );
  const copiedConvertedPath = await copyDebugArtifact(
    params.convertedScreenshotPath,
    params.outputDir,
    `${params.section.nodeId}-converted.png`
  );
  const copiedDiffPath = await copyDebugArtifact(
    params.diffScreenshotPath,
    params.outputDir,
    `${params.section.nodeId}-diff.png`
  );

  if (!debugJsonPath) {
    return;
  }

  const desktopViewport = params.section.viewports.desktop ?? Object.values(params.section.viewports)[0];
  const debugPayload = {
    nodeId: params.section.nodeId,
    name: params.section.name,
    type: params.section.type,
    stage: params.stage,
    similarity: params.similarity,
    lossType: params.lossType,
    originalHtml: params.section.originalHtml,
    boundingBox: params.section.debug?.sectionBoundingBox ?? params.section.box,
    captureBox: params.section.debug?.captureBoundingBox ?? desktopViewport?.captureBox,
    sectionWidth: params.section.debug?.sectionWidth ?? params.section.box.width,
    sectionHeight: params.section.debug?.sectionHeight ?? params.section.box.height,
    screenshotOriginal: copiedOriginalPath ?? params.originalScreenshotPath,
    screenshotConverted: copiedConvertedPath ?? params.convertedScreenshotPath,
    screenshotDiff: copiedDiffPath ?? params.diffScreenshotPath,
    images: params.section.debug?.originalImages ?? [],
    backgrounds: params.section.debug?.cssBackgrounds ?? [],
    loadedFonts: params.section.debug?.loadedFonts ?? [],
    linksAndButtons: params.section.debug?.interactiveElements ?? [],
    positionedElements: params.section.debug?.positionedElements ?? [],
    unsafeSectionBoundary: params.section.debug?.unsafeSectionBoundary ?? false,
    unsafeReasons: params.section.debug?.unsafeReasons ?? [],
    captureStrategy: desktopViewport?.captureStrategy,
    invadingNodeIds: desktopViewport?.invadingNodeIds ?? [],
    diagnosticSummary: buildSectionDiagnosticSummary(
      params.section,
      params.lossType ?? "position",
      Boolean(params.dimensionsDiffer)
    )
  };

  await writeFile(debugJsonPath, JSON.stringify(debugPayload, null, 2), "utf8");
}

async function writeFullPageVisualDebugArtifacts(params: {
  outputDir?: string;
  originalScreenshotPath?: string;
  convertedScreenshotPath?: string;
  diffScreenshotPath?: string;
}) {
  if (!shouldWriteVisualDebugArtifacts() || !params.outputDir) {
    return;
  }

  await copyDebugArtifact(
    params.originalScreenshotPath,
    params.outputDir,
    "original-full-page.png"
  );
  await copyDebugArtifact(
    params.convertedScreenshotPath,
    params.outputDir,
    "converted-full-page.png"
  );
  await copyDebugArtifact(params.diffScreenshotPath, params.outputDir, "full-page-diff.png");
}

function summarizeVisualDiagnostics(
  issues: SnapshotVisualValidationIssue[],
  sections: SectionCapture[]
) {
  const sectionById = new Map(sections.map((section) => [section.nodeId, section]));
  const diagnostics = issues.flatMap((issue) =>
    buildSectionDiagnosticSummary(
      issue.sectionId ? sectionById.get(issue.sectionId) : null,
      issue.lossType,
      issue.lossType === "size"
    )
  );

  return [...new Set(diagnostics)];
}

function collectVisualDebugArtifacts(params: {
  outputDir?: string;
  sections: SectionCapture[];
}): string[] {
  if (!shouldWriteVisualDebugArtifacts() || !params.outputDir) {
    return [];
  }

  const artifactPaths = [
    buildDebugArtifactPath(params.outputDir, "original-full-page.png"),
    buildDebugArtifactPath(params.outputDir, "converted-full-page.png"),
    buildDebugArtifactPath(params.outputDir, "full-page-diff.png"),
    buildDebugArtifactPath(params.outputDir, "visual-validation-report.json"),
    ...params.sections.flatMap((section) => [
      buildDebugArtifactPath(params.outputDir, `${section.nodeId}-original.png`),
      buildDebugArtifactPath(params.outputDir, `${section.nodeId}-converted.png`),
      buildDebugArtifactPath(params.outputDir, `${section.nodeId}-diff.png`),
      buildDebugArtifactPath(params.outputDir, `${section.nodeId}-debug.json`)
    ])
  ].filter((candidate): candidate is string => Boolean(candidate));

  return [...new Set(artifactPaths)];
}

async function validateSnapshotSectionAcrossViewports(params: {
  section: SectionCapture;
  widgetHtml: string;
  outputDir?: string;
  stage: "section-snapshot" | "section-recapture" | "pure-snapshot";
}): Promise<ForceSectionValidationResult> {
  const viewportNames = ["desktop", "tablet", "mobile"] as const;
  const viewportResults: SnapshotViewportValidation[] = [];
  const issues: SnapshotVisualValidationIssue[] = [];
  const viewportSimilarities: Partial<Record<CaptureViewportName, number>> = {};
  let minSimilarity = 1;

  for (const viewportName of viewportNames) {
    const viewport = params.section.viewports[viewportName];

    if (!viewport?.snapshotDataUrl) {
      continue;
    }

    const baseName = sanitizeFileSegment(`${params.section.nodeId}-${params.stage}-${viewportName}`);
    const convertedScreenshotPath = params.outputDir
      ? shouldWriteVisualDebugArtifacts() && viewportName === "desktop"
        ? path.join(params.outputDir, `${params.section.nodeId}-converted.png`)
        : path.join(params.outputDir, `${baseName}-converted.png`)
      : undefined;
    const diffScreenshotPath = params.outputDir
      ? shouldWriteVisualDebugArtifacts() && viewportName === "desktop"
        ? path.join(params.outputDir, `${params.section.nodeId}-diff.png`)
        : path.join(params.outputDir, `${baseName}-diff.png`)
      : undefined;
    const rendered = await renderHtmlToScreenshot({
      html: buildStandaloneSectionPreviewHtml({
        widgetHtml: params.widgetHtml,
        viewportWidth: viewport.width
      }),
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      outputPath: convertedScreenshotPath,
      fullPage: true
    });
    const comparison = await compareImagesPixelByPixel({
      reference: viewport.snapshotPath ?? viewport.snapshotDataUrl,
      candidate: rendered.dataUrl,
      similarityThreshold: PAGE_SIMILARITY_THRESHOLD,
      diffOutputPath: diffScreenshotPath
    });
    const result = {
      viewport: viewportName,
      passed: comparison.passed,
      similarity: comparison.similarity,
      originalScreenshotPath: viewport.snapshotPath,
      convertedScreenshotPath,
      diffScreenshotPath: comparison.diffOutputPath
    } satisfies SnapshotViewportValidation;

    viewportResults.push(result);
    viewportSimilarities[viewportName] = comparison.similarity;
    minSimilarity = Math.min(minSimilarity, comparison.similarity);

    await writeSectionVisualDebugReport({
      section: params.section,
      outputDir: params.outputDir,
      stage: params.stage,
      viewportName,
      similarity: comparison.similarity,
      lossType: inferSnapshotLossType(params.section, viewport, comparison.dimensionsDiffer),
      originalScreenshotPath: viewport.snapshotPath,
      convertedScreenshotPath,
      diffScreenshotPath: comparison.diffOutputPath,
      dimensionsDiffer: comparison.dimensionsDiffer
    });

    if (!comparison.passed) {
      const lossType = inferSnapshotLossType(params.section, viewport, comparison.dimensionsDiffer);
      issues.push({
        viewport: viewportName,
        sectionId: params.section.nodeId,
        sectionName: params.section.name,
        sectionType: params.section.type,
        similarity: comparison.similarity,
        lossType,
        fallbackStage: params.stage,
        fallbackUsed: params.stage,
        originalScreenshotPath: viewport.snapshotPath,
        convertedScreenshotPath,
        diffScreenshotPath: comparison.diffOutputPath,
        message: buildSnapshotValidationMessage({
          viewport: viewportName,
          section: params.section,
          similarity: comparison.similarity,
          lossType,
          fallbackStage: params.stage
        })
      });
    }
  }

  const decision: ForceSnapshotDecision = {
    nodeId: params.section.nodeId,
    name: params.section.name,
    type: params.section.type,
    mode: "snapshot",
    reason:
      params.stage === "section-recapture"
        ? "Secao recapturada com bounding box expandida, elementos absolute/fixed invadindo a area, lazy-load/imagens/fontes estabilizados e animacoes desligadas."
        : params.stage === "pure-snapshot"
          ? "Secao forcada para snapshot visual puro com overlays transparentes."
          : "Secao exportada como snapshot visual principal.",
    similarity: minSimilarity,
    fidelityScore: minSimilarity,
    preservedLinks: getUniqueLinkCount(params.section),
    totalLinks: getUniqueLinkCount(params.section),
    htmlBlocked: true,
    healingIssues: [],
    healingSteps: [],
    widgetHtml: params.widgetHtml,
    pixelPerfectRequired: false,
    fallbackStage: params.stage === "section-snapshot" ? undefined : params.stage,
    viewportSimilarities
  };

  return {
    decision,
    passed: viewportResults.every((result) => result.passed),
    similarity: minSimilarity,
    viewportResults,
    issues
  };
}

async function validatePreviewAcrossViewports(params: {
  capture: PageCapture;
  previewHtml: string;
  outputDir?: string;
  mode: "section-snapshot" | "full-page-snapshot";
}): Promise<{
  passed: boolean;
  similarity: number;
  viewportResults: PageViewportValidationResult[];
  issues: SnapshotVisualValidationIssue[];
}> {
  const viewportResults: PageViewportValidationResult[] = [];
  const issues: SnapshotVisualValidationIssue[] = [];
  let minSimilarity = 1;

  for (const viewport of params.capture.viewports) {
    const referencePath = params.capture.artifacts.screenshots[viewport.name];

    if (!referencePath) {
      continue;
    }

    const baseName = sanitizeFileSegment(`${params.mode}-${viewport.name}`);
    const convertedScreenshotPath = params.outputDir
      ? shouldWriteVisualDebugArtifacts() && viewport.name === "desktop"
        ? path.join(params.outputDir, "converted-full-page.png")
        : path.join(params.outputDir, `${baseName}-converted.png`)
      : undefined;
    const diffScreenshotPath = params.outputDir
      ? shouldWriteVisualDebugArtifacts() && viewport.name === "desktop"
        ? path.join(params.outputDir, "full-page-diff.png")
        : path.join(params.outputDir, `${baseName}-diff.png`)
      : undefined;
    const rendered = await renderHtmlToScreenshot({
      html: params.previewHtml,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      outputPath: convertedScreenshotPath,
      fullPage: true
    });
    const comparison = await compareImagesPixelByPixel({
      reference: referencePath,
      candidate: rendered.dataUrl,
      similarityThreshold: PAGE_SIMILARITY_THRESHOLD,
      diffOutputPath: diffScreenshotPath
    });
    const result = {
      viewport: viewport.name,
      passed: comparison.passed,
      similarity: comparison.similarity,
      originalScreenshotPath: referencePath,
      convertedScreenshotPath,
      diffScreenshotPath: comparison.diffOutputPath
    } satisfies SnapshotViewportValidation;

    viewportResults.push(result);
    minSimilarity = Math.min(minSimilarity, comparison.similarity);

    if (viewport.name === "desktop") {
      await writeFullPageVisualDebugArtifacts({
        outputDir: params.outputDir,
        originalScreenshotPath: referencePath,
        convertedScreenshotPath,
        diffScreenshotPath: comparison.diffOutputPath
      });
    }

    if (!comparison.passed) {
      const lossType: SnapshotValidationLossType = comparison.dimensionsDiffer
        ? "size"
        : "position";
      issues.push({
        viewport: viewport.name,
        similarity: comparison.similarity,
        lossType,
        fallbackStage: params.mode,
        fallbackUsed: params.mode,
        originalScreenshotPath: referencePath,
        convertedScreenshotPath,
        diffScreenshotPath: comparison.diffOutputPath,
        message: buildSnapshotValidationMessage({
          viewport: viewport.name,
          similarity: comparison.similarity,
          lossType,
          fallbackStage: params.mode
        })
      });
    }
  }

  return {
    passed: viewportResults.every((result) => result.passed),
    similarity: viewportResults.length > 0 ? minSimilarity : 0,
    viewportResults,
    issues
  };
}

function createSectionSnapshotEntry(
  decision: ForceSnapshotDecision
): SnapshotSectionValidationEntry {
  return {
    nodeId: decision.nodeId,
    name: decision.name,
    type: decision.type,
    similarity: decision.similarity,
    viewportSimilarities: decision.viewportSimilarities ?? {},
    fallbackStage: decision.fallbackStage,
    preservedLinks: decision.preservedLinks,
    totalLinks: decision.totalLinks
  };
}

function buildSnapshotWarnings(
  issues: SnapshotVisualValidationIssue[]
) {
  return issues.map(
    (issue) =>
      `[visual-validation] viewport=${issue.viewport} secao=${
        issue.sectionName && issue.sectionId
          ? `${issue.sectionName} (${issue.sectionId})`
          : issue.sectionId ?? "pagina inteira"
      } similaridade=${toPercentLabel(issue.similarity)} perda=${issue.lossType} fallback=${issue.fallbackUsed} original=${
        issue.originalScreenshotPath ?? "n/a"
      } convertido=${issue.convertedScreenshotPath ?? "n/a"} diff=${
        issue.diffScreenshotPath ?? "n/a"
      }`
  );
}

async function createForceVisualSnapshotDocumentV3(params: {
  capture: PageCapture;
  layout: LayoutDocument;
  sections: SectionCapture[];
  selectedMode: OutputMode;
  outputDir?: string;
}): Promise<SnapshotEmitterResult> {
  const orderedSections = [...params.sections].sort(
    (left, right) => left.box.y - right.box.y || left.box.x - right.box.x
  );
  const sectionSeparation = assessSectionSeparation({
    capture: params.capture,
    layout: params.layout,
    sections: orderedSections
  });
  const encounteredIssues: SnapshotVisualValidationIssue[] = [];
  const warnings = sectionSeparation.issues.map(
    (issue) =>
      `Separacao por secao insegura em ${issue.name} (${issue.nodeId}): ${issue.reason}`
  );
  const mergeIssues = (issues: SnapshotVisualValidationIssue[]) => {
    encounteredIssues.push(...issues);
    warnings.push(...buildSnapshotWarnings(issues));
  };
  const finalizeSnapshot = async (params2: {
    decisions: ForceSnapshotDecision[];
    contentSections: SectionCapture[];
    renderStrategy: "section-snapshots" | "full-page-snapshot";
    fullPageFallbackReason?: string;
    finalValidation: Awaited<ReturnType<typeof validatePreviewAcrossViewports>>;
    blockingReason?: string;
  }): Promise<SnapshotEmitterResult> => {
    const previewHtml = buildPreviewHtml({
      capture: params.capture,
      decisions: params2.decisions
    });
    const content = params2.decisions.flatMap((decision, index) => {
      const section = params2.contentSections[index];

      if (!section) {
        return [];
      }

      return [
        buildContainerElement({
          section,
          widgetHtml: decision.widgetHtml,
          mode: "snapshot",
          similarity: decision.similarity,
          fidelityScore: decision.fidelityScore,
          riskScore: decision.riskScore,
          htmlBlocked: true,
          instabilityReasons: decision.instabilityReasons,
          healingSteps: decision.healingSteps,
          index
        })
      ];
    });
    const sectionReports = params2.decisions.map<SnapshotSectionReport>((decision) => ({
      nodeId: decision.nodeId,
      name: decision.name,
      type: decision.type,
      mode: "snapshot",
      reason: decision.reason,
      similarity: decision.similarity,
      fidelityScore: decision.fidelityScore,
      riskScore: decision.riskScore,
      htmlBlocked: true,
      instabilityReasons: decision.instabilityReasons,
      healingIssues: decision.healingIssues,
      healingSteps: decision.healingSteps,
      preservedLinks: decision.preservedLinks,
      totalLinks: decision.totalLinks
    }));
    const modeUsed =
      params2.renderStrategy === "full-page-snapshot"
        ? "full-page-snapshot"
        : params2.decisions.some((decision) => Boolean(decision.fallbackStage))
          ? "section-fallback"
          : "section-snapshot";
    const sectionsApproved = params2.decisions
      .filter((decision) => !decision.fallbackStage)
      .map(createSectionSnapshotEntry);
    const sectionsWithFallback = params2.decisions
      .filter((decision) => Boolean(decision.fallbackStage))
      .map(createSectionSnapshotEntry);
    const viewportSimilarities = Object.fromEntries(
      params2.finalValidation.viewportResults.map((result) => [result.viewport, result.similarity])
    ) as Partial<Record<CaptureViewportName, number>>;
    const totalLinks = sectionReports.reduce((sum, section) => sum + section.totalLinks, 0);
    const preservedLinks = sectionReports.reduce(
      (sum, section) => sum + section.preservedLinks,
      0
    );
    const blockingReason = params2.finalValidation.passed
      ? undefined
      : params2.blockingReason ??
        `Snapshot visual falhou apos todos os fallbacks; similaridade final ${toPercentLabel(
          params2.finalValidation.similarity
        )} abaixo de ${toPercentLabel(PAGE_SIMILARITY_THRESHOLD)}.`;
    const desktopViewport = params2.finalValidation.viewportResults.find(
      (result) => result.viewport === "desktop"
    );
    const issues = [
      ...new Map(
        encounteredIssues
          .concat(params2.finalValidation.issues)
          .map((issue) => [
            `${issue.viewport}:${issue.sectionId ?? "page"}:${issue.fallbackStage}:${issue.message}`,
            issue
          ])
      ).values()
    ];
    const diagnosticSummary = [
      ...new Set(
        [
          ...sectionSeparation.issues.map(
            (issue) => `${issue.name} (${issue.nodeId}): ${issue.reason}`
          ),
          ...summarizeVisualDiagnostics(issues, params2.contentSections),
          params2.fullPageFallbackReason ? `fallback global: ${params2.fullPageFallbackReason}` : "",
          blockingReason ? `motivo do bloqueio: ${blockingReason}` : ""
        ].filter(Boolean)
      )
    ];
    const visualValidationReport: SnapshotVisualValidationReport = {
      status: params2.finalValidation.passed ? "passed" : "blocked",
      modeUsed,
      viewportsTested: params2.finalValidation.viewportResults.map((result) => result.viewport),
      sectionsApproved,
      sectionsWithFallback,
      linksPreserved: preservedLinks,
      totalLinks,
      similarityFinal: params2.finalValidation.similarity,
      viewportResults: params2.finalValidation.viewportResults,
      issues,
      diagnosticSummary,
      debugArtifacts: collectVisualDebugArtifacts({
        outputDir: params.outputDir,
        sections: params2.contentSections
      }),
      blockingReason
    };
    const result: SnapshotEmitterResult = {
      document: {
        version: "1.0",
        title: params.capture.title,
        type: "page",
        content
      },
      previewHtml,
      snapshot: {
        renderStrategy: params2.renderStrategy,
        fullPageFallbackReason: params2.fullPageFallbackReason,
        overallSimilarity: params2.finalValidation.similarity,
        threshold: PAGE_SIMILARITY_THRESHOLD,
        convertedScreenshotPath: desktopViewport?.convertedScreenshotPath,
        originalScreenshotPath: desktopViewport?.originalScreenshotPath,
        viewportSimilarities,
        sectionReports,
        requiresPixelPerfect: false,
        pixelPerfectReason: undefined,
        learningNotes: sectionSeparation.issues.map(
          (issue) => `${issue.name} (${issue.nodeId}): ${issue.reason}`
        ),
        visualValidationReport,
        totals: {
          htmlSections: 0,
          snapshotSections: sectionReports.length,
          pixelPerfectRequiredSections: 0,
          preservedLinks,
          totalLinks
        }
      },
      warnings: [...new Set([...warnings, ...(blockingReason ? [blockingReason] : [])])]
    };

    const debugReportPath = buildDebugArtifactPath(params.outputDir, "visual-validation-report.json");

    if (debugReportPath) {
      await writeFile(
        debugReportPath,
        JSON.stringify(result.snapshot.visualValidationReport, null, 2),
        "utf8"
      );
    }

    return result;
  };

  const buildSnapshotDecision = (
    section: SectionCapture,
    stage:
      | "section-snapshot"
      | "section-recapture"
      | "pure-snapshot"
      | "full-page-snapshot",
    reason: string
  ): ForceSnapshotDecision => ({
    nodeId: section.nodeId,
    name: section.name,
    type: section.type,
    mode: "snapshot",
    reason,
    similarity: 1,
    fidelityScore: 1,
    riskScore: 0,
    htmlBlocked: true,
    healingIssues: [],
    healingSteps: [reason],
    preservedLinks: getUniqueLinkCount(section),
    totalLinks: getUniqueLinkCount(section),
    widgetHtml: buildSectionSnapshotMarkup(section),
    pixelPerfectRequired: false,
    fallbackStage: stage === "section-snapshot" ? undefined : stage,
    viewportSimilarities: {}
  });

  const buildFullPageResult = async (reason: string) => {
    const snapshotSource = await buildFullPageSnapshotSource(params.capture, params.layout);

    if (!snapshotSource) {
      const finalValidation = {
        passed: false,
        similarity: 0,
        viewportResults: [] as SnapshotViewportValidation[],
        issues: encounteredIssues
      };

      return finalizeSnapshot({
        decisions: [],
        contentSections: [],
        renderStrategy: "full-page-snapshot",
        fullPageFallbackReason: reason,
        finalValidation,
        blockingReason: `${reason} Snapshot da pagina inteira nao pode ser gerado, entao a exportacao foi bloqueada.`
      });
    }

    const pageSection = createSyntheticPageSection(params.capture, params.layout, snapshotSource);
    const decision = buildSnapshotDecision(
      pageSection,
      "full-page-snapshot",
      `${reason} Snapshot da pagina inteira aplicado com overlays transparentes.`
    );
    const previewHtml = buildPreviewHtml({
      capture: params.capture,
      decisions: [decision]
    });
    const finalValidation = await validatePreviewAcrossViewports({
      capture: params.capture,
      previewHtml,
      outputDir: params.outputDir,
      mode: "full-page-snapshot"
    });

    if (!finalValidation.passed) {
      mergeIssues(finalValidation.issues);
    }

    return finalizeSnapshot({
      decisions: [decision],
      contentSections: [pageSection],
      renderStrategy: "full-page-snapshot",
      fullPageFallbackReason: reason,
      finalValidation,
      blockingReason: finalValidation.passed
        ? undefined
        : `${reason} Snapshot da pagina inteira falhou na validacao visual com similaridade ${toPercentLabel(
            finalValidation.similarity
          )}.`
    });
  };

  if (!sectionSeparation.safe || orderedSections.length === 0) {
    return buildFullPageResult(
      sectionSeparation.fallbackReason ??
        "Separacao por secoes falhou; usando snapshot da pagina inteira."
    );
  }

  let activeSections = [...orderedSections];
  let decisions = activeSections.map((section) =>
    buildSnapshotDecision(section, "section-snapshot", "Secao exportada como snapshot visual principal.")
  );
  let validations: ForceSectionValidationResult[] = [];

  const runSectionValidation = async (
    stage: "section-snapshot" | "section-recapture" | "pure-snapshot"
  ) => {
    validations = [];

    for (const section of activeSections) {
      const decision = decisions.find((candidate) => candidate.nodeId === section.nodeId);
      const validation = await validateSnapshotSectionAcrossViewports({
        section,
        widgetHtml: decision?.widgetHtml ?? buildSectionSnapshotMarkup(section),
        outputDir: params.outputDir,
        stage
      });

      validations.push(validation);
    }

    mergeIssues(validations.flatMap((validation) => validation.issues));
    decisions = validations.map((validation) => ({
      ...validation.decision,
      reason:
        decisions.find((candidate) => candidate.nodeId === validation.decision.nodeId)?.reason ??
        validation.decision.reason
    }));
  };

  await runSectionValidation("section-snapshot");

  let failedSectionIds = validations
    .filter((validation) => !validation.passed)
    .map((validation) => validation.decision.nodeId);

  if (failedSectionIds.length > 0 && params.outputDir) {
    warnings.push(
      `Falha visual em ${failedSectionIds.length} secao(oes); recaptura com bounding box maior, overlays invadindo a secao, lazy-load/imagens/fontes estabilizados e animacoes desligadas foi iniciada.`
    );
    const retriedSections = await buildVisualSectionCaptures({
      capture: params.capture,
      layout: params.layout,
      outputDir: params.outputDir,
      sectionNodeIds: failedSectionIds,
      capturePadding: 48,
      fileSuffix: "retry"
    });
    const retriedById = new Map(retriedSections.map((section) => [section.nodeId, section]));

    activeSections = activeSections.map((section) => retriedById.get(section.nodeId) ?? section);
    decisions = activeSections.map((section) =>
      buildSnapshotDecision(
        section,
        failedSectionIds.includes(section.nodeId) ? "section-recapture" : "section-snapshot",
        failedSectionIds.includes(section.nodeId)
          ? "Secao recapturada com bounding box maior, elementos absolute/fixed invadindo a secao, imagens/fontes/lazy-load estabilizados e animacoes desligadas."
          : "Secao exportada como snapshot visual principal."
      )
    );
    await runSectionValidation("section-recapture");
    failedSectionIds = validations
      .filter((validation) => !validation.passed)
      .map((validation) => validation.decision.nodeId);
  }

  if (failedSectionIds.length > 0) {
    warnings.push(
      `Secoes ${failedSectionIds.join(", ")} continuaram abaixo de 99%; snapshot visual puro sera usado antes do fallback global.`
    );
    decisions = activeSections.map((section) =>
      buildSnapshotDecision(
        section,
        failedSectionIds.includes(section.nodeId) ? "pure-snapshot" : "section-snapshot",
        failedSectionIds.includes(section.nodeId)
          ? "Secao substituida por snapshot visual puro com overlays transparentes."
          : "Secao exportada como snapshot visual principal."
      )
    );
    await runSectionValidation("pure-snapshot");
    failedSectionIds = validations
      .filter((validation) => !validation.passed)
      .map((validation) => validation.decision.nodeId);
  }

  if (failedSectionIds.length > 0) {
    return buildFullPageResult(
      `Secoes ${failedSectionIds.join(", ")} continuaram falhando apos retry e snapshot puro.`
    );
  }

  const previewHtml = buildPreviewHtml({
    capture: params.capture,
    decisions
  });
  const finalValidation = await validatePreviewAcrossViewports({
    capture: params.capture,
    previewHtml,
    outputDir: params.outputDir,
    mode: "section-snapshot"
  });

  if (!finalValidation.passed) {
    mergeIssues(finalValidation.issues);
    return buildFullPageResult(
      `Snapshot por secao caiu para ${toPercentLabel(
        finalValidation.similarity
      )}; fallback final para snapshot da pagina inteira.`
    );
  }

  return finalizeSnapshot({
    decisions,
    contentSections: activeSections,
    renderStrategy: "section-snapshots",
    finalValidation
  });
}

export async function createSnapshotElementorDocumentV3(params: {
  capture: PageCapture;
  layout: LayoutDocument;
  sections: SectionCapture[];
  selectedMode: OutputMode;
  outputDir?: string;
}): Promise<SnapshotEmitterResult> {
  if (isForceVisualSnapshotEnabled()) {
    return createForceVisualSnapshotDocumentV3(params);
  }

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
