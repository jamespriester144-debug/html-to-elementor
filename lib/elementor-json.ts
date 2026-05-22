import type { ElementorDocument } from "@/types/conversion";

const SERIALIZATION_ERROR_MESSAGE =
  "O JSON final do template nao pode ser serializado.";
const PARSING_ERROR_MESSAGE = "O JSON final do template ficou invalido.";

export class InvalidElementorJsonError extends Error {
  cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "InvalidElementorJsonError";
    this.cause = cause;
  }
}

export function stringifyValidatedElementorJson(
  elementorJson: ElementorDocument
): string {
  let jsonText: string;

  try {
    jsonText = JSON.stringify(elementorJson, null, 2);
  } catch (error) {
    throw new InvalidElementorJsonError(SERIALIZATION_ERROR_MESSAGE, error);
  }

  try {
    JSON.parse(jsonText);
  } catch (error) {
    throw new InvalidElementorJsonError(PARSING_ERROR_MESSAGE, error);
  }

  return jsonText;
}
