import assert from "node:assert/strict";

import JSZip from "jszip";

import { runPixelPerfectConversionPipeline } from "../lib/converter-v2/pipeline";
import { extractSourceFromZip } from "../lib/converter-v2/source-extractor";
import { convertHtmlToElementor } from "../lib/converter";

function flattenElements(elements: Array<{ elements: unknown[] } & Record<string, unknown>>): Array<Record<string, unknown>> {
  return elements.flatMap((element) => [
    element,
    ...flattenElements((element.elements as Array<{ elements: unknown[] } & Record<string, unknown>>) ?? [])
  ]);
}

async function testPixelPerfectHtmlPipeline() {
  const html = `<!doctype html>
<html>
  <head>
    <title>Visual Test</title>
  </head>
  <body>
    <header>
      <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=" alt="Brand" />
      <a href="#order">Order Now</a>
    </header>
    <section>
      <h1>Lovable Hero</h1>
      <p>A responsive section.</p>
      <span role="button">Learn More</span>
      <span>Limited Offer</span>
      <img src="data:image/svg+xml;base64,PHN2Zy8+" alt="Hero banner" />
    </section>
    <section>
      <article>
        <span>Best Value</span>
        <h2>Card Title</h2>
        <img src="data:image/svg+xml;base64,PHN2Zy8+" alt="Card visual" />
        <a href="/checkout">Buy Now</a>
        <button onclick="addToCart()">Add to Cart</button>
      </article>
    </section>
  </body>
</html>`;

  const pipeline = await runPixelPerfectConversionPipeline(html, "raw-html");
  const json = JSON.stringify(pipeline.elementorJson);
  const widgets = flattenElements(pipeline.elementorJson.content as never[]);

  assert.equal(pipeline.report.exportBlocked, false);
  assert.equal(pipeline.report.status, "success");
  assert.equal(pipeline.report.elementosPerdidos.length, 0);
  assert.match(json, /iframe_srcdoc_pixel_perfect_v2/);
  assert.match(json, /scrolling=\\\"no\\\"/);
  assert.match(json, /onload=\\\"/);
  assert.match(json, /setInterval\(function\(\)/);
  assert.match(json, /overflow-y: visible !important/);
  assert.doesNotMatch(json, /scrollbar-width: none/);
  assert.match(json, /html-to-elementor:frame-resize/);
  assert.match(json, /Math\.abs\(targetHeight - currentHeight\) <= 1/);
  assert.doesNotMatch(json, /\+ 24/);
  assert.match(json, /srcdoc=/);
  assert.match(json, /Lovable Hero/);
  assert.match(json, /Order Now/);
  assert.match(json, /Best Value/);
  assert.match(json, /Card visual/);
  assert.equal(widgets.filter((widget) => widget.widgetType === "html").length, 1);
  assert.ok(pipeline.cleanHtml.includes("<style>"), "injects renderable CSS into the HTML shell");
}

async function testPublicConverterUsesNewPipeline() {
  const html = "<main><h1>Converted Title</h1><a href=\"#buy\">Buy</a></main>";
  const elementor = await convertHtmlToElementor(html);
  const json = JSON.stringify(elementor);

  assert.equal(elementor.title, "Elementor Page");
  assert.match(json, /iframe_srcdoc_pixel_perfect_v2/);
  assert.match(json, /Converted Title/);
}

async function testAlternatingLayoutOrderRule() {
  const html = `<!doctype html>
<html>
  <body>
    <div class="grid gap-10 md:grid-cols-2 md:items-center md:[&amp;&gt;div:first-child]:order-2">
      <div><img src="data:image/svg+xml;base64,PHN2Zy8+" alt="Visual" /></div>
      <div><h3>Move with ease, every day</h3></div>
    </div>
  </body>
</html>`;

  const pipeline = await runPixelPerfectConversionPipeline(html, "raw-html");

  assert.match(pipeline.cleanHtml, /data-first-child-order-md="2"/);
  assert.match(pipeline.cleanHtml, /\[data-first-child-order-md="2"\] > :first-child \{ order: 2; \}/);
}

async function testLovableZipExtraction() {
  const zip = new JSZip();
  zip.file("sample/src/assets/logo.png", "test-image");
  zip.file(
    "sample/src/routes/index.tsx",
    `import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import logoImg from "@/assets/logo.png";

export const Route = createFileRoute("/")({
  component: Index,
  head: () => ({
    links: [
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap" }
    ]
  }),
});

const benefits = ["Fast", "Responsive"];

function Index() {
  const [openFaq] = useState<number | null>(0);

  return (
    <div className="min-h-screen bg-background font-sans text-foreground" style={{ fontFamily: "var(--font-sans)" }}>
      <header className="flex items-center justify-between px-6 py-4">
        <img src={logoImg} alt="Logo" className="h-14 w-auto" />
        <a href="#order" className="rounded-full bg-primary px-5 py-2.5 text-primary-foreground">Order</a>
      </header>
      <section id="features" className="grid gap-6 md:grid-cols-2">
        {benefits.map((benefit) => (
          <div className="rounded-3xl border p-6">
            <h2>{benefit}</h2>
          </div>
        ))}
      </section>
      <section id="faq">
        <div>
          <button>Question</button>
          {openFaq === 0 && <p>Hidden answer</p>}
        </div>
      </section>
    </div>
  );
}`
  );

  const extracted = await extractSourceFromZip(zip);
  const pipeline = await runPixelPerfectConversionPipeline(
    extracted.html,
    extracted.sourceKind
  );
  const json = JSON.stringify(pipeline.elementorJson);

  assert.equal(extracted.sourceKind, "lovable-react-source");
  assert.match(extracted.html, /fonts\.googleapis\.com/, "keeps route head font links");
  assert.match(extracted.html, /data:image\/png;base64/, "embeds local assets");
  assert.match(extracted.html, /Fast/, "renders array map items");
  assert.match(extracted.html, /Responsive/, "renders all array items");
  assert.match(extracted.html, /Hidden answer/, "renders conditional content from initial state");
  assert.equal(pipeline.report.exportBlocked, false);
  assert.equal(pipeline.report.elementosPerdidos.length, 0);
  assert.match(json, /iframe_srcdoc_pixel_perfect_v2/);
  assert.match(json, /Question/);
  assert.match(json, /--html-to-elementor-fixed-vh/);
  assert.doesNotMatch(json, /min-height:100vh/);
}

async function main() {
  await testPixelPerfectHtmlPipeline();
  await testPublicConverterUsesNewPipeline();
  await testAlternatingLayoutOrderRule();
  await testLovableZipExtraction();
  console.log("converter tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
