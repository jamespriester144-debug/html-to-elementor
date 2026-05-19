export type ConversionStatus = "pending" | "paid";

export type ConversionRecord = {
  id: string;
  html: string;
  elementor_json: ElementorDocument;
  status: ConversionStatus;
  payment_id: string | null;
  created_at: string;
  updated_at: string;
};

export type ElementorDocument = {
  version: string;
  title: string;
  type: "page";
  content: ElementorElement[];
};

export type ElementorElement = {
  id: string;
  elType: "section" | "column" | "container" | "widget";
  widgetType?: string;
  settings: Record<string, unknown>;
  elements: ElementorElement[];
};
