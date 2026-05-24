import path from "node:path";

import type { ExportPipelineResult, SnapshotValidationLossType } from "@/lib/converter-v3/contracts/output";
import { buildUniversalVisualValidationReport } from "@/lib/converter-v3/reports/visual-validation-report";

export type UniversalLearningReport = {
  learnedAt: string;
  inputPath: string;
  inputFileName: string;
  sourceKind: ExportPipelineResult["resolvedSource"]["sourceKind"];
  title: string;
  modeUsed: ExportPipelineResult["report"]["emittedMode"];
  similarityThreshold: number;
  approvedForPromotion: boolean;
  promotedFixtureName?: string;
  universalReport: ReturnType<typeof buildUniversalVisualValidationReport>;
  contentIntegrity: ExportPipelineResult["contentIntegrity"];
  exportReport: ExportPipelineResult["report"];
  learningNotes: string[];
  improvementPriorities: Array<{
    lossType: SnapshotValidationLossType;
    count: number;
  }>;
  suggestions: string[];
  artifacts: ExportPipelineResult["artifacts"];
};

function countLossTypes(result: ExportPipelineResult) {
  return result.report.visualIssues.reduce<Record<SnapshotValidationLossType, number>>(
    (acc, issue) => {
      const lossType = issue.lossType;

      if (!lossType) {
        return acc;
      }

      acc[lossType] = (acc[lossType] ?? 0) + 1;
      return acc;
    },
    {
      text: 0,
      image: 0,
      button: 0,
      background: 0,
      position: 0,
      size: 0,
      link: 0
    }
  );
}

function buildSuggestions(result: ExportPipelineResult) {
  const counts = countLossTypes(result);
  const suggestions: string[] = [];

  if ((counts.text ?? 0) > 0) {
    suggestions.push(
      "Priorizar full-page snapshot quando texto, pontuacao ou tipografia divergirem nos viewports renderizados."
    );
  }

  if ((counts.position ?? 0) > 0 || (counts.size ?? 0) > 0) {
    suggestions.push(
      "Rebaixar mais cedo para snapshot visual completo quando houver perda de geometria, overlay ou stacking."
    );
  }

  if ((counts.image ?? 0) > 0 || (counts.background ?? 0) > 0) {
    suggestions.push(
      "Revalidar assets de background, lazy-load e imagens CSS antes de aceitar export estrutural."
    );
  }

  if ((counts.link ?? 0) > 0 || (counts.button ?? 0) > 0) {
    suggestions.push(
      "Conferir overlays clicaveis por viewport e evitar reposicionamento automatico em areas interativas."
    );
  }

  if (suggestions.length === 0) {
    suggestions.push(
      "Site aprovado como benchmark universal; manter este fixture na matriz para proteger futuras mudancas."
    );
  }

  return suggestions;
}

export function buildUniversalLearningReport(params: {
  result: ExportPipelineResult;
  inputPath: string;
  similarityThreshold?: number;
  promotedFixtureName?: string;
}): UniversalLearningReport {
  const threshold = params.similarityThreshold ?? 0.99;
  const universalReport = buildUniversalVisualValidationReport(params.result);
  const improvementPriorities = Object.entries(countLossTypes(params.result))
    .map(([lossType, count]) => ({
      lossType: lossType as SnapshotValidationLossType,
      count
    }))
    .filter((entry) => entry.count > 0)
    .sort((left, right) => right.count - left.count);
  const approvedForPromotion =
    params.result.contentIntegrity.status === "passed" &&
    universalReport.finalSimilarity >= threshold;

  return {
    learnedAt: new Date().toISOString(),
    inputPath: path.resolve(params.inputPath),
    inputFileName: path.basename(params.inputPath),
    sourceKind: params.result.resolvedSource.sourceKind,
    title: params.result.resolvedSource.title,
    modeUsed: params.result.report.emittedMode,
    similarityThreshold: threshold,
    approvedForPromotion,
    promotedFixtureName: params.promotedFixtureName,
    universalReport,
    contentIntegrity: params.result.contentIntegrity,
    exportReport: params.result.report,
    learningNotes: [
      ...(params.result.report.learningNotes ?? []),
      ...buildSuggestions(params.result)
    ],
    improvementPriorities,
    suggestions: buildSuggestions(params.result),
    artifacts: params.result.artifacts
  };
}
