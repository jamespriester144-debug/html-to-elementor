import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import JSZip from "jszip";

import type { PageCapture, SectionCapture } from "../lib/converter-v3/contracts/capture";
import type { LayoutDocument, LayoutNode } from "../lib/converter-v3/contracts/layout";
import { createSnapshotElementorDocumentV3 } from "../lib/converter-v3/emitters/elementor/snapshot";
import {
  createElementorResponsiveSettings,
  createResponsiveChildSettings,
  detectContainerPreset,
  deriveContainerLayout,
  getOrderedChildIdsForPattern
} from "../lib/converter-v3/emitters/elementor/responsive-layout";
import { createEditableElementorDocumentV3 } from "../lib/converter-v3/emitters/elementor/editable";
import { runExportPipelineV3FromHtml } from "../lib/converter-v3/orchestration/export-pipeline-v3";
import { runCapturePipelineV3FromHtml } from "../lib/converter-v3/orchestration/pipeline-v3";
import { resolveSourceFromUpload } from "../lib/converter-v3/resolve/source-resolver";
import { classifySections } from "../lib/converter-v3/section-classifier";
import { buildVisualHierarchy } from "../lib/converter-v3/visual-hierarchy";

function unwrapSectionStrategyChildren<T extends { settings?: Record<string, unknown>; elements?: T[] }>(
  elements: T[] | undefined
) {
  const shells = elements ?? [];
  const usesRegionShells = shells.every(
    (child) => child.settings?.converter_v3_section_region_shell === true
  );

  if (!usesRegionShells) {
    return {
      shells,
      children: shells
    };
  }

  return {
    shells,
    children: shells.flatMap((shell) => shell.elements ?? [])
  };
}

async function testV3HtmlCapturePipeline() {
  const html = `<!doctype html>
<html>
  <head>
    <title>Capture Test</title>
  </head>
  <body>
    <section class="hero">
      <h1>Rendered Hero</h1>
      <p>Capture me with layout metadata.</p>
      <a href="#buy">Buy</a>
      <img src="data:image/svg+xml;base64,PHN2Zy8+" alt="Hero visual" />
    </section>
  </body>
</html>`;
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const result = await runCapturePipelineV3FromHtml(html, {
    preferBrowser: false,
    outputRoot
  });

  assert.equal(result.resolvedSource.sourceKind, "raw-html");
  assert.equal(result.capture.title, "Capture Test");
  assert.equal(result.capture.summary.images, 1);
  assert.equal(result.capture.summary.buttons, 1);
  assert.ok(result.capture.domSnapshot.some((node) => node.tag === "section"));
  assert.ok(result.capture.styleSnapshot.every((node) => node.computedStyles));
  assert.ok(result.layout.rootNodeId);
  assert.equal(result.layout.nodeCount >= result.capture.summary.visibleNodes, true);
  assert.ok(result.layout.nodes.some((node) => node.kind === "image"));
  assert.equal(result.analysis.selectedMode, "editable");
  assert.ok(result.capture.nodes.every((node) => node.viewportStates.desktop));
  assert.ok(result.capture.nodes.every((node) => node.viewportStates.tablet));
  assert.ok(result.capture.nodes.every((node) => node.viewportStates.mobile));
  assert.ok(result.capture.responsiveSnapshot.length > 0);
  await access(result.capture.artifacts.pageCapturePath);
  await access(result.capture.artifacts.domSnapshotPath);
  await access(result.capture.artifacts.responsiveSnapshotPath);
  await access(result.capture.artifacts.layoutPath);
  await access(result.capture.artifacts.analysisPath);
  const renderedHtml = await readFile(result.capture.artifacts.renderedHtmlPath, "utf8");
  assert.match(renderedHtml, /Rendered Hero/);
}

async function testV3ZipResolver() {
  const zip = new JSZip();
  zip.file("sample/src/assets/logo.png", "test-image");
  zip.file(
    "sample/src/routes/index.tsx",
    `import { createFileRoute } from "@tanstack/react-router";
import logoImg from "@/assets/logo.png";

export const Route = createFileRoute("/")({
  component: Index,
});

function Index() {
  return (
    <div>
      <header>
        <img src={logoImg} alt="Logo" />
        <a href="#order">Order</a>
      </header>
      <section>
        <h1>Lovable Capture</h1>
      </section>
    </div>
  );
}`
  );

  const file = new File([await zip.generateAsync({ type: "arraybuffer" })], "sample.zip", {
    type: "application/zip"
  });
  const resolved = await resolveSourceFromUpload(file);

  assert.equal(resolved.sourceKind, "lovable-react-source");
  assert.equal(resolved.archiveFileCount >= 1, true);
  assert.match(resolved.html, /Lovable Capture/);
  assert.ok(resolved.assets.some((asset) => asset.kind === "image"));
}

async function testV3ComplexitySelection() {
  const html = `<!doctype html>
<html>
  <body>
    <section style="display:grid;grid-template-columns:repeat(2, minmax(0, 1fr));gap:40px;padding:24px;background-color:#f8efe8;">
      <div>
        <h2>Structured Section</h2>
        <p>Left column text.</p>
      </div>
      <div style="position:relative;">
        <img src="https://example.com/hero.png" alt="Hero" style="border-radius:24px;box-shadow:0 12px 48px rgba(0,0,0,0.12);" />
        <div style="position:absolute;top:12px;right:12px;width:48px;height:48px;background:#ffcc00;border-radius:999px;"></div>
      </div>
    </section>
  </body>
</html>`;
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const result = await runCapturePipelineV3FromHtml(html, {
    preferBrowser: false,
    outputRoot
  });

  assert.ok(result.layout.nodes.some((node) => node.layout.display === "grid"));
  assert.ok(result.layout.nodes.some((node) => node.flags.decorative));
  assert.equal(result.analysis.gridContainers >= 1, true);
  assert.equal(result.analysis.absoluteNodes >= 1, true);
  assert.equal(["hybrid", "pixel-perfect"].includes(result.analysis.selectedMode), true);
}

async function testV3ExportPipeline() {
  const html = `<!doctype html>
<html>
  <head>
    <title>Export Test</title>
  </head>
  <body>
    <section style="display:flex;gap:24px;padding:24px;">
      <div>
        <h1>Export Ready</h1>
        <p>Render this inside Elementor.</p>
        <ul>
          <li>Fast setup</li>
          <li>Clear CTA</li>
        </ul>
        <details>
          <summary>What is included?</summary>
          <p>Editable widgets with safe defaults.</p>
        </details>
      </div>
      <img src="data:image/svg+xml;base64,PHN2Zy8+" alt="Visual" />
      <a href="#buy">Buy now</a>
    </section>
  </body>
</html>`;
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const result = await runExportPipelineV3FromHtml(html, {
    preferBrowser: false,
    outputRoot
  });

  assert.equal(result.emittedMode, "editable");
  assert.equal(result.analysis.selectedMode, "editable");
  assert.equal(result.fallbackReason, undefined);
  await access(result.artifacts.elementorTemplatePath);
  await access(result.artifacts.reportPath);

  const elementorTemplate = JSON.parse(
    await readFile(result.artifacts.elementorTemplatePath, "utf8")
  ) as {
    title: string;
    content: Array<{
      elType: string;
      settings?: {
        flex_direction?: string;
        converter_v3_responsive?: Record<string, unknown>;
        converter_v3_elementor_responsive?: Record<string, unknown>;
        tablet_flex_direction?: string;
        mobile_flex_direction?: string;
      };
      elements: Array<{
        elType?: string;
        widgetType?: string;
        settings?: {
          converter_v3_responsive?: Record<string, unknown>;
          converter_v3_elementor_responsive?: Record<string, unknown>;
          tablet_width?: string;
          mobile_width?: string;
        };
        elements?: Array<{ widgetType?: string }>
      }>;
    }>;
  };
  const report = JSON.parse(await readFile(result.artifacts.reportPath, "utf8")) as {
    emittedMode: string;
    selectedMode: string;
  };
  const sectionChildren = elementorTemplate.content[0].elements;

  assert.equal(elementorTemplate.title, "Export Test");
  assert.equal(elementorTemplate.content[0].elType, "container");
  assert.equal((elementorTemplate.content[0] as { settings?: { flex_direction?: string } }).settings?.flex_direction, "row");
  assert.ok(elementorTemplate.content[0].settings?.converter_v3_responsive?.desktop);
  assert.ok(elementorTemplate.content[0].settings?.converter_v3_responsive?.tablet);
  assert.ok(elementorTemplate.content[0].settings?.converter_v3_responsive?.mobile);
  assert.ok(elementorTemplate.content[0].settings?.converter_v3_elementor_responsive?.desktop);
  assert.ok(elementorTemplate.content[0].settings?.converter_v3_elementor_responsive?.tablet);
  assert.ok(elementorTemplate.content[0].settings?.converter_v3_elementor_responsive?.mobile);
  assert.equal(elementorTemplate.content[0].settings?.tablet_flex_direction, "row");
  assert.equal(elementorTemplate.content[0].settings?.mobile_flex_direction, "row");
  assert.ok(sectionChildren.some((element) => element.widgetType === "image"));
  assert.ok(sectionChildren.some((element) => element.widgetType === "button"));
  assert.ok(sectionChildren.every((element) => typeof (element as { settings?: { width?: string } }).settings?.width === "string"));
  const nestedContainer = sectionChildren.find((element) => element.elType === "container");
  assert.ok(nestedContainer);
  assert.ok(nestedContainer?.elements?.some((element) => element.widgetType === "heading"));
  assert.ok(nestedContainer?.elements?.some((element) => element.widgetType === "text-editor"));
  assert.ok(nestedContainer?.elements?.some((element) => element.widgetType === "icon-list"));
  assert.ok(nestedContainer?.elements?.some((element) => element.widgetType === "accordion"));
  assert.ok(sectionChildren.some((element) => element.settings?.converter_v3_responsive?.desktop));
  assert.ok(sectionChildren.some((element) => element.settings?.converter_v3_elementor_responsive?.desktop));
  assert.ok(sectionChildren.some((element) => typeof element.settings?.tablet_width === "string"));
  assert.ok(sectionChildren.some((element) => typeof element.settings?.mobile_width === "string"));
  assert.equal(report.emittedMode, "editable");
  assert.equal(report.selectedMode, "editable");
}

async function testV3HybridSectionFallback() {
  const html = `<!doctype html>
<html>
  <head>
    <title>Hybrid Export</title>
  </head>
  <body>
    <section style="display:grid;grid-template-columns:repeat(2, minmax(0, 1fr));gap:40px;padding:24px;background-color:#f8efe8;">
      <div>
        <h2>Structured Section</h2>
        <p>Left column text.</p>
      </div>
      <div style="position:relative;">
        <img src="https://example.com/hero.png" alt="Hero" style="border-radius:24px;box-shadow:0 12px 48px rgba(0,0,0,0.12);" />
        <div style="position:absolute;top:12px;right:12px;width:48px;height:48px;background:#ffcc00;border-radius:999px;"></div>
      </div>
    </section>
  </body>
</html>`;
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const result = await runExportPipelineV3FromHtml(html, {
    preferBrowser: false,
    outputRoot
  });

  assert.equal(result.analysis.selectedMode, "hybrid");
  assert.equal(result.emittedMode, "hybrid");
  assert.equal(result.fallbackReason, undefined);
  assert.ok(result.report.warnings.length >= 1);

  const elementorTemplate = JSON.parse(
    await readFile(result.artifacts.elementorTemplatePath, "utf8")
  ) as {
    content: Array<{ widgetType?: string; elements?: Array<{ widgetType?: string }> }>;
  };

  assert.equal(elementorTemplate.content[0].widgetType, "html");
}

async function testV3HybridPreservesGridWidths() {
  const html = `<!doctype html>
<html>
  <head>
    <title>Hybrid Grid</title>
  </head>
  <body>
    <section style="display:grid;grid-template-columns:repeat(3, minmax(0, 1fr));gap:24px;padding:24px;">
      <article><h3>Card One</h3><p>First card</p></article>
      <article><h3>Card Two</h3><p>Second card</p></article>
      <article><h3>Card Three</h3><p>Third card</p></article>
    </section>
  </body>
</html>`;
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const result = await runExportPipelineV3FromHtml(html, {
    preferBrowser: false,
    outputRoot
  });

  assert.equal(result.analysis.selectedMode, "hybrid");
  assert.equal(result.emittedMode, "hybrid");

  const elementorTemplate = JSON.parse(
    await readFile(result.artifacts.elementorTemplatePath, "utf8")
  ) as {
    content: Array<{
      elType: string;
      settings?: {
        flex_direction?: string;
        flex_wrap?: string;
        gap?: string;
        converter_v3_responsive?: Record<string, unknown>;
        converter_v3_elementor_responsive?: Record<string, unknown>;
        tablet_flex_direction?: string;
        mobile_flex_direction?: string;
      };
      elements: Array<{ elType?: string; settings?: { width?: string; flex_basis?: string } }>;
    }>;
  };
  const topLevel = elementorTemplate.content[0];

  assert.equal(topLevel.elType, "container");
  assert.equal(topLevel.settings?.flex_direction, "row");
  assert.equal(topLevel.settings?.flex_wrap, "wrap");
  assert.equal(topLevel.settings?.gap, "24px");
  assert.ok(topLevel.settings?.converter_v3_responsive?.desktop);
  assert.ok(topLevel.settings?.converter_v3_responsive?.tablet);
  assert.ok(topLevel.settings?.converter_v3_responsive?.mobile);
  assert.ok(topLevel.settings?.converter_v3_elementor_responsive?.desktop);
  assert.ok(topLevel.settings?.converter_v3_elementor_responsive?.tablet);
  assert.ok(topLevel.settings?.converter_v3_elementor_responsive?.mobile);
  assert.equal(topLevel.settings?.tablet_flex_direction, "row");
  assert.equal(topLevel.settings?.mobile_flex_direction, "row");
  assert.equal(topLevel.elements.length, 3);
  assert.ok(
    topLevel.elements.every(
      (element) =>
        element.settings?.width === "33.33%" &&
        element.settings?.flex_basis === "33.33%"
    )
  );
}

async function testV3HybridKeepsRichPatternedGridStructural() {
  const cards = Array.from({ length: 6 }, (_, index) => {
    const number = index + 1;

    return `
      <article style="padding:20px;border-radius:18px;background:#fff;">
        <img src="https://example.com/card-${number}.jpg" alt="Card ${number}" style="border-radius:14px;" />
        <span>Badge ${number}</span>
        <h3>Card ${number}</h3>
        <p>Supporting copy ${number}</p>
        <a href="#card-${number}">Shop ${number}</a>
      </article>
    `;
  }).join("");

  const html = `<!doctype html>
<html>
  <head>
    <title>Hybrid Rich Grid</title>
  </head>
  <body>
    <section style="display:grid;grid-template-columns:repeat(3, minmax(0, 1fr));gap:24px;padding:24px;background:#f8efe8;">
      ${cards}
    </section>
  </body>
</html>`;
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const result = await runExportPipelineV3FromHtml(html, {
    preferBrowser: false,
    outputRoot
  });

  assert.equal(result.analysis.selectedMode, "hybrid");
  assert.equal(result.emittedMode, "hybrid");

  const elementorTemplate = JSON.parse(
    await readFile(result.artifacts.elementorTemplatePath, "utf8")
  ) as {
    content: Array<{
      elType?: string;
      widgetType?: string;
      settings?: {
        converter_v3_layout?: { pattern?: string; columns?: number };
      };
      elements?: Array<{
        elType?: string;
        widgetType?: string;
        settings?: {
          converter_v3_pattern_role?: string;
          width?: string;
          flex_direction?: string;
          align_items?: string;
        };
      }>;
    }>;
  };
  const topLevel = elementorTemplate.content[0];

  assert.equal(topLevel.elType, "container");
  assert.equal(topLevel.widgetType, undefined);
  assert.equal(topLevel.settings?.converter_v3_layout?.pattern, "card-grid");
  assert.equal(topLevel.settings?.converter_v3_layout?.columns, 3);
  assert.equal(topLevel.elements?.length, 6);
  assert.ok(
    topLevel.elements?.every(
      (element) =>
        element.settings?.converter_v3_pattern_role === "card" &&
        element.settings?.width === "33.33%" &&
        element.settings?.flex_direction === "column" &&
        element.settings?.align_items === "stretch"
    )
  );
}

async function testV3HybridDetectsPricingPreset() {
  const html = `<!doctype html>
<html>
  <head>
    <title>Hybrid Pricing Grid</title>
  </head>
  <body>
    <section style="display:grid;grid-template-columns:repeat(3, minmax(0, 1fr));gap:24px;padding:24px;background:#f8efe8;">
      <article style="padding:20px;border-radius:18px;background:#fff;">
        <span>Basic</span>
        <h3>1 Jar</h3>
        <p>$49.95</p>
        <p>30 day supply</p>
        <a href="#basic">Add to cart</a>
      </article>
      <article style="padding:20px;border-radius:18px;background:#fff;">
        <span>Most Popular</span>
        <h3>3 Jars</h3>
        <p>$44.95</p>
        <p>90 day supply</p>
        <a href="#popular">Add to cart</a>
      </article>
      <article style="padding:20px;border-radius:18px;background:#fff;">
        <span>Best Value</span>
        <h3>6 Jars</h3>
        <p>$41.50</p>
        <p>180 day supply</p>
        <a href="#value">Add to cart</a>
      </article>
    </section>
  </body>
</html>`;
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const result = await runExportPipelineV3FromHtml(html, {
    preferBrowser: false,
    outputRoot
  });

  assert.equal(result.analysis.selectedMode, "hybrid");
  assert.equal(result.emittedMode, "hybrid");

  const elementorTemplate = JSON.parse(
    await readFile(result.artifacts.elementorTemplatePath, "utf8")
  ) as {
    content: Array<{
      settings?: {
        converter_v3_layout?: { preset?: string; pattern?: string };
      };
      elements?: Array<{
        settings?: {
          converter_v3_preset?: string;
          converter_v3_preset_role?: string;
          justify_content?: string;
          align_items?: string;
        };
      }>;
    }>;
  };
  const topLevel = elementorTemplate.content[0];

  assert.equal(topLevel.settings?.converter_v3_layout?.pattern, "card-grid");
  assert.equal(topLevel.settings?.converter_v3_layout?.preset, "pricing-cards");
  assert.ok(
    topLevel.elements?.every(
      (element) =>
        element.settings?.converter_v3_preset === "pricing-cards" &&
        element.settings?.converter_v3_preset_role === "pricing-card" &&
        element.settings?.justify_content === "space-between" &&
        element.settings?.align_items === "stretch"
    )
  );
}

