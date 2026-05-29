import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import JSZip from "jszip";

import type { PageCapture, SectionCapture } from "../lib/converter-v3/contracts/capture";
import type {
  InputFrameworkHint,
  InputLayoutType,
  InputPageAnalysis
} from "../lib/converter-v3/contracts/input-analysis";
import type { LayoutDocument, LayoutNode } from "../lib/converter-v3/contracts/layout";
import { auditThemeConsistency } from "../lib/converter-v3/analyze/theme-detector";
import { CAPTURED_STYLE_PROPERTIES } from "../lib/converter-v3/bounding-box-extractor";
import { buildConvertedPreviewHtml } from "../lib/converter-v3/debug/conversion-debug";
import { createElementorNativeExport } from "../lib/converter-v3/elementor-native-exporter";
import { createPixelPerfectElementorDocumentV3 } from "../lib/converter-v3/emitters/elementor/pixel-perfect";
import {
  createSnapshotElementorDocumentV3,
  inferFullPageSnapshotLossType
} from "../lib/converter-v3/emitters/elementor/snapshot";
import {
  createElementorResponsiveSettings,
  createResponsiveChildSettings,
  detectContainerPreset,
  deriveContainerLayout,
  getOrderedChildIdsForPattern
} from "../lib/converter-v3/emitters/elementor/responsive-layout";
import { createEditableElementorDocumentV3 } from "../lib/converter-v3/emitters/elementor/editable";
import {
  resolvePageShellVisualContext,
  resolveStyleMapBackgroundColor,
  buildStyledHtmlFragment
} from "../lib/converter-v3/emitters/elementor/style-preservation";
import {
  runExportPipelineV3,
  runExportPipelineV3FromHtml
} from "../lib/converter-v3/orchestration/export-pipeline-v3";
import {
  runCapturePipelineV3,
  runCapturePipelineV3FromHtml
} from "../lib/converter-v3/orchestration/pipeline-v3";
import { buildExportReport } from "../lib/converter-v3/reports/report-builder";
import {
  resolveSourceFromLocalFile,
  resolveSourceFromUpload
} from "../lib/converter-v3/resolve/source-resolver";
import { buildVisualSectionCaptures } from "../lib/converter-v3/sections/visual-section-capture";
import { classifySections } from "../lib/converter-v3/section-classifier";
import {
  assessVisualCloneRisk,
  shouldForceUniversalFullPageSnapshot,
  shouldPreferUniversalVisualSnapshot,
  VISUAL_REASON_DARK_THEME,
  VISUAL_REASON_FALLBACK_PIXEL_PERFECT,
  VISUAL_REASON_FALLBACK_SNAPSHOT,
  VISUAL_REASON_HERO_BACKGROUND,
  VISUAL_REASON_HIGH_RISK,
  VISUAL_REASON_STRUCTURAL_AUDIT
} from "../lib/converter-v3/visual-clone-policy";
import { buildVisualHierarchy } from "../lib/converter-v3/visual-hierarchy";
import { validateElementorExport } from "../lib/converter-v3/visual-regression-validator";
import type { ElementorDocument, ElementorElement } from "../types/conversion";
import {
  isForceFullPageSnapshotEnabled as isForceFullPageSnapshotEnabledFromEnv,
  isForceVisualSnapshotEnabled as isForceVisualSnapshotEnabledFromEnv
} from "../lib/env";

if (typeof process.env.FORCE_FULL_PAGE_SNAPSHOT !== "string") {
  process.env.FORCE_FULL_PAGE_SNAPSHOT = "false";
}

function isForceVisualSnapshotEnabled() {
  const value = String(process.env.FORCE_VISUAL_SNAPSHOT || "").toLowerCase().trim();

  if (!value) {
    return true;
  }

  if (["1", "true", "yes", "on"].includes(value)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(value)) {
    return false;
  }

  return true;
}

function isForceFullPageSnapshotEnabled() {
  const value = String(process.env.FORCE_FULL_PAGE_SNAPSHOT || "").toLowerCase().trim();

  if (!value) {
    return false;
  }

  if (["1", "true", "yes", "on"].includes(value)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(value)) {
    return false;
  }

  return false;
}

function expectedPrimaryMode() {
  return isForceVisualSnapshotEnabled() ? "snapshot" : "editable";
}

function assertPrimaryMode(actualMode: string) {
  assert.equal(actualMode, expectedPrimaryMode());
}

function preferBrowserForExportPipelineTests() {
  return isForceVisualSnapshotEnabled();
}

function expectedForcedSnapshotVisualStatus(): "passed" | "blocked" {
  return preferBrowserForExportPipelineTests() ? "passed" : "blocked";
}

function logForceVisualSnapshotDebug() {
  if (String(process.env.DEBUG_FORCE_VISUAL_SNAPSHOT || "").toLowerCase().trim() !== "true") {
    return;
  }

  console.log("FORCE_VISUAL_SNAPSHOT =", process.env.FORCE_VISUAL_SNAPSHOT);
  console.log("expectedPrimaryMode =", expectedPrimaryMode());
}

async function testForceVisualSnapshotDefaultsToTrue() {
  const previous = process.env.FORCE_VISUAL_SNAPSHOT;

  try {
    delete process.env.FORCE_VISUAL_SNAPSHOT;
    assert.equal(isForceVisualSnapshotEnabledFromEnv(), true);
    assert.equal(isForceVisualSnapshotEnabled(), true);
  } finally {
    if (typeof previous === "string") {
      process.env.FORCE_VISUAL_SNAPSHOT = previous;
    } else {
      delete process.env.FORCE_VISUAL_SNAPSHOT;
    }
  }
}

async function testForceFullPageSnapshotDefaultsToFalse() {
  const previous = process.env.FORCE_FULL_PAGE_SNAPSHOT;

  try {
    delete process.env.FORCE_FULL_PAGE_SNAPSHOT;
    assert.equal(isForceFullPageSnapshotEnabledFromEnv(), false);
    assert.equal(isForceFullPageSnapshotEnabled(), false);
  } finally {
    if (typeof previous === "string") {
      process.env.FORCE_FULL_PAGE_SNAPSHOT = previous;
    } else {
      delete process.env.FORCE_FULL_PAGE_SNAPSHOT;
    }
  }
}

function createMockInputAnalysis(
  overrides: Partial<InputPageAnalysis> = {}
): InputPageAnalysis {
  return {
    fileName: overrides.fileName ?? "test-fixture.html",
    sourceKind: overrides.sourceKind ?? "raw-html",
    layoutTypes: overrides.layoutTypes ?? ["static-html"],
    frameworkHints: overrides.frameworkHints ?? [],
    structure: {
      totalElements: 0,
      realSectionCount: 1,
      headers: 0,
      navbars: 0,
      heroSections: 0,
      cards: 0,
      grids: 0,
      buttons: 0,
      images: 0,
      backgrounds: 0,
      absoluteFixedSticky: 0,
      zIndexNodes: 0,
      iframes: 0,
      scripts: 0,
      lazyLoadElements: 0,
      externalAssets: 0,
      externalFonts: 0,
      links: 0,
      forms: 0,
      carousels: 0,
      transformedElements: 0,
      overflowHiddenElements: 0,
      outOfFlowElements: 0,
      ...(overrides.structure ?? {})
    },
    sectionCandidates: overrides.sectionCandidates ?? [],
    assets: {
      found: [],
      total: 0,
      local: 0,
      external: 0,
      embedded: 0,
      images: 0,
      backgrounds: 0,
      stylesheets: 0,
      fonts: 0,
      scripts: 0,
      iframes: 0,
      lazy: 0,
      loaded: 0,
      failed: 0,
      ...(overrides.assets ?? {})
    },
    renderStrategy: {
      requiresBrowserRender: true,
      preferVisualSnapshot: false,
      preferFullPageSnapshot: false,
      safeSectionExtraction: true,
      reasons: [],
      ...(overrides.renderStrategy ?? {})
    },
    diagnostics: {
      errors: [],
      warnings: [],
      rendererUsed: "browser",
      htmlRendered: true,
      cssLoaded: true,
      imagesLoaded: true,
      relativeAssetsResolved: true,
      viewportMatched: true,
      sectionCroppingRisk: false,
      fullPageSnapshotFailed: false,
      resources: [],
      ...(overrides.diagnostics ?? {})
    }
  };
}

function createMockCapture(overrides: Partial<PageCapture> = {}): PageCapture {
  return {
    id: overrides.id ?? "mock-capture",
    sourceKind: overrides.sourceKind ?? "raw-html",
    title: overrides.title ?? "Mock Capture",
    sourceHtml: overrides.sourceHtml ?? "<html><body></body></html>",
    renderedHtml: overrides.renderedHtml ?? "<html><body></body></html>",
    renderer: overrides.renderer ?? "browser",
    inputAnalysis: overrides.inputAnalysis ?? createMockInputAnalysis(),
    viewports: overrides.viewports ?? [
      {
        name: "desktop",
        width: 1440,
        height: 1200
      },
      {
        name: "tablet",
        width: 1024,
        height: 1366
      },
      {
        name: "mobile",
        width: 390,
        height: 844
      }
    ],
    domSnapshot: overrides.domSnapshot ?? [],
    styleSnapshot: overrides.styleSnapshot ?? [],
    boxSnapshot: overrides.boxSnapshot ?? [],
    responsiveSnapshot: overrides.responsiveSnapshot ?? [],
    nodes: overrides.nodes ?? [],
    sections: overrides.sections,
    themeAnalysis: overrides.themeAnalysis,
    summary: overrides.summary ?? {
      totalNodes: 0,
      visibleNodes: 0,
      links: 0,
      images: 0,
      buttons: 0,
      textBlocks: 0,
      visualContainers: 0,
      geometryGroups: 0,
      sections: 0
    },
    artifacts: overrides.artifacts ?? {
      outputDir: path.join(os.tmpdir(), "mock-capture"),
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
      screenshots: {}
    }
  };
}

function flattenElementTree(elements: ElementorElement[]): ElementorElement[] {
  const flattened: ElementorElement[] = [];
  const queue = [...elements];

  while (queue.length > 0) {
    const element = queue.shift();

    if (!element) {
      continue;
    }

    flattened.push(element);
    queue.push(...element.elements);
  }

  return flattened;
}

function findFirstWidget(document: ElementorDocument, widgetType: string) {
  return flattenElementTree(document.content).find(
    (element) => element.widgetType === widgetType
  );
}

function assertSnapshotModeWhenForced(
  result: {
    analysis: { selectedMode: string };
    emittedMode: string;
    fallbackReason?: string;
    elementorDocument?: unknown;
    validation?: {
      passed: boolean;
    };
    snapshot?: {
      overallSimilarity: number;
      threshold: number;
      totals: {
        preservedLinks: number;
      };
      visualValidationReport?: {
        status: string;
        blockingReason?: string;
      };
    };
  },
  options: {
    requireSelectedModeSnapshot?: boolean;
    expectedVisualStatus?: "passed" | "blocked";
    preservedLinksAtLeast?: number;
    requireLinkOverlay?: boolean;
    report?: {
      emittedMode?: string;
      selectedMode?: string;
    };
    document?: unknown;
  } = {}
) {
  if (!isForceVisualSnapshotEnabled()) {
    return false;
  }

  const expectedMode = expectedPrimaryMode();

  assert.equal(result.emittedMode, expectedMode);
  assert.ok(result.snapshot);

  if (typeof options.report?.emittedMode === "string") {
    assert.equal(options.report.emittedMode, expectedMode);
  }

  if (typeof options.report?.selectedMode === "string") {
    assert.equal(options.report.selectedMode, expectedMode);
  }

  if (options.requireSelectedModeSnapshot) {
    assert.equal(result.analysis.selectedMode, expectedMode);
  }

  if (typeof result.fallbackReason === "string") {
    assert.equal(/editable|hybrid/i.test(result.fallbackReason), false);
  }

  if (options.expectedVisualStatus === "passed") {
    assert.equal(result.snapshot.visualValidationReport?.status, "passed");
    assert.equal(result.snapshot.overallSimilarity >= result.snapshot.threshold, true);
  }

  if (options.expectedVisualStatus === "blocked") {
    assert.equal(result.snapshot.visualValidationReport?.status, "blocked");
    assert.equal(result.validation?.passed, false);
    assert.ok(result.snapshot.visualValidationReport?.blockingReason);
  }

  if (
    options.expectedVisualStatus !== "blocked" &&
    typeof options.preservedLinksAtLeast === "number"
  ) {
    assert.equal(
      result.snapshot.totals.preservedLinks >= options.preservedLinksAtLeast,
      true
    );
  }

  if (options.expectedVisualStatus !== "blocked" && options.requireLinkOverlay) {
    assertContainsSnapshotLinkOverlay(options.document ?? result.elementorDocument);
  }

  return true;
}

function objectContainsPattern(value: unknown, pattern: RegExp): boolean {
  if (typeof value === "string") {
    return pattern.test(value);
  }

  if (Array.isArray(value)) {
    return value.some((item) => objectContainsPattern(item, pattern));
  }

  if (value && typeof value === "object") {
    return Object.values(value).some((item) => objectContainsPattern(item, pattern));
  }

  return false;
}

function assertContainsSnapshotLinkOverlay(value: unknown) {
  assert.equal(objectContainsPattern(value, /converter-v3-snapshot-link-1/), true);
}

function parseRgbChannels(value?: string) {
  const match = value?.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/i);

  if (!match) {
    return undefined;
  }

  return {
    r: Number.parseInt(match[1], 10),
    g: Number.parseInt(match[2], 10),
    b: Number.parseInt(match[3], 10)
  };
}

function createVisualAuditFixture() {
  const width = 1200;
  const height = 520;
  const box = {
    x: 0,
    y: 0,
    top: 0,
    right: width,
    bottom: height,
    left: 0,
    width,
    height,
    centerX: width / 2,
    centerY: height / 2
  };
  const capture = createMockCapture({
    id: "visual-audit-fixture",
    title: "Visual Audit Fixture",
    renderedHtml:
      "<html><body><section><h1>Dark premium hero</h1><a href=\"#cta\">Start</a><input type=\"email\" /></section></body></html>",
    inputAnalysis: createMockInputAnalysis({
      structure: {
        heroSections: 1,
        cards: 1,
        buttons: 1,
        forms: 1,
        links: 1,
        backgrounds: 1
      } as InputPageAnalysis["structure"],
      diagnostics: {
        errors: [],
        warnings: [],
        rendererUsed: "browser",
        htmlRendered: true,
        cssLoaded: true,
        imagesLoaded: true,
        relativeAssetsResolved: true,
        viewportMatched: true,
        sectionCroppingRisk: false,
        fullPageSnapshotFailed: false,
        resources: [
          {
            url: "hero-bg.png",
            kind: "background",
            status: "loaded",
            sourceTag: "section",
            sourceAttribute: "background-image",
            nodeId: "hero-section",
            importance: "hero",
            critical: true,
            diagnostic: "background image loaded"
          }
        ]
      }
    }),
    nodes: [
      {
        id: "hero-section",
        tag: "section",
        text: "",
        attributes: {},
        parentId: null,
        childIds: ["hero-title", "hero-button", "hero-card"],
        computedStyles: {
          color: "#f8fafc",
          "background-color": "#020617"
        },
        box,
        viewportStates: {
          desktop: {
            computedStyles: {
              color: "#f8fafc",
              "background-color": "#020617"
            },
            box,
            isVisible: true
          }
        },
        visualOrder: 0,
        isVisible: true,
        asset: {
          backgroundImage: 'linear-gradient(180deg, rgba(2, 6, 23, 0.92), rgba(2, 6, 23, 0.55)), url("hero-bg.png")',
          backgroundUrls: ["hero-bg.png"],
          hasGradientBackground: true
        }
      }
    ],
    sections: [
      {
        id: "hero-capture",
        nodeId: "hero-section",
        name: "hero-1",
        type: "hero",
        box: {
          x: 0,
          y: 0,
          width,
          height
        },
        subtreeNodeIds: ["hero-section", "hero-title", "hero-button", "hero-card"],
        originalHtml: "<section></section>",
        htmlCandidate: "<html><body><section></section></body></html>",
        complexity: createSectionCaptureComplexity(),
        viewports: {
          desktop: {
            viewport: "desktop",
            width,
            height,
            linkOverlays: []
          }
        },
        debug: {
          sectionBoundingBox: {
            x: 0,
            y: 0,
            width,
            height
          },
          sectionWidth: width,
          sectionHeight: height,
          originalImages: [],
          cssBackgrounds: [
            {
              nodeId: "hero-section",
              tag: "section",
              backgroundImage:
                'linear-gradient(180deg, rgba(2, 6, 23, 0.92), rgba(2, 6, 23, 0.55)), url("hero-bg.png")',
              backgroundUrls: ["hero-bg.png"],
              hasGradient: true,
              status: "loaded"
            }
          ],
          loadedFonts: [],
          interactiveElements: [],
          positionedElements: []
        }
      }
    ],
    themeAnalysis: {
      detectedTheme: "dark",
      dominantBackgroundLuminance: 0.02,
      dominantContrast: 15.4,
      colorSamples: [],
      designTokens: {
        globalBackground: "rgb(2, 6, 23)",
        foreground: "rgb(248, 250, 252)",
        cardBackground: "rgb(15, 23, 42)",
        primaryButtonColor: "rgb(56, 189, 248)",
        borderColor: "rgb(51, 65, 85)",
        radius: "14px",
        shadow: "0 18px 40px rgba(15, 23, 42, 0.2)"
      },
      styleSignals: {
        hasStrongDarkTheme: true,
        hasStyledButtons: true,
        hasStyledInputs: true,
        hasElevatedCards: true
      },
      roleCounts: {
        cards: 1,
        buttons: 1,
        inputs: 1,
        headers: 0,
        footers: 0,
        sections: 1
      },
      messages: ["dark theme detected"]
    },
    summary: {
      totalNodes: 4,
      visibleNodes: 4,
      links: 1,
      images: 1,
      buttons: 1,
      textBlocks: 1,
      visualContainers: 1,
      geometryGroups: 1,
      sections: 1
    }
  });
  const layout: LayoutDocument = {
    id: "visual-audit-layout",
    title: "Visual Audit Layout",
    sourceKind: "raw-html",
    rootNodeId: "page",
    nodeCount: 5,
    sectionIds: ["hero-section"],
    semanticIndex: {
      hero: ["hero-section"],
      card: ["hero-card"],
      button: ["hero-button"]
    },
    detectedSections: [
      {
        id: "hero-section",
        type: "hero",
        confidence: 0.99,
        childIds: ["hero-title", "hero-button", "hero-card"],
        anchors: [],
        contains: ["hero", "button", "card", "text"]
      }
    ],
    nodes: [
      {
        id: "page",
        kind: "page",
        parentId: null,
        children: ["hero-section"],
        box: {
          x: 0,
          y: 0,
          width,
          height
        },
        visualOrder: 0,
        layout: {},
        spacing: {},
        style: {
          backgroundColor: "#020617"
        },
        content: {},
        flags: {},
        responsive: {}
      },
      {
        id: "hero-section",
        tag: "section",
        kind: "section",
        parentId: "page",
        children: ["hero-title", "hero-button", "hero-card"],
        box: {
          x: 0,
          y: 0,
          width,
          height
        },
        visualOrder: 1,
        layout: {},
        spacing: {},
        style: {
          backgroundColor: "#020617",
          backgroundImage:
            'linear-gradient(180deg, rgba(2, 6, 23, 0.92), rgba(2, 6, 23, 0.55)), url("hero-bg.png")'
        },
        content: {},
        flags: {},
        detection: {
          semanticRole: "hero",
          confidence: 0.99
        },
        responsive: {}
      },
      {
        id: "hero-title",
        tag: "h1",
        kind: "text",
        parentId: "hero-section",
        children: [],
        box: {
          x: 48,
          y: 40,
          width: 480,
          height: 72
        },
        visualOrder: 2,
        layout: {},
        spacing: {},
        style: {
          color: "#f8fafc"
        },
        content: {
          text: "Dark premium hero"
        },
        flags: {},
        responsive: {}
      },
      {
        id: "hero-button",
        tag: "a",
        kind: "button",
        parentId: "hero-section",
        children: [],
        box: {
          x: 48,
          y: 140,
          width: 160,
          height: 48
        },
        visualOrder: 3,
        layout: {},
        spacing: {},
        style: {
          backgroundColor: "#38bdf8",
          borderRadius: "999px",
          boxShadow: "0 18px 40px rgba(56, 189, 248, 0.35)"
        },
        content: {
          text: "Start",
          href: "#cta"
        },
        flags: {},
        detection: {
          semanticRole: "button",
          confidence: 0.96
        },
        responsive: {}
      },
      {
        id: "hero-card",
        tag: "div",
        kind: "container",
        parentId: "hero-section",
        children: [],
        box: {
          x: 720,
          y: 80,
          width: 360,
          height: 240
        },
        visualOrder: 4,
        layout: {},
        spacing: {},
        style: {
          backgroundColor: "#0f172a",
          borderRadius: "20px",
          boxShadow: "0 24px 48px rgba(15, 23, 42, 0.28)"
        },
        content: {},
        flags: {},
        detection: {
          semanticRole: "card",
          confidence: 0.95
        },
        responsive: {}
      }
    ]
  };
  const document = {
    version: "1.0",
    title: "Visual Audit Export",
    type: "page" as const,
    content: [
      {
        id: "hero-container",
        elType: "container" as const,
        settings: {
          converter_v3_source_node_id: "hero-section"
        },
        elements: [
          {
            id: "hero-title-widget",
            elType: "widget" as const,
            widgetType: "heading",
            settings: {
              converter_v3_source_node_id: "hero-title",
              title: "Dark premium hero"
            },
            elements: []
          },
          {
            id: "hero-button-widget",
            elType: "widget" as const,
            widgetType: "button",
            settings: {
              converter_v3_source_node_id: "hero-button",
              text: "Start",
              link: {
                url: "#cta"
              }
            },
            elements: []
          },
          {
            id: "hero-input-widget",
            elType: "widget" as const,
            widgetType: "html",
            settings: {
              converter_v3_source_node_id: "hero-input",
              html: '<input data-capture-id="hero-input" type="email" placeholder="Email" />'
            },
            elements: []
          },
          {
            id: "hero-card-container",
            elType: "container" as const,
            settings: {
              converter_v3_source_node_id: "hero-card"
            },
            elements: []
          }
        ]
      }
    ]
  };

  return {
    capture,
    layout,
    document
  };
}

function createLightClonePreviewHtml() {
  return `<!doctype html>
<html>
  <body style="margin:0;background:#ffffff;color:#111827;font-family:Arial,sans-serif;">
    <main style="padding:48px 56px;">
      <section style="padding:48px 56px;background:#ffffff;">
        <h1>Dark premium hero</h1>
        <a href="#cta" style="display:inline-flex;padding:12px 20px;background:#ffffff;color:#111827;border:1px solid #d1d5db;border-radius:10px;">Start</a>
        <input style="margin-top:20px;width:240px;padding:12px 16px;background:#ffffff;color:#111827;border:1px solid #d1d5db;border-radius:10px;" placeholder="Email" />
        <div class="card" style="margin-top:32px;padding:32px;background:#ffffff;border:1px solid #e5e7eb;border-radius:16px;">Card</div>
      </section>
    </main>
  </body>
</html>`;
}

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

async function testV3HtmlCaptureTreatsInlineSvgAsImageAsset() {
  const html = `<!doctype html>
<html>
  <head>
    <title>Inline SVG Asset</title>
  </head>
  <body>
    <header>
      <svg width="140" height="42" viewBox="0 0 140 42" role="img" aria-label="Brand Logo">
        <rect width="140" height="42" rx="12" fill="#102542" />
        <circle cx="28" cy="21" r="10" fill="#ffd166" />
        <text x="52" y="27" fill="#ffffff" font-size="16">Brand</text>
      </svg>
    </header>
  </body>
</html>`;
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const result = await runCapturePipelineV3FromHtml(html, {
    preferBrowser: true,
    outputRoot
  });
  const svgImageNode = result.layout.nodes.find(
    (node) =>
      node.kind === "image" &&
      node.tag === "svg" &&
      typeof node.content.src === "string" &&
      node.content.src.startsWith("data:image/svg+xml;base64,")
  );

  assert.equal(result.capture.renderer, "browser");
  assert.ok(svgImageNode);
  assert.equal(svgImageNode?.content.alt, "Brand Logo");
}

async function testV3SectionCaptureExpandsForOverflowingHeaderMedia() {
  const html = `<!doctype html>
<html>
  <head>
    <title>Overflow Header Media</title>
    <style>
      html, body { margin: 0; background: #102542; }
      header {
        position: relative;
        width: 240px;
        height: 92px;
        margin: 32px;
        border-radius: 18px;
        background: #102542;
        overflow: visible;
      }
      .brand-lockup {
        position: absolute;
        top: 18px;
        left: 170px;
        width: 120px;
        height: 48px;
      }
    </style>
  </head>
  <body>
    <header>
      <img
        class="brand-lockup"
        alt="Brand Lockup"
        src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMjAiIGhlaWdodD0iNDgiIHZpZXdCb3g9IjAgMCAxMjAgNDgiPjxyZWN0IHdpZHRoPSIxMjAiIGhlaWdodD0iNDgiIHJ4PSIxMiIgZmlsbD0iI2ZmZDE2NiIvPjx0ZXh0IHg9IjE4IiB5PSIzMSIgZm9udC1zaXplPSIxOCIgcG9wdWxhdGlvbj0iQXJpYWwiIGZpbGw9IiMxMDI1NDIiPkJyYW5kPC90ZXh0Pjwvc3ZnPg=="
      />
    </header>
  </body>
</html>`;
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const captureResult = await runCapturePipelineV3FromHtml(html, {
    preferBrowser: true,
    outputRoot
  });
  const sections = await buildVisualSectionCaptures({
    capture: captureResult.capture,
    layout: captureResult.layout,
    outputDir: captureResult.capture.artifacts.outputDir
  });
  const headerSection =
    sections.find((section) => section.type === "header") ??
    sections.find((section) => section.name.startsWith("header-"));
  const desktopViewport = headerSection?.viewports.desktop;

  assert.equal(captureResult.capture.renderer, "browser");
  assert.ok(headerSection);
  assert.ok(desktopViewport?.captureBox);
  assert.equal((desktopViewport?.captureBox?.width ?? 0) > (headerSection?.box.width ?? 0), true);
  assert.equal((headerSection?.debug?.originalImages.length ?? 0) >= 1, true);
}

async function testV3HtmlCaptureCollectsExpandedComputedStyles() {
  const html = `<!doctype html>
<html>
  <head>
    <title>Expanded Computed Styles</title>
    <style>
      .visual-shell {
        position: relative;
        display: grid;
        place-items: center;
        place-content: space-between;
        grid-auto-flow: column;
        grid-auto-columns: minmax(120px, 1fr);
        grid-auto-rows: minmax(48px, auto);
        min-width: 220px;
        max-height: 320px;
        aspect-ratio: 16 / 9;
        background-origin: padding-box;
        background-attachment: local;
        background-blend-mode: multiply;
        isolation: isolate;
        border-width: 2px;
        border-style: solid;
        outline: 2px solid rgba(255, 209, 102, 0.5);
        outline-offset: 3px;
        text-shadow: 0 1px 4px rgba(0, 0, 0, 0.45);
      }
      .overlay {
        position: absolute;
        inset: 12px;
        min-width: 80px;
        max-height: 160px;
        flex-wrap: wrap;
        flex-grow: 1;
        flex-shrink: 0;
        flex-basis: 140px;
        filter: drop-shadow(0 8px 24px rgba(0, 0, 0, 0.35));
        backdrop-filter: blur(8px);
        mix-blend-mode: screen;
      }
    </style>
  </head>
  <body>
    <div class="visual-shell">
      Styled card
      <div class="overlay">Layered overlay</div>
    </div>
  </body>
</html>`;
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const result = await runCapturePipelineV3FromHtml(html, {
    preferBrowser: true,
    outputRoot
  });
  const shellNode = result.capture.nodes.find(
    (node) => node.tag === "div" && node.text.includes("Styled card")
  );
  const overlayNode = result.capture.nodes.find(
    (node) => node.tag === "div" && node.text.includes("Layered overlay")
  );

  assert.ok(CAPTURED_STYLE_PROPERTIES.includes("background-origin"));
  assert.ok(CAPTURED_STYLE_PROPERTIES.includes("background-attachment"));
  assert.ok(CAPTURED_STYLE_PROPERTIES.includes("place-items"));
  assert.ok(CAPTURED_STYLE_PROPERTIES.includes("grid-auto-flow"));
  assert.ok(CAPTURED_STYLE_PROPERTIES.includes("outline-offset"));
  assert.ok(CAPTURED_STYLE_PROPERTIES.includes("mix-blend-mode"));
  assert.ok(shellNode);
  assert.equal(shellNode?.computedStyles["background-origin"], "padding-box");
  assert.equal(shellNode?.computedStyles["background-attachment"], "local");
  assert.equal(shellNode?.computedStyles["background-blend-mode"], "multiply");
  assert.equal(shellNode?.computedStyles.isolation, "isolate");
  assert.ok(shellNode?.computedStyles["place-items"]);
  assert.equal(shellNode?.computedStyles["grid-auto-flow"], "column");
  assert.equal(shellNode?.computedStyles["border-style"], "solid");
  assert.equal(shellNode?.computedStyles["outline-offset"], "3px");
  assert.ok(shellNode?.computedStyles["text-shadow"]);
  assert.ok(overlayNode);
  assert.equal(overlayNode?.computedStyles.inset, "12px");
  assert.equal(overlayNode?.computedStyles["min-width"], "80px");
  assert.equal(overlayNode?.computedStyles["max-height"], "160px");
  assert.equal(overlayNode?.computedStyles["flex-wrap"], "wrap");
  assert.equal(overlayNode?.computedStyles["flex-grow"], "1");
  assert.equal(overlayNode?.computedStyles["flex-shrink"], "0");
  assert.equal(overlayNode?.computedStyles["flex-basis"], "140px");
  assert.ok(overlayNode?.computedStyles.filter);
  assert.ok(overlayNode?.computedStyles["backdrop-filter"]);
  assert.equal(overlayNode?.computedStyles["mix-blend-mode"], "screen");
}

