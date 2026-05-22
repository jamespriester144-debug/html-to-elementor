import type {
  SectionCapture,
  SectionComplexity,
  SectionInstabilityReason
} from "@/lib/converter-v3/contracts/capture";

export const HTML_TO_SNAPSHOT_SIMILARITY = 0.99;
export const HTML_BLOCK_SIMILARITY = 0.98;
export const PIXEL_PERFECT_SIMILARITY = 0.97;

export type SectionRenderStrategy = "html" | "snapshot";

export type SectionHealingIssue =
  | "image-out-of-place"
  | "missing-button"
  | "text-misaligned"
  | "broken-overlay"
  | "wrong-spacing"
  | "visual-overlap";

export type SectionFidelityDecision = {
  recommendedMode: SectionRenderStrategy;
  visuallyUnstable: boolean;
  htmlAllowed: boolean;
  htmlBlocked: boolean;
  forcePixelPerfect: boolean;
  riskScore: number;
  signature: string;
  instabilityReasons: SectionInstabilityReason[];
  narrativeReasons: string[];
};

export type SectionStrategyLearningState = {
  htmlBlockedRiskScore: number | null;
  pixelPerfectRiskScore: number | null;
  blockedHtmlSignatures: Set<string>;
  forcedPixelPerfectSignatures: Set<string>;
  notes: string[];
};

function createReasonLabel(reason: SectionInstabilityReason, complexity: SectionComplexity) {
  switch (reason) {
    case "absolute-positioning":
      return `Posicionamento absoluto detectado (${complexity.absoluteNodes}).`;
    case "complex-z-index":
      return `Camadas com z-index complexo detectadas (${complexity.complexZIndexNodes}).`;
    case "overlays":
      return `Overlays visuais detectados (${complexity.overlayNodes}).`;
    case "transforms":
      return `Transforms detectados (${complexity.transformedNodes}).`;
    case "complex-gradients":
      return `Gradientes complexos detectados (${complexity.gradientNodes}).`;
    case "pseudo-elements":
      return `Pseudo-elements detectados (${complexity.pseudoElementNodes}).`;
    case "fragile-grid":
      return `Grid fragil detectado (${complexity.gridContainers} grid(s)).`;
    case "carousel":
      return `Carousel/slider detectado (${complexity.carouselNodes}).`;
    case "animations":
      return `Animacoes detectadas (${complexity.animatedNodes}).`;
    case "unsupported-css":
      return `CSS fora do suporte seguro do Elementor detectado (${complexity.unsupportedCssNodes}).`;
    case "dense-dom":
      return `DOM denso detectado (${complexity.nodeCount} nos).`;
    case "visual-overlap":
      return `Sobreposicao visual detectada (${complexity.overlappingNodes}).`;
    case "complex-nested-layout":
      return `Flex/grid aninhado complexo detectado (profundidade ${complexity.maxFlexGridDepth}).`;
    default:
      return "Complexidade visual elevada detectada.";
  }
}

function buildInstabilityReasons(complexity: SectionComplexity): SectionInstabilityReason[] {
  const reasons: SectionInstabilityReason[] = [];

  if (complexity.absoluteNodes > 0) {
    reasons.push("absolute-positioning");
  }
  if (complexity.complexZIndexNodes > 1) {
    reasons.push("complex-z-index");
  }
  if (complexity.overlayNodes > 0) {
    reasons.push("overlays");
  }
  if (complexity.hasTransforms || complexity.transformedNodes > 0) {
    reasons.push("transforms");
  }
  if (complexity.gradientNodes > 0) {
    reasons.push("complex-gradients");
  }
  if (complexity.hasPseudoElements || complexity.pseudoElementNodes > 0) {
    reasons.push("pseudo-elements");
  }
  if (
    complexity.gridContainers > 0 &&
    (complexity.absoluteNodes > 0 ||
      complexity.overlappingNodes > 0 ||
      complexity.nestedFlexGridContainers > 1)
  ) {
    reasons.push("fragile-grid");
  }
  if (complexity.carouselNodes > 0) {
    reasons.push("carousel");
  }
  if (complexity.animatedNodes > 0) {
    reasons.push("animations");
  }
  if (complexity.unsupportedCssNodes > 0) {
    reasons.push("unsupported-css");
  }
  if (complexity.nodeCount > 40) {
    reasons.push("dense-dom");
  }
  if (complexity.overlappingNodes > 0) {
    reasons.push("visual-overlap");
  }
  if (complexity.nestedFlexGridContainers > 2 || complexity.maxFlexGridDepth > 2) {
    reasons.push("complex-nested-layout");
  }

  return reasons;
}