async function testV3HybridComposesTestimonialWidgets() {
  const html = `<!doctype html>
<html>
  <head>
    <title>Hybrid Testimonial Grid</title>
  </head>
  <body>
    <section style="display:grid;grid-template-columns:repeat(2, minmax(0, 1fr));gap:24px;padding:24px;background:#f8efe8;">
      <article style="padding:20px;border-radius:18px;background:#fff;">
        <img src="https://example.com/customer-1.jpg" alt="Customer 1" />
        <p>★★★★★</p>
        <p>"This collagen made a visible difference in my skin and my daily routine feels better now."</p>
        <p>Rachel M.</p>
      </article>
      <article style="padding:20px;border-radius:18px;background:#fff;">
        <img src="https://example.com/customer-2.jpg" alt="Customer 2" />
        <p>5/5</p>
        <p>"I noticed smoother recovery and better consistency after a few weeks of use."</p>
        <p>Daniel K.</p>
      </article>
    </section>
  </body>
</html>`;
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const result = await runExportPipelineV3FromHtml(html, {
    preferBrowser: false,
    outputRoot
  });

  assert.equal(result.analysis.selectedMode, "hybrid");
  assert.equal(result.emittedMode, "hybrid");

  const elementorTemplate = JSON.parse(
    await readFile(result.artifacts.elementorTemplatePath, "utf8")
  ) as {
    content: Array<{
      settings?: { converter_v3_layout?: { preset?: string } };
      elements?: Array<{
        settings?: {
          converter_v3_preset?: string;
          converter_v3_preset_role?: string;
          flex_direction?: string;
          gap?: string;
        };
        elements?: Array<{
          widgetType?: string;
          settings?: {
            converter_v3_widget_semantic?: string;
            align?: string;
            line_height?: string;
            font_weight?: string;
          };
        }>;
      }>;
    }>;
  };

  const topLevel = elementorTemplate.content[0];
  const cardContainers = topLevel.elements ?? [];
  const nestedWidgets = cardContainers.flatMap((card) => card.elements ?? []);

  assert.equal(topLevel.settings?.converter_v3_layout?.preset, "testimonial-cards");
  assert.ok(
    cardContainers.every(
      (card) =>
        card.settings?.converter_v3_preset === "testimonial-cards" &&
        card.settings?.converter_v3_preset_role === "testimonial-card" &&
        card.settings?.flex_direction === "column" &&
        card.settings?.gap === "14px"
    )
  );
  assert.deepEqual(
    (cardContainers[0]?.elements ?? []).map(
      (widget) => widget.settings?.converter_v3_widget_semantic
    ),
    [
      "testimonial-media",
      "testimonial-rating",
      "testimonial-quote",
      "testimonial-attribution"
    ]
  );
  assert.ok(
    nestedWidgets.some(
      (widget) =>
        widget.widgetType === "blockquote" &&
        widget.settings?.converter_v3_widget_semantic === "testimonial-quote" &&
        widget.settings?.align === "left" &&
        widget.settings?.line_height === "1.5"
    )
  );
  assert.ok(
    nestedWidgets.some(
      (widget) =>
        widget.widgetType === "text-editor" &&
        widget.settings?.converter_v3_widget_semantic === "testimonial-rating" &&
        widget.settings?.font_weight === "700"
    )
  );
  assert.ok(
    nestedWidgets.some(
      (widget) =>
        widget.widgetType === "heading" &&
        widget.settings?.converter_v3_widget_semantic === "testimonial-attribution" &&
        widget.settings?.font_weight === "600"
    )
  );
  assert.ok(
    nestedWidgets.some(
      (widget) =>
        widget.widgetType === "image" &&
        widget.settings?.converter_v3_widget_semantic === "testimonial-media"
    )
  );
}

async function testV3EditableComposesPricingWidgets() {
  const html = `<!doctype html>
<html>
  <head>
    <title>Editable Pricing Grid</title>
  </head>
  <body>
    <section style="display:grid;grid-template-columns:repeat(3, minmax(0, 1fr));gap:24px;padding:24px;background:#f8efe8;">
      <article style="padding:20px;border-radius:18px;background:#fff;">
        <h3>1 Jar</h3>
        <p>$49.95</p>
        <p>30 day supply</p>
        <a href="#basic">Add to cart</a>
      </article>
      <article style="padding:20px;border-radius:18px;background:#fff;">
        <h3>3 Jars</h3>
        <p>$44.95</p>
        <p>90 day supply</p>
        <a href="#popular">Add to cart</a>
      </article>
      <article style="padding:20px;border-radius:18px;background:#fff;">
        <h3>6 Jars</h3>
        <p>$41.50</p>
        <p>180 day supply</p>
        <a href="#value">Add to cart</a>
      </article>
    </section>
  </body>
</html>`;
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const captureResult = await runCapturePipelineV3FromHtml(html, {
    preferBrowser: false,
    outputRoot
  });
  const editableDocument = createEditableElementorDocumentV3({
    capture: captureResult.capture,
    layout: captureResult.layout,
    selectedMode: "editable"
  }).document as {
    content: Array<{
      settings?: { converter_v3_layout?: { preset?: string } };
      elements?: Array<{
        settings?: {
          converter_v3_preset?: string;
          converter_v3_preset_role?: string;
          flex_direction?: string;
          gap?: string;
        };
        elements?: Array<{
          widgetType?: string;
          settings?: {
            converter_v3_widget_semantic?: string;
            width?: string;
            align?: string;
            font_weight?: string;
          };
        }>;
      }>;
    }>;
  };

  const topLevel = editableDocument.content[0];
  const cardContainers = topLevel.elements ?? [];
  const nestedWidgets = cardContainers.flatMap((card) => card.elements ?? []);

  assert.equal(topLevel.settings?.converter_v3_layout?.preset, "pricing-cards");
  assert.ok(
    cardContainers.every(
      (card) =>
        card.settings?.converter_v3_preset === "pricing-cards" &&
        card.settings?.converter_v3_preset_role === "pricing-card" &&
        card.settings?.flex_direction === "column" &&
        card.settings?.gap === "12px"
    )
  );
  assert.deepEqual(
    (cardContainers[0]?.elements ?? []).map(
      (widget) => widget.settings?.converter_v3_widget_semantic
    ),
    ["pricing-title", "price", "pricing-support", "pricing-cta"]
  );
  assert.ok(
    nestedWidgets.some(
      (widget) =>
        widget.widgetType === "heading" &&
        widget.settings?.converter_v3_widget_semantic === "price" &&
        widget.settings?.font_weight === "700"
    )
  );
  assert.ok(
    nestedWidgets.some(
      (widget) =>
        widget.widgetType === "button" &&
        widget.settings?.converter_v3_widget_semantic === "pricing-cta" &&
        widget.settings?.width === "100%" &&
        widget.settings?.align === "left"
    )
  );
}

async function testV3EditableComposesTestimonialWidgets() {
  const html = `<!doctype html>
<html>
  <head>
    <title>Editable Testimonial Grid</title>
  </head>
  <body>
    <section style="display:grid;grid-template-columns:repeat(2, minmax(0, 1fr));gap:24px;padding:24px;background:#f8efe8;">
      <article style="padding:20px;border-radius:18px;background:#fff;">
        <img src="https://example.com/customer-1.jpg" alt="Customer 1" />
        <p>★★★★★</p>
        <p>"This collagen made a visible difference in my skin and my daily routine feels better now."</p>
        <p>Rachel M.</p>
      </article>
      <article style="padding:20px;border-radius:18px;background:#fff;">
        <img src="https://example.com/customer-2.jpg" alt="Customer 2" />
        <p>5/5</p>
        <p>"I noticed smoother recovery and better consistency after a few weeks of use."</p>
        <p>Daniel K.</p>
      </article>
    </section>
  </body>
</html>`;
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const captureResult = await runCapturePipelineV3FromHtml(html, {
    preferBrowser: false,
    outputRoot
  });
  const editableDocument = createEditableElementorDocumentV3({
    capture: captureResult.capture,
    layout: captureResult.layout,
    selectedMode: "editable"
  }).document as {
    content: Array<{
      settings?: { converter_v3_layout?: { preset?: string } };
      elements?: Array<{
        settings?: {
          converter_v3_preset?: string;
          converter_v3_preset_role?: string;
          flex_direction?: string;
          gap?: string;
        };
        elements?: Array<{
          widgetType?: string;
          settings?: {
            converter_v3_widget_semantic?: string;
            align?: string;
            line_height?: string;
            font_weight?: string;
          };
        }>;
      }>;
    }>;
  };

  const topLevel = editableDocument.content[0];
  const cardContainers = topLevel.elements ?? [];
  const nestedWidgets = cardContainers.flatMap((card) => card.elements ?? []);

  assert.equal(topLevel.settings?.converter_v3_layout?.preset, "testimonial-cards");
  assert.ok(
    cardContainers.every(
      (card) =>
        card.settings?.converter_v3_preset === "testimonial-cards" &&
        card.settings?.converter_v3_preset_role === "testimonial-card" &&
        card.settings?.flex_direction === "column" &&
        card.settings?.gap === "14px"
    )
  );
  assert.deepEqual(
    (cardContainers[0]?.elements ?? []).map(
      (widget) => widget.settings?.converter_v3_widget_semantic
    ),
    [
      "testimonial-media",
      "testimonial-rating",
      "testimonial-quote",
      "testimonial-attribution"
    ]
  );
  assert.ok(
    nestedWidgets.some(
      (widget) =>
        widget.widgetType === "blockquote" &&
        widget.settings?.converter_v3_widget_semantic === "testimonial-quote" &&
        widget.settings?.align === "left" &&
        widget.settings?.line_height === "1.5"
    )
  );
  assert.ok(
    nestedWidgets.some(
      (widget) =>
        widget.widgetType === "text-editor" &&
        widget.settings?.converter_v3_widget_semantic === "testimonial-rating" &&
        widget.settings?.font_weight === "700"
    )
  );
  assert.ok(
    nestedWidgets.some(
      (widget) =>
        widget.widgetType === "heading" &&
        widget.settings?.converter_v3_widget_semantic === "testimonial-attribution" &&
        widget.settings?.font_weight === "600"
    )
  );
  assert.ok(
    nestedWidgets.some(
      (widget) =>
        widget.widgetType === "image" &&
        widget.settings?.converter_v3_widget_semantic === "testimonial-media"
    )
  );
}

async function testV3EditableComposesFeatureWidgets() {
  const html = `<!doctype html>
<html>
  <head>
    <title>Editable Feature Grid</title>
  </head>
  <body>
    <section style="display:grid;grid-template-columns:repeat(3, minmax(0, 1fr));gap:24px;padding:24px;background:#f8efe8;">
      <article style="padding:20px;border-radius:18px;background:#fff;">
        <img src="https://example.com/feature-1.jpg" alt="Feature 1" />
        <span>Daily Support</span>
        <h3>Smoother mornings</h3>
        <p>Helps your routine feel easier to keep up with.</p>
        <a href="#learn-1">Learn more</a>
      </article>
      <article style="padding:20px;border-radius:18px;background:#fff;">
        <img src="https://example.com/feature-2.jpg" alt="Feature 2" />
        <span>Comfort Focus</span>
        <h3>Joint-friendly blend</h3>
        <p>Designed to fit calmly into daily movement and recovery.</p>
        <a href="#learn-2">Learn more</a>
      </article>
      <article style="padding:20px;border-radius:18px;background:#fff;">
        <img src="https://example.com/feature-3.jpg" alt="Feature 3" />
        <span>Simple Routine</span>
        <h3>Easy to mix</h3>
        <p>Works neatly in hot or cold drinks without changing your flow.</p>
        <a href="#learn-3">Learn more</a>
      </article>
    </section>
  </body>
</html>`;
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const captureResult = await runCapturePipelineV3FromHtml(html, {
    preferBrowser: false,
    outputRoot
  });
  const editableDocument = createEditableElementorDocumentV3({
    capture: captureResult.capture,
    layout: captureResult.layout,
    selectedMode: "editable"
  }).document as {
    content: Array<{
      settings?: { converter_v3_layout?: { preset?: string } };
      elements?: Array<{
        settings?: {
          converter_v3_preset?: string;
          converter_v3_preset_role?: string;
          flex_direction?: string;
          gap?: string;
        };
        elements?: Array<{
          widgetType?: string;
          settings?: {
            converter_v3_widget_semantic?: string;
            align?: string;
            line_height?: string;
            font_weight?: string;
          };
        }>;
      }>;
    }>;
  };

  const topLevel = editableDocument.content[0];
  const cardContainers = topLevel.elements ?? [];
  const nestedWidgets = cardContainers.flatMap((card) => card.elements ?? []);

  assert.equal(topLevel.settings?.converter_v3_layout?.preset, "feature-cards");
  assert.ok(
    cardContainers.every(
      (card) =>
        card.settings?.converter_v3_preset === "feature-cards" &&
        card.settings?.converter_v3_preset_role === "feature-card" &&
        card.settings?.flex_direction === "column" &&
        card.settings?.gap === "14px"
    )
  );
  assert.deepEqual(
    (cardContainers[0]?.elements ?? []).map(
      (widget) => widget.settings?.converter_v3_widget_semantic
    ),
    [
      "feature-media",
      "feature-eyebrow",
      "feature-title",
      "feature-support",
      "feature-cta"
    ]
  );
  assert.ok(
    nestedWidgets.some(
      (widget) =>
        widget.widgetType === "text-editor" &&
        widget.settings?.converter_v3_widget_semantic === "feature-eyebrow" &&
        widget.settings?.font_weight === "600"
    )
  );
  assert.ok(
    nestedWidgets.some(
      (widget) =>
        widget.widgetType === "heading" &&
        widget.settings?.converter_v3_widget_semantic === "feature-title" &&
        widget.settings?.font_weight === "700"
    )
  );
  assert.ok(
    nestedWidgets.some(
      (widget) =>
        widget.widgetType === "text-editor" &&
        widget.settings?.converter_v3_widget_semantic === "feature-support" &&
        widget.settings?.line_height === "1.5"
    )
  );
  assert.ok(
    nestedWidgets.some(
      (widget) =>
        widget.widgetType === "button" &&
        widget.settings?.converter_v3_widget_semantic === "feature-cta" &&
        widget.settings?.align === "left"
    )
  );
  assert.ok(
    nestedWidgets.some(
      (widget) =>
        widget.widgetType === "image" &&
        widget.settings?.converter_v3_widget_semantic === "feature-media"
    )
  );
}

async function testV3EditableComposesPricingSection() {
  const html = `<!doctype html>
<html>
  <head>
    <title>Editable Pricing Section</title>
  </head>
  <body>
    <section style="padding:24px;background:#f8efe8;">
      <div>
        <h2>Try Advanced Collagen Plus today.</h2>
        <p>Backed by our 60-day money-back guarantee.</p>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3, minmax(0, 1fr));gap:24px;">
        <article style="padding:20px;border-radius:18px;background:#fff;">
          <h3>1 Jar</h3>
          <p>$49.95</p>
          <p>30 day supply</p>
          <a href="#basic">Add to cart</a>
        </article>
        <article style="padding:20px;border-radius:18px;background:#fff;">
          <h3>3 Jars</h3>
          <p>$44.95</p>
          <p>90 day supply</p>
          <a href="#popular">Add to cart</a>
        </article>
        <article style="padding:20px;border-radius:18px;background:#fff;">
          <h3>6 Jars</h3>
          <p>$41.50</p>
          <p>180 day supply</p>
          <a href="#value">Add to cart</a>
        </article>
      </div>
    </section>
  </body>
</html>`;
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const captureResult = await runCapturePipelineV3FromHtml(html, {
    preferBrowser: false,
    outputRoot
  });
  const editableDocument = createEditableElementorDocumentV3({
    capture: captureResult.capture,
    layout: captureResult.layout,
    selectedMode: "editable"
  }).document as {
    content: Array<{
      settings?: {
        flex_direction?: string;
        gap?: string;
        converter_v3_layout?: {
          sectionComposition?: string;
        };
      };
      elements?: Array<{
        settings?: {
          converter_v3_layout?: { preset?: string };
        };
      }>;
    }>;
  };

  const topLevel = editableDocument.content[0];
  const { shells: regionShells, children: sectionChildren } = unwrapSectionStrategyChildren(
    topLevel.elements
  );
  const topLevelSettings = topLevel.settings as Record<string, unknown> | undefined;
  const typedRegionShells = regionShells as Array<{ settings?: Record<string, unknown> }>;

  assert.equal(topLevel.settings?.converter_v3_layout?.sectionComposition, "pricing-section");
  assert.equal(topLevel.settings?.flex_direction, "column");
  assert.equal(topLevel.settings?.gap, "32px");
  assert.equal(topLevelSettings?.converter_v3_section_strategy, "commerce-offer");
  assert.equal(topLevelSettings?.converter_v3_section_strategy_structure, "region-shells");
  assert.deepEqual(
    typedRegionShells.map((child) => child.settings?.converter_v3_section_region),
    ["intro", "main"]
  );
  assert.equal(typedRegionShells[0]?.settings?.converter_v3_section_region_shell, true);
  assert.equal(
    sectionChildren.at(-1)?.settings?.converter_v3_layout?.preset,
    "pricing-cards"
  );
  assert.notEqual(
    sectionChildren[0]?.settings?.converter_v3_layout?.preset,
    "pricing-cards"
  );
}

async function testV3HybridComposesPricingSection() {
  const html = `<!doctype html>
<html>
  <head>
    <title>Hybrid Pricing Section</title>
  </head>
  <body>
    <section style="padding:24px;background:#f8efe8;">
      <div>
        <h2>Try Advanced Collagen Plus today.</h2>
        <p>Backed by our 60-day money-back guarantee.</p>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3, minmax(0, 1fr));gap:24px;">
        <article style="padding:20px;border-radius:18px;background:#fff;">
          <h3>1 Jar</h3>
          <p>$49.95</p>
          <p>30 day supply</p>
          <a href="#basic">Add to cart</a>
        </article>
        <article style="padding:20px;border-radius:18px;background:#fff;">
          <h3>3 Jars</h3>
          <p>$44.95</p>
          <p>90 day supply</p>
          <a href="#popular">Add to cart</a>
        </article>
        <article style="padding:20px;border-radius:18px;background:#fff;">
          <h3>6 Jars</h3>
          <p>$41.50</p>
          <p>180 day supply</p>
          <a href="#value">Add to cart</a>
        </article>
      </div>
    </section>
  </body>
</html>`;
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const result = await runExportPipelineV3FromHtml(html, {
    preferBrowser: false,
    outputRoot
  });

  assert.equal(result.analysis.selectedMode, "hybrid");
  assert.equal(result.emittedMode, "hybrid");

  const elementorTemplate = JSON.parse(
    await readFile(result.artifacts.elementorTemplatePath, "utf8")
  ) as {
    content: Array<{
      settings?: {
        flex_direction?: string;
        gap?: string;
        converter_v3_layout?: {
          sectionComposition?: string;
        };
      };
      elements?: Array<{
        settings?: {
          converter_v3_layout?: { preset?: string };
        };
      }>;
    }>;
  };

  const topLevel = elementorTemplate.content[0];
  const { shells: regionShells, children: sectionChildren } = unwrapSectionStrategyChildren(
    topLevel.elements
  );
  const topLevelSettings = topLevel.settings as Record<string, unknown> | undefined;
  const typedRegionShells = regionShells as Array<{ settings?: Record<string, unknown> }>;

  assert.equal(topLevel.settings?.converter_v3_layout?.sectionComposition, "pricing-section");
  assert.equal(topLevel.settings?.flex_direction, "column");
  assert.equal(topLevel.settings?.gap, "32px");
  assert.equal(topLevelSettings?.converter_v3_section_strategy, "commerce-offer");
  assert.equal(topLevelSettings?.converter_v3_section_strategy_structure, "region-shells");
  assert.deepEqual(
    typedRegionShells.map((child) => child.settings?.converter_v3_section_region),
    ["intro", "main"]
  );
  assert.equal(typedRegionShells[1]?.settings?.converter_v3_section_region_shell, true);
  assert.equal(
    sectionChildren.at(-1)?.settings?.converter_v3_layout?.preset,
    "pricing-cards"
  );
  assert.notEqual(
    sectionChildren[0]?.settings?.converter_v3_layout?.preset,
    "pricing-cards"
  );
}

