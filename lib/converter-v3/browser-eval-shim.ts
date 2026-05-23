export async function installBrowserEvalShim(page: {
  evaluate: {
    <Result>(pageFunction: () => Result | Promise<Result>): Promise<Result>;
  };
}) {
  await page.evaluate(() => {
    if (!(globalThis as { __name?: unknown }).__name) {
      (globalThis as { __name?: <T>(value: T, name?: string) => T }).__name = <T>(
        value: T
      ) => value;
    }
  });
}
