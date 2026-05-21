import type { PageCapture } from "@/lib/converter-v3/contracts/capture";
import type { LayoutNode } from "@/lib/converter-v3/contracts/layout";
import { describePresetChildren } from "@/lib/converter-v3/emitters/elementor/responsive-layout";

export type PresetContext = {
  preset: string;
  role: string;
  index: number;
  cardNodeId: string;
};

export type PresetNodeMaps = {
  layoutById: Map<string, LayoutNode>;
  captureById: Map<string, PageCapture["nodes"][number]>;
};

function sanitizeText(value: string | undefined) {
  return value?.replace(/\s+/g, " ").trim() || "";
}

function isPriceLikeText(text: string) {
  return /\$\s?\d|(?:usd|eur|gbp|brl)\s?\d|\d+(?:[.,]\d{2})/.test(text.toLowerCase());
}

function isShortTitleLikeText(text: string) {
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  return text.length <= 48 && wordCount <= 8 && !/[.!?]/.test(text);
}

function isEyebrowLikeText(text: string) {
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  return text.length <= 24 && wordCount <= 4;
}

function isRatingLikeText(text: string) {
  return /(?:★|☆){3,}|(?:\b[1-5](?:\.\d)?\/5\b)|(?:\b[1-5](?:\.\d)?\s*out of 5\b)/i.test(text);
}

export function getPresetContext(
  node: LayoutNode,
  maps: PresetNodeMaps
): PresetContext | undefined {
  let currentNode: LayoutNode | undefined = node;

  while (currentNode?.parentId) {
    const parentNode = maps.layoutById.get(currentNode.parentId);

    if (!parentNode) {
      break;
    }

    const presetChildren = describePresetChildren(parentNode, maps.layoutById, "desktop");
    const descriptor = presetChildren.get(currentNode.id);

    if (descriptor) {
      return {
        preset: descriptor.preset,
        role: descriptor.role,
        index: descriptor.index,
        cardNodeId: currentNode.id
      };
    }

    currentNode = parentNode;
  }

  return undefined;
}

function getDescendantLeafNodes(cardNodeId: string, maps: PresetNodeMaps) {
  const queue = [...(maps.layoutById.get(cardNodeId)?.children ?? [])];
  const descendants: LayoutNode[] = [];

  while (queue.length) {
    const currentId = queue.shift();

    if (!currentId) {
      continue;
    }

    const current = maps.layoutById.get(currentId);

    if (!current || current.flags.hidden) {
      continue;
    }

    descendants.push(current);
    queue.push(...current.children);
  }

  return descendants;
}

function getPresetTextEntries(cardNodeId: string, maps: PresetNodeMaps) {
  return getDescendantLeafNodes(cardNodeId, maps)
    .filter((candidate) => candidate.kind === "text" || candidate.kind === "badge")
    .map((candidate) => ({
      node: candidate,
      text:
        sanitizeText(candidate.content.text) ||
        sanitizeText(maps.captureById.get(candidate.id)?.text),
      tag: maps.captureById.get(candidate.id)?.tag ?? ""
    }))
    .filter((entry) => entry.text)
    .sort((left, right) => left.node.visualOrder - right.node.visualOrder);
}

export function getPresetSemanticHint(
  node: LayoutNode,
  maps: PresetNodeMaps,
  captureNode: PageCapture["nodes"][number] | undefined,
  presetContext?: PresetContext
) {
  if (!presetContext) {
    return undefined;
  }

  if (node.kind === "image") {
    if (presetContext.preset === "pricing-cards") {
      return "pricing-media";
    }

    if (presetContext.preset === "testimonial-cards") {
      return "testimonial-media";
    }

    if (presetContext.preset === "feature-cards") {
      return "feature-media";
    }
  }

  if (node.kind === "button") {
    if (presetContext.preset === "pricing-cards") {
      return "pricing-cta";
    }

    if (presetContext.preset === "feature-cards") {
      return "feature-cta";
    }

    if (presetContext.preset === "testimonial-cards") {
      return "testimonial-cta";
    }
  }

  if (node.kind !== "text" && node.kind !== "badge") {
    return undefined;
  }

  const text = sanitizeText(node.content.text) || sanitizeText(captureNode?.text);

  if (!text) {
    return undefined;
  }

  const textEntries = getPresetTextEntries(presetContext.cardNodeId, maps);

  if (presetContext.preset === "pricing-cards") {
    if (isPriceLikeText(text)) {
      return "price";
    }

    const titleCandidate = textEntries.find(
      (entry) => !isPriceLikeText(entry.text) && (/^h[1-6]$/.test(entry.tag) || isShortTitleLikeText(entry.text))
    );

    if (titleCandidate?.node.id === node.id) {
      return "pricing-title";
    }

    return "pricing-support";
  }

  if (presetContext.preset === "testimonial-cards") {
    const ratingCandidate = textEntries.find((entry) => isRatingLikeText(entry.text));
    const quoteCandidate =
      textEntries.find((entry) => entry.tag === "blockquote") ??
      [...textEntries]
        .filter((entry) => !isRatingLikeText(entry.text))
        .sort((left, right) => right.text.length - left.text.length)[0];
    const attributionCandidate = [...textEntries]
      .filter(
        (entry) =>
          entry.node.id !== quoteCandidate?.node.id &&
          !isRatingLikeText(entry.text) &&
          entry.text.length <= 40
      )
      .at(-1);

    if (ratingCandidate?.node.id === node.id) {
      return "testimonial-rating";
    }

    if (quoteCandidate?.node.id === node.id && quoteCandidate.text.length >= 32) {
      return "testimonial-quote";
    }

    if (attributionCandidate?.node.id === node.id) {
      return "testimonial-attribution";
    }

    return "testimonial-support";
  }

  if (presetContext.preset === "feature-cards") {
    const eyebrowCandidate =
      textEntries.length >= 3
        ? textEntries.find((entry) => isEyebrowLikeText(entry.text))
        : undefined;
    const remainingEntries = textEntries.filter((entry) => entry.node.id !== eyebrowCandidate?.node.id);
    const titleCandidate =
      remainingEntries.find((entry) => /^h[1-6]$/.test(entry.tag)) ??
      remainingEntries.find((entry) => isShortTitleLikeText(entry.text));

    if (eyebrowCandidate?.node.id === node.id) {
      return "feature-eyebrow";
    }

    if (titleCandidate?.node.id === node.id) {
      return "feature-title";
    }

    return "feature-support";
  }

  return undefined;
}