async function testV3EditableComposesPricingSectionChildren() {
  const html = `<!doctype html>
<html>
  <head>
    <title>Editable Pricing Section Children</title>
  </head>
  <body>
    <section style="padding:24px;background:#f8efe8;">
      <div>
        <h2>Try Advanced Collagen Plus today.</h2>
        <p>Backed by our 60-day money-back guarantee.</p>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3, minmax(0, 1fr));gap:24px;">
        <article style="padding:20px;border-radius:18px;background:#fff;">
          <h3>1 Jar</h3>
          <p>$49.95</p>
          <p>30 day supply</p>
          <a href="#basic">Add to cart</a>
        </article>
        <article style="padding:20px;border-radius:18px;background:#fff;">
          <h3>3 Jars</h3>
          <p>$44.95</p>
          <p>90 day supply</p>
          <a href="#popular">Add to cart</a>
        </article>
        <article style="padding:20px;border-radius:18px;background:#fff;">
          <h3>6 Jars</h3>
          <p>$41.50</p>
          <p>180 day supply</p>
          <a href="#value">Add to cart</a>
        </article>
      </div>
      <div style="display:flex;gap:12px;">
        <p>Secure checkout</p>
        <p>60-day guarantee</p>
        <p>Fast shipping</p>
      </div>
      <div>
        <a href="#claim">Claim your savings</a>
      </div>
    </section>
  </body>
</html>`;
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const captureResult = await runCapturePipelineV3FromHtml(html, {
    preferBrowser: false,
    outputRoot
  });
  const editableDocument = createEditableElementorDocumentV3({
    capture: captureResult.capture,
    layout: captureResult.layout,
    selectedMode: "editable"
  }).document as {
    content: Array<{
      settings?: {
        converter_v3_layout?: {
          sectionComposition?: string;
        };
      };
      elements?: Array<{
        settings?: {
          gap?: string;
          converter_v3_section_role?: string;
          converter_v3_layout?: {
            preset?: string;
            sectionRole?: string;
          };
        };
      }>;
    }>;
  };

  const topLevel = editableDocument.content[0];
  const { shells: regionShells, children: sectionChildren } = unwrapSectionStrategyChildren(
    topLevel.elements
  );
  const topLevelSettings = topLevel.settings as Record<string, unknown> | undefined;
  const typedRegionShells = regionShells as Array<{ settings?: Record<string, unknown> }>;
  const roles = sectionChildren.map((child) => child.settings?.converter_v3_section_role);

  assert.equal(topLevel.settings?.converter_v3_layout?.sectionComposition, "pricing-section");
  assert.equal(topLevelSettings?.converter_v3_section_strategy_structure, "region-shells");
  assert.deepEqual(
    typedRegionShells.map((child) => child.settings?.converter_v3_section_region),
    ["intro", "main", "proof", "closing"]
  );
  assert.deepEqual(roles, [
    "section-header",
    "section-grid",
    "section-support",
    "section-cta"
  ]);
  assert.equal(
    sectionChildren[1]?.settings?.converter_v3_layout?.preset,
    "pricing-cards"
  );
  assert.equal(
    sectionChildren[2]?.settings?.converter_v3_layout?.sectionRole,
    "section-support"
  );
  assert.equal(sectionChildren[2]?.settings?.gap, "12px");
  assert.equal(
    sectionChildren[3]?.settings?.converter_v3_layout?.sectionRole,
    "section-cta"
  );
}

async function testV3HybridComposesPricingSectionChildren() {
  const html = `<!doctype html>
<html>
  <head>
    <title>Hybrid Pricing Section Children</title>
  </head>
  <body>
    <section style="padding:24px;background:#f8efe8;">
      <div>
        <h2>Try Advanced Collagen Plus today.</h2>
        <p>Backed by our 60-day money-back guarantee.</p>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3, minmax(0, 1fr));gap:24px;">
        <article style="padding:20px;border-radius:18px;background:#fff;">
          <h3>1 Jar</h3>
          <p>$49.95</p>
          <p>30 day supply</p>
          <a href="#basic">Add to cart</a>
        </article>
        <article style="padding:20px;border-radius:18px;background:#fff;">
          <h3>3 Jars</h3>
          <p>$44.95</p>
          <p>90 day supply</p>
          <a href="#popular">Add to cart</a>
        </article>
        <article style="padding:20px;border-radius:18px;background:#fff;">
          <h3>6 Jars</h3>
          <p>$41.50</p>
          <p>180 day supply</p>
          <a href="#value">Add to cart</a>
        </article>
      </div>
      <div style="display:flex;gap:12px;">
        <p>Secure checkout</p>
        <p>60-day guarantee</p>
        <p>Fast shipping</p>
      </div>
      <div>
        <a href="#claim">Claim your savings</a>
      </div>
    </section>
  </body>
</html>`;
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const result = await runExportPipelineV3FromHtml(html, {
    preferBrowser: false,
    outputRoot
  });

  assert.equal(result.analysis.selectedMode, "hybrid");
  assert.equal(result.emittedMode, "hybrid");

  const elementorTemplate = JSON.parse(
    await readFile(result.artifacts.elementorTemplatePath, "utf8")
  ) as {
    content: Array<{
      settings?: {
        converter_v3_layout?: {
          sectionComposition?: string;
        };
      };
      elements?: Array<{
        settings?: {
          gap?: string;
          converter_v3_section_role?: string;
          converter_v3_layout?: {
            preset?: string;
            sectionRole?: string;
          };
        };
      }>;
    }>;
  };

  const topLevel = elementorTemplate.content[0];
  const { shells: regionShells, children: sectionChildren } = unwrapSectionStrategyChildren(
    topLevel.elements
  );
  const topLevelSettings = topLevel.settings as Record<string, unknown> | undefined;
  const typedRegionShells = regionShells as Array<{ settings?: Record<string, unknown> }>;
  const roles = sectionChildren.map((child) => child.settings?.converter_v3_section_role);

  assert.equal(topLevel.settings?.converter_v3_layout?.sectionComposition, "pricing-section");
  assert.equal(topLevelSettings?.converter_v3_section_strategy_structure, "region-shells");
  assert.deepEqual(
    typedRegionShells.map((child) => child.settings?.converter_v3_section_region),
    ["intro", "main", "proof", "closing"]
  );
  assert.deepEqual(roles, [
    "section-header",
    "section-grid",
    "section-support",
    "section-cta"
  ]);
  assert.equal(
    sectionChildren[1]?.settings?.converter_v3_layout?.preset,
    "pricing-cards"
  );
  assert.equal(
    sectionChildren[2]?.settings?.converter_v3_layout?.sectionRole,
    "section-support"
  );
  assert.equal(sectionChildren[2]?.settings?.gap, "12px");
  assert.equal(
    sectionChildren[3]?.settings?.converter_v3_layout?.sectionRole,
    "section-cta"
  );
}

async function testV3EditableComposesPricingSectionBlocks() {
  const html = `<!doctype html>
<html>
  <head>
    <title>Editable Pricing Section Blocks</title>
  </head>
  <body>
    <section style="padding:24px;background:#f8efe8;">
      <div>
        <h2>Try Advanced Collagen Plus today.</h2>
        <p>Backed by our 60-day money-back guarantee.</p>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3, minmax(0, 1fr));gap:24px;">
        <article style="padding:20px;border-radius:18px;background:#fff;">
          <h3>1 Jar</h3>
          <p>$49.95</p>
          <p>30 day supply</p>
          <a href="#basic">Add to cart</a>
        </article>
        <article style="padding:20px;border-radius:18px;background:#fff;">
          <h3>3 Jars</h3>
          <p>$44.95</p>
          <p>90 day supply</p>
          <a href="#popular">Add to cart</a>
        </article>
        <article style="padding:20px;border-radius:18px;background:#fff;">
          <h3>6 Jars</h3>
          <p>$41.50</p>
          <p>180 day supply</p>
          <a href="#value">Add to cart</a>
        </article>
      </div>
      <div style="display:flex;gap:12px;">
        <p>Secure checkout</p>
        <p>60-day guarantee</p>
        <p>Fast shipping</p>
      </div>
      <div style="padding:18px;border-radius:16px;background:#fff;">
        <h3>ABN 100% Satisfaction Guarantee</h3>
        <p>If you're unsatisfied for any reason, we’ll make it right.</p>
      </div>
      <div>
        <a href="#claim">Claim your savings</a>
        <p>Limited offer available today.</p>
      </div>
    </section>
  </body>
</html>`;
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const captureResult = await runCapturePipelineV3FromHtml(html, {
    preferBrowser: false,
    outputRoot
  });
  const editableDocument = createEditableElementorDocumentV3({
    capture: captureResult.capture,
    layout: captureResult.layout,
    selectedMode: "editable"
  }).document as {
    content: Array<{
      settings?: {
        converter_v3_section_preset?: string;
        converter_v3_section_preset_layout?: string;
        converter_v3_section_signature?: string;
        converter_v3_section_phases?: string[];
        converter_v3_section_slots?: string[];
        converter_v3_section_slot_signature?: string;
        converter_v3_section_regions?: string[];
        converter_v3_section_region_signature?: string;
        converter_v3_section_strategy?: string;
        converter_v3_section_strategy_profile?: {
          name?: string;
          layoutModel?: string;
          rootGap?: string;
          rootAlignItems?: string;
        };
        converter_v3_section_blueprint?: {
          primarySlot?: string;
          closingSlot?: string;
          regionSignature?: string;
        };
        align_items?: string;
        converter_v3_layout?: {
          sectionComposition?: string;
          sectionPreset?: string;
          sectionPresetLayout?: string;
          sectionSignature?: string;
          sectionPhases?: string[];
          sectionSlots?: string[];
          sectionSlotSignature?: string;
          sectionRegions?: string[];
          sectionRegionSignature?: string;
          sectionStrategy?: string;
          sectionStrategyProfile?: {
            name?: string;
            layoutModel?: string;
            rootGap?: string;
            rootAlignItems?: string;
          };
          sectionBlueprint?: {
            primarySlot?: string;
            closingSlot?: string;
            regionSignature?: string;
          };
        };
      };
      elements?: Array<{
        settings?: {
          converter_v3_section_role?: string;
          converter_v3_section_phase?: string;
          converter_v3_section_block?: string;
          converter_v3_section_block_preset?: string;
          converter_v3_section_slot?: string;
          converter_v3_section_slot_order?: number;
          converter_v3_section_region?: string;
          converter_v3_section_region_order?: number;
          converter_v3_section_region_mode?: string;
          converter_v3_section_strategy?: string;
          converter_v3_section_preset_layout?: string;
          converter_v3_section_block_micro_layout?: string;
          converter_v3_section_block_responsive?: {
            desktop?: { flex_direction?: string; flex_wrap?: string; gap?: string };
            tablet?: { flex_direction?: string; flex_wrap?: string; gap?: string; align_items?: string };
            mobile?: { flex_direction?: string; gap?: string; align_items?: string };
          };
          gap?: string;
          width?: string;
          max_width?: string;
          content_width?: string;
          boxed_width?: string;
          align_self?: string;
          flex_direction?: string;
          justify_content?: string;
          align_items?: string;
          flex_wrap?: string;
          tablet_flex_direction?: string;
          tablet_align_items?: string;
          tablet_gap?: string;
          mobile_flex_direction?: string;
          mobile_gap?: string;
          converter_v3_layout?: {
            sectionRole?: string;
            sectionPhase?: string;
            sectionBlock?: string;
            sectionBlockPreset?: string;
            sectionBlockMicroLayout?: string;
            sectionSlot?: string;
            sectionRegion?: string;
            sectionRegionMode?: string;
            sectionPresetLayout?: string;
            sectionBlockResponsive?: {
              desktop?: { flex_direction?: string; flex_wrap?: string; gap?: string };
              tablet?: { flex_direction?: string; flex_wrap?: string; gap?: string; align_items?: string };
              mobile?: { flex_direction?: string; gap?: string; align_items?: string };
            };
          };
        };
        elements?: Array<{
          settings?: {
            converter_v3_widget_semantic?: string;
            converter_v3_section_block_micro_layout?: string;
            align?: string;
            converter_v3_section_block_widget_responsive?: {
              tablet_width?: string;
              mobile_width?: string;
            };
            font_weight?: string;
            line_height?: string;
            width?: string;
            tablet_width?: string;
            mobile_width?: string;
          };
        }>;
      }>;
    }>;
  };

  const topLevel = editableDocument.content[0];
  const { shells: regionShells, children: sectionChildren } = unwrapSectionStrategyChildren(
    topLevel.elements
  );
  const topLevelSettings = topLevel.settings as Record<string, any> | undefined;
  const topLevelLayout = topLevel.settings?.converter_v3_layout as Record<string, any> | undefined;
  const typedRegionShells = regionShells as Array<{ settings?: Record<string, any> }>;
  const roles = sectionChildren.map((child) => child.settings?.converter_v3_section_role);
  const blocks = sectionChildren.map((child) => child.settings?.converter_v3_section_block);

  assert.equal(topLevel.settings?.converter_v3_layout?.sectionComposition, "pricing-section");
  assert.equal(topLevel.settings?.converter_v3_section_preset, "commerce-offer-section");
  assert.equal(topLevel.settings?.converter_v3_section_strategy, "commerce-offer");
  assert.equal(topLevel.settings?.converter_v3_section_strategy_profile?.name, "commerce-offer");
  assert.equal(
    topLevel.settings?.converter_v3_section_strategy_profile?.layoutModel,
    "stacked-offer"
  );
  assert.equal(topLevel.settings?.converter_v3_section_strategy_profile?.rootGap, "32px");
  assert.equal(topLevelSettings?.converter_v3_section_strategy_structure, "region-shells");
  assert.equal(topLevel.settings?.converter_v3_section_preset_layout, "commerce-narrative");
  assert.equal(topLevel.settings?.converter_v3_section_signature, "intro-main-support-cta");
  assert.equal(
    topLevel.settings?.converter_v3_section_slot_signature,
    "offer-intro-offer-grid-offer-proof-offer-guarantee-offer-closing-cta"
  );
  assert.deepEqual(topLevel.settings?.converter_v3_section_phases, [
    "intro",
    "main",
    "support",
    "cta"
  ]);
  assert.deepEqual(topLevel.settings?.converter_v3_section_slots, [
    "offer-intro",
    "offer-grid",
    "offer-proof",
    "offer-guarantee",
    "offer-closing-cta"
  ]);
  assert.deepEqual(topLevel.settings?.converter_v3_section_regions, [
    "intro",
    "main",
    "proof",
    "support",
    "closing"
  ]);
  assert.equal(
    topLevel.settings?.converter_v3_section_region_signature,
    "intro-main-proof-support-closing"
  );
  assert.equal(topLevel.settings?.converter_v3_section_blueprint?.primarySlot, "offer-intro");
  assert.equal(
    topLevel.settings?.converter_v3_section_blueprint?.closingSlot,
    "offer-closing-cta"
  );
  assert.equal(
    topLevel.settings?.converter_v3_layout?.sectionPreset,
    "commerce-offer-section"
  );
  assert.equal(
    topLevel.settings?.converter_v3_layout?.sectionPresetLayout,
    "commerce-narrative"
  );
  assert.equal(
    topLevel.settings?.converter_v3_layout?.sectionSignature,
    "intro-main-support-cta"
  );
  assert.deepEqual(topLevel.settings?.converter_v3_layout?.sectionPhases, [
    "intro",
    "main",
    "support",
    "cta"
  ]);
  assert.deepEqual(topLevel.settings?.converter_v3_layout?.sectionSlots, [
    "offer-intro",
    "offer-grid",
    "offer-proof",
    "offer-guarantee",
    "offer-closing-cta"
  ]);
  assert.equal(
    topLevel.settings?.converter_v3_layout?.sectionSlotSignature,
    "offer-intro-offer-grid-offer-proof-offer-guarantee-offer-closing-cta"
  );
  assert.deepEqual(topLevel.settings?.converter_v3_layout?.sectionRegions, [
    "intro",
    "main",
    "proof",
    "support",
    "closing"
  ]);
  assert.equal(
    topLevel.settings?.converter_v3_layout?.sectionRegionSignature,
    "intro-main-proof-support-closing"
  );
  assert.equal(topLevel.settings?.converter_v3_layout?.sectionStrategy, "commerce-offer");
  assert.equal(
    topLevel.settings?.converter_v3_layout?.sectionStrategyProfile?.layoutModel,
    "stacked-offer"
  );
  assert.equal(topLevelLayout?.sectionStrategyStructure, "region-shells");
  assert.deepEqual(
    typedRegionShells.map((child) => child.settings?.converter_v3_section_region),
    ["intro", "main", "proof", "support", "closing"]
  );
  assert.ok(
    typedRegionShells.every((child) => child.settings?.converter_v3_section_region_shell === true)
  );
  assert.deepEqual(
    typedRegionShells.map((child) => child.settings?.converter_v3_section_region_child_roles),
    [["section-header"], ["section-grid"], ["section-support"], ["section-support"], ["section-cta"]]
  );
  assert.deepEqual(roles, [
    "section-header",
    "section-grid",
    "section-support",
    "section-support",
    "section-cta"
  ]);
  assert.deepEqual(blocks, [
    "generic",
    "primary-grid",
    "badge-row",
    "guarantee-strip",
    "secondary-cta"
  ]);
  assert.deepEqual(
    sectionChildren.map((child) => child.settings?.converter_v3_section_phase),
    ["intro", "main", "support", "support", "cta"]
  );
  assert.deepEqual(
    sectionChildren.map((child) => child.settings?.converter_v3_layout?.sectionPhase),
    ["intro", "main", "support", "support", "cta"]
  );
  assert.deepEqual(
    sectionChildren.map((child) => child.settings?.converter_v3_section_slot),
    [
      "offer-intro",
      "offer-grid",
      "offer-proof",
      "offer-guarantee",
      "offer-closing-cta"
    ]
  );
  assert.deepEqual(
    sectionChildren.map((child) => child.settings?.converter_v3_section_region),
    ["intro", "main", "proof", "support", "closing"]
  );
  assert.deepEqual(
    sectionChildren.map((child) => child.settings?.converter_v3_section_region_mode),
    [
      "boxed-centered",
      "stretch-grid",
      "boxed-centered",
      "boxed-centered",
      "boxed-centered"
    ]
  );
  assert.deepEqual(
    sectionChildren.map((child) => child.settings?.align_self),
    ["center", "stretch", "center", "center", "center"]
  );
  assert.equal(topLevel.settings?.align_items, "center");
  assert.equal(sectionChildren[0]?.settings?.width, "100%");
  assert.equal(sectionChildren[0]?.settings?.max_width, "720px");
  assert.equal(sectionChildren[0]?.settings?.content_width, "boxed");
  assert.equal(sectionChildren[0]?.settings?.boxed_width, "720px");
  assert.equal(sectionChildren[0]?.settings?.align_items, "center");
  assert.equal(sectionChildren[0]?.settings?.converter_v3_section_preset_layout, "offer-intro");
  assert.equal(sectionChildren[1]?.settings?.max_width, "1200px");
  assert.equal(sectionChildren[1]?.settings?.content_width, "boxed");
  assert.equal(sectionChildren[1]?.settings?.boxed_width, "1200px");
  assert.equal(sectionChildren[1]?.settings?.converter_v3_section_preset_layout, "offer-grid");
  assert.equal(sectionChildren[2]?.settings?.converter_v3_section_block_preset, "badge-list");
  assert.equal(sectionChildren[2]?.settings?.max_width, "960px");
  assert.equal(sectionChildren[2]?.settings?.content_width, "boxed");
  assert.equal(sectionChildren[2]?.settings?.boxed_width, "960px");
  assert.equal(sectionChildren[2]?.settings?.justify_content, "center");
  assert.equal(
    sectionChildren[2]?.settings?.converter_v3_section_preset_layout,
    "offer-proof-row"
  );
  assert.equal(sectionChildren[2]?.settings?.converter_v3_section_block_micro_layout, "badge-flow");
  assert.equal(sectionChildren[2]?.settings?.converter_v3_section_block_responsive?.tablet?.flex_wrap, "wrap");
  assert.equal(sectionChildren[2]?.settings?.converter_v3_section_block_responsive?.mobile?.flex_direction, "column");
  assert.equal(sectionChildren[2]?.settings?.flex_wrap, "wrap");
  assert.equal(sectionChildren[2]?.settings?.tablet_flex_direction, "row");
  assert.equal(sectionChildren[2]?.settings?.tablet_gap, "12px");
  assert.equal(sectionChildren[2]?.settings?.mobile_flex_direction, "column");
  assert.equal(sectionChildren[2]?.settings?.mobile_gap, "10px");
  assert.equal(sectionChildren[2]?.settings?.flex_direction, "row");
  assert.equal(
    sectionChildren[3]?.settings?.converter_v3_section_block_preset,
    "guarantee-panel"
  );
  assert.equal(
    sectionChildren[3]?.settings?.converter_v3_section_block_micro_layout,
    "guarantee-stack"
  );
  assert.equal(sectionChildren[3]?.settings?.max_width, "720px");
  assert.equal(sectionChildren[3]?.settings?.content_width, "boxed");
  assert.equal(sectionChildren[3]?.settings?.boxed_width, "720px");
  assert.equal(sectionChildren[3]?.settings?.align_items, "center");
  assert.equal(
    sectionChildren[3]?.settings?.converter_v3_section_preset_layout,
    "offer-guarantee"
  );
  assert.equal(sectionChildren[3]?.settings?.converter_v3_section_block_responsive?.tablet?.flex_direction, "column");
  assert.equal(sectionChildren[3]?.settings?.flex_direction, "column");
  assert.equal(sectionChildren[3]?.settings?.gap, "10px");
  assert.equal(sectionChildren[3]?.settings?.tablet_flex_direction, "column");
  assert.equal(sectionChildren[3]?.settings?.tablet_gap, "10px");
  assert.equal(sectionChildren[3]?.settings?.mobile_flex_direction, "column");
  assert.equal(
    sectionChildren[4]?.settings?.converter_v3_section_block_preset,
    "secondary-cta-stack"
  );
  assert.equal(
    sectionChildren[4]?.settings?.converter_v3_section_block_micro_layout,
    "secondary-cta-stack"
  );
  assert.equal(sectionChildren[4]?.settings?.max_width, "520px");
  assert.equal(sectionChildren[4]?.settings?.content_width, "boxed");
  assert.equal(sectionChildren[4]?.settings?.boxed_width, "520px");
  assert.equal(sectionChildren[4]?.settings?.align_items, "center");
  assert.equal(
    sectionChildren[4]?.settings?.converter_v3_section_preset_layout,
    "offer-closing-cta"
  );
  assert.equal(sectionChildren[4]?.settings?.converter_v3_section_block_responsive?.tablet?.flex_direction, "column");
  assert.equal(sectionChildren[4]?.settings?.flex_direction, "column");
  assert.equal(sectionChildren[4]?.settings?.tablet_flex_direction, "column");
  assert.equal(sectionChildren[4]?.settings?.tablet_gap, "10px");
  assert.equal(sectionChildren[4]?.settings?.mobile_flex_direction, "column");
  assert.equal(
    sectionChildren[4]?.settings?.converter_v3_layout?.sectionBlock,
    "secondary-cta"
  );
  assert.equal(
    sectionChildren[4]?.settings?.converter_v3_layout?.sectionBlockPreset,
    "secondary-cta-stack"
  );
  assert.deepEqual(
    (sectionChildren[2]?.elements ?? []).map(
      (child) => child.settings?.converter_v3_widget_semantic
    ),
    ["section-badge", "section-badge", "section-badge"]
  );
  assert.ok(
    (sectionChildren[2]?.elements ?? []).every(
      (child) =>
        child.settings?.converter_v3_section_block_micro_layout === "badge-flow" &&
        child.settings?.tablet_width === "48%" &&
        child.settings?.converter_v3_section_block_widget_responsive?.tablet_width === "48%" &&
        child.settings?.mobile_width === "100%"
    )
  );
  assert.deepEqual(
    (sectionChildren[3]?.elements ?? []).map(
      (child) => child.settings?.converter_v3_widget_semantic
    ),
    ["guarantee-title", "guarantee-support"]
  );
  assert.equal(sectionChildren[3]?.elements?.[0]?.settings?.font_weight, "700");
  assert.equal(sectionChildren[3]?.elements?.[0]?.settings?.align, "center");
  assert.equal(sectionChildren[3]?.elements?.[1]?.settings?.line_height, "1.5");
  assert.equal(sectionChildren[3]?.elements?.[1]?.settings?.align, "center");
  assert.ok(
    (sectionChildren[3]?.elements ?? []).every(
      (child) =>
        child.settings?.converter_v3_section_block_micro_layout === "guarantee-stack" &&
        child.settings?.tablet_width === "100%" &&
        child.settings?.mobile_width === "100%"
    )
  );
  assert.deepEqual(
    (sectionChildren[4]?.elements ?? []).map(
      (child) => child.settings?.converter_v3_widget_semantic
    ),
    ["section-secondary-cta", "section-secondary-support"]
  );
  assert.equal(sectionChildren[4]?.elements?.[0]?.settings?.width, "100%");
  assert.equal(sectionChildren[4]?.elements?.[0]?.settings?.align, "center");
  assert.equal(sectionChildren[4]?.elements?.[0]?.settings?.tablet_width, "100%");
  assert.equal(
    sectionChildren[4]?.elements?.[0]?.settings?.converter_v3_section_block_micro_layout,
    "secondary-cta-stack"
  );
  assert.equal(
    sectionChildren[4]?.elements?.[0]?.settings?.converter_v3_section_block_widget_responsive?.tablet_width,
    "100%"
  );
  assert.equal(sectionChildren[4]?.elements?.[1]?.settings?.mobile_width, "100%");
}

