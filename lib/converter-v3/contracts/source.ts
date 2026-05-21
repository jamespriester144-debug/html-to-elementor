export type SourceKind = "raw-html" | "static-html-archive" | "lovable-react-source";

export type ResolvedAssetKind = "image" | "font" | "stylesheet" | "script" | "other";

export type ResolvedAssetLocation = "embedded" | "external" | "local";

export type ResolvedAsset = {
  kind: ResolvedAssetKind;
  source: string;
  location: ResolvedAssetLocation;
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
};
