import JSZip from "jszip";

export type ZipProjectSnapshot = {
  zip: JSZip;
  fileNames: string[];
  htmlEntries: string[];
  routeEntries: string[];
};

export async function loadZipSnapshotFromBuffer(buffer: ArrayBuffer): Promise<ZipProjectSnapshot> {
  const zip = await JSZip.loadAsync(buffer);
  const fileNames = Object.values(zip.files)
    .filter((entry) => !entry.dir)
    .map((entry) => entry.name.replace(/\\/g, "/"));

  return {
    zip,
    fileNames,
    htmlEntries: fileNames.filter((name) => name.toLowerCase().endsWith(".html")),
    routeEntries: fileNames.filter((name) =>
      /src\/(?:routes\/index|pages\/index|App)\.(?:tsx|jsx)$/i.test(name)
    )
  };
}
