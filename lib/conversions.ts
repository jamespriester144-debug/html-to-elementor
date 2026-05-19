import { notFound } from "next/navigation";

import {
  getConversionById,
  saveConversion,
  updateConversionStatusToPaid
} from "@/lib/supabase";
import type { ConversionRecord, ElementorDocument } from "@/types/conversion";

export async function getConversion(id: string): Promise<ConversionRecord | null> {
  return getConversionById(id);
}

export async function requireConversion(id: string): Promise<ConversionRecord> {
  const conversion = await getConversion(id);

  if (!conversion) {
    notFound();
  }

  return conversion;
}

export async function createConversion(
  html: string,
  elementorJson: ElementorDocument
): Promise<ConversionRecord> {
  return saveConversion(html, elementorJson);
}

export async function markConversionAsPaid(
  id: string,
  paymentId?: string | null
): Promise<void> {
  await updateConversionStatusToPaid(id, paymentId);
}
