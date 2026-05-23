import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";

import type {
  InputAssetKind,
  InputAssetLoadStatus,
  InputAssetReference,
  InputFrameworkHint,
  InputLayoutType,
  InputPageAnalysis,
  InputPageDiagnostics,
  InputPageSectionCandidate,
  InputPageStructureSummary
} from "@/lib/converter-v3/contracts/input-analysis";
import type {
  ResolvedAssetKind,
  ResolvedAssetLocation,
  SourceKind
} from "@/lib/converter-v3/contracts/source";

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function parseInlineStyle(style: string | undefined) {
  if (!style) {
    return {};
  }

  return style
    .split(";")
    .map((declaration) => declaration.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((acc, declaration) => {
      const separatorIndex = declaration.indexOf(":");

      if (separatorIndex === -1) {
        return acc;
      }

      const property = declaration.slice(0, separatorIndex).trim().toLowerCase();
      const value = declaration.slice(separatorIndex + 1).trim();

      if (property && value) {
        acc[property] = value;
      }

      return acc;
    }, {});
}

function getAssetKind(source: string, attribute: string): InputAssetKind {
  const normalized = source.trim().toLowerCase();

  if (attribute === "background-image" || attribute === "data-background") {
    return "background";
  }

  if (attribute === "src" && /iframe/i.test(attribute)) {
    return "iframe";
  }

  if (
    /\.(png|jpe?g|webp|gif|svg|avif)(?:$|[?#])/i.test(normalized) ||
    normalized.startsWith("data:image/")
  ) {
    return "image";
  }

  if (/\.(woff2?|ttf|otf|eot)(?:$|[?#])/i.test(normalized)) {
    return "font";
  }

  if (/\.(css)(?:$|[?#])/i.test(normalized)) {
    return "stylesheet";
  }

  if (/\.(js|mjs)(?:$|[?#])/i.test(normalized)) {
    return "script";
  }

  if (attribute === "href") {
    return "link";
  }

  if (attribute === "src" && normalized.includes("iframe")) {
    return "iframe";
  }

  return "other";
}

function getAssetLocation(source: string): ResolvedAssetLocation {
  if (source.startsWith("data:")) {
    return "embedded";
  }

  if (/^(?:https?:)?\/\//i.test(source)) {
    return "external";
  }

  return "local";
}

function matchesLazyLoadAttributes(attributes: Record<string, string | undefined>) {
  return Boolean(
    attributes["loading"] === "lazy" ||
      attributes["data-src"] ||
      attributes["data-lazy-src"] ||
      attributes["data-original"] ||
      attributes["data-srcset"] ||
      attributes["data-lazy-srcset"]
  );
}

function matchesInlineStyle(
  style: Record<string, string>,
  predicate: (property: string, value: string) => boolean
) {
  return Object.entries(style).some(([property, value]) => predicate(property, value));
}

function extractUrlsFromStyleText(styleText: string) {
  return [...styleText.matchAll(/url\((['"]?)(.*?)\1\)/gi)]
    .map((match) => match[2]?.trim())
    .filter((value): value is string => Boolean(value));
}

function buildAssetReference(params: {
  url: string;
  sourceTag: string;
  sourceAttribute: string;
  lazy?: boolean;
}): InputAssetReference {
  const location = getAssetLocation(params.url);
  const kind = getAssetKind(params.url, params.sourceAttribute);

  return {
    url: params.url,
    originalUrl: params.url,
    kind,
    location,
    sourceTag: params.sourceTag,
    sourceAttribute: params.sourceAttribute,
    external: location === "external",
    lazy: Boolean(params.lazy)
  };
}

function collectAssetReferences(html: string) {
  const $ = cheerio.load(html);
  const assets = new Map<string, InputAssetReference>();

  const addAsset = (asset: InputAssetReference) => {
    const key = [
      asset.kind,
      asset.sourceTag,
      asset.sourceAttribute,
      asset.url
    ].join("|");

    if (!assets.has(key)) {
      assets.set(key, asset);
    }
  };

  $("img,source,video,link,script,iframe,audio").each((_, element) => {
    const node = $(element);
    const tag = element.tagName.toLowerCase();
    const lazy = matchesLazyLoadAttributes({
      loading: node.attr("loading"),
      "data-src": node.attr("data-src"),
      "data-lazy-src": node.attr("data-lazy-src"),
      "data-original": node.attr("data-original"),
      "data-srcset": node.attr("data-srcset"),
      "data-lazy-srcset": node.attr("data-lazy-srcset")
    });
    const candidateAttributes = [
      "src",
      "href",
      "poster",
      "data-src",
      "data-lazy-src",
      "data-original",
      "data-url",
      "data-background"
    ] as const;

    candidateAttributes.forEach((attribute) => {
      const value = node.attr(attribute);

      if (value) {
        addAsset(
          buildAssetReference({
            url: value,
            sourceTag: tag,
            sourceAttribute: attribute,
            lazy
          })
        );
      }
    });

    const srcset = node.attr("srcset") || node.attr("data-srcset") || node.attr("data-lazy-srcset");

    if (srcset) {
      srcset
        .split(",")
        .map((item) => item.trim().split(/\s+/)[0])
        .filter(Boolean)
        .forEach((url) => {
          addAsset(
            buildAssetReference({
              url,
              sourceTag: tag,
              sourceAttribute: "srcset",
              lazy
            })
          );
        });
    }
  });

  $("[style],style").each((_, element) => {
    const node = $(element);
    const styleText = node.attr("style") || node.html() || "";
    const sourceTag = element.tagName.toLowerCase();

    extractUrlsFromStyleText(styleText).forEach((url) => {
      addAsset(
        buildAssetReference({
          url,
          sourceTag,
          sourceAttribute: "background-image"
        })
      );
    });
  });

  return [...assets.values()];
}

function countRepeatedCardChildren($: cheerio.CheerioAPI) {
  let cardCount = 0;

  $("section,main,article,div,ul,ol").each((_, element) => {
    const node = $(element);
    const children = node.children("article,div,li,section").toArray();

    if (children.length < 2) {
      return;
    }

    const presentationChildren = children.filter((child) => {
      const childNode = $(child);
      const className = childNode.attr("class") || "";
      const style = parseInlineStyle(childNode.attr("style"));
      const hasPresentation =
        Boolean(style["background"]) ||
        Boolean(style["background-color"]) ||
        Boolean(style["border-radius"]) ||
        Boolean(style["box-shadow"]) ||
        /card|panel|tile|feature/i.test(className);
      const childText = normalizeWhitespace(childNode.text());
      return hasPresentation && childText.length > 0;
    });

    if (presentationChildren.length >= 2) {
      cardCount += presentationChildren.length;
    }
  });

  return cardCount;
}

function detectFrameworkHints($: cheerio.CheerioAPI, html: string) {
  const lowerHtml = html.toLowerCase();
  const hints = new Set<InputFrameworkHint>();

  if (
    /data-lovable|lovable/i.test(lowerHtml) ||
    $('meta[name="generator"][content*="Lovable" i]').length > 0
  ) {
    hints.add("lovable");
  }

  if (
    /__next|data-reactroot|react-dom|hydrateRoot|createRoot|id="root"/i.test(lowerHtml) ||
    $("#root,#__next,[data-reactroot]").length > 0
  ) {
    hints.add("react");
  }

  if (
    /vite|@vite|\/assets\/.*\.(?:js|css)/i.test(lowerHtml) ||
    $('script[type="module"]').length > 0
  ) {
    hints.add("vite");
  }

  if (
    /(?:^|\s)(?:container|mx-auto|px-\d+|py-\d+|grid|flex|md:|lg:|xl:)/i.test(
      $("[class]").toArray().map((element) => $(element).attr("class")).join(" ")
    ) ||
    /tailwind/i.test(lowerHtml)
  ) {
    hints.add("tailwind");
  }

  if (
    /bootstrap/i.test(lowerHtml) ||
    $("[class*='container'],[class*='row'],[class*='col-']").length > 0
  ) {
    hints.add("bootstrap");
  }

  return [...hints];
}

function buildSectionCandidates($: cheerio.CheerioAPI) {
  const candidates: InputPageSectionCandidate[] = [];
  const seen = new Set<string>();
  const candidateSelectors = [
    "header",
    "nav",
    "main",
    "footer",
    "section",
    "article",
    "[role='banner']",
    "[role='navigation']",
    "[role='main']",
    "[role='contentinfo']"
  ];

  const pushCandidate = (
    element: AnyNode,
    reason: string,
    depth: number
  ) => {
    const node = $(element);
    const tag = String(node.prop("tagName") || "div").toLowerCase();
    const id = node.attr("id") || undefined;
    const role = node.attr("role") || undefined;
    const key = id ? `${tag}#${id}` : `${tag}:${candidates.length + 1}`;

    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    candidates.push({
      key,
      tag,
      id,
      role,
      reason,
      depth,
      estimatedChildren: node.children().length
    });
  };

  candidateSelectors.forEach((selector) => {
    $(selector).each((_, element) => {
      const depth = $(element).parents().length;
      pushCandidate(element, `landmark:${selector}`, depth);
    });
  });

  $("body > div, body > section, body > article, body > main, main > div, main > section, main > article").each(
    (_, element) => {
      const node = $(element);
      const style = parseInlineStyle(node.attr("style"));
      const className = node.attr("class") || "";
      const text = normalizeWhitespace(node.text());
      const directChildren = node.children().length;
      const score =
        (directChildren >= 2 ? 1 : 0) +
        (Boolean(style["background"]) || Boolean(style["background-color"]) ? 1 : 0) +
        (/section|hero|feature|content|wrapper|container|grid|cards?/i.test(className) ? 1 : 0) +
        (/^h[1-6]$/i.test(node.find("h1,h2,h3").first().prop("tagName") || "") ? 1 : 0) +
        (text.length >= 80 ? 1 : 0);

      if (score >= 2) {
        pushCandidate(element, "visual-block", $(element).parents().length);
      }
    }
  );

  return candidates
    .sort((left, right) => left.depth - right.depth || left.estimatedChildren - right.estimatedChildren)
    .slice(0, 24);
}

function resolveLayoutTypes(params: {
  sourceKind: SourceKind;
  frameworkHints: InputFrameworkHint[];
  hasInlineCss: boolean;
  hasExternalCss: boolean;
  hasLocalAssets: boolean;
  hasRemoteAssets: boolean;
  absoluteCount: number;
  flexCount: number;
  gridCount: number;
  scriptCount: number;
}) {
  const layoutTypes = new Set<InputLayoutType>(["static-html"]);

  if (params.sourceKind === "lovable-react-source" || params.frameworkHints.includes("lovable")) {
    layoutTypes.add("lovable-export");
  }

  if (params.frameworkHints.includes("react") || params.frameworkHints.includes("vite")) {
    layoutTypes.add("vite-react-export");
  }

  if (params.frameworkHints.includes("react")) {
    layoutTypes.add("react-runtime");
  }

  if (params.frameworkHints.includes("tailwind")) {
    layoutTypes.add("tailwind");
  }

  if (params.frameworkHints.includes("bootstrap")) {
    layoutTypes.add("bootstrap");
  }

  if (params.hasInlineCss) {
    layoutTypes.add("inline-css");
  }

  if (params.hasExternalCss) {
    layoutTypes.add("external-css");
  }

  if (params.hasLocalAssets) {
    layoutTypes.add("local-assets");
  }

  if (params.hasRemoteAssets) {
    layoutTypes.add("remote-assets");
  }

  if (params.absoluteCount > 0) {
    layoutTypes.add("absolute-layout");
  }

  if (params.flexCount > 0) {
    layoutTypes.add("flex-layout");
  }

  if (params.gridCount > 0) {
    layoutTypes.add("grid-layout");
  }

  if (params.scriptCount > 0) {
    layoutTypes.add("scripted");
  }

  return [...layoutTypes];
}

function buildStaticDiagnostics(): InputPageDiagnostics {
  return {
    errors: [],
    warnings: [],
    resources: []
  };
}

function collectStructureSummary(
  $: cheerio.CheerioAPI,
  assets: InputAssetReference[],
  sectionCandidates: InputPageSectionCandidate[]
) {
  const allElements = $("body *").toArray();
  const inlineStyles = allElements.map((element) => parseInlineStyle($(element).attr("style")));
  const combinedClasses = allElements
    .map((element) => $(element).attr("class") || "")
    .join(" ");
  const scriptCount = $("script").length;
  const buttons =
    $("button,[role='button'],input[type='button'],input[type='submit']").length +
    $("a[href]").toArray().filter((element) => {
      const text = normalizeWhitespace($(element).text());
      return text.length > 0;
    }).length;
  const links = $("a[href]").length;
  const backgrounds = inlineStyles.filter((style) =>
    matchesInlineStyle(style, (property, value) =>
      property.startsWith("background") && value !== "none"
    )
  ).length;
  const absoluteFixedSticky = inlineStyles.filter((style) =>
    ["absolute", "fixed", "sticky"].includes(style["position"] || "")
  ).length;
  const zIndexNodes = inlineStyles.filter((style) => {
    const value = style["z-index"];
    return Boolean(value && value !== "auto" && value !== "0");
  }).length;
  const transformedElements = inlineStyles.filter((style) => {
    const value = style["transform"];
    return Boolean(value && value !== "none");
  }).length;
  const overflowHiddenElements = inlineStyles.filter((style) =>
    ["hidden", "clip"].includes(style["overflow"] || "") ||
    ["hidden", "clip"].includes(style["overflow-x"] || "") ||
    ["hidden", "clip"].includes(style["overflow-y"] || "")
  ).length;
  const classBasedAbsoluteCount = (combinedClasses.match(/\b(?:absolute|fixed|sticky)\b/g) || []).length;
  const classBasedGridCount = (combinedClasses.match(/\b(?:grid|grid-cols-\d+|row|col-\d+)\b/g) || []).length;
  const classBasedFlexCount = (combinedClasses.match(/\b(?:flex|inline-flex)\b/g) || []).length;
  const classBasedTransformCount = (combinedClasses.match(/\b(?:translate|scale|rotate|skew)\b/g) || []).length;
  const classBasedZIndexCount = (combinedClasses.match(/\bz-\d+\b/g) || []).length;
  const scriptedRoot =
    scriptCount > 0 &&
    ($("#root,#__next,[data-reactroot]").length > 0 || $("body").children().length <= 3);
  const cards = countRepeatedCardChildren($);
  const heroSections = sectionCandidates.filter((candidate) => /hero/i.test(candidate.key)).length +
    $("section,header,div").toArray().filter((element) => {
      const node = $(element);
      const text = normalizeWhitespace(node.text());
      const hasHeading = node.find("h1,h2").length > 0;
      const hasMedia = node.find("img,picture,video").length > 0;
      const hasButton = node.find("a[href],button,[role='button']").length > 0;
      return hasHeading && (hasMedia || hasButton) && text.length >= 40;
    }).length;
  const grids =
    inlineStyles.filter((style) =>
      style["display"] === "grid" || Boolean(style["grid-template-columns"])
    ).length + classBasedGridCount;
  const forms = $("form").length;
  const iframes = $("iframe").length;
  const images = $("img,picture,svg").length;
  const navbars = $("nav,[role='navigation']").length;
  const headers = $("header,[role='banner']").length;
  const lazyLoadElements = $("img[loading='lazy'],img[data-src],img[data-lazy-src],img[data-original],[data-srcset],[data-lazy-srcset],[data-background]").length;
  const carousels = $(
    "[class*='carousel' i],[class*='slider' i],[class*='swiper' i],[class*='slick' i],[class*='splide' i],[class*='glide' i],[class*='embla' i],[data-carousel],[data-slider]"
  ).length;
  const outOfFlowElements = absoluteFixedSticky + transformedElements + overflowHiddenElements;
  const localAssets = assets.filter((asset) => asset.location === "local").length;
  const externalAssets = assets.filter((asset) => asset.location === "external").length;
  const externalFonts = assets.filter(
    (asset) => asset.kind === "font" && asset.location === "external"
  ).length;

  return {
    totalElements: allElements.length,
    realSectionCount: Math.max(
      sectionCandidates.length,
      $("section,article,main,header,footer,nav").length
    ),
    headers,
    navbars,
    heroSections: Math.max(heroSections, headers > 0 ? 1 : 0),
    cards,
    grids,
    buttons,
    images,
    backgrounds,
    absoluteFixedSticky: absoluteFixedSticky + classBasedAbsoluteCount,
    zIndexNodes: zIndexNodes + classBasedZIndexCount,
    iframes,
    scripts: scriptCount,
    lazyLoadElements,
    externalAssets,
    externalFonts,
    links,
    forms,
    carousels,
    transformedElements: transformedElements + classBasedTransformCount,
    overflowHiddenElements,
    outOfFlowElements: outOfFlowElements + (scriptedRoot ? 1 : 0)
  } satisfies InputPageStructureSummary;
}

function buildRenderStrategy(params: {
  sourceKind: SourceKind;
  frameworkHints: InputFrameworkHint[];
  structure: InputPageStructureSummary;
  sectionCandidates: InputPageSectionCandidate[];
  assets: InputAssetReference[];
}) {
  const reasons: string[] = [];
  const localAssets = params.assets.filter((asset) => asset.location === "local").length;
  const externalStylesheets = params.assets.filter(
    (asset) => asset.kind === "stylesheet" && asset.location === "external"
  ).length;
  const scriptsRequired =
    params.structure.scripts > 0 &&
    (params.frameworkHints.includes("react") ||
      params.frameworkHints.includes("vite") ||
      params.structure.realSectionCount <= 1);

  if (scriptsRequired) {
    reasons.push("React/Vite/scripts detectados: a pagina precisa ser renderizada no browser.");
  }

  if (localAssets > 0) {
    reasons.push("Assets locais/relativos detectados: a captura precisa resolver caminhos reais.");
  }

  if (params.structure.lazyLoadElements > 0) {
    reasons.push("Lazy-load detectado: a captura deve estabilizar imagens e backgrounds.");
  }

  if (params.structure.absoluteFixedSticky > 0) {
    reasons.push("Elementos absolute/fixed/sticky detectados.");
  }

  if (params.structure.transformedElements > 0) {
    reasons.push("Transforms detectados.");
  }

  if (params.structure.overflowHiddenElements > 0) {
    reasons.push("Overflow hidden/clip detectado.");
  }

  if (params.structure.carousels > 0) {
    reasons.push("Carousel/slider detectado.");
  }

  if (params.structure.iframes > 0) {
    reasons.push("Embeds/iframes detectados.");
  }

  if (params.sectionCandidates.length === 0) {
    reasons.push("Nenhuma secao confiavel foi encontrada na analise inicial.");
  }

  if (externalStylesheets > 0) {
    reasons.push("Stylesheets externos detectados.");
  }

  const requiresBrowserRender = scriptsRequired || localAssets > 0 || externalStylesheets > 0;
  const preferVisualSnapshot =
    params.structure.absoluteFixedSticky > 0 ||
    params.structure.transformedElements > 0 ||
    params.structure.overflowHiddenElements > 0 ||
    params.structure.carousels > 0 ||
    params.structure.iframes > 0 ||
    scriptsRequired;
  const preferFullPageSnapshot =
    params.sectionCandidates.length === 0 ||
    params.structure.absoluteFixedSticky >= 3 ||
    params.structure.transformedElements >= 2 ||
    params.structure.overflowHiddenElements >= 2 ||
    params.structure.carousels > 0 ||
    params.structure.iframes > 0;

  return {
    requiresBrowserRender,
    preferVisualSnapshot,
    preferFullPageSnapshot,
    safeSectionExtraction:
      params.sectionCandidates.length > 0 &&
      !preferFullPageSnapshot &&
      params.structure.outOfFlowElements < 6,
    reasons
  };
}

export function analyzeInputPage(params: {
  html: string;
  sourceKind: SourceKind;
  fileName: string;
}): InputPageAnalysis {
  const $ = cheerio.load(params.html);
  const assets = collectAssetReferences(params.html);
  const frameworkHints = detectFrameworkHints($, params.html);
  const sectionCandidates = buildSectionCandidates($);
  const structure = collectStructureSummary($, assets, sectionCandidates);
  const renderStrategy = buildRenderStrategy({
    sourceKind: params.sourceKind,
    frameworkHints,
    structure,
    sectionCandidates,
    assets
  });
  const layoutTypes = resolveLayoutTypes({
    sourceKind: params.sourceKind,
    frameworkHints,
    hasInlineCss: $("[style],style").length > 0,
    hasExternalCss: assets.some((asset) => asset.kind === "stylesheet"),
    hasLocalAssets: assets.some((asset) => asset.location === "local"),
    hasRemoteAssets: assets.some((asset) => asset.location === "external"),
    absoluteCount: structure.absoluteFixedSticky,
    flexCount:
      (structure.totalElements > 0
        ? $("body *[style*='display:flex' i]").length
        : 0) +
      (($("[class]").toArray().map((element) => $(element).attr("class")).join(" ").match(/\bflex\b/g) || []).length),
    gridCount: structure.grids,
    scriptCount: structure.scripts
  });
  const diagnostics = buildStaticDiagnostics();

  return {
    fileName: params.fileName,
    sourceKind: params.sourceKind,
    layoutTypes,
    frameworkHints,
    structure,
    sectionCandidates,
    assets: {
      found: assets,
      total: assets.length,
      local: assets.filter((asset) => asset.location === "local").length,
      external: assets.filter((asset) => asset.location === "external").length,
      embedded: assets.filter((asset) => asset.location === "embedded").length,
      images: assets.filter((asset) => asset.kind === "image").length,
      backgrounds: assets.filter((asset) => asset.kind === "background").length,
      stylesheets: assets.filter((asset) => asset.kind === "stylesheet").length,
      fonts: assets.filter((asset) => asset.kind === "font").length,
      scripts: assets.filter((asset) => asset.kind === "script").length,
      iframes: assets.filter((asset) => asset.kind === "iframe").length,
      lazy: assets.filter((asset) => asset.lazy).length,
      loaded: 0,
      failed: 0
    },
    renderStrategy,
    diagnostics
  };
}

function mapAssetKindForDiagnostics(kind: string): InputAssetKind {
  if (
    kind === "image" ||
    kind === "font" ||
    kind === "stylesheet" ||
    kind === "script" ||
    kind === "background" ||
    kind === "iframe" ||
    kind === "link"
  ) {
    return kind;
  }

  return "other";
}

export function enrichInputPageAnalysis(
  analysis: InputPageAnalysis,
  params: {
    renderer: "browser" | "server";
    htmlRendered: boolean;
    cssLoaded: boolean;
    imagesLoaded: boolean;
    relativeAssetsResolved: boolean;
    viewportMatched: boolean;
    sectionCroppingRisk: boolean;
    fullPageSnapshotFailed: boolean;
    resources: Array<{
      url: string;
      kind: string;
      status: "loaded" | "failed" | "pending" | "skipped";
      reason?: string;
      sourceTag?: string;
      sourceAttribute?: string;
      lazy?: boolean;
    }>;
    warnings?: string[];
    errors?: string[];
    realSectionCount?: number;
  }
): InputPageAnalysis {
  const resources: InputAssetLoadStatus[] = params.resources.map((resource) => ({
    url: resource.url,
    kind: mapAssetKindForDiagnostics(resource.kind),
    status: resource.status,
    reason: resource.reason,
    sourceTag: resource.sourceTag,
    sourceAttribute: resource.sourceAttribute,
    lazy: resource.lazy
  }));

  return {
    ...analysis,
    structure: {
      ...analysis.structure,
      realSectionCount:
        typeof params.realSectionCount === "number"
          ? params.realSectionCount
          : analysis.structure.realSectionCount
    },
    assets: {
      ...analysis.assets,
      loaded: resources.filter((resource) => resource.status === "loaded").length,
      failed: resources.filter((resource) => resource.status === "failed").length
    },
    diagnostics: {
      ...analysis.diagnostics,
      rendererUsed: params.renderer,
      htmlRendered: params.htmlRendered,
      cssLoaded: params.cssLoaded,
      imagesLoaded: params.imagesLoaded,
      relativeAssetsResolved: params.relativeAssetsResolved,
      viewportMatched: params.viewportMatched,
      sectionCroppingRisk: params.sectionCroppingRisk,
      fullPageSnapshotFailed: params.fullPageSnapshotFailed,
      resources,
      warnings: [...analysis.diagnostics.warnings, ...(params.warnings ?? [])],
      errors: [...analysis.diagnostics.errors, ...(params.errors ?? [])]
    }
  };
}

export function toResolvedAssetList(assets: InputAssetReference[]) {
  return assets.map((asset) => ({
    kind: (asset.kind === "background" || asset.kind === "iframe" || asset.kind === "link"
      ? "other"
      : asset.kind) as ResolvedAssetKind,
    source: asset.url,
    location: asset.location
  }));
}
