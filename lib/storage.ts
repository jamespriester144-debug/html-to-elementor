import { createSupabaseAdmin } from "@/lib/supabase";

const DEFAULT_ASSET_BUCKET = "conversion-assets";

function getAssetBucketName() {
  return process.env.SUPABASE_STORAGE_BUCKET || DEFAULT_ASSET_BUCKET;
}

function normalizeStoragePath(path: string) {
  return path
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/[^a-zA-Z0-9._/-]/g, "-")
    .replace(/\/+/g, "/");
}

export async function ensureConversionAssetBucket() {
  const supabase = createSupabaseAdmin();
  const bucketName = getAssetBucketName();
  const { data: buckets, error: listError } = await supabase.storage.listBuckets();

  if (listError) {
    throw new Error(`Nao foi possivel listar buckets do Supabase Storage: ${listError.message}`);
  }

  if (buckets?.some((bucket) => bucket.name === bucketName)) {
    return bucketName;
  }

  const { error } = await supabase.storage.createBucket(bucketName, {
    public: true,
    fileSizeLimit: "25MB"
  });

  if (error && !error.message.toLowerCase().includes("already exists")) {
    throw new Error(`Nao foi possivel criar o bucket ${bucketName}: ${error.message}`);
  }

  return bucketName;
}

export async function uploadConversionAsset({
  conversionKey,
  sourcePath,
  contentType,
  body
}: {
  conversionKey: string;
  sourcePath: string;
  contentType: string;
  body: ArrayBuffer;
}) {
  const supabase = createSupabaseAdmin();
  const bucketName = await ensureConversionAssetBucket();
  const storagePath = normalizeStoragePath(
    `${conversionKey}/${Date.now()}-${sourcePath}`
  );
  const { error } = await supabase.storage
    .from(bucketName)
    .upload(storagePath, body, {
      contentType,
      upsert: true
    });

  if (error) {
    throw new Error(`Nao foi possivel enviar imagem para o Supabase Storage: ${error.message}`);
  }

  const { data } = supabase.storage.from(bucketName).getPublicUrl(storagePath);

  return data.publicUrl;
}
