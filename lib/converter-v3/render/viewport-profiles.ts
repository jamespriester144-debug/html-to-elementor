import type { CaptureViewportProfile } from "@/lib/converter-v3/contracts/capture";

export const CAPTURE_VIEWPORTS: CaptureViewportProfile[] = [
  { name: "desktop", width: 1440, height: 1200 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "mobile", width: 390, height: 844 }
];
