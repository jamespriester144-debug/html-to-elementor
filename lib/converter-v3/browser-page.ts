export type BrowserViewport = {
  width: number;
  height: number;
  deviceScaleFactor?: number;
};

export type BrowserWaitOptions = {
  timeout?: number;
};

export type BrowserSetContentOptions = {
  waitUntil?: "load" | "domcontentloaded";
  timeout?: number;
};

export type BrowserNetworkIdleOptions = {
  idleTime?: number;
  timeout?: number;
};

export type BrowserScreenshotOptions = {
  clip?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  path?: string;
  fullPage?: boolean;
  type?: "png" | "jpeg";
};

export type BrowserLocator = {
  count: () => Promise<number>;
  screenshot: (options?: BrowserScreenshotOptions) => Promise<Uint8Array>;
};

export type BrowserPage = {
  close: () => Promise<unknown>;
  evaluate: {
    <Result>(pageFunction: () => Result | Promise<Result>): Promise<Result>;
    <Arg, Result>(
      pageFunction: (arg: Arg) => Result | Promise<Result>,
      arg: Arg
    ): Promise<Result>;
  };
  goto?: (
    url: string,
    options?: BrowserSetContentOptions
  ) => Promise<unknown>;
  screenshot: (options?: BrowserScreenshotOptions) => Promise<Uint8Array>;
  setContent: (html: string, options?: BrowserSetContentOptions) => Promise<unknown>;
  setJavaScriptEnabled?: (enabled: boolean) => Promise<unknown>;
  setViewport?: (viewport: BrowserViewport) => Promise<unknown>;
  waitForLoadState?: (
    state: "load" | "domcontentloaded" | "networkidle",
    options?: BrowserWaitOptions
  ) => Promise<unknown>;
  waitForNetworkIdle?: (options?: BrowserNetworkIdleOptions) => Promise<unknown>;
  waitForSelector?: (selector: string, options?: BrowserWaitOptions) => Promise<unknown>;
};

export type BrowserPageWithLocator = BrowserPage & {
  locator: (selector: string) => BrowserLocator;
};

export type BrowserPageSession = {
  page: BrowserPage;
  close: () => Promise<void>;
};

export type BrowserPageSessionWithLocator = {
  page: BrowserPageWithLocator;
  close: () => Promise<void>;
};
