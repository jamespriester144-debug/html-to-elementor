import type { InputPageAnalysis } from "@/lib/converter-v3/contracts/input-analysis";

export type SourceKind = "raw-html" | "static-html-archive" | "lovable-react-source";

export type ResolvedAssetKind = "image" | "font" | "stylesheet" | "script" | "other";

export type ResolvedAssetLocation = "embedded" | "external" | "local";

export type ResolvedAsset = {
  kind: ResolvedAssetKind;
  source: string;
  location: ResolvedAssetLocation;
};

export type ResolvedRenderContext =
  | {
      mode: "set-content";
      sourcePath?: string | null;
      baseHref?: string;
    }
  | {
      mode: "local-server";
      documentRoot: string;
      entryPath: string;
      sourcePath?: string | null;
      baseHref?: string;
    };

export type ResolvedSource = {
  id: string;
  sourceKind: SourceKind;
  title: string;
  html: string;
  assets: ResolvedAsset[];
  entryFile: string | null;
  routeFile: string | null;
  archiveFileCount: number;
  notes: string[];
  sourcePath?: string | null;
  renderContext?: ResolvedRenderContext;
  inputAnalysis?: InputPageAnalysis;
};
