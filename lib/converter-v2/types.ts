import type { ElementorDocument } from "@/types/conversion";

export type ConversionSourceKind =
  | "raw-html"
  | "static-html-archive"
  | "lovable-react-source";

export type ConversionStrategy = "pixel-perfect-iframe-v2";

export type ConversionCountSummary = {
  text: number;
  heading: number;
  image: number;
  button: number;
};

export type PixelPerfectReport = {
  sourceKind: ConversionSourceKind;
  strategy: ConversionStrategy;
  totalTextosEncontrados: number;
  totalTextosConvertidos: number;
  totalImagensEncontradas: number;
  totalImagensConvertidas: number;
  totalBotoesEncontrados: number;
  totalBotoesConvertidos: number;
  totalHeadingsEncontrados: number;
  totalHeadingsConvertidos: number;
  totalElementosExportados: number;
  elementosPerdidos: Array<{
    type: "text" | "image" | "button" | "heading";
    value: string;
  }>;
  elementosRecuperados: Array<{
    type: "text" | "image" | "button" | "heading";
    value: string;
  }>;
  imagensNaoCarregadas: string[];
  warnings: string[];
  status: "success" | "warning" | "blocked";
  exportBlocked: boolean;
  screenshots: Record<string, never>;
  visualComparison: {
    desktop: { passed: boolean };
    tablet: { passed: boolean };
    mobile: { passed: boolean };
  };
  captureFailed: boolean;
  errors: string[];
};

export type ExtractedSource = {
  html: string;
  sourceKind: ConversionSourceKind;
};

export type PixelPerfectPipelineResult = {
  cleanHtml: string;
  elementorJson: ElementorDocument;
  report: PixelPerfectReport;
  outputDir: null;
  sourceKind: ConversionSourceKind;
  strategy: ConversionStrategy;
};
