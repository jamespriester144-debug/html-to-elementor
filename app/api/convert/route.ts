import { createConvertPostHandler } from "@/lib/api/convert-route";

export const runtime = "nodejs";

export const POST = createConvertPostHandler();
