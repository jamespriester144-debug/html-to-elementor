import { uploadConversionAsset } from "@/lib/storage";

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
  const bodyBuffer = match[2]
    ? Buffer.from(match[3], "base64")
    : Buffer.from(decodeURIComponent(match[3]));

  return {
    contentType,
    body: bodyBuffer.buffer.slice(
      bodyBuffer.byteOffset,
      bodyBuffer.byteOffset + bodyBuffer.byteLength
    )
  };
}

export async function persistEmbeddedConversionAssets(
  html: string,
  elementorJson: unknown,
  conversionKey: string
) {
  let nextHtml = html;
  let jsonText = JSON.stringify(elementorJson);
  const dataUrls = new Set([
    ...(nextHtml.match(/data:[^"'()\s<>]+/g) ?? []),
    ...(jsonText.match(/data:[^"'()\s<>]+/g) ?? [])
  ]);
  let index = 0;

  for (const dataUrl of dataUrls) {
    const decoded = decodeDataUrl(dataUrl);

    if (!decoded) continue;

    index += 1;
    const publicUrl = await uploadConversionAsset({
      conversionKey,
      sourcePath: `embedded-${index}.${getDataUrlExtension(decoded.contentType)}`,
      contentType: decoded.contentType,
      body: decoded.body
    });

    nextHtml = nextHtml.split(dataUrl).join(publicUrl);
    jsonText = jsonText.split(dataUrl).join(publicUrl);
  }

  return {
    html: nextHtml,
    elementorJson: JSON.parse(jsonText)
  };
}
