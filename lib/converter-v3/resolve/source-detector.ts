import type { SourceKind } from "@/lib/converter-v3/contracts/source";
import type { ZipProjectSnapshot } from "@/lib/converter-v3/resolve/zip-project-reader";

export function detectSourceKindFromZipSnapshot(snapshot: ZipProjectSnapshot): SourceKind {
  if (snapshot.htmlEntries.length > 0) {
    return "static-html-archive";
  }

  if (snapshot.routeEntries.length > 0) {
    return "lovable-react-source";
  }

  throw new Error(
    "O arquivo .zip nao contem nenhum HTML exportado nem uma entrada Lovable/React reconhecivel."
  );
}

export function detectSourceKindFromUpload(fileName: string): SourceKind {
  return fileName.toLowerCase().endsWith(".zip") ? "static-html-archive" : "raw-html";
}
