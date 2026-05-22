import assert from "node:assert/strict";

import {
  createDownloadGetHandler,
  type DownloadRouteDependencies
} from "../lib/api/download-route";

function createBaseDependencies(): DownloadRouteDependencies {
  return {
    getConversion: async () =>
      ({
        id: "conversion-id",
        html: "<html><body>preview</body></html>",
        elementor_json: {
          version: "1.0",
          title: "Downloaded Template",
          type: "page",
          content: [
            {
              id: "section-1",
              elType: "section",
              settings: {},
              elements: []
            }
          ]
        },
        status: "paid",
        payment_id: "pi_123",
        created_at: "2026-05-22T00:00:00.000Z",
        updated_at: "2026-05-22T00:00:00.000Z"
      }) as never,
    markConversionAsPaid: async () => undefined,
    getStripeCheckoutSession: async () =>
      ({
        metadata: {},
        payment_status: "unpaid"
      }) as never
  };
}

async function testDownloadRouteReturnsValidJsonFile() {
  const handler = createDownloadGetHandler(createBaseDependencies());
  const response = await handler(new Request("http://localhost/api/download/conversion-id"), {
    params: Promise.resolve({
      id: "conversion-id"
    })
  });
  const jsonText = await response.text();

  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("Content-Type"),
    "application/json; charset=utf-8"
  );
  assert.match(
    String(response.headers.get("Content-Disposition")),
    /elementor-template\.json/
  );
  assert.doesNotThrow(() => JSON.parse(jsonText));

  const parsed = JSON.parse(jsonText) as {
    title: string;
    content: Array<{ elType: string }>;
  };

  assert.equal(parsed.title, "Downloaded Template");
  assert.equal(parsed.content[0]?.elType, "section");
}

async function main() {
  await testDownloadRouteReturnsValidJsonFile();
  console.log("download route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