async function testV3HtmlCapturePreservesMultiLayerBackgroundImages() {
  const heroImage =
    "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MDAiIGhlaWdodD0iMjIwIiB2aWV3Qm94PSIwIDAgNDAwIDIyMCI+PHJlY3Qgd2lkdGg9IjQwMCIgaGVpZ2h0PSIyMjAiIGZpbGw9IiMxMDI1NDIiLz48Y2lyY2xlIGN4PSIzMjAiIGN5PSI2MCIgcj0iNDQiIGZpbGw9IiNmZmQxNjYiLz48L3N2Zz4=";
  const html = `<!doctype html>
<html>
  <head>
    <title>Layered Background</title>
    <style>
      .hero {
        width: 420px;
        height: 220px;
        background-image:
          linear-gradient(135deg, rgba(16, 37, 66, 0.92) 0%, rgba(16, 37, 66, 0.35) 100%),
          url("${heroImage}");
        background-size: cover, cover;
        background-position: center, center;
      }
    </style>
  </head>
  <body>
    <section class="hero"></section>
  </body>
</html>`;
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const result = await runCapturePipelineV3FromHtml(html, {
    preferBrowser: true,
    outputRoot
  });
  const heroNode = result.capture.nodes.find((node) => node.tag === "section");

  assert.ok(heroNode);
  assert.match(heroNode?.computedStyles["background-image"] ?? "", /linear-gradient/i);
  assert.match(heroNode?.computedStyles["background-image"] ?? "", /url\(/i);
  assert.equal(heroNode?.asset.backgroundImage, heroNode?.computedStyles["background-image"]);
  assert.deepEqual(
    heroNode?.asset.backgroundLayers?.map((layer) => layer.type),
    ["gradient", "image"]
  );
  assert.equal(heroNode?.asset.backgroundUrls?.[0], heroImage);
}

async function testV3HtmlCaptureTracksPictureSourcesAndLazyImages() {
  const pictureSource =
    "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMjAiIGhlaWdodD0iMTgwIiB2aWV3Qm94PSIwIDAgMzIwIDE4MCI+PHJlY3Qgd2lkdGg9IjMyMCIgaGVpZ2h0PSIxODAiIGZpbGw9IiMxMDI1NDIiLz48L3N2Zz4=";
  const fallbackImage =
    "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMjAiIGhlaWdodD0iMTgwIiB2aWV3Qm94PSIwIDAgMzIwIDE4MCI+PHJlY3Qgd2lkdGg9IjMyMCIgaGVpZ2h0PSIxODAiIGZpbGw9IiNmZmQxNjYiLz48L3N2Zz4=";
  const lazyImage =
    "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNDAiIGhlaWdodD0iMTQwIiB2aWV3Qm94PSIwIDAgMjQwIDE0MCI+PHJlY3Qgd2lkdGg9IjI0MCIgaGVpZ2h0PSIxNDAiIHJ4PSIyNCIgZmlsbD0iI2Y4NzA2MCIvPjwvc3ZnPg==";
  const html = `<!doctype html>
<html>
  <head>
    <title>Picture And Lazy Assets</title>
  </head>
  <body>
    <picture class="hero-picture">
      <source media="(min-width: 300px)" srcset="${pictureSource} 1x" />
      <img src="${fallbackImage}" alt="Responsive visual" />
    </picture>
    <img
      class="lazy-card"
      src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="
      data-src="${lazyImage}"
      alt="Lazy visual"
      loading="lazy"
    />
  </body>
</html>`;
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const result = await runCapturePipelineV3FromHtml(html, {
    preferBrowser: true,
    outputRoot
  });
  const pictureNode = result.capture.nodes.find(
    (node) => node.tag === "picture" && node.attributes.class === "hero-picture"
  );
  const lazyNode = result.capture.nodes.find(
    (node) => node.tag === "img" && node.attributes.class === "lazy-card"
  );

  assert.ok(pictureNode);
  assert.deepEqual(pictureNode?.asset.pictureSources, [pictureSource]);
  assert.equal(pictureNode?.asset.currentSrc, pictureSource);
  assert.equal(pictureNode?.asset.src, pictureSource);
  assert.ok(lazyNode);
  assert.deepEqual(lazyNode?.asset.lazySources, [lazyImage]);
  assert.equal(lazyNode?.asset.currentSrc, lazyImage);
  assert.equal(lazyNode?.asset.src, lazyImage);
}

async function testV3HtmlCaptureWaitsForDelayedFooterContent() {
  const html = `<!doctype html>
<html>
  <head>
    <title>Delayed Footer Capture</title>
    <style>
      body {
        margin: 0;
        font-family: sans-serif;
        background: #f8fafc;
        color: #0f172a;
      }

      main {
        width: min(1120px, calc(100% - 48px));
        margin: 0 auto;
      }

      .spacer {
        height: 2200px;
        padding: 56px 0;
        background: linear-gradient(#ffffff, #e2e8f0);
      }

      footer {
        padding: 32px 24px;
        background: #111827;
        color: #ffffff;
      }
    </style>
  </head>
  <body>
    <main>
      <section class="spacer">
        <h1>Scroll to reveal delayed content</h1>
        <p>The footer appears only after the sentinel is brought into view.</p>
      </section>
      <div id="footer-sentinel" style="height:1px"></div>
    </main>
    <script>
      const sentinel = document.getElementById("footer-sentinel");
      const appendFooter = () => {
        if (document.querySelector("footer")) {
          return;
        }

        const footer = document.createElement("footer");
        footer.textContent = "FOOTER LOADED";
        document.body.appendChild(footer);
      };

      const observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setTimeout(appendFooter, 1000);
          observer.disconnect();
        }
      });

      observer.observe(sentinel);
    </script>
  </body>
</html>`;
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const result = await runCapturePipelineV3FromHtml(html, {
    preferBrowser: true,
    outputRoot
  });
  const footerNode = result.capture.nodes.find(
    (node) => node.tag === "footer" && (node.text || "").includes("FOOTER LOADED")
  );

  assert.ok(footerNode);
  assert.equal(footerNode?.isVisible, true);
  assert.equal(result.capture.inputAnalysis.diagnostics.htmlRendered, true);
}

async function testV3HtmlCaptureDetectsVisualPseudoElements() {
  const html = `<!doctype html>
<html>
  <head>
    <title>Pseudo Capture</title>
    <style>
      .card {
        position: relative;
        width: 180px;
        height: 96px;
        background: #102542;
      }
      .card::before {
        content: "";
        position: absolute;
        left: 12px;
        top: 14px;
        width: 44px;
        height: 44px;
        opacity: 0.95;
        border: 1px solid rgba(255, 209, 102, 0.4);
        box-shadow: 0 0 18px rgba(255, 209, 102, 0.25);
        background-image: linear-gradient(135deg, rgba(255, 209, 102, 0.95), rgba(255, 209, 102, 0.35));
      }
    </style>
  </head>
  <body>
    <div class="card"></div>
  </body>
</html>`;
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const result = await runCapturePipelineV3FromHtml(html, {
    preferBrowser: true,
    outputRoot
  });
  const cardNode = result.capture.nodes.find(
    (node) => node.tag === "div" && node.attributes.class === "card"
  );
  const beforePseudo = cardNode?.pseudoElements?.find((pseudo) => pseudo.pseudo === "::before");

  assert.ok(cardNode);
  assert.ok(beforePseudo);
  assert.equal(beforePseudo?.isVisible, true);
  assert.equal(beforePseudo?.box?.width, 44);
  assert.equal(beforePseudo?.box?.height, 44);
  assert.ok(beforePseudo?.computedStyles["background-image"]);
  assert.ok(beforePseudo?.computedStyles["box-shadow"]);
  assert.equal(beforePseudo?.asset.backgroundLayers?.[0]?.type, "gradient");
  assert.equal(beforePseudo?.asset.hasGradientBackground, true);
}

async function testV3SectionCaptureTracksHeroOverlayCardImagesAndPseudoBackgrounds() {
  const heroImage =
    "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI3MjAiIGhlaWdodD0iMzYwIiB2aWV3Qm94PSIwIDAgNzIwIDM2MCI+PHJlY3Qgd2lkdGg9IjcyMCIgaGVpZ2h0PSIzNjAiIGZpbGw9IiMxMDI1NDIiLz48Y2lyY2xlIGN4PSI1NzAiIGN5PSI5MCIgcj0iNzIiIGZpbGw9IiNmZmQxNjYiLz48L3N2Zz4=";
  const cardImage =
    "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNDAiIGhlaWdodD0iMTYwIiB2aWV3Qm94PSIwIDAgMjQwIDE2MCI+PHJlY3Qgd2lkdGg9IjI0MCIgaGVpZ2h0PSIxNjAiIHJ4PSIyNCIgZmlsbD0iI2ZmZDE2NiIvPjwvc3ZnPg==";
  const badgeImage =
    "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIgdmlld0JveD0iMCAwIDcyIDcyIj48Y2lyY2xlIGN4PSIzNiIgY3k9IjM2IiByPSIzNiIgZmlsbD0iI2ZmZDE2NiIvPjwvc3ZnPg==";
  const html = `<!doctype html>
<html>
  <head>
    <title>Hero Overlay Cards</title>
    <style>
      html, body { margin: 0; background: #f4efe8; }
      .hero {
        position: relative;
        min-height: 420px;
        padding: 48px;
        color: white;
        background-image:
          linear-gradient(135deg, rgba(16, 37, 66, 0.9), rgba(16, 37, 66, 0.28)),
          url("${heroImage}");
        background-size: cover, cover;
        background-position: center, center;
        overflow: hidden;
      }
      .hero::after {
        content: "";
        position: absolute;
        inset: 24px;
        border-radius: 28px;
        background-image: linear-gradient(135deg, rgba(255, 209, 102, 0.18), rgba(255, 209, 102, 0));
        pointer-events: none;
      }
      .cards {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 20px;
        margin-top: 28px;
      }
      .card {
        position: relative;
        padding: 20px;
        border-radius: 24px;
        background: rgba(255, 255, 255, 0.14);
      }
      .card::before {
        content: "";
        position: absolute;
        top: 14px;
        right: 14px;
        width: 36px;
        height: 36px;
        background-image: url("${badgeImage}");
        background-size: cover;
      }
      .card img {
        display: block;
        width: 100%;
        border-radius: 18px;
      }
    </style>
  </head>
  <body>
    <section class="hero">
      <h1>Visual hero</h1>
      <div class="cards">
        <article class="card">
          <img src="${cardImage}" alt="Card visual" />
          <p>Card content</p>
        </article>
      </div>
    </section>
  </body>
</html>`;
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const captureResult = await runCapturePipelineV3FromHtml(html, {
    preferBrowser: true,
    outputRoot
  });
  const sections = await buildVisualSectionCaptures({
    capture: captureResult.capture,
    layout: captureResult.layout,
    outputDir: captureResult.capture.artifacts.outputDir
  });
  const heroSection = sections.find((section) => /class="hero"/i.test(section.originalHtml));

  assert.ok(heroSection);
  assert.equal(heroSection?.complexity.hasPseudoElements, true);
  assert.equal(
    heroSection?.debug?.cssBackgrounds.some(
      (background) =>
        background.status === "loaded" &&
        background.hasGradient &&
        (background.backgroundUrls?.length ?? 0) === 1
    ),
    true
  );
  assert.equal(
    heroSection?.debug?.cssBackgrounds.some(
      (background) => background.pseudo === "::before" && background.status === "loaded"
    ),
    true
  );
  assert.equal(
    heroSection?.debug?.originalImages.some(
      (image) => image.alt === "Card visual" && image.status === "loaded"
    ),
    true
  );
}

async function testV3BrowserDiagnosticsResolveRelativeHeroCardAndPseudoAssets() {
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const sourceRoot = path.join(outputRoot, "relative-asset-diagnostics");
  const assetDir = path.join(sourceRoot, "assets");

  await mkdir(assetDir, { recursive: true });
  await writeFile(
    path.join(assetDir, "hero.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="360" viewBox="0 0 720 360"><rect width="720" height="360" fill="#102542" /><circle cx="570" cy="90" r="72" fill="#ffd166" /></svg>`
  );
  await writeFile(
    path.join(assetDir, "card.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160" viewBox="0 0 240 160"><rect width="240" height="160" rx="24" fill="#ffd166" /></svg>`
  );
  await writeFile(
    path.join(assetDir, "badge.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72"><circle cx="36" cy="36" r="36" fill="#ffd166" /></svg>`
  );
  await writeFile(
    path.join(sourceRoot, "index.html"),
    `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Relative Asset Diagnostics</title>
    <style>
      body { margin: 0; font-family: Arial, sans-serif; }
      .hero {
        min-height: 320px;
        padding: 32px;
        background-image: linear-gradient(135deg, rgba(16, 37, 66, 0.88), rgba(16, 37, 66, 0.24)), url("./assets/hero.svg");
        background-size: cover, cover;
      }
      .card {
        position: relative;
        width: 240px;
        margin: 24px 32px;
        padding: 16px;
        border-radius: 20px;
        background: #fff;
      }
      .card::before {
        content: "";
        position: absolute;
        top: 12px;
        right: 12px;
        width: 28px;
        height: 28px;
        background-image: url("./assets/badge.svg");
        background-size: cover;
      }
      .card img { width: 100%; display: block; }
    </style>
  </head>
  <body>
    <section class="hero"><h1>Relative hero</h1></section>
    <article class="card"><img src="./assets/card.svg" alt="Card asset" /></article>
  </body>
</html>`
  );

  const resolvedSource = await resolveSourceFromLocalFile(path.join(sourceRoot, "index.html"));
  const captureResult = await runCapturePipelineV3(resolvedSource, {
    preferBrowser: true,
    outputRoot
  });
  const resources = captureResult.capture.inputAnalysis.diagnostics.resources;

  assert.equal(captureResult.capture.inputAnalysis.diagnostics.relativeAssetsResolved, true);
  assert.equal(
    resources.some(
      (resource) => resource.diagnostic === "background image loaded" && resource.status === "loaded"
    ),
    true
  );
  assert.equal(
    resources.some(
      (resource) => resource.diagnostic === "inline image loaded" && resource.status === "loaded"
    ),
    true
  );
  assert.equal(
    resources.some(
      (resource) =>
        resource.diagnostic === "pseudo-element background loaded" && resource.status === "loaded"
    ),
    true
  );
}

async function testV3CriticalAssetFailuresPromoteSnapshotFallback() {
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const sourceRoot = path.join(outputRoot, "critical-asset-failures");

  await mkdir(sourceRoot, { recursive: true });
  await writeFile(
    path.join(sourceRoot, "index.html"),
    `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Critical Asset Failures</title>
    <style>
      body { margin: 0; font-family: Arial, sans-serif; }
      .hero {
        min-height: 320px;
        padding: 32px;
        color: white;
        background-image: linear-gradient(135deg, rgba(16, 37, 66, 0.88), rgba(16, 37, 66, 0.24)), url("./assets/missing-hero.svg");
        background-size: cover, cover;
      }
      .card {
        width: 240px;
        margin: 24px 32px;
        padding: 16px;
        border-radius: 20px;
        background: #fff;
      }
      .card img { width: 100%; display: block; }
    </style>
  </head>
  <body>
    <section class="hero"><h1>Broken hero</h1></section>
    <article class="card"><img src="./assets/missing-card.svg" alt="Missing card asset" /></article>
  </body>
</html>`
  );

  const result = await withSnapshotFlagsDisabled(async () => {
    const resolvedSource = await resolveSourceFromLocalFile(path.join(sourceRoot, "index.html"));
    return runExportPipelineV3(resolvedSource, {
      preferBrowser: true,
      outputRoot
    });
  });
  const resources = result.capture.inputAnalysis.diagnostics.resources;

  assert.equal(
    resources.some(
      (resource) =>
        resource.diagnostic === "hero background missing" &&
        resource.status === "failed" &&
        resource.critical === true
    ),
    true
  );
  assert.equal(
    resources.some(
      (resource) =>
        resource.diagnostic === "card image missing" &&
        resource.status === "failed" &&
        resource.critical === true
    ),
    true
  );
  assert.equal(result.analysis.selectedMode, "snapshot");
  assert.equal(["snapshot", "pixel-perfect"].includes(result.emittedMode), true);
}

async function testV3HtmlCapturePreservesThemeCssVariables() {
  const html = `<!doctype html>
<html>
  <head>
    <title>Theme Variables</title>
    <style>
      :root {
        --background: 222 47% 11%;
        --foreground: 210 40% 98%;
        --card: 224 29% 14%;
        --accent: 43 96% 56%;
        --border: 217 33% 22%;
        --radius: 1rem;
      }
      body {
        background: hsl(var(--background));
        color: hsl(var(--foreground));
      }
      .card {
        width: 260px;
        padding: 24px;
        background: hsl(var(--card));
        border: 1px solid hsl(var(--border));
        border-radius: var(--radius);
      }
    </style>
  </head>
  <body>
    <section class="card">Premium card</section>
  </body>
</html>`;
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const result = await runCapturePipelineV3FromHtml(html, {
    preferBrowser: true,
    outputRoot
  });
  const bodyNode = result.capture.nodes.find((node) => node.tag === "body");
  const cardNode = result.capture.nodes.find(
    (node) => node.tag === "section" && node.text.includes("Premium card")
  );

  assert.ok(bodyNode);
  assert.ok(cardNode);
  assert.equal(bodyNode?.computedStyles["--background"], "222 47% 11%");
  assert.equal(bodyNode?.computedStyles["--foreground"], "210 40% 98%");
  assert.equal(cardNode?.computedStyles["--card"], "224 29% 14%");
  assert.equal(cardNode?.computedStyles["--border"], "217 33% 22%");
  assert.equal(cardNode?.computedStyles["--radius"], "1rem");
}

async function testV3ThemeDetectorIdentifiesDarkFixtures() {
  const html = `<!doctype html>
<html style="background:#020617;">
  <head>
    <title>Dark Theme Fixture</title>
    <style>
      :root {
        --background: 222 47% 11%;
        --foreground: 210 40% 98%;
        --card: 224 29% 14%;
        --border: 217 33% 22%;
        --primary: 43 96% 56%;
      }
      html, body {
        margin: 0;
        background: hsl(var(--background));
        color: hsl(var(--foreground));
        font-family: "Space Grotesk", sans-serif;
      }
      main {
        padding: 32px;
      }
      header, footer, .card, input, .cta {
        border-radius: 18px;
        border: 1px solid hsl(var(--border));
        background: hsl(var(--card));
        box-shadow: 0 24px 60px rgba(2, 6, 23, 0.45);
      }
      h1 {
        font-size: 56px;
      }
      p, input {
        font-size: 18px;
      }
      .stack > * + * {
        margin-top: 40px;
      }
      .cta {
        display: inline-flex;
        padding: 14px 24px;
        color: hsl(var(--background));
        background: hsl(var(--primary));
      }
      input {
        width: 320px;
        padding: 14px 18px;
        color: hsl(var(--foreground));
      }
    </style>
  </head>
  <body>
    <main class="stack">
      <header>Premium Header</header>
      <section class="card">
        <h1>Dark premium hero</h1>
        <p>Elegant contrast with layered surfaces.</p>
        <a class="cta" href="#buy">Buy now</a>
      </section>
      <section class="card"><input placeholder="Email" /></section>
      <footer>Footer</footer>
    </main>
  </body>
</html>`;
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const result = await runCapturePipelineV3FromHtml(html, {
    preferBrowser: true,
    outputRoot
  });

  assert.equal(result.capture.themeAnalysis?.detectedTheme, "dark");
  assert.equal(result.capture.themeAnalysis?.messages.includes("dark theme detected"), true);
  const darkBackground = parseRgbChannels(result.capture.themeAnalysis?.designTokens.globalBackground);
  const darkCard = parseRgbChannels(result.capture.themeAnalysis?.designTokens.cardBackground);
  const darkButton = parseRgbChannels(result.capture.themeAnalysis?.designTokens.primaryButtonColor);

  assert.ok(darkBackground);
  assert.equal((darkBackground?.r ?? 255) <= 20, true);
  assert.equal((darkBackground?.g ?? 255) <= 30, true);
  assert.equal((darkBackground?.b ?? 255) <= 50, true);
  assert.ok(darkCard);
  assert.equal((darkCard?.r ?? 255) <= 40, true);
  assert.equal((darkCard?.g ?? 255) <= 50, true);
  assert.equal((darkCard?.b ?? 255) <= 60, true);
  assert.ok(darkButton);
  assert.equal((darkButton?.r ?? 0) >= 220, true);
  assert.equal((darkButton?.g ?? 0) >= 150, true);
  assert.equal((darkButton?.b ?? 255) <= 60, true);
  assert.equal(result.capture.themeAnalysis?.designTokens.fontFamily, "Space Grotesk");
  assert.equal(result.capture.themeAnalysis?.roleCounts.cards >= 2, true);
}

async function testV3ThemeDetectorIdentifiesLightFixtures() {
  const html = `<!doctype html>
<html style="background:#f8fafc;">
  <head>
    <title>Light Theme Fixture</title>
    <style>
      html, body {
        margin: 0;
        background: #f8fafc;
        color: #0f172a;
        font-family: "DM Sans", sans-serif;
      }
      header, footer, .card {
        background: #ffffff;
        border: 1px solid #dbe4f0;
        border-radius: 16px;
        box-shadow: 0 20px 45px rgba(148, 163, 184, 0.18);
      }
      main {
        padding: 32px;
      }
      h1 {
        font-size: 52px;
      }
      p {
        font-size: 17px;
      }
      .card + .card {
        margin-top: 36px;
      }
      .cta {
        display: inline-flex;
        padding: 14px 24px;
        color: #ffffff;
        background: #2563eb;
        border-radius: 14px;
      }
    </style>
  </head>
  <body>
    <main>
      <header>Clean Header</header>
      <section class="card">
        <h1>Light hero</h1>
        <p>Bright landing page.</p>
        <a class="cta" href="#start">Start</a>
      </section>
      <section class="card">Card</section>
      <footer>Footer</footer>
    </main>
  </body>
</html>`;
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const result = await runCapturePipelineV3FromHtml(html, {
    preferBrowser: true,
    outputRoot
  });

  assert.equal(result.capture.themeAnalysis?.detectedTheme, "light");
  assert.equal(result.capture.themeAnalysis?.messages.includes("light theme detected"), true);
  const lightBackground = parseRgbChannels(result.capture.themeAnalysis?.designTokens.globalBackground);
  const lightCard = parseRgbChannels(result.capture.themeAnalysis?.designTokens.cardBackground);
  const lightButton = parseRgbChannels(result.capture.themeAnalysis?.designTokens.primaryButtonColor);

  assert.ok(lightBackground);
  assert.equal((lightBackground?.r ?? 0) >= 240, true);
  assert.equal((lightBackground?.g ?? 0) >= 245, true);
  assert.equal((lightBackground?.b ?? 0) >= 248, true);
  assert.ok(lightCard);
  assert.equal((lightCard?.r ?? 0) >= 250, true);
  assert.equal((lightCard?.g ?? 0) >= 250, true);
  assert.equal((lightCard?.b ?? 0) >= 250, true);
  assert.ok(lightButton);
  assert.equal((lightButton?.r ?? 255) <= 60, true);
  assert.equal((lightButton?.g ?? 255) <= 120, true);
  assert.equal((lightButton?.b ?? 0) >= 200, true);
}

async function testV3ThemeAuditFailsWhenDarkSourceTurnsIntoLightClone() {
  const html = `<!doctype html>
<html>
  <head>
    <title>Dark Source Audit</title>
    <style>
      html, body {
        margin: 0;
        background: #020617;
        color: #f8fafc;
      }
      .card {
        margin: 32px;
        padding: 24px;
        background: #111827;
        border: 1px solid #334155;
        border-radius: 18px;
      }
      .cta {
        display: inline-flex;
        padding: 12px 20px;
        color: #020617;
        background: #f59e0b;
        border-radius: 14px;
      }
      input {
        margin-top: 20px;
        width: 240px;
        padding: 12px 16px;
        background: #111827;
        color: #f8fafc;
        border: 1px solid #334155;
        border-radius: 14px;
      }
    </style>
  </head>
  <body>
    <main>
      <section class="card">
        <h1>Dark source</h1>
        <a class="cta" href="#cta">Action</a>
        <input placeholder="Email" />
      </section>
    </main>
  </body>
</html>`;
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const result = await runCapturePipelineV3FromHtml(html, {
    preferBrowser: true,
    outputRoot
  });
  const previewHtml = `<!doctype html>
<html>
  <body style="margin:0;background:#ffffff;color:#111827;font-family:Arial,sans-serif;">
    <main style="padding:32px;">
      <section class="card" style="padding:24px;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;">
        <h1>Dark source</h1>
        <a href="#cta" style="display:inline-flex;padding:12px 20px;background:#ffffff;color:#111827;border:1px solid #d1d5db;border-radius:10px;">Action</a>
        <input style="margin-top:20px;width:240px;padding:12px 16px;background:#ffffff;color:#111827;border:1px solid #d1d5db;border-radius:10px;" />
      </section>
    </main>
  </body>
</html>`;
  const audit = auditThemeConsistency({
    sourceThemeAnalysis: result.capture.themeAnalysis,
    previewHtml,
    emittedMode: "editable"
  });

  assert.ok(audit);
  assert.equal(audit?.passed, false);
  assert.equal(audit?.sourceTheme, "dark");
  assert.equal(audit?.convertedTheme, "light");
  assert.equal(audit?.messages.includes("dark theme lost"), true);
  assert.equal(audit?.messages.includes("card background mismatch"), true);
  assert.equal(audit?.messages.includes("default button style detected"), true);
  assert.equal(audit?.messages.includes("default input style detected"), true);
}

async function testV3ThemeAuditFlagsGlobalBackgroundMismatchInsideDarkTheme() {
  const html = `<!doctype html>
<html>
  <head>
    <title>Dark Source Background Audit</title>
    <style>
      html, body {
        margin: 0;
        background: #020617;
        color: #f8fafc;
      }
      .card {
        margin: 32px;
        padding: 24px;
        background: #111827;
        border: 1px solid #334155;
        border-radius: 18px;
      }
    </style>
  </head>
  <body>
    <main>
      <section class="card">
        <h1>Dark source</h1>
        <p>Premium shell</p>
      </section>
    </main>
  </body>
</html>`;
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const result = await runCapturePipelineV3FromHtml(html, {
    preferBrowser: true,
    outputRoot
  });
  const previewHtml = `<!doctype html>
<html>
  <body style="margin:0;background:#334155;color:#f8fafc;font-family:Arial,sans-serif;">
    <main style="padding:32px;">
      <section class="card" style="padding:24px;background:#475569;border:1px solid #64748b;border-radius:18px;">
        <h1>Dark source</h1>
        <p>Premium shell</p>
      </section>
    </main>
  </body>
</html>`;
  const audit = auditThemeConsistency({
    sourceThemeAnalysis: result.capture.themeAnalysis,
    previewHtml,
    emittedMode: "editable"
  });

  assert.ok(audit);
  assert.equal(audit?.passed, false);
  assert.equal(audit?.sourceTheme, "dark");
  assert.equal(audit?.convertedTheme, "dark");
  assert.equal(audit?.messages.includes("theme mismatch"), true);
  assert.equal(
    audit?.issues.some(
      (issue) => issue.type === "theme-mismatch" && /theme mismatch/i.test(issue.message)
    ),
    true
  );
  assert.equal(audit?.messages.includes("dark theme lost"), false);
}

function testV3VisualAuditFlagsDarkCloneAndWhiteCards() {
  const fixture = createVisualAuditFixture();
  const report = validateElementorExport({
    capture: fixture.capture,
    layout: fixture.layout,
    document: fixture.document,
    mode: "editable",
    previewHtml: createLightClonePreviewHtml()
  });

  assert.equal(report.passed, false);
  assert.equal(report.highestSeverity, "blocking");
  assert.equal(
    report.issues.some((issue) => issue.type === "body-white-on-dark" && /dark theme lost/i.test(issue.message)),
    true
  );
  assert.equal(
    report.issues.some((issue) => issue.type === "card-background-mismatch" && /card background mismatch/i.test(issue.message)),
    true
  );
  assert.equal(
    report.issues.some((issue) => issue.type === "dominant-color-mismatch" && /dominant color mismatch/i.test(issue.message)),
    true
  );
}

function testV3VisualAuditFlagsDefaultButtonFixture() {
  const fixture = createVisualAuditFixture();
  const report = validateElementorExport({
    capture: fixture.capture,
    layout: fixture.layout,
    document: fixture.document,
    mode: "editable",
    previewHtml: createLightClonePreviewHtml()
  });

  assert.equal(
    report.issues.some(
      (issue) =>
        issue.type === "default-button-style-detected" &&
        /default button style detected/i.test(issue.message)
    ),
    true
  );
}

function testV3VisualAuditFlagsDefaultInputFixture() {
  const fixture = createVisualAuditFixture();
  const report = validateElementorExport({
    capture: fixture.capture,
    layout: fixture.layout,
    document: fixture.document,
    mode: "editable",
    previewHtml: createLightClonePreviewHtml()
  });

  assert.equal(
    report.issues.some(
      (issue) =>
        issue.type === "default-input-style-detected" &&
        /default input style detected/i.test(issue.message)
    ),
    true
  );
}

function testV3VisualAuditFlagsHeroOverlayMissingFixture() {
  const fixture = createVisualAuditFixture();
  const report = validateElementorExport({
    capture: fixture.capture,
    layout: fixture.layout,
    document: fixture.document,
    mode: "editable",
    previewHtml: createLightClonePreviewHtml()
  });

  assert.equal(
    report.issues.some(
      (issue) =>
        issue.type === "hero-overlay-missing" && /hero overlay missing/i.test(issue.message)
    ),
    true
  );
  assert.equal(
    report.issues.some(
      (issue) =>
        issue.type === "hero-background-missing" && /hero background missing/i.test(issue.message)
    ),
    true
  );
}

function testV3VisualAuditFlagsImportantVisualAssetMessage() {
  const fixture = createVisualAuditFixture();
  const report = validateElementorExport({
    capture: fixture.capture,
    layout: fixture.layout,
    document: fixture.document,
    mode: "editable",
    previewHtml: createLightClonePreviewHtml()
  });

  assert.equal(
    report.issues.some(
      (issue) =>
        issue.type === "background-mismatch" &&
        /important visual asset missing/i.test(issue.message)
    ),
    true
  );
}

function testV3VisualAuditFlagsWhiteCardsFixture() {
  const fixture = createVisualAuditFixture();
  const report = validateElementorExport({
    capture: fixture.capture,
    layout: fixture.layout,
    document: fixture.document,
    mode: "editable",
    previewHtml: createLightClonePreviewHtml()
  });

  assert.equal(
    report.issues.some(
      (issue) =>
        issue.type === "card-background-mismatch" &&
        /card background mismatch/i.test(issue.message)
    ),
    true
  );
}

function testV3VisualAuditFlagsHeaderFooterMismatchAndPageHeightDifference() {
  const fixture = createVisualAuditFixture();
  fixture.capture.summary.sections = 3;
  fixture.capture.themeAnalysis = {
    ...fixture.capture.themeAnalysis!,
    roleCounts: {
      ...fixture.capture.themeAnalysis!.roleCounts,
      headers: 1,
      footers: 1,
      sections: 3
    }
  };
  fixture.layout.sectionIds = ["header-shell", "hero-section", "footer-shell"];
  fixture.layout.semanticIndex = {
    ...fixture.layout.semanticIndex,
    header: ["header-shell"],
    footer: ["footer-shell"]
  };
  fixture.layout.nodes.unshift({
    id: "header-shell",
    tag: "header",
    kind: "section",
    parentId: "page",
    children: ["header-title"],
    box: {
      x: 0,
      y: 0,
      width: 1200,
      height: 96
    },
    visualOrder: -1,
    layout: {},
    spacing: {},
    style: {
      backgroundColor: "#020617"
    },
    content: {},
    flags: {},
    detection: {
      semanticRole: "header",
      confidence: 0.97
    },
    responsive: {}
  });
  fixture.layout.nodes.push(
    {
      id: "footer-shell",
      tag: "footer",
      kind: "section",
      parentId: "page",
      children: ["footer-text"],
      box: {
        x: 0,
        y: 980,
        width: 1200,
        height: 160
      },
      visualOrder: 10,
      layout: {},
      spacing: {},
      style: {
        backgroundColor: "#020617"
      },
      content: {},
      flags: {},
      detection: {
        semanticRole: "footer",
        confidence: 0.96
      },
      responsive: {}
    },
    {
      id: "footer-text",
      tag: "p",
      kind: "text",
      parentId: "footer-shell",
      children: [],
      box: {
        x: 48,
        y: 1036,
        width: 320,
        height: 24
      },
      visualOrder: 11,
      layout: {},
      spacing: {},
      style: {
        color: "#f8fafc"
      },
      content: {
        text: "Premium footer"
      },
      flags: {},
      responsive: {}
    }
  );
  fixture.layout.detectedSections = [
    {
      id: "header-shell",
      type: "header",
      confidence: 0.97,
      childIds: ["header-title"],
      anchors: [],
      contains: ["header"]
    },
    ...fixture.layout.detectedSections,
    {
      id: "footer-shell",
      type: "footer",
      confidence: 0.96,
      childIds: ["footer-text"],
      anchors: [],
      contains: ["footer"]
    }
  ];
  fixture.document.content.unshift({
    id: "header-shell-container",
    elType: "container",
    settings: {
      converter_v3_source_node_id: "header-shell"
    },
    elements: [
      {
        id: "header-title-widget",
        elType: "widget",
        widgetType: "heading",
        settings: {
          converter_v3_source_node_id: "header-title",
          title: "Header"
        },
        elements: []
      }
    ]
  } as (typeof fixture.document.content)[number]);

  const report = validateElementorExport({
    capture: fixture.capture,
    layout: fixture.layout,
    document: fixture.document,
    mode: "editable",
    previewHtml: createLightClonePreviewHtml()
  });

  assert.equal(
    report.issues.some(
      (issue) =>
        issue.type === "header-footer-background-mismatch" &&
        /header\/footer background mismatch/i.test(issue.message)
    ),
    true
  );
  assert.equal(
    report.issues.some(
      (issue) => issue.type === "height-mismatch" && /page height mismatch/i.test(issue.message)
    ),
    true
  );
}

function testV3VisualClonePolicyPromotesHighRiskLovableLayouts() {
  const box = {
    x: 0,
    y: 0,
    top: 0,
    right: 1200,
    bottom: 420,
    left: 0,
    width: 1200,
    height: 420,
    centerX: 600,
    centerY: 210
  };
  const capture = createMockCapture({
    sourceKind: "lovable-react-source",
    inputAnalysis: createMockInputAnalysis({
      layoutTypes: ["lovable-export", "tailwind", "react-runtime", "scripted"],
      frameworkHints: ["lovable", "tailwind", "react"],
      structure: {
        heroSections: 1,
        cards: 2,
        buttons: 2,
        images: 3,
        backgrounds: 3,
        forms: 1,
        absoluteFixedSticky: 6,
        zIndexNodes: 7,
        transformedElements: 4,
        outOfFlowElements: 9
      } as InputPageAnalysis["structure"],
      renderStrategy: {
        requiresBrowserRender: true,
        preferVisualSnapshot: true,
        preferFullPageSnapshot: false,
        safeSectionExtraction: false,
        reasons: ["High risk Lovable visual policy test."]
      }
    }),
    themeAnalysis: {
      detectedTheme: "dark",
      dominantBackgroundLuminance: 0.018,
      dominantContrast: 14.8,
      colorSamples: [],
      designTokens: {
        globalBackground: "rgb(2, 6, 23)",
        foreground: "rgb(248, 250, 252)",
        cardBackground: "rgb(15, 23, 42)",
        primaryButtonColor: "rgb(56, 189, 248)",
        borderColor: "rgb(51, 65, 85)",
        radius: "18px",
        shadow: "0 20px 80px rgba(15, 23, 42, 0.45)"
      },
      styleSignals: {
        hasStrongDarkTheme: true,
        hasStyledButtons: true,
        hasStyledInputs: true,
        hasElevatedCards: true
      },
      roleCounts: {
        cards: 2,
        buttons: 2,
        inputs: 1,
        headers: 1,
        footers: 1,
        sections: 2
      },
      messages: ["dark theme detected"]
    },
    nodes: [
      {
        id: "hero-section",
        tag: "section",
        text: "",
        attributes: {
          class:
            "relative grid grid-cols-2 overflow-hidden rounded-3xl bg-background text-foreground"
        },
        parentId: "page",
        childIds: ["hero-overlay", "hero-card", "cta-button", "email-input"],
        computedStyles: {
          position: "relative",
          "background-color": "rgb(2, 6, 23)",
          "background-image":
            "linear-gradient(135deg, rgba(15, 23, 42, 0.96), rgba(37, 99, 235, 0.72)), url(hero-visual.png)",
          "z-index": "0"
        },
        box,
        viewportStates: {},
        visualOrder: 0,
        isVisible: true,
        asset: {
          backgroundImage:
            "linear-gradient(135deg, rgba(15, 23, 42, 0.96), rgba(37, 99, 235, 0.72)), url(hero-visual.png)",
          backgroundUrls: ["hero-visual.png"],
          backgroundLayers: [
            {
              index: 0,
              type: "gradient",
              value: "linear-gradient(135deg, rgba(15, 23, 42, 0.96), rgba(37, 99, 235, 0.72))"
            },
            {
              index: 1,
              type: "image",
              value: "url(hero-visual.png)",
              url: "hero-visual.png"
            }
          ],
          hasGradientBackground: true
        },
        pseudoElements: [
          {
            pseudo: "::before",
            content: "\"\"",
            computedStyles: {
              "background-image": "linear-gradient(180deg, rgba(15,23,42,0.2), rgba(15,23,42,0.92))",
              "background-color": "transparent"
            },
            box: null,
            isVisible: true,
            asset: {
              backgroundImage:
                "linear-gradient(180deg, rgba(15,23,42,0.2), rgba(15,23,42,0.92))",
              hasGradientBackground: true,
              backgroundLayers: [
                {
                  index: 0,
                  type: "gradient",
                  value: "linear-gradient(180deg, rgba(15,23,42,0.2), rgba(15,23,42,0.92))"
                }
              ]
            }
          }
        ]
      },
      {
        id: "hero-overlay",
        tag: "div",
        text: "",
        attributes: {
          class:
            "absolute inset-0 z-20 bg-background text-foreground backdrop-blur-xl data-[state=open]:opacity-100"
        },
        parentId: "hero-section",
        childIds: [],
        computedStyles: {
          position: "absolute",
          "background-color": "rgba(15, 23, 42, 0.45)",
          "backdrop-filter": "blur(20px)",
          "z-index": "20"
        },
        box,
        viewportStates: {},
        visualOrder: 1,
        isVisible: true,
        asset: {}
      },
      {
        id: "hero-card",
        tag: "article",
        text: "",
        attributes: {
          class: "rounded-3xl border border-border bg-background shadow-2xl"
        },
        parentId: "hero-section",
        childIds: ["hero-card-image"],
        computedStyles: {
          "background-color": "rgb(15, 23, 42)",
          "border-radius": "24px",
          "box-shadow": "0 24px 64px rgba(15, 23, 42, 0.35)"
        },
        box,
        viewportStates: {},
        visualOrder: 2,
        isVisible: true,
        asset: {}
      },
      {
        id: "hero-card-image",
        tag: "img",
        text: "",
        attributes: {
          alt: "Feature card image"
        },
        parentId: "hero-card",
        childIds: [],
        computedStyles: {},
        box,
        viewportStates: {},
        visualOrder: 3,
        isVisible: true,
        asset: {
          src: "card-visual.png"
        }
      },
      {
        id: "cta-button",
        tag: "a",
        text: "Start now",
        attributes: {
          href: "#start",
          class: "inline-flex rounded-full bg-sky-400 px-6 py-3 font-semibold shadow-xl"
        },
        parentId: "hero-section",
        childIds: [],
        computedStyles: {
          "background-color": "rgb(56, 189, 248)",
          "border-radius": "999px",
          "box-shadow": "0 18px 40px rgba(56, 189, 248, 0.35)"
        },
        box,
        viewportStates: {},
        visualOrder: 4,
        isVisible: true,
        asset: {
          href: "#start"
        }
      },
      {
        id: "email-input",
        tag: "input",
        text: "",
        attributes: {
          type: "email",
          class: "rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-slate-100"
        },
        parentId: "hero-section",
        childIds: [],
        computedStyles: {
          "background-color": "rgb(15, 23, 42)",
          "border-radius": "14px",
          "box-shadow": "0 12px 24px rgba(15, 23, 42, 0.22)"
        },
        box,
        viewportStates: {},
        visualOrder: 5,
        isVisible: true,
        asset: {}
      }
    ],
    summary: {
      totalNodes: 6,
      visibleNodes: 6,
      links: 1,
      images: 2,
      buttons: 2,
      textBlocks: 2,
      visualContainers: 3,
      geometryGroups: 2,
      sections: 1
    }
  });
  const layout: LayoutDocument = {
    id: "visual-policy-risk-layout",
    title: "High Risk Lovable Layout",
    sourceKind: "lovable-react-source",
    rootNodeId: "page",
    nodeCount: 6,
    sectionIds: ["hero-section"],
    semanticIndex: {
      hero: ["hero-section"],
      card: ["hero-card"],
      button: ["cta-button"],
      image: ["hero-card-image"]
    },
    detectedSections: [
      {
        id: "hero-section",
        type: "hero",
        confidence: 0.99,
        childIds: ["hero-overlay", "hero-card", "cta-button", "email-input"],
        anchors: [],
        contains: ["hero", "card", "button", "image", "overlay"]
      }
    ],
    nodes: [
      {
        id: "hero-section",
        tag: "section",
        kind: "section",
        parentId: "page",
        children: ["hero-overlay", "hero-card", "cta-button", "email-input"],
        box: {
          x: 0,
          y: 0,
          width: 1200,
          height: 420
        },
        visualOrder: 0,
        layout: {
          display: "grid",
          gridTemplateColumns: "1.1fr 0.9fr"
        },
        spacing: {},
        style: {
          backgroundColor: "rgb(2, 6, 23)",
          backgroundImage:
            "linear-gradient(135deg, rgba(15, 23, 42, 0.96), rgba(37, 99, 235, 0.72)), url(hero-visual.png)"
        },
        content: {},
        flags: {},
        visual: {
          layer: "background",
          effectiveZIndex: 0
        },
        detection: {
          semanticRole: "hero",
          confidence: 0.99,
          containsInteractive: true,
          containsMedia: true
        },
        responsive: {}
      },
      {
        id: "hero-overlay",
        tag: "div",
        kind: "container",
        parentId: "hero-section",
        children: [],
        box: {
          x: 0,
          y: 0,
          width: 1200,
          height: 420
        },
        visualOrder: 1,
        layout: {
          position: "absolute"
        },
        spacing: {},
        style: {
          backgroundColor: "rgba(15, 23, 42, 0.45)",
          zIndex: "20"
        },
        content: {},
        flags: {
          decorative: true
        },
        visual: {
          layer: "overlay",
          effectiveZIndex: 20,
          overlapCount: 1
        },
        detection: {
          semanticRole: "overlay",
          confidence: 0.98
        },
        responsive: {}
      },
      {
        id: "hero-card",
        tag: "article",
        kind: "container",
        parentId: "hero-section",
        children: ["hero-card-image"],
        box: {
          x: 780,
          y: 60,
          width: 320,
          height: 240
        },
        visualOrder: 2,
        layout: {
          display: "block"
        },
        spacing: {},
        style: {
          backgroundColor: "rgb(15, 23, 42)",
          borderRadius: "24px",
          boxShadow: "0 24px 64px rgba(15, 23, 42, 0.35)"
        },
        content: {},
        flags: {},
        detection: {
          semanticRole: "card",
          confidence: 0.97,
          containsMedia: true
        },
        responsive: {}
      },
      {
        id: "hero-card-image",
        tag: "img",
        kind: "image",
        parentId: "hero-card",
        children: [],
        box: {
          x: 820,
          y: 96,
          width: 240,
          height: 160
        },
        visualOrder: 3,
        layout: {},
        spacing: {},
        style: {},
        content: {
          src: "card-visual.png"
        },
        flags: {},
        detection: {
          semanticRole: "image",
          confidence: 0.96
        },
        responsive: {}
      },
      {
        id: "cta-button",
        tag: "a",
        kind: "button",
        parentId: "hero-section",
        children: [],
        box: {
          x: 120,
          y: 300,
          width: 180,
          height: 48
        },
        visualOrder: 4,
        layout: {},
        spacing: {},
        style: {
          backgroundColor: "rgb(56, 189, 248)",
          borderRadius: "999px",
          boxShadow: "0 18px 40px rgba(56, 189, 248, 0.35)"
        },
        content: {
          href: "#start"
        },
        flags: {},
        detection: {
          semanticRole: "button",
          confidence: 0.95
        },
        responsive: {}
      },
      {
        id: "email-input",
        tag: "input",
        kind: "container",
        parentId: "hero-section",
        children: [],
        box: {
          x: 120,
          y: 360,
          width: 260,
          height: 48
        },
        visualOrder: 5,
        layout: {},
        spacing: {},
        style: {
          backgroundColor: "rgb(15, 23, 42)",
          borderRadius: "14px",
          boxShadow: "0 12px 24px rgba(15, 23, 42, 0.22)"
        },
        content: {},
        flags: {},
        detection: {
          semanticRole: "section",
          confidence: 0.8
        },
        responsive: {}
      }
    ]
  };

  const risk = assessVisualCloneRisk(capture, layout);

  assert.equal(risk.highRisk, true);
  assert.equal(risk.preferSnapshot, true);
  assert.equal(risk.preferFullPageSnapshot, true);
  assert.equal(risk.reasons.includes(VISUAL_REASON_HIGH_RISK), true);
  assert.equal(risk.reasons.includes(VISUAL_REASON_DARK_THEME), true);
  assert.equal(risk.reasons.includes(VISUAL_REASON_HERO_BACKGROUND), true);
  assert.equal(risk.signals.gradientNodes >= 1, true);
  assert.equal(risk.signals.overlayNodes >= 1, true);
  assert.equal(risk.signals.backgroundImageNodes >= 1, true);
  assert.equal(risk.signals.cardMediaNodes >= 1, true);
  assert.equal(risk.signals.shadcnPatternNodes >= 1, true);
  assert.equal(risk.signals.tailwindUtilityNodes >= 1, true);
  assert.equal(risk.signals.backdropBlurNodes >= 1, true);
  assert.equal(risk.signals.highZIndexNodes >= 1, true);
  assert.equal(risk.signals.pseudoVisualNodes >= 1, true);
  assert.equal(risk.signals.styledButtons >= 1, true);
  assert.equal(risk.signals.styledInputs >= 1, true);
}

function testV3VisualClonePolicyPromotesHighRiskDarkGenericLayouts() {
  const box = {
    x: 0,
    y: 0,
    top: 0,
    right: 1200,
    bottom: 420,
    left: 0,
    width: 1200,
    height: 420,
    centerX: 600,
    centerY: 210
  };
  const capture = createMockCapture({
    sourceKind: "raw-html",
    inputAnalysis: createMockInputAnalysis({
      layoutTypes: ["static-html", "tailwind"],
      frameworkHints: ["tailwind"],
      diagnostics: {
        htmlRendered: true,
        rendererUsed: "browser"
      } as InputPageAnalysis["diagnostics"],
      structure: {
        heroSections: 1,
        cards: 2,
        buttons: 2,
        backgrounds: 2,
        forms: 1,
        absoluteFixedSticky: 4,
        zIndexNodes: 4,
        transformedElements: 2,
        outOfFlowElements: 6
      } as InputPageAnalysis["structure"],
      renderStrategy: {
        requiresBrowserRender: true,
        preferVisualSnapshot: false,
        preferFullPageSnapshot: false,
        safeSectionExtraction: false,
        reasons: ["High risk generic dark visual policy test."]
      }
    }),
    themeAnalysis: {
      detectedTheme: "dark",
      dominantBackgroundLuminance: 0.018,
      dominantContrast: 14.8,
      colorSamples: [],
      designTokens: {
        globalBackground: "rgb(2, 6, 23)",
        foreground: "rgb(248, 250, 252)",
        cardBackground: "rgb(15, 23, 42)"
      },
      styleSignals: {
        hasStrongDarkTheme: true,
        hasStyledButtons: true,
        hasStyledInputs: true,
        hasElevatedCards: true
      },
      roleCounts: {
        cards: 2,
        buttons: 2,
        inputs: 1,
        headers: 0,
        footers: 0,
        sections: 1
      },
      messages: ["dark theme detected"]
    },
    nodes: [
      {
        id: "hero-section",
        tag: "section",
        text: "",
        attributes: {
          class: "relative grid rounded-3xl bg-slate-950 text-slate-100"
        },
        parentId: "page",
        childIds: ["hero-overlay", "cta-button", "email-input"],
        computedStyles: {
          position: "relative",
          "background-color": "rgb(2, 6, 23)",
          "background-image":
            "linear-gradient(135deg, rgba(15, 23, 42, 0.96), rgba(37, 99, 235, 0.72)), url(hero-visual.png)"
        },
        box,
        viewportStates: {},
        visualOrder: 0,
        isVisible: true,
        asset: {
          backgroundImage:
            "linear-gradient(135deg, rgba(15, 23, 42, 0.96), rgba(37, 99, 235, 0.72)), url(hero-visual.png)",
          backgroundUrls: ["hero-visual.png"],
          hasGradientBackground: true
        },
        pseudoElements: [
          {
            pseudo: "::before",
            content: "\"\"",
            computedStyles: {
              "background-image": "linear-gradient(180deg, rgba(15,23,42,0.2), rgba(15,23,42,0.92))"
            },
            box: null,
            isVisible: true,
            asset: {
              hasGradientBackground: true
            }
          }
        ]
      },
      {
        id: "hero-overlay",
        tag: "div",
        text: "",
        attributes: {
          class: "absolute inset-0 z-20 backdrop-blur-xl"
        },
        parentId: "hero-section",
        childIds: [],
        computedStyles: {
          position: "absolute",
          "background-color": "rgba(15, 23, 42, 0.45)",
          "backdrop-filter": "blur(20px)",
          "z-index": "20"
        },
        box,
        viewportStates: {},
        visualOrder: 1,
        isVisible: true,
        asset: {}
      },
      {
        id: "cta-button",
        tag: "a",
        text: "Start now",
        attributes: {
          href: "#start",
          class: "inline-flex rounded-full bg-sky-400 px-6 py-3 font-semibold shadow-xl"
        },
        parentId: "hero-section",
        childIds: [],
        computedStyles: {
          "background-color": "rgb(56, 189, 248)",
          "border-radius": "999px",
          "box-shadow": "0 18px 40px rgba(56, 189, 248, 0.35)"
        },
        box,
        viewportStates: {},
        visualOrder: 2,
        isVisible: true,
        asset: {
          href: "#start"
        }
      },
      {
        id: "email-input",
        tag: "input",
        text: "",
        attributes: {
          type: "email",
          class: "rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-slate-100"
        },
        parentId: "hero-section",
        childIds: [],
        computedStyles: {
          "background-color": "rgb(15, 23, 42)",
          "border-radius": "14px",
          "box-shadow": "0 12px 24px rgba(15, 23, 42, 0.22)"
        },
        box,
        viewportStates: {},
        visualOrder: 3,
        isVisible: true,
        asset: {}
      }
    ]
  });
  const layout: LayoutDocument = {
    id: "visual-policy-risk-generic-layout",
    title: "High Risk Generic Dark Layout",
    sourceKind: "raw-html",
    rootNodeId: "page",
    nodeCount: 4,
    sectionIds: ["hero-section"],
    semanticIndex: {
      hero: ["hero-section"]
    },
    detectedSections: [
      {
        id: "hero-section",
        type: "hero",
        confidence: 0.99,
        childIds: ["hero-overlay", "cta-button", "email-input"],
        anchors: [],
        contains: ["hero", "button", "overlay"]
      }
    ],
    nodes: [
      {
        id: "hero-section",
        tag: "section",
        kind: "section",
        parentId: "page",
        children: ["hero-overlay", "cta-button", "email-input"],
        box: {
          x: 0,
          y: 0,
          width: 1200,
          height: 420
        },
        visualOrder: 0,
        layout: {
          display: "grid"
        },
        spacing: {},
        style: {
          backgroundColor: "rgb(2, 6, 23)",
          backgroundImage:
            "linear-gradient(135deg, rgba(15, 23, 42, 0.96), rgba(37, 99, 235, 0.72)), url(hero-visual.png)"
        },
        content: {},
        flags: {},
        visual: {
          layer: "background",
          effectiveZIndex: 0
        },
        detection: {
          semanticRole: "hero",
          confidence: 0.99,
          containsInteractive: true
        },
        responsive: {}
      },
      {
        id: "hero-overlay",
        tag: "div",
        kind: "container",
        parentId: "hero-section",
        children: [],
        box: {
          x: 0,
          y: 0,
          width: 1200,
          height: 420
        },
        visualOrder: 1,
        layout: {
          position: "absolute"
        },
        spacing: {},
        style: {
          backgroundColor: "rgba(15, 23, 42, 0.45)",
          zIndex: "20"
        },
        content: {},
        flags: {
          decorative: true
        },
        visual: {
          layer: "overlay",
          effectiveZIndex: 20,
          overlapCount: 1
        },
        detection: {
          semanticRole: "overlay",
          confidence: 0.98
        },
        responsive: {}
      },
      {
        id: "cta-button",
        tag: "a",
        kind: "button",
        parentId: "hero-section",
        children: [],
        box: {
          x: 48,
          y: 280,
          width: 180,
          height: 52
        },
        visualOrder: 2,
        layout: {},
        spacing: {},
        style: {
          backgroundColor: "rgb(56, 189, 248)",
          borderRadius: "999px",
          boxShadow: "0 18px 40px rgba(56, 189, 248, 0.35)"
        },
        content: {
          text: "Start now",
          href: "#start"
        },
        flags: {},
        detection: {
          semanticRole: "button",
          confidence: 0.96
        },
        responsive: {}
      },
      {
        id: "email-input",
        tag: "input",
        kind: "container",
        parentId: "hero-section",
        children: [],
        box: {
          x: 260,
          y: 280,
          width: 280,
          height: 52
        },
        visualOrder: 3,
        layout: {},
        spacing: {},
        style: {
          backgroundColor: "rgb(15, 23, 42)",
          borderRadius: "14px",
          boxShadow: "0 12px 24px rgba(15, 23, 42, 0.22)"
        },
        content: {},
        flags: {},
        responsive: {}
      }
    ]
  };

  assert.equal(shouldPreferUniversalVisualSnapshot(capture, layout), true);
  assert.equal(shouldForceUniversalFullPageSnapshot(capture, layout), true);
}

async function testV3LovableLikeSitesKeepEditableWhenVisualRiskIsLow() {
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-lovable-low-risk");
  const result = await withSnapshotFlagsDisabled(() =>
    runExportPipelineV3FromHtml(
      `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="generator" content="Lovable" />
    <title>Low Risk Lovable</title>
    <style>
      html, body { margin: 0; background: #ffffff; color: #111827; font-family: Arial, sans-serif; }
      section { padding: 48px 24px; }
      a { display: inline-block; padding: 12px 18px; background: #2563eb; color: #ffffff; border-radius: 8px; text-decoration: none; }
    </style>
  </head>
  <body>
    <section>
      <h1>Simple editable page</h1>
      <p>This Lovable export should stay editable when visual risk is low.</p>
      <a href="#learn">Learn more</a>
    </section>
  </body>
</html>`,
      {
        preferBrowser: true,
        outputRoot
      }
    )
  );

  assert.notEqual(result.analysis.selectedMode, "snapshot");
  assert.notEqual(result.report.selectedMode, "snapshot");
  assert.equal(result.report.selectionReasons?.includes(VISUAL_REASON_HIGH_RISK) ?? false, false);
}

async function testV3ServerRenderedDarkHighRiskPagesJumpToPixelPerfect() {
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-server-dark-high-risk");
  const result = await withSnapshotFlagsDisabled(() =>
    runExportPipelineV3FromHtml(
      `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Server Dark High Risk</title>
    <style>
      html, body {
        margin: 0;
        background: #020617;
        color: #e2e8f0;
        font-family: Arial, sans-serif;
      }
      .hero {
        min-height: 100vh;
        padding: 48px;
        background:
          radial-gradient(circle at top right, rgba(56, 189, 248, 0.34), transparent 35%),
          linear-gradient(145deg, #0f172a, #111827 55%, #1d4ed8);
      }
      .cta {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 50px;
        padding: 0 24px;
        border-radius: 999px;
        background: #f8fafc;
        color: #0f172a;
        text-decoration: none;
        box-shadow: 0 18px 40px rgba(15, 23, 42, 0.35);
      }
      .email {
        display: block;
        margin-top: 18px;
        width: 320px;
        min-height: 50px;
        padding: 0 18px;
        border-radius: 14px;
        border: 1px solid rgba(148, 163, 184, 0.28);
        background: #0f172a;
        color: #e2e8f0;
        box-shadow: 0 12px 24px rgba(15, 23, 42, 0.22);
      }
      .cards {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 20px;
        margin-top: 28px;
      }
      .card {
        padding: 24px;
        border-radius: 24px;
        background: rgba(15, 23, 42, 0.92);
        box-shadow: 0 24px 64px rgba(15, 23, 42, 0.35);
      }
    </style>
  </head>
  <body>
    <section class="hero">
      <h1>Dark premium hero</h1>
      <p>This page should not be accepted as a white generic structural clone.</p>
      <a class="cta" href="#start">Start now</a>
      <input class="email" type="email" placeholder="Email" />
      <div class="cards">
        <article class="card"><h2>Card one</h2></article>
        <article class="card"><h2>Card two</h2></article>
        <article class="card"><h2>Card three</h2></article>
      </div>
    </section>
  </body>
</html>`,
      {
        preferBrowser: false,
        outputRoot
      }
    )
  );

  assert.equal(result.capture.renderer, "server");
  assert.equal(result.analysis.selectedMode, "pixel-perfect");
  assert.equal(result.emittedMode, "pixel-perfect");
  assert.equal(
    result.elementorDocument.content[0]?.settings?.background_color,
    "rgb(2, 6, 23)"
  );
  assert.match(
    String(
      result.elementorDocument.content[0]?.elements?.[0]?.elements?.[0]?.settings?.html ?? ""
    ),
    /background:rgb\(2,\s*6,\s*23\)|background-color:rgb\(2,\s*6,\s*23\)/i
  );
  assert.match(result.report.warnings.join(" "), /pixel-perfect/i);
}

async function testV3ServerFallbackResolvesStylesheetDrivenDarkShell() {
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-server-stylesheet-dark-shell");
  const result = await withSnapshotFlagsDisabled(() =>
    runExportPipelineV3FromHtml(
      `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Server Stylesheet Dark Shell</title>
    <style>
      :root {
        --background: 222.2 47.4% 11.2%;
        --foreground: 210 40% 98%;
        --card: 222.2 47.4% 15%;
        --card-foreground: 210 40% 98%;
        --primary: 211 100% 50%;
        --primary-foreground: 210 40% 98%;
      }
      html, body {
        margin: 0;
        background-color: hsl(var(--background));
        color: hsl(var(--foreground));
        font-family: Arial, sans-serif;
      }
      .hero {
        min-height: 100vh;
        padding: 48px;
        background:
          radial-gradient(circle at top right, rgba(96, 165, 250, 0.28), transparent 36%),
          linear-gradient(145deg, hsl(var(--background)), #020617 55%, #0f172a);
      }
      .card {
        margin-top: 24px;
        padding: 24px;
        border-radius: 24px;
        background-color: hsl(var(--card));
        color: hsl(var(--card-foreground));
        box-shadow: 0 24px 64px rgba(15, 23, 42, 0.35);
      }
      .cta {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 48px;
        padding: 0 22px;
        border-radius: 999px;
        background-color: hsl(var(--primary));
        color: hsl(var(--primary-foreground));
      }
      .search {
        display: block;
        width: 320px;
        min-height: 48px;
        margin-top: 18px;
        padding: 0 18px;
        border-radius: 14px;
        border: 1px solid rgba(148, 163, 184, 0.28);
        background-color: rgba(15, 23, 42, 0.88);
        color: hsl(var(--foreground));
      }
    </style>
  </head>
  <body>
    <section class="hero">
      <h1>Dark token hero</h1>
      <a class="cta" href="#start">Start</a>
      <input class="search" type="search" placeholder="Search" />
      <article class="card">
        <h2>Premium card</h2>
        <p>Dark shell should survive server-side capture.</p>
      </article>
    </section>
  </body>
</html>`,
      {
        preferBrowser: false,
        outputRoot
      }
    )
  );

  const bodyNode = result.capture.nodes.find((node) => node.tag === "body");

  assert.ok(bodyNode);
  assert.equal(result.capture.renderer, "server");
  assert.ok(result.capture.themeAnalysis);
  assert.equal(bodyNode.computedStyles["--background"], "222.2 47.4% 11.2%");
  assert.ok(bodyNode.computedStyles["background-color"]);
  assert.equal(bodyNode.computedStyles["background-color"].includes("var("), false);
  assert.equal(result.capture.themeAnalysis.detectedTheme, "dark");
  assert.equal(result.capture.themeAnalysis.styleSignals?.hasStrongDarkTheme, true);
  assert.equal(result.analysis.selectedMode, "pixel-perfect");
  assert.equal(result.emittedMode, "pixel-perfect");
  assert.equal(
    result.elementorDocument.content[0]?.settings?.background_color,
    "rgb(15, 23, 42)"
  );
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

async function testV3ZipResolverPrefersReactSourceWhenZipIncludesIndexHtml() {
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
    "sample/package.json",
    JSON.stringify({
      name: "lovable-sample",
      private: true,
      scripts: {
        dev: "vite"
      }
    })
  );
  zip.file("sample/src/assets/badge.png", "badge-image");
  zip.file(
    "sample/src/main.tsx",
    `import { createRoot } from "react-dom/client";
import App from "./App";

createRoot(document.getElementById("root")!).render(<App />);`
  );
  zip.file(
    "sample/src/App.tsx",
    `import Hero from "./components/Hero";

export default function App() {
  return (
    <main>
      <Hero title="Universal Lovable" ctaLabel="Buy now" />
    </main>
  );
}`
  );
  zip.file(
    "sample/src/components/Hero.tsx",
    `import badgeImg from "../assets/badge.png";

const highlights = ["Fast", "Flexible"];

export default function Hero({
  title,
  ctaLabel
}: {
  title: string;
  ctaLabel: string;
}) {
  return (
    <section>
      <img src={badgeImg} alt="Badge" />
      <h1>{title}</h1>
      {highlights.map((item) => (
        <p>{item}</p>
      ))}
      <a href="#buy">{ctaLabel}</a>
    </section>
  );
}`
  );

  const file = new File([await zip.generateAsync({ type: "arraybuffer" })], "sample.zip", {
    type: "application/zip"
  });
  const resolved = await resolveSourceFromUpload(file);

  assert.equal(resolved.sourceKind, "lovable-react-source");
  assert.match(resolved.html, /Universal Lovable/);
  assert.match(resolved.html, /Fast/);
  assert.match(resolved.html, /Flexible/);
  assert.match(resolved.html, /Buy now/);
  assert.match(resolved.html, /data:image\/png;base64/);
}

async function testV3ZipResolverSupportsNonStandardEntryAndPageNames() {
  const zip = new JSZip();
  zip.file(
    "sample/index.html",
    `<!doctype html>
<html>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/bootstrap.tsx"></script>
  </body>
</html>`
  );
  zip.file(
    "sample/package.json",
    JSON.stringify({
      name: "lovable-bootstrap-sample",
      private: true,
      scripts: {
        dev: "vite --host"
      }
    })
  );
  zip.file(
    "sample/src/bootstrap.tsx",
    `import { hydrateRoot } from "react-dom/client";
import LandingPage from "./pages/LandingPage";

hydrateRoot(document.getElementById("root")!, <LandingPage />);`
  );
  zip.file(
    "sample/src/pages/LandingPage.tsx",
    `import FeatureCard from "../ui/FeatureCard";

const plans = [
  { title: "Starter", body: "Simple setup" },
  { title: "Scale", body: "Handles larger funnels" }
];

export default function LandingPage() {
  return (
    <section>
      <h1>Another Lovable Layout</h1>
      {plans.map((plan) => (
        <FeatureCard title={plan.title} body={plan.body} />
      ))}
    </section>
  );
}`
  );
  zip.file(
    "sample/src/ui/FeatureCard.tsx",
    `export function FeatureCard({
  title,
  body
}: {
  title: string;
  body: string;
}) {
  return (
    <article>
      <h2>{title}</h2>
      <p>{body}</p>
      <button>Choose</button>
    </article>
  );
}`
  );

  const file = new File([await zip.generateAsync({ type: "arraybuffer" })], "sample.zip", {
    type: "application/zip"
  });
  const resolved = await resolveSourceFromUpload(file);

  assert.equal(resolved.sourceKind, "lovable-react-source");
  assert.match(resolved.html, /Another Lovable Layout/);
  assert.match(resolved.html, /Starter/);
  assert.match(resolved.html, /Simple setup/);
  assert.match(resolved.html, /Scale/);
  assert.match(resolved.html, /Choose/);
}

async function testV3ZipResolverSupportsRouterProvidersAndImportedRouteContent() {
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
    "sample/package.json",
    JSON.stringify({
      name: "lovable-router-provider-sample",
      private: true,
      scripts: {
        dev: "vite"
      }
    })
  );
  zip.file(
    "sample/src/main.tsx",
    `import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { router } from "./router";

createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);`
  );
  zip.file(
    "sample/src/router.tsx",
    `import { createBrowserRouter } from "react-router-dom";
import HomePage from "./pages/HomePage";

export const router = createBrowserRouter([
  {
    path: "/",
    element: <HomePage />
  }
]);`
  );
  zip.file(
    "sample/src/content/siteData.ts",
    `export const plans = [
  { title: "Launch Fast", body: "Build a funnel without waiting on templates." },
  { title: "Scale Cleanly", body: "Keep sections reusable across campaigns." }
];`
  );
  zip.file(
    "sample/src/pages/HomePage.tsx",
    `import { plans } from "../content/siteData";
import { FeatureCard } from "../ui/FeatureCard";

export default function HomePage() {
  return (
    <main>
      <section>
        <h1>Router Based Lovable</h1>
        {plans.map((plan) => (
          <FeatureCard title={plan.title} body={plan.body} />
        ))}
      </section>
    </main>
  );
}`
  );
  zip.file(
    "sample/src/ui/FeatureCard.tsx",
    `export function FeatureCard({
  title,
  body
}: {
  title: string;
  body: string;
}) {
  return (
    <article>
      <h2>{title}</h2>
      <p>{body}</p>
      <a href="#start">Start now</a>
    </article>
  );
}`
  );

  const file = new File([await zip.generateAsync({ type: "arraybuffer" })], "sample.zip", {
    type: "application/zip"
  });
  const resolved = await resolveSourceFromUpload(file);

  assert.equal(resolved.sourceKind, "lovable-react-source");
  assert.match(resolved.html, /Router Based Lovable/);
  assert.match(resolved.html, /Launch Fast/);
  assert.match(resolved.html, /Build a funnel without waiting on templates/);
  assert.match(resolved.html, /Scale Cleanly/);
  assert.match(resolved.html, /Start now/);
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
  logForceVisualSnapshotDebug();

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
  if (isForceVisualSnapshotEnabled()) {
    return;
  }
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const result = await runExportPipelineV3FromHtml(html, {
    preferBrowser: preferBrowserForExportPipelineTests(),
    outputRoot
  });

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

  if (
    assertSnapshotModeWhenForced(result, {
      expectedVisualStatus: expectedForcedSnapshotVisualStatus(),
      preservedLinksAtLeast: 1,
      requireLinkOverlay: true,
      report: {
        emittedMode: report.emittedMode
      },
      document: elementorTemplate
    })
  ) {
    return;
  }

  assertPrimaryMode(result.emittedMode);
  assertPrimaryMode(result.analysis.selectedMode);
  assert.equal(result.fallbackReason, undefined);
  assert.equal(elementorTemplate.title, "Export Test");
  assert.equal(elementorTemplate.content[0].elType, "container");
  assert.equal((elementorTemplate.content[0] as { settings?: { flex_direction?: string } }).settings?.flex_direction, "row");
  const sectionChildren = elementorTemplate.content[0].elements;
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
  assertPrimaryMode(report.emittedMode);
  assertPrimaryMode(report.selectedMode);
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
  if (isForceVisualSnapshotEnabled()) {
    return;
  }
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const result = await runExportPipelineV3FromHtml(html, {
    preferBrowser: preferBrowserForExportPipelineTests(),
    outputRoot
  });

  if (
    assertSnapshotModeWhenForced(result, {
      expectedVisualStatus: expectedForcedSnapshotVisualStatus()
    })
  ) {
    return;
  }

  assert.equal(result.analysis.selectedMode, "hybrid");
  assert.equal(result.emittedMode, "hybrid");
  assert.equal(result.fallbackReason, undefined);
  assert.ok(result.report.warnings.length >= 1);
  assert.equal(result.contentIntegrity.status, "passed");

  const elementorTemplate = JSON.parse(
    await readFile(result.artifacts.elementorTemplatePath, "utf8")
  ) as {
    content: Array<{ elType?: string; widgetType?: string; elements?: Array<{ widgetType?: string }> }>;
  };

  assert.equal(elementorTemplate.content[0].elType, "container");
  assert.equal(elementorTemplate.content[0].elements?.[0]?.widgetType, "html");
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
  if (isForceVisualSnapshotEnabled()) {
    return;
  }
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const result = await runExportPipelineV3FromHtml(html, {
    preferBrowser: preferBrowserForExportPipelineTests(),
    outputRoot
  });

  if (
    assertSnapshotModeWhenForced(result, {
      expectedVisualStatus: expectedForcedSnapshotVisualStatus()
    })
  ) {
    return;
  }

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
  if (isForceVisualSnapshotEnabled()) {
    return;
  }
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const result = await runExportPipelineV3FromHtml(html, {
    preferBrowser: preferBrowserForExportPipelineTests(),
    outputRoot
  });

  if (
    assertSnapshotModeWhenForced(result, {
      expectedVisualStatus: expectedForcedSnapshotVisualStatus(),
      preservedLinksAtLeast: 1,
      requireLinkOverlay: true
    })
  ) {
    return;
  }

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
  if (isForceVisualSnapshotEnabled()) {
    return;
  }
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const result = await runExportPipelineV3FromHtml(html, {
    preferBrowser: preferBrowserForExportPipelineTests(),
    outputRoot
  });

  if (
    assertSnapshotModeWhenForced(result, {
      expectedVisualStatus: expectedForcedSnapshotVisualStatus(),
      preservedLinksAtLeast: 1,
      requireLinkOverlay: true
    })
  ) {
    return;
  }

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
  if (isForceVisualSnapshotEnabled()) {
    return;
  }
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const result = await runExportPipelineV3FromHtml(html, {
    preferBrowser: preferBrowserForExportPipelineTests(),
    outputRoot
  });

  if (
    assertSnapshotModeWhenForced(result, {
      expectedVisualStatus: expectedForcedSnapshotVisualStatus()
    })
  ) {
    return;
  }

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

async function testV3EditableUsesUniversalNeutralModeForLovableLayouts() {
  const html = `<!doctype html>
<html>
  <head>
    <title>Lovable Neutral Pricing Grid</title>
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
    preferBrowser: true,
    outputRoot
  });

  captureResult.capture.sourceKind = "lovable-react-source";
  captureResult.layout.sourceKind = "lovable-react-source";
  captureResult.capture.inputAnalysis = {
    ...captureResult.capture.inputAnalysis,
    frameworkHints: [
      ...new Set<InputFrameworkHint>([
        ...captureResult.capture.inputAnalysis.frameworkHints,
        "lovable",
        "tailwind"
      ])
    ],
    layoutTypes: [
      ...new Set<InputLayoutType>([
        ...captureResult.capture.inputAnalysis.layoutTypes,
        "lovable-export"
      ])
    ]
  };
  captureResult.capture.summary = {
    ...captureResult.capture.summary,
    visualContainers: Math.max(captureResult.capture.summary.visualContainers ?? 0, 3),
    geometryGroups: Math.max(captureResult.capture.summary.geometryGroups ?? 0, 1)
  };

  const editableDocument = createEditableElementorDocumentV3({
    capture: captureResult.capture,
    layout: captureResult.layout,
    selectedMode: "editable"
  }).document as {
    content: Array<{
      settings?: {
        converter_v3_layout?: { preset?: string; universalNeutralMode?: boolean };
        converter_v3_universal_neutral_mode?: boolean;
      };
      elements?: Array<{
        settings?: {
          converter_v3_preset?: string;
          converter_v3_preset_role?: string;
          converter_v3_universal_neutral_mode?: boolean;
        };
        elements?: Array<{
          widgetType?: string;
          settings?: {
            converter_v3_widget_semantic?: string;
            width?: string;
          };
        }>;
      }>;
    }>;
  };

  const topLevel = editableDocument.content[0];
  const cardContainers = topLevel.elements ?? [];
  const nestedWidgets = cardContainers.flatMap((card) => card.elements ?? []);

  assert.equal(topLevel.settings?.converter_v3_layout?.universalNeutralMode, true);
  assert.equal(topLevel.settings?.converter_v3_layout?.preset, "generic");
  assert.ok(
    cardContainers.every(
      (card) =>
        !card.settings?.converter_v3_preset &&
        !card.settings?.converter_v3_preset_role &&
        card.settings?.converter_v3_universal_neutral_mode === true
    )
  );
  assert.ok(
    nestedWidgets.every(
      (widget) =>
        widget.settings?.converter_v3_widget_semantic !== "pricing-cta" &&
        widget.settings?.converter_v3_widget_semantic !== "price"
    )
  );
  assert.ok(
    nestedWidgets.some(
      (widget) =>
        widget.widgetType === "button" &&
        widget.settings?.width !== "100%"
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
  if (isForceVisualSnapshotEnabled()) {
    return;
  }
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const result = await runExportPipelineV3FromHtml(html, {
    preferBrowser: preferBrowserForExportPipelineTests(),
    outputRoot
  });

  if (
    assertSnapshotModeWhenForced(result, {
      expectedVisualStatus: expectedForcedSnapshotVisualStatus(),
      preservedLinksAtLeast: 1,
      requireLinkOverlay: true
    })
  ) {
    return;
  }

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
  if (isForceVisualSnapshotEnabled()) {
    return;
  }
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const result = await runExportPipelineV3FromHtml(html, {
    preferBrowser: preferBrowserForExportPipelineTests(),
    outputRoot
  });

  if (
    assertSnapshotModeWhenForced(result, {
      expectedVisualStatus: expectedForcedSnapshotVisualStatus(),
      preservedLinksAtLeast: 1,
      requireLinkOverlay: true
    })
  ) {
    return;
  }

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
  if (isForceVisualSnapshotEnabled()) {
    return;
  }
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const result = await runExportPipelineV3FromHtml(html, {
    preferBrowser: preferBrowserForExportPipelineTests(),
    outputRoot
  });

  if (
    assertSnapshotModeWhenForced(result, {
      expectedVisualStatus: expectedForcedSnapshotVisualStatus(),
      preservedLinksAtLeast: 1,
      requireLinkOverlay: true
    })
  ) {
    return;
  }

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
  if (isForceVisualSnapshotEnabled()) {
    return;
  }
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const result = await runExportPipelineV3FromHtml(html, {
    preferBrowser: preferBrowserForExportPipelineTests(),
    outputRoot
  });

  if (
    assertSnapshotModeWhenForced(result, {
      expectedVisualStatus: expectedForcedSnapshotVisualStatus()
    })
  ) {
    return;
  }

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
  if (isForceVisualSnapshotEnabled()) {
    return;
  }
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const result = await runExportPipelineV3FromHtml(html, {
    preferBrowser: preferBrowserForExportPipelineTests(),
    outputRoot
  });

  if (
    assertSnapshotModeWhenForced(result, {
      expectedVisualStatus: expectedForcedSnapshotVisualStatus()
    })
  ) {
    return;
  }

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
  if (isForceVisualSnapshotEnabled()) {
    return;
  }
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const result = await runExportPipelineV3FromHtml(html, {
    preferBrowser: preferBrowserForExportPipelineTests(),
    outputRoot
  });

  if (
    assertSnapshotModeWhenForced(result, {
      expectedVisualStatus: expectedForcedSnapshotVisualStatus()
    })
  ) {
    return;
  }

  assertPrimaryMode(result.analysis.selectedMode);
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

async function testV3EditablePreservesStyledButtonVisuals() {
  const html = `<!doctype html>
<html>
  <head>
    <title>Styled Button Preservation</title>
  </head>
  <body>
    <section style="padding:32px;background:#fff7ed;">
      <a
        href="#cta"
        style="display:inline-flex;align-items:center;justify-content:center;padding:16px 28px;border-radius:999px;background:#e11d48;color:#f8fafc;border:1px solid rgba(255,255,255,.22);box-shadow:0 18px 40px rgba(225,29,72,.35);text-decoration:none;"
      >
        Comecar agora
      </a>
    </section>
  </body>
</html>`;
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const captureResult = await runCapturePipelineV3FromHtml(html, {
    preferBrowser: false,
    outputRoot
  });
  const editableResult = createEditableElementorDocumentV3({
    capture: captureResult.capture,
    layout: captureResult.layout,
    selectedMode: "editable"
  });
  const button = findFirstWidget(editableResult.document, "button");
  const previewHtml = buildConvertedPreviewHtml({
    capture: captureResult.capture,
    document: editableResult.document
  });

  assert.ok(button);
  assert.match(
    String(button?.settings?.converter_v3_inline_style ?? ""),
    /padding:16px 28px/i
  );
  assert.match(
    String(button?.settings?.converter_v3_inline_style ?? ""),
    /box-shadow:/i
  );
  assert.match(
    String(button?.settings?.background_color ?? ""),
    /(225,\s*29,\s*72|#e11d48)/i
  );
  assert.match(
    String(button?.settings?.button_text_color ?? button?.settings?.color ?? ""),
    /(248,\s*250,\s*252|#f8fafc)/i
  );
  assert.match(previewHtml, /225,\s*29,\s*72/i);
  assert.match(previewHtml, /padding:16px 28px/i);
  assert.match(previewHtml, /background:transparent/i);
  assert.equal(previewHtml.includes("background:#ffffff"), false);
  assert.equal(previewHtml.includes("background: #ffffff"), false);
  assert.equal(previewHtml.includes("background:#111"), false);
}

async function testV3EditableNormalizesButtonUnderline() {
  const html = `<!doctype html>
<html>
  <head>
    <title>Underline Button Normalization</title>
  </head>
  <body>
    <section style="padding:32px;">
      <a
        href="#cta"
        style="display:inline-flex;align-items:center;justify-content:center;padding:16px 28px;border-radius:999px;background:#e11d48;color:#f8fafc;border:1px solid rgba(255,255,255,.22);box-shadow:0 18px 40px rgba(225,29,72,.35);text-decoration:underline;"
      >
        Comecar agora
      </a>
    </section>
  </body>
</html>`;
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const captureResult = await runCapturePipelineV3FromHtml(html, {
    preferBrowser: false,
    outputRoot
  });
  const editableResult = createEditableElementorDocumentV3({
    capture: captureResult.capture,
    layout: captureResult.layout,
    selectedMode: "editable"
  });
  const button = findFirstWidget(editableResult.document, "button");
  const previewHtml = buildConvertedPreviewHtml({
    capture: captureResult.capture,
    document: editableResult.document
  });

  assert.ok(button);
  assert.equal(
    String(
      (button?.settings?.converter_v3_styles as Record<string, string> | undefined)?.[
        "text-decoration"
      ] ?? ""
    ),
    "none"
  );
  assert.match(
    String(button?.settings?.converter_v3_inline_style ?? ""),
    /text-decoration:\s*none/i
  );
  assert.equal(button?.settings?.typography_typography, "custom");
  assert.equal(button?.settings?.typography_text_decoration, "none");
  assert.equal(button?.settings?.button_typography_text_decoration, "none");
  assert.equal(/text-decoration:\s*underline/i.test(previewHtml), false);
}

async function testV3StyledHtmlFragmentNormalizesDefaultLinkUnderline() {
  const captureNode: PageCapture["nodes"][number] = {
    id: "link-1",
    tag: "a",
    text: "Learn more",
    attributes: {
      href: "#learn"
    },
    parentId: null,
    childIds: [],
    computedStyles: {
      color: "rgb(0, 0, 238)",
      "text-decoration": "underline"
    },
    box: null,
    viewportStates: {},
    visualOrder: 1,
    isVisible: true,
    asset: {
      href: "#learn"
    }
  };

  const layoutNode: LayoutNode = {
    id: "link-1",
    tag: "a",
    kind: "text",
    parentId: null,
    children: [],
    box: {
      x: 0,
      y: 0,
      width: 0,
      height: 0
    },
    visualOrder: 1,
    layout: {},
    spacing: {},
    style: {},
    content: {
      text: "Learn more",
      href: "#learn"
    },
    flags: {},
    responsive: {}
  };

  const strippedFragment = buildStyledHtmlFragment({
    html: '<a data-capture-id="link-1" href="#learn">Learn more</a>',
    captureById: new Map([[captureNode.id, captureNode]]),
    layoutById: new Map([[layoutNode.id, layoutNode]])
  });

  const explicitUnderlineFragment = buildStyledHtmlFragment({
    html: '<a data-capture-id="link-1" href="#learn">Learn more</a>',
    captureById: new Map([
      [
        captureNode.id,
        {
          ...captureNode,
          attributes: {
            ...captureNode.attributes,
            style: "text-decoration: underline;"
          }
        }
      ]
    ]),
    layoutById: new Map([[layoutNode.id, layoutNode]])
  });

  assert.match(strippedFragment, /text-decoration:\s*none/i);
  assert.equal(/text-decoration:\s*underline/i.test(strippedFragment), false);
  assert.match(explicitUnderlineFragment, /text-decoration:\s*none/i);
  assert.equal(/text-decoration:\s*underline/i.test(explicitUnderlineFragment), false);
}

async function testV3StyledHtmlFragmentNormalizesClickableUnderlineStyles() {
  const captureNode: PageCapture["nodes"][number] = {
    id: "block-1",
    tag: "div",
    text: "Read more",
    attributes: {},
    parentId: null,
    childIds: [],
    computedStyles: {},
    box: null,
    viewportStates: {},
    visualOrder: 1,
    isVisible: true,
    asset: {}
  };

  const layoutNode: LayoutNode = {
    id: "block-1",
    tag: "div",
    kind: "container",
    parentId: null,
    children: [],
    box: {
      x: 0,
      y: 0,
      width: 100,
      height: 20
    },
    visualOrder: 1,
    layout: {},
    spacing: {},
    style: {},
    content: {},
    flags: {},
    responsive: {}
  };

  const fragment = buildStyledHtmlFragment({
    html:
      '<div data-capture-id="block-1"><p>Read <a href="/more">more</a> or <a href="/learn" style="text-decoration: underline;">learn</a> <button style="text-decoration: underline;"><span style="text-decoration: underline;">buy</span></button> <span role="button" style="text-decoration: underline;">tap</span></p></div>',
    captureById: new Map([[captureNode.id, captureNode]]),
    layoutById: new Map([[layoutNode.id, layoutNode]])
  });

  assert.match(fragment, /<a href="\/more" style="[^"]*text-decoration:none/i);
  assert.match(fragment, /<a href="\/learn" style="[^"]*text-decoration:none/i);
  assert.match(fragment, /<button style="[^"]*text-decoration:none/i);
  assert.match(fragment, /role="button" style="[^"]*text-decoration:none/i);
  assert.equal(/text-decoration:\s*underline/i.test(fragment), false);
}

function testV3PixelPerfectInjectsClickableUnderlineReset() {
  const document = createPixelPerfectElementorDocumentV3(
    '<!doctype html><html><head><style>a{ text-decoration: underline !important; }</style></head><body><a href="#buy">Buy</a></body></html>',
    {
      title: "Pixel Perfect Underline Reset",
      selectedMode: "pixel-perfect"
    }
  );
  const htmlWidget = findFirstWidget(document, "html");
  const html = String(htmlWidget?.settings?.html ?? "");

  assert.ok(htmlWidget);
  assert.match(html, /a\[href\]\{text-decoration:none !important/i);
  assert.match(html, /\.elementor-button\{text-decoration:none !important/i);
  assert.match(html, /background:transparent/i);
  assert.equal(html.includes("var(--detected-page-background, #ffffff)"), false);
  assert.equal(/#ffffff/i.test(html), false);
}

async function testV3EditablePreservesStyledInputAsHtml() {
  const html = `<!doctype html>
<html>
  <head>
    <title>Styled Input Preservation</title>
  </head>
  <body>
    <section style="padding:32px;background:#020617;color:#f8fafc;">
      <input
        type="search"
        placeholder="Pesquisar"
        value=""
        style="display:block;width:280px;padding:14px 18px;border-radius:999px;background:#0f172a;color:#f8fafc;border:1px solid #334155;box-shadow:0 18px 40px rgba(15,23,42,.22);"
      />
    </section>
  </body>
</html>`;
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const captureResult = await runCapturePipelineV3FromHtml(html, {
    preferBrowser: false,
    outputRoot
  });
  const editableResult = createEditableElementorDocumentV3({
    capture: captureResult.capture,
    layout: captureResult.layout,
    selectedMode: "editable"
  });
  const htmlWidget = findFirstWidget(editableResult.document, "html");
  const preservedHtml = String(htmlWidget?.settings?.html ?? "");

  assert.ok(htmlWidget);
  assert.match(preservedHtml, /<input/i);
  assert.match(preservedHtml, /padding:14px 18px/i);
  assert.match(preservedHtml, /border-radius:999px/i);
  assert.match(preservedHtml, /box-shadow:/i);
  assert.match(preservedHtml, /(15,\s*23,\s*42|#0f172a)/i);
}

async function testV3EditablePreservesDarkCardShell() {
  const html = `<!doctype html>
<html>
  <head>
    <title>Dark Card Preservation</title>
  </head>
  <body>
    <section style="padding:32px;background:#020617;">
      <article
        style="padding:24px;border-radius:24px;background:#111827;color:#f8fafc;box-shadow:0 24px 60px rgba(15,23,42,.35);"
      >
        <h3>Dark card</h3>
        <p>O shell visual nao pode virar container neutro.</p>
      </article>
    </section>
  </body>
</html>`;
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const captureResult = await runCapturePipelineV3FromHtml(html, {
    preferBrowser: false,
    outputRoot
  });
  const editableResult = createEditableElementorDocumentV3({
    capture: captureResult.capture,
    layout: captureResult.layout,
    selectedMode: "editable"
  });
  const cardNode = captureResult.layout.nodes.find((node) => node.tag === "article");
  const cardElement = flattenElementTree(editableResult.document.content).find(
    (element) => element.settings?.converter_v3_source_node_id === cardNode?.id
  );
  const padding = cardElement?.settings?._padding as
    | {
        top?: number;
        right?: number;
        bottom?: number;
        left?: number;
      }
    | undefined;

  assert.ok(cardNode);
  assert.ok(cardElement);
  assert.match(
    String(cardElement?.settings?.background_color ?? cardElement?.settings?._background_color ?? ""),
    /(17,\s*24,\s*39|#111827)/i
  );
  assert.equal(cardElement?.settings?.border_radius, "24px");
  assert.match(String(cardElement?.settings?.box_shadow ?? ""), /0 24px 60px/i);
  assert.equal(padding?.top, 24);
  assert.equal(padding?.right, 24);
}

async function testV3EditablePreservesHeroBackgroundAndOverlay() {
  const html = `<!doctype html>
<html>
  <head>
    <title>Hero Overlay Preservation</title>
  </head>
  <body>
    <section
      style="position:relative;overflow:hidden;min-height:420px;padding:56px;background:linear-gradient(135deg, #0f172a 0%, #1d4ed8 100%);color:#f8fafc;"
    >
      <div
        aria-hidden="true"
        style="position:absolute;inset:0;background:rgba(15,23,42,.55);"
      ></div>
      <div style="position:relative;z-index:2;max-width:480px;">
        <h1>Hero preservado</h1>
        <p>Altura, contraste e overlay nao podem sumir.</p>
        <a href="#hero-cta" style="display:inline-flex;padding:14px 24px;border-radius:999px;background:#f8fafc;color:#0f172a;text-decoration:none;">Ver mais</a>
      </div>
    </section>
  </body>
</html>`;
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const captureResult = await runCapturePipelineV3FromHtml(html, {
    preferBrowser: false,
    outputRoot
  });
  const editableResult = createEditableElementorDocumentV3({
    capture: captureResult.capture,
    layout: captureResult.layout,
    selectedMode: "editable"
  });
  const heroNode = captureResult.layout.nodes.find((node) => node.tag === "section");
  const htmlWidget = findFirstWidget(editableResult.document, "html");
  const preservedHtml = String(htmlWidget?.settings?.html ?? "");

  assert.ok(heroNode);
  assert.ok(editableResult.usedHtmlFallbackNodeIds.includes(heroNode.id));
  assert.ok(htmlWidget);
  assert.match(preservedHtml, /linear-gradient/i);
  assert.match(preservedHtml, /min-height:420px/i);
  assert.match(preservedHtml, /position:absolute/i);
  assert.match(
    preservedHtml,
    /(background-color|background):rgba\(15,\s*23,\s*42,\s*(?:0?\.)?55\)/i
  );
}

async function testV3EditablePreservesDarkFooterShell() {
  const html = `<!doctype html>
<html>
  <head>
    <title>Dark Footer Preservation</title>
  </head>
  <body>
    <section style="min-height:240px;padding:32px;">Conteudo</section>
    <footer
      style="display:flex;justify-content:space-between;align-items:center;padding:28px 32px;background:#020617;color:#e2e8f0;"
    >
      <span>Footer dark</span>
      <a href="#contact" style="color:#f8fafc;text-decoration:none;">Contato</a>
    </footer>
  </body>
</html>`;
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const captureResult = await runCapturePipelineV3FromHtml(html, {
    preferBrowser: false,
    outputRoot
  });
  const editableResult = createEditableElementorDocumentV3({
    capture: captureResult.capture,
    layout: captureResult.layout,
    selectedMode: "editable"
  });
  const footerNode = captureResult.layout.nodes.find((node) => node.tag === "footer");
  const footerElement = flattenElementTree(editableResult.document.content).find(
    (element) => element.settings?.converter_v3_source_node_id === footerNode?.id
  );

  assert.ok(footerNode);
  assert.ok(footerElement);
  assert.match(
    String(footerElement?.settings?.background_color ?? footerElement?.settings?._background_color ?? ""),
    /(2,\s*6,\s*23|#020617)/i
  );
  assert.equal(footerElement?.settings?.justify_content, "space-between");
  assert.equal(footerElement?.settings?.align_items, "center");
}

function testV3EditableWrapsGlobalPageShellWhenOnlyBodyCarriesDarkTheme() {
  const width = 1280;
  const height = 720;
  const capture = createMockCapture({
    id: "editable-page-shell",
    title: "Editable Page Shell",
    renderedHtml:
      '<html><body style="margin:0;background:rgb(2, 6, 23);color:rgb(248, 250, 252);font-family:Space Grotesk,sans-serif;"><main><section data-capture-id="hero-section"><h1 data-capture-id="hero-title">Dark shell</h1></section></main></body></html>',
    themeAnalysis: {
      detectedTheme: "dark",
      dominantBackgroundLuminance: 0.018,
      dominantContrast: 15.2,
      colorSamples: [],
      designTokens: {
        globalBackground: "rgb(2, 6, 23)",
        foreground: "rgb(248, 250, 252)",
        fontFamily: "Space Grotesk"
      },
      styleSignals: {
        hasStrongDarkTheme: true,
        hasStyledButtons: false,
        hasStyledInputs: false,
        hasElevatedCards: false
      },
      roleCounts: {
        cards: 0,
        buttons: 0,
        inputs: 0,
        headers: 0,
        footers: 0,
        sections: 1
      },
      messages: ["dark theme detected"]
    },
    viewports: [
      {
        name: "desktop",
        width,
        height
      }
    ],
    nodes: [
      {
        id: "page",
        tag: "main",
        text: "",
        attributes: {},
        parentId: null,
        childIds: ["hero-section"],
        computedStyles: {},
        box: {
          x: 0,
          y: 0,
          top: 0,
          right: width,
          bottom: height,
          left: 0,
          width,
          height,
          centerX: width / 2,
          centerY: height / 2
        },
        viewportStates: {},
        visualOrder: 0,
        isVisible: true,
        asset: {}
      },
      {
        id: "body-node",
        tag: "body",
        text: "",
        attributes: {},
        parentId: null,
        childIds: ["page"],
        computedStyles: {
          "background-color": "rgb(2, 6, 23)",
          color: "rgb(248, 250, 252)",
          "font-family": "Space Grotesk"
        },
        box: {
          x: 0,
          y: 0,
          top: 0,
          right: width,
          bottom: height,
          left: 0,
          width,
          height,
          centerX: width / 2,
          centerY: height / 2
        },
        viewportStates: {},
        visualOrder: -1,
        isVisible: true,
        asset: {}
      },
      {
        id: "hero-section",
        tag: "section",
        text: "",
        attributes: {},
        parentId: "page",
        childIds: ["hero-title"],
        computedStyles: {},
        box: {
          x: 0,
          y: 0,
          top: 0,
          right: width,
          bottom: 320,
          left: 0,
          width,
          height: 320,
          centerX: width / 2,
          centerY: 160
        },
        viewportStates: {},
        visualOrder: 1,
        isVisible: true,
        asset: {}
      },
      {
        id: "hero-title",
        tag: "h1",
        text: "Dark shell",
        attributes: {},
        parentId: "hero-section",
        childIds: [],
        computedStyles: {
          color: "rgb(248, 250, 252)"
        },
        box: {
          x: 48,
          y: 48,
          top: 48,
          right: 480,
          bottom: 120,
          left: 48,
          width: 432,
          height: 72,
          centerX: 264,
          centerY: 84
        },
        viewportStates: {},
        visualOrder: 2,
        isVisible: true,
        asset: {}
      }
    ]
  });
  const layout: LayoutDocument = {
    id: "editable-page-shell-layout",
    title: "Editable Page Shell Layout",
    sourceKind: "raw-html",
    rootNodeId: "page",
    nodeCount: 3,
    sectionIds: ["hero-section"],
    semanticIndex: {
      hero: ["hero-section"]
    },
    detectedSections: [
      {
        id: "hero-section",
        type: "hero",
        confidence: 0.98,
        childIds: ["hero-title"],
        anchors: [],
        contains: ["hero", "text"]
      }
    ],
    nodes: [
      {
        id: "page",
        tag: "main",
        kind: "page",
        parentId: null,
        children: ["hero-section"],
        box: {
          x: 0,
          y: 0,
          width,
          height
        },
        visualOrder: 0,
        layout: {},
        spacing: {},
        style: {},
        content: {},
        flags: {},
        responsive: {}
      },
      {
        id: "hero-section",
        tag: "section",
        kind: "section",
        parentId: "page",
        children: ["hero-title"],
        box: {
          x: 0,
          y: 0,
          width,
          height: 320
        },
        visualOrder: 1,
        layout: {},
        spacing: {},
        style: {},
        content: {},
        flags: {},
        detection: {
          semanticRole: "hero",
          confidence: 0.98
        },
        responsive: {}
      },
      {
        id: "hero-title",
        tag: "h1",
        kind: "text",
        parentId: "hero-section",
        children: [],
        box: {
          x: 48,
          y: 48,
          width: 432,
          height: 72
        },
        visualOrder: 2,
        layout: {},
        spacing: {},
        style: {
          color: "rgb(248, 250, 252)"
        },
        content: {
          text: "Dark shell"
        },
        flags: {},
        responsive: {}
      }
    ]
  };
  const editableResult = createEditableElementorDocumentV3({
    capture,
    layout,
    selectedMode: "editable"
  });
  const pageShell = editableResult.document.content[0];
  const previewHtml = buildConvertedPreviewHtml({
    capture,
    document: editableResult.document
  });

  assert.equal(pageShell?.settings?.converter_v3_page_shell, true);
  assert.equal(pageShell?.settings?.background_color, "rgb(2, 6, 23)");
  assert.equal(pageShell?.settings?.converter_v3_page_shell_capture_node_id, "body-node");
  assert.match(previewHtml, /background:rgb\(2, 6, 23\)/i);
  assert.match(previewHtml, /color:rgb\(248, 250, 252\)/i);
}

function testV3PageShellIgnoresTransparentBodyBackgroundShorthand() {
  const darkShell = "rgb(2, 6, 23)";
  const capture = createMockCapture({
    themeAnalysis: {
      detectedTheme: "dark",
      dominantBackgroundLuminance: 0.018,
      dominantContrast: 15.2,
      colorSamples: [],
      designTokens: {
        globalBackground: darkShell,
        foreground: "rgb(248, 250, 252)"
      },
      styleSignals: {
        hasStrongDarkTheme: true,
        hasStyledButtons: false,
        hasStyledInputs: false,
        hasElevatedCards: false
      },
      roleCounts: {
        cards: 0,
        buttons: 0,
        inputs: 0,
        headers: 0,
        footers: 0,
        sections: 1
      },
      messages: ["dark theme detected"]
    },
    nodes: [
      {
        id: "body-node",
        tag: "body",
        text: "",
        attributes: {},
        parentId: null,
        childIds: ["page"],
        computedStyles: {
          background: "rgba(0, 0, 0, 0) none repeat scroll 0% 0% / auto padding-box border-box",
          "background-color": "rgba(0, 0, 0, 0)",
          color: "rgb(248, 250, 252)"
        },
        box: {
          x: 0,
          y: 0,
          top: 0,
          right: 1440,
          bottom: 900,
          left: 0,
          width: 1440,
          height: 900,
          centerX: 720,
          centerY: 450
        },
        viewportStates: {},
        visualOrder: 0,
        isVisible: true,
        asset: {}
      }
    ]
  });
  const layout: LayoutDocument = {
    id: "transparent-body-page-shell-layout",
    title: "Transparent Body Page Shell Layout",
    sourceKind: "raw-html",
    rootNodeId: "page",
    nodeCount: 1,
    sectionIds: [],
    semanticIndex: {},
    detectedSections: [],
    nodes: [
      {
        id: "page",
        tag: "main",
        kind: "page",
        parentId: null,
        children: [],
        box: {
          x: 0,
          y: 0,
          width: 1440,
          height: 900
        },
        visualOrder: 0,
        layout: {},
        spacing: {},
        style: {},
        content: {},
        flags: {},
        responsive: {}
      }
    ]
  };
  const pageShell = resolvePageShellVisualContext({
    capture,
    layout
  });

  assert.equal(pageShell.shouldWrap, true);
  assert.equal(pageShell.styleMap["background-color"], darkShell);
  assert.equal(pageShell.detectedPageBackground, darkShell);
  assert.doesNotMatch(
    pageShell.styleMap.background ?? "",
    /rgba\(0,\s*0,\s*0,\s*0\)\s+none/i
  );
}

function testV3ElementorBackgroundColorNormalizesModernCssColors() {
  assert.equal(
    resolveStyleMapBackgroundColor({
      "background-color": "oklch(0 0 0)"
    }),
    "rgb(0, 0, 0)"
  );
  assert.equal(
    resolveStyleMapBackgroundColor({
      background: "oklch(0 0 0) none repeat scroll 0% 0% / auto padding-box border-box",
      "background-color": "rgba(0, 0, 0, 0)"
    }),
    "rgb(0, 0, 0)"
  );
  assert.equal(
    resolveStyleMapBackgroundColor({
      "background-color": "hsl(0 0% 0%)"
    }),
    "rgb(0, 0, 0)"
  );
  assert.equal(
    resolveStyleMapBackgroundColor({
      "background-color": "hsl(var(--background))"
    }),
    undefined
  );
}

async function testV3NativeExportKeepsDetectedPageShellWhenLayoutRootIsWhite() {
  const width = 1440;
  const height = 900;
  const darkShell = "rgb(16, 37, 66)";
  const whiteSurface = "rgb(255, 255, 255)";
  const lightText = "rgb(248, 250, 252)";
  const capture = createMockCapture({
    renderer: "server",
    title: "Native Page Shell Priority",
    renderedHtml:
      '<!doctype html><html><body style="margin:0;background:#ffffff;"><main style="min-height:100vh;background:rgb(16, 37, 66);color:rgb(248, 250, 252);"><section><h1>Dark shell</h1></section></main></body></html>',
    themeAnalysis: {
      detectedTheme: "dark",
      dominantBackgroundLuminance: 0.02,
      dominantContrast: 15.4,
      colorSamples: [],
      designTokens: {
        globalBackground: darkShell,
        foreground: lightText,
        primaryButtonColor: "rgb(56, 189, 248)",
        cardBackground: "rgb(17, 24, 39)",
        borderColor: "rgb(51, 65, 85)",
        radius: "14px",
        shadow: "0 18px 40px rgba(15, 23, 42, 0.2)"
      },
      styleSignals: {
        hasStrongDarkTheme: true,
        hasStyledButtons: true,
        hasStyledInputs: true,
        hasElevatedCards: true
      },
      roleCounts: {
        cards: 0,
        buttons: 0,
        inputs: 0,
        headers: 0,
        footers: 0,
        sections: 1
      },
      messages: ["dark theme detected"]
    },
    nodes: [
      {
        id: "html-node",
        tag: "html",
        text: "",
        attributes: {},
        parentId: null,
        childIds: ["body-node"],
        computedStyles: {
          background: whiteSurface,
          "background-color": whiteSurface
        },
        box: null,
        viewportStates: {},
        visualOrder: -2,
        isVisible: true,
        asset: {}
      },
      {
        id: "body-node",
        tag: "body",
        text: "",
        attributes: {},
        parentId: "html-node",
        childIds: ["main-node"],
        computedStyles: {
          background: whiteSurface,
          "background-color": whiteSurface,
          color: "rgb(17, 24, 39)"
        },
        box: null,
        viewportStates: {},
        visualOrder: -1,
        isVisible: true,
        asset: {}
      },
      {
        id: "main-node",
        tag: "main",
        text: "",
        attributes: {},
        parentId: "body-node",
        childIds: ["hero-section"],
        computedStyles: {
          background: darkShell,
          "background-color": darkShell,
          color: lightText,
          "font-family": "Arial, sans-serif"
        },
        box: {
          x: 0,
          y: 0,
          top: 0,
          right: width,
          bottom: height,
          left: 0,
          width,
          height,
          centerX: width / 2,
          centerY: height / 2
        },
        viewportStates: {},
        visualOrder: 0,
        isVisible: true,
        asset: {}
      },
      {
        id: "hero-section",
        tag: "section",
        text: "",
        attributes: {},
        parentId: "main-node",
        childIds: ["hero-title"],
        computedStyles: {},
        box: {
          x: 0,
          y: 0,
          top: 0,
          right: width,
          bottom: 320,
          left: 0,
          width,
          height: 320,
          centerX: width / 2,
          centerY: 160
        },
        viewportStates: {},
        visualOrder: 1,
        isVisible: true,
        asset: {}
      },
      {
        id: "hero-title",
        tag: "h1",
        text: "Dark shell",
        attributes: {},
        parentId: "hero-section",
        childIds: [],
        computedStyles: {
          color: lightText
        },
        box: {
          x: 48,
          y: 48,
          top: 48,
          right: 480,
          bottom: 120,
          left: 48,
          width: 432,
          height: 72,
          centerX: 264,
          centerY: 84
        },
        viewportStates: {},
        visualOrder: 2,
        isVisible: true,
        asset: {}
      }
    ]
  });
  const layout: LayoutDocument = {
    id: "native-page-shell-priority-layout",
    title: "Native Page Shell Priority Layout",
    sourceKind: "raw-html",
    rootNodeId: "body-node",
    nodeCount: 4,
    sectionIds: ["hero-section"],
    semanticIndex: {
      hero: ["hero-section"]
    },
    detectedSections: [
      {
        id: "hero-section",
        type: "hero",
        confidence: 0.98,
        childIds: ["hero-title"],
        anchors: [],
        contains: ["hero", "text"]
      }
    ],
    nodes: [
      {
        id: "body-node",
        tag: "body",
        kind: "page",
        parentId: null,
        children: ["main-node"],
        box: {
          x: 0,
          y: 0,
          width,
          height
        },
        visualOrder: 0,
        layout: {},
        spacing: {},
        style: {
          backgroundColor: whiteSurface
        },
        content: {},
        flags: {},
        responsive: {}
      },
      {
        id: "main-node",
        tag: "main",
        kind: "container",
        parentId: "body-node",
        children: ["hero-section"],
        box: {
          x: 0,
          y: 0,
          width,
          height
        },
        visualOrder: 1,
        layout: {},
        spacing: {},
        style: {
          backgroundColor: darkShell,
          color: lightText,
          fontFamily: "Arial, sans-serif"
        },
        content: {},
        flags: {},
        responsive: {}
      },
      {
        id: "hero-section",
        tag: "section",
        kind: "section",
        parentId: "main-node",
        children: ["hero-title"],
        box: {
          x: 0,
          y: 0,
          width,
          height: 320
        },
        visualOrder: 2,
        layout: {},
        spacing: {},
        style: {},
        content: {},
        flags: {},
        detection: {
          semanticRole: "hero",
          confidence: 0.98
        },
        responsive: {}
      },
      {
        id: "hero-title",
        tag: "h1",
        kind: "text",
        parentId: "hero-section",
        children: [],
        box: {
          x: 48,
          y: 48,
          width: 432,
          height: 72
        },
        visualOrder: 3,
        layout: {},
        spacing: {},
        style: {
          color: lightText
        },
        content: {
          text: "Dark shell"
        },
        flags: {},
        responsive: {}
      }
    ]
  };

  const result = await withSnapshotFlagsDisabled(() =>
    createElementorNativeExport({
      capture,
      layout,
      selectedMode: "editable"
    })
  );
  const pageShell = result.document.content[0];
  const previewHtml =
    result.previewHtml ??
    buildConvertedPreviewHtml({
      capture,
      document: result.document
    });

  assert.equal(result.emittedMode, "editable");
  assert.equal(pageShell?.settings?.converter_v3_page_shell, true);
  assert.equal(pageShell?.settings?.background_color, darkShell);
  assert.equal(pageShell?.settings?.text_color, lightText);
  assert.equal(pageShell?.settings?.converter_v3_page_shell_capture_node_id, "main-node");
  assert.match(previewHtml, /background:rgb\(16, 37, 66\)/i);
  assert.match(previewHtml, /color:rgb\(248, 250, 252\)/i);
}

async function testV3SnapshotEmitterPropagatesDetectedPageBackgroundOnlyToPageShell() {
  const width = 120;
  const height = 120;
  const darkShell = "rgb(16, 37, 66)";
  const whiteSurface = "rgb(255, 255, 255)";
  const reference = createSvgDataUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="#ffffff" /></svg>`
  );
  const sectionBox = {
    x: 0,
    y: 0,
    top: 0,
    right: width,
    bottom: height,
    left: 0,
    width,
    height,
    centerX: width / 2,
    centerY: height / 2
  };
  const capture = createMockCapture({
    id: "snapshot-page-shell-detection",
    title: "Snapshot Page Shell Detection",
    renderedHtml:
      '<!doctype html><html><body style="margin:0;background:#ffffff;"><main style="min-height:100vh;background:rgb(16, 37, 66);"><section style="background:#ffffff;"></section></main></body></html>',
    viewports: [
      {
        name: "desktop",
        width,
        height
      }
    ],
    nodes: [
      {
        id: "html-node",
        tag: "html",
        text: "",
        attributes: {},
        parentId: null,
        childIds: ["body-node"],
        computedStyles: {
          background: whiteSurface,
          "background-color": whiteSurface
        },
        box: null,
        viewportStates: {},
        visualOrder: 0,
        isVisible: true,
        asset: {}
      },
      {
        id: "body-node",
        tag: "body",
        text: "",
        attributes: {},
        parentId: "html-node",
        childIds: ["main-node"],
        computedStyles: {
          background: whiteSurface,
          "background-color": whiteSurface
        },
        box: sectionBox,
        viewportStates: {
          desktop: {
            computedStyles: {
              background: whiteSurface,
              "background-color": whiteSurface
            },
            box: sectionBox,
            isVisible: true
          }
        },
        visualOrder: 1,
        isVisible: true,
        asset: {}
      },
      {
        id: "main-node",
        tag: "main",
        text: "",
        attributes: {},
        parentId: "body-node",
        childIds: ["hero-section"],
        computedStyles: {
          background: darkShell,
          "background-color": darkShell,
          color: "rgb(248, 250, 252)",
          "font-family": "Arial, sans-serif"
        },
        box: sectionBox,
        viewportStates: {
          desktop: {
            computedStyles: {
              background: darkShell,
              "background-color": darkShell,
              color: "rgb(248, 250, 252)",
              "font-family": "Arial, sans-serif"
            },
            box: sectionBox,
            isVisible: true
          }
        },
        visualOrder: 2,
        isVisible: true,
        asset: {}
      },
      {
        id: "hero-section",
        tag: "section",
        text: "",
        attributes: {},
        parentId: "main-node",
        childIds: [],
        computedStyles: {
          background: whiteSurface,
          "background-color": whiteSurface
        },
        box: sectionBox,
        viewportStates: {
          desktop: {
            computedStyles: {
              background: whiteSurface,
              "background-color": whiteSurface
            },
            box: sectionBox,
            isVisible: true
          }
        },
        visualOrder: 3,
        isVisible: true,
        asset: {}
      }
    ],
    summary: {
      totalNodes: 4,
      visibleNodes: 4,
      images: 0,
      buttons: 0,
      textBlocks: 0,
      sections: 1
    },
    artifacts: {
      outputDir: path.join(os.tmpdir(), "snapshot-page-shell-detection"),
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
        desktop: reference
      }
    }
  });
  const sections: SectionCapture[] = [
    {
      id: "hero-section-capture",
      nodeId: "hero-section",
      name: "hero-section",
      type: "hero",
      box: {
        x: 0,
        y: 0,
        width,
        height
      },
      subtreeNodeIds: ["hero-section"],
      originalHtml: `<section style="display:block;width:${width}px;height:${height}px;background:#ffffff;"></section>`,
      htmlCandidate: `<!doctype html><html><head><meta charset="utf-8" /><style>html,body{margin:0;padding:0;background:#ffffff;}</style></head><body><section style="display:block;width:${width}px;height:${height}px;background:#ffffff;"></section></body></html>`,
      complexity: createSectionCaptureComplexity(),
      viewports: {
        desktop: {
          viewport: "desktop",
          width,
          height,
          snapshotDataUrl: reference,
          linkOverlays: []
        }
      }
    }
  ];
  const layout: LayoutDocument = {
    id: "snapshot-page-shell-layout",
    title: "Snapshot Page Shell Layout",
    sourceKind: "raw-html",
    rootNodeId: "page",
    nodeCount: 3,
    sectionIds: ["hero-section"],
    semanticIndex: {
      hero: ["hero-section"]
    },
    detectedSections: [
      {
        id: "hero-section",
        type: "hero",
        confidence: 0.99,
        childIds: [],
        anchors: [],
        contains: ["hero"]
      }
    ],
    nodes: [
      {
        id: "page",
        tag: "body",
        kind: "page",
        parentId: null,
        children: ["main-node"],
        box: {
          x: 0,
          y: 0,
          width,
          height
        },
        visualOrder: 0,
        layout: {},
        spacing: {},
        style: {},
        content: {},
        flags: {},
        responsive: {}
      },
      {
        id: "main-node",
        tag: "main",
        kind: "container",
        parentId: "page",
        children: ["hero-section"],
        box: {
          x: 0,
          y: 0,
          width,
          height
        },
        visualOrder: 1,
        layout: {},
        spacing: {},
        style: {
          backgroundColor: darkShell,
          color: "rgb(248, 250, 252)",
          fontFamily: "Arial, sans-serif"
        },
        content: {},
        flags: {},
        responsive: {}
      },
      {
        id: "hero-section",
        tag: "section",
        kind: "section",
        parentId: "main-node",
        children: [],
        box: {
          x: 0,
          y: 0,
          width,
          height
        },
        visualOrder: 2,
        layout: {},
        spacing: {},
        style: {
          backgroundColor: whiteSurface
        },
        content: {},
        flags: {},
        detection: {
          semanticRole: "hero",
          confidence: 0.99
        },
        responsive: {}
      }
    ]
  };

  const result = await createSnapshotElementorDocumentV3({
    capture,
    layout,
    sections,
    selectedMode: "snapshot"
  });
  const pageShell = result.document.content[0];
  const snapshotSection = pageShell?.elements?.[0];

  assert.equal(pageShell?.settings?.converter_v3_page_shell, true);
  assert.equal(pageShell?.settings?.background_color, darkShell);
  assert.equal(pageShell?.settings?.converter_v3_page_shell_capture_node_id, "main-node");
  assert.equal(snapshotSection?.settings?.background_color, undefined);
  assert.equal(snapshotSection?.settings?._background_color, undefined);
  assert.match(result.previewHtml, /--detected-page-background:rgb\(16,\s*37,\s*66\)/i);
  assert.equal(result.previewHtml.includes("var(--detected-page-background, #ffffff)"), false);
}

async function testV3PixelPerfectEmitterInjectsDetectedPageBackgroundVariableWithoutGlobalOverride() {
  const darkShell = "rgb(16, 37, 66)";
  const capture = createMockCapture({
    nodes: [
      {
        id: "html-node",
        tag: "html",
        text: "",
        attributes: {},
        parentId: null,
        childIds: ["body-node"],
        computedStyles: {
          background: "rgb(255, 255, 255)",
          "background-color": "rgb(255, 255, 255)"
        },
        box: null,
        viewportStates: {},
        visualOrder: 0,
        isVisible: true,
        asset: {}
      },
      {
        id: "body-node",
        tag: "body",
        text: "",
        attributes: {},
        parentId: "html-node",
        childIds: ["main-node"],
        computedStyles: {
          background: "rgb(255, 255, 255)",
          "background-color": "rgb(255, 255, 255)"
        },
        box: null,
        viewportStates: {},
        visualOrder: 1,
        isVisible: true,
        asset: {}
      },
      {
        id: "main-node",
        tag: "main",
        text: "",
        attributes: {},
        parentId: "body-node",
        childIds: ["card-node"],
        computedStyles: {
          background: darkShell,
          "background-color": darkShell,
          color: "rgb(248, 250, 252)",
          "font-family": "Arial, sans-serif"
        },
        box: null,
        viewportStates: {},
        visualOrder: 2,
        isVisible: true,
        asset: {}
      },
      {
        id: "card-node",
        tag: "div",
        text: "Card copy",
        attributes: {
          class: "card"
        },
        parentId: "main-node",
        childIds: [],
        computedStyles: {
          background: "rgb(255, 255, 255)",
          "background-color": "rgb(255, 255, 255)"
        },
        box: null,
        viewportStates: {},
        visualOrder: 3,
        isVisible: true,
        asset: {}
      }
    ]
  });
  const layout: LayoutDocument = {
    id: "pixel-perfect-page-shell-layout",
    title: "Pixel Perfect Page Shell Layout",
    sourceKind: "raw-html",
    rootNodeId: "page",
    nodeCount: 2,
    sectionIds: [],
    semanticIndex: {},
    detectedSections: [],
    nodes: [
      {
        id: "page",
        tag: "body",
        kind: "page",
        parentId: null,
        children: ["main-node"],
        box: {
          x: 0,
          y: 0,
          width: 1440,
          height: 720
        },
        visualOrder: 0,
        layout: {},
        spacing: {},
        style: {},
        content: {},
        flags: {},
        responsive: {}
      },
      {
        id: "main-node",
        tag: "main",
        kind: "container",
        parentId: "page",
        children: [],
        box: {
          x: 0,
          y: 0,
          width: 1440,
          height: 720
        },
        visualOrder: 1,
        layout: {},
        spacing: {},
        style: {
          backgroundColor: darkShell,
          color: "rgb(248, 250, 252)",
          fontFamily: "Arial, sans-serif"
        },
        content: {},
        flags: {},
        responsive: {}
      }
    ]
  };
  const pageShell = resolvePageShellVisualContext({
    capture,
    layout
  });
  const document = createPixelPerfectElementorDocumentV3(
    `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Pixel Perfect Background</title>
    <style>
      body { margin: 0; background: #ffffff; }
      main { min-height: 100vh; background: rgb(16, 37, 66); }
      .card { margin: 32px; padding: 24px; background: #ffffff; border-radius: 16px; }
    </style>
  </head>
  <body>
    <main>
      <div class="card">Card copy</div>
    </main>
  </body>
</html>`,
    {
      title: "Pixel Perfect Background",
      selectedMode: "pixel-perfect",
      shellStyleMap: pageShell.styleMap
    }
  );
  const rootSettings = document.content[0]?.settings as
    | {
        background_color?: string;
        converter_v3_page_shell?: boolean;
        converter_v3_detected_page_background?: string;
      }
    | undefined;
  const htmlWidget = findFirstWidget(document, "html");
  const widgetHtml = String(htmlWidget?.settings?.html ?? "");

  assert.equal(rootSettings?.converter_v3_page_shell, true);
  assert.equal(rootSettings?.background_color, darkShell);
  assert.match(
    String(rootSettings?.converter_v3_detected_page_background ?? ""),
    /rgb\(16,\s*37,\s*66\)/i
  );
  assert.match(widgetHtml, /--detected-page-background:rgb\(16,\s*37,\s*66\)/i);
  assert.match(widgetHtml, /body\s*&gt;\s*main/i);
  assert.match(widgetHtml, /background:\s*var\(--detected-page-background,\s*#ffffff\)/i);
  assert.match(widgetHtml, /\.card\s*\{\s*margin:\s*32px;\s*padding:\s*24px;\s*background:\s*#ffffff;/i);
  assert.doesNotMatch(widgetHtml, /\*\s*\{\s*background\s*:/i);
}

function testV3SnapshotValidationTreatsCanvasMismatchAsPageBackgroundOnly() {
  const capture = createMockCapture({
    themeAnalysis: {
      detectedTheme: "dark",
      dominantBackgroundLuminance: 0.02,
      dominantContrast: 15.4,
      colorSamples: [],
      designTokens: {
        globalBackground: "rgb(16, 37, 66)",
        foreground: "rgb(248, 250, 252)",
        primaryButtonColor: "rgb(56, 189, 248)",
        cardBackground: "rgb(17, 24, 39)",
        borderColor: "rgb(51, 65, 85)",
        radius: "14px",
        shadow: "0 18px 40px rgba(15, 23, 42, 0.2)"
      },
      styleSignals: {
        hasStrongDarkTheme: true,
        hasStyledButtons: true,
        hasStyledInputs: true,
        hasElevatedCards: true
      },
      roleCounts: {
        cards: 1,
        buttons: 1,
        inputs: 1,
        headers: 0,
        footers: 0,
        sections: 1
      },
      messages: ["dark theme detected"]
    }
  });
  const pageShellStyleMap = {
    background: "rgb(16, 37, 66)",
    "background-color": "rgb(16, 37, 66)"
  };

  assert.equal(
    inferFullPageSnapshotLossType({
      capture,
      viewportWidth: 1440,
      viewportHeight: 900,
      bbox: {
        x: 0,
        y: 0,
        width: 1440,
        height: 520
      },
      dimensionsDiffer: false,
      pageShellStyleMap
    }),
    "background"
  );
  assert.equal(
    inferFullPageSnapshotLossType({
      capture,
      viewportWidth: 1440,
      viewportHeight: 900,
      bbox: {
        x: 320,
        y: 240,
        width: 280,
        height: 160
      },
      dimensionsDiffer: false,
      pageShellStyleMap
    }),
    "position"
  );
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
  if (isForceVisualSnapshotEnabled()) {
    return;
  }
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const result = await runExportPipelineV3FromHtml(html, {
    preferBrowser: preferBrowserForExportPipelineTests(),
    outputRoot
  });
  const elementorTemplate = JSON.parse(
    await readFile(result.artifacts.elementorTemplatePath, "utf8")
  ) as {
    content: Array<{
      settings?: {
        width?: string;
        tablet_width?: string;
        mobile_width?: string;
        background_image?: { url?: string };
        _background_image?: { url?: string };
        background_size?: string;
        _background_size?: string;
        background_position?: string;
        _background_position?: string;
      };
    }>;
  };

  if (
    assertSnapshotModeWhenForced(result, {
      expectedVisualStatus: expectedForcedSnapshotVisualStatus(),
      preservedLinksAtLeast: 1,
      requireLinkOverlay: true
    })
  ) {
    return;
  }

  assert.equal(result.validation.passed, true);
  assert.equal(elementorTemplate.content[0].settings?.width, "100%");
  assert.equal(elementorTemplate.content[0].settings?.tablet_width, "100%");
  assert.equal(elementorTemplate.content[0].settings?.mobile_width, "100%");
  assert.equal(
    elementorTemplate.content[0].settings?.background_image?.url,
    "https://example.com/hero-bg.jpg"
  );
  assert.equal(
    elementorTemplate.content[0].settings?._background_image?.url,
    "https://example.com/hero-bg.jpg"
  );
  assert.equal(elementorTemplate.content[0].settings?.background_size, "cover");
  assert.equal(elementorTemplate.content[0].settings?._background_size, "cover");
  assert.equal(elementorTemplate.content[0].settings?.background_position, "center center");
  assert.equal(
    elementorTemplate.content[0].settings?._background_position,
    "center center"
  );
}

async function testV3NativeExportPreservesNestedBackgroundImagesFromLocalAssets() {
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const sourceRoot = path.join(outputRoot, "nested-background-assets");
  const assetDir = path.join(sourceRoot, "assets");

  await mkdir(assetDir, { recursive: true });
  await writeFile(
    path.join(assetDir, "hero.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300"><rect width="400" height="300" fill="#123456" /><circle cx="308" cy="84" r="52" fill="#fed766" /></svg>`
  );
  await writeFile(
    path.join(sourceRoot, "index.html"),
    `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Nested Background Media</title>
    <style>
      body { margin: 0; background: #f5f1e8; font-family: Arial, sans-serif; }
      section { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; padding: 32px; }
      .card { padding: 24px; border-radius: 24px; background: #ffffff; }
      .hero-art {
        min-height: 280px;
        border-radius: 24px;
        background-image: url("./assets/hero.svg");
        background-size: cover;
        background-position: center center;
      }
    </style>
  </head>
  <body>
    <section>
      <div class="card">
        <h1>Hero</h1>
        <p>Copy that should stay editable.</p>
      </div>
      <div class="hero-art" aria-label="Decorative hero panel"></div>
    </section>
  </body>
</html>`
  );

  const result = await withSnapshotFlagsDisabled(async () => {
    const resolvedSource = await resolveSourceFromLocalFile(path.join(sourceRoot, "index.html"));
    return runExportPipelineV3(resolvedSource, {
      preferBrowser: true,
      outputRoot
    });
  });
  const elementorTemplate = JSON.parse(
    await readFile(result.artifacts.elementorTemplatePath, "utf8")
  ) as {
    content: unknown[];
  };
  const backgroundImages = [
    ...JSON.stringify(elementorTemplate).matchAll(
      /"background_image"\s*:\s*\{\s*"url"\s*:\s*"([^"]+)"/g
    )
  ].map((match) => match[1]);

  assert.equal(result.validation.passed, true);

  if (result.emittedMode === "snapshot") {
    assert.ok(result.snapshot);
    assert.equal(result.snapshot.overallSimilarity >= 0.99, true);
    return;
  }

  assert.equal(backgroundImages.some((url) => url.startsWith("data:image/svg+xml;base64,")), true);
}

async function testV3NativeExportPreservesRootBackgroundColorImageAndGradientOverlay() {
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const sourceRoot = path.join(outputRoot, "root-background-assets");
  const assetDir = path.join(sourceRoot, "assets");

  await mkdir(assetDir, { recursive: true });
  await writeFile(
    path.join(assetDir, "hero.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500" viewBox="0 0 800 500"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#102542" /><stop offset="100%" stop-color="#f87060" /></linearGradient></defs><rect width="800" height="500" fill="url(#g)" /><circle cx="620" cy="120" r="90" fill="#ffd166" /></svg>`
  );
  await writeFile(
    path.join(sourceRoot, "index.html"),
    `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Root Background Overlay</title>
    <style>
      html, body { margin: 0; min-height: 100%; }
      body {
        min-height: 100vh;
        background-color: #f5f1e8;
        background-image: linear-gradient(135deg, rgba(16, 37, 66, 0.86), rgba(248, 112, 96, 0.78)), url("./assets/hero.svg");
        background-size: cover;
        background-position: center center;
        color: #fff;
        font-family: Arial, sans-serif;
      }
      main { min-height: 100vh; padding: 48px; }
      .panel { max-width: 520px; padding: 32px; border-radius: 28px; background: rgba(255, 255, 255, 0.12); }
    </style>
  </head>
  <body>
    <main>
      <div class="panel">
        <h1>Hero background</h1>
        <p>Testing root color, image and effect export.</p>
      </div>
    </main>
  </body>
</html>`
  );

  const result = await withSnapshotFlagsDisabled(async () => {
    const resolvedSource = await resolveSourceFromLocalFile(path.join(sourceRoot, "index.html"));
    return runExportPipelineV3(resolvedSource, {
      preferBrowser: true,
      outputRoot
    });
  });
  const elementorTemplate = JSON.parse(
    await readFile(result.artifacts.elementorTemplatePath, "utf8")
  ) as {
    content: Array<{
      settings?: {
        background_color?: string;
        _background_color?: string;
        background_image?: { url?: string };
        _background_image?: { url?: string };
        background_position?: string;
        _background_position?: string;
        background_size?: string;
        _background_size?: string;
        background_overlay_background?: string;
        _background_overlay_background?: string;
        background_overlay_gradient_type?: string;
        _background_overlay_gradient_type?: string;
      };
    }>;
  };
  const rootSettings = elementorTemplate.content[0]?.settings;

  assert.equal(result.validation.passed, true);
  assert.equal(rootSettings?.background_color, "rgb(245, 241, 232)");
  assert.equal(rootSettings?._background_color, "rgb(245, 241, 232)");
  assert.equal(rootSettings?.background_image?.url?.startsWith("data:image/svg+xml;base64,"), true);
  assert.equal(rootSettings?._background_image?.url?.startsWith("data:image/svg+xml;base64,"), true);
  assert.equal(rootSettings?.background_position, "50% 50%");
  assert.equal(rootSettings?._background_position, "50% 50%");
  assert.equal(rootSettings?.background_size, "cover");
  assert.equal(rootSettings?._background_size, "cover");
  assert.equal(rootSettings?.background_overlay_background, "gradient");
  assert.equal(rootSettings?._background_overlay_background, "gradient");
  assert.equal(rootSettings?.background_overlay_gradient_type, "linear");
  assert.equal(rootSettings?._background_overlay_gradient_type, "linear");
}

async function testV3NativeExportFallsBackToHtmlBackgroundWhenBodyIsTransparent() {
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-tests");
  const sourceRoot = path.join(outputRoot, "html-root-background-assets");

  await mkdir(sourceRoot, { recursive: true });
  await writeFile(
    path.join(sourceRoot, "index.html"),
    `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>HTML Root Background</title>
    <style>
      html {
        background: rgb(16, 37, 66);
      }
      body {
        margin: 0;
        min-height: 100vh;
        background: transparent;
        color: white;
        font-family: Arial, sans-serif;
      }
      main {
        padding: 48px;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>HTML background fallback</h1>
      <p>Body stays transparent, but the export should keep the page color.</p>
    </main>
  </body>
</html>`
  );

  const result = await withSnapshotFlagsDisabled(async () => {
    const resolvedSource = await resolveSourceFromLocalFile(path.join(sourceRoot, "index.html"));
    return runExportPipelineV3(resolvedSource, {
      preferBrowser: true,
      outputRoot
    });
  });
  const elementorTemplate = JSON.parse(
    await readFile(result.artifacts.elementorTemplatePath, "utf8")
  ) as {
    content: Array<{
      settings?: {
        background_color?: string;
        _background_color?: string;
      };
    }>;
  };
  const rootSettings = elementorTemplate.content[0]?.settings;

  assert.equal(result.validation.passed, true);
  assert.equal(rootSettings?.background_color, "rgb(16, 37, 66)");
  assert.equal(rootSettings?._background_color, "rgb(16, 37, 66)");
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

function testSectionClassifierDetectsFaqAndCtaSections() {
  const layout: LayoutDocument = {
    id: "faq-cta-layout",
    title: "FAQ CTA Layout",
    sourceKind: "raw-html",
    rootNodeId: "page",
    nodeCount: 12,
    sectionIds: ["faq", "cta"],
    semanticIndex: {},
    detectedSections: [],
    nodes: [
      {
        id: "page",
        tag: "body",
        kind: "page",
        parentId: null,
        children: ["faq", "cta"],
        box: { x: 0, y: 0, width: 1200, height: 900 },
        visualOrder: 1,
        layout: {},
        spacing: {},
        style: {},
        content: {},
        flags: {},
        responsive: {}
      },
      {
        id: "faq",
        tag: "section",
        kind: "section",
        parentId: "page",
        children: ["faq-title", "faq-q1", "faq-a1", "faq-q2", "faq-a2"],
        box: { x: 0, y: 80, width: 1200, height: 360 },
        visualOrder: 2,
        layout: {},
        spacing: {},
        style: { backgroundColor: "#f8fafc" },
        content: {},
        flags: {},
        responsive: {}
      },
      {
        id: "faq-title",
        tag: "h2",
        kind: "text",
        parentId: "faq",
        children: [],
        box: { x: 80, y: 120, width: 300, height: 40 },
        visualOrder: 3,
        layout: {},
        spacing: {},
        style: {},
        content: { text: "Perguntas frequentes" },
        flags: {},
        responsive: {}
      },
      {
        id: "faq-q1",
        tag: "button",
        kind: "button",
        parentId: "faq",
        children: [],
        box: { x: 80, y: 190, width: 520, height: 48 },
        visualOrder: 4,
        layout: {},
        spacing: {},
        style: {},
        content: { text: "Como funciona o plano?" },
        flags: {},
        responsive: {}
      },
      {
        id: "faq-a1",
        tag: "p",
        kind: "text",
        parentId: "faq",
        children: [],
        box: { x: 80, y: 250, width: 640, height: 48 },
        visualOrder: 5,
        layout: {},
        spacing: {},
        style: {},
        content: { text: "Ele libera o snapshot visual e os overlays clicaveis." },
        flags: {},
        responsive: {}
      },
      {
        id: "faq-q2",
        tag: "button",
        kind: "button",
        parentId: "faq",
        children: [],
        box: { x: 80, y: 320, width: 520, height: 48 },
        visualOrder: 6,
        layout: {},
        spacing: {},
        style: {},
        content: { text: "Posso importar no Elementor?" },
        flags: {},
        responsive: {}
      },
      {
        id: "faq-a2",
        tag: "p",
        kind: "text",
        parentId: "faq",
        children: [],
        box: { x: 80, y: 380, width: 640, height: 48 },
        visualOrder: 7,
        layout: {},
        spacing: {},
        style: {},
        content: { text: "Sim, com JSON pronto para WordPress/Elementor." },
        flags: {},
        responsive: {}
      },
      {
        id: "cta",
        tag: "section",
        kind: "section",
        parentId: "page",
        children: ["cta-title", "cta-copy", "cta-button"],
        box: { x: 0, y: 500, width: 1200, height: 220 },
        visualOrder: 8,
        layout: {},
        spacing: {},
        style: { backgroundColor: "#102542" },
        content: {},
        flags: {},
        responsive: {}
      },
      {
        id: "cta-title",
        tag: "h2",
        kind: "text",
        parentId: "cta",
        children: [],
        box: { x: 80, y: 560, width: 380, height: 40 },
        visualOrder: 9,
        layout: {},
        spacing: {},
        style: {},
        content: { text: "Pronto para clonar com fidelidade?" },
        flags: {},
        responsive: {}
      },
      {
        id: "cta-copy",
        tag: "p",
        kind: "text",
        parentId: "cta",
        children: [],
        box: { x: 80, y: 616, width: 520, height: 32 },
        visualOrder: 10,
        layout: {},
        spacing: {},
        style: {},
        content: { text: "Ative o modo visual para exportar snapshots responsivos." },
        flags: {},
        responsive: {}
      },
      {
        id: "cta-button",
        tag: "a",
        kind: "button",
        parentId: "cta",
        children: [],
        box: { x: 80, y: 664, width: 220, height: 44 },
        visualOrder: 11,
        layout: {},
        spacing: {},
        style: {},
        content: { text: "Comecar agora", href: "#start" },
        flags: {},
        responsive: {}
      }
    ]
  };

  const classified = classifySections(buildVisualHierarchy(layout));

  assert.deepEqual(
    classified.detectedSections.map((section) => section.type),
    ["faq", "cta"]
  );
  assert.equal(
    classified.nodes.find((node) => node.id === "faq")?.detection?.semanticRole,
    "faq"
  );
  assert.equal(
    classified.nodes.find((node) => node.id === "cta")?.detection?.semanticRole,
    "cta"
  );
}

function createSvgDataUrl(svg: string) {
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

async function withForceVisualSnapshot<T>(callback: () => Promise<T>) {
  const previousForceVisualSnapshot = process.env.FORCE_VISUAL_SNAPSHOT;
  const previousForceFullPageSnapshot = process.env.FORCE_FULL_PAGE_SNAPSHOT;
  process.env.FORCE_VISUAL_SNAPSHOT = "true";
  process.env.FORCE_FULL_PAGE_SNAPSHOT = "false";

  try {
    return await callback();
  } finally {
    if (typeof previousForceVisualSnapshot === "string") {
      process.env.FORCE_VISUAL_SNAPSHOT = previousForceVisualSnapshot;
    } else {
      delete process.env.FORCE_VISUAL_SNAPSHOT;
    }

    if (typeof previousForceFullPageSnapshot === "string") {
      process.env.FORCE_FULL_PAGE_SNAPSHOT = previousForceFullPageSnapshot;
    } else {
      delete process.env.FORCE_FULL_PAGE_SNAPSHOT;
    }
  }
}

async function withForceFullPageSnapshot<T>(callback: () => Promise<T>) {
  const previousForceVisualSnapshot = process.env.FORCE_VISUAL_SNAPSHOT;
  const previousForceFullPageSnapshot = process.env.FORCE_FULL_PAGE_SNAPSHOT;
  process.env.FORCE_VISUAL_SNAPSHOT = "true";
  process.env.FORCE_FULL_PAGE_SNAPSHOT = "true";

  try {
    return await callback();
  } finally {
    if (typeof previousForceVisualSnapshot === "string") {
      process.env.FORCE_VISUAL_SNAPSHOT = previousForceVisualSnapshot;
    } else {
      delete process.env.FORCE_VISUAL_SNAPSHOT;
    }

    if (typeof previousForceFullPageSnapshot === "string") {
      process.env.FORCE_FULL_PAGE_SNAPSHOT = previousForceFullPageSnapshot;
    } else {
      delete process.env.FORCE_FULL_PAGE_SNAPSHOT;
    }
  }
}

async function withSnapshotFlagsDisabled<T>(callback: () => Promise<T>) {
  const previousForceVisualSnapshot = process.env.FORCE_VISUAL_SNAPSHOT;
  const previousForceFullPageSnapshot = process.env.FORCE_FULL_PAGE_SNAPSHOT;
  process.env.FORCE_VISUAL_SNAPSHOT = "false";
  process.env.FORCE_FULL_PAGE_SNAPSHOT = "false";

  try {
    return await callback();
  } finally {
    if (typeof previousForceVisualSnapshot === "string") {
      process.env.FORCE_VISUAL_SNAPSHOT = previousForceVisualSnapshot;
    } else {
      delete process.env.FORCE_VISUAL_SNAPSHOT;
    }

    if (typeof previousForceFullPageSnapshot === "string") {
      process.env.FORCE_FULL_PAGE_SNAPSHOT = previousForceFullPageSnapshot;
    } else {
      delete process.env.FORCE_FULL_PAGE_SNAPSHOT;
    }
  }
}

async function ensureOutputDir(name: string) {
  const dir = path.join(os.tmpdir(), name);
  await mkdir(dir, { recursive: true });
  return dir;
}

function createSectionCaptureComplexity(
  overrides: Partial<SectionCapture["complexity"]> = {}
): SectionCapture["complexity"] {
  return {
    nodeCount: 1,
    absoluteNodes: 0,
    overlappingNodes: 0,
    interactiveNodes: 0,
    imageNodes: 0,
    overlayNodes: 0,
    complexZIndexNodes: 0,
    transformedNodes: 0,
    gradientNodes: 0,
    animatedNodes: 0,
    unsupportedCssNodes: 0,
    carouselNodes: 0,
    gridContainers: 0,
    flexContainers: 0,
    nestedFlexGridContainers: 0,
    maxFlexGridDepth: 0,
    pseudoElementNodes: 0,
    hasPseudoElements: false,
    hasTransforms: false,
    hasEmbeds: false,
    ...overrides
  };
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
    inputAnalysis: createMockInputAnalysis(),
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
      complexity: createSectionCaptureComplexity(),
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
      complexity: createSectionCaptureComplexity({
        nodeCount: 6,
        pseudoElementNodes: 1,
        hasPseudoElements: true
      }),
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

  if (isForceVisualSnapshotEnabled()) {
    assert.equal(result.document.content.length, 2);
    assert.equal(result.snapshot.totals.htmlSections, 0);
    assert.equal(result.snapshot.totals.snapshotSections, 2);
    assert.equal(
      result.snapshot.sectionReports.every((section) => section.mode === "snapshot"),
      true
    );
    assert.equal(result.snapshot.overallSimilarity >= 0.99, true);
    assert.equal(objectContainsPattern(result.document, /converter-v3-snapshot-section/), true);
    return;
  }

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

async function testV3SnapshotEmitterBlocksHtmlProfilesAfterHardFailure() {
  const width = 100;
  const sectionHeight = 100;
  const pageHeight = sectionHeight * 2;
  const firstReference = createSvgDataUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${sectionHeight}" viewBox="0 0 ${width} ${sectionHeight}"><rect width="${width}" height="${sectionHeight}" fill="#f2545b" /></svg>`
  );
  const secondReference = createSvgDataUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${sectionHeight}" viewBox="0 0 ${width} ${sectionHeight}"><rect width="${width}" height="${sectionHeight}" fill="#2e86ab" /></svg>`
  );
  const fullPageReference = createSvgDataUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${pageHeight}" viewBox="0 0 ${width} ${pageHeight}"><rect width="${width}" height="${sectionHeight}" fill="#f2545b" /><rect y="${sectionHeight}" width="${width}" height="${sectionHeight}" fill="#2e86ab" /></svg>`
  );
  const capture = {
    id: "snapshot-learning",
    sourceKind: "raw-html",
    title: "Snapshot Learning",
    sourceHtml: "<body></body>",
    renderedHtml: "<html><body></body></html>",
    renderer: "browser",
    inputAnalysis: createMockInputAnalysis(),
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
      outputDir: path.join(os.tmpdir(), "snapshot-learning-tests"),
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
      id: "section-a",
      nodeId: "section-a",
      name: "section-a",
      type: "section",
      box: {
        x: 0,
        y: 0,
        width,
        height: sectionHeight
      },
      subtreeNodeIds: ["section-a"],
      originalHtml: `<section style="display:block;width:${width}px;height:${sectionHeight}px;background:#f2545b;"></section>`,
      htmlCandidate: `<!doctype html><html><head><meta charset="utf-8" /><style>html,body{margin:0;padding:0;}</style></head><body><section style="display:block;width:${width}px;height:${sectionHeight}px;background:#f2545b;"><div style="display:block;width:25px;height:10px;background:#101820;"></div></section></body></html>`,
      complexity: createSectionCaptureComplexity(),
      viewports: {
        desktop: {
          viewport: "desktop",
          width,
          height: sectionHeight,
          snapshotDataUrl: firstReference,
          linkOverlays: []
        }
      }
    },
    {
      id: "section-b",
      nodeId: "section-b",
      name: "section-b",
      type: "section",
      box: {
        x: 0,
        y: sectionHeight,
        width,
        height: sectionHeight
      },
      subtreeNodeIds: ["section-b"],
      originalHtml: `<section style="display:block;width:${width}px;height:${sectionHeight}px;background:#2e86ab;"></section>`,
      htmlCandidate: `<!doctype html><html><head><meta charset="utf-8" /><style>html,body{margin:0;padding:0;}</style></head><body><section style="display:block;width:${width}px;height:${sectionHeight}px;background:#2e86ab;"></section></body></html>`,
      complexity: createSectionCaptureComplexity(),
      viewports: {
        desktop: {
          viewport: "desktop",
          width,
          height: sectionHeight,
          snapshotDataUrl: secondReference,
          linkOverlays: []
        }
      }
    }
  ];
  const layout: LayoutDocument = {
    id: "snapshot-learning-layout",
    title: "Snapshot Learning Layout",
    sourceKind: "raw-html",
    rootNodeId: "page",
    nodeCount: 3,
    sectionIds: ["section-a", "section-b"],
    semanticIndex: {},
    detectedSections: [
      {
        id: "section-a",
        type: "section",
        confidence: 0.9,
        childIds: [],
        anchors: [],
        contains: ["section"]
      },
      {
        id: "section-b",
        type: "section",
        confidence: 0.9,
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

  assert.equal(result.snapshot.sectionReports[0]?.mode, "snapshot");
  assert.equal(result.snapshot.sectionReports[0]?.htmlBlocked, true);
  assert.equal(result.snapshot.sectionReports[1]?.mode, "snapshot");
  assert.equal(result.snapshot.sectionReports[1]?.htmlBlocked, true);
  assert.equal(result.snapshot.totals.htmlSections, 0);
  assert.equal(result.snapshot.totals.snapshotSections, 2);
  assert.equal(result.snapshot.requiresPixelPerfect, false);
}

async function testV3SnapshotEmitterKeepsSnapshotOutputWhenSectionAlreadyMatchesVisually() {
  const width = 100;
  const sectionHeight = 100;
  const reference = createSvgDataUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${sectionHeight}" viewBox="0 0 ${width} ${sectionHeight}"><rect width="${width}" height="${sectionHeight}" fill="#f2545b" /></svg>`
  );
  const capture = {
    id: "snapshot-pixel-perfect",
    sourceKind: "raw-html",
    title: "Snapshot Pixel Perfect",
    sourceHtml: "<body></body>",
    renderedHtml: "<html><body></body></html>",
    renderer: "browser",
    inputAnalysis: createMockInputAnalysis(),
    viewports: [
      {
        name: "desktop",
        width,
        height: sectionHeight
      }
    ],
    domSnapshot: [],
    styleSnapshot: [],
    boxSnapshot: [],
    responsiveSnapshot: [],
    nodes: [],
    summary: {
      totalNodes: 1,
      visibleNodes: 1,
      images: 0,
      buttons: 0,
      textBlocks: 0,
      sections: 1
    },
    artifacts: {
      outputDir: path.join(os.tmpdir(), "snapshot-pixel-perfect-tests"),
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
        desktop: reference
      }
    }
  } satisfies PageCapture;
  const sections: SectionCapture[] = [
    {
      id: "critical-section",
      nodeId: "critical-section",
      name: "critical-section",
      type: "hero",
      box: {
        x: 0,
        y: 0,
        width,
        height: sectionHeight
      },
      subtreeNodeIds: ["critical-section"],
      originalHtml: `<section style="display:block;width:${width}px;height:${sectionHeight}px;background:#f2545b;"></section>`,
      htmlCandidate: `<!doctype html><html><head><meta charset="utf-8" /><style>html,body{margin:0;padding:0;}</style></head><body><section style="display:block;width:${width}px;height:${sectionHeight}px;background:#f2545b;"><div style="display:block;width:40px;height:10px;background:#101820;"></div></section></body></html>`,
      complexity: createSectionCaptureComplexity(),
      viewports: {
        desktop: {
          viewport: "desktop",
          width,
          height: sectionHeight,
          snapshotDataUrl: reference,
          linkOverlays: []
        }
      }
    }
  ];
  const layout: LayoutDocument = {
    id: "snapshot-pixel-perfect-layout",
    title: "Snapshot Pixel Perfect Layout",
    sourceKind: "raw-html",
    rootNodeId: "page",
    nodeCount: 2,
    sectionIds: ["critical-section"],
    semanticIndex: {},
    detectedSections: [
      {
        id: "critical-section",
        type: "hero",
        confidence: 0.99,
        childIds: [],
        anchors: [],
        contains: ["hero"]
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

  if (isForceVisualSnapshotEnabled()) {
    assert.equal(result.snapshot.sectionReports[0]?.mode, "snapshot");
    assert.equal(result.snapshot.renderStrategy, "section-snapshots");
    assert.equal(result.snapshot.requiresPixelPerfect, false);
    assert.equal(result.snapshot.pixelPerfectReason, undefined);
    assert.equal(result.snapshot.totals.pixelPerfectRequiredSections, 0);
    return;
  }

  assert.equal(result.snapshot.sectionReports[0]?.mode, "snapshot");
  assert.equal(result.snapshot.sectionReports[0]?.htmlBlocked, true);
  assert.equal(result.snapshot.renderStrategy, "section-snapshots");
  assert.equal(result.snapshot.requiresPixelPerfect, false);
  assert.equal(result.snapshot.pixelPerfectReason, undefined);
  assert.equal(result.snapshot.totals.pixelPerfectRequiredSections, 1);
}

async function testV3ForceVisualSnapshotDisablesEditableAndHybridFallbacks() {
  const width = 160;
  const sectionHeight = 100;
  const outputDir = await ensureOutputDir("snapshot-force-native-tests");
  const reference = createSvgDataUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${sectionHeight}" viewBox="0 0 ${width} ${sectionHeight}"><rect width="${width}" height="${sectionHeight}" fill="#f2545b" /></svg>`
  );
  const capture = {
    id: "snapshot-force-native",
    sourceKind: "raw-html",
    title: "Forced Snapshot Native Export",
    sourceHtml: "<body></body>",
    renderedHtml:
      '<!doctype html><html><body style="margin:0;"><section data-capture-id="hero-force" style="width:100%;height:100px;background:#f2545b;"></section></body></html>',
    renderer: "browser",
    inputAnalysis: createMockInputAnalysis(),
    viewports: [
      {
        name: "desktop",
        width,
        height: sectionHeight
      }
    ],
    domSnapshot: [],
    styleSnapshot: [],
    boxSnapshot: [],
    responsiveSnapshot: [],
    nodes: [],
    summary: {
      totalNodes: 1,
      visibleNodes: 1,
      images: 0,
      buttons: 0,
      textBlocks: 0,
      sections: 1
    },
    artifacts: {
      outputDir,
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
        desktop: reference
      }
    },
    sections: [
      {
        id: "hero-force-section",
        nodeId: "hero-force",
        name: "hero-force-1",
        type: "hero",
        box: {
          x: 0,
          y: 0,
          width,
          height: sectionHeight
        },
        subtreeNodeIds: ["hero-force"],
        originalHtml: `<section style="width:${width}px;height:${sectionHeight}px;background:#f2545b;"></section>`,
        htmlCandidate: `<!doctype html><html><body><section style="width:${width}px;height:${sectionHeight}px;background:#f2545b;"></section></body></html>`,
        complexity: createSectionCaptureComplexity(),
        viewports: {
          desktop: {
            viewport: "desktop",
            width,
            height: sectionHeight,
            snapshotDataUrl: reference,
            linkOverlays: []
          }
        }
      }
    ]
  } satisfies PageCapture;
  const layout: LayoutDocument = {
    id: "snapshot-force-native-layout",
    title: "Forced Snapshot Native Layout",
    sourceKind: "raw-html",
    rootNodeId: "page",
    nodeCount: 1,
    sectionIds: ["hero-force"],
    semanticIndex: {},
    detectedSections: [
      {
        id: "hero-force",
        type: "hero",
        confidence: 0.99,
        childIds: [],
        anchors: [],
        contains: ["hero"]
      }
    ],
    nodes: []
  };

  const result = await withForceVisualSnapshot(() =>
    createElementorNativeExport({
      capture,
      layout,
      selectedMode: "editable",
      outputDir
    })
  );

  assert.equal(result.emittedMode, "snapshot");
  assert.equal(result.snapshot?.visualValidationReport?.status, "passed");
  assert.equal(result.snapshot?.visualValidationReport?.modeUsed, "section-snapshot");
}

async function testV3ForceVisualSnapshotFallsBackToPixelPerfectWhenSnapshotCannotBeValidated() {
  const width = 160;
  const sectionHeight = 100;
  const outputDir = await ensureOutputDir("snapshot-force-pixel-perfect-tests");
  const reference = createSvgDataUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${sectionHeight}" viewBox="0 0 ${width} ${sectionHeight}"><rect width="${width}" height="${sectionHeight}" fill="#f2545b" /></svg>`
  );
  const capture = {
    id: "snapshot-force-pixel-perfect",
    sourceKind: "raw-html",
    title: "Forced Snapshot Pixel Perfect Fallback",
    sourceHtml: "<body></body>",
    renderedHtml:
      '<!doctype html><html><body style="margin:0;"><section data-capture-id="hero-force-fallback" style="width:100%;height:100px;background:#f2545b;"></section></body></html>',
    renderer: "browser",
    inputAnalysis: createMockInputAnalysis(),
    viewports: [
      {
        name: "desktop",
        width,
        height: sectionHeight
      }
    ],
    domSnapshot: [],
    styleSnapshot: [],
    boxSnapshot: [],
    responsiveSnapshot: [],
    nodes: [],
    summary: {
      totalNodes: 1,
      visibleNodes: 1,
      images: 0,
      buttons: 0,
      textBlocks: 0,
      sections: 1
    },
    artifacts: {
      outputDir,
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
      screenshots: {}
    },
    sections: [
      {
        id: "hero-force-fallback-section",
        nodeId: "hero-force-fallback",
        name: "hero-force-fallback-1",
        type: "hero",
        box: {
          x: 0,
          y: 0,
          width,
          height: sectionHeight
        },
        subtreeNodeIds: ["hero-force-fallback"],
        originalHtml: `<section style="width:${width}px;height:${sectionHeight}px;background:#f2545b;"></section>`,
        htmlCandidate: `<!doctype html><html><body><section style="width:${width}px;height:${sectionHeight}px;background:#f2545b;"></section></body></html>`,
        complexity: createSectionCaptureComplexity(),
        viewports: {
          desktop: {
            viewport: "desktop",
            width,
            height: sectionHeight,
            snapshotDataUrl: reference,
            linkOverlays: []
          }
        }
      }
    ]
  } satisfies PageCapture;
  const layout: LayoutDocument = {
    id: "snapshot-force-pixel-perfect-layout",
    title: "Forced Snapshot Pixel Perfect Fallback Layout",
    sourceKind: "raw-html",
    rootNodeId: "page",
    nodeCount: 1,
    sectionIds: ["hero-force-fallback"],
    semanticIndex: {},
    detectedSections: [
      {
        id: "hero-force-fallback",
        type: "hero",
        confidence: 0.99,
        childIds: [],
        anchors: [],
        contains: ["hero"]
      }
    ],
    nodes: []
  };

  const result = await withForceVisualSnapshot(() =>
    createElementorNativeExport({
      capture,
      layout,
      selectedMode: "snapshot",
      outputDir
    })
  );

  assert.equal(result.emittedMode, "pixel-perfect");
  assert.equal(result.exportStage, "pixel-perfect-emitter");
  assert.equal(result.snapshot, undefined);
  assert.equal(
    result.warnings.some((warning) => /snapshot ficou abaixo da similaridade minima/i.test(warning)),
    true
  );
}

async function testV3SnapshotSelectionFallsBackToPixelPerfectWithoutForceFlag() {
  const width = 160;
  const sectionHeight = 100;
  const outputDir = await ensureOutputDir("snapshot-selection-pixel-perfect-tests");
  const reference = createSvgDataUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${sectionHeight}" viewBox="0 0 ${width} ${sectionHeight}"><rect width="${width}" height="${sectionHeight}" fill="#f2545b" /></svg>`
  );
  const capture = {
    id: "snapshot-selection-pixel-perfect",
    sourceKind: "lovable-react-source",
    title: "Snapshot Selection Pixel Perfect Fallback",
    sourceHtml: "<body></body>",
    renderedHtml:
      '<!doctype html><html><body style="margin:0;"><section data-capture-id="hero-selection-fallback" style="width:100%;height:100px;background:#f2545b;"></section></body></html>',
    renderer: "browser",
    inputAnalysis: createMockInputAnalysis({
      layoutTypes: ["lovable-export", "tailwind"],
      frameworkHints: ["lovable", "tailwind"]
    }),
    viewports: [
      {
        name: "desktop",
        width,
        height: sectionHeight
      }
    ],
    domSnapshot: [],
    styleSnapshot: [],
    boxSnapshot: [],
    responsiveSnapshot: [],
    nodes: [],
    summary: {
      totalNodes: 1,
      visibleNodes: 1,
      images: 0,
      buttons: 0,
      textBlocks: 0,
      sections: 1
    },
    artifacts: {
      outputDir,
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
      screenshots: {}
    },
    sections: [
      {
        id: "hero-selection-fallback-section",
        nodeId: "hero-selection-fallback",
        name: "hero-selection-fallback-1",
        type: "hero",
        box: {
          x: 0,
          y: 0,
          width,
          height: sectionHeight
        },
        subtreeNodeIds: ["hero-selection-fallback"],
        originalHtml: `<section style="width:${width}px;height:${sectionHeight}px;background:#f2545b;"></section>`,
        htmlCandidate: `<!doctype html><html><body><section style="width:${width}px;height:${sectionHeight}px;background:#f2545b;"></section></body></html>`,
        complexity: createSectionCaptureComplexity(),
        viewports: {
          desktop: {
            viewport: "desktop",
            width,
            height: sectionHeight,
            snapshotDataUrl: reference,
            linkOverlays: []
          }
        }
      }
    ]
  } satisfies PageCapture;
  const layout: LayoutDocument = {
    id: "snapshot-selection-pixel-perfect-layout",
    title: "Snapshot Selection Pixel Perfect Layout",
    sourceKind: "lovable-react-source",
    rootNodeId: "page",
    nodeCount: 1,
    sectionIds: ["hero-selection-fallback"],
    semanticIndex: {},
    detectedSections: [
      {
        id: "hero-selection-fallback",
        type: "hero",
        confidence: 0.99,
        childIds: [],
        anchors: [],
        contains: ["hero"]
      }
    ],
    nodes: []
  };

  const result = await withSnapshotFlagsDisabled(() =>
    createElementorNativeExport({
      capture,
      layout,
      selectedMode: "snapshot",
      outputDir
    })
  );

  assert.equal(result.emittedMode, "pixel-perfect");
  assert.equal(result.exportStage, "pixel-perfect-emitter");
  assert.equal(result.snapshot, undefined);
  assert.equal(result.warnings.includes(VISUAL_REASON_FALLBACK_PIXEL_PERFECT), true);
}

async function testV3ForceFullPageSnapshotUsesSingleResponsivePageSnapshot() {
  const desktopWidth = 1280;
  const tabletWidth = 834;
  const mobileWidth = 430;
  const pageHeight = 220;
  const outputDir = await ensureOutputDir("snapshot-force-full-page-tests");
  const desktop = createSvgDataUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${desktopWidth}" height="${pageHeight}" viewBox="0 0 ${desktopWidth} ${pageHeight}"><rect width="${desktopWidth}" height="${pageHeight}" fill="#102542" /></svg>`
  );
  const tablet = createSvgDataUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${tabletWidth}" height="${pageHeight}" viewBox="0 0 ${tabletWidth} ${pageHeight}"><rect width="${tabletWidth}" height="${pageHeight}" fill="#102542" /></svg>`
  );
  const mobile = createSvgDataUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${mobileWidth}" height="${pageHeight}" viewBox="0 0 ${mobileWidth} ${pageHeight}"><rect width="${mobileWidth}" height="${pageHeight}" fill="#102542" /></svg>`
  );
  const capture = {
    id: "snapshot-force-full-page",
    sourceKind: "raw-html",
    title: "Forced Full Page Snapshot",
    sourceHtml: "<body></body>",
    renderedHtml:
      '<!doctype html><html><body style="margin:0;"><section style="height:220px;background:#102542;"></section></body></html>',
    renderer: "browser",
    inputAnalysis: createMockInputAnalysis(),
    viewports: [
      {
        name: "desktop",
        width: desktopWidth,
        height: pageHeight
      },
      {
        name: "tablet",
        width: tabletWidth,
        height: pageHeight
      },
      {
        name: "mobile",
        width: mobileWidth,
        height: pageHeight
      }
    ],
    domSnapshot: [],
    styleSnapshot: [],
    boxSnapshot: [],
    responsiveSnapshot: [],
    nodes: [
      {
        id: "cta-link",
        tag: "a",
        text: "Pricing",
        attributes: {
          href: "#pricing",
          target: "_blank",
          rel: "noopener",
          "aria-label": "Open pricing"
        },
        parentId: "page",
        childIds: [],
        computedStyles: {
          position: "absolute",
          "z-index": "5"
        },
        box: {
          x: 120,
          y: 80,
          top: 80,
          right: 360,
          bottom: 112,
          left: 120,
          width: 240,
          height: 32,
          centerX: 240,
          centerY: 96
        },
        viewportStates: {
          desktop: {
            computedStyles: {
              position: "absolute",
              "z-index": "5"
            },
            box: {
              x: 120,
              y: 80,
              top: 80,
              right: 360,
              bottom: 112,
              left: 120,
              width: 240,
              height: 32,
              centerX: 240,
              centerY: 96
            },
            isVisible: true
          },
          tablet: {
            computedStyles: {
              position: "absolute",
              "z-index": "5"
            },
            box: {
              x: 90,
              y: 80,
              top: 80,
              right: 290,
              bottom: 112,
              left: 90,
              width: 200,
              height: 32,
              centerX: 190,
              centerY: 96
            },
            isVisible: true
          },
          mobile: {
            computedStyles: {
              position: "absolute",
              "z-index": "5"
            },
            box: {
              x: 40,
              y: 80,
              top: 80,
              right: 220,
              bottom: 112,
              left: 40,
              width: 180,
              height: 32,
              centerX: 130,
              centerY: 96
            },
            isVisible: true
          }
        },
        visualOrder: 1,
        isVisible: true,
        asset: {
          href: "#pricing"
        }
      }
    ],
    summary: {
      totalNodes: 2,
      visibleNodes: 2,
      links: 1,
      images: 0,
      buttons: 1,
      textBlocks: 1,
      sections: 1
    },
    artifacts: {
      outputDir,
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
        desktop,
        tablet,
        mobile
      }
    },
    sections: []
  } satisfies PageCapture;
  const layout: LayoutDocument = {
    id: "snapshot-force-full-page-layout",
    title: "Forced Full Page Snapshot Layout",
    sourceKind: "raw-html",
    rootNodeId: "page",
    nodeCount: 2,
    sectionIds: ["page"],
    semanticIndex: {},
    detectedSections: [],
    nodes: []
  };

  const result = await withForceFullPageSnapshot(() =>
    createElementorNativeExport({
      capture,
      layout,
      selectedMode: "editable",
      outputDir
    })
  );

  assert.equal(result.emittedMode, "snapshot");
  assert.equal(result.snapshot?.renderStrategy, "full-page-snapshot");
  assert.equal(result.snapshot?.visualValidationReport?.modeUsed, "full-page-snapshot");
  assert.deepEqual(result.snapshot?.visualValidationReport?.viewportsTested, [
    "desktop",
    "tablet",
    "mobile"
  ]);
  assert.equal(result.document.content.length, 1);
  assert.equal(result.document.content[0]?.elType, "section");
  assert.equal(result.document.content[0]?.elements?.[0]?.elType, "column");
  assert.equal(result.document.content[0]?.elements?.[0]?.elements?.[0]?.widgetType, "html");
  const snapshotWidgetHtml = String(
    result.document.content[0]?.elements?.[0]?.elements?.[0]?.settings?.html ?? ""
  );
  assert.match(
    snapshotWidgetHtml,
    /converter-v3-snapshot-stage\{position:relative;display:block;width:100%;max-width:100%;margin:0;padding:0;line-height:0\}/
  );
  assert.equal(/converter-v3-snapshot-stage\{[^}]*width:\d+px/i.test(snapshotWidgetHtml), false);
  assert.match(String(result.previewHtml), /converter-v3-snapshot-image-desktop/);
  assert.match(String(result.previewHtml), /converter-v3-preview-page \{/);
  assert.match(String(result.previewHtml), /width: max-content/);
  assert.match(String(result.previewHtml), /aria-label="Open pricing"/);
  assert.match(String(result.previewHtml), /target="_blank"/);
  assert.match(String(result.previewHtml), /rel="noopener"/);
}

async function testV3ForceFullPageSnapshotFallsBackToPixelPerfectOnlyWhenSnapshotCannotBeCreated() {
  const width = 160;
  const sectionHeight = 100;
  const outputDir = await ensureOutputDir("snapshot-force-full-page-pixel-perfect-tests");
  const capture = {
    id: "snapshot-force-full-page-missing",
    sourceKind: "raw-html",
    title: "Forced Full Page Snapshot Missing Source",
    sourceHtml: "<body></body>",
    renderedHtml:
      '<!doctype html><html><body style="margin:0;"><section style="height:100px;background:#f2545b;"></section></body></html>',
    renderer: "browser",
    inputAnalysis: createMockInputAnalysis(),
    viewports: [
      {
        name: "desktop",
        width,
        height: sectionHeight
      }
    ],
    domSnapshot: [],
    styleSnapshot: [],
    boxSnapshot: [],
    responsiveSnapshot: [],
    nodes: [],
    summary: {
      totalNodes: 1,
      visibleNodes: 1,
      images: 0,
      buttons: 0,
      textBlocks: 0,
      sections: 1
    },
    artifacts: {
      outputDir,
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
      screenshots: {}
    },
    sections: []
  } satisfies PageCapture;
  const layout: LayoutDocument = {
    id: "snapshot-force-full-page-missing-layout",
    title: "Forced Full Page Snapshot Missing Layout",
    sourceKind: "raw-html",
    rootNodeId: "page",
    nodeCount: 1,
    sectionIds: ["page"],
    semanticIndex: {},
    detectedSections: [],
    nodes: []
  };

  const result = await withForceFullPageSnapshot(() =>
    createElementorNativeExport({
      capture,
      layout,
      selectedMode: "editable",
      outputDir
    })
  );

  assert.equal(result.emittedMode, "pixel-perfect");
  assert.equal(result.exportStage, "pixel-perfect-emitter");
  assert.equal(result.snapshot?.requiresPixelPerfect, true);
  assert.match(String(result.snapshot?.pixelPerfectReason), /fallback emergencial para pixel-perfect/i);
}

async function testV3LovableLikeSitesAutomaticallyUseUniversalFullPageClone() {
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-lovable-universal-clone");
  const result = await withSnapshotFlagsDisabled(() =>
    runExportPipelineV3FromHtml(
      `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="generator" content="Lovable" />
    <title>Universal Lovable Clone</title>
    <style>
      html, body { margin: 0; padding: 0; background: #0f172a; color: #f8fafc; font-family: Inter, Arial, sans-serif; }
      .container { width: min(1120px, calc(100% - 48px)); margin: 0 auto; }
      .hero { display: grid; grid-template-columns: 1.1fr 0.9fr; gap: 32px; align-items: center; min-height: 420px; }
      .panel { border-radius: 28px; padding: 32px; background: linear-gradient(135deg, rgba(15,23,42,0.92), rgba(37,99,235,0.7)); box-shadow: 0 20px 80px rgba(15,23,42,0.35); }
      .badge { display: inline-flex; padding: 8px 14px; border-radius: 999px; background: rgba(148,163,184,0.18); font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; }
      .cta { display: inline-block; margin-top: 20px; padding: 14px 20px; border-radius: 999px; background: #f8fafc; color: #0f172a; font-weight: 700; text-decoration: none; }
      .visual { position: relative; min-height: 320px; }
      .card { position: absolute; inset: 0; border-radius: 32px; background: linear-gradient(180deg, #38bdf8, #2563eb); }
      .orb { position: absolute; width: 180px; height: 180px; right: 24px; bottom: 24px; border-radius: 999px; background: rgba(255,255,255,0.24); backdrop-filter: blur(6px); }
      @media (max-width: 900px) {
        .hero { grid-template-columns: 1fr; padding: 48px 0; }
      }
    </style>
  </head>
  <body>
    <main class="container mx-auto px-6 md:grid lg:grid-cols-2">
      <section class="hero">
        <div class="panel">
          <span class="badge">Lovable export</span>
          <h1>Clone visual universal</h1>
          <p>Quando um site chega com assinatura Lovable-like, o pipeline deve priorizar o snapshot full-page em vez de tentar reconstruir widgets editaveis.</p>
          <a class="cta" href="#pricing">Ver planos</a>
        </div>
        <div class="visual">
          <div class="card"></div>
          <div class="orb"></div>
        </div>
      </section>
    </main>
  </body>
</html>`,
      {
        preferBrowser: true,
        outputRoot
      }
    )
  );

  assert.equal(result.capture.renderer, "browser");
  assert.equal(result.analysis.selectedMode, "snapshot");
  assert.equal(result.emittedMode, "snapshot");
  assert.equal(result.report.selectedMode, "snapshot");
  assert.equal(result.report.selectionReasons?.includes(VISUAL_REASON_HIGH_RISK), true);
  assert.equal(result.report.selectionReasons?.includes(VISUAL_REASON_DARK_THEME), true);
  assert.equal(result.report.selectionReasons?.includes(VISUAL_REASON_HERO_BACKGROUND), true);
  assert.equal(result.snapshot?.renderStrategy, "full-page-snapshot");
  assert.equal(result.snapshot?.visualValidationReport?.modeUsed, "full-page-snapshot");
  assert.equal(result.snapshot?.visualValidationReport?.status, "passed");
  assert.equal((result.capture.sections?.length ?? 0) >= 1, true);
  assert.match(
    result.analysis.reasons.join(" "),
    /Politica (visual|universal) .*Lovable-like|Complexidade visual alta detectada/i
  );
}

async function testV3ForcedSnapshotReportIncludesViewportLogs() {
  const outputRoot = path.join(os.tmpdir(), "html-to-elementor-v3-force-report-tests");
  const result = await withForceVisualSnapshot(() =>
    runExportPipelineV3FromHtml(
      `<!doctype html>
<html>
  <head>
    <title>Forced Snapshot Report</title>
  </head>
  <body style="margin:0;">
    <section style="display:grid;grid-template-columns:1.1fr 0.9fr;gap:24px;padding:40px;background:linear-gradient(135deg,#102542,#f87060);color:#fff;">
      <div>
        <p style="margin:0 0 12px;font-size:14px;letter-spacing:0.12em;text-transform:uppercase;">Snapshot first</p>
        <h1 style="margin:0 0 16px;font-size:48px;">Forced visual export</h1>
        <p style="margin:0 0 20px;max-width:32ch;">This fixture verifies viewport similarity logs and clickable overlays in the forced visual pipeline.</p>
        <a href="#start" style="display:inline-block;padding:14px 22px;border-radius:999px;background:#fff;color:#102542;text-decoration:none;font-weight:700;">Start now</a>
      </div>
      <div style="min-height:240px;border-radius:28px;background:rgba(255,255,255,0.18);box-shadow:0 20px 50px rgba(0,0,0,0.22);"></div>
    </section>
  </body>
</html>`,
      {
        preferBrowser: true,
        outputRoot
      }
    )
  );

  assert.equal(result.emittedMode, "snapshot");
  assert.equal(result.snapshot?.visualValidationReport?.status, "passed");
  assert.equal(Array.isArray(result.report.visualValidationSummary), true);
  assert.equal(result.report.visualValidationSummary[0], "[Visual Validation]");
  assert.equal(Array.isArray(result.report.visualLogs), true);
  assert.equal(result.report.visualLogs[0], "[Visual Validation]");
  assert.equal(result.report.visualLogs.some((line) => line.startsWith("[CAPTURE]")), true);
  assert.equal(result.report.visualLogs.some((line) => line.startsWith("[SECTION]")), true);
  assert.equal(result.report.visualLogs.some((line) => line.startsWith("[VISUAL SNAPSHOT]")), true);
  assert.equal(result.report.visualLogs.some((line) => line.startsWith("[LINK OVERLAY]")), true);
  assert.equal(result.report.visualLogs.some((line) => line.startsWith("[VALIDATION] similaridade desktop:")), true);
  assert.equal(result.report.visualLogs.some((line) => line === "[EXPORT] aprovado"), true);
  assert.equal(typeof result.report.viewportSimilarities?.desktop, "number");
  assert.equal(typeof result.report.viewportSimilarities?.tablet, "number");
  assert.equal(typeof result.report.viewportSimilarities?.mobile, "number");
  assert.equal(Array.isArray(result.report.visualIssues), true);
}

function testBuildExportReportFormatsFriendlyVisualValidationLogs() {
  const capture = createMockCapture({
    id: "friendly-visual-validation",
    title: "Friendly Visual Validation",
    themeAnalysis: {
      detectedTheme: "dark",
      dominantBackgroundLuminance: 0.02,
      dominantContrast: 15.4,
      colorSamples: [],
      designTokens: {
        globalBackground: "rgb(15, 23, 42)",
        foreground: "rgb(248, 250, 252)",
        cardBackground: "rgb(30, 41, 59)"
      },
      roleCounts: {
        cards: 2,
        buttons: 1,
        inputs: 1,
        headers: 1,
        footers: 0,
        sections: 2
      },
      messages: ["dark theme detected"]
    },
    sections: [
      {
        id: "hero-section-capture",
        nodeId: "hero-section",
        name: "hero-1",
        type: "hero",
        box: {
          x: 0,
          y: 0,
          width: 1440,
          height: 360
        },
        subtreeNodeIds: ["hero-section"],
        originalHtml: "<section></section>",
        htmlCandidate: "<section></section>",
        complexity: createSectionCaptureComplexity({
          imageNodes: 2
        }),
        viewports: {
          desktop: {
            viewport: "desktop",
            width: 1440,
            height: 360,
            linkOverlays: []
          }
        },
        debug: {
          sectionBoundingBox: {
            x: 0,
            y: 0,
            width: 1440,
            height: 360
          },
          sectionWidth: 1440,
          sectionHeight: 360,
          originalImages: [
            {
              nodeId: "hero-image-1",
              tag: "img",
              src: "https://example.com/hero-1.png",
              width: 320,
              height: 240
            },
            {
              nodeId: "hero-image-2",
              tag: "img",
              src: "https://example.com/hero-2.png",
              width: 320,
              height: 240
            }
          ],
          cssBackgrounds: [],
          loadedFonts: [],
          interactiveElements: [],
          positionedElements: []
        }
      },
      {
        id: "cards-section-capture",
        nodeId: "cards-section",
        name: "cards-2",
        type: "grid",
        box: {
          x: 0,
          y: 420,
          width: 1440,
          height: 320
        },
        subtreeNodeIds: ["cards-section"],
        originalHtml: "<section></section>",
        htmlCandidate: "<section></section>",
        complexity: createSectionCaptureComplexity({
          gridContainers: 1
        }),
        viewports: {
          mobile: {
            viewport: "mobile",
            width: 390,
            height: 320,
            linkOverlays: []
          }
        },
        debug: {
          sectionBoundingBox: {
            x: 0,
            y: 420,
            width: 1440,
            height: 320
          },
          sectionWidth: 1440,
          sectionHeight: 320,
          originalImages: [],
          cssBackgrounds: [],
          loadedFonts: [],
          interactiveElements: [],
          positionedElements: []
        }
      }
    ]
  });
  const layout: LayoutDocument = {
    id: "friendly-visual-validation-layout",
    title: "Friendly Visual Validation Layout",
    sourceKind: "raw-html",
    rootNodeId: "page",
    nodeCount: 3,
    sectionIds: ["hero-section", "cards-section"],
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
        id: "cards-section",
        type: "grid",
        confidence: 0.92,
        childIds: [],
        anchors: [],
        contains: ["grid"]
      }
    ],
    nodes: []
  };
  const report = buildExportReport({
    capture,
    layout,
    analysis: {
      score: 9,
      overlappingGroups: 1,
      gridContainers: 1,
      flexContainers: 1,
      absoluteNodes: 1,
      decorativeNodes: 0,
      interactiveNodes: 1,
      selectedMode: "snapshot",
      reasons: ["Snapshot visual preferido."]
    },
    emittedMode: "snapshot",
    validation: {
      passed: false,
      mode: "snapshot",
      issueCount: 2,
      issues: [],
      stats: {
        expectedTexts: 0,
        matchedTexts: 0,
        expectedImages: 0,
        matchedImages: 0,
        expectedButtons: 0,
        matchedButtons: 0,
        expectedLinks: 0,
        matchedLinks: 0,
        expectedSections: 0,
        matchedSections: 0,
        expectedCards: 0,
        matchedCards: 0,
        expectedHeaders: 0,
        matchedHeaders: 0,
        expectedFooters: 0,
        matchedFooters: 0,
        expectedPositionedNodes: 0,
        matchedPositionedNodes: 0
      }
    },
    snapshotEnabled: true,
    snapshotReason: "Snapshot visual validado.",
    themeAudit: {
      passed: false,
      sourceTheme: "dark",
      convertedTheme: "light",
      sourceTokens: {
        globalBackground: "rgb(15, 23, 42)"
      },
      convertedTokens: {
        globalBackground: "rgb(255, 255, 255)"
      },
      issues: [
        {
          type: "theme-mismatch",
          severity: "critical",
          message: "dark theme lost",
          originalValue: "rgb(15, 23, 42)",
          convertedValue: "rgb(255, 255, 255)"
        }
      ],
      messages: ["dark theme detected", "light theme detected", "dark theme lost"]
    },
    snapshot: {
      renderStrategy: "section-snapshots",
      overallSimilarity: 0.968,
      threshold: 0.99,
      viewportSimilarities: {
        desktop: 0.984,
        tablet: 0.991,
        mobile: 0.968
      },
      sectionReports: [],
      visualValidationReport: {
        status: "blocked",
        modeUsed: "section-snapshot",
        viewportsTested: ["desktop", "tablet", "mobile"],
        sectionsApproved: [],
        sectionsWithFallback: [],
        linksPreserved: 0,
        totalLinks: 0,
        similarityFinal: 0.968,
        similarityFinalPercent: "96.80%",
        viewportResults: [
          {
            viewport: "desktop",
            passed: false,
            similarity: 0.984,
            similarityPercent: "98.40%"
          },
          {
            viewport: "tablet",
            passed: true,
            similarity: 0.991,
            similarityPercent: "99.10%"
          },
          {
            viewport: "mobile",
            passed: false,
            similarity: 0.968,
            similarityPercent: "96.80%"
          }
        ],
        issues: [
          {
            viewport: "desktop",
            sectionId: "hero-section",
            sectionName: "hero-1",
            sectionType: "hero",
            sectionTypeLabel: "Hero",
            severity: "critical",
            similarity: 0.984,
            similarityPercent: "98.40%",
            lossType: "image",
            estimatedLossCount: 2,
            estimatedLosses: {
              total: 2,
              images: 2,
              texts: 0,
              buttons: 0,
              links: 0,
              backgrounds: 0
            },
            bbox: {
              x: 12,
              y: 24,
              width: 180,
              height: 120
            },
            fallbackStage: "section-snapshot",
            fallbackUsed: "section-snapshot",
            message: "Viewport desktop; secao hero-1 (hero-section); similaridade 98.40%; perda detectada: image; fallback usado: section-snapshot."
          },
          {
            viewport: "mobile",
            sectionId: "cards-section",
            sectionName: "cards-2",
            sectionType: "grid",
            sectionTypeLabel: "Cards",
            severity: "warning",
            similarity: 0.968,
            similarityPercent: "96.80%",
            lossType: "position",
            estimatedLossCount: 4,
            estimatedLosses: {
              total: 4,
              images: 0,
              texts: 2,
              buttons: 1,
              links: 1,
              backgrounds: 0
            },
            bbox: {
              x: 20,
              y: 220,
              width: 280,
              height: 160
            },
            fallbackStage: "section-snapshot",
            fallbackUsed: "section-snapshot",
            message: "Viewport mobile; secao cards-2 (cards-section); similaridade 96.80%; perda detectada: position; fallback usado: section-snapshot."
          }
        ]
      },
      totals: {
        htmlSections: 0,
        snapshotSections: 2,
        preservedLinks: 0,
        totalLinks: 0
      }
    }
  });

  assert.deepEqual(report.visualValidationSummary, [
    "[Visual Validation]",
    "Desktop: 98.4% - falhou",
    "Problema: secao Hero perdeu 2 imagens",
    "Tablet: 99.1% - ok",
    "Mobile: 96.8% - falhou",
    "Problema: cards ficaram desalinhados",
    "Exportacao bloqueada"
  ]);
  assert.deepEqual(report.visualLogs.slice(0, 7), report.visualValidationSummary);
  assert.equal(report.themeAnalysis?.detectedTheme, "dark");
  assert.equal(report.themeAudit?.passed, false);
  assert.deepEqual(report.themeLogs, [
    "[THEME] dark theme detected",
    "[THEME] light theme detected",
    "[THEME] dark theme lost"
  ]);
  assert.equal(report.visualLogs.includes("[THEME] dark theme lost"), true);
}

function testBuildExportReportIncludesFallbackTriggeredMessages() {
  const capture = createMockCapture({
    id: "fallback-trigger-report",
    title: "Fallback Trigger Report"
  });
  const layout: LayoutDocument = {
    id: "fallback-trigger-layout",
    title: "Fallback Trigger Layout",
    sourceKind: "raw-html",
    rootNodeId: "page",
    nodeCount: 1,
    sectionIds: [],
    semanticIndex: {},
    detectedSections: [],
    nodes: []
  };
  const report = buildExportReport({
    capture,
    layout,
    analysis: {
      score: 4,
      overlappingGroups: 0,
      gridContainers: 0,
      flexContainers: 1,
      absoluteNodes: 0,
      decorativeNodes: 0,
      interactiveNodes: 0,
      selectedMode: "editable",
      reasons: ["Editable tentado primeiro."]
    },
    emittedMode: "pixel-perfect",
    validation: {
      passed: true,
      mode: "pixel-perfect",
      issueCount: 0,
      issues: [],
      stats: {
        expectedTexts: 0,
        matchedTexts: 0,
        expectedImages: 0,
        matchedImages: 0,
        expectedButtons: 0,
        matchedButtons: 0,
        expectedLinks: 0,
        matchedLinks: 0,
        expectedSections: 0,
        matchedSections: 0,
        expectedCards: 0,
        matchedCards: 0,
        expectedHeaders: 0,
        matchedHeaders: 0,
        expectedFooters: 0,
        matchedFooters: 0,
        expectedPositionedNodes: 0,
        matchedPositionedNodes: 0
      }
    },
    snapshotEnabled: true,
    snapshotReason: "Snapshot visual falhou e exigiu fallback final.",
    fallbackReason:
      "fallback to pixel-perfect: snapshot visual ainda falhou na auditoria final; fallback final em iframe preservou a aparencia completa.",
    warnings: ["fallback to snapshot", "fallback to pixel-perfect"],
    themeAudit: {
      passed: true,
      sourceTheme: "dark",
      convertedTheme: "dark",
      sourceTokens: {},
      convertedTokens: {},
      issues: [],
      messages: []
    }
  });

  assert.equal(
    report.visualLogs.includes("[FALLBACK] fallback to snapshot triggered"),
    true
  );
  assert.equal(
    report.visualLogs.includes("[FALLBACK] fallback to pixel-perfect triggered"),
    true
  );
}

async function testV3NativeExportFallsBackToSnapshotWhenStructuralSimilarityIsLow() {
  const width = 180;
  const height = 120;
  const outputDir = await ensureOutputDir("native-visual-fidelity-tests");
  const reference = createSvgDataUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="#f2545b" /></svg>`
  );
  const sectionBox = {
    x: 0,
    y: 0,
    top: 0,
    right: width,
    bottom: height,
    left: 0,
    width,
    height,
    centerX: width / 2,
    centerY: height / 2
  };
  const textBox = {
    x: 24,
    y: 36,
    top: 36,
    right: width - 24,
    bottom: 76,
    left: 24,
    width: width - 48,
    height: 40,
    centerX: width / 2,
    centerY: 56
  };
  const capture: PageCapture = {
    id: "native-visual-fidelity",
    sourceKind: "raw-html",
    title: "Native Visual Fidelity",
    sourceHtml: "<body></body>",
    renderedHtml: "<html><body><section><h1>Hero Title</h1></section></body></html>",
    renderer: "browser",
    inputAnalysis: createMockInputAnalysis(),
    viewports: [
      {
        name: "desktop",
        width,
        height
      }
    ],
    domSnapshot: [],
    styleSnapshot: [],
    boxSnapshot: [],
    responsiveSnapshot: [],
    nodes: [
      {
        id: "hero-section",
        tag: "section",
        text: "",
        attributes: {},
        parentId: "page",
        childIds: ["hero-title"],
        computedStyles: {
          display: "flex",
          "flex-direction": "column",
          "justify-content": "center",
          "align-items": "flex-start",
          padding: "24px",
          gap: "12px",
          background: "#ffffff",
          "background-color": "#ffffff",
          color: "#111111"
        },
        box: sectionBox,
        viewportStates: {
          desktop: {
            computedStyles: {
              display: "flex",
              "flex-direction": "column",
              "justify-content": "center",
              "align-items": "flex-start",
              padding: "24px",
              gap: "12px",
              background: "#ffffff",
              "background-color": "#ffffff",
              color: "#111111"
            },
            box: sectionBox,
            isVisible: true
          }
        },
        visualOrder: 0,
        isVisible: true,
        asset: {}
      },
      {
        id: "hero-title",
        tag: "h1",
        text: "Hero Title",
        attributes: {},
        parentId: "hero-section",
        childIds: [],
        computedStyles: {
          display: "block",
          color: "#111111",
          "font-size": "32px",
          "font-weight": "700",
          margin: "0"
        },
        box: textBox,
        viewportStates: {
          desktop: {
            computedStyles: {
              display: "block",
              color: "#111111",
              "font-size": "32px",
              "font-weight": "700",
              margin: "0"
            },
            box: textBox,
            isVisible: true
          }
        },
        visualOrder: 1,
        isVisible: true,
        asset: {}
      }
    ],
    sections: [
      {
        id: "section-hero",
        nodeId: "hero-section",
        name: "hero-section",
        type: "hero",
        box: {
          x: 0,
          y: 0,
          width,
          height
        },
        subtreeNodeIds: ["hero-section", "hero-title"],
        originalHtml: `<section style="display:block;width:${width}px;height:${height}px;background:#f2545b;"></section>`,
        htmlCandidate: `<!doctype html><html><head><meta charset="utf-8" /><style>html,body{margin:0;padding:0;background:#fff;}</style></head><body><section style="display:flex;align-items:center;width:${width}px;height:${height}px;padding:24px;background:#ffffff;color:#111111;"><h1 style="margin:0;font:700 32px/1.2 Arial,sans-serif;">Hero Title</h1></section></body></html>`,
        complexity: createSectionCaptureComplexity(),
        viewports: {
          desktop: {
            viewport: "desktop",
            width,
            height,
            snapshotDataUrl: reference,
            linkOverlays: []
          }
        }
      }
    ],
    summary: {
      totalNodes: 2,
      visibleNodes: 2,
      images: 0,
      buttons: 0,
      textBlocks: 1,
      sections: 1
    },
    artifacts: {
      outputDir,
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
        desktop: reference
      }
    }
  };
  const layout: LayoutDocument = {
    id: "native-visual-fidelity-layout",
    title: "Native Visual Fidelity Layout",
    sourceKind: "raw-html",
    rootNodeId: "page",
    nodeCount: 2,
    sectionIds: ["hero-section"],
    semanticIndex: {
      hero: ["hero-section"],
      text: ["hero-title"]
    },
    detectedSections: [
      {
        id: "hero-section",
        type: "hero",
        confidence: 0.99,
        childIds: ["hero-title"],
        anchors: [],
        contains: ["hero", "text"]
      }
    ],
    nodes: [
      {
        id: "hero-section",
        tag: "section",
        kind: "section",
        parentId: "page",
        children: ["hero-title"],
        box: {
          x: 0,
          y: 0,
          width,
          height
        },
        visualOrder: 0,
        layout: {
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "flex-start",
          gap: "12px"
        },
        spacing: {
          padding: "24px"
        },
        style: {
          backgroundColor: "#ffffff",
          color: "#111111"
        },
        content: {},
        flags: {},
        detection: {
          semanticRole: "hero",
          confidence: 0.99,
          containsHeading: true
        },
        responsive: {}
      },
      {
        id: "hero-title",
        tag: "h1",
        kind: "text",
        parentId: "hero-section",
        children: [],
        box: {
          x: 24,
          y: 36,
          width: width - 48,
          height: 40
        },
        visualOrder: 1,
        layout: {
          display: "block"
        },
        spacing: {},
        style: {
          color: "#111111",
          fontSize: "32px",
          fontWeight: "700"
        },
        content: {
          text: "Hero Title"
        },
        flags: {},
        detection: {
          semanticRole: "text",
          confidence: 0.95
        },
        responsive: {}
      }
    ]
  };

  const result = await createElementorNativeExport({
    capture,
    layout,
    selectedMode: "editable",
    outputDir
  });

  assert.equal(result.emittedMode, "snapshot");
  assert.ok(result.snapshot);
  assert.equal(result.snapshot.overallSimilarity >= 0.99, true);

  if (isForceVisualSnapshotEnabled()) {
    return;
  }

  assert.match(result.warnings.join(" "), /similaridade visual/i);
}