function computeRiskScore(complexity: SectionComplexity) {
  let score = 0;

  score += Math.min(complexity.absoluteNodes * 8, 24);
  score += Math.min(complexity.overlayNodes * 8, 24);
  score += Math.min(complexity.complexZIndexNodes * 6, 18);
  score += Math.min(complexity.transformedNodes * 5, 15);
  score += Math.min(complexity.gradientNodes * 4, 12);
  score += complexity.hasPseudoElements ? 12 : 0;
  score += Math.min(complexity.carouselNodes * 18, 36);
  score += Math.min(complexity.animatedNodes * 8, 24);
  score += Math.min(complexity.unsupportedCssNodes * 10, 30);
  score += complexity.nodeCount > 80 ? 20 : complexity.nodeCount > 40 ? 12 : 0;
  score += Math.min(complexity.overlappingNodes * 10, 30);
  score +=
    complexity.gridContainers > 0 &&
    (complexity.absoluteNodes > 0 ||
      complexity.overlappingNodes > 0 ||
      complexity.nestedFlexGridContainers > 1)
      ? 14
      : 0;
  score += Math.min(complexity.nestedFlexGridContainers * 5, 15);
  score += complexity.maxFlexGridDepth > 2 ? (complexity.maxFlexGridDepth - 2) * 6 : 0;
  score += complexity.hasEmbeds ? 24 : 0;

  return score;
}

function buildSignature(
  reasons: SectionInstabilityReason[],
  complexity: SectionComplexity
) {
  return [
    ...[...reasons].sort(),
    complexity.nodeCount > 40 ? "dense" : "light",
    complexity.absoluteNodes > 0 ? "abs" : "flow",
    complexity.overlappingNodes > 0 ? "overlap" : "aligned",
    complexity.gridContainers > 0 ? "grid" : complexity.flexContainers > 0 ? "flex" : "block",
    complexity.maxFlexGridDepth > 2 ? "deep" : "shallow",
    complexity.hasEmbeds ? "embed" : "no-embed"
  ].join("|");
}

export function createSectionStrategyLearningState(): SectionStrategyLearningState {
  return {
    htmlBlockedRiskScore: null,
    pixelPerfectRiskScore: null,
    blockedHtmlSignatures: new Set<string>(),
    forcedPixelPerfectSignatures: new Set<string>(),
    notes: []
  };
}

