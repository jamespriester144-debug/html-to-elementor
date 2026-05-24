import JSZip from "jszip";

export type ZipProjectSnapshot = {
  zip: JSZip;
  fileNames: string[];
  htmlEntries: string[];
  routeEntries: string[];
  sourceEntries: string[];
  reactEntryCandidates: string[];
  packageJsonEntries: string[];
};

function isRenderableSourceEntry(name: string) {
  return (
    /(^|\/)src\/.+\.(?:tsx|jsx|ts|js)$/i.test(name) &&
    !/\.d\.ts$/i.test(name) &&
    !/\.(?:test|spec|stories)\.(?:tsx|jsx|ts|js)$/i.test(name)
  );
}

function isReactEntryCandidate(name: string) {
  return (
    /(^|\/)src\/(?:main|index|App|Root|root|entry(?:-client|-server)?)\.(?:tsx|jsx|ts|js)$/i.test(
      name
    ) ||
    /(^|\/)src\/(?:routes|pages)\/.+\.(?:tsx|jsx|ts|js)$/i.test(name)
  );
}

export async function loadZipSnapshotFromBuffer(buffer: ArrayBuffer): Promise<ZipProjectSnapshot> {
  const zip = await JSZip.loadAsync(buffer);
  const fileNames = Object.values(zip.files)
    .filter((entry) => !entry.dir)
    .map((entry) => entry.name.replace(/\\/g, "/"));
  const sourceEntries = fileNames.filter(isRenderableSourceEntry);
  const routeEntries = sourceEntries.filter((name) =>
    /(^|\/)src\/(?:routes|pages)\/.+\.(?:tsx|jsx|ts|js)$/i.test(name)
  );
  const reactEntryCandidates = sourceEntries.filter(isReactEntryCandidate);

  return {
    zip,
    fileNames,
    htmlEntries: fileNames.filter((name) => name.toLowerCase().endsWith(".html")),
    routeEntries,
    sourceEntries,
    reactEntryCandidates,
    packageJsonEntries: fileNames.filter((name) => /(^|\/)package\.json$/i.test(name))
  };
}
