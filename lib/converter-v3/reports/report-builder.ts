import type { PageCapture } from "@/lib/converter-v3/contracts/capture";
import type { ComplexityAnalysis, LayoutDocument, OutputMode } from "@/lib/converter-v3/contracts/layout";
import type {
  ExportReport,
  SnapshotVisualSummary,
  ThemeAuditReport,
  VisualValidationIssueSummary,
  VisualValidationIssue,
  VisualValidationReport
} from "@/lib/converter-v3/contracts/output";
import {
  extractSelectionReasons,
  VISUAL_REASON_FALLBACK_PIXEL_PERFECT,
  VISUAL_REASON_FALLBACK_SNAPSHOT
} from "@/lib/converter-v3/visual-clone-policy";

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

function mapValidationIssueToSummary(issue: VisualValidationIssue): VisualValidationIssueSummary {
  return {
    type: issue.type,
    nodeId: issue.nodeId,
    sectionId: issue.sectionId,
    sectionName: issue.sectionName,
    sectionType: issue.sectionType,
    sectionTypeLabel: issue.sectionTypeLabel,
    viewport: issue.viewport,
    severity: issue.severity,
    similarity: issue.similarity,
    similarityPercent: issue.similarityPercent,
    lossType: issue.lossType,
    estimatedLossCount: issue.estimatedLossCount,
    estimatedLosses: issue.estimatedLosses,
    bbox: issue.bbox,
    originalScreenshotPath: issue.originalScreenshotPath,
    convertedScreenshotPath: issue.convertedScreenshotPath,
    diffScreenshotPath: issue.diffScreenshotPath,
    originalValue: issue.originalValue,
    convertedValue: issue.convertedValue,
    message: issue.message
  };
}

function buildVisualIssues(params: {
  validation: VisualValidationReport;
  snapshot?: SnapshotVisualSummary;
}): VisualValidationIssueSummary[] {
  const snapshotIssues =
    params.snapshot?.visualValidationReport?.issues.map((issue) => ({
      type: "missing-position" as const,
      nodeId: issue.sectionId,
      sectionId: issue.sectionId,
      sectionName: issue.sectionName,
      sectionType: issue.sectionType,
      sectionTypeLabel: issue.sectionTypeLabel,
      viewport: issue.viewport,
      severity: issue.severity,
      similarity: issue.similarity,
      similarityPercent: issue.similarityPercent,
      lossType: issue.lossType,
      estimatedLossCount: issue.estimatedLossCount,
      estimatedLosses: issue.estimatedLosses,
      bbox: issue.bbox,
      originalScreenshotPath: issue.originalScreenshotPath,
      convertedScreenshotPath: issue.convertedScreenshotPath,
      diffScreenshotPath: issue.diffScreenshotPath,
      fallbackStage: issue.fallbackStage,
      message: issue.message
    })) ?? [];
  const merged = [...snapshotIssues, ...params.validation.issues.map(mapValidationIssueToSummary)];

  return [
    ...new Map(
      merged.map((issue) => [
        `${issue.type ?? "issue"}:${issue.nodeId ?? ""}:${issue.viewport ?? ""}:${issue.message}`,
        issue
      ])
    ).values()
  ];
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

function compactIssueMessage(message: string) {
  return message
    .replace(/\s+Secao\s+[^.]+\([^)]+\)\.$/i, "")
    .replace(/\.$/, "");
}

function resolveFriendlyValidationIssueMessage(issue: VisualValidationIssue) {
  const compactMessage = compactIssueMessage(issue.message);

  switch (issue.type) {
    case "theme-mismatch":
      return "theme mismatch";
    case "body-white-on-dark":
      return "dark theme lost";
    case "hero-overlay-missing":
      return "hero overlay missing";
    case "hero-background-missing":
      return "hero background missing";
    case "background-mismatch":
    case "important-image-missing":
      return "important visual asset missing";
    case "card-background-mismatch":
      return "card background mismatch";
    case "default-button-style-detected":
      return "default button style detected";
    case "default-input-style-detected":
      return "default input style detected";
    case "header-footer-background-mismatch":
      return "header/footer background mismatch";
    case "height-mismatch":
      return "page height mismatch";
    case "dominant-color-mismatch":
      return "dominant color mismatch";
    default:
      return compactMessage;
  }
}

