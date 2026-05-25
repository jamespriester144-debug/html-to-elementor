import type { CaptureViewportProfile } from "@/lib/converter-v3/contracts/capture";

export const CAPTURE_VIEWPORTS: CaptureViewportProfile[] = [
  { name: "desktop", width: 1440, height: 1200 },
  { name: "tablet", width: 1024, height: 1366 },
  { name: "mobile", width: 390, height: 844 }
];
