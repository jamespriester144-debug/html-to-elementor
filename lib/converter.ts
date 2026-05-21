import { runPixelPerfectConversionPipeline } from "@/lib/converter-v2/pipeline";
import type { ElementorDocument } from "@/types/conversion";

export async function convertHtmlToElementor(html: string): Promise<ElementorDocument> {
  const result = await runPixelPerfectConversionPipeline(html, "raw-html");

  return result.elementorJson;
}