async function testV3HybridComposesPricingSectionBlocks() {
  const html = `<!doctype html>
<html>
  <head>
    <title>Hybrid Pricing Section Blocks</title>
  </head>
  <body>
    <section style="padding:24px;background:#f8efe8;">
      <div>
        <h2>Try Advanced Collagen Plus today.</h2>
        <p>Backed by our 60-day money-back guarantee.</p>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3, minmax(0, 1fr));gap:24px;">
        <article style="padding:20px;border-radius:18px;background:#fff;">
          <h3>1 Jar</h3>
          <p>$49.95</p>
          <p>30 day supply</p>
          <a href="#basic">Add to cart</a>
        </article>
        <article style="padding:20px;border-radius:18px;background:#fff;">
          <h3>3 Jars</h3>
          <p>$44.95</p>
          <p>90 day supply</p>
          <a href="#popular">Add to cart</a>
        </article>
        <article style="padding:20px;border-radius:18px;background:#fff;">
          <h3>6 Jars</h3>
          <p>$41.50</p>
          <p>180 day supply</p>
          <a href="#value">Add to cart</a>
        </article>
      </div>
      <div style="display:flex;gap:12px;">
        <p>Secure checkout</p>
        <p>60-day guarantee</p>
        <p>Fast shipping</p>
      </div>
      <div style="padding:18px;border-radius:16px;background:#fff;">
        <h3>ABN 100% Satisfaction Guarantee</h3>
        <p>If you're unsatisfied for any reason, we’ll make it right.</p>
      </div>
      <div>
        <a href="#claim">Claim your savings</a>
        <p>Limited offer available today.</p>
      </div>
    </section>
  </body>
</html>`;
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const result = await runExportPipelineV3FromHtml(html, {
    preferBrowser: false,
    outputRoot
  });

  assert.equal(result.analysis.selectedMode, "hybrid");
  assert.equal(result.emittedMode, "hybrid");

  const elementorTemplate = JSON.parse(
    await readFile(result.artifacts.elementorTemplatePath, "utf8")
  ) as {
    content: Array<{
      settings?: {
        converter_v3_section_preset?: string;
        converter_v3_section_preset_layout?: string;
        converter_v3_section_signature?: string;
        converter_v3_section_phases?: string[];
        converter_v3_section_slots?: string[];
        converter_v3_section_slot_signature?: string;
        converter_v3_section_regions?: string[];
        converter_v3_section_region_signature?: string;
        converter_v3_section_strategy?: string;
        converter_v3_section_strategy_profile?: {
          name?: string;
          layoutModel?: string;
          rootGap?: string;
          rootAlignItems?: string;
        };
        converter_v3_section_blueprint?: {
          primarySlot?: string;
          closingSlot?: string;
          regionSignature?: string;
        };
        align_items?: string;
        converter_v3_layout?: {
          sectionComposition?: string;
          sectionPreset?: string;
          sectionPresetLayout?: string;
          sectionSignature?: string;
          sectionPhases?: string[];
          sectionSlots?: string[];
          sectionSlotSignature?: string;
          sectionRegions?: string[];
          sectionRegionSignature?: string;
          sectionStrategy?: string;
          sectionStrategyProfile?: {
            name?: string;
            layoutModel?: string;
            rootGap?: string;
            rootAlignItems?: string;
          };
          sectionBlueprint?: {
            primarySlot?: string;
            closingSlot?: string;
            regionSignature?: string;
          };
        };
      };
      elements?: Array<{
        settings?: {
          converter_v3_section_role?: string;
          converter_v3_section_phase?: string;
          converter_v3_section_block?: string;
          converter_v3_section_block_preset?: string;
          converter_v3_section_slot?: string;
          converter_v3_section_slot_order?: number;
          converter_v3_section_region?: string;
          converter_v3_section_region_order?: number;
          converter_v3_section_region_mode?: string;
          converter_v3_section_strategy?: string;
          converter_v3_section_preset_layout?: string;
          converter_v3_section_block_micro_layout?: string;
          converter_v3_section_block_responsive?: {
            desktop?: { flex_direction?: string; flex_wrap?: string; gap?: string };
            tablet?: { flex_direction?: string; flex_wrap?: string; gap?: string; align_items?: string };
            mobile?: { flex_direction?: string; gap?: string; align_items?: string };
          };
          gap?: string;
          width?: string;
          max_width?: string;
          content_width?: string;
          boxed_width?: string;
          align_self?: string;
          flex_direction?: string;
          justify_content?: string;
          align_items?: string;
          flex_wrap?: string;
          tablet_flex_direction?: string;
          tablet_align_items?: string;
          tablet_gap?: string;
          mobile_flex_direction?: string;
          mobile_gap?: string;
          converter_v3_layout?: {
            sectionRole?: string;
            sectionPhase?: string;
            sectionBlock?: string;
            sectionBlockPreset?: string;
            sectionBlockMicroLayout?: string;
            sectionSlot?: string;
            sectionRegion?: string;
            sectionRegionMode?: string;
            sectionPresetLayout?: string;
            sectionBlockResponsive?: {
              desktop?: { flex_direction?: string; flex_wrap?: string; gap?: string };
              tablet?: { flex_direction?: string; flex_wrap?: string; gap?: string; align_items?: string };
              mobile?: { flex_direction?: string; gap?: string; align_items?: string };
            };
          };
        };
        elements?: Array<{
          settings?: {
            converter_v3_widget_semantic?: string;
            converter_v3_section_block_micro_layout?: string;
            align?: string;
            converter_v3_section_block_widget_responsive?: {
              tablet_width?: string;
              mobile_width?: string;
            };
            font_weight?: string;
            line_height?: string;
            width?: string;
            tablet_width?: string;
            mobile_width?: string;
          };
        }>;
      }>;
    }>;
  };

  const topLevel = elementorTemplate.content[0];
  const { shells: regionShells, children: sectionChildren } = unwrapSectionStrategyChildren(
    topLevel.elements
  );
  const topLevelSettings = topLevel.settings as Record<string, any> | undefined;
  const topLevelLayout = topLevel.settings?.converter_v3_layout as Record<string, any> | undefined;
  const typedRegionShells = regionShells as Array<{ settings?: Record<string, any> }>;
  const roles = sectionChildren.map((child) => child.settings?.converter_v3_section_role);
  const blocks = sectionChildren.map((child) => child.settings?.converter_v3_section_block);

  assert.equal(topLevel.settings?.converter_v3_layout?.sectionComposition, "pricing-section");
  assert.equal(topLevel.settings?.converter_v3_section_preset, "commerce-offer-section");
  assert.equal(topLevel.settings?.converter_v3_section_strategy, "commerce-offer");
  assert.equal(topLevel.settings?.converter_v3_section_strategy_profile?.name, "commerce-offer");
  assert.equal(
    topLevel.settings?.converter_v3_section_strategy_profile?.layoutModel,
    "stacked-offer"
  );
  assert.equal(topLevel.settings?.converter_v3_section_strategy_profile?.rootGap, "32px");
  assert.equal(topLevelSettings?.converter_v3_section_strategy_structure, "region-shells");
  assert.equal(topLevel.settings?.converter_v3_section_preset_layout, "commerce-narrative");
  assert.equal(topLevel.settings?.converter_v3_section_signature, "intro-main-support-cta");
  assert.equal(
    topLevel.settings?.converter_v3_section_slot_signature,
    "offer-intro-offer-grid-offer-proof-offer-guarantee-offer-closing-cta"
  );
  assert.deepEqual(topLevel.settings?.converter_v3_section_phases, [
    "intro",
    "main",
    "support",
    "cta"
  ]);
  assert.deepEqual(topLevel.settings?.converter_v3_section_slots, [
    "offer-intro",
    "offer-grid",
    "offer-proof",
    "offer-guarantee",
    "offer-closing-cta"
  ]);
  assert.deepEqual(topLevel.settings?.converter_v3_section_regions, [
    "intro",
    "main",
    "proof",
    "support",
    "closing"
  ]);
  assert.equal(
    topLevel.settings?.converter_v3_section_region_signature,
    "intro-main-proof-support-closing"
  );
  assert.equal(topLevel.settings?.converter_v3_section_blueprint?.primarySlot, "offer-intro");
  assert.equal(
    topLevel.settings?.converter_v3_section_blueprint?.closingSlot,
    "offer-closing-cta"
  );
  assert.equal(
    topLevel.settings?.converter_v3_layout?.sectionPreset,
    "commerce-offer-section"
  );
  assert.equal(
    topLevel.settings?.converter_v3_layout?.sectionPresetLayout,
    "commerce-narrative"
  );
  assert.equal(
    topLevel.settings?.converter_v3_layout?.sectionSignature,
    "intro-main-support-cta"
  );
  assert.deepEqual(topLevel.settings?.converter_v3_layout?.sectionPhases, [
    "intro",
    "main",
    "support",
    "cta"
  ]);
  assert.deepEqual(topLevel.settings?.converter_v3_layout?.sectionSlots, [
    "offer-intro",
    "offer-grid",
    "offer-proof",
    "offer-guarantee",
    "offer-closing-cta"
  ]);
  assert.equal(
    topLevel.settings?.converter_v3_layout?.sectionSlotSignature,
    "offer-intro-offer-grid-offer-proof-offer-guarantee-offer-closing-cta"
  );
  assert.deepEqual(topLevel.settings?.converter_v3_layout?.sectionRegions, [
    "intro",
    "main",
    "proof",
    "support",
    "closing"
  ]);
  assert.equal(
    topLevel.settings?.converter_v3_layout?.sectionRegionSignature,
    "intro-main-proof-support-closing"
  );
  assert.equal(topLevel.settings?.converter_v3_layout?.sectionStrategy, "commerce-offer");
  assert.equal(
    topLevel.settings?.converter_v3_layout?.sectionStrategyProfile?.layoutModel,
    "stacked-offer"
  );
  assert.equal(topLevelLayout?.sectionStrategyStructure, "region-shells");
  assert.deepEqual(
    typedRegionShells.map((child) => child.settings?.converter_v3_section_region),
    ["intro", "main", "proof", "support", "closing"]
  );
  assert.ok(
    typedRegionShells.every((child) => child.settings?.converter_v3_section_region_shell === true)
  );
  assert.deepEqual(
    typedRegionShells.map((child) => child.settings?.converter_v3_section_region_child_roles),
    [["section-header"], ["section-grid"], ["section-support"], ["section-support"], ["section-cta"]]
  );
  assert.deepEqual(roles, [
    "section-header",
    "section-grid",
    "section-support",
    "section-support",
    "section-cta"
  ]);
  assert.deepEqual(blocks, [
    "generic",
    "primary-grid",
    "badge-row",
    "guarantee-strip",
    "secondary-cta"
  ]);
  assert.deepEqual(
    sectionChildren.map((child) => child.settings?.converter_v3_section_phase),
    ["intro", "main", "support", "support", "cta"]
  );
  assert.deepEqual(
    sectionChildren.map((child) => child.settings?.converter_v3_layout?.sectionPhase),
    ["intro", "main", "support", "support", "cta"]
  );
  assert.deepEqual(
    sectionChildren.map((child) => child.settings?.converter_v3_section_slot),
    [
      "offer-intro",
      "offer-grid",
      "offer-proof",
      "offer-guarantee",
      "offer-closing-cta"
    ]
  );
  assert.deepEqual(
    sectionChildren.map((child) => child.settings?.converter_v3_section_region),
    ["intro", "main", "proof", "support", "closing"]
  );
  assert.deepEqual(
    sectionChildren.map((child) => child.settings?.converter_v3_section_region_mode),
    [
      "boxed-centered",
      "stretch-grid",
      "boxed-centered",
      "boxed-centered",
      "boxed-centered"
    ]
  );
  assert.deepEqual(
    sectionChildren.map((child) => child.settings?.align_self),
    ["center", "stretch", "center", "center", "center"]
  );
  assert.equal(topLevel.settings?.align_items, "center");
  assert.equal(sectionChildren[0]?.settings?.width, "100%");
  assert.equal(sectionChildren[0]?.settings?.max_width, "720px");
  assert.equal(sectionChildren[0]?.settings?.content_width, "boxed");
  assert.equal(sectionChildren[0]?.settings?.boxed_width, "720px");
  assert.equal(sectionChildren[0]?.settings?.align_items, "center");
  assert.equal(sectionChildren[0]?.settings?.converter_v3_section_preset_layout, "offer-intro");
  assert.equal(sectionChildren[1]?.settings?.max_width, "1200px");
  assert.equal(sectionChildren[1]?.settings?.content_width, "boxed");
  assert.equal(sectionChildren[1]?.settings?.boxed_width, "1200px");
  assert.equal(sectionChildren[1]?.settings?.converter_v3_section_preset_layout, "offer-grid");
  assert.equal(sectionChildren[2]?.settings?.converter_v3_section_block_preset, "badge-list");
  assert.equal(sectionChildren[2]?.settings?.max_width, "960px");
  assert.equal(sectionChildren[2]?.settings?.content_width, "boxed");
  assert.equal(sectionChildren[2]?.settings?.boxed_width, "960px");
  assert.equal(sectionChildren[2]?.settings?.justify_content, "center");
  assert.equal(
    sectionChildren[2]?.settings?.converter_v3_section_preset_layout,
    "offer-proof-row"
  );
  assert.equal(sectionChildren[2]?.settings?.converter_v3_section_block_micro_layout, "badge-flow");
  assert.equal(sectionChildren[2]?.settings?.converter_v3_section_block_responsive?.tablet?.flex_wrap, "wrap");
  assert.equal(sectionChildren[2]?.settings?.converter_v3_section_block_responsive?.mobile?.flex_direction, "column");
  assert.equal(sectionChildren[2]?.settings?.flex_wrap, "wrap");
  assert.equal(sectionChildren[2]?.settings?.tablet_flex_direction, "row");
  assert.equal(sectionChildren[2]?.settings?.tablet_gap, "12px");
  assert.equal(sectionChildren[2]?.settings?.mobile_flex_direction, "column");
  assert.equal(sectionChildren[2]?.settings?.mobile_gap, "10px");
  assert.equal(sectionChildren[2]?.settings?.flex_direction, "row");
  assert.equal(
    sectionChildren[3]?.settings?.converter_v3_section_block_preset,
    "guarantee-panel"
  );
  assert.equal(
    sectionChildren[3]?.settings?.converter_v3_section_block_micro_layout,
    "guarantee-stack"
  );
  assert.equal(sectionChildren[3]?.settings?.max_width, "720px");
  assert.equal(sectionChildren[3]?.settings?.content_width, "boxed");
  assert.equal(sectionChildren[3]?.settings?.boxed_width, "720px");
  assert.equal(sectionChildren[3]?.settings?.align_items, "center");
  assert.equal(
    sectionChildren[3]?.settings?.converter_v3_section_preset_layout,
    "offer-guarantee"
  );
  assert.equal(sectionChildren[3]?.settings?.converter_v3_section_block_responsive?.tablet?.flex_direction, "column");
  assert.equal(sectionChildren[3]?.settings?.flex_direction, "column");
  assert.equal(sectionChildren[3]?.settings?.gap, "10px");
  assert.equal(sectionChildren[3]?.settings?.tablet_flex_direction, "column");
  assert.equal(sectionChildren[3]?.settings?.tablet_gap, "10px");
  assert.equal(sectionChildren[3]?.settings?.mobile_flex_direction, "column");
  assert.equal(
    sectionChildren[4]?.settings?.converter_v3_section_block_preset,
    "secondary-cta-stack"
  );
  assert.equal(
    sectionChildren[4]?.settings?.converter_v3_section_block_micro_layout,
    "secondary-cta-stack"
  );
  assert.equal(sectionChildren[4]?.settings?.max_width, "520px");
  assert.equal(sectionChildren[4]?.settings?.content_width, "boxed");
  assert.equal(sectionChildren[4]?.settings?.boxed_width, "520px");
  assert.equal(sectionChildren[4]?.settings?.align_items, "center");
  assert.equal(
    sectionChildren[4]?.settings?.converter_v3_section_preset_layout,
    "offer-closing-cta"
  );
  assert.equal(sectionChildren[4]?.settings?.converter_v3_section_block_responsive?.tablet?.flex_direction, "column");
  assert.equal(sectionChildren[4]?.settings?.flex_direction, "column");
  assert.equal(sectionChildren[4]?.settings?.tablet_flex_direction, "column");
  assert.equal(sectionChildren[4]?.settings?.tablet_gap, "10px");
  assert.equal(sectionChildren[4]?.settings?.mobile_flex_direction, "column");
  assert.equal(
    sectionChildren[4]?.settings?.converter_v3_layout?.sectionBlock,
    "secondary-cta"
  );
  assert.equal(
    sectionChildren[4]?.settings?.converter_v3_layout?.sectionBlockPreset,
    "secondary-cta-stack"
  );
  assert.deepEqual(
    (sectionChildren[2]?.elements ?? []).map(
      (child) => child.settings?.converter_v3_widget_semantic
    ),
    ["section-badge", "section-badge", "section-badge"]
  );
  assert.ok(
    (sectionChildren[2]?.elements ?? []).every(
      (child) =>
        child.settings?.converter_v3_section_block_micro_layout === "badge-flow" &&
        child.settings?.tablet_width === "48%" &&
        child.settings?.converter_v3_section_block_widget_responsive?.tablet_width === "48%" &&
        child.settings?.mobile_width === "100%"
    )
  );
  assert.deepEqual(
    (sectionChildren[3]?.elements ?? []).map(
      (child) => child.settings?.converter_v3_widget_semantic
    ),
    ["guarantee-title", "guarantee-support"]
  );
  assert.equal(sectionChildren[3]?.elements?.[0]?.settings?.font_weight, "700");
  assert.equal(sectionChildren[3]?.elements?.[0]?.settings?.align, "center");
  assert.equal(sectionChildren[3]?.elements?.[1]?.settings?.line_height, "1.5");
  assert.equal(sectionChildren[3]?.elements?.[1]?.settings?.align, "center");
  assert.ok(
    (sectionChildren[3]?.elements ?? []).every(
      (child) =>
        child.settings?.converter_v3_section_block_micro_layout === "guarantee-stack" &&
        child.settings?.tablet_width === "100%" &&
        child.settings?.mobile_width === "100%"
    )
  );
  assert.deepEqual(
    (sectionChildren[4]?.elements ?? []).map(
      (child) => child.settings?.converter_v3_widget_semantic
    ),
    ["section-secondary-cta", "section-secondary-support"]
  );
  assert.equal(sectionChildren[4]?.elements?.[0]?.settings?.width, "100%");
  assert.equal(sectionChildren[4]?.elements?.[0]?.settings?.align, "center");
  assert.equal(sectionChildren[4]?.elements?.[0]?.settings?.tablet_width, "100%");
  assert.equal(
    sectionChildren[4]?.elements?.[0]?.settings?.converter_v3_section_block_micro_layout,
    "secondary-cta-stack"
  );
  assert.equal(
    sectionChildren[4]?.elements?.[0]?.settings?.converter_v3_section_block_widget_responsive?.tablet_width,
    "100%"
  );
  assert.equal(sectionChildren[4]?.elements?.[1]?.settings?.mobile_width, "100%");
}

