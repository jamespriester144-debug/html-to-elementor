import assert from "node:assert/strict";

import { createBrowserPageWithLocator } from "../lib/converter-v3/sections/visual-section-capture";

class MockBrowserPage {
  calls: string[] = [];

  async close() {
    this.calls.push("close");
  }

  async evaluate(_pageFunction: unknown, arg?: unknown) {
    this.calls.push(`evaluate:${String(arg)}`);
    return {
      ok: true,
      calls: [...this.calls]
    };
  }

  async screenshot() {
    this.calls.push("screenshot");
    return new Uint8Array();
  }

  async setContent(html: string) {
    this.calls.push(`setContent:${html}`);
  }

  async setJavaScriptEnabled(enabled: boolean) {
    this.calls.push(`setJavaScriptEnabled:${String(enabled)}`);
  }

  async setViewport(viewport: { width: number; height: number }) {
    this.calls.push(`setViewport:${viewport.width}x${viewport.height}`);
  }

  async waitForLoadState(state: "load" | "domcontentloaded" | "networkidle") {
    this.calls.push(`waitForLoadState:${state}`);
  }

  async waitForNetworkIdle() {
    this.calls.push("waitForNetworkIdle");
  }

  async waitForSelector(selector: string) {
    this.calls.push(`waitForSelector:${selector}`);
  }
}

async function testCreateBrowserPageWithLocatorPreservesMethodContext() {
  const page = new MockBrowserPage();
  const wrapped = createBrowserPageWithLocator(page as never);

  const result = await wrapped.evaluate(
    () => ({
      ok: true,
      calls: [] as string[]
    })
  );

  await wrapped.setJavaScriptEnabled?.(true);
  await wrapped.setViewport?.({ width: 1280, height: 720 });
  await wrapped.waitForLoadState?.("domcontentloaded");
  await wrapped.waitForNetworkIdle?.();
  await wrapped.waitForSelector?.("body");
  await wrapped.setContent("<main>ok</main>");
  await wrapped.screenshot();
  await wrapped.close();

  assert.equal(result.ok, true);
  assert.deepEqual(page.calls, [
    "evaluate:undefined",
    "setJavaScriptEnabled:true",
    "setViewport:1280x720",
    "waitForLoadState:domcontentloaded",
    "waitForNetworkIdle",
    "waitForSelector:body",
    "setContent:<main>ok</main>",
    "screenshot",
    "close"
  ]);
}

async function main() {
  await testCreateBrowserPageWithLocatorPreservesMethodContext();
  console.log("visual section capture tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