async function testV3NativeExportFallsBackWhenEmbeddedAssetsStillMissSimilarityThreshold() {
  const width = 180;
  const height = 120;
  const outputDir = await ensureOutputDir("native-embedded-visual-fidelity-tests");
  const reference = createSvgDataUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="#f2545b" /></svg>`
  );
  const embeddedImage = createSvgDataUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72"><circle cx="36" cy="36" r="32" fill="#fde047" /></svg>`
  );
  const sectionBox = {
    x: 0,
    y: 0,
    top: 0,
    right: width,
    bottom: height,
    left: 0,
    width,
    height,
    centerX: width / 2,
    centerY: height / 2
  };
  const imageBox = {
    x: 24,
    y: 24,
    top: 24,
    right: 96,
    bottom: 96,
    left: 24,
    width: 72,
    height: 72,
    centerX: 60,
    centerY: 60
  };
  const capture: PageCapture = {
    id: "native-embedded-visual-fidelity",
    sourceKind: "raw-html",
    title: "Native Embedded Visual Fidelity",
    sourceHtml: "<body></body>",
    renderedHtml: "<html><body><section><img alt=\"Visual\" /></section></body></html>",
    renderer: "browser",
    inputAnalysis: createMockInputAnalysis(),
    viewports: [
      {
        name: "desktop",
        width,
        height
      }
    ],
    domSnapshot: [],
    styleSnapshot: [],
    boxSnapshot: [],
    responsiveSnapshot: [],
    nodes: [
      {
        id: "hero-section",
        tag: "section",
        text: "",
        attributes: {},
        parentId: "page",
        childIds: ["hero-image"],
        computedStyles: {
          display: "flex",
          "align-items": "center",
          padding: "24px",
          background: "#ffffff",
          "background-color": "#ffffff"
        },
        box: sectionBox,
        viewportStates: {
          desktop: {
            computedStyles: {
              display: "flex",
              "align-items": "center",
              padding: "24px",
              background: "#ffffff",
              "background-color": "#ffffff"
            },
            box: sectionBox,
            isVisible: true
          }
        },
        visualOrder: 0,
        isVisible: true,
        asset: {}
      },
      {
        id: "hero-image",
        tag: "img",
        text: "",
        attributes: {
          src: embeddedImage,
          alt: "Visual"
        },
        parentId: "hero-section",
        childIds: [],
        computedStyles: {
          display: "block",
          width: "72px",
          height: "72px"
        },
        box: imageBox,
        viewportStates: {
          desktop: {
            computedStyles: {
              display: "block",
              width: "72px",
              height: "72px"
            },
            box: imageBox,
            isVisible: true
          }
        },
        visualOrder: 1,
        isVisible: true,
        asset: {
          src: embeddedImage
        }
      }
    ],
    sections: [
      {
        id: "section-hero-embedded",
        nodeId: "hero-section",
        name: "hero-section",
        type: "hero",
        box: {
          x: 0,
          y: 0,
          width,
          height
        },
        subtreeNodeIds: ["hero-section", "hero-image"],
        originalHtml: `<section style="display:block;width:${width}px;height:${height}px;background:#f2545b;"></section>`,
        htmlCandidate: `<!doctype html><html><head><meta charset="utf-8" /><style>html,body{margin:0;padding:0;background:#fff;}</style></head><body><section style="display:flex;align-items:center;width:${width}px;height:${height}px;padding:24px;background:#ffffff;"><img src="${embeddedImage}" alt="Visual" style="display:block;width:72px;height:72px;" /></section></body></html>`,
        complexity: createSectionCaptureComplexity(),
        viewports: {
          desktop: {
            viewport: "desktop",
            width,
            height,
            snapshotDataUrl: reference,
            linkOverlays: []
          }
        }
      }
    ],
    summary: {
      totalNodes: 2,
      visibleNodes: 2,
      images: 1,
      buttons: 0,
      textBlocks: 0,
      sections: 1
    },
    artifacts: {
      outputDir,
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
        desktop: reference
      }
    }
  };
  const layout: LayoutDocument = {
    id: "native-embedded-visual-fidelity-layout",
    title: "Native Embedded Visual Fidelity Layout",
    sourceKind: "raw-html",
    rootNodeId: "page",
    nodeCount: 2,
    sectionIds: ["hero-section"],
    semanticIndex: {
      hero: ["hero-section"]
    },
    detectedSections: [
      {
        id: "hero-section",
        type: "hero",
        confidence: 0.99,
        childIds: ["hero-image"],
        anchors: [],
        contains: ["hero", "image"]
      }
    ],
    nodes: [
      {
        id: "hero-section",
        tag: "section",
        kind: "section",
        parentId: "page",
        children: ["hero-image"],
        box: {
          x: 0,
          y: 0,
          width,
          height
        },
        visualOrder: 0,
        layout: {
          display: "flex",
          alignItems: "center"
        },
        spacing: {
          padding: "24px"
        },
        style: {
          backgroundColor: "#ffffff"
        },
        content: {},
        flags: {},
        detection: {
          semanticRole: "hero",
          confidence: 0.99
        },
        responsive: {}
      },
      {
        id: "hero-image",
        tag: "img",
        kind: "image",
        parentId: "hero-section",
        children: [],
        box: {
          x: 24,
          y: 24,
          width: 72,
          height: 72
        },
        visualOrder: 1,
        layout: {},
        spacing: {},
        style: {},
        content: {
          src: embeddedImage,
          alt: "Visual"
        },
        flags: {},
        detection: {
          semanticRole: "image",
          confidence: 0.95
        },
        responsive: {}
      }
    ]
  };

  const result = await withSnapshotFlagsDisabled(() =>
    createElementorNativeExport({
      capture,
      layout,
      selectedMode: "editable",
      outputDir
    })
  );

  assert.equal(result.emittedMode, "snapshot");
  assert.ok(result.snapshot);
  assert.equal(result.snapshot.overallSimilarity >= 0.99, true);
  assert.match(result.warnings.join(" "), /similaridade visual/i);
  assert.equal(
    result.warnings.some((warning) => /assets locais embutidos/i.test(warning)),
    false
  );
}

