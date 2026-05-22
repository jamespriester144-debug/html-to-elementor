import type { PageCapture } from "@/lib/converter-v3/contracts/capture";
import type { LayoutDocument } from "@/lib/converter-v3/contracts/layout";
import { normalizeCaptureToLayoutDocument } from "@/lib/converter-v3/normalize/layout-normalizer";

export function detectLayoutDocument(capture: PageCapture): LayoutDocument {
  return normalizeCaptureToLayoutDocument(capture);
}
