import * as cheerio from "cheerio";
import type { Element } from "domhandler";

import type { ElementorDocument, ElementorElement } from "@/types/conversion";

function createId(prefix: string, index: number): string {
  return `${prefix}-${index.toString(16).padStart(4, "0")}`;
}

function cleanText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function createWidget(
  $: cheerio.CheerioAPI,
  element: Element,
  index: number
): ElementorElement | null {
  if (element.type !== "tag") {
    return null;
  }

  const node = $(element);
  const tag = element.name.toLowerCase();
  const id = createId(tag, index);

  if (["h1", "h2", "h3"].includes(tag)) {
    return {
      id,
      elType: "widget",
      widgetType: "heading",
      settings: {
        title: cleanText(node.text()),
        header_size: tag
      },
      elements: []
    };
  }

  if (tag === "p") {
    return {
      id,
      elType: "widget",
      widgetType: "text-editor",
      settings: {
        editor: node.html()?.trim() ?? cleanText(node.text())
      },
      elements: []
    };
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
        }
      },
      elements: []
    };
  }

  if (tag === "a" || tag === "button") {
    return {
      id,
      elType: "widget",
      widgetType: "button",
      settings: {
        text: cleanText(node.text()) || "Button",
        link: {
          url: tag === "a" ? node.attr("href") ?? "" : ""
        }
      },
      elements: []
    };
  }

  return null;
}

function convertElement(
  $: cheerio.CheerioAPI,
  element: Element,
  index: number
): ElementorElement | null {
  if (element.type !== "tag") {
    return null;
  }

  const tag = element.name.toLowerCase();

  if (tag === "section" || tag === "div") {
    return {
      id: createId("container", index),
      elType: "container",
      settings: {},
      elements: $(element)
        .children()
        .toArray()
        .map((child, childIndex) => convertElement($, child, childIndex))
        .filter(Boolean) as ElementorElement[]
    };
  }

  return createWidget($, element, index);
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
  const title = cleanText($("title").first().text()) || "Elementor Page";
  const rootElements = getRootElements($);

  return {
    version: "0.4",
    title,
    type: "page",
    content: rootElements
      .map((element, index) => convertElement($, element, index))
      .filter(Boolean) as ElementorElement[]
  };
}