async function testV3EditableComposesFeatureSectionIntroBlock() {
  const html = `<!doctype html>
<html>
  <head>
    <title>Editable Feature Section Intro</title>
  </head>
  <body>
    <section style="padding:24px;background:#fffaf7;">
      <div>
        <p>Designed for you</p>
        <h2>One scoop. Three transformations.</h2>
        <p>Support for skin, joints, and daily vitality.</p>
        <a href="#benefits">See all benefits</a>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3, minmax(0, 1fr));gap:24px;">
        <article>
          <img src="https://example.com/feature-1.jpg" alt="Feature 1" />
          <p>Radiant skin</p>
          <h3>Visibly firmer, smoother skin</h3>
          <p>Daily collagen support for healthy-looking skin.</p>
          <a href="#skin">Learn more</a>
        </article>
        <article>
          <img src="https://example.com/feature-2.jpg" alt="Feature 2" />
          <p>Active health</p>
          <h3>Move with ease, every day</h3>
          <p>Support for cartilage, joint comfort and flexibility.</p>
          <a href="#mobility">Learn more</a>
        </article>
        <article>
          <img src="https://example.com/feature-3.jpg" alt="Feature 3" />
          <p>Premium ingredients</p>
          <h3>5 types. 4 sources. Zero compromise.</h3>
          <p>Collagen designed to dissolve perfectly in hot or cold drinks.</p>
          <a href="#ingredients">Learn more</a>
        </article>
      </div>
    </section>
  </body>
</html>`;
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const captureResult = await runCapturePipelineV3FromHtml(html, {
    preferBrowser: false,
    outputRoot
  });
  const editableDocument = createEditableElementorDocumentV3({
    capture: captureResult.capture,
    layout: captureResult.layout,
    selectedMode: "editable"
  }).document as {
    content: Array<{
      settings?: {
        converter_v3_section_preset?: string;
        converter_v3_section_preset_layout?: string;
        converter_v3_section_signature?: string;
        converter_v3_section_phases?: string[];
        converter_v3_section_slots?: string[];
        converter_v3_section_slot_signature?: string;
        converter_v3_section_regions?: string[];
        converter_v3_section_region_signature?: string;
        converter_v3_section_strategy?: string;
        converter_v3_section_strategy_profile?: {
          name?: string;
          layoutModel?: string;
          rootGap?: string;
        };
        converter_v3_layout?: {
          sectionComposition?: string;
          sectionPreset?: string;
          sectionPresetLayout?: string;
          sectionSignature?: string;
          sectionPhases?: string[];
          sectionSlots?: string[];
          sectionSlotSignature?: string;
          sectionRegions?: string[];
          sectionRegionSignature?: string;
          sectionStrategy?: string;
          sectionStrategyProfile?: {
            name?: string;
            layoutModel?: string;
            rootGap?: string;
          };
        };
      };
      elements?: Array<{
        settings?: {
          converter_v3_section_role?: string;
          converter_v3_section_slot?: string;
          converter_v3_section_region?: string;
          converter_v3_section_region_mode?: string;
          converter_v3_section_strategy?: string;
          converter_v3_section_preset_layout?: string;
          converter_v3_section_block_preset?: string;
          converter_v3_section_block_micro_layout?: string;
          gap?: string;
          width?: string;
          max_width?: string;
          content_width?: string;
          boxed_width?: string;
          align_self?: string;
          flex_direction?: string;
          align_items?: string;
          mobile_flex_direction?: string;
          converter_v3_layout?: {
            preset?: string;
            sectionPresetLayout?: string;
          };
        };
        elements?: Array<{
          settings?: {
            converter_v3_widget_semantic?: string;
            converter_v3_section_block_micro_layout?: string;
            align?: string;
            width?: string;
            mobile_width?: string;
          };
        }>;
      }>;
    }>;
  };

  const topLevel = editableDocument.content[0];
  const sectionChildren = topLevel.elements ?? [];

  assert.equal(topLevel.settings?.converter_v3_layout?.sectionComposition, "feature-section");
  assert.equal(topLevel.settings?.converter_v3_section_preset, "benefits-showcase-section");
  assert.equal(topLevel.settings?.converter_v3_section_strategy, "benefits-showcase");
  assert.equal(
    topLevel.settings?.converter_v3_section_strategy_profile?.layoutModel,
    "stacked-benefits"
  );
  assert.equal(topLevel.settings?.converter_v3_section_preset_layout, "benefits-narrative");
  assert.equal(topLevel.settings?.converter_v3_section_signature, "intro-main");
  assert.equal(
    topLevel.settings?.converter_v3_section_slot_signature,
    "benefits-intro-benefits-grid"
  );
  assert.equal(
    topLevel.settings?.converter_v3_section_region_signature,
    "intro-main"
  );
  assert.deepEqual(topLevel.settings?.converter_v3_section_phases, ["intro", "main"]);
  assert.deepEqual(topLevel.settings?.converter_v3_section_slots, [
    "benefits-intro",
    "benefits-grid"
  ]);
  assert.deepEqual(topLevel.settings?.converter_v3_section_regions, ["intro", "main"]);
  assert.equal(topLevel.settings?.converter_v3_layout?.sectionStrategy, "benefits-showcase");
  assert.equal(
    topLevel.settings?.converter_v3_layout?.sectionStrategyProfile?.layoutModel,
    "stacked-benefits"
  );
  assert.equal(sectionChildren[0]?.settings?.converter_v3_section_role, "section-header");
  assert.equal(sectionChildren[0]?.settings?.converter_v3_section_slot, "benefits-intro");
  assert.equal(sectionChildren[0]?.settings?.converter_v3_section_region, "intro");
  assert.equal(sectionChildren[0]?.settings?.converter_v3_section_region_mode, "boxed-centered");
  assert.equal(sectionChildren[0]?.settings?.align_self, "center");
  assert.equal(sectionChildren[0]?.settings?.converter_v3_section_preset_layout, "benefits-intro");
  assert.equal(sectionChildren[0]?.settings?.converter_v3_section_block_preset, "section-intro-stack");
  assert.equal(sectionChildren[0]?.settings?.converter_v3_section_block_micro_layout, "intro-stack");
  assert.equal(sectionChildren[0]?.settings?.width, "100%");
  assert.equal(sectionChildren[0]?.settings?.max_width, "760px");
  assert.equal(sectionChildren[0]?.settings?.content_width, "boxed");
  assert.equal(sectionChildren[0]?.settings?.boxed_width, "760px");
  assert.equal(sectionChildren[0]?.settings?.flex_direction, "column");
  assert.equal(sectionChildren[0]?.settings?.align_items, "center");
  assert.equal(sectionChildren[0]?.settings?.gap, "14px");
  assert.equal(sectionChildren[0]?.settings?.mobile_flex_direction, "column");
  assert.equal(sectionChildren[1]?.settings?.max_width, "1180px");
  assert.equal(sectionChildren[1]?.settings?.converter_v3_section_slot, "benefits-grid");
  assert.equal(sectionChildren[1]?.settings?.converter_v3_section_region, "main");
  assert.equal(sectionChildren[1]?.settings?.converter_v3_section_region_mode, "stretch-grid");
  assert.equal(sectionChildren[1]?.settings?.align_self, "stretch");
  assert.equal(sectionChildren[1]?.settings?.content_width, "boxed");
  assert.equal(sectionChildren[1]?.settings?.boxed_width, "1180px");
  assert.equal(sectionChildren[1]?.settings?.converter_v3_layout?.sectionPresetLayout, "benefits-grid");
  assert.equal(sectionChildren[1]?.settings?.converter_v3_layout?.preset, "feature-cards");
  assert.deepEqual(
    (sectionChildren[0]?.elements ?? []).map(
      (child) => child.settings?.converter_v3_widget_semantic
    ),
    [
      "section-intro-eyebrow",
      "section-intro-title",
      "section-intro-support",
      "section-intro-cta"
    ]
  );
  assert.ok(
    (sectionChildren[0]?.elements ?? []).every(
      (child) => child.settings?.align === "center"
    )
  );
  assert.equal(sectionChildren[0]?.elements?.[3]?.settings?.width, "100%");
  assert.equal(sectionChildren[0]?.elements?.[3]?.settings?.mobile_width, "100%");
  assert.ok(
    (sectionChildren[0]?.elements ?? []).every(
      (child) => child.settings?.converter_v3_section_block_micro_layout === "intro-stack"
    )
  );
}

