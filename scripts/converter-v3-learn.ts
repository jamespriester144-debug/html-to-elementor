import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  LEARNED_FIXTURE_TAGS,
  getLearnedFixtureDirectory,
  upsertLearnedFixtureManifestEntry,
  type LearnedFixtureTag
} from "../lib/converter-v3/learning/fixture-manifest";
import { buildUniversalLearningReport } from "../lib/converter-v3/learning/universal-learning";
import { runExportPipelineV3 } from "../lib/converter-v3/orchestration/export-pipeline-v3";
import { resolveSourceFromLocalPath } from "../lib/converter-v3/resolve/source-resolver";

type LearnCommandOptions = {
  inputPath: string;
  tags: LearnedFixtureTag[];
  promoteFixture: boolean;
  fixtureName?: string;
  minSimilarity: number;
};

function printUsage() {
  console.log(
    [
      "Uso:",
      "npm run learn:converter:v3 -- --input <caminho-do-site.html|zip> [--tag lovable] [--tag responsive] [--promote-fixture] [--fixture-name meu-site.html] [--min-similarity 0.99]"
    ].join("\n")
  );
}

function parseArgs(argv: string[]): LearnCommandOptions {
  let inputPath = "";
  const tags: LearnedFixtureTag[] = [];
  let promoteFixture = false;
  let fixtureName: string | undefined;
  let minSimilarity = 0.99;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--input") {
      inputPath = argv[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (arg === "--tag") {
      const value = argv[index + 1] ?? "";
      index += 1;

      value
        .split(",")
        .map((item) => item.trim())
        .filter((item): item is LearnedFixtureTag =>
          (LEARNED_FIXTURE_TAGS as readonly string[]).includes(item)
        )
        .forEach((tag) => tags.push(tag));
      continue;
    }

    if (arg === "--promote-fixture") {
      promoteFixture = true;
      continue;
    }

    if (arg === "--fixture-name") {
      fixtureName = argv[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (arg === "--min-similarity") {
      const value = Number(argv[index + 1] ?? "0.99");
      index += 1;

      if (Number.isFinite(value)) {
        minSimilarity = Math.min(1, Math.max(0, value));
      }
    }
  }

  if (!inputPath) {
    throw new Error("Informe --input com o caminho do site HTML ou ZIP.");
  }

  return {
    inputPath,
    tags: [...new Set(tags)],
    promoteFixture,
    fixtureName: fixtureName?.trim() || undefined,
    minSimilarity
  };
}

function sanitizeFileName(fileName: string) {
  return fileName.replace(/\\/g, "/").replace(/^.*\//, "").replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function deriveTagsFromResolvedSource(params: {
  sourceKind: string;
  layoutTypes: string[];
  sectionCount: number;
  hasExternalAssets: boolean;
  hasLazyAssets: boolean;
  viewportMatched: boolean;
}): LearnedFixtureTag[] {
  const tags = new Set<LearnedFixtureTag>();

  if (
    params.sourceKind === "lovable-react-source" ||
    params.layoutTypes.includes("lovable-export")
  ) {
    tags.add("lovable");
  }

  if (params.layoutTypes.includes("vite-react-export")) {
    tags.add("react-export");
  }

  if (params.sourceKind === "raw-html") {
    tags.add("generic-static");
  }

  if (params.sectionCount >= 3) {
    tags.add("layout-stress");
  }

  if (params.sectionCount >= 5) {
    tags.add("long-form");
  }

  if (params.hasExternalAssets || params.hasLazyAssets) {
    tags.add("asset-coverage");
  }

  if (params.viewportMatched) {
    tags.add("responsive");
  }

  if (tags.size === 0) {
    tags.add("generic-static");
  }

  return [...tags];
}

function selectStableExpectedLayoutTypes(layoutTypes: string[]) {
  const stableTypes = ["lovable-export", "vite-react-export", "tailwind"];

  return layoutTypes.filter((layoutType) => stableTypes.includes(layoutType));
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const resolvedSource = await resolveSourceFromLocalPath(options.inputPath);
    const result = await runExportPipelineV3(resolvedSource, {
      preferBrowser: true,
      outputRoot: path.join(process.cwd(), "debug", "conversions", "learning")
    });
    const derivedTags = deriveTagsFromResolvedSource({
      sourceKind: result.resolvedSource.sourceKind,
      layoutTypes: result.capture.inputAnalysis.layoutTypes,
      sectionCount:
        result.layout.detectedSections.length || result.layout.sectionIds.length,
      hasExternalAssets: result.capture.inputAnalysis.assets.external > 0,
      hasLazyAssets: result.capture.inputAnalysis.assets.lazy > 0,
      viewportMatched: result.capture.inputAnalysis.diagnostics.viewportMatched ?? false
    });
    const tags = [...new Set([...derivedTags, ...options.tags])];
    const promotedFixtureFileName = sanitizeFileName(
      options.fixtureName || path.basename(options.inputPath)
    );
    const learningReport = buildUniversalLearningReport({
      result,
      inputPath: options.inputPath,
      similarityThreshold: options.minSimilarity,
      promotedFixtureName: options.promoteFixture
        ? `learned/${promotedFixtureFileName}`
        : undefined
    });
    const outputDir = result.capture.artifacts.outputDir;
    const learningReportPath = path.join(outputDir, "learning-report.json");

    await mkdir(outputDir, { recursive: true });
    await writeFile(learningReportPath, JSON.stringify(learningReport, null, 2), "utf8");

    console.log(`[LEARN] relatorio salvo em ${learningReportPath}`);
    console.log(
      `[LEARN] similaridade final: ${(learningReport.universalReport.finalSimilarity * 100).toFixed(2)}%`
    );
    console.log(`[LEARN] modo final: ${learningReport.modeUsed}`);
    console.log(`[LEARN] tags sugeridas: ${tags.join(", ")}`);

    if (learningReport.improvementPriorities.length > 0) {
      console.log("[LEARN] prioridades:");
      learningReport.improvementPriorities.forEach((priority) => {
        console.log(`- ${priority.lossType}: ${priority.count}`);
      });
    }

    if (options.promoteFixture) {
      if (!learningReport.approvedForPromotion) {
        throw new Error(
          `Site nao promovido para a matriz universal. Similaridade final ${(
            learningReport.universalReport.finalSimilarity * 100
          ).toFixed(2)}% abaixo do minimo de ${(options.minSimilarity * 100).toFixed(2)}% ou integridade bloqueada.`
        );
      }

      const learnedFixtureDirectory = getLearnedFixtureDirectory();
      const targetPath = path.join(learnedFixtureDirectory, promotedFixtureFileName);
      await mkdir(path.dirname(targetPath), { recursive: true });
      await copyFile(path.resolve(options.inputPath), targetPath);
      await upsertLearnedFixtureManifestEntry({
        name: `learned/${promotedFixtureFileName}`,
        tags,
        verifyExport: true,
        preferBrowser: true,
        minSimilarity: options.minSimilarity,
        expectedLayoutTypes: (() => {
          const stableTypes = selectStableExpectedLayoutTypes(
            result.capture.inputAnalysis.layoutTypes
          );

          return stableTypes.length > 0 ? stableTypes : undefined;
        })(),
        promotedAt: learningReport.learnedAt,
        sourceKind: result.resolvedSource.sourceKind
      });

      console.log(`[LEARN] fixture promovido para ${targetPath}`);
      console.log("[LEARN] a suite universal vai validar esse site nas proximas correcoes.");
    }

    if (!learningReport.approvedForPromotion) {
      process.exitCode = 1;
    }
  } catch (error) {
    printUsage();
    console.error(error);
    process.exit(1);
  }
}

main();