async function testV3NativeExportFallsBackToSnapshotWhenStructuralVisualAuditFails() {
  const width = 240;
  const height = 140;
  const outputDir = await ensureOutputDir("native-visual-audit-fallback-tests");
  const reference = createSvgDataUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="#020617" /></svg>`
  );
  const heroBox = {
    x: 0,
    y: 0,
    top: 0,
    right: width,
    bottom: height,
    left: 0,
    width,
    height,
    centerX: width / 2,
    centerY: height / 2
  };
  const capture: PageCapture = {
    id: "native-visual-audit",
    sourceKind: "lovable-react-source",
    title: "Native Visual Audit Fallback",
    sourceHtml: "<body></body>",
    renderedHtml:
      "<html><body><section><h1>Dark source</h1><a href=\"#cta\">Action</a><input placeholder=\"Email\" /></section></body></html>",
    renderer: "browser",
    inputAnalysis: createMockInputAnalysis({
      layoutTypes: ["lovable-export", "tailwind"],
      frameworkHints: ["lovable", "tailwind"],
      structure: {
        heroSections: 1,
        buttons: 1,
        forms: 1,
        links: 1
      } as InputPageAnalysis["structure"]
    }),
    viewports: [
      {
        name: "desktop",
        width,
        height
      }
    ],
    domSnapshot: [],
    styleSnapshot: [],
    boxSnapshot: [],
    responsiveSnapshot: [],
    nodes: [
      {
        id: "hero-audit",
        tag: "section",
        text: "",
        attributes: {},
        parentId: "page",
        childIds: ["hero-title", "hero-button", "hero-input"],
        computedStyles: {
          display: "block",
          color: "#f8fafc"
        },
        box: heroBox,
        viewportStates: {
          desktop: {
            computedStyles: {
              display: "block",
              color: "#f8fafc"
            },
            box: heroBox,
            isVisible: true
          }
        },
        visualOrder: 0,
        isVisible: true,
        asset: {}
      },
      {
        id: "hero-title",
        tag: "h1",
        text: "Dark source",
        attributes: {},
        parentId: "hero-audit",
        childIds: [],
        computedStyles: {
          color: "#f8fafc"
        },
        box: heroBox,
        viewportStates: {},
        visualOrder: 1,
        isVisible: true,
        asset: {}
      },
      {
        id: "hero-button",
        tag: "a",
        text: "Action",
        attributes: {
          href: "#cta"
        },
        parentId: "hero-audit",
        childIds: [],
        computedStyles: {
          color: "#020617",
          "background-color": "#38bdf8",
          "border-radius": "999px",
          "box-shadow": "0 18px 40px rgba(56, 189, 248, 0.35)"
        },
        box: heroBox,
        viewportStates: {},
        visualOrder: 2,
        isVisible: true,
        asset: {
          href: "#cta"
        }
      },
      {
        id: "hero-input",
        tag: "input",
        text: "",
        attributes: {
          type: "email"
        },
        parentId: "hero-audit",
        childIds: [],
        computedStyles: {
          color: "#f8fafc",
          "background-color": "#111827",
          "border-radius": "14px",
          "box-shadow": "0 12px 24px rgba(15, 23, 42, 0.2)"
        },
        box: heroBox,
        viewportStates: {},
        visualOrder: 3,
        isVisible: true,
        asset: {}
      }
    ],
    sections: [
      {
        id: "section-hero-audit",
        nodeId: "hero-audit",
        name: "hero-audit",
        type: "hero",
        box: {
          x: 0,
          y: 0,
          width,
          height
        },
        subtreeNodeIds: ["hero-audit", "hero-title", "hero-button", "hero-input"],
        originalHtml: `<section style="display:block;width:${width}px;height:${height}px;background:#020617;"></section>`,
        htmlCandidate: `<!doctype html><html><head><meta charset="utf-8" /><style>html,body{margin:0;padding:0;background:#020617;}</style></head><body><section style="display:block;width:${width}px;height:${height}px;background:#020617;"></section></body></html>`,
        complexity: createSectionCaptureComplexity(),
        viewports: {
          desktop: {
            viewport: "desktop",
            width,
            height,
            snapshotDataUrl: reference,
            linkOverlays: []
          }
        }
      }
    ],
    themeAnalysis: {
      detectedTheme: "dark",
      dominantBackgroundLuminance: 0.018,
      dominantContrast: 15.4,
      colorSamples: [],
      designTokens: {
        globalBackground: "rgb(2, 6, 23)",
        foreground: "rgb(248, 250, 252)",
        primaryButtonColor: "rgb(56, 189, 248)",
        cardBackground: "rgb(17, 24, 39)",
        borderColor: "rgb(51, 65, 85)",
        radius: "14px",
        shadow: "0 18px 40px rgba(15, 23, 42, 0.2)"
      },
      styleSignals: {
        hasStrongDarkTheme: true,
        hasStyledButtons: true,
        hasStyledInputs: true,
        hasElevatedCards: false
      },
      roleCounts: {
        cards: 0,
        buttons: 1,
        inputs: 1,
        headers: 0,
        footers: 0,
        sections: 1
      },
      messages: ["dark theme detected"]
    },
    summary: {
      totalNodes: 4,
      visibleNodes: 4,
      links: 1,
      images: 0,
      buttons: 1,
      textBlocks: 1,
      sections: 1
    },
    artifacts: {
      outputDir,
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
        desktop: reference
      }
    }
  };
  const layout: LayoutDocument = {
    id: "native-visual-audit-layout",
    title: "Native Visual Audit Layout",
    sourceKind: "lovable-react-source",
    rootNodeId: "page",
    nodeCount: 4,
    sectionIds: ["hero-audit"],
    semanticIndex: {
      hero: ["hero-audit"],
      button: ["hero-button"]
    },
    detectedSections: [
      {
        id: "hero-audit",
        type: "hero",
        confidence: 0.99,
        childIds: ["hero-title", "hero-button", "hero-input"],
        anchors: [],
        contains: ["hero", "button", "text"]
      }
    ],
    nodes: [
      {
        id: "hero-audit",
        tag: "section",
        kind: "section",
        parentId: "page",
        children: ["hero-title", "hero-button", "hero-input"],
        box: {
          x: 0,
          y: 0,
          width,
          height
        },
        visualOrder: 0,
        layout: {},
        spacing: {},
        style: {
          color: "#f8fafc"
        },
        content: {},
        flags: {},
        detection: {
          semanticRole: "hero",
          confidence: 0.99,
          containsInteractive: true
        },
        responsive: {}
      },
      {
        id: "hero-title",
        tag: "h1",
        kind: "text",
        parentId: "hero-audit",
        children: [],
        box: {
          x: 24,
          y: 24,
          width: width - 48,
          height: 40
        },
        visualOrder: 1,
        layout: {},
        spacing: {},
        style: {
          color: "#f8fafc"
        },
        content: {
          text: "Dark source"
        },
        flags: {},
        detection: {
          semanticRole: "text",
          confidence: 0.95
        },
        responsive: {}
      },
      {
        id: "hero-button",
        tag: "a",
        kind: "button",
        parentId: "hero-audit",
        children: [],
        box: {
          x: 24,
          y: 80,
          width: 140,
          height: 42
        },
        visualOrder: 2,
        layout: {},
        spacing: {},
        style: {
          backgroundColor: "#38bdf8",
          borderRadius: "999px",
          boxShadow: "0 18px 40px rgba(56, 189, 248, 0.35)"
        },
        content: {
          href: "#cta"
        },
        flags: {},
        detection: {
          semanticRole: "button",
          confidence: 0.95
        },
        responsive: {}
      },
      {
        id: "hero-input",
        tag: "input",
        kind: "container",
        parentId: "hero-audit",
        children: [],
        box: {
          x: 24,
          y: 132,
          width: 180,
          height: 42
        },
        visualOrder: 3,
        layout: {},
        spacing: {},
        style: {
          backgroundColor: "#111827",
          borderRadius: "14px",
          boxShadow: "0 12px 24px rgba(15, 23, 42, 0.2)"
        },
        content: {},
        flags: {},
        detection: {
          semanticRole: "section",
          confidence: 0.8
        },
        responsive: {}
      }
    ]
  };

  const result = await createElementorNativeExport({
    capture,
    layout,
    selectedMode: "editable",
    outputDir
  });

  assert.equal(result.emittedMode, "snapshot");
  assert.equal(result.snapshot?.visualValidationReport?.status, "passed");
}

