import assert from "node:assert/strict";

import JSZip from "jszip";

import { resolveSourceFromUpload } from "../lib/converter-v3/resolve/source-resolver";
import { getLovableBaseCss, inlineLovableStyles } from "../lib/tailwind";

async function testLovableResolverEmbedsProjectStylesAndFonts() {
  const zip = new JSZip();

  zip.file(
    "sample/index.html",
    `<!doctype html>
<html>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>`
  );
  zip.file(
    "sample/src/main.tsx",
    `import { createRoot } from "react-dom/client";
import App from "./App";

const headLinks = [
  { href: "https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&display=swap" }
];

createRoot(document.getElementById("root")!).render(<App />);`
  );
  zip.file(
    "sample/src/App.tsx",
    `import appCss from "./styles.css?url";

export default function App() {
  return (
    <section className="font-sans">
      <span data-css={appCss}>css asset</span>
      <h1 style={{ fontFamily: "var(--font-display)" }}>Styled heading</h1>
      <p>Resolved with project CSS.</p>
    </section>
  );
}`
  );
  zip.file(
    "sample/src/styles.css",
    `@import "tailwindcss" source(none);
@source "../src";

:root {
  --font-display: "Cormorant Garamond", Georgia, serif;
  --font-sans: "Inter", ui-sans-serif, system-ui, sans-serif;
  --background: #faf7f2;
}

@layer base {
  body {
    background-color: var(--background);
  }
}`
  );

  const file = new File([await zip.generateAsync({ type: "arraybuffer" })], "sample.zip", {
    type: "application/zip"
  });
  const resolved = await resolveSourceFromUpload(file);

  assert.equal(resolved.sourceKind, "lovable-react-source");
  assert.match(resolved.html, /data-converter-v3-project-css/);
  assert.match(resolved.html, /--font-display: "Cormorant Garamond"/);
  assert.match(resolved.html, /fonts\.googleapis\.com/);
}

