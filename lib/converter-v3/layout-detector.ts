import type { PageCapture } from "@/lib/converter-v3/contracts/capture";
import type { LayoutDocument } from "@/lib/converter-v3/contracts/layout";
import { normalizeCaptureToLayoutDocument } from "@/lib/converter-v3/normalize/layout-normalizer";
import { classifySections } from "@/lib/converter-v3/section-classifier";
import { buildVisualHierarchy } from "@/lib/converter-v3/visual-hierarchy";

export function detectLayoutDocument(capture: PageCapture): LayoutDocument {
  const normalized = normalizeCaptureToLayoutDocument(capture);
  const withHierarchy = buildVisualHierarchy(normalized);
  return classifySections(withHierarchy);
}
