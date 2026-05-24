import { createSupabaseAdmin } from "@/lib/supabase";

const DEFAULT_ASSET_BUCKET = "conversion-assets";
type UploadBody = ArrayBuffer | Uint8Array | Buffer;

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

function normalizeUploadBody(body: UploadBody) {
  if (Buffer.isBuffer(body)) {
    return body;
  }

  if (body instanceof Uint8Array) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }

  return Buffer.from(body);
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
  body: UploadBody;
}) {
  const supabase = createSupabaseAdmin();
  const bucketName = await ensureConversionAssetBucket();
  const storagePath = normalizeStoragePath(
    `${conversionKey}/${Date.now()}-${sourcePath}`
  );
  const uploadBody = normalizeUploadBody(body);
  const { error } = await supabase.storage
    .from(bucketName)
    .upload(storagePath, uploadBody, {
      contentType,
      upsert: true
    });

  if (error) {
    throw new Error(
      `Nao foi possivel enviar imagem para o Supabase Storage: ${error.message} (bucket=${bucketName}, path=${storagePath}, contentType=${contentType}, bytes=${uploadBody.byteLength})`
    );
  }

  const { data } = supabase.storage.from(bucketName).getPublicUrl(storagePath);

  return data.publicUrl;
}
