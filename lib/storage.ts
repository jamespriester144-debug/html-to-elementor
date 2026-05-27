import { createSupabaseAdmin } from "@/lib/supabase";

const DEFAULT_ASSET_BUCKET = "conversion-assets";
const BUCKET_ALREADY_EXISTS_PATTERN = /already exists/i;
const BUCKET_NOT_FOUND_PATTERN = /(not found|does not exist|no such bucket)/i;
const RETRYABLE_STORAGE_MESSAGE_PATTERN = /(bad request|fetch failed|network)/i;
type UploadBody = ArrayBuffer | Uint8Array | Buffer;
type StorageServiceError = {
  message?: string;
  status?: number;
  statusCode?: string;
} | null;

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

function formatStorageError(error: StorageServiceError) {
  const message = error?.message || "Erro desconhecido";
  const status =
    typeof error?.status === "number" ? ` status=${error.status}` : "";
  const statusCode = error?.statusCode ? ` code=${error.statusCode}` : "";

  return `${message}${status}${statusCode}`;
}

function isMissingBucketError(error: StorageServiceError) {
  const message = error?.message?.toLowerCase() ?? "";

  return error?.status === 404 || BUCKET_NOT_FOUND_PATTERN.test(message);
}

function shouldRetryUpload(error: StorageServiceError) {
  if (!error) {
    return false;
  }

  if (isMissingBucketError(error)) {
    return true;
  }

  if (
    error.status === undefined ||
    [400, 408, 429, 500, 502, 503, 504].includes(error.status)
  ) {
    return true;
  }

  return RETRYABLE_STORAGE_MESSAGE_PATTERN.test(error.message ?? "");
}

async function ensureConversionAssetBucketWithClient(
  supabase: ReturnType<typeof createSupabaseAdmin>
) {
  const bucketName = getAssetBucketName();
  const { error: getError } = await supabase.storage.getBucket(bucketName);

  if (!getError) {
    return bucketName;
  }

  if (!isMissingBucketError(getError)) {
    throw new Error(
      `Nao foi possivel consultar o bucket ${bucketName} no Supabase Storage: ${formatStorageError(getError)}`
    );
  }

  const { error } = await supabase.storage.createBucket(bucketName, {
    public: true,
    fileSizeLimit: "25MB"
  });

  if (error && !BUCKET_ALREADY_EXISTS_PATTERN.test(error.message ?? "")) {
    throw new Error(
      `Nao foi possivel criar o bucket ${bucketName}: ${formatStorageError(error)}`
    );
  }

  return bucketName;
}

export async function ensureConversionAssetBucket() {
  return ensureConversionAssetBucketWithClient(createSupabaseAdmin());
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
  const bucketName = getAssetBucketName();
  const storagePath = normalizeStoragePath(
    `${conversionKey}/${Date.now()}-${sourcePath}`
  );
  const uploadBody = normalizeUploadBody(body);

  let { error } = await supabase.storage
    .from(bucketName)
    .upload(storagePath, uploadBody, {
      contentType,
      upsert: true
    });

  // Storage occasionally returns transient client errors for otherwise valid
  // uploads. Retry once after confirming the bucket exists.
  if (error && shouldRetryUpload(error)) {
    try {
      await ensureConversionAssetBucketWithClient(supabase);
    } catch (bucketError) {
      const bucketMessage =
        bucketError instanceof Error ? bucketError.message : "Erro desconhecido";

      throw new Error(
        `Nao foi possivel enviar imagem para o Supabase Storage: ${formatStorageError(error)}. Tambem nao foi possivel garantir o bucket ${bucketName}: ${bucketMessage} (bucket=${bucketName}, path=${storagePath}, contentType=${contentType}, bytes=${uploadBody.byteLength})`
      );
    }

    ({ error } = await supabase.storage.from(bucketName).upload(
      storagePath,
      uploadBody,
      {
        contentType,
        upsert: true
      }
    ));
  }

  if (error) {
    throw new Error(
      `Nao foi possivel enviar imagem para o Supabase Storage: ${formatStorageError(error)} (bucket=${bucketName}, path=${storagePath}, contentType=${contentType}, bytes=${uploadBody.byteLength})`
    );
  }

  const { data } = supabase.storage.from(bucketName).getPublicUrl(storagePath);

  return data.publicUrl;
}
