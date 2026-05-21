import { createClient } from "@supabase/supabase-js";

import { getRequiredEnv } from "@/lib/env";
import type { ConversionRecord, ElementorDocument } from "@/types/conversion";

const MAX_STORED_HTML_LENGTH = 200_000;

const conversionSelectFields =
  "id, html, elementor_json, status, payment_id, created_at, updated_at";

const missingOriginalHtmlMessages = [
  "original_html",
  "schema cache"
];

function getSupabaseProjectUrl() {
  return getRequiredEnv("SUPABASE_URL")
    .replace(/\/rest\/v1\/?$/i, "")
    .replace(/\/+$/, "");
}

export function createSupabaseClient() {
  return createClient(
    getSupabaseProjectUrl(),
    getRequiredEnv("SUPABASE_ANON_KEY")
  );
}

export function createSupabaseAdmin() {
  return createClient(
    getSupabaseProjectUrl(),
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
  const storedHtml = shrinkHtmlForDatabase(html);

  const insertPayload = {
    html: storedHtml,
    original_html: storedHtml,
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
        html: storedHtml,
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

function shrinkHtmlForDatabase(html: string): string {
  const withoutLargeDataUrls = html.replace(
    /data:([a-z]+\/[a-z0-9.+-]+);base64,[a-z0-9+/=]+/gi,
    "data:$1;base64,[embedded-asset-omitted-from-database-preview]"
  );

  if (withoutLargeDataUrls.length <= MAX_STORED_HTML_LENGTH) {
    return withoutLargeDataUrls;
  }

  return `${withoutLargeDataUrls.slice(0, MAX_STORED_HTML_LENGTH)}
<!-- Original HTML truncated for database preview. Elementor JSON remains available for paid download. -->`;
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