async function testV3ForceVisualSnapshotUsesSectionFallbackBeforePassing() {
  const desktopWidth = 1200;
  const tabletWidth = 900;
  const mobileWidth = 600;
  const sectionHeight = 100;
  const outputDir = await ensureOutputDir("snapshot-force-section-fallback-tests");
  const desktopReference = createSvgDataUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${desktopWidth}" height="${sectionHeight}" viewBox="0 0 ${desktopWidth} ${sectionHeight}"><rect width="${desktopWidth}" height="${sectionHeight}" fill="#f2545b" /></svg>`
  );
  const tabletReference = createSvgDataUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${tabletWidth}" height="${sectionHeight}" viewBox="0 0 ${tabletWidth} ${sectionHeight}"><rect width="${tabletWidth}" height="${sectionHeight}" fill="#f2545b" /></svg>`
  );
  const mobileReference = createSvgDataUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${mobileWidth}" height="${sectionHeight}" viewBox="0 0 ${mobileWidth} ${sectionHeight}"><rect width="${mobileWidth}" height="${sectionHeight}" fill="#f2545b" /></svg>`
  );
  const desktopLinkOverlay = {
    nodeId: "critical-link",
    href: "#buy",
    text: ".",
    isButton: false,
    box: {
      x: 0,
      y: 0,
      width: 40,
      height: 20
    },
    relativeBox: {
      x: 0,
      y: 0,
      width: 40 / desktopWidth,
      height: 20 / 120
    }
  };
  const tabletLinkOverlay = {
    ...desktopLinkOverlay,
    box: {
      x: 0,
      y: 0,
      width: 40,
      height: 20
    },
    relativeBox: {
      x: 0,
      y: 0,
      width: 40 / tabletWidth,
      height: 20 / 120
    }
  };
  const mobileLinkOverlay = {
    ...desktopLinkOverlay,
    box: {
      x: 0,
      y: 0,
      width: 40,
      height: 20
    },
    relativeBox: {
      x: 0,
      y: 0,
      width: 40 / mobileWidth,
      height: 20 / 120
    }
  };
  const capture = {
    id: "snapshot-force-section-fallback",
    sourceKind: "raw-html",
    title: "Forced Snapshot Section Fallback",
    sourceHtml: "<body></body>",
    renderedHtml:
      '<!doctype html><html><head><style>html,body{margin:0;padding:0;}</style></head><body><section data-capture-id="critical-section" style="width:100%;height:100px;background:#f2545b;"><a href="#buy" style="display:block;width:40px;height:20px;color:transparent;text-decoration:none;">.</a></section></body></html>',
    renderer: "browser",
    inputAnalysis: createMockInputAnalysis(),
    viewports: [
      {
        name: "desktop",
        width: desktopWidth,
        height: sectionHeight
      },
      {
        name: "tablet",
        width: tabletWidth,
        height: sectionHeight
      },
      {
        name: "mobile",
        width: mobileWidth,
        height: sectionHeight
      }
    ],
    domSnapshot: [],
    styleSnapshot: [],
    boxSnapshot: [],
    responsiveSnapshot: [],
    nodes: [],
    summary: {
      totalNodes: 1,
      visibleNodes: 1,
      images: 0,
      buttons: 1,
      textBlocks: 0,
      sections: 1
    },
    artifacts: {
      outputDir,
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
        desktop: desktopReference,
        tablet: tabletReference,
        mobile: mobileReference
      }
    }
  } satisfies PageCapture;
  const sections: SectionCapture[] = [
    {
      id: "critical-section-capture",
      nodeId: "critical-section",
      name: "critical-section",
      type: "hero",
      box: {
        x: 0,
        y: 0,
        width: desktopWidth,
        height: sectionHeight
      },
      subtreeNodeIds: ["critical-section"],
      originalHtml: `<section style="width:${desktopWidth}px;height:${sectionHeight}px;background:#f2545b;"></section>`,
      htmlCandidate: `<!doctype html><html><body><section style="width:${desktopWidth}px;height:${sectionHeight}px;background:#f2545b;"></section></body></html>`,
      complexity: createSectionCaptureComplexity(),
      viewports: {
        desktop: {
          viewport: "desktop",
          width: desktopWidth,
          height: 120,
          snapshotDataUrl: desktopReference,
          linkOverlays: [desktopLinkOverlay]
        },
        tablet: {
          viewport: "tablet",
          width: tabletWidth,
          height: 120,
          snapshotDataUrl: tabletReference,
          linkOverlays: [tabletLinkOverlay]
        },
        mobile: {
          viewport: "mobile",
          width: mobileWidth,
          height: 120,
          snapshotDataUrl: mobileReference,
          linkOverlays: [mobileLinkOverlay]
        }
      }
    }
  ];
  const layout: LayoutDocument = {
    id: "snapshot-force-section-fallback-layout",
    title: "Forced Snapshot Section Fallback Layout",
    sourceKind: "raw-html",
    rootNodeId: "page",
    nodeCount: 2,
    sectionIds: ["critical-section"],
    semanticIndex: {},
    detectedSections: [
      {
        id: "critical-section",
        type: "hero",
        confidence: 0.99,
        childIds: [],
        anchors: [],
        contains: ["hero"]
      }
    ],
    nodes: [
      {
        id: "page",
        kind: "page",
        parentId: null,
        children: ["critical-section"],
        box: {
          x: 0,
          y: 0,
          width: desktopWidth,
          height: sectionHeight
        },
        visualOrder: 0,
        layout: {},
        spacing: {},
        style: {},
        content: {},
        flags: {},
        responsive: {}
      },
      {
        id: "critical-section",
        tag: "section",
        kind: "section",
        parentId: "page",
        children: [],
        box: {
          x: 0,
          y: 0,
          width: desktopWidth,
          height: sectionHeight
        },
        visualOrder: 1,
        layout: {
          display: "block"
        },
        spacing: {},
        style: {
          backgroundColor: "#f2545b"
        },
        content: {},
        flags: {},
        detection: {
          semanticRole: "hero"
        },
        responsive: {}
      }
    ]
  };

  const result = await withForceVisualSnapshot(() =>
    createSnapshotElementorDocumentV3({
      capture,
      layout,
      sections,
      selectedMode: "snapshot",
      outputDir
    })
  );

  assert.equal(result.snapshot.visualValidationReport?.status, "passed");
  assert.ok(
    result.snapshot.visualValidationReport?.modeUsed === "section-fallback" ||
      result.snapshot.visualValidationReport?.modeUsed === "section-snapshot"
  );
  assert.equal(result.snapshot.visualValidationReport?.linksPreserved, 1);
  if (result.snapshot.visualValidationReport?.modeUsed === "section-fallback") {
    assert.equal(result.snapshot.visualValidationReport.sectionsWithFallback.length, 1);
    assert.equal(
      result.snapshot.visualValidationReport.sectionsWithFallback[0]?.fallbackStage,
      "section-recapture"
    );
    assert.equal(
      result.snapshot.visualValidationReport.sectionsWithFallback[0]?.preservedLinks,
      1
    );
  } else {
    assert.equal(result.snapshot.visualValidationReport?.sectionsWithFallback.length, 0);
  }
  assert.equal(result.snapshot.overallSimilarity >= 0.99, true);
  assertContainsSnapshotLinkOverlay(result.document);
}