async function testV3HybridComposesTestimonialSectionIntroBlock() {
  const html = `<!doctype html>
<html>
  <head>
    <title>Hybrid Testimonial Section Intro</title>
  </head>
  <body>
    <section style="padding:24px;background:#fffaf7;">
      <div>
        <p>Customer stories</p>
        <h2>Loved by thousands.</h2>
        <p>Real feedback from customers who made this part of their daily routine.</p>
      </div>
      <div style="display:grid;grid-template-columns:repeat(2, minmax(0, 1fr));gap:24px;">
        <article>
          <img src="https://example.com/review-1.jpg" alt="Reviewer 1" />
          <p>★★★★★</p>
          <p>This collagen has become part of my routine and I already notice the difference.</p>
          <h4>Lauren B.</h4>
        </article>
        <article>
          <img src="https://example.com/review-2.jpg" alt="Reviewer 2" />
          <p>★★★★★</p>
          <p>Supportive, easy to take, and actually pleasant to use every single day.</p>
          <h4>Maria S.</h4>
        </article>
      </div>
    </section>
  </body>
</html>`;
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const result = await runExportPipelineV3FromHtml(html, {
    preferBrowser: false,
    outputRoot
  });

  assert.equal(result.analysis.selectedMode, "hybrid");
  assert.equal(result.emittedMode, "hybrid");

  const elementorTemplate = JSON.parse(
    await readFile(result.artifacts.elementorTemplatePath, "utf8")
  ) as {
    content: Array<{
      settings?: {
        converter_v3_section_preset?: string;
        converter_v3_section_preset_layout?: string;
        converter_v3_section_signature?: string;
        converter_v3_section_phases?: string[];
        converter_v3_section_slots?: string[];
        converter_v3_section_slot_signature?: string;
        converter_v3_section_regions?: string[];
        converter_v3_section_region_signature?: string;
        converter_v3_section_strategy?: string;
        converter_v3_section_strategy_profile?: {
          name?: string;
          layoutModel?: string;
          rootGap?: string;
        };
        converter_v3_layout?: {
          sectionComposition?: string;
          sectionPreset?: string;
          sectionPresetLayout?: string;
          sectionSignature?: string;
          sectionPhases?: string[];
          sectionSlots?: string[];
          sectionSlotSignature?: string;
          sectionRegions?: string[];
          sectionRegionSignature?: string;
          sectionStrategy?: string;
          sectionStrategyProfile?: {
            name?: string;
            layoutModel?: string;
            rootGap?: string;
          };
        };
      };
      elements?: Array<{
        settings?: {
          converter_v3_section_role?: string;
          converter_v3_section_slot?: string;
          converter_v3_section_preset_layout?: string;
          converter_v3_section_block_preset?: string;
          converter_v3_section_block_micro_layout?: string;
          gap?: string;
          width?: string;
          max_width?: string;
          content_width?: string;
          boxed_width?: string;
          flex_direction?: string;
          align_items?: string;
          mobile_flex_direction?: string;
          converter_v3_layout?: {
            preset?: string;
            sectionPresetLayout?: string;
          };
        };
        elements?: Array<{
          settings?: {
            converter_v3_widget_semantic?: string;
            converter_v3_section_block_micro_layout?: string;
            align?: string;
          };
        }>;
      }>;
    }>;
  };

  const topLevel = elementorTemplate.content[0];
  const sectionChildren = topLevel.elements ?? [];

  assert.equal(topLevel.settings?.converter_v3_layout?.sectionComposition, "testimonial-section");
  assert.equal(topLevel.settings?.converter_v3_section_preset, "social-proof-section");
  assert.equal(topLevel.settings?.converter_v3_section_preset_layout, "social-proof-narrative");
  assert.equal(topLevel.settings?.converter_v3_section_signature, "intro-main");
  assert.equal(
    topLevel.settings?.converter_v3_section_slot_signature,
    "social-proof-intro-social-proof-grid"
  );
  assert.deepEqual(topLevel.settings?.converter_v3_section_phases, ["intro", "main"]);
  assert.deepEqual(topLevel.settings?.converter_v3_section_slots, [
    "social-proof-intro",
    "social-proof-grid"
  ]);
  assert.equal(sectionChildren[0]?.settings?.converter_v3_section_role, "section-header");
  assert.equal(sectionChildren[0]?.settings?.converter_v3_section_slot, "social-proof-intro");
  assert.equal(
    sectionChildren[0]?.settings?.converter_v3_section_preset_layout,
    "social-proof-intro"
  );
  assert.equal(sectionChildren[0]?.settings?.converter_v3_section_block_preset, "section-intro-stack");
  assert.equal(sectionChildren[0]?.settings?.converter_v3_section_block_micro_layout, "intro-stack");
  assert.equal(sectionChildren[0]?.settings?.width, "100%");
  assert.equal(sectionChildren[0]?.settings?.max_width, "720px");
  assert.equal(sectionChildren[0]?.settings?.content_width, "boxed");
  assert.equal(sectionChildren[0]?.settings?.boxed_width, "720px");
  assert.equal(sectionChildren[0]?.settings?.flex_direction, "column");
  assert.equal(sectionChildren[0]?.settings?.align_items, "center");
  assert.equal(sectionChildren[0]?.settings?.gap, "16px");
  assert.equal(sectionChildren[0]?.settings?.mobile_flex_direction, "column");
  assert.equal(sectionChildren[1]?.settings?.max_width, "1040px");
  assert.equal(sectionChildren[1]?.settings?.converter_v3_section_slot, "social-proof-grid");
  assert.equal(sectionChildren[1]?.settings?.content_width, "boxed");
  assert.equal(sectionChildren[1]?.settings?.boxed_width, "1040px");
  assert.equal(
    sectionChildren[1]?.settings?.converter_v3_layout?.sectionPresetLayout,
    "social-proof-grid"
  );
  assert.equal(sectionChildren[1]?.settings?.converter_v3_layout?.preset, "testimonial-cards");
  assert.deepEqual(
    (sectionChildren[0]?.elements ?? []).map(
      (child) => child.settings?.converter_v3_widget_semantic
    ),
    [
      "section-intro-eyebrow",
      "section-intro-title",
      "section-intro-support"
    ]
  );
  assert.ok(
    (sectionChildren[0]?.elements ?? []).every(
      (child) =>
        child.settings?.converter_v3_section_block_micro_layout === "intro-stack" &&
        child.settings?.align === "center"
    )
  );
}

async function testV3EditableComposesFeatureSectionOutroBlock() {
  const html = `<!doctype html>
<html>
  <head>
    <title>Editable Feature Section Outro</title>
  </head>
  <body>
    <section style="padding:24px;background:#fffaf7;">
      <div>
        <p>Designed for you</p>
        <h2>One scoop. Three transformations.</h2>
        <p>Support for skin, joints, and daily vitality.</p>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3, minmax(0, 1fr));gap:24px;">
        <article>
          <img src="https://example.com/feature-1.jpg" alt="Feature 1" />
          <p>Radiant skin</p>
          <h3>Visibly firmer, smoother skin</h3>
          <p>Daily collagen support for healthy-looking skin.</p>
          <a href="#skin">Learn more</a>
        </article>
        <article>
          <img src="https://example.com/feature-2.jpg" alt="Feature 2" />
          <p>Active health</p>
          <h3>Move with ease, every day</h3>
          <p>Support for cartilage, joint comfort and flexibility.</p>
          <a href="#mobility">Learn more</a>
        </article>
        <article>
          <img src="https://example.com/feature-3.jpg" alt="Feature 3" />
          <p>Premium ingredients</p>
          <h3>5 types. 4 sources. Zero compromise.</h3>
          <p>Collagen designed to dissolve perfectly in hot or cold drinks.</p>
          <a href="#ingredients">Learn more</a>
        </article>
      </div>
      <div>
        <h3>Ready to feel the difference?</h3>
        <p>Build a simple daily routine that supports skin, joints, and recovery.</p>
        <a href="#shop">Shop now</a>
      </div>
    </section>
  </body>
</html>`;
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const captureResult = await runCapturePipelineV3FromHtml(html, {
    preferBrowser: false,
    outputRoot
  });
  const editableDocument = createEditableElementorDocumentV3({
    capture: captureResult.capture,
    layout: captureResult.layout,
    selectedMode: "editable"
  }).document as {
    content: Array<{
      settings?: {
        converter_v3_section_preset?: string;
        converter_v3_section_preset_layout?: string;
        converter_v3_section_signature?: string;
        converter_v3_section_phases?: string[];
        converter_v3_section_slots?: string[];
        converter_v3_section_slot_signature?: string;
        converter_v3_section_regions?: string[];
        converter_v3_section_region_signature?: string;
        converter_v3_section_strategy?: string;
        converter_v3_section_strategy_profile?: {
          name?: string;
          layoutModel?: string;
          rootGap?: string;
        };
        converter_v3_layout?: {
          sectionComposition?: string;
          sectionPreset?: string;
          sectionPresetLayout?: string;
          sectionSignature?: string;
          sectionPhases?: string[];
          sectionSlots?: string[];
          sectionSlotSignature?: string;
          sectionRegions?: string[];
          sectionRegionSignature?: string;
          sectionStrategy?: string;
          sectionStrategyProfile?: {
            name?: string;
            layoutModel?: string;
            rootGap?: string;
          };
        };
      };
      elements?: Array<{
        settings?: {
          converter_v3_section_role?: string;
          converter_v3_section_phase?: string;
          converter_v3_section_slot?: string;
          converter_v3_section_region?: string;
          converter_v3_section_region_mode?: string;
          converter_v3_section_strategy?: string;
          converter_v3_section_block?: string;
          converter_v3_section_block_preset?: string;
          converter_v3_section_preset_layout?: string;
          converter_v3_section_block_micro_layout?: string;
          width?: string;
          max_width?: string;
          content_width?: string;
          boxed_width?: string;
          align_self?: string;
          flex_direction?: string;
          align_items?: string;
          gap?: string;
          mobile_flex_direction?: string;
          converter_v3_layout?: {
            preset?: string;
            sectionPhase?: string;
            sectionBlockPreset?: string;
            sectionPreset?: string;
            sectionPresetLayout?: string;
            sectionSignature?: string;
            sectionPhases?: string[];
          };
        };
        elements?: Array<{
          settings?: {
            converter_v3_widget_semantic?: string;
            converter_v3_section_block_micro_layout?: string;
            align?: string;
            width?: string;
            tablet_width?: string;
            mobile_width?: string;
          };
        }>;
      }>;
    }>;
  };

  const topLevel = editableDocument.content[0];
  const sectionChildren = topLevel.elements ?? [];
  const outro = sectionChildren[2];

  assert.equal(topLevel.settings?.converter_v3_layout?.sectionComposition, "feature-section");
  assert.equal(topLevel.settings?.converter_v3_section_preset, "benefits-showcase-section");
  assert.equal(topLevel.settings?.converter_v3_section_strategy, "benefits-showcase");
  assert.equal(
    topLevel.settings?.converter_v3_section_strategy_profile?.layoutModel,
    "stacked-benefits"
  );
  assert.equal(topLevel.settings?.converter_v3_section_preset_layout, "benefits-narrative");
  assert.equal(topLevel.settings?.converter_v3_section_signature, "intro-main-outro");
  assert.equal(
    topLevel.settings?.converter_v3_section_slot_signature,
    "benefits-intro-benefits-grid-benefits-outro"
  );
  assert.equal(
    topLevel.settings?.converter_v3_section_region_signature,
    "intro-main-closing"
  );
  assert.deepEqual(topLevel.settings?.converter_v3_section_phases, [
    "intro",
    "main",
    "outro"
  ]);
  assert.deepEqual(topLevel.settings?.converter_v3_section_slots, [
    "benefits-intro",
    "benefits-grid",
    "benefits-outro"
  ]);
  assert.deepEqual(topLevel.settings?.converter_v3_section_regions, [
    "intro",
    "main",
    "closing"
  ]);
  assert.equal(topLevel.settings?.converter_v3_layout?.sectionStrategy, "benefits-showcase");
  assert.equal(
    topLevel.settings?.converter_v3_layout?.sectionStrategyProfile?.layoutModel,
    "stacked-benefits"
  );
  assert.equal(
    topLevel.settings?.converter_v3_layout?.sectionPreset,
    "benefits-showcase-section"
  );
  assert.equal(
    topLevel.settings?.converter_v3_layout?.sectionPresetLayout,
    "benefits-narrative"
  );
  assert.equal(
    topLevel.settings?.converter_v3_layout?.sectionSignature,
    "intro-main-outro"
  );
  assert.deepEqual(topLevel.settings?.converter_v3_layout?.sectionPhases, [
    "intro",
    "main",
    "outro"
  ]);
  assert.equal(outro?.settings?.converter_v3_section_role, "section-cta");
  assert.equal(outro?.settings?.converter_v3_section_phase, "outro");
  assert.equal(outro?.settings?.converter_v3_section_slot, "benefits-outro");
  assert.equal(outro?.settings?.converter_v3_section_region, "closing");
  assert.equal(outro?.settings?.converter_v3_section_region_mode, "boxed-centered");
  assert.equal(outro?.settings?.align_self, "center");
  assert.equal(outro?.settings?.converter_v3_section_preset_layout, "benefits-outro");
  assert.equal(outro?.settings?.converter_v3_section_block, "closing-stack");
  assert.equal(outro?.settings?.converter_v3_section_block_preset, "section-outro-stack");
  assert.equal(outro?.settings?.converter_v3_section_block_micro_layout, "outro-stack");
  assert.equal(outro?.settings?.width, "100%");
  assert.equal(outro?.settings?.max_width, "720px");
  assert.equal(outro?.settings?.content_width, "boxed");
  assert.equal(outro?.settings?.boxed_width, "720px");
  assert.equal(outro?.settings?.flex_direction, "column");
  assert.equal(outro?.settings?.align_items, "center");
  assert.equal(outro?.settings?.gap, "12px");
  assert.equal(outro?.settings?.mobile_flex_direction, "column");
  assert.equal(outro?.settings?.converter_v3_layout?.sectionBlockPreset, "section-outro-stack");
  assert.equal(outro?.settings?.converter_v3_layout?.sectionPhase, "outro");
  assert.equal(outro?.settings?.converter_v3_layout?.sectionPresetLayout, "benefits-outro");
  assert.deepEqual(
    (outro?.elements ?? []).map((child) => child.settings?.converter_v3_widget_semantic),
    [
      "section-outro-title",
      "section-outro-support",
      "section-outro-cta"
    ]
  );
  assert.equal(outro?.elements?.[2]?.settings?.width, "100%");
  assert.equal(outro?.elements?.[2]?.settings?.align, "center");
  assert.equal(outro?.elements?.[2]?.settings?.tablet_width, "100%");
  assert.equal(outro?.elements?.[2]?.settings?.mobile_width, "100%");
  assert.ok(
    (outro?.elements ?? []).every(
      (child) =>
        child.settings?.converter_v3_section_block_micro_layout === "outro-stack" &&
        child.settings?.align === "center"
    )
  );
}

async function testV3HybridComposesTestimonialSectionOutroBlock() {
  const html = `<!doctype html>
<html>
  <head>
    <title>Hybrid Testimonial Section Outro</title>
  </head>
  <body>
    <section style="padding:24px;background:#fffaf7;">
      <div>
        <p>Customer stories</p>
        <h2>Loved by thousands.</h2>
        <p>Real feedback from customers who made this part of their daily routine.</p>
      </div>
      <div style="display:grid;grid-template-columns:repeat(2, minmax(0, 1fr));gap:24px;">
        <article>
          <img src="https://example.com/review-1.jpg" alt="Reviewer 1" />
          <p>★★★★★</p>
          <p>This collagen has become part of my routine and I already notice the difference.</p>
          <h4>Lauren B.</h4>
        </article>
        <article>
          <img src="https://example.com/review-2.jpg" alt="Reviewer 2" />
          <p>★★★★★</p>
          <p>Supportive, easy to take, and actually pleasant to use every single day.</p>
          <h4>Maria S.</h4>
        </article>
      </div>
      <div>
        <h3>See why customers keep coming back.</h3>
        <p>Simple habits add up when the routine is easy to stick with.</p>
      </div>
    </section>
  </body>
</html>`;
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const result = await runExportPipelineV3FromHtml(html, {
    preferBrowser: false,
    outputRoot
  });

  assert.equal(result.analysis.selectedMode, "hybrid");
  assert.equal(result.emittedMode, "hybrid");

  const elementorTemplate = JSON.parse(
    await readFile(result.artifacts.elementorTemplatePath, "utf8")
  ) as {
    content: Array<{
      settings?: {
        converter_v3_section_preset?: string;
        converter_v3_section_preset_layout?: string;
        converter_v3_section_signature?: string;
        converter_v3_section_phases?: string[];
        converter_v3_section_slots?: string[];
        converter_v3_section_slot_signature?: string;
        converter_v3_section_regions?: string[];
        converter_v3_section_region_signature?: string;
        converter_v3_section_strategy?: string;
        converter_v3_section_strategy_profile?: {
          name?: string;
          layoutModel?: string;
          rootGap?: string;
        };
        converter_v3_layout?: {
          sectionComposition?: string;
          sectionPreset?: string;
          sectionPresetLayout?: string;
          sectionSignature?: string;
          sectionPhases?: string[];
          sectionSlots?: string[];
          sectionSlotSignature?: string;
          sectionRegions?: string[];
          sectionRegionSignature?: string;
          sectionStrategy?: string;
          sectionStrategyProfile?: {
            name?: string;
            layoutModel?: string;
            rootGap?: string;
          };
        };
      };
      elements?: Array<{
        settings?: {
          converter_v3_section_role?: string;
          converter_v3_section_phase?: string;
          converter_v3_section_slot?: string;
          converter_v3_section_region?: string;
          converter_v3_section_region_mode?: string;
          converter_v3_section_strategy?: string;
          converter_v3_section_block?: string;
          converter_v3_section_block_preset?: string;
          converter_v3_section_preset_layout?: string;
          converter_v3_section_block_micro_layout?: string;
          width?: string;
          max_width?: string;
          content_width?: string;
          boxed_width?: string;
          align_self?: string;
          flex_direction?: string;
          align_items?: string;
          gap?: string;
          mobile_flex_direction?: string;
          converter_v3_layout?: {
            preset?: string;
            sectionPhase?: string;
            sectionBlockPreset?: string;
            sectionPreset?: string;
            sectionPresetLayout?: string;
            sectionSignature?: string;
            sectionPhases?: string[];
          };
        };
        elements?: Array<{
          settings?: {
            converter_v3_widget_semantic?: string;
            converter_v3_section_block_micro_layout?: string;
            align?: string;
          };
        }>;
      }>;
    }>;
  };

  const topLevel = elementorTemplate.content[0];
  const sectionChildren = topLevel.elements ?? [];
  const outro = sectionChildren[2];

  assert.equal(topLevel.settings?.converter_v3_layout?.sectionComposition, "testimonial-section");
  assert.equal(topLevel.settings?.converter_v3_section_preset, "social-proof-section");
  assert.equal(topLevel.settings?.converter_v3_section_strategy, "social-proof");
  assert.equal(
    topLevel.settings?.converter_v3_section_strategy_profile?.layoutModel,
    "stacked-social-proof"
  );
  assert.equal(topLevel.settings?.converter_v3_section_preset_layout, "social-proof-narrative");
  assert.equal(topLevel.settings?.converter_v3_section_signature, "intro-main-outro");
  assert.equal(
    topLevel.settings?.converter_v3_section_slot_signature,
    "social-proof-intro-social-proof-grid-social-proof-outro"
  );
  assert.equal(
    topLevel.settings?.converter_v3_section_region_signature,
    "intro-main-closing"
  );
  assert.deepEqual(topLevel.settings?.converter_v3_section_phases, [
    "intro",
    "main",
    "outro"
  ]);
  assert.deepEqual(topLevel.settings?.converter_v3_section_slots, [
    "social-proof-intro",
    "social-proof-grid",
    "social-proof-outro"
  ]);
  assert.deepEqual(topLevel.settings?.converter_v3_section_regions, [
    "intro",
    "main",
    "closing"
  ]);
  assert.equal(topLevel.settings?.converter_v3_layout?.sectionStrategy, "social-proof");
  assert.equal(
    topLevel.settings?.converter_v3_layout?.sectionStrategyProfile?.layoutModel,
    "stacked-social-proof"
  );
  assert.equal(
    topLevel.settings?.converter_v3_layout?.sectionPreset,
    "social-proof-section"
  );
  assert.equal(
    topLevel.settings?.converter_v3_layout?.sectionPresetLayout,
    "social-proof-narrative"
  );
  assert.equal(
    topLevel.settings?.converter_v3_layout?.sectionSignature,
    "intro-main-outro"
  );
  assert.deepEqual(topLevel.settings?.converter_v3_layout?.sectionPhases, [
    "intro",
    "main",
    "outro"
  ]);
  assert.equal(outro?.settings?.converter_v3_section_role, "section-support");
  assert.equal(outro?.settings?.converter_v3_section_phase, "outro");
  assert.equal(outro?.settings?.converter_v3_section_slot, "social-proof-outro");
  assert.equal(outro?.settings?.converter_v3_section_region, "closing");
  assert.equal(outro?.settings?.converter_v3_section_region_mode, "boxed-centered");
  assert.equal(outro?.settings?.align_self, "center");
  assert.equal(outro?.settings?.converter_v3_section_preset_layout, "social-proof-outro");
  assert.equal(outro?.settings?.converter_v3_section_block, "closing-stack");
  assert.equal(outro?.settings?.converter_v3_section_block_preset, "section-outro-stack");
  assert.equal(outro?.settings?.converter_v3_section_block_micro_layout, "outro-stack");
  assert.equal(outro?.settings?.width, "100%");
  assert.equal(outro?.settings?.max_width, "680px");
  assert.equal(outro?.settings?.content_width, "boxed");
  assert.equal(outro?.settings?.boxed_width, "680px");
  assert.equal(outro?.settings?.flex_direction, "column");
  assert.equal(outro?.settings?.align_items, "center");
  assert.equal(outro?.settings?.gap, "12px");
  assert.equal(outro?.settings?.mobile_flex_direction, "column");
  assert.equal(outro?.settings?.converter_v3_layout?.sectionBlockPreset, "section-outro-stack");
  assert.equal(outro?.settings?.converter_v3_layout?.sectionPhase, "outro");
  assert.equal(
    outro?.settings?.converter_v3_layout?.sectionPresetLayout,
    "social-proof-outro"
  );
  assert.deepEqual(
    (outro?.elements ?? []).map((child) => child.settings?.converter_v3_widget_semantic),
    [
      "section-outro-title",
      "section-outro-support"
    ]
  );
  assert.ok(
    (outro?.elements ?? []).every(
      (child) =>
        child.settings?.converter_v3_section_block_micro_layout === "outro-stack" &&
        child.settings?.align === "center"
    )
  );
}