export function resolveSectionFidelityDecision(
  section: SectionCapture,
  learning: SectionStrategyLearningState
): SectionFidelityDecision {
  const reasons = buildInstabilityReasons(section.complexity);
  const riskScore = computeRiskScore(section.complexity);
  const signature = buildSignature(reasons, section.complexity);
  const visuallyUnstable =
    reasons.length > 0 ||
    riskScore >= 18 ||
    section.complexity.nodeCount > 40 ||
    section.complexity.overlappingNodes > 0;
  const learnedHtmlBlock =
    learning.blockedHtmlSignatures.has(signature) ||
    (typeof learning.htmlBlockedRiskScore === "number" &&
      riskScore >= learning.htmlBlockedRiskScore);
  const learnedPixelPerfect =
    learning.forcedPixelPerfectSignatures.has(signature) ||
    (typeof learning.pixelPerfectRiskScore === "number" &&
      riskScore >= learning.pixelPerfectRiskScore);
  const forcePixelPerfect =
    learnedPixelPerfect ||
    section.complexity.hasEmbeds ||
    section.complexity.carouselNodes > 0 ||
    (section.complexity.animatedNodes > 0 && section.complexity.transformedNodes > 0) ||
    section.complexity.unsupportedCssNodes >= 2 ||
    riskScore >= 72;
  const htmlBlocked =
    learnedHtmlBlock ||
    section.complexity.nodeCount > 40 ||
    section.complexity.absoluteNodes > 0 ||
    section.complexity.overlayNodes > 0 ||
    section.complexity.overlappingNodes > 0 ||
    section.complexity.hasPseudoElements ||
    section.complexity.carouselNodes > 0 ||
    section.complexity.animatedNodes > 0 ||
    section.complexity.unsupportedCssNodes > 0 ||
    section.complexity.nestedFlexGridContainers > 2 ||
    section.complexity.maxFlexGridDepth > 2;

  return {
    recommendedMode: htmlBlocked || forcePixelPerfect ? "snapshot" : "html",
    visuallyUnstable,
    htmlAllowed: !htmlBlocked && !forcePixelPerfect,
    htmlBlocked,
    forcePixelPerfect,
    riskScore,
    signature,
    instabilityReasons: reasons,
    narrativeReasons: reasons.map((reason) => createReasonLabel(reason, section.complexity))
  };
}

export function learnFromSectionSimilarity(params: {
  decision: SectionFidelityDecision;
  learning: SectionStrategyLearningState;
  similarity: number;
}) {
  if (params.similarity < HTML_BLOCK_SIMILARITY) {
    params.learning.blockedHtmlSignatures.add(params.decision.signature);
    params.learning.htmlBlockedRiskScore =
      params.learning.htmlBlockedRiskScore === null
        ? params.decision.riskScore
        : Math.min(params.learning.htmlBlockedRiskScore, params.decision.riskScore);
    params.learning.notes.push(
      `HTML congelado bloqueado para assinatura ${params.decision.signature} apos similaridade ${(
        params.similarity * 100
      ).toFixed(2)}%.`
    );
  }

  if (params.similarity < PIXEL_PERFECT_SIMILARITY) {
    params.learning.forcedPixelPerfectSignatures.add(params.decision.signature);
    params.learning.pixelPerfectRiskScore =
      params.learning.pixelPerfectRiskScore === null
        ? params.decision.riskScore
        : Math.min(params.learning.pixelPerfectRiskScore, params.decision.riskScore);
    params.learning.notes.push(
      `Pixel-perfect exigido para assinatura ${params.decision.signature} apos similaridade ${(
        params.similarity * 100
      ).toFixed(2)}%.`
    );
  }
}

export function inferHealingIssues(
  section: SectionCapture,
  decision: SectionFidelityDecision,
  similarity: number
): SectionHealingIssue[] {
  const issues = new Set<SectionHealingIssue>();

  if (similarity >= HTML_TO_SNAPSHOT_SIMILARITY) {
    return [];
  }

  if (section.complexity.imageNodes > 0) {
    issues.add("image-out-of-place");
  }
  if (
    Object.values(section.viewports).some((viewport) => (viewport?.linkOverlays.length ?? 0) > 0)
  ) {
    issues.add("missing-button");
  }
  if (section.complexity.overlayNodes > 0 || decision.instabilityReasons.includes("pseudo-elements")) {
    issues.add("broken-overlay");
  }
  if (
    section.complexity.absoluteNodes > 0 ||
    section.complexity.overlappingNodes > 0 ||
    decision.instabilityReasons.includes("complex-nested-layout") ||
    decision.instabilityReasons.includes("fragile-grid")
  ) {
    issues.add("wrong-spacing");
  }
  if (section.complexity.overlappingNodes > 0) {
    issues.add("visual-overlap");
  }

  if (!issues.size) {
    issues.add("text-misaligned");
  }

  return [...issues];
}
