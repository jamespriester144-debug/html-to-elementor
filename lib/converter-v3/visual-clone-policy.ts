import type { CapturedNode, PageCapture } from "@/lib/converter-v3/contracts/capture";
import type { LayoutDocument, LayoutNode } from "@/lib/converter-v3/contracts/layout";

export const VISUAL_REASON_HIGH_RISK = "high visual risk";
export const VISUAL_REASON_DARK_THEME = "dark theme preservation";
export const VISUAL_REASON_HERO_BACKGROUND = "hero background preservation";
export const VISUAL_REASON_STRUCTURAL_AUDIT = "structural export failed visual audit";
export const VISUAL_REASON_FALLBACK_SNAPSHOT = "fallback to snapshot";
export const VISUAL_REASON_FALLBACK_PIXEL_PERFECT = "fallback to pixel-perfect";

export const VISUAL_SELECTION_REASON_LABELS = [
  VISUAL_REASON_HIGH_RISK,
  VISUAL_REASON_DARK_THEME,
  VISUAL_REASON_HERO_BACKGROUND,
  VISUAL_REASON_STRUCTURAL_AUDIT,
  VISUAL_REASON_FALLBACK_SNAPSHOT,
  VISUAL_REASON_FALLBACK_PIXEL_PERFECT
] as const;

export type VisualSelectionReasonLabel = (typeof VISUAL_SELECTION_REASON_LABELS)[number];

export type VisualCloneRiskAssessment = {
  score: number;
  highRisk: boolean;
  preferSnapshot: boolean;
  preferFullPageSnapshot: boolean;
  reasons: string[];
  signals: {
    strongDarkTheme: boolean;
    gradientNodes: number;
    overlayNodes: number;
    backgroundImageNodes: number;
    cardMediaNodes: number;
    shadcnPatternNodes: number;
    tailwindUtilityNodes: number;
    backdropBlurNodes: number;
    absoluteFixedStickyNodes: number;
    highZIndexNodes: number;
    pseudoVisualNodes: number;
    heroBackgroundNodes: number;
    styledButtons: number;
    styledInputs: number;
  };
};

export function requiresVisualSafeMode(assessment: VisualCloneRiskAssessment) {
  const visualShellSignals =
    assessment.signals.heroBackgroundNodes > 0 ||
    assessment.signals.gradientNodes > 0 ||
    assessment.signals.overlayNodes > 0 ||
    assessment.signals.backgroundImageNodes > 0 ||
    assessment.signals.cardMediaNodes > 0 ||
    assessment.signals.pseudoVisualNodes > 0;
  const brandedUiSignals =
    assessment.signals.styledButtons > 0 ||
    assessment.signals.styledInputs > 0;

  return (
    assessment.highRisk ||
    (
      assessment.signals.strongDarkTheme &&
      (visualShellSignals || brandedUiSignals)
    )
  );
}

function shouldPreferGenericHighFidelitySnapshot(assessment: VisualCloneRiskAssessment) {
  return requiresVisualSafeMode(assessment);
}