async function testV3SnapshotEmitterFallsBackToFullPageSnapshotWhenSectionsAreUnsafe() {
  const width = 1200;
  const tabletWidth = 900;
  const mobileWidth = 600;
  const topSectionHeight = 100;
  const bottomSectionHeight = 100;
  const pageHeight = topSectionHeight + bottomSectionHeight;
  const topDesktop = createSvgDataUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${topSectionHeight}" viewBox="0 0 ${width} ${topSectionHeight}"><rect width="${width}" height="${topSectionHeight}" fill="#f2545b" /></svg>`
  );
  const bottomDesktop = createSvgDataUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${bottomSectionHeight}" viewBox="0 0 ${width} ${bottomSectionHeight}"><rect width="${width}" height="${bottomSectionHeight}" fill="#2e86ab" /></svg>`
  );
  const fullPageDesktop = createSvgDataUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${pageHeight}" viewBox="0 0 ${width} ${pageHeight}"><rect width="${width}" height="${topSectionHeight}" fill="#f2545b" /><rect y="${topSectionHeight}" width="${width}" height="${bottomSectionHeight}" fill="#2e86ab" /></svg>`
  );
  const fullPageTablet = createSvgDataUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${tabletWidth}" height="${pageHeight}" viewBox="0 0 ${tabletWidth} ${pageHeight}"><rect width="${tabletWidth}" height="${topSectionHeight}" fill="#f2545b" /><rect y="${topSectionHeight}" width="${tabletWidth}" height="${bottomSectionHeight}" fill="#2e86ab" /></svg>`
  );
  const fullPageMobile = createSvgDataUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${mobileWidth}" height="${pageHeight}" viewBox="0 0 ${mobileWidth} ${pageHeight}"><rect width="${mobileWidth}" height="${topSectionHeight}" fill="#f2545b" /><rect y="${topSectionHeight}" width="${mobileWidth}" height="${bottomSectionHeight}" fill="#2e86ab" /></svg>`
  );
  const capture = {
    id: "snapshot-full-page",
    sourceKind: "raw-html",
    title: "Snapshot Full Page",
    sourceHtml: "<body></body>",
    renderedHtml: "<html><body></body></html>",
    renderer: "browser",
    inputAnalysis: createMockInputAnalysis(),
    viewports: [
      {
        name: "desktop",
        width,
        height: pageHeight
      },
      {
        name: "tablet",
        width: tabletWidth,
        height: pageHeight
      },
      {
        name: "mobile",
        width: mobileWidth,
        height: pageHeight
      }
    ],
    domSnapshot: [],
    styleSnapshot: [],
    boxSnapshot: [],
    responsiveSnapshot: [],
    nodes: [
      {
        id: "hero-link",
        tag: "a",
        text: "Buy",
        attributes: {
          href: "#buy"
        },
        parentId: "page",
        childIds: [],
        computedStyles: {},
        box: {
          x: 120,
          y: 40,
          top: 40,
          right: 520,
          bottom: 60,
          left: 120,
          width: 400,
          height: 20,
          centerX: 320,
          centerY: 50
        },
        viewportStates: {
          desktop: {
            computedStyles: {},
            box: {
              x: 120,
              y: 40,
              top: 40,
              right: 520,
              bottom: 60,
              left: 120,
              width: 400,
              height: 20,
              centerX: 320,
              centerY: 50
            },
            isVisible: true
          },
          tablet: {
            computedStyles: {},
            box: {
              x: 90,
              y: 40,
              top: 40,
              right: 390,
              bottom: 60,
              left: 90,
              width: 300,
              height: 20,
              centerX: 240,
              centerY: 50
            },
            isVisible: true
          },
          mobile: {
            computedStyles: {},
            box: {
              x: 60,
              y: 40,
              top: 40,
              right: 260,
              bottom: 60,
              left: 60,
              width: 200,
              height: 20,
              centerX: 160,
              centerY: 50
            },
            isVisible: true
          }
        },
        visualOrder: 1,
        isVisible: true,
        asset: {
          href: "#buy"
        }
      }
    ],
    summary: {
      totalNodes: 1,
      visibleNodes: 1,
      images: 0,
      buttons: 1,
      textBlocks: 0,
      sections: 2
    },
    artifacts: {
      outputDir: path.join(os.tmpdir(), "snapshot-full-page-tests"),
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
        desktop: fullPageDesktop,
        tablet: fullPageTablet,
        mobile: fullPageMobile
      }
    }
  } satisfies PageCapture;
  const sections: SectionCapture[] = [
    {
      id: "hero-section",
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
      htmlCandidate: `<!doctype html><html><body><section style="width:${width}px;height:${topSectionHeight}px;background:#f2545b;"></section></body></html>`,
      complexity: createSectionCaptureComplexity(),
      viewports: {
        desktop: {
          viewport: "desktop",
          width,
          height: topSectionHeight,
          snapshotDataUrl: topDesktop,
          linkOverlays: []
        }
      }
    },
    {
      id: "feature-section",
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
      htmlCandidate: `<!doctype html><html><body><section style="width:${width}px;height:${bottomSectionHeight}px;background:#2e86ab;"></section></body></html>`,
      complexity: createSectionCaptureComplexity(),
      viewports: {
        desktop: {
          viewport: "desktop",
          width,
          height: bottomSectionHeight,
          snapshotDataUrl: bottomDesktop,
          linkOverlays: []
        }
      }
    }
  ];
  const layout: LayoutDocument = {
    id: "snapshot-full-page-layout",
    title: "Snapshot Full Page Layout",
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
        confidence: 0.9,
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

  assert.equal(result.document.content.length, 1);
  assert.equal(result.snapshot.renderStrategy, "full-page-snapshot");
  assert.equal(result.snapshot.totals.htmlSections, 0);
  assert.equal(result.snapshot.totals.snapshotSections, 1);
  assert.equal(result.snapshot.totals.totalLinks, 1);
  assert.equal(result.snapshot.totals.preservedLinks, 1);
  assert.equal(result.snapshot.overallSimilarity >= 0.99, true);
  assert.match(String(result.snapshot.fullPageFallbackReason), /hero-1|section-2/);
  assertContainsSnapshotLinkOverlay(result.document);
}

