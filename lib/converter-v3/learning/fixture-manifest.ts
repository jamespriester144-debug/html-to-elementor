import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const LEARNED_FIXTURE_TAGS = [
  "lovable",
  "generic-static",
  "react-export",
  "layout-stress",
  "asset-coverage",
  "responsive",
  "long-form"
] as const;

export type LearnedFixtureTag = (typeof LEARNED_FIXTURE_TAGS)[number];

export type LearnedFixtureManifestEntry = {
  name: string;
  tags: LearnedFixtureTag[];
  verifyExport?: boolean;
  preferBrowser?: boolean;
  minSimilarity?: number;
  expectedLayoutTypes?: string[];
  promotedAt?: string;
  sourceKind?: string;
};

export type LearnedFixtureManifest = {
  version: 1;
  fixtures: LearnedFixtureManifestEntry[];
};

export function getLearnedFixtureManifestPath() {
  return path.join(process.cwd(), "tests", "support", "converter-v3-learned-fixtures.json");
}

export function getLearnedFixtureDirectory() {
  return path.join(process.cwd(), "tests", "fixtures", "sites", "learned");
}

function normalizeTags(tags: string[] | undefined): LearnedFixtureTag[] {
  return [...new Set((tags ?? []).filter((tag): tag is LearnedFixtureTag => {
    return (LEARNED_FIXTURE_TAGS as readonly string[]).includes(tag);
  }))];
}

function normalizeName(name: string) {
  return name.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\.\.+/g, ".").trim();
}

function normalizeManifestEntry(
  entry: LearnedFixtureManifestEntry
): LearnedFixtureManifestEntry | null {
  const name = normalizeName(entry.name);
  const tags = normalizeTags(entry.tags);

  if (!name || tags.length === 0) {
    return null;
  }

  return {
    name,
    tags,
    verifyExport: entry.verifyExport ?? true,
    preferBrowser: entry.preferBrowser ?? true,
    minSimilarity:
      typeof entry.minSimilarity === "number" && Number.isFinite(entry.minSimilarity)
        ? Math.min(1, Math.max(0, entry.minSimilarity))
        : undefined,
    expectedLayoutTypes: Array.isArray(entry.expectedLayoutTypes)
      ? [...new Set(entry.expectedLayoutTypes.filter(Boolean))]
      : undefined,
    promotedAt: entry.promotedAt,
    sourceKind: entry.sourceKind
  };
}

export function getDefaultLearnedFixtureManifest(): LearnedFixtureManifest {
  return {
    version: 1,
    fixtures: []
  };
}

export function readLearnedFixtureManifestSync(
  manifestPath = getLearnedFixtureManifestPath()
): LearnedFixtureManifest {
  if (!existsSync(manifestPath)) {
    return getDefaultLearnedFixtureManifest();
  }

  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as Partial<LearnedFixtureManifest>;
    const fixtures = Array.isArray(parsed.fixtures)
      ? parsed.fixtures
          .map((entry) => normalizeManifestEntry(entry as LearnedFixtureManifestEntry))
          .filter((entry): entry is LearnedFixtureManifestEntry => Boolean(entry))
      : [];

    return {
      version: 1,
      fixtures
    };
  } catch {
    return getDefaultLearnedFixtureManifest();
  }
}

export async function readLearnedFixtureManifest(
  manifestPath = getLearnedFixtureManifestPath()
): Promise<LearnedFixtureManifest> {
  try {
    const source = await readFile(manifestPath, "utf8");
    const parsed = JSON.parse(source) as Partial<LearnedFixtureManifest>;
    const fixtures = Array.isArray(parsed.fixtures)
      ? parsed.fixtures
          .map((entry) => normalizeManifestEntry(entry as LearnedFixtureManifestEntry))
          .filter((entry): entry is LearnedFixtureManifestEntry => Boolean(entry))
      : [];

    return {
      version: 1,
      fixtures
    };
  } catch {
    return getDefaultLearnedFixtureManifest();
  }
}

export async function writeLearnedFixtureManifest(
  manifest: LearnedFixtureManifest,
  manifestPath = getLearnedFixtureManifestPath()
) {
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        version: 1,
        fixtures: manifest.fixtures
          .map((entry) => normalizeManifestEntry(entry))
          .filter((entry): entry is LearnedFixtureManifestEntry => Boolean(entry))
      } satisfies LearnedFixtureManifest,
      null,
      2
    ),
    "utf8"
  );
}

export async function upsertLearnedFixtureManifestEntry(
  entry: LearnedFixtureManifestEntry,
  manifestPath = getLearnedFixtureManifestPath()
) {
  const normalizedEntry = normalizeManifestEntry(entry);

  if (!normalizedEntry) {
    throw new Error("Entrada de fixture aprendida invalida.");
  }

  const manifest = await readLearnedFixtureManifest(manifestPath);
  const nextFixtures = manifest.fixtures.filter(
    (fixture) => fixture.name !== normalizedEntry.name
  );

  nextFixtures.push(normalizedEntry);
  nextFixtures.sort((left, right) => left.name.localeCompare(right.name));

  await writeLearnedFixtureManifest(
    {
      version: 1,
      fixtures: nextFixtures
    },
    manifestPath
  );
}
