import type { CapturedBackgroundLayer } from "@/lib/converter-v3/contracts/capture";

export const VISUAL_LAZY_SOURCE_ATTRIBUTES = [
  "data-src",
  "data-lazy-src",
  "data-original",
  "data-url"
] as const;

export const VISUAL_LAZY_SRCSET_ATTRIBUTES = [
  "data-srcset",
  "data-lazy-srcset"
] as const;

export function splitCssBackgroundLayers(value: string): string[] {
  const layers: string[] = [];
  let current = "";
  let depth = 0;
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const previous = index > 0 ? value[index - 1] : "";

    if (quote) {
      current += char;

      if (char === quote && previous !== "\\") {
        quote = null;
      }

      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }

    if (char === "(") {
      depth += 1;
      current += char;
      continue;
    }

    if (char === ")") {
      depth = Math.max(depth - 1, 0);
      current += char;
      continue;
    }

    if (char === "," && depth === 0) {
      const trimmed = current.trim();

      if (trimmed) {
        layers.push(trimmed);
      }

      current = "";
      continue;
    }

    current += char;
  }

  const trimmed = current.trim();

  if (trimmed) {
    layers.push(trimmed);
  }

  return layers;
}

export function extractSrcsetCandidates(value: string | null | undefined): string[] {
  if (!value) {
    return [];
  }

  const candidates: string[] = [];
  let index = 0;

  while (index < value.length) {
    while (index < value.length && /[\s,]/.test(value[index] ?? "")) {
      index += 1;
    }

    if (index >= value.length) {
      break;
    }

    const isDataUrl = value.slice(index, index + 5).toLowerCase() === "data:";
    let candidate = "";

    while (index < value.length) {
      const char = value[index] ?? "";

      if (/\s/.test(char) || (!isDataUrl && char === ",")) {
        break;
      }

      candidate += char;
      index += 1;
    }

    const normalizedCandidate = candidate.trim();

    if (normalizedCandidate) {
      candidates.push(normalizedCandidate);
    }

    while (index < value.length && value[index] !== ",") {
      index += 1;
    }

    if (value[index] === ",") {
      index += 1;
    }
  }

  return candidates;
}

export function extractCssUrls(value: string | null | undefined): string[] {
  if (!value || value === "none") {
    return [];
  }

  return splitCssBackgroundLayers(value).flatMap((layer) =>
    [...layer.matchAll(/url\((['"]?)(.*?)\1\)/gi)]
      .map((match) => match[2]?.trim())
      .filter((item): item is string => Boolean(item))
  );
}

export function buildCapturedBackgroundLayers(
  value: string | null | undefined
): CapturedBackgroundLayer[] {
  if (!value || value === "none") {
    return [];
  }

  return splitCssBackgroundLayers(value).map((layer, index) => {
    const url = [...layer.matchAll(/url\((['"]?)(.*?)\1\)/gi)]
      .map((match) => match[2]?.trim())
      .find((item): item is string => Boolean(item));
    const normalized = layer.trim();
    const type = /(?:^|[^-])(linear|radial|conic)-gradient\(/i.test(normalized)
      ? "gradient"
      : url
        ? "image"
        : "other";

    return {
      index,
      type,
      value: normalized,
      url
    };
  });
}

export function uniqueNonEmpty(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  values.forEach((value) => {
    const normalized = value?.trim();

    if (!normalized || seen.has(normalized)) {
      return;
    }

    seen.add(normalized);
    result.push(normalized);
  });

  return result;
}