async function testV3ForceVisualSnapshotPrefersFullPageSnapshotForComplexVisualPages() {
  const width = 1200;
  const tabletWidth = 768;
  const mobileWidth = 390;
  const topSectionHeight = 120;
  const bottomSectionHeight = 120;
  const pageHeight = topSectionHeight + bottomSectionHeight;
  const topDesktop = createSvgDataUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${topSectionHeight}" viewBox="0 0 ${width} ${topSectionHeight}"><rect width="${width}" height="${topSectionHeight}" fill="#101820" /></svg>`
  );
  const bottomDesktop = createSvgDataUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${bottomSectionHeight}" viewBox="0 0 ${width} ${bottomSectionHeight}"><rect width="${width}" height="${bottomSectionHeight}" fill="#f2aa4c" /></svg>`
  );
  const fullPageDesktop = createSvgDataUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${pageHeight}" viewBox="0 0 ${width} ${pageHeight}"><rect width="${width}" height="${topSectionHeight}" fill="#101820" /><rect y="${topSectionHeight}" width="${width}" height="${bottomSectionHeight}" fill="#f2aa4c" /></svg>`
  );
  const fullPageTablet = createSvgDataUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${tabletWidth}" height="${pageHeight}" viewBox="0 0 ${tabletWidth} ${pageHeight}"><rect width="${tabletWidth}" height="${topSectionHeight}" fill="#101820" /><rect y="${topSectionHeight}" width="${tabletWidth}" height="${bottomSectionHeight}" fill="#f2aa4c" /></svg>`
  );
  const fullPageMobile = createSvgDataUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${mobileWidth}" height="${pageHeight}" viewBox="0 0 ${mobileWidth} ${pageHeight}"><rect width="${mobileWidth}" height="${topSectionHeight}" fill="#101820" /><rect y="${topSectionHeight}" width="${mobileWidth}" height="${bottomSectionHeight}" fill="#f2aa4c" /></svg>`
  );
  const capture = {
    id: "snapshot-force-complex-page",
    sourceKind: "raw-html",
    title: "Forced Snapshot Complex Page",
    sourceHtml: "<body></body>",
    renderedHtml:
      '<!doctype html><html><body style="margin:0;"><section data-capture-id="hero-section" style="width:100%;height:120px;background:#101820;"></section><section data-capture-id="feature-section" style="width:100%;height:120px;background:#f2aa4c;"></section></body></html>',
    renderer: "browser",
    inputAnalysis: createMockInputAnalysis({
      layoutTypes: ["lovable-export", "react-runtime", "tailwind", "scripted"],
      frameworkHints: ["lovable", "react", "tailwind"],
      structure: {
        absoluteFixedSticky: 5,
        zIndexNodes: 6,
        transformedElements: 4,
        externalFonts: 2,
        links: 4,
        outOfFlowElements: 5
      } as InputPageAnalysis["structure"]
    }),
    viewports: [
      {
        name: "desktop",
        width,
        height: pageHeight
      },
      {
        name: "tablet",
        width: tabletWidth,
        height: pageHeight
      },
      {
        name: "mobile",
        width: mobileWidth,
        height: pageHeight
      }
    ],
    domSnapshot: [],
    styleSnapshot: [],
    boxSnapshot: [],
    responsiveSnapshot: [],
    nodes: [
      {
        id: "hero-link",
        tag: "a",
        text: "Explore",
        attributes: {
          href: "#explore"
        },
        parentId: "hero-section",
        childIds: [],
        computedStyles: {
          position: "absolute",
          "z-index": "10"
        },
        box: {
          x: 100,
          y: 40,
          top: 40,
          right: 340,
          bottom: 70,
          left: 100,
          width: 240,
          height: 30,
          centerX: 220,
          centerY: 55
        },
        viewportStates: {
          desktop: {
            computedStyles: {
              position: "absolute",
              "z-index": "10"
            },
            box: {
              x: 100,
              y: 40,
              top: 40,
              right: 340,
              bottom: 70,
              left: 100,
              width: 240,
              height: 30,
              centerX: 220,
              centerY: 55
            },
            isVisible: true
          },
          tablet: {
            computedStyles: {
              position: "absolute",
              "z-index": "10"
            },
            box: {
              x: 80,
              y: 40,
              top: 40,
              right: 260,
              bottom: 70,
              left: 80,
              width: 180,
              height: 30,
              centerX: 170,
              centerY: 55
            },
            isVisible: true
          },
          mobile: {
            computedStyles: {
              position: "absolute",
              "z-index": "10"
            },
            box: {
              x: 40,
              y: 40,
              top: 40,
              right: 200,
              bottom: 70,
              left: 40,
              width: 160,
              height: 30,
              centerX: 120,
              centerY: 55
            },
            isVisible: true
          }
        },
        visualOrder: 1,
        isVisible: true,
        asset: {
          href: "#explore"
        }
      }
    ],
    summary: {
      totalNodes: 3,
      visibleNodes: 3,
      links: 1,
      images: 0,
      buttons: 1,
      textBlocks: 2,
      sections: 2
    },
    artifacts: {
      outputDir: path.join(os.tmpdir(), "snapshot-force-complex-page-tests"),
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
        desktop: fullPageDesktop,
        tablet: fullPageTablet,
        mobile: fullPageMobile
      }
    }
  } satisfies PageCapture;
  const sections: SectionCapture[] = [
    {
      id: "hero-section-capture",
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
      originalHtml: `<section style="width:${width}px;height:${topSectionHeight}px;background:#101820;"></section>`,
      htmlCandidate: `<!doctype html><html><body><section style="width:${width}px;height:${topSectionHeight}px;background:#101820;"></section></body></html>`,
      complexity: createSectionCaptureComplexity({
        absoluteNodes: 2,
        overlayNodes: 3,
        complexZIndexNodes: 3,
        transformedNodes: 2,
        pseudoElementNodes: 2,
        hasPseudoElements: true,
        hasTransforms: true,
        unsupportedCssNodes: 1
      }),
      viewports: {
        desktop: {
          viewport: "desktop",
          width,
          height: topSectionHeight,
          snapshotDataUrl: topDesktop,
          linkOverlays: []
        },
        tablet: {
          viewport: "tablet",
          width: tabletWidth,
          height: topSectionHeight,
          snapshotDataUrl: createSvgDataUrl(
            `<svg xmlns="http://www.w3.org/2000/svg" width="${tabletWidth}" height="${topSectionHeight}" viewBox="0 0 ${tabletWidth} ${topSectionHeight}"><rect width="${tabletWidth}" height="${topSectionHeight}" fill="#101820" /></svg>`
          ),
          linkOverlays: []
        },
        mobile: {
          viewport: "mobile",
          width: mobileWidth,
          height: topSectionHeight,
          snapshotDataUrl: createSvgDataUrl(
            `<svg xmlns="http://www.w3.org/2000/svg" width="${mobileWidth}" height="${topSectionHeight}" viewBox="0 0 ${mobileWidth} ${topSectionHeight}"><rect width="${mobileWidth}" height="${topSectionHeight}" fill="#101820" /></svg>`
          ),
          linkOverlays: []
        }
      },
      debug: {
        sectionBoundingBox: {
          x: 0,
          y: 0,
          width,
          height: topSectionHeight
        },
        sectionWidth: width,
        sectionHeight: topSectionHeight,
        originalImages: [],
        cssBackgrounds: [],
        loadedFonts: [
          {
            family: "Inter Tight",
            status: "loaded"
          }
        ],
        interactiveElements: [],
        positionedElements: [
          {
            nodeId: "hero-link",
            tag: "a",
            position: "absolute",
            zIndex: "10",
            overlapsSection: true,
            insideSection: true
          }
        ]
      }
    },
    {
      id: "feature-section-capture",
      nodeId: "feature-section",
      name: "feature-2",
      type: "section",
      box: {
        x: 0,
        y: topSectionHeight,
        width,
        height: bottomSectionHeight
      },
      subtreeNodeIds: ["feature-section"],
      originalHtml: `<section style="width:${width}px;height:${bottomSectionHeight}px;background:#f2aa4c;"></section>`,
      htmlCandidate: `<!doctype html><html><body><section style="width:${width}px;height:${bottomSectionHeight}px;background:#f2aa4c;"></section></body></html>`,
      complexity: createSectionCaptureComplexity({
        overlayNodes: 1,
        complexZIndexNodes: 1,
        transformedNodes: 1,
        gradientNodes: 1,
        hasTransforms: true
      }),
      viewports: {
        desktop: {
          viewport: "desktop",
          width,
          height: bottomSectionHeight,
          snapshotDataUrl: bottomDesktop,
          linkOverlays: []
        },
        tablet: {
          viewport: "tablet",
          width: tabletWidth,
          height: bottomSectionHeight,
          snapshotDataUrl: createSvgDataUrl(
            `<svg xmlns="http://www.w3.org/2000/svg" width="${tabletWidth}" height="${bottomSectionHeight}" viewBox="0 0 ${tabletWidth} ${bottomSectionHeight}"><rect width="${tabletWidth}" height="${bottomSectionHeight}" fill="#f2aa4c" /></svg>`
          ),
          linkOverlays: []
        },
        mobile: {
          viewport: "mobile",
          width: mobileWidth,
          height: bottomSectionHeight,
          snapshotDataUrl: createSvgDataUrl(
            `<svg xmlns="http://www.w3.org/2000/svg" width="${mobileWidth}" height="${bottomSectionHeight}" viewBox="0 0 ${mobileWidth} ${bottomSectionHeight}"><rect width="${mobileWidth}" height="${bottomSectionHeight}" fill="#f2aa4c" /></svg>`
          ),
          linkOverlays: []
        }
      },
      debug: {
        sectionBoundingBox: {
          x: 0,
          y: topSectionHeight,
          width,
          height: bottomSectionHeight
        },
        sectionWidth: width,
        sectionHeight: bottomSectionHeight,
        originalImages: [],
        cssBackgrounds: [],
        loadedFonts: [
          {
            family: "Material Symbols Rounded",
            status: "loaded"
          }
        ],
        interactiveElements: [],
        positionedElements: []
      }
    }
  ];
  const layout: LayoutDocument = {
    id: "snapshot-force-complex-page-layout",
    title: "Forced Snapshot Complex Page Layout",
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
        confidence: 0.9,
        childIds: [],
        anchors: [],
        contains: ["section"]
      }
    ],
    nodes: []
  };

  const result = await withForceVisualSnapshot(() =>
    createSnapshotElementorDocumentV3({
      capture,
      layout,
      sections,
      selectedMode: "snapshot"
    })
  );

  assert.equal(result.snapshot.renderStrategy, "full-page-snapshot");
  assert.equal(result.snapshot.visualValidationReport?.status, "passed");
  assert.equal(result.snapshot.overallSimilarity >= 0.99, true);
  assert.match(
    String(result.snapshot.fullPageFallbackReason),
    /Complexidade visual alta detectada|Politica universal Lovable-like|FORCE_FULL_PAGE_SNAPSHOT ativo/i
  );
  assertContainsSnapshotLinkOverlay(result.document);
}

