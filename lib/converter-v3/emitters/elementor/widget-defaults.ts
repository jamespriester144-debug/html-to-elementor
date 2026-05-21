export function applyPresetWidgetDefaults(
  widgetType: string,
  widgetSemanticHint: string | undefined,
  settings: Record<string, unknown>
) {
  const nextSettings = { ...settings };

  switch (widgetSemanticHint) {
    case "section-intro-eyebrow":
      nextSettings.align ??= "left";
      nextSettings.font_weight ??= "600";
      break;
    case "section-intro-title":
      if (widgetType === "heading") {
        nextSettings.align ??= "left";
        nextSettings.font_weight ??= "700";
        nextSettings.line_height ??= "1.2";
      }
      break;
    case "section-intro-support":
      nextSettings.align ??= "left";
      nextSettings.line_height ??= "1.5";
      break;
    case "section-intro-cta":
      if (widgetType === "button") {
        nextSettings.align ??= "left";
      }
      break;
    case "section-outro-title":
      if (widgetType === "heading") {
        nextSettings.align ??= "left";
        nextSettings.font_weight ??= "700";
        nextSettings.line_height ??= "1.25";
      }
      break;
    case "section-outro-support":
      nextSettings.align ??= "left";
      nextSettings.line_height ??= "1.5";
      break;
    case "section-outro-cta":
      if (widgetType === "button") {
        nextSettings.align ??= "left";
      }
      break;
    case "price":
      if (widgetType === "heading") {
        nextSettings.align ??= "left";
        nextSettings.font_weight ??= "700";
        nextSettings.line_height ??= "1.1";
      }
      break;
    case "pricing-title":
      if (widgetType === "heading") {
        nextSettings.align ??= "left";
        nextSettings.font_weight ??= "700";
      }
      break;
    case "pricing-support":
      nextSettings.align ??= "left";
      nextSettings.line_height ??= "1.4";
      break;
    case "pricing-cta":
      if (widgetType === "button") {
        nextSettings.width = "100%";
        nextSettings.align ??= "left";
      }
      break;
    case "testimonial-quote":
      nextSettings.align ??= "left";
      nextSettings.font_style ??= "italic";
      nextSettings.line_height ??= "1.5";
      break;
    case "testimonial-rating":
      nextSettings.align ??= "left";
      nextSettings.font_weight ??= "700";
      break;
    case "testimonial-attribution":
      if (widgetType === "heading") {
        nextSettings.align ??= "left";
        nextSettings.font_weight ??= "600";
      }
      break;
    case "feature-eyebrow":
      nextSettings.align ??= "left";
      nextSettings.font_weight ??= "600";
      break;
    case "feature-title":
      if (widgetType === "heading") {
        nextSettings.align ??= "left";
        nextSettings.font_weight ??= "700";
        nextSettings.line_height ??= "1.2";
      }
      break;
    case "feature-support":
      nextSettings.align ??= "left";
      nextSettings.line_height ??= "1.5";
      break;
    case "feature-cta":
      if (widgetType === "button") {
        nextSettings.align ??= "left";
      }
      break;
    case "section-badge":
      nextSettings.align ??= "left";
      nextSettings.font_weight ??= "600";
      break;
    case "section-support-item":
      nextSettings.align ??= "left";
      nextSettings.line_height ??= "1.4";
      break;
    case "guarantee-title":
      if (widgetType === "heading") {
        nextSettings.align ??= "left";
        nextSettings.font_weight ??= "700";
        nextSettings.line_height ??= "1.2";
      }
      break;
    case "guarantee-support":
      nextSettings.align ??= "left";
      nextSettings.line_height ??= "1.5";
      break;
    case "guarantee-cta":
      if (widgetType === "button") {
        nextSettings.align ??= "left";
      }
      break;
    case "section-secondary-cta":
      if (widgetType === "button") {
        nextSettings.align ??= "left";
      }
      break;
    case "section-secondary-support":
      nextSettings.align ??= "left";
      nextSettings.line_height ??= "1.4";
      break;
    default:
      break;
  }

  return nextSettings;
}
