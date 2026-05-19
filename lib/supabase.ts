import { createClient } from "@supabase/supabase-js";

import { getRequiredEnv } from "@/lib/env";
import type { ConversionRecord, ElementorDocument } from "@/types/conversion";

const conversionSelectFields =
  "id, html, elementor_json, status, payment_id, created_at, updated_at";

const missingOriginalHtmlMessages = [
  "original_html",
  "schema cache"
];

export function createSupabaseClient() {
  return createClient(
    getRequiredEnv("SUPABASE_URL"),
    getRequiredEnv("SUPABASE_ANON_KEY")
  );
}

export function createSupabaseAdmin() {
  return createClient(
    getRequiredEnv("SUPABASE_URL"),
    getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    }
  );
}

export async function saveConversion(
  html: string,
  elementorJson: ElementorDocument
): Promise<ConversionRecord> {
  const supabase = createSupabaseAdmin();

  const insertPayload = {
    html,
    original_html: html,
    elementor_json: elementorJson,
    status: "pending"
  };

  let { data, error } = await supabase
    .from("conversions")
    .insert(insertPayload)
    .select(conversionSelectFields)
    .single();

  const insertErrorMessage = error?.message ?? "";

  if (
    error &&
    missingOriginalHtmlMessages.every((message) =>
      insertErrorMessage.includes(message)
    )
  ) {
    const fallback = await supabase
      .from("conversions")
      .insert({
        html,
        elementor_json: elementorJson,
        status: "pending"
      })
      .select(conversionSelectFields)
      .single();

    data = fallback.data;
    error = fallback.error;
  }

  if (error) {
    throw new Error(error.message);
  }

  return data as ConversionRecord;
}

export async function getConversionById(
  id: string
): Promise<ConversionRecord | null> {
  const supabase = createSupabaseAdmin();
  const { data, error } = await supabase
    .from("conversions")
    .select(conversionSelectFields)
    .eq("id", id)
    .single();

  if (error) {
    return null;
  }

  return data as ConversionRecord;
}

export async function updateConversionStatusToPaid(
  id: string,
  paymentId?: string | null
): Promise<void> {
  const supabase = createSupabaseAdmin();
  const { error } = await supabase
    .from("conversions")
    .update({ status: "paid", payment_id: paymentId ?? null })
    .eq("id", id);

  if (error) {
    throw new Error(error.message);
  }
}
