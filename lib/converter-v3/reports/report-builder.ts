import type { PageCapture } from "@/lib/converter-v3/contracts/capture";
import type { ComplexityAnalysis, LayoutDocument, OutputMode } from "@/lib/converter-v3/contracts/layout";
import type {
  ExportReport,
  SnapshotVisualSummary,
  VisualValidationIssueSummary,
  VisualValidationReport
} from "@/lib/converter-v3/contracts/output";

function formatPercent(value: number) {
  return `${(value * 100).toFixed(2)}%`;
}

function formatFriendlyPercent(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function formatBox(box: {
  x: number;
  y: number;
  width: number;
  height: number;
}) {
  return `x=${Math.round(box.x)} y=${Math.round(box.y)} w=${Math.round(box.width)} h=${Math.round(
    box.height
  )}`;
}

function getUniqueSectionLinkCount(section: NonNullable<PageCapture["sections"]>[number]) {
  const uniqueLinks = new Set<string>();

  Object.values(section.viewports).forEach((viewport) => {
    viewport?.linkOverlays.forEach((overlay) => {
      uniqueLinks.add(`${overlay.nodeId}:${overlay.href}`);
    });
  });

  return uniqueLinks.size;
}

function buildVisualIssues(snapshot?: SnapshotVisualSummary): VisualValidationIssueSummary[] {
  return (
    snapshot?.visualValidationReport?.issues.map((issue) => ({
      sectionId: issue.sectionId,
      sectionName: issue.sectionName,
      sectionType: issue.sectionType,
      viewport: issue.viewport,
      similarity: issue.similarity,
      lossType: issue.lossType,
      fallbackStage: issue.fallbackStage,
      message: issue.message
    })) ?? []
  );
}

function humanizeSectionType(type?: string) {
  switch ((type ?? "").toLowerCase()) {
    case "hero":
      return "Hero";
    case "faq":
      return "FAQ";
    case "cta":
      return "CTA";
    case "header":
      return "Header";
    case "footer":
      return "Footer";
    case "grid":
      return "Cards";
    default:
      return "Secao";
  }
}

function toFriendlyViewportLabel(viewport: "desktop" | "tablet" | "mobile") {
  switch (viewport) {
    case "desktop":
      return "Desktop";
    case "tablet":
      return "Tablet";
    case "mobile":
      return "Mobile";
  }
}

function pluralize(count: number, singular: string, plural: string) {
  return count === 1 ? singular : plural;
}

function resolveFriendlyProblemMessage(params: {
  issue: NonNullable<SnapshotVisualSummary["visualValidationReport"]>["issues"][number];
  section?: NonNullable<PageCapture["sections"]>[number];
}) {
  const sectionType = (params.issue.sectionType ?? params.section?.type ?? "").toLowerCase();
  const sectionLabel = humanizeSectionType(sectionType);
  const imageCount = Math.max(params.section?.debug?.originalImages.length ?? 0, 1);
  const backgroundCount = Math.max(params.section?.debug?.cssBackgrounds.length ?? 0, 1);
  const linkCount = Math.max(
    params.section?.debug?.interactiveElements.filter((element) => Boolean(element.href)).length ?? 0,
    1
  );
  const buttonCount = Math.max(
    params.section?.debug?.interactiveElements.filter((element) => element.isButton).length ?? 0,
    1
  );

  if (params.issue.lossType === "image") {
    return `secao ${sectionLabel} perdeu ${imageCount} ${pluralize(imageCount, "imagem", "imagens")}`;
  }

  if (params.issue.lossType === "background") {
    return `secao ${sectionLabel} perdeu ${backgroundCount} ${pluralize(
      backgroundCount,
      "background",
      "backgrounds"
    )}`;
  }

  if (params.issue.lossType === "button") {
    return `secao ${sectionLabel} perdeu ${buttonCount} ${pluralize(buttonCount, "botao", "botoes")}`;
  }

  if (params.issue.lossType === "link") {
    return `secao ${sectionLabel} perdeu ${linkCount} ${pluralize(linkCount, "link", "links")} clicaveis`;
  }

  if (
    (params.issue.lossType === "position" || params.issue.lossType === "size") &&
    sectionType === "grid"
  ) {
    return "cards ficaram desalinhados";
  }

  if (params.issue.lossType === "position" || params.issue.lossType === "size") {
    return `secao ${sectionLabel} ficou desalinhada`;
  }

  if (params.issue.lossType === "text") {
    return `textos da secao ${sectionLabel} ficaram incompletos`;
  }

  return params.issue.message;
}

function buildFriendlyVisualValidationLogs(params: {
  capture: PageCapture;
  snapshot?: SnapshotVisualSummary;
  validation: VisualValidationReport;
}) {
  const visualValidationReport = params.snapshot?.visualValidationReport;

  if (!visualValidationReport || visualValidationReport.viewportResults.length === 0) {
    return [];
  }

  const sectionById = new Map(
    (params.capture.sections ?? []).map((section) => [section.nodeId, section])
  );
  const viewportOrder = {
    desktop: 0,
    tablet: 1,
    mobile: 2
  } as const;
  const logs = ["[Visual Validation]"];
  const orderedViewportResults = [...visualValidationReport.viewportResults].sort(
    (left, right) => viewportOrder[left.viewport] - viewportOrder[right.viewport]
  );

  orderedViewportResults.forEach((viewportResult) => {
    logs.push(
      `${toFriendlyViewportLabel(viewportResult.viewport)}: ${formatFriendlyPercent(
        viewportResult.similarity
      )} - ${viewportResult.passed ? "ok" : "falhou"}`
    );

    if (viewportResult.passed) {
      return;
    }

    const viewportIssues = visualValidationReport.issues.filter(
      (issue) => issue.viewport === viewportResult.viewport
    );
    const friendlyProblems = [
      ...new Set(
        viewportIssues.map((issue) =>
          resolveFriendlyProblemMessage({
            issue,
            section: issue.sectionId ? sectionById.get(issue.sectionId) : undefined
          })
        )
      )
    ];

    if (friendlyProblems.length > 0) {
      logs.push(`Problema: ${friendlyProblems.join("; ")}`);
    }
  });

  logs.push(params.validation.passed ? "Exportacao liberada" : "Exportacao bloqueada");

  return logs;
}

function buildSectionLogs(params: { capture: PageCapture; layout: LayoutDocument }) {
  const sectionCaptures = [...(params.capture.sections ?? [])].sort(
    (left, right) => left.box.y - right.box.y || left.box.x - right.box.x
  );

  if (sectionCaptures.length > 0) {
    return sectionCaptures.map((section, index) => {
      const desktopViewport = section.viewports.desktop ?? Object.values(section.viewports)[0];
      const overlayCount = getUniqueSectionLinkCount(section);
      const unsafeBoundary = section.debug?.unsafeSectionBoundary === true;
      const unsafeReasons = section.debug?.unsafeReasons?.join(", ");

      return [
        `[SECTION] ${(index + 1).toString().padStart(2, "0")} ${section.type} ${section.name} node=${section.nodeId}`,
        `bbox=${formatBox(section.box)}`,
        desktopViewport?.captureBox ? `capture=${formatBox(desktopViewport.captureBox)}` : "",
        `links=${overlayCount}`,
        `unsafe=${unsafeBoundary ? "yes" : "no"}`,
        unsafeReasons ? `reasons=${unsafeReasons}` : ""
      ]
        .filter(Boolean)
        .join(" ");
    });
  }

  const nodeById = new Map(params.layout.nodes.map((node) => [node.id, node]));
  const detectedSections =
    params.layout.detectedSections.length > 0
      ? params.layout.detectedSections.map((section) => ({
          id: section.id,
          type: section.type,
          confidence: section.confidence
        }))
      : params.layout.sectionIds.map((sectionId) => ({
          id: sectionId,
          type: "section",
          confidence: undefined
        }));

  return detectedSections.map((section, index) => {
    const node = nodeById.get(section.id);
    const confidence =
      typeof section.confidence === "number"
        ? ` confidence=${formatPercent(section.confidence)}`
        : "";

    return [
      `[SECTION] ${(index + 1).toString().padStart(2, "0")} ${section.type} node=${section.id}${confidence}`,
      node?.box ? `bbox=${formatBox(node.box)}` : ""
    ]
      .filter(Boolean)
      .join(" ");
  });
}

function buildLossLogs(snapshot?: SnapshotVisualSummary) {
  const issues = snapshot?.visualValidationReport?.issues ?? [];

  return [
    ...new Map(
      issues.map((issue) => [
        `${issue.viewport}:${issue.sectionId ?? "page"}:${issue.lossType}:${issue.message}`,
        [
          `[LOSS] viewport=${issue.viewport}`,
          issue.sectionName ? `section=${issue.sectionName}` : issue.sectionId ? `section=${issue.sectionId}` : "",
          issue.sectionType ? `type=${issue.sectionType}` : "",
          `loss=${issue.lossType}`,
          `similarity=${formatPercent(issue.similarity)}`,
          issue.fallbackStage ? `stage=${issue.fallbackStage}` : "",
          issue.message
        ]
          .filter(Boolean)
          .join(" ")
      ])
    ).values()
  ];
}

function buildVisualLogs(params: {
  capture: PageCapture;
  layout: LayoutDocument;
  emittedMode: OutputMode;
  validation: VisualValidationReport;
  snapshotEnabled: boolean;
  snapshot?: SnapshotVisualSummary;
  fallbackReason?: string;
}) {
  const logs = buildFriendlyVisualValidationLogs({
    capture: params.capture,
    snapshot: params.snapshot,
    validation: params.validation
  });
  const resourceStatuses = params.capture.inputAnalysis.diagnostics.resources ?? [];
  const loadedAssets = resourceStatuses.filter((resource) => resource.status === "loaded").length;
  const failedAssets = resourceStatuses.filter((resource) => resource.status === "failed").length;

  logs.push(
    `[CAPTURE] textos=${params.capture.summary.textBlocks} imagens=${params.capture.summary.images} botoes=${params.capture.summary.buttons} links=${params.capture.summary.links ?? 0} secoes=${params.capture.summary.sections} containers=${params.capture.summary.visualContainers ?? 0} grupos=${params.capture.summary.geometryGroups ?? 0}`
  );
  logs.push(...buildSectionLogs({ capture: params.capture, layout: params.layout }));

  if (params.snapshotEnabled && params.snapshot) {
    params.snapshot.sectionReports.forEach((section, index) => {
      if (section.mode !== "snapshot") {
        return;
      }

      logs.push(
        `[VISUAL SNAPSHOT] Secao ${(index + 1).toString().padStart(2, "0")} (${section.name}) capturada com sucesso`
      );
    });
  }

  if (resourceStatuses.length > 0) {
    logs.push(`[ASSET] ${loadedAssets} recursos carregados com sucesso`);

    if (failedAssets > 0) {
      logs.push(`[ASSET] ${failedAssets} recursos falharam durante a renderizacao`);
    }
  }

  if (params.snapshot?.totals.preservedLinks || params.capture.summary.links) {
    logs.push(
      `[LINK OVERLAY] ${params.snapshot?.totals.preservedLinks ?? 0} links preservados`
    );
  }

  Object.entries(
    params.snapshot?.viewportSimilarities ??
      params.snapshot?.visualValidationReport?.viewportResults.reduce<
        Partial<Record<"desktop" | "tablet" | "mobile", number>>
      >((acc, result) => {
        acc[result.viewport] = result.similarity;
        return acc;
      }, {}) ??
      {}
  ).forEach(([viewport, similarity]) => {
    if (typeof similarity === "number") {
        logs.push(`[VALIDATION] similaridade ${viewport}: ${formatPercent(similarity)}`);
    }
  });

  logs.push(...buildLossLogs(params.snapshot));

  if (params.fallbackReason) {
    logs.push(`[FALLBACK] ${params.fallbackReason}`);
  }

  logs.push(
    params.validation.passed
      ? "[EXPORT] aprovado"
      : `[EXPORT] bloqueado: ${params.validation.issueCount} perda(s) detectada(s)`
  );

  return logs;
}

export function buildExportReport(params: {
  capture: PageCapture;
  layout: LayoutDocument;
  analysis: ComplexityAnalysis;
  emittedMode: OutputMode;
  validation: VisualValidationReport;
  snapshotEnabled: boolean;
  snapshotReason: string;
  fallbackReason?: string;
  warnings?: string[];
  snapshot?: SnapshotVisualSummary;
}): ExportReport {
  const warnings = [
    ...(params.warnings ?? []),
    ...(params.fallbackReason ? [params.fallbackReason] : [])
  ];
  const visualIssues = buildVisualIssues(params.snapshot);
  const visualLogs = buildVisualLogs({
    capture: params.capture,
    layout: params.layout,
    emittedMode: params.emittedMode,
    validation: params.validation,
    snapshotEnabled: params.snapshotEnabled,
    snapshot: params.snapshot,
    fallbackReason: params.fallbackReason
  });

  return {
    id: params.capture.id,
    title: params.capture.title,
    sourceKind: params.capture.sourceKind,
    renderer: params.capture.renderer,
    snapshotEnabled: params.snapshotEnabled,
    snapshotReason: params.snapshotReason,
    selectedMode: params.analysis.selectedMode,
    emittedMode: params.emittedMode,
    fallbackReason: params.fallbackReason,
    summary: params.capture.summary,
    layout: {
      rootNodeId: params.layout.rootNodeId,
      nodeCount: params.layout.nodeCount,
      sectionCount: params.layout.sectionIds.length
    },
    analysis: params.analysis,
    validation: params.validation,
    warnings,
    contentMetrics: {
      detectedTexts: params.capture.summary.textBlocks,
      detectedImages: params.capture.summary.images,
      detectedButtons: params.capture.summary.buttons,
      detectedLinks: params.capture.summary.links ?? 0,
      detectedVisualContainers: params.capture.summary.visualContainers ?? 0,
      detectedGeometryGroups: params.capture.summary.geometryGroups ?? 0,
      createdSections:
        params.snapshot?.totals.snapshotSections ??
        (params.layout.detectedSections.length || params.layout.sectionIds.length)
    },
    viewportSimilarities:
      params.snapshot?.viewportSimilarities ??
      params.snapshot?.visualValidationReport?.viewportResults.reduce<
        Partial<Record<"desktop" | "tablet" | "mobile", number>>
      >((acc, result) => {
        acc[result.viewport] = result.similarity;
        return acc;
      }, {}),
    visualIssues,
    visualLogs,
    learningNotes: params.snapshot?.learningNotes ?? [],
    fallbackTrail: [
      `selected:${params.analysis.selectedMode}`,
      `emitted:${params.emittedMode}`,
      ...(params.fallbackReason ? [`fallback:${params.fallbackReason}`] : []),
      ...(params.snapshot?.learningNotes ?? []),
      ...warnings,
      ...visualLogs
    ],
    snapshot: params.snapshot
  };
}
