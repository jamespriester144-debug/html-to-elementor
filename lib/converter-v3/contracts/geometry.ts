import type { CapturedBox } from "@/lib/converter-v3/contracts/capture";

export type VisibleContentElement = {
  nodeId: string;
  parentId: string | null;
  childIds: string[];
  tag: string;
  text: string;
  href?: string;
  src?: string;
  poster?: string;
  backgroundImage?: string;
  box: CapturedBox;
  zIndex?: string;
  fontSize?: string;
  color?: string;
  background?: string;
  borderRadius?: string;
  display?: string;
  position?: string;
  flexDirection?: string;
  gridTemplateColumns?: string;
  visualOrder: number;
  isText: boolean;
  isMedia: boolean;
  isInteractive: boolean;
  isLink: boolean;
  isButton: boolean;
  isVisualContainer: boolean;
};

export type VisibleContentMetrics = {
  visibleElements: number;
  texts: number;
  images: number;
  buttons: number;
  links: number;
  visualContainers: number;
};

export type VisualGeometryGroup = {
  id: string;
  name: string;
  nodeIds: string[];
  topLevelNodeIds: string[];
  box: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  textCount: number;
  imageCount: number;
  buttonCount: number;
  linkCount: number;
  visualContainerCount: number;
  reason: string;
};