async function testV3EditableFallsBackToHybridOnUnsupportedBlock() {
  const html = `<!doctype html>
<html>
  <head>
    <title>Editable With Table</title>
  </head>
  <body>
    <section style="padding:24px;">
      <h2>Simple section</h2>
      <p>This layout is mostly editable.</p>
      <table>
        <tr><td>Cell A</td><td>Cell B</td></tr>
      </table>
    </section>
  </body>
</html>`;
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const result = await runExportPipelineV3FromHtml(html, {
    preferBrowser: false,
    outputRoot
  });

  assert.equal(result.analysis.selectedMode, "editable");
  assert.equal(result.emittedMode, "hybrid");
  assert.match(result.fallbackReason ?? "", /exportando em hybrid/);
  assert.ok(result.report.warnings.length >= 1);
}

function testResponsiveChildSettingsHelper() {
  const parent: LayoutNode = {
    id: "parent",
    kind: "container",
    parentId: null,
    children: ["child-a", "child-b"],
    box: { x: 0, y: 0, width: 600, height: 220 },
    visualOrder: 1,
    layout: {
      display: "flex",
      flexDirection: "row",
      gap: "24px"
    },
    spacing: {},
    style: {},
    content: {},
    flags: {},
    responsive: {
      desktop: {
        isVisible: true,
        box: { x: 0, y: 0, width: 600, height: 220 },
        layout: { display: "flex", flexDirection: "row", gap: "24px" },
        spacing: {},
        style: {}
      },
      tablet: {
        isVisible: true,
        box: { x: 0, y: 0, width: 500, height: 240 },
        layout: { display: "flex", flexDirection: "row", gap: "20px" },
        spacing: {},
        style: {}
      },
      mobile: {
        isVisible: true,
        box: { x: 0, y: 0, width: 320, height: 420 },
        layout: { display: "flex", flexDirection: "column", gap: "16px" },
        spacing: {},
        style: {}
      }
    }
  };
  const childA: LayoutNode = {
    id: "child-a",
    kind: "container",
    parentId: "parent",
    children: [],
    box: { x: 0, y: 0, width: 288, height: 180 },
    visualOrder: 2,
    layout: {},
    spacing: {},
    style: {},
    content: {},
    flags: {},
    responsive: {
      desktop: {
        isVisible: true,
        box: { x: 0, y: 0, width: 288, height: 180 },
        layout: {},
        spacing: {},
        style: {}
      },
      tablet: {
        isVisible: true,
        box: { x: 0, y: 0, width: 240, height: 180 },
        layout: {},
        spacing: {},
        style: {}
      },
      mobile: {
        isVisible: true,
        box: { x: 0, y: 0, width: 320, height: 180 },
        layout: {},
        spacing: {},
        style: {}
      }
    }
  };
  const childB: LayoutNode = {
    id: "child-b",
    kind: "container",
    parentId: "parent",
    children: [],
    box: { x: 312, y: 0, width: 288, height: 180 },
    visualOrder: 3,
    layout: {},
    spacing: {},
    style: {},
    content: {},
    flags: {},
    responsive: {
      desktop: {
        isVisible: true,
        box: { x: 312, y: 0, width: 288, height: 180 },
        layout: {},
        spacing: {},
        style: {}
      },
      tablet: {
        isVisible: true,
        box: { x: 260, y: 0, width: 240, height: 180 },
        layout: {},
        spacing: {},
        style: {}
      },
      mobile: {
        isVisible: true,
        box: { x: 0, y: 200, width: 320, height: 180 },
        layout: {},
        spacing: {},
        style: {}
      }
    }
  };
  const layoutById = new Map<string, LayoutNode>([
    [parent.id, parent],
    [childA.id, childA],
    [childB.id, childB]
  ]);

  const parentResponsive = createElementorResponsiveSettings(parent, layoutById);
  const childResponsive = createResponsiveChildSettings(parent, "child-a", layoutById);

  assert.equal(parentResponsive.mobile_flex_direction, "column");
  assert.equal(parentResponsive.tablet_flex_direction, "row");
  assert.equal(childResponsive.width, "48%");
  assert.equal(childResponsive.tablet_width, "48%");
  assert.equal(childResponsive.mobile_width, "100%");
}

function testResponsiveGridColumnReductionHelper() {
  const parent: LayoutNode = {
    id: "grid-parent",
    kind: "container",
    parentId: null,
    children: ["grid-a", "grid-b", "grid-c", "grid-d"],
    box: { x: 0, y: 0, width: 1200, height: 640 },
    visualOrder: 1,
    layout: {
      display: "grid",
      gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
      gap: "24px"
    },
    spacing: {},
    style: {},
    content: {},
    flags: {},
    responsive: {
      desktop: {
        isVisible: true,
        box: { x: 0, y: 0, width: 1200, height: 320 },
        layout: {
          display: "grid",
          gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
          gap: "24px"
        },
        spacing: {},
        style: {}
      },
      tablet: {
        isVisible: true,
        box: { x: 0, y: 0, width: 800, height: 640 },
        layout: {
          display: "grid",
          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
          gap: "20px"
        },
        spacing: {},
        style: {}
      },
      mobile: {
        isVisible: true,
        box: { x: 0, y: 0, width: 400, height: 1280 },
        layout: {
          display: "grid",
          gridTemplateColumns: "1fr",
          gap: "16px"
        },
        spacing: {},
        style: {}
      }
    }
  };

  function createGridChild(
    id: string,
    visualOrder: number,
    desktopBox: { x: number; y: number; width: number; height: number },
    tabletBox: { x: number; y: number; width: number; height: number },
    mobileBox: { x: number; y: number; width: number; height: number }
  ): LayoutNode {
    return {
      id,
      kind: "container",
      parentId: parent.id,
      children: [],
      box: desktopBox,
      visualOrder,
      layout: {},
      spacing: {},
      style: {},
      content: {},
      flags: {},
      responsive: {
        desktop: {
          isVisible: true,
          box: desktopBox,
          layout: {},
          spacing: {},
          style: {}
        },
        tablet: {
          isVisible: true,
          box: tabletBox,
          layout: {},
          spacing: {},
          style: {}
        },
        mobile: {
          isVisible: true,
          box: mobileBox,
          layout: {},
          spacing: {},
          style: {}
        }
      }
    };
  }

  const childA = createGridChild(
    "grid-a",
    2,
    { x: 0, y: 0, width: 300, height: 280 },
    { x: 0, y: 0, width: 400, height: 280 },
    { x: 0, y: 0, width: 400, height: 280 }
  );
  const childB = createGridChild(
    "grid-b",
    3,
    { x: 300, y: 0, width: 300, height: 280 },
    { x: 400, y: 0, width: 400, height: 280 },
    { x: 0, y: 320, width: 400, height: 280 }
  );
  const childC = createGridChild(
    "grid-c",
    4,
    { x: 600, y: 0, width: 300, height: 280 },
    { x: 0, y: 320, width: 400, height: 280 },
    { x: 0, y: 640, width: 400, height: 280 }
  );
  const childD = createGridChild(
    "grid-d",
    5,
    { x: 900, y: 0, width: 300, height: 280 },
    { x: 400, y: 320, width: 400, height: 280 },
    { x: 0, y: 960, width: 400, height: 280 }
  );

  const layoutById = new Map<string, LayoutNode>([
    [parent.id, parent],
    [childA.id, childA],
    [childB.id, childB],
    [childC.id, childC],
    [childD.id, childD]
  ]);

  const desktopLayout = deriveContainerLayout(parent, layoutById, "desktop");
  const tabletLayout = deriveContainerLayout(parent, layoutById, "tablet");
  const mobileLayout = deriveContainerLayout(parent, layoutById, "mobile");
  const parentResponsive = createElementorResponsiveSettings(parent, layoutById);
  const childResponsive = createResponsiveChildSettings(parent, "grid-a", layoutById);

  assert.equal(desktopLayout.columnCount, 4);
  assert.equal(tabletLayout.columnCount, 2);
  assert.equal(mobileLayout.columnCount, 1);
  assert.equal(desktopLayout.rowCount, 1);
  assert.equal(tabletLayout.rowCount, 2);
  assert.equal(mobileLayout.rowCount, 4);
  assert.equal(tabletLayout.flexDirection, "row");
  assert.equal(mobileLayout.flexDirection, "column");
  assert.equal(parentResponsive.columns, 4);
  assert.equal(parentResponsive.tablet_columns, 2);
  assert.equal(parentResponsive.mobile_columns, 1);
  assert.equal(parentResponsive.mobile_stacked, true);
  assert.equal(parentResponsive.pattern, "card-grid");
  assert.equal(parentResponsive.tablet_pattern, "card-grid");
  assert.equal(parentResponsive.mobile_pattern, "stack");
  assert.equal(childResponsive.width, "25%");
  assert.equal(childResponsive.tablet_width, "50%");
  assert.equal(childResponsive.mobile_width, "100%");
}

function testResponsiveSplitPatternHelper() {
  const parent: LayoutNode = {
    id: "split-parent",
    kind: "section",
    parentId: null,
    children: ["text-block", "media-block"],
    box: { x: 0, y: 0, width: 1000, height: 480 },
    visualOrder: 1,
    layout: {
      display: "flex",
      flexDirection: "row",
      gap: "32px"
    },
    spacing: {},
    style: {},
    content: {},
    flags: {},
    responsive: {
      desktop: {
        isVisible: true,
        box: { x: 0, y: 0, width: 1000, height: 480 },
        layout: { display: "flex", flexDirection: "row", gap: "32px" },
        spacing: {},
        style: {}
      },
      tablet: {
        isVisible: true,
        box: { x: 0, y: 0, width: 800, height: 440 },
        layout: { display: "flex", flexDirection: "row", gap: "24px" },
        spacing: {},
        style: {}
      },
      mobile: {
        isVisible: true,
        box: { x: 0, y: 0, width: 360, height: 760 },
        layout: { display: "flex", flexDirection: "column", gap: "20px" },
        spacing: {},
        style: {}
      }
    }
  };
  const textBlock: LayoutNode = {
    id: "text-block",
    kind: "container",
    parentId: parent.id,
    children: ["heading-node", "body-node", "cta-node"],
    box: { x: 0, y: 0, width: 480, height: 320 },
    visualOrder: 2,
    layout: {},
    spacing: {},
    style: {},
    content: {},
    flags: {},
    responsive: {
      desktop: {
        isVisible: true,
        box: { x: 0, y: 0, width: 480, height: 320 },
        layout: {},
        spacing: {},
        style: {}
      },
      tablet: {
        isVisible: true,
        box: { x: 0, y: 0, width: 388, height: 300 },
        layout: {},
        spacing: {},
        style: {}
      },
      mobile: {
        isVisible: true,
        box: { x: 0, y: 0, width: 360, height: 240 },
        layout: {},
        spacing: {},
        style: {}
      }
    }
  };
  const mediaBlock: LayoutNode = {
    id: "media-block",
    kind: "container",
    parentId: parent.id,
    children: ["image-node"],
    box: { x: 520, y: 0, width: 480, height: 320 },
    visualOrder: 3,
    layout: {},
    spacing: {},
    style: {},
    content: {},
    flags: {},
    responsive: {
      desktop: {
        isVisible: true,
        box: { x: 520, y: 0, width: 480, height: 320 },
        layout: {},
        spacing: {},
        style: {}
      },
      tablet: {
        isVisible: true,
        box: { x: 412, y: 0, width: 388, height: 300 },
        layout: {},
        spacing: {},
        style: {}
      },
      mobile: {
        isVisible: true,
        box: { x: 0, y: 260, width: 360, height: 320 },
        layout: {},
        spacing: {},
        style: {}
      }
    }
  };
  const headingNode: LayoutNode = {
    id: "heading-node",
    kind: "text",
    parentId: textBlock.id,
    children: [],
    box: { x: 0, y: 0, width: 420, height: 48 },
    visualOrder: 4,
    layout: {},
    spacing: {},
    style: {},
    content: { text: "Hero heading" },
    flags: {},
    responsive: {}
  };
  const bodyNode: LayoutNode = {
    id: "body-node",
    kind: "text",
    parentId: textBlock.id,
    children: [],
    box: { x: 0, y: 64, width: 420, height: 96 },
    visualOrder: 5,
    layout: {},
    spacing: {},
    style: {},
    content: { text: "Supporting copy" },
    flags: {},
    responsive: {}
  };
  const ctaNode: LayoutNode = {
    id: "cta-node",
    kind: "button",
    parentId: textBlock.id,
    children: [],
    box: { x: 0, y: 176, width: 160, height: 48 },
    visualOrder: 6,
    layout: {},
    spacing: {},
    style: {},
    content: { text: "Buy now", href: "#buy" },
    flags: {},
    responsive: {}
  };
  const imageNode: LayoutNode = {
    id: "image-node",
    kind: "image",
    parentId: mediaBlock.id,
    children: [],
    box: { x: 520, y: 0, width: 480, height: 320 },
    visualOrder: 7,
    layout: {},
    spacing: {},
    style: {},
    content: { src: "https://example.com/image.jpg", alt: "Product" },
    flags: {},
    responsive: {}
  };

  const layoutById = new Map<string, LayoutNode>([
    [parent.id, parent],
    [textBlock.id, textBlock],
    [mediaBlock.id, mediaBlock],
    [headingNode.id, headingNode],
    [bodyNode.id, bodyNode],
    [ctaNode.id, ctaNode],
    [imageNode.id, imageNode]
  ]);

  const parentResponsive = createElementorResponsiveSettings(parent, layoutById);

  assert.equal(parentResponsive.pattern, "text-image-split");
  assert.equal(parentResponsive.tablet_pattern, "text-image-split");
  assert.equal(parentResponsive.mobile_pattern, "stack");
  assert.equal(parentResponsive.tablet_columns, 2);
  assert.equal(parentResponsive.mobile_columns, 1);
}

function testPatternOrderedChildIdsHelper() {
  const parent: LayoutNode = {
    id: "ordered-parent",
    kind: "section",
    parentId: null,
    children: ["media-block", "content-block"],
    box: { x: 0, y: 0, width: 1000, height: 420 },
    visualOrder: 1,
    layout: { display: "flex", flexDirection: "row", gap: "32px" },
    spacing: {},
    style: {},
    content: {},
    flags: {},
    responsive: {
      desktop: {
        isVisible: true,
        box: { x: 0, y: 0, width: 1000, height: 420 },
        layout: { display: "flex", flexDirection: "row", gap: "32px" },
        spacing: {},
        style: {}
      }
    }
  };
  const mediaBlock: LayoutNode = {
    id: "media-block",
    kind: "container",
    parentId: parent.id,
    children: ["image-node"],
    box: { x: 560, y: 0, width: 440, height: 320 },
    visualOrder: 2,
    layout: {},
    spacing: {},
    style: {},
    content: {},
    flags: {},
    responsive: {
      desktop: {
        isVisible: true,
        box: { x: 560, y: 0, width: 440, height: 320 },
        layout: {},
        spacing: {},
        style: {}
      }
    }
  };
  const contentBlock: LayoutNode = {
    id: "content-block",
    kind: "container",
    parentId: parent.id,
    children: ["heading-node", "text-node"],
    box: { x: 0, y: 0, width: 500, height: 320 },
    visualOrder: 3,
    layout: {},
    spacing: {},
    style: {},
    content: {},
    flags: {},
    responsive: {
      desktop: {
        isVisible: true,
        box: { x: 0, y: 0, width: 500, height: 320 },
        layout: {},
        spacing: {},
        style: {}
      }
    }
  };
  const imageNode: LayoutNode = {
    id: "image-node",
    kind: "image",
    parentId: mediaBlock.id,
    children: [],
    box: { x: 560, y: 0, width: 440, height: 320 },
    visualOrder: 4,
    layout: {},
    spacing: {},
    style: {},
    content: { src: "https://example.com/product.jpg" },
    flags: {},
    responsive: {}
  };
  const headingNode: LayoutNode = {
    id: "heading-node",
    kind: "text",
    parentId: contentBlock.id,
    children: [],
    box: { x: 0, y: 0, width: 440, height: 60 },
    visualOrder: 5,
    layout: {},
    spacing: {},
    style: {},
    content: { text: "Heading" },
    flags: {},
    responsive: {}
  };
  const textNode: LayoutNode = {
    id: "text-node",
    kind: "text",
    parentId: contentBlock.id,
    children: [],
    box: { x: 0, y: 80, width: 440, height: 120 },
    visualOrder: 6,
    layout: {},
    spacing: {},
    style: {},
    content: { text: "Body" },
    flags: {},
    responsive: {}
  };

  const layoutById = new Map<string, LayoutNode>([
    [parent.id, parent],
    [mediaBlock.id, mediaBlock],
    [contentBlock.id, contentBlock],
    [imageNode.id, imageNode],
    [headingNode.id, headingNode],
    [textNode.id, textNode]
  ]);

  const ordered = getOrderedChildIdsForPattern(parent, layoutById, "desktop");

  assert.deepEqual(ordered, ["content-block", "media-block"]);
}