async function testV3ForceVisualSnapshotBlocksOnlyAfterFullPageFallbackFails() {
  const desktopWidth = 1200;
  const tabletWidth = 900;
  const mobileWidth = 600;
  const referenceHeight = 100;
  const viewportHeight = 120;
  const outputDir = await ensureOutputDir("snapshot-force-blocked-tests");
  const fullPageDesktop = createSvgDataUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${desktopWidth}" height="${referenceHeight}" viewBox="0 0 ${desktopWidth} ${referenceHeight}"><rect width="${desktopWidth}" height="${referenceHeight}" fill="#f2545b" /></svg>`
  );
  const fullPageTablet = createSvgDataUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${tabletWidth}" height="${referenceHeight}" viewBox="0 0 ${tabletWidth} ${referenceHeight}"><rect width="${tabletWidth}" height="${referenceHeight}" fill="#f2545b" /></svg>`
  );
  const fullPageMobile = createSvgDataUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${mobileWidth}" height="${referenceHeight}" viewBox="0 0 ${mobileWidth} ${referenceHeight}"><rect width="${mobileWidth}" height="${referenceHeight}" fill="#f2545b" /></svg>`
  );
  const capture = {
    id: "snapshot-force-blocked",
    sourceKind: "raw-html",
    title: "Forced Snapshot Blocked",
    sourceHtml: "<body></body>",
    renderedHtml: "<html><body></body></html>",
    renderer: "browser",
    inputAnalysis: createMockInputAnalysis(),
    viewports: [
      {
        name: "desktop",
        width: desktopWidth,
        height: viewportHeight
      },
      {
        name: "tablet",
        width: tabletWidth,
        height: viewportHeight
      },
      {
        name: "mobile",
        width: mobileWidth,
        height: viewportHeight
      }
    ],
    domSnapshot: [],
    styleSnapshot: [],
    boxSnapshot: [],
    responsiveSnapshot: [],
    nodes: [],
    summary: {
      totalNodes: 1,
      visibleNodes: 1,
      images: 0,
      buttons: 0,
      textBlocks: 0,
      sections: 1
    },
    artifacts: {
      outputDir,
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
        desktop: fullPageDesktop,
        tablet: fullPageTablet,
        mobile: fullPageMobile
      }
    }
  } satisfies PageCapture;
  const sections: SectionCapture[] = [
    {
      id: "unsafe-section-capture",
      nodeId: "unsafe-section",
      name: "unsafe-section-1",
      type: "section",
      box: {
        x: 0,
        y: 0,
        width: desktopWidth,
        height: referenceHeight
      },
      subtreeNodeIds: ["unsafe-section"],
      originalHtml: `<section style="width:${desktopWidth}px;height:${referenceHeight}px;background:#f2545b;"></section>`,
      htmlCandidate: `<!doctype html><html><body><section style="width:${desktopWidth}px;height:${referenceHeight}px;background:#f2545b;"></section></body></html>`,
      complexity: createSectionCaptureComplexity(),
      viewports: {
        desktop: {
          viewport: "desktop",
          width: desktopWidth,
          height: referenceHeight,
          snapshotDataUrl: fullPageDesktop,
          linkOverlays: []
        }
      }
    }
  ];
  const layout: LayoutDocument = {
    id: "snapshot-force-blocked-layout",
    title: "Forced Snapshot Blocked Layout",
    sourceKind: "raw-html",
    rootNodeId: "page",
    nodeCount: 2,
    sectionIds: ["unsafe-section"],
    semanticIndex: {},
    detectedSections: [
      {
        id: "unsafe-section",
        type: "section",
        confidence: 0.9,
        childIds: [],
        anchors: [],
        contains: ["section"]
      }
    ],
    nodes: []
  };

  const result = await withForceVisualSnapshot(() =>
    createSnapshotElementorDocumentV3({
      capture,
      layout,
      sections,
      selectedMode: "snapshot",
      outputDir
    })
  );

  assert.equal(result.snapshot.visualValidationReport?.status, "passed");
  assert.equal(result.snapshot.visualValidationReport?.modeUsed, "full-page-snapshot");
  assert.equal(result.snapshot.overallSimilarity >= 0.99, true);
  assert.equal(result.snapshot.visualValidationReport?.blockingReason, undefined);
}

async function main() {
  await testForceVisualSnapshotDefaultsToTrue();
  await testForceFullPageSnapshotDefaultsToFalse();
  await testV3HtmlCapturePipeline();
  await testV3HtmlCaptureTreatsInlineSvgAsImageAsset();
  await testV3SectionCaptureExpandsForOverflowingHeaderMedia();
  await testV3HtmlCaptureCollectsExpandedComputedStyles();
  await testV3HtmlCapturePreservesMultiLayerBackgroundImages();
  await testV3HtmlCaptureTracksPictureSourcesAndLazyImages();
  await testV3HtmlCaptureWaitsForDelayedFooterContent();
  await testV3HtmlCaptureDetectsVisualPseudoElements();
  await testV3SectionCaptureTracksHeroOverlayCardImagesAndPseudoBackgrounds();
  await testV3BrowserDiagnosticsResolveRelativeHeroCardAndPseudoAssets();
  await testV3CriticalAssetFailuresPromoteSnapshotFallback();
  await testV3HtmlCapturePreservesThemeCssVariables();
  await testV3ThemeDetectorIdentifiesDarkFixtures();
  await testV3ThemeDetectorIdentifiesLightFixtures();
  await testV3ThemeAuditFailsWhenDarkSourceTurnsIntoLightClone();
  await testV3ThemeAuditFlagsGlobalBackgroundMismatchInsideDarkTheme();
  testV3VisualAuditFlagsDarkCloneAndWhiteCards();
  testV3VisualAuditFlagsDefaultButtonFixture();
  testV3VisualAuditFlagsDefaultInputFixture();
  testV3VisualAuditFlagsHeroOverlayMissingFixture();
  testV3VisualAuditFlagsImportantVisualAssetMessage();
  testV3VisualAuditFlagsWhiteCardsFixture();
  testV3VisualAuditFlagsHeaderFooterMismatchAndPageHeightDifference();
  testV3VisualClonePolicyPromotesHighRiskLovableLayouts();
  testV3VisualClonePolicyPromotesHighRiskDarkGenericLayouts();
  await testV3LovableLikeSitesKeepEditableWhenVisualRiskIsLow();
  await testV3ServerRenderedDarkHighRiskPagesJumpToPixelPerfect();
  await testV3ServerFallbackResolvesStylesheetDrivenDarkShell();
  await testV3ZipResolver();
  await testV3ZipResolverPrefersReactSourceWhenZipIncludesIndexHtml();
  await testV3ZipResolverSupportsNonStandardEntryAndPageNames();
  await testV3ZipResolverSupportsRouterProvidersAndImportedRouteContent();
  await testV3ComplexitySelection();
  await testV3ExportPipeline();
  await testV3HybridSectionFallback();
  await testV3HybridPreservesGridWidths();
  await testV3HybridKeepsRichPatternedGridStructural();
  await testV3HybridDetectsPricingPreset();
  await testV3HybridComposesTestimonialWidgets();
  await testV3EditableComposesPricingWidgets();
  await testV3EditableUsesUniversalNeutralModeForLovableLayouts();
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
  await testV3EditablePreservesStyledButtonVisuals();
  await testV3EditableNormalizesButtonUnderline();
  await testV3StyledHtmlFragmentNormalizesDefaultLinkUnderline();
  await testV3StyledHtmlFragmentNormalizesClickableUnderlineStyles();
  testV3PixelPerfectInjectsClickableUnderlineReset();
  await testV3EditablePreservesStyledInputAsHtml();
  await testV3EditablePreservesDarkCardShell();
  await testV3EditablePreservesHeroBackgroundAndOverlay();
  await testV3EditablePreservesDarkFooterShell();
  testV3EditableWrapsGlobalPageShellWhenOnlyBodyCarriesDarkTheme();
  testV3PageShellIgnoresTransparentBodyBackgroundShorthand();
  testV3ElementorBackgroundColorNormalizesModernCssColors();
  await testV3NativeExportKeepsDetectedPageShellWhenLayoutRootIsWhite();
  await testV3SnapshotEmitterPropagatesDetectedPageBackgroundOnlyToPageShell();
  await testV3PixelPerfectEmitterInjectsDetectedPageBackgroundVariableWithoutGlobalOverride();
  testV3SnapshotValidationTreatsCanvasMismatchAsPageBackgroundOnly();
  await testV3NativeExportPreservesBackgroundImages();
  await testV3NativeExportPreservesNestedBackgroundImagesFromLocalAssets();
  await testV3NativeExportPreservesRootBackgroundColorImageAndGradientOverlay();
  await testV3NativeExportFallsBackToHtmlBackgroundWhenBodyIsTransparent();
  testResponsiveChildSettingsHelper();
  testResponsiveGridColumnReductionHelper();
  testResponsiveSplitPatternHelper();
  testPatternOrderedChildIdsHelper();
  testResponsivePresetDetectionHelper();
  testSectionClassifierDetectsSemanticSections();
  testSectionClassifierDetectsFaqAndCtaSections();
  await testV3SnapshotEmitterKeepsSimpleSectionsAsHtmlAndFallsBackPerSection();
  await testV3SnapshotEmitterBlocksHtmlProfilesAfterHardFailure();
  await testV3SnapshotEmitterKeepsSnapshotOutputWhenSectionAlreadyMatchesVisually();
  await testV3ForceVisualSnapshotDisablesEditableAndHybridFallbacks();
  await testV3ForceVisualSnapshotFallsBackToPixelPerfectWhenSnapshotCannotBeValidated();
  await testV3SnapshotSelectionFallsBackToPixelPerfectWithoutForceFlag();
  await testV3ForceFullPageSnapshotUsesSingleResponsivePageSnapshot();
  await testV3ForceFullPageSnapshotFallsBackToPixelPerfectOnlyWhenSnapshotCannotBeCreated();
  await testV3LovableLikeSitesAutomaticallyUseUniversalFullPageClone();
  await testV3ForcedSnapshotReportIncludesViewportLogs();
  await testV3NativeExportFallsBackToSnapshotWhenStructuralSimilarityIsLow();
  await testV3NativeExportFallsBackWhenEmbeddedAssetsStillMissSimilarityThreshold();
  await testV3NativeExportFallsBackToSnapshotWhenStructuralVisualAuditFails();
  testBuildExportReportFormatsFriendlyVisualValidationLogs();
  testBuildExportReportIncludesFallbackTriggeredMessages();
  await testV3ForceVisualSnapshotUsesSectionFallbackBeforePassing();
  await testV3SnapshotEmitterFallsBackToFullPageSnapshotWhenSectionsAreUnsafe();
  await testV3ForceVisualSnapshotPrefersFullPageSnapshotForComplexVisualPages();
  await testV3ForceVisualSnapshotBlocksOnlyAfterFullPageFallbackFails();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