function buildFallbackTriggeredMessages(params: {
  warnings?: string[];
  fallbackReason?: string;
}) {
  const combined = [params.fallbackReason, ...(params.warnings ?? [])]
    .filter((value): value is string => Boolean(value))
    .join("\n");
  const messages: string[] = [];

  if (combined.includes(VISUAL_REASON_FALLBACK_SNAPSHOT)) {
    messages.push("fallback to snapshot triggered");
  }

  if (combined.includes(VISUAL_REASON_FALLBACK_PIXEL_PERFECT)) {
    messages.push("fallback to pixel-perfect triggered");
  }

  return messages;
}

function resolveFriendlyProblemMessage(params: {
  issue: NonNullable<SnapshotVisualSummary["visualValidationReport"]>["issues"][number];
  section?: NonNullable<PageCapture["sections"]>[number];
}) {
  const sectionType = (params.issue.sectionType ?? params.section?.type ?? "").toLowerCase();
  const sectionLabel = params.issue.sectionTypeLabel ?? humanizeSectionType(sectionType);
  const imageCount = Math.max(
    params.issue.estimatedLosses.images ?? params.section?.debug?.originalImages.length ?? 0,
    params.issue.estimatedLossCount > 0 && params.issue.lossType === "image"
      ? params.issue.estimatedLossCount
      : 1
  );
  const backgroundCount = Math.max(
    params.issue.estimatedLosses.backgrounds ?? params.section?.debug?.cssBackgrounds.length ?? 0,
    params.issue.estimatedLossCount > 0 && params.issue.lossType === "background"
      ? params.issue.estimatedLossCount
      : 1
  );
  const linkCount = Math.max(
    params.issue.estimatedLosses.links ??
      params.section?.debug?.interactiveElements.filter((element) => Boolean(element.href)).length ??
      0,
    params.issue.estimatedLossCount > 0 && params.issue.lossType === "link"
      ? params.issue.estimatedLossCount
      : 1
  );
  const buttonCount = Math.max(
    params.issue.estimatedLosses.buttons ??
      params.section?.debug?.interactiveElements.filter((element) => element.isButton).length ??
      0,
    params.issue.estimatedLossCount > 0 && params.issue.lossType === "button"
      ? params.issue.estimatedLossCount
      : 1
  );
  const textCount = Math.max(
    params.issue.estimatedLosses.texts ?? 0,
    params.issue.estimatedLossCount > 0 && params.issue.lossType === "text"
      ? params.issue.estimatedLossCount
      : 1
  );

  if (!params.issue.sectionId && params.issue.bbox) {
    return `perda visual detectada na area ${formatBox(params.issue.bbox)}`;
  }

  if (params.issue.severity === "critical" && /hero background missing/i.test(params.issue.message)) {
    return "hero background missing";
  }

  if (params.issue.severity === "critical" && /card image missing/i.test(params.issue.message)) {
    return "card image missing";
  }

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
    return `secao ${sectionLabel} perdeu ${textCount} ${pluralize(textCount, "texto", "textos")}`;
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
    if (params.validation.issueCount === 0) {
      return [];
    }

    const friendlyMessages = [
      ...new Set(
        params.validation.issues
          .slice()
          .sort(
            (left, right) =>
              determineSeverityWeight(right.severity) - determineSeverityWeight(left.severity)
          )
          .map(resolveFriendlyValidationIssueMessage)
      )
    ];

    return [
      "[Visual Validation]",
      ...friendlyMessages.slice(0, 4).map((message) => `Problema: ${message}`),
      params.validation.passed ? "Exportacao liberada" : "Exportacao bloqueada"
    ];
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

  const extraValidationProblems = [
    ...new Set(
      params.validation.issues
        .filter(
          (issue) =>
            !visualValidationReport.issues.some((snapshotIssue) => snapshotIssue.message === issue.message)
        )
        .map(resolveFriendlyValidationIssueMessage)
    )
  ];

  extraValidationProblems.slice(0, 2).forEach((message) => {
    logs.push(`Problema: ${message}`);
  });

  logs.push(params.validation.passed ? "Exportacao liberada" : "Exportacao bloqueada");

  return logs;
}