function testResponsivePresetDetectionHelper() {
  const parent: LayoutNode = {
    id: "preset-parent",
    kind: "section",
    parentId: null,
    children: ["price-a", "price-b", "price-c"],
    box: { x: 0, y: 0, width: 1200, height: 420 },
    visualOrder: 1,
    layout: {
      display: "grid",
      gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
      gap: "24px"
    },
    spacing: {},
    style: {},
    content: {},
    flags: {},
    responsive: {
      desktop: {
        isVisible: true,
        box: { x: 0, y: 0, width: 1200, height: 420 },
        layout: {
          display: "grid",
          gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
          gap: "24px"
        },
        spacing: {},
        style: {}
      }
    }
  };

  function createPricingCard(
    id: string,
    visualOrder: number,
    x: number,
    title: string,
    price: string
  ): LayoutNode[] {
    const card: LayoutNode = {
      id,
      kind: "container",
      parentId: parent.id,
      children: [`${id}-title`, `${id}-price`, `${id}-cta`],
      box: { x, y: 0, width: 384, height: 320 },
      visualOrder,
      layout: {},
      spacing: {},
      style: {},
      content: {},
      flags: {},
      responsive: {
        desktop: {
          isVisible: true,
          box: { x, y: 0, width: 384, height: 320 },
          layout: {},
          spacing: {},
          style: {}
        }
      }
    };
    const titleNode: LayoutNode = {
      id: `${id}-title`,
      kind: "text",
      parentId: id,
      children: [],
      box: { x, y: 0, width: 200, height: 32 },
      visualOrder: visualOrder + 10,
      layout: {},
      spacing: {},
      style: {},
      content: { text: title },
      flags: {},
      responsive: {}
    };
    const priceNode: LayoutNode = {
      id: `${id}-price`,
      kind: "text",
      parentId: id,
      children: [],
      box: { x, y: 40, width: 180, height: 32 },
      visualOrder: visualOrder + 11,
      layout: {},
      spacing: {},
      style: {},
      content: { text: price },
      flags: {},
      responsive: {}
    };
    const ctaNode: LayoutNode = {
      id: `${id}-cta`,
      kind: "button",
      parentId: id,
      children: [],
      box: { x, y: 96, width: 160, height: 44 },
      visualOrder: visualOrder + 12,
      layout: {},
      spacing: {},
      style: {},
      content: { text: "Add to cart", href: "#buy" },
      flags: {},
      responsive: {}
    };

    return [card, titleNode, priceNode, ctaNode];
  }

  const nodes = [
    parent,
    ...createPricingCard("price-a", 2, 0, "1 Jar", "$49.95"),
    ...createPricingCard("price-b", 3, 408, "3 Jars", "$44.95"),
    ...createPricingCard("price-c", 4, 816, "6 Jars", "$41.50")
  ];
  const layoutById = new Map(nodes.map((node) => [node.id, node]));

  assert.equal(detectContainerPreset(parent, layoutById, "desktop"), "pricing-cards");
}

async function testV3NativeExportPreservesBackgroundImages() {
  const html = `<!doctype html>
<html>
  <head>
    <title>Background Section</title>
  </head>
  <body>
    <section style="padding:48px;background-image:url('https://example.com/hero-bg.jpg');background-size:cover;background-position:center center;">
      <h1>Background Hero</h1>
      <p>Hero copy that should stay editable.</p>
      <a href="#buy">Buy now</a>
    </section>
  </body>
</html>`;
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const result = await runExportPipelineV3FromHtml(html, {
    preferBrowser: false,
    outputRoot
  });
  const elementorTemplate = JSON.parse(
    await readFile(result.artifacts.elementorTemplatePath, "utf8")
  ) as {
    content: Array<{
      settings?: {
        background_image?: { url?: string };
        background_size?: string;
        background_position?: string;
      };
    }>;
  };

  assert.equal(result.validation.passed, true);
  assert.equal(
    elementorTemplate.content[0].settings?.background_image?.url,
    "https://example.com/hero-bg.jpg"
  );
  assert.equal(elementorTemplate.content[0].settings?.background_size, "cover");
  assert.equal(elementorTemplate.content[0].settings?.background_position, "center center");
}

function testSectionClassifierDetectsSemanticSections() {
  const layout: LayoutDocument = {
    id: "semantic-layout",
    title: "Semantic Layout",
    sourceKind: "raw-html",
    rootNodeId: "page",
    nodeCount: 15,
    sectionIds: ["header", "hero", "grid", "footer"],
    semanticIndex: {},
    detectedSections: [],
    nodes: [
      {
        id: "page",
        tag: "body",
        kind: "page",
        parentId: null,
        children: ["header", "hero", "grid", "footer"],
        box: { x: 0, y: 0, width: 1200, height: 1200 },
        visualOrder: 1,
        layout: {},
        spacing: {},
        style: {},
        content: {},
        flags: {},
        responsive: {}
      },
      {
        id: "header",
        tag: "header",
        kind: "section",
        parentId: "page",
        children: ["header-link"],
        box: { x: 0, y: 0, width: 1200, height: 80 },
        visualOrder: 2,
        layout: { display: "flex" },
        spacing: {},
        style: { backgroundColor: "#ffffff" },
        content: {},
        flags: {},
        responsive: {}
      },
      {
        id: "header-link",
        tag: "a",
        kind: "button",
        parentId: "header",
        children: [],
        box: { x: 920, y: 20, width: 160, height: 40 },
        visualOrder: 3,
        layout: {},
        spacing: {},
        style: {},
        content: { text: "Shop", href: "#shop" },
        flags: {},
        responsive: {}
      },
      {
        id: "hero",
        tag: "section",
        kind: "section",
        parentId: "page",
        children: ["hero-heading", "hero-image", "hero-cta"],
        box: { x: 0, y: 120, width: 1200, height: 420 },
        visualOrder: 4,
        layout: { display: "flex" },
        spacing: {},
        style: { backgroundColor: "#f8efe8" },
        content: {},
        flags: {},
        responsive: {}
      },
      {
        id: "hero-heading",
        tag: "h1",
        kind: "text",
        parentId: "hero",
        children: [],
        box: { x: 80, y: 180, width: 420, height: 72 },
        visualOrder: 5,
        layout: {},
        spacing: {},
        style: { fontSize: "56px" },
        content: { text: "Hero title" },
        flags: {},
        responsive: {}
      },
      {
        id: "hero-image",
        tag: "img",
        kind: "image",
        parentId: "hero",
        children: [],
        box: { x: 680, y: 160, width: 360, height: 260 },
        visualOrder: 6,
        layout: {},
        spacing: {},
        style: {},
        content: { src: "https://example.com/hero.png", alt: "Hero" },
        flags: {},
        responsive: {}
      },
      {
        id: "hero-cta",
        tag: "a",
        kind: "button",
        parentId: "hero",
        children: [],
        box: { x: 80, y: 300, width: 180, height: 48 },
        visualOrder: 7,
        layout: {},
        spacing: {},
        style: {},
        content: { text: "Get started", href: "#start" },
        flags: {},
        responsive: {}
      },
      {
        id: "grid",
        tag: "section",
        kind: "section",
        parentId: "page",
        children: ["card-a", "card-b"],
        box: { x: 0, y: 580, width: 1200, height: 320 },
        visualOrder: 8,
        layout: {
          display: "grid",
          gridTemplateColumns: "repeat(2, minmax(0, 1fr))"
        },
        spacing: {},
        style: {},
        content: {},
        flags: {},
        responsive: {}
      },
      {
        id: "card-a",
        tag: "article",
        kind: "container",
        parentId: "grid",
        children: ["card-a-title", "card-a-cta"],
        box: { x: 80, y: 620, width: 480, height: 220 },
        visualOrder: 9,
        layout: {},
        spacing: {},
        style: { backgroundColor: "#fff", borderRadius: "24px", boxShadow: "0 10px 30px rgba(0,0,0,0.08)" },
        content: {},
        flags: {},
        responsive: {}
      },
      {
        id: "card-a-title",
        tag: "h3",
        kind: "text",
        parentId: "card-a",
        children: [],
        box: { x: 120, y: 660, width: 220, height: 32 },
        visualOrder: 10,
        layout: {},
        spacing: {},
        style: {},
        content: { text: "Card A" },
        flags: {},
        responsive: {}
      },
      {
        id: "card-a-cta",
        tag: "a",
        kind: "button",
        parentId: "card-a",
        children: [],
        box: { x: 120, y: 720, width: 160, height: 40 },
        visualOrder: 11,
        layout: {},
        spacing: {},
        style: {},
        content: { text: "Shop A", href: "#a" },
        flags: {},
        responsive: {}
      },
      {
        id: "card-b",
        tag: "article",
        kind: "container",
        parentId: "grid",
        children: ["card-b-title"],
        box: { x: 640, y: 620, width: 480, height: 220 },
        visualOrder: 12,
        layout: {},
        spacing: {},
        style: { backgroundColor: "#fff", borderRadius: "24px", boxShadow: "0 10px 30px rgba(0,0,0,0.08)" },
        content: {},
        flags: {},
        responsive: {}
      },
      {
        id: "card-b-title",
        tag: "h3",
        kind: "text",
        parentId: "card-b",
        children: [],
        box: { x: 680, y: 660, width: 220, height: 32 },
        visualOrder: 13,
        layout: {},
        spacing: {},
        style: {},
        content: { text: "Card B" },
        flags: {},
        responsive: {}
      },
      {
        id: "footer",
        tag: "footer",
        kind: "section",
        parentId: "page",
        children: ["footer-link"],
        box: { x: 0, y: 980, width: 1200, height: 140 },
        visualOrder: 14,
        layout: {},
        spacing: {},
        style: { backgroundColor: "#101820" },
        content: {},
        flags: {},
        responsive: {}
      },
      {
        id: "footer-link",
        tag: "a",
        kind: "button",
        parentId: "footer",
        children: [],
        box: { x: 80, y: 1030, width: 180, height: 36 },
        visualOrder: 15,
        layout: {},
        spacing: {},
        style: {},
        content: { text: "Contact", href: "#contact" },
        flags: {},
        responsive: {}
      }
    ]
  };

  const classified = classifySections(buildVisualHierarchy(layout));

  assert.deepEqual(
    classified.detectedSections.map((section) => section.type),
    ["header", "hero", "grid", "footer"]
  );
  assert.deepEqual(classified.semanticIndex.card, ["card-a", "card-b"]);
  assert.equal(
    classified.nodes.find((node) => node.id === "hero")?.detection?.semanticRole,
    "hero"
  );
}

function createSvgDataUrl(svg: string) {
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

async function testV3SnapshotEmitterKeepsSimpleSectionsAsHtmlAndFallsBackPerSection() {
  const topSectionHeight = 150;
  const bottomSectionHeight = 150;
  const width = 320;
  const pageHeight = topSectionHeight + bottomSectionHeight;
  const topSectionImage = createSvgDataUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${topSectionHeight}" viewBox="0 0 ${width} ${topSectionHeight}"><rect width="${width}" height="${topSectionHeight}" fill="#f2545b" /></svg>`
  );
  const bottomSectionImage = createSvgDataUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${bottomSectionHeight}" viewBox="0 0 ${width} ${bottomSectionHeight}"><rect width="${width}" height="${bottomSectionHeight}" fill="#2e86ab" /></svg>`
  );
  const fullPageReference = createSvgDataUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${pageHeight}" viewBox="0 0 ${width} ${pageHeight}"><rect width="${width}" height="${topSectionHeight}" fill="#f2545b" /><rect y="${topSectionHeight}" width="${width}" height="${bottomSectionHeight}" fill="#2e86ab" /></svg>`
  );
  const capture = {
    id: "snapshot-capture",
    sourceKind: "raw-html",
    title: "Snapshot Page",
    sourceHtml: "<body></body>",
    renderedHtml: "<html><body></body></html>",
    renderer: "browser",
    viewports: [
      {
        name: "desktop",
        width,
        height: pageHeight
      }
    ],
    domSnapshot: [],
    styleSnapshot: [],
    boxSnapshot: [],
    responsiveSnapshot: [],
    nodes: [],
    summary: {
      totalNodes: 2,
      visibleNodes: 2,
      images: 0,
      buttons: 0,
      textBlocks: 0,
      sections: 2
    },
    artifacts: {
      outputDir: path.join(os.tmpdir(), "snapshot-elementor-tests"),
      resolvedSourcePath: "",
      renderedHtmlPath: "",
      domSnapshotPath: "",
      styleSnapshotPath: "",
      boxSnapshotPath: "",
      responsiveSnapshotPath: "",
      layoutPath: "",
      analysisPath: "",
      pageCapturePath: "",
      sectionArtifactsPath: "",
      screenshots: {
        desktop: fullPageReference
      }
    }
  } satisfies PageCapture;
  const sections: SectionCapture[] = [
    {
      id: "section-1",
      nodeId: "hero-section",
      name: "hero-1",
      type: "hero",
      box: {
        x: 0,
        y: 0,
        width,
        height: topSectionHeight
      },
      subtreeNodeIds: ["hero-section"],
      originalHtml: `<section style="width:${width}px;height:${topSectionHeight}px;background:#f2545b;"></section>`,
      htmlCandidate: `<!doctype html><html><head><meta charset="utf-8" /><style>html,body{margin:0;padding:0;}</style></head><body><section style="display:block;width:${width}px;height:${topSectionHeight}px;background:#f2545b;"></section></body></html>`,
      complexity: {
        nodeCount: 1,
        absoluteNodes: 0,
        overlappingNodes: 0,
        interactiveNodes: 0,
        imageNodes: 0,
        hasPseudoElements: false,
        hasTransforms: false,
        hasEmbeds: false
      },
      viewports: {
        desktop: {
          viewport: "desktop",
          width,
          height: topSectionHeight,
          snapshotDataUrl: topSectionImage,
          linkOverlays: []
        }
      }
    },
    {
      id: "section-2",
      nodeId: "feature-section",
      name: "section-2",
      type: "section",
      box: {
        x: 0,
        y: topSectionHeight,
        width,
        height: bottomSectionHeight
      },
      subtreeNodeIds: ["feature-section"],
      originalHtml: `<section style="width:${width}px;height:${bottomSectionHeight}px;background:#2e86ab;"></section>`,
      htmlCandidate: `<!doctype html><html><head><meta charset="utf-8" /></head><body><section style="display:block;width:${width}px;height:${bottomSectionHeight}px;background:#2e86ab;"></section></body></html>`,
      complexity: {
        nodeCount: 6,
        absoluteNodes: 0,
        overlappingNodes: 0,
        interactiveNodes: 0,
        imageNodes: 0,
        hasPseudoElements: true,
        hasTransforms: false,
        hasEmbeds: false
      },
      viewports: {
        desktop: {
          viewport: "desktop",
          width,
          height: bottomSectionHeight,
          snapshotDataUrl: bottomSectionImage,
          linkOverlays: []
        }
      }
    }
  ];
  const layout: LayoutDocument = {
    id: "snapshot-layout",
    title: "Snapshot Layout",
    sourceKind: "raw-html",
    rootNodeId: "page",
    nodeCount: 3,
    sectionIds: ["hero-section", "feature-section"],
    semanticIndex: {},
    detectedSections: [
      {
        id: "hero-section",
        type: "hero",
        confidence: 0.99,
        childIds: [],
        anchors: [],
        contains: ["hero"]
      },
      {
        id: "feature-section",
        type: "section",
        confidence: 0.8,
        childIds: [],
        anchors: [],
        contains: ["section"]
      }
    ],
    nodes: []
  };

  const result = await createSnapshotElementorDocumentV3({
    capture,
    layout,
    sections,
    selectedMode: "snapshot"
  });

  assert.equal(result.document.content.length, 2);
  assert.equal(result.snapshot.totals.htmlSections, 1);
  assert.equal(result.snapshot.totals.snapshotSections, 1);
  assert.equal(result.snapshot.sectionReports[0]?.mode, "html");
  assert.equal(result.snapshot.sectionReports[1]?.mode, "snapshot");
  assert.equal(result.snapshot.overallSimilarity >= 0.99, true);
  assert.match(
    String(result.document.content[1]?.elements?.[0]?.settings?.html ?? ""),
    /converter-v3-snapshot-section/
  );
}

async function main() {
  await testV3HtmlCapturePipeline();
  await testV3ZipResolver();
  await testV3ComplexitySelection();
  await testV3ExportPipeline();
  await testV3HybridSectionFallback();
  await testV3HybridPreservesGridWidths();
  await testV3HybridKeepsRichPatternedGridStructural();
  await testV3HybridDetectsPricingPreset();
  await testV3HybridComposesTestimonialWidgets();
  await testV3EditableComposesPricingWidgets();
  await testV3EditableComposesTestimonialWidgets();
  await testV3EditableComposesFeatureWidgets();
  await testV3EditableComposesPricingSection();
  await testV3HybridComposesPricingSection();
  await testV3EditableComposesPricingSectionChildren();
  await testV3HybridComposesPricingSectionChildren();
  await testV3EditableComposesPricingSectionBlocks();
  await testV3HybridComposesPricingSectionBlocks();
  await testV3EditableComposesFeatureSectionIntroBlock();
  await testV3HybridComposesTestimonialSectionIntroBlock();
  await testV3EditableComposesFeatureSectionOutroBlock();
  await testV3HybridComposesTestimonialSectionOutroBlock();
  await testV3EditableFallsBackToHybridOnUnsupportedBlock();
  await testV3NativeExportPreservesBackgroundImages();
  testResponsiveChildSettingsHelper();
  testResponsiveGridColumnReductionHelper();
  testResponsiveSplitPatternHelper();
  testPatternOrderedChildIdsHelper();
  testResponsivePresetDetectionHelper();
  testSectionClassifierDetectsSemanticSections();
  await testV3SnapshotEmitterKeepsSimpleSectionsAsHtmlAndFallsBackPerSection();
  console.log("converter-v3 tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