function shouldPreferGenericHighFidelityFullPageSnapshot(assessment: VisualCloneRiskAssessment) {
  return (
    requiresVisualSafeMode(assessment) &&
    (
      (
        assessment.signals.strongDarkTheme &&
        (
          assessment.signals.gradientNodes > 0 ||
          assessment.signals.overlayNodes > 0 ||
          assessment.signals.backgroundImageNodes > 0 ||
          assessment.signals.pseudoVisualNodes > 0
        )
      ) ||
      (
        assessment.signals.heroBackgroundNodes > 0 &&
        (
          assessment.signals.overlayNodes > 0 ||
          assessment.signals.backgroundImageNodes > 0 ||
          assessment.signals.pseudoVisualNodes > 0
        )
      )
    )
  );
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function hasGradient(value?: string) {
  return /gradient\(/i.test(value ?? "");
}

function hasMeaningfulBackgroundImage(value?: string) {
  return /url\(/i.test(value ?? "");
}

function hasMeaningfulColor(value?: string) {
  const normalized = (value ?? "").replace(/\s+/g, "").toLowerCase();
  return Boolean(
    normalized &&
      normalized !== "transparent" &&
      normalized !== "none" &&
      normalized !== "rgba(0,0,0,0)" &&
      normalized !== "rgb(0,0,0,0)"
  );
}

function parseNumericValue(value?: string) {
  const match = (value ?? "").trim().match(/-?\d+(?:\.\d+)?/);
  return match ? Number.parseFloat(match[0]) : undefined;
}

function hasRoundedCorners(value?: string, minimum = 8) {
  const numeric = parseNumericValue(value);
  return typeof numeric === "number" && numeric >= minimum;
}

function hasShadow(value?: string) {
  const normalized = (value ?? "").trim().toLowerCase();
  return Boolean(normalized && normalized !== "none");
}

function hasBackdropBlur(node: Pick<CapturedNode, "computedStyles" | "attributes">) {
  const backdropFilter = node.computedStyles["backdrop-filter"];
  const className = node.attributes.class ?? "";
  return /blur/i.test(backdropFilter ?? "") || /\bbackdrop-blur(?:-[\w/[\]-]+)?\b/i.test(className);
}

function hasVisualPseudoElement(node?: Pick<CapturedNode, "pseudoElements">) {
  return (
    node?.pseudoElements?.some(
      (pseudo) =>
        pseudo.isVisible &&
        (
          hasMeaningfulBackgroundImage(pseudo.computedStyles["background-image"]) ||
          hasGradient(pseudo.computedStyles["background-image"]) ||
          hasMeaningfulColor(pseudo.computedStyles["background-color"]) ||
          pseudo.asset.backgroundUrls?.length ||
          pseudo.asset.hasGradientBackground ||
          pseudo.asset.backgroundLayers?.some((layer) => layer.type !== "other") ||
          Boolean((pseudo.content ?? "").replace(/^['"]|['"]$/g, "").trim())
        )
    ) ?? false
  );
}

function getNodeZIndex(node?: Pick<CapturedNode, "computedStyles">) {
  return parseNumericValue(node?.computedStyles["z-index"]) ?? 0;
}

function getClassTokens(node: Pick<CapturedNode, "attributes">) {
  return (node.attributes.class ?? "")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function stripVariantPrefixes(token: string) {
  const segments = token.split(":");
  return segments[segments.length - 1] ?? token;
}

function isTailwindUtilityToken(token: string) {
  const normalized = stripVariantPrefixes(token);

  if (
    [
      "container",
      "block",
      "inline-block",
      "inline-flex",
      "flex",
      "grid",
      "hidden",
      "absolute",
      "relative",
      "fixed",
      "sticky",
      "mx-auto"
    ].includes(normalized)
  ) {
    return true;
  }

  return [
    "inset-",
    "top-",
    "right-",
    "bottom-",
    "left-",
    "z-",
    "w-",
    "h-",
    "min-h-",
    "max-w-",
    "px-",
    "py-",
    "p-",
    "pt-",
    "pr-",
    "pb-",
    "pl-",
    "mx-",
    "my-",
    "m-",
    "mt-",
    "mr-",
    "mb-",
    "ml-",
    "gap-",
    "space-x-",
    "space-y-",
    "items-",
    "justify-",
    "content-",
    "grid-cols-",
    "col-span-",
    "row-span-",
    "rounded",
    "border",
    "shadow",
    "bg-",
    "from-",
    "via-",
    "to-",
    "text-",
    "font-",
    "leading-",
    "tracking-",
    "opacity-",
    "overflow-",
    "object-",
    "backdrop-blur",
    "blur",
    "ring",
    "transition",
    "duration-",
    "ease-"
  ].some((prefix) => normalized.startsWith(prefix));
}

function isShadcnPatternToken(token: string) {
  const normalized = stripVariantPrefixes(token);

  return (
    [
      "bg-background",
      "text-foreground",
      "border-border",
      "ring-offset-background",
      "shadow-sm",
      "shadow-md",
      "shadow-lg",
      "rounded-lg",
      "rounded-xl",
      "rounded-2xl",
      "peer",
      "group"
    ].includes(normalized) ||
    normalized.startsWith("data-[") ||
    normalized.startsWith("aria-[") ||
    normalized.startsWith("supports-[") ||
    normalized.startsWith("focus-visible:ring")
  );
}

function countTailwindUtilityNodes(nodes: CapturedNode[]) {
  return nodes.filter((node) => getClassTokens(node).filter(isTailwindUtilityToken).length >= 3).length;
}

function countShadcnPatternNodes(nodes: CapturedNode[]) {
  return nodes.filter((node) => {
    const classTokens = getClassTokens(node);
    const shadcnTokenCount = classTokens.filter(isShadcnPatternToken).length;
    const hasRadixAttributes = Object.keys(node.attributes).some((key) =>
      /^(data-radix|data-slot|data-state|data-side|data-align)/i.test(key)
    );

    return shadcnTokenCount >= 2 || (shadcnTokenCount >= 1 && hasRadixAttributes) || hasRadixAttributes;
  }).length;
}

function countOverlayNodes(layout: LayoutDocument, nodes: CapturedNode[]) {
  const capturedNodeById = new Map(nodes.map((node) => [node.id, node]));

  return layout.nodes.filter((node) => {
    const captured = capturedNodeById.get(node.id);
    const zIndex = node.visual?.effectiveZIndex ?? getNodeZIndex(captured);
    return (
      node.detection?.semanticRole === "overlay" ||
      node.visual?.layer === "overlay" ||
      (node.visual?.overlapCount ?? 0) > 0 ||
      zIndex >= 10 ||
      hasVisualPseudoElement(captured)
    );
  }).length;
}

function collectSubtreeNodeIds(layout: LayoutDocument, rootId: string) {
  const childrenById = new Map(layout.nodes.map((node) => [node.id, node.children]));
  const visited = new Set<string>();
  const queue = [rootId];

  while (queue.length > 0) {
    const currentId = queue.shift();

    if (!currentId || visited.has(currentId)) {
      continue;
    }

    visited.add(currentId);
    queue.push(...(childrenById.get(currentId) ?? []));
  }

  return visited;
}

function nodeHasMeaningfulBackground(layoutNode?: LayoutNode, capturedNode?: CapturedNode) {
  const backgroundImage =
    layoutNode?.style.backgroundImage ?? capturedNode?.computedStyles["background-image"];
  const backgroundColor =
    layoutNode?.style.backgroundColor ?? capturedNode?.computedStyles["background-color"];

  return (
    hasMeaningfulBackgroundImage(backgroundImage) ||
    hasGradient(backgroundImage) ||
    hasMeaningfulColor(backgroundColor)
  );
}

function countHeroBackgroundNodes(capture: PageCapture, layout: LayoutDocument) {
  const capturedNodeById = new Map(capture.nodes.map((node) => [node.id, node]));
  const heroSectionIds = [
    ...new Set([
      ...layout.detectedSections.filter((section) => section.type === "hero").map((section) => section.id),
      ...(layout.semanticIndex.hero ?? [])
    ])
  ];

  return heroSectionIds.filter((heroId) => {
    const subtreeIds = collectSubtreeNodeIds(layout, heroId);

    return [...subtreeIds].some((nodeId) => {
      const layoutNode = layout.nodes.find((node) => node.id === nodeId);
      const capturedNode = capturedNodeById.get(nodeId);

      return (
        nodeHasMeaningfulBackground(layoutNode, capturedNode) ||
        hasVisualPseudoElement(capturedNode) ||
        layoutNode?.detection?.semanticRole === "overlay" ||
        layoutNode?.visual?.layer === "overlay"
      );
    });
  }).length;
}

function countCardMediaNodes(capture: PageCapture, layout: LayoutDocument) {
  const cardNodes = layout.nodes.filter((node) => node.detection?.semanticRole === "card");
  const layoutNodeById = new Map(layout.nodes.map((node) => [node.id, node]));
  const capturedNodeById = new Map(capture.nodes.map((node) => [node.id, node]));

  return cardNodes.filter((cardNode) => {
    const subtreeIds = collectSubtreeNodeIds(layout, cardNode.id);

    return [...subtreeIds].some((nodeId) => {
      const layoutNode = layoutNodeById.get(nodeId);
      const capturedNode = capturedNodeById.get(nodeId);

      return (
        layoutNode?.kind === "image" ||
        Boolean(capturedNode?.asset.src) ||
        Boolean(capturedNode?.asset.currentSrc) ||
        Boolean(capturedNode?.asset.backgroundUrls?.length) ||
        hasMeaningfulBackgroundImage(layoutNode?.style.backgroundImage)
      );
    });
  }).length;
}

function isInteractiveButtonNode(node: CapturedNode) {
  return (
    node.tag === "button" ||
    node.attributes.role === "button" ||
    (node.tag === "a" && Boolean(node.attributes.href))
  );
}

function isInputNode(node: CapturedNode) {
  return ["input", "textarea", "select"].includes(node.tag);
}

function isHighlyStyledNode(node: CapturedNode) {
  return (
    hasMeaningfulColor(node.computedStyles["background-color"]) ||
    hasMeaningfulBackgroundImage(node.computedStyles["background-image"]) ||
    hasGradient(node.computedStyles["background-image"]) ||
    hasRoundedCorners(node.computedStyles["border-radius"]) ||
    hasShadow(node.computedStyles["box-shadow"]) ||
    hasBackdropBlur(node)
  );
}

export function isLovableLikeSource(capture: PageCapture): boolean {
  return (
    capture.sourceKind === "lovable-react-source" ||
    capture.inputAnalysis.frameworkHints.includes("lovable") ||
    capture.inputAnalysis.layoutTypes.includes("lovable-export")
  );
}

export function assessVisualCloneRisk(
  capture: PageCapture,
  layout: LayoutDocument
): VisualCloneRiskAssessment {
  const structure = capture.inputAnalysis.structure;
  const strongDarkTheme =
    capture.themeAnalysis?.styleSignals?.hasStrongDarkTheme === true ||
    (
      capture.themeAnalysis?.detectedTheme === "dark" &&
      (capture.themeAnalysis.dominantBackgroundLuminance ?? 1) <= 0.22
    );
  const gradientNodes = capture.nodes.filter(
    (node) =>
      node.asset.hasGradientBackground ||
      node.asset.backgroundLayers?.some((layer) => layer.type === "gradient") ||
      hasGradient(node.computedStyles["background-image"]) ||
      hasGradient(node.asset.backgroundImage)
  ).length;
  const backgroundImageNodes = capture.nodes.filter(
    (node) =>
      Boolean(node.asset.backgroundUrls?.length) ||
      hasMeaningfulBackgroundImage(node.computedStyles["background-image"]) ||
      hasMeaningfulBackgroundImage(node.asset.backgroundImage)
  ).length;
  const overlayNodes = countOverlayNodes(layout, capture.nodes);
  const cardMediaNodes = countCardMediaNodes(capture, layout);
  const shadcnPatternNodes = countShadcnPatternNodes(capture.nodes);
  const tailwindUtilityNodes = countTailwindUtilityNodes(capture.nodes);
  const backdropBlurNodes = capture.nodes.filter(hasBackdropBlur).length;
  const absoluteFixedStickyNodes = capture.nodes.filter((node) =>
    ["absolute", "fixed", "sticky"].includes(node.computedStyles.position ?? "")
  ).length;
  const highZIndexNodes = capture.nodes.filter((node) => getNodeZIndex(node) >= 10).length;
  const pseudoVisualNodes = capture.nodes.filter(hasVisualPseudoElement).length;
  const heroBackgroundNodes = countHeroBackgroundNodes(capture, layout);
  const styledButtons = capture.nodes.filter(
    (node) => isInteractiveButtonNode(node) && isHighlyStyledNode(node)
  ).length;
  const styledInputs = capture.nodes.filter(
    (node) => isInputNode(node) && isHighlyStyledNode(node)
  ).length;
  const reasons: string[] = [];
  let score = 0;

  if (strongDarkTheme) {
    score += 4;
    reasons.push(VISUAL_REASON_DARK_THEME);
  }

  score += gradientNodes >= 4 ? 4 : gradientNodes >= 2 ? 2 : gradientNodes > 0 ? 1 : 0;
  score += overlayNodes >= 4 ? 4 : overlayNodes >= 2 ? 2 : overlayNodes > 0 ? 1 : 0;
  score += backgroundImageNodes >= 3 ? 4 : backgroundImageNodes >= 1 ? 2 : 0;
  score += cardMediaNodes >= 2 ? 3 : cardMediaNodes > 0 ? 1 : 0;
  score += shadcnPatternNodes >= 2 ? 3 : shadcnPatternNodes > 0 ? 1 : 0;
  score += tailwindUtilityNodes >= 5 ? 3 : tailwindUtilityNodes >= 2 ? 1 : 0;
  score += backdropBlurNodes >= 1 ? 3 : 0;
  score +=
    absoluteFixedStickyNodes >= 6 ? 4 : absoluteFixedStickyNodes >= 3 ? 2 : absoluteFixedStickyNodes > 0 ? 1 : 0;
  score += highZIndexNodes >= 5 ? 3 : highZIndexNodes >= 2 ? 1 : 0;
  score += pseudoVisualNodes >= 2 ? 3 : pseudoVisualNodes > 0 ? 1 : 0;

  if (heroBackgroundNodes > 0) {
    score += 4;
    reasons.push(VISUAL_REASON_HERO_BACKGROUND);
  }

  score += styledButtons >= 2 ? 2 : styledButtons > 0 ? 1 : 0;
  score += styledInputs >= 1 ? 2 : 0;
  score += structure.outOfFlowElements >= 8 ? 2 : 0;
  score += structure.transformedElements >= 4 ? 2 : 0;
  score += structure.carousels > 0 ? 3 : 0;
  score += structure.iframes > 0 ? 2 : 0;
  score += capture.inputAnalysis.renderStrategy.preferVisualSnapshot ? 2 : 0;
  score += capture.inputAnalysis.renderStrategy.preferFullPageSnapshot ? 3 : 0;

  const highRisk =
    score >= 10 ||
    (
      heroBackgroundNodes > 0 &&
      (backgroundImageNodes > 0 || overlayNodes >= 2 || pseudoVisualNodes > 0)
    ) ||
    (
      strongDarkTheme &&
      (gradientNodes >= 2 || overlayNodes >= 2 || backdropBlurNodes > 0 || highZIndexNodes >= 2)
    );
  const sectionCount =
    layout.detectedSections.length ||
    layout.sectionIds.length ||
    capture.inputAnalysis.sectionCandidates.length;
  const hasReusableSectionSnapshot = (capture.sections ?? []).some((section) => {
    const viewports = Object.values(section.viewports ?? {});

    return (
      typeof section.htmlCandidate === "string" &&
      section.htmlCandidate.trim().length > 0 &&
      viewports.some(
        (viewport) =>
          (typeof viewport.snapshotDataUrl === "string" && viewport.snapshotDataUrl.trim().length > 0) ||
          (typeof viewport.snapshotPath === "string" && viewport.snapshotPath.trim().length > 0)
      )
    );
  });
  const preferFullPageSnapshot =
    highRisk &&
    (
      !capture.inputAnalysis.renderStrategy.safeSectionExtraction ||
      capture.inputAnalysis.renderStrategy.preferFullPageSnapshot ||
      (sectionCount <= 1 && !hasReusableSectionSnapshot) ||
      overlayNodes >= 4 ||
      absoluteFixedStickyNodes >= 5 ||
      highZIndexNodes >= 4 ||
      pseudoVisualNodes >= 2 ||
      (
        heroBackgroundNodes > 0 &&
        (backgroundImageNodes > 0 || overlayNodes >= 2 || pseudoVisualNodes > 0)
      ) ||
      (
        strongDarkTheme &&
        (gradientNodes >= 3 || backdropBlurNodes > 0 || structure.outOfFlowElements >= 8)
      )
    );

  if (highRisk) {
    reasons.unshift(VISUAL_REASON_HIGH_RISK);
  }

  return {
    score,
    highRisk,
    preferSnapshot: highRisk,
    preferFullPageSnapshot,
    reasons: uniqueStrings(reasons),
    signals: {
      strongDarkTheme,
      gradientNodes,
      overlayNodes,
      backgroundImageNodes,
      cardMediaNodes,
      shadcnPatternNodes,
      tailwindUtilityNodes,
      backdropBlurNodes,
      absoluteFixedStickyNodes,
      highZIndexNodes,
      pseudoVisualNodes,
      heroBackgroundNodes,
      styledButtons,
      styledInputs
    }
  };
}

export function shouldPreferUniversalVisualSnapshot(
  capture: PageCapture,
  layout: LayoutDocument
): boolean {
  if (
    capture.renderer !== "browser" ||
    capture.inputAnalysis.diagnostics.htmlRendered !== true
  ) {
    return false;
  }

  const assessment = assessVisualCloneRisk(capture, layout);

  if (isLovableLikeSource(capture)) {
    return assessment.preferSnapshot;
  }

  return shouldPreferGenericHighFidelitySnapshot(assessment);
}

export function shouldForceUniversalFullPageSnapshot(
  capture: PageCapture,
  layout: LayoutDocument
): boolean {
  if (
    capture.renderer !== "browser" ||
    capture.inputAnalysis.diagnostics.htmlRendered !== true
  ) {
    return false;
  }

  const assessment = assessVisualCloneRisk(capture, layout);

  if (isLovableLikeSource(capture)) {
    return assessment.preferFullPageSnapshot;
  }

  return shouldPreferGenericHighFidelityFullPageSnapshot(assessment);
}

export function extractSelectionReasons(values: Array<string | undefined>) {
  return uniqueStrings(
    VISUAL_SELECTION_REASON_LABELS.filter((reason) =>
      values.some((value) => (value ?? "").includes(reason))
    )
  );
}
