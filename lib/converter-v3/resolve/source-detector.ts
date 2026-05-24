import type { SourceKind } from "@/lib/converter-v3/contracts/source";
import type { ZipProjectSnapshot } from "@/lib/converter-v3/resolve/zip-project-reader";

export function detectSourceKindFromZipSnapshot(snapshot: ZipProjectSnapshot): SourceKind {
  const hasLovableReactSource =
    snapshot.reactEntryCandidates.length > 0 ||
    snapshot.routeEntries.length > 0 ||
    (snapshot.sourceEntries.length > 0 && snapshot.packageJsonEntries.length > 0);

  if (hasLovableReactSource) {
    return "lovable-react-source";
  }

  if (snapshot.htmlEntries.length > 0) {
    return "static-html-archive";
  }

  throw new Error(
    "O arquivo .zip nao contem nenhum HTML exportado nem uma entrada Lovable/React reconhecivel."
  );
}

export function detectSourceKindFromUpload(fileName: string): SourceKind {
  return fileName.toLowerCase().endsWith(".zip") ? "static-html-archive" : "raw-html";
}
