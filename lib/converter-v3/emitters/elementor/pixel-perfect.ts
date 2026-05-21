import * as cheerio from "cheerio";

import type { OutputMode } from "@/lib/converter-v3/contracts/layout";
import type { ElementorDocument } from "@/types/conversion";

function escapeHtmlAttribute(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function createElementId(prefix: string, index: number) {
  return `${prefix}-${index.toString(16).padStart(6, "0")}`;
}

function estimateInitialHeight($: cheerio.CheerioAPI) {
  const sectionCount = $("section, header, footer, main, article").length;
  const imageCount = $("img").length;
  const textCount = $("h1,h2,h3,h4,h5,h6,p,li,blockquote").length;

  return Math.max(1200, sectionCount * 360 + imageCount * 120 + textCount * 24);
}

function createIframeOnloadScript() {
  return `(function(frame){
  if (!frame) return;
  frame.setAttribute('scrolling', 'no');
  frame.style.overflow = 'hidden';
  function applyHeight(nextHeight) {
    if (!nextHeight || !Number.isFinite(nextHeight)) return;
    var targetHeight = Math.ceil(nextHeight);
    var currentHeight = Math.ceil(parseFloat(frame.style.height || '0'));
    if (Math.abs(targetHeight - currentHeight) <= 1) return;
    frame.style.height = String(targetHeight) + 'px';
  }
  function getFrameDocument() {
    try {
      return frame.contentDocument || (frame.contentWindow && frame.contentWindow.document) || null;
    } catch (error) {
      return null;
    }
  }
  function measure() {
    var doc = getFrameDocument();
    if (!doc) return;
    var body = doc.body;
    var root = doc.documentElement;
    var bodyRectHeight = body ? Math.ceil(body.getBoundingClientRect().height) : 0;
    var rootRectHeight = root ? Math.ceil(root.getBoundingClientRect().height) : 0;
    applyHeight(Math.max(
      body ? body.scrollHeight : 0,
      root ? root.scrollHeight : 0,
      body ? body.offsetHeight : 0,
      root ? root.offsetHeight : 0,
      body ? body.clientHeight : 0,
      root ? root.clientHeight : 0,
      bodyRectHeight,
      rootRectHeight
    ));
  }
  function scheduleMeasure() {
    if (window.requestAnimationFrame) {
      window.requestAnimationFrame(measure);
      return;
    }
    setTimeout(measure, 16);
  }
  function bindObservers() {
    if (frame.__converterV3Bound) return;
    var doc = getFrameDocument();
    if (!doc) return;
    frame.__converterV3Bound = true;
    try {
      if (doc.fonts && doc.fonts.ready) {
        doc.fonts.ready.then(scheduleMeasure).catch(function() {});
      }
    } catch (error) {}
    try {
      Array.prototype.forEach.call(doc.images || [], function(image) {
        if (image && !image.complete) {
          image.addEventListener('load', scheduleMeasure, { once: true });
          image.addEventListener('error', scheduleMeasure, { once: true });
        }
      });
    } catch (error) {}
    try {
      var Observer = frame.contentWindow && frame.contentWindow.ResizeObserver;
      if (Observer) {
        var resizeObserver = new Observer(scheduleMeasure);
        if (doc.documentElement) resizeObserver.observe(doc.documentElement);
        if (doc.body) resizeObserver.observe(doc.body);
        frame.__converterV3ResizeObserver = resizeObserver;
      }
    } catch (error) {}
  }
  bindObservers();
  measure();
  setTimeout(function(){ bindObservers(); measure(); }, 50);
  setTimeout(function(){ bindObservers(); measure(); }, 250);
  setTimeout(function(){ bindObservers(); measure(); }, 1000);
  setTimeout(function(){ bindObservers(); measure(); }, 2500);
})(this);`;
}

function injectFrameRuntime(html: string, frameToken: string) {
  const $ = cheerio.load(
    html.replace(/\b100(?:d|s)?vh\b/g, "var(--converter-v3-fixed-vh, 100vh)")
  );

  if (!$("html").length) {
    $.root().append("<html><head></head><body></body></html>");
  }

  if (!$("head").length) {
    $("html").prepend("<head></head>");
  }

  if (!$("body").length) {
    $("html").append("<body></body>");
  }

  $("head").append(`<style data-converter-v3-frame-runtime>
:root {
  --converter-v3-fixed-vh: 100vh;
}

html {
  overflow-x: hidden !important;
  overflow-y: visible !important;
}

body {
  overflow-x: hidden !important;
  overflow-y: visible !important;
}
</style>`);

  $("body").append(`<script>
(function() {
  var frameToken = "${frameToken}";

  function getParentViewportHeight() {
    try {
      var parentWindow = window.parent && window.parent !== window ? window.parent : window;
      var parentRoot = parentWindow.document && parentWindow.document.documentElement;
      var parentViewportHeight = Math.max(
        parentWindow.innerHeight || 0,
        parentRoot ? parentRoot.clientHeight : 0
      );

      if (parentViewportHeight > 0) {
        return parentViewportHeight;
      }
    } catch (error) {}

    return Math.max(window.innerHeight || 0, window.screen ? window.screen.height || 0 : 0);
  }

  function syncViewportUnit() {
    var viewportHeight = getParentViewportHeight();

    if (!viewportHeight || !Number.isFinite(viewportHeight)) {
      return;
    }

    document.documentElement.style.setProperty(
      "--converter-v3-fixed-vh",
      String(Math.ceil(viewportHeight)) + "px"
    );
  }

  function getDocumentHeight() {
    syncViewportUnit();
    var body = document.body;
    var root = document.documentElement;
    var bodyRectHeight = body ? Math.ceil(body.getBoundingClientRect().height) : 0;
    var rootRectHeight = root ? Math.ceil(root.getBoundingClientRect().height) : 0;

    return Math.max(
      body ? body.scrollHeight : 0,
      root ? root.scrollHeight : 0,
      body ? body.offsetHeight : 0,
      root ? root.offsetHeight : 0,
      body ? body.clientHeight : 0,
      root ? root.clientHeight : 0,
      bodyRectHeight,
      rootRectHeight
    );
  }

  function notifyParent() {
    var height = getDocumentHeight();
    if (!height || !Number.isFinite(height)) return;

    parent.postMessage(
      {
        type: "converter-v3:frame-resize",
        token: frameToken,
        height: height
      },
      "*"
    );
  }

  function scheduleNotify() {
    window.requestAnimationFrame(function() {
      syncViewportUnit();
      notifyParent();
    });
  }

  syncViewportUnit();
  window.addEventListener("load", notifyParent);
  window.addEventListener("resize", scheduleNotify);
  document.addEventListener("DOMContentLoaded", notifyParent);

  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(scheduleNotify).catch(function() {});
  }

  Array.prototype.forEach.call(document.images || [], function(image) {
    if (image && !image.complete) {
      image.addEventListener("load", scheduleNotify, { once: true });
      image.addEventListener("error", scheduleNotify, { once: true });
    }
  });

  if (window.ResizeObserver) {
    var resizeObserver = new ResizeObserver(scheduleNotify);
    if (document.documentElement) {
      resizeObserver.observe(document.documentElement);
    }
    if (document.body) {
      resizeObserver.observe(document.body);
    }
  }

  if (window.MutationObserver && document.documentElement) {
    var mutationObserver = new MutationObserver(scheduleNotify);
    mutationObserver.observe(document.documentElement, {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true
    });
  }

  setTimeout(notifyParent, 50);
  setTimeout(notifyParent, 250);
  setTimeout(notifyParent, 1000);
  setTimeout(notifyParent, 2500);
})();
</script>`);

  return $.html();
}

export function createPixelPerfectElementorDocumentV3(
  html: string,
  options: {
    title?: string;
    selectedMode: OutputMode;
    fallbackReason?: string;
  }
): ElementorDocument {
  const $ = cheerio.load(html);
  const documentTitle = $("title").first().text().trim() || options.title || "Elementor Page";
  const initialHeight = estimateInitialHeight($);
  const frameToken = createElementId("frame", 1);
  const srcdoc = escapeHtmlAttribute(injectFrameRuntime(html, frameToken));
  const iframeOnload = escapeHtmlAttribute(createIframeOnloadScript());
  const widgetHtml = `<iframe
  class="converter-v3-frame"
  data-converter-v3-frame="${frameToken}"
  title="${escapeHtmlAttribute(documentTitle)}"
  loading="eager"
  onload="${iframeOnload}"
  scrolling="no"
  srcdoc="${srcdoc}"
  style="display:block;width:100%;max-width:100%;height:${initialHeight}px;border:0;margin:0;padding:0;background:#fff;overflow:hidden;"
></iframe>
<script>
(function(){
  var frame = document.currentScript && document.currentScript.previousElementSibling;
  var frameToken = "${frameToken}";
  if (!frame || frame.tagName !== "IFRAME") return;
  frame.setAttribute("scrolling", "no");
  frame.style.overflow = "hidden";
  function applyHeight(nextHeight) {
    if (!nextHeight || !Number.isFinite(nextHeight)) return;
    var targetHeight = Math.ceil(nextHeight);
    var currentHeight = Math.ceil(parseFloat(frame.style.height || "0"));
    if (Math.abs(targetHeight - currentHeight) <= 1) return;
    frame.style.height = String(targetHeight) + "px";
  }
  function resizeFrame() {
    try {
      var doc = frame.contentDocument || frame.contentWindow.document;
      if (!doc) return;
      var body = doc.body;
      var root = doc.documentElement;
      var bodyRectHeight = body ? Math.ceil(body.getBoundingClientRect().height) : 0;
      var rootRectHeight = root ? Math.ceil(root.getBoundingClientRect().height) : 0;
      applyHeight(Math.max(
        body ? body.scrollHeight : 0,
        root ? root.scrollHeight : 0,
        body ? body.offsetHeight : 0,
        root ? root.offsetHeight : 0,
        body ? body.clientHeight : 0,
        root ? root.clientHeight : 0,
        bodyRectHeight,
        rootRectHeight
      ));
    } catch (error) {}
  }
  function handleFrameMessage(event) {
    var data = event && event.data;
    if (!data || data.type !== "converter-v3:frame-resize" || data.token !== frameToken) return;
    applyHeight(Number(data.height));
  }
  window.addEventListener("message", handleFrameMessage);
  frame.addEventListener("load", resizeFrame);
  setTimeout(resizeFrame, 50);
  setTimeout(resizeFrame, 250);
  setTimeout(resizeFrame, 1000);
  setTimeout(resizeFrame, 2500);
})();
</script>`;

  return {
    version: "1.0",
    title: documentTitle,
    type: "page",
    content: [
      {
        id: createElementId("section", 1),
        elType: "section",
        settings: {
          layout: "full_width",
          content_width: "full",
          gap: "no",
          _padding: {
            unit: "px",
            top: 0,
            right: 0,
            bottom: 0,
            left: 0,
            isLinked: true
          },
          _margin: {
            unit: "px",
            top: 0,
            right: 0,
            bottom: 0,
            left: 0,
            isLinked: true
          },
          html_to_elementor_strategy: "pixel-perfect-iframe-v3",
          converter_v3_selected_mode: options.selectedMode,
          converter_v3_fallback_reason: options.fallbackReason
        },
        elements: [
          {
            id: createElementId("column", 1),
            elType: "column",
            settings: {
              _column_size: 100,
              _padding: {
                unit: "px",
                top: 0,
                right: 0,
                bottom: 0,
                left: 0,
                isLinked: true
              },
              _margin: {
                unit: "px",
                top: 0,
                right: 0,
                bottom: 0,
                left: 0,
                isLinked: true
              }
            },
            elements: [
              {
                id: createElementId("widget", 1),
                elType: "widget",
                widgetType: "html",
                settings: {
                  html: widgetHtml,
                  converter_v3_mode: "pixel-perfect",
                  converter_v3_note:
                    "Renderizacao isolada em iframe srcdoc para preservar o layout visual original."
                },
                elements: []
              }
            ]
          }
        ]
      }
    ]
  };
}