async function testLovableResolverInlinesStylesheetAssetUrls() {
  const zip = new JSZip();

  zip.file(
    "assets/index.html",
    `<!doctype html>
<html>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>`
  );
  zip.file(
    "assets/src/main.tsx",
    `import { createRoot } from "react-dom/client";
import App from "./App";

createRoot(document.getElementById("root")!).render(<App />);`
  );
  zip.file(
    "assets/src/App.tsx",
    `import "./styles.css";

export default function App() {
  return <section className="hero">Background clone</section>;
}`
  );
  zip.file(
    "assets/src/styles.css",
    `.hero {
  min-height: 240px;
  background-image: url("./hero.png");
  background-size: cover;
}`
  );
  zip.file(
    "assets/src/hero.png",
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9oNcamcAAAAASUVORK5CYII=",
      "base64"
    )
  );

  const file = new File([await zip.generateAsync({ type: "arraybuffer" })], "assets.zip", {
    type: "application/zip"
  });
  const resolved = await resolveSourceFromUpload(file);

  assert.equal(resolved.sourceKind, "lovable-react-source");
  assert.match(resolved.html, /background-image:\s*url\("data:image\/png;base64,/);
}

function testInlineLovableStylesHandlesResponsiveAndArbitraryUtilities() {
  const html = `<!doctype html>
<html>
  <head></head>
  <body>
    <section class="container mx-auto grid grid-cols-1 md:grid-cols-2">
      <div class="hidden md:flex size-5 min-w-full right-0 tracking-[0.25em] leading-[1.05] font-sans text-foreground bg-background/80">
        Tone
      </div>
      <div class="[background:radial-gradient(circle,#111,#fff)]">
        Hero
      </div>
    </section>
  </body>
</html>`;

  const output = inlineLovableStyles(html);
  const baseCss = getLovableBaseCss();

  assert.match(output, /width:100%/);
  assert.match(output, /margin-left:auto/);
  assert.match(output, /height:1\.25rem/);
  assert.match(output, /min-width:100%/);
  assert.match(output, /right:0/);
  assert.match(output, /letter-spacing:0\.25em/);
  assert.match(output, /line-height:1\.05/);
  assert.match(output, /color:hsl\(var\(--foreground\)\)/);
  assert.match(output, /background:hsl\(var\(--background\) \/ 0\.8\)/);
  assert.match(output, /font-family:var\(--font-sans/);
  assert.match(output, /background:radial-gradient\(circle,#111,#fff\)/);
  assert.match(output, /data-converter-v3-generated-responsive/);
  assert.match(output, /@media \(min-width: 768px\)/);
  assert.match(output, /display:flex !important/);
  assert.match(output, /grid-template-columns:repeat\(2, minmax\(0, 1fr\)\) !important/);
  assert.match(baseCss, /html, body \{/);
  assert.match(baseCss, /\.container \{/);
}

async function testLovableResolverRendersExternalIconFallbacks() {
  const zip = new JSZip();

  zip.file(
    "icons/index.html",
    `<!doctype html>
<html>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>`
  );
  zip.file(
    "icons/src/main.tsx",
    `import { createRoot } from "react-dom/client";
import App from "./App";

createRoot(document.getElementById("root")!).render(<App />);`
  );
  zip.file(
    "icons/src/App.tsx",
    `import { Sparkles } from "lucide-react";

export default function App() {
  return (
    <main className="container mx-auto">
      <Sparkles className="size-5 text-primary" strokeWidth={2} />
      <h1 className="text-[42px] text-foreground">Icon clone</h1>
    </main>
  );
}`
  );

  const file = new File([await zip.generateAsync({ type: "arraybuffer" })], "icons.zip", {
    type: "application/zip"
  });
  const resolved = await resolveSourceFromUpload(file);

  assert.equal(resolved.sourceKind, "lovable-react-source");
  assert.match(resolved.html, /data-lovable-icon="Sparkles"/);
  assert.match(resolved.html, /class="size-5 text-primary"/);
  assert.match(resolved.html, /Icon clone/);
}

async function testLovableResolverKeepsChildrenHtmlOutOfVisibleCodeFallbacks() {
  const zip = new JSZip();

  zip.file(
    "fallback/index.html",
    `<!doctype html>
<html>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>`
  );
  zip.file(
    "fallback/src/main.tsx",
    `import { createRoot } from "react-dom/client";
import App from "./App";

createRoot(document.getElementById("root")!).render(<App />);`
  );
  zip.file(
    "fallback/src/logo.svg",
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#2563eb"/></svg>`
  );
  zip.file(
    "fallback/src/App.tsx",
    `import Logo from "./logo.svg";

const motion = {
  div: "div"
};

export default function App() {
  return (
    <main>
      <Button className="cta" href="#buy">
        <span>Buy now</span>
      </Button>
      <NavLink className="nav-link" to="/plans">
        <span>Plans</span>
      </NavLink>
      <motion.div className="hero-shell">
        <strong>Motion wrapper</strong>
      </motion.div>
      <Logo className="brand-mark" />
    </main>
  );
}`
  );

  const file = new File([await zip.generateAsync({ type: "arraybuffer" })], "fallback.zip", {
    type: "application/zip"
  });
  const resolved = await resolveSourceFromUpload(file);

  assert.equal(resolved.sourceKind, "lovable-react-source");
  assert.doesNotMatch(resolved.html, /&lt;span&gt;Buy now&lt;\/span&gt;/);
  assert.doesNotMatch(resolved.html, /<motion\.div/i);
  assert.match(resolved.html, /<a[^>]+class="cta"[^>]*><span>Buy now<\/span><\/a>/);
  assert.match(resolved.html, /<a[^>]+class="nav-link"[^>]+href="\/plans"[^>]*><span>Plans<\/span><\/a>/);
  assert.match(resolved.html, /<div[^>]+class="hero-shell"[^>]*><strong>Motion wrapper<\/strong><\/div>/);
  assert.match(resolved.html, /<img[^>]+class="brand-mark"[^>]+src="data:image\/svg\+xml;base64,/);
}

async function main() {
  await testLovableResolverEmbedsProjectStylesAndFonts();
  await testLovableResolverInlinesStylesheetAssetUrls();
  testInlineLovableStylesHandlesResponsiveAndArbitraryUtilities();
  await testLovableResolverRendersExternalIconFallbacks();
  await testLovableResolverKeepsChildrenHtmlOutOfVisibleCodeFallbacks();
  console.log("lovable rendering tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
