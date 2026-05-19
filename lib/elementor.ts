import * as cheerio from "cheerio";
import type { Element } from "domhandler";

import type { ElementorDocument, ElementorElement } from "@/types/conversion";

const widgetMap: Record<string, string> = {
  h1: "heading",
  h2: "heading",
  h3: "heading",
  h4: "heading",
  h5: "heading",
  h6: "heading",
  p: "text-editor",
  a: "button",
  img: "image",
  ul: "text-editor",
  ol: "text-editor",
  blockquote: "blockquote",
  video: "video",
  iframe: "html"
};

function createId(seed: string): string {
  let hash = 0;

  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash << 5) - hash + seed.charCodeAt(index);
    hash |= 0;
  }

  return Math.abs(hash).toString(16).slice(0, 7).padStart(7, "0");
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function toWidget(
  $: cheerio.CheerioAPI,
  element: Element,
  index: number
): ElementorElement | null {
  if (element.type !== "tag") {
    return null;
  }

  const tag = element.name.toLowerCase();
  const widgetType = widgetMap[tag] ?? "html";
  const node = $(element);
  const html = node.html()?.trim() ?? "";
  const text = cleanText(node.text());
  const id = createId(`${tag}-${index}-${html}-${text}`);

  if (!html && !text && tag !== "img") {
    return null;
  }

  if (tag === "img") {
    return {
      id,
      elType: "widget",
      widgetType: "image",
      settings: {
        image: {
          url: node.attr("src") ?? "",
          alt: node.attr("alt") ?? ""
        },
        caption: node.attr("title") ?? ""
      },
      elements: []
    };
  }

  if (/^h[1-6]$/.test(tag)) {
    return {
      id,
      elType: "widget",
      widgetType: "heading",
      settings: {
        title: text,
        header_size: tag
      },
      elements: []
    };
  }

  if (tag === "a") {
    return {
      id,
      elType: "widget",
      widgetType: "button",
      settings: {
        text: text || node.attr("href") || "Link",
        link: {
          url: node.attr("href") ?? ""
        }
      },
      elements: []
    };
  }

  if (tag === "iframe") {
    return {
      id,
      elType: "widget",
      widgetType: "html",
      settings: {
        html: $.html(element)
      },
      elements: []
    };
  }

  return {
    id,
    elType: "widget",
    widgetType,
    settings: {
      editor: widgetType === "text-editor" ? html : undefined,
      html: widgetType === "html" ? $.html(element) : undefined
    },
    elements: []
  };
}

function createSection(widget: ElementorElement, index: number): ElementorElement {
  return {
    id: createId(`section-${index}-${widget.id}`),
    elType: "section",
    settings: {
      layout: "boxed"
    },
    elements: [
      {
        id: createId(`column-${index}-${widget.id}`),
        elType: "column",
        settings: {
          _column_size: 100
        },
        elements: [widget]
      }
    ]
  };
}

function getRootElements($: cheerio.CheerioAPI): Element[] {
  if ($("body").length) {
    return $("body")
      .children()
      .toArray()
      .filter((element): element is Element => element.type === "tag");
  }

  return $.root()
    .children()
    .toArray()
    .filter((element): element is Element => element.type === "tag");
}

export function convertHtmlToElementor(html: string): ElementorDocument {
  const $ = cheerio.load(html);
  const title = cleanText($("title").first().text()) || "Converted Elementor Page";
  const rootElements = getRootElements($);

  const widgets = rootElements
    .flatMap((element, index) => {
      const widget = toWidget($, element, index);

      if (widget) {
        return [widget];
      }

      return $(element)
        .find("h1,h2,h3,h4,h5,h6,p,a,img,ul,ol,blockquote,iframe,video")
        .toArray()
        .map((child, childIndex) => toWidget($, child, index + childIndex + 1))
        .filter(Boolean) as ElementorElement[];
    });

  return {
    version: "0.4",
    title,
    type: "page",
    content: widgets.map(createSection)
  };
}