function determineSeverityWeight(severity?: VisualValidationIssue["severity"]) {
  switch (severity) {
    case "blocking":
      return 3;
    case "critical":
      return 2;
    case "warning":
      return 1;
    default:
      return 0;
  }
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

function buildLossLogs(params: {
  snapshot?: SnapshotVisualSummary;
  validation: VisualValidationReport;
}) {
  const issues = params.snapshot?.visualValidationReport?.issues ?? [];
  const snapshotLogs = [
    ...new Map(
      issues.map((issue) => [
        `${issue.viewport}:${issue.sectionId ?? "page"}:${issue.lossType}:${issue.message}`,
        [
          `[LOSS] viewport=${issue.viewport}`,
          issue.sectionName ? `section=${issue.sectionName}` : issue.sectionId ? `section=${issue.sectionId}` : "",
          issue.sectionTypeLabel
            ? `type=${issue.sectionTypeLabel}`
            : issue.sectionType
              ? `type=${issue.sectionType}`
              : "",
          `severity=${issue.severity}`,
          `loss=${issue.lossType}`,
          `similarity=${formatPercent(issue.similarity)}`,
          `count=${issue.estimatedLossCount}`,
          issue.bbox ? `bbox=${formatBox(issue.bbox)}` : "",
          issue.fallbackStage ? `stage=${issue.fallbackStage}` : "",
          issue.originalScreenshotPath ? `original=${issue.originalScreenshotPath}` : "",
          issue.convertedScreenshotPath ? `converted=${issue.convertedScreenshotPath}` : "",
          issue.diffScreenshotPath ? `diff=${issue.diffScreenshotPath}` : "",
          issue.message
        ]
          .filter(Boolean)
          .join(" ")
      ])
    ).values()
  ];
  const structuralLogs = params.validation.issues
    .filter(
      (issue) =>
        !issues.some(
          (snapshotIssue) =>
            snapshotIssue.message === issue.message &&
            snapshotIssue.sectionId === issue.sectionId &&
            snapshotIssue.viewport === issue.viewport
        )
    )
    .map((issue) =>
      [
        `[AUDIT] severity=${issue.severity ?? "blocking"}`,
        `type=${issue.type}`,
        issue.nodeId ? `node=${issue.nodeId}` : "",
        issue.viewport ? `viewport=${issue.viewport}` : "",
        issue.sectionName ? `section=${issue.sectionName}` : issue.sectionId ? `section=${issue.sectionId}` : "",
        compactIssueMessage(issue.message)
      ]
        .filter(Boolean)
        .join(" ")
    );

  return [...snapshotLogs, ...structuralLogs];
}

function buildThemeLogs(params: {
  capture: PageCapture;
  themeAudit?: ThemeAuditReport;
}) {
  const logs: string[] = [];
  const themeMessages = params.capture.themeAnalysis?.messages ?? [];

  themeMessages.forEach((message) => {
    logs.push(`[THEME] ${message}`);
  });

  params.themeAudit?.messages.forEach((message) => {
    if (themeMessages.includes(message)) {
      return;
    }

    logs.push(`[THEME] ${message}`);
  });

  return [...new Set(logs)];
}

function buildVisualLogs(params: {
  capture: PageCapture;
  layout: LayoutDocument;
  validation: VisualValidationReport;
  snapshotEnabled: boolean;
  snapshot?: SnapshotVisualSummary;
  fallbackReason?: string;
  warnings?: string[];
  themeAudit?: ThemeAuditReport;
  visualValidationSummary: string[];
}) {
  const logs = [...params.visualValidationSummary];
  const resourceStatuses = params.capture.inputAnalysis.diagnostics.resources ?? [];
  const loadedAssets = resourceStatuses.filter((resource) => resource.status === "loaded").length;
  const failedAssets = resourceStatuses.filter((resource) => resource.status === "failed").length;
  const assetDiagnosticCounts = new Map<string, number>();
  const criticalAssetMessages = new Set<string>();
  const themeLogs = buildThemeLogs({
    capture: params.capture,
    themeAudit: params.themeAudit
  });

  resourceStatuses.forEach((resource) => {
    if (resource.diagnostic) {
      assetDiagnosticCounts.set(
        resource.diagnostic,
        (assetDiagnosticCounts.get(resource.diagnostic) ?? 0) + 1
      );
    }

    if (resource.critical && resource.diagnostic) {
      criticalAssetMessages.add(resource.diagnostic);
    }
  });

  logs.push(
    `[CAPTURE] textos=${params.capture.summary.textBlocks} imagens=${params.capture.summary.images} botoes=${params.capture.summary.buttons} links=${params.capture.summary.links ?? 0} secoes=${params.capture.summary.sections} containers=${params.capture.summary.visualContainers ?? 0} grupos=${params.capture.summary.geometryGroups ?? 0}`
  );
  logs.push(...themeLogs);
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

    for (const [diagnostic, count] of assetDiagnosticCounts.entries()) {
      logs.push(`[ASSET] ${diagnostic}: ${count}`);
    }
  }

  if (criticalAssetMessages.size > 0) {
    criticalAssetMessages.forEach((message) => {
      logs.push(`[CRITICAL FIDELITY] ${message}`);
    });
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

  logs.push(
    ...buildLossLogs({
      snapshot: params.snapshot,
      validation: params.validation
    })
  );

  logs.push(
    ...buildFallbackTriggeredMessages({
      warnings: params.warnings,
      fallbackReason: params.fallbackReason
    }).map((message) => `[FALLBACK] ${message}`)
  );

  if (params.fallbackReason) {
    logs.push(`[FALLBACK] ${params.fallbackReason}`);
  }

  logs.push(
    params.validation.passed
      ? "[EXPORT] aprovado"
      : `[EXPORT] bloqueado: ${params.validation.issueCount} perda(s) detectada(s)`
  );

  return [...new Set(logs)];
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
  themeAudit?: ThemeAuditReport;
}): ExportReport {
  const warnings = [
    ...(params.warnings ?? []),
    ...(params.fallbackReason ? [params.fallbackReason] : [])
  ];
  const selectionReasons = extractSelectionReasons([
    ...params.analysis.reasons,
    ...warnings,
    ...(params.themeAudit?.messages ?? [])
  ]);
  const visualIssues = buildVisualIssues({
    validation: params.validation,
    snapshot: params.snapshot
  });
  const visualValidationSummary = buildFriendlyVisualValidationLogs({
    capture: params.capture,
    snapshot: params.snapshot,
    validation: params.validation
  });
  const themeLogs = buildThemeLogs({
    capture: params.capture,
    themeAudit: params.themeAudit
  });
  const visualLogs = buildVisualLogs({
    capture: params.capture,
    layout: params.layout,
    validation: params.validation,
    snapshotEnabled: params.snapshotEnabled,
    snapshot: params.snapshot,
    fallbackReason: params.fallbackReason,
    warnings,
    themeAudit: params.themeAudit,
    visualValidationSummary
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
    selectionReasons,
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
    visualValidationSummary,
    visualLogs,
    themeAnalysis: params.capture.themeAnalysis,
    themeAudit: params.themeAudit,
    themeLogs,
    learningNotes: params.snapshot?.learningNotes ?? [],
    fallbackTrail: [
      `selected:${params.analysis.selectedMode}`,
      `emitted:${params.emittedMode}`,
      ...selectionReasons,
      ...(params.fallbackReason ? [`fallback:${params.fallbackReason}`] : []),
      ...(params.snapshot?.learningNotes ?? []),
      ...warnings,
      ...visualLogs
    ],
    snapshot: params.snapshot
  };
}
