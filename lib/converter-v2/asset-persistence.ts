import { uploadConversionAsset } from "@/lib/storage";

const DATA_URL_PATTERN = /data:image\/[^"'()\s<>]+/gi;

export type PersistEmbeddedConversionAssets = <T>(
  html: string,
  elementorJson: T,
  conversionKey: string
) => Promise<{
  html: string;
  elementorJson: T;
}>;

type PersistEmbeddedAssetDependencies = {
  uploadConversionAsset: typeof uploadConversionAsset;
};

function getDataUrlExtension(contentType: string) {
  if (contentType.includes("png")) return "png";
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return "jpg";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("svg")) return "svg";
  if (contentType.includes("gif")) return "gif";
  if (contentType.includes("avif")) return "avif";
  return "bin";
}

function decodeDataUrl(dataUrl: string) {
  const match = dataUrl.match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/);

  if (!match) return null;

  const contentType = match[1] || "application/octet-stream";
  const body = match[2]
    ? Buffer.from(match[3], "base64")
    : Buffer.from(decodeURIComponent(match[3]));

  return {
    contentType,
    body
  };
}

async function replaceDataUrlsInString(
  value: string,
  replaceDataUrl: (dataUrl: string) => Promise<string>
) {
  const matches = [...value.matchAll(new RegExp(DATA_URL_PATTERN.source, "gi"))];

  if (matches.length === 0) {
    return value;
  }

  let nextValue = "";
  let lastIndex = 0;

  for (const match of matches) {
    const dataUrl = match[0];
    const start = match.index ?? 0;
    const publicUrl = await replaceDataUrl(dataUrl);

    nextValue += value.slice(lastIndex, start);
    nextValue += publicUrl;
    lastIndex = start + dataUrl.length;
  }

  nextValue += value.slice(lastIndex);
  return nextValue;
}

async function persistAssetsInValue<T>(
  value: T,
  replaceDataUrl: (dataUrl: string) => Promise<string>
): Promise<T> {
  if (typeof value === "string") {
    return (await replaceDataUrlsInString(value, replaceDataUrl)) as T;
  }

  if (Array.isArray(value)) {
    return (await Promise.all(
      value.map((item) => persistAssetsInValue(item, replaceDataUrl))
    )) as T;
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const entries = await Promise.all(
    Object.entries(value).map(async ([key, nestedValue]) => [
      key,
      await persistAssetsInValue(nestedValue, replaceDataUrl)
    ])
  );

  return Object.fromEntries(entries) as T;
}

export function createEmbeddedConversionAssetPersister(
  deps: PersistEmbeddedAssetDependencies = {
    uploadConversionAsset
  }
): PersistEmbeddedConversionAssets {
  return async function persistEmbeddedConversionAssets<T>(
    html: string,
    elementorJson: T,
    conversionKey: string
  ) {
    const uploadedUrls = new Map<string, string>();
    let index = 0;

    const replaceDataUrl = async (dataUrl: string) => {
      const cachedUrl = uploadedUrls.get(dataUrl);

      if (cachedUrl) {
        return cachedUrl;
      }

      const decoded = decodeDataUrl(dataUrl);

      if (!decoded) {
        return dataUrl;
      }

      index += 1;

      try {
        const publicUrl = await deps.uploadConversionAsset({
          conversionKey,
          sourcePath: `embedded-${index}.${getDataUrlExtension(decoded.contentType)}`,
          contentType: decoded.contentType,
          body: decoded.body
        });

        uploadedUrls.set(dataUrl, publicUrl);
        return publicUrl;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Erro desconhecido";

        console.warn(
          `[ASSET] Falha ao enviar asset embutido para o Supabase Storage. Mantendo data URL original. conversionKey=${conversionKey} index=${index} contentType=${decoded.contentType} bytes=${decoded.body.byteLength} motivo=${message}`
        );
        uploadedUrls.set(dataUrl, dataUrl);
        return dataUrl;
      }
    };

    return {
      html: await replaceDataUrlsInString(html, replaceDataUrl),
      elementorJson: await persistAssetsInValue(elementorJson, replaceDataUrl)
    };
  };
}

export const persistEmbeddedConversionAssets =
  createEmbeddedConversionAssetPersister();
