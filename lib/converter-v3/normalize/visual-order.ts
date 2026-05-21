import type { CapturedNode } from "@/lib/converter-v3/contracts/capture";

function getRowTolerance(node: CapturedNode): number {
  if (!node.box) {
    return 24;
  }

  return Math.max(16, Math.min(48, Math.round(node.box.height * 0.35)));
}

function sameVisualRow(left: CapturedNode, right: CapturedNode): boolean {
  if (!left.box || !right.box) {
    return false;
  }

  const tolerance = Math.max(getRowTolerance(left), getRowTolerance(right));
  return Math.abs(left.box.top - right.box.top) <= tolerance;
}

export function compareNodesByVisualFlow(left: CapturedNode, right: CapturedNode): number {
  if (left.box && right.box) {
    if (sameVisualRow(left, right)) {
      if (Math.abs(left.box.left - right.box.left) > 1) {
        return left.box.left - right.box.left;
      }

      if (Math.abs(left.box.width - right.box.width) > 1) {
        return right.box.width - left.box.width;
      }
    }

    if (Math.abs(left.box.top - right.box.top) > 1) {
      return left.box.top - right.box.top;
    }

    if (Math.abs(left.box.left - right.box.left) > 1) {
      return left.box.left - right.box.left;
    }
  }

  return left.visualOrder - right.visualOrder;
}

export function orderSiblingNodesByVisualFlow(nodes: CapturedNode[]): CapturedNode[] {
  return [...nodes].sort(compareNodesByVisualFlow);
}
