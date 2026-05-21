import JSZip from "jszip";
import ts from "typescript";

type LovableAssetMap = Map<string, string>;
type RenderScope = Map<string, unknown>;

type ExtractedNode = {
  tag: string;
  attrs: Record<string, string>;
  text: string;
};

const semanticTagMap: Record<string, string> = {
  header: "header",
  nav: "nav",
  main: "main",
  section: "section",
  footer: "footer",
  h1: "h1",
  h2: "h2",
  h3: "h3",
  h4: "h4",
  h5: "h5",
  h6: "h6",
  p: "p",
  a: "a",
  button: "button",
  img: "img",
  li: "li",
  ul: "ul",
  ol: "ol",
  blockquote: "blockquote"
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function getStringLiteralValue(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }

  return null;
}

function getExpressionText(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
  constants: Map<string, unknown>,
  assets: LovableAssetMap
): string {
  if (
    ts.isObjectLiteralExpression(expression) ||
    ts.isArrayLiteralExpression(expression) ||
    ts.isArrowFunction(expression) ||
    ts.isFunctionExpression(expression)
  ) {
    return "";
  }

  const literal = getStringLiteralValue(expression);

  if (literal !== null) {
    return literal;
  }

  if (ts.isIdentifier(expression)) {
    const value = constants.get(expression.text);

    if (typeof value === "string") {
      return value;
    }

    return assets.get(expression.text) ?? "";
  }

  if (ts.isPropertyAccessExpression(expression)) {
    const objectName = expression.expression.getText(sourceFile);
    const objectValue = constants.get(objectName);

    if (
      objectValue &&
      typeof objectValue === "object" &&
      !Array.isArray(objectValue)
    ) {
      const value = (objectValue as Record<string, unknown>)[expression.name.text];

      return typeof value === "string" || typeof value === "number"
        ? String(value)
        : "";
    }
  }

  if (ts.isJsxElement(expression) || ts.isJsxSelfClosingElement(expression)) {
    return "";
  }

  return "";
}

function parseLiteralValue(
  node: ts.Expression,
  assets: LovableAssetMap = new Map()
): unknown {
  const literal = getStringLiteralValue(node);

  if (literal !== null) {
    return literal;
  }

  if (ts.isNumericLiteral(node)) {
    return Number(node.text);
  }

  if (node.kind === ts.SyntaxKind.TrueKeyword) {
    return true;
  }

  if (node.kind === ts.SyntaxKind.FalseKeyword) {
    return false;
  }

  if (ts.isIdentifier(node)) {
    return assets.get(node.text) ?? null;
  }

  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.map((element) =>
      ts.isExpression(element) ? parseLiteralValue(element, assets) : null
    );
  }

  if (ts.isObjectLiteralExpression(node)) {
    const objectValue: Record<string, unknown> = {};

    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) {
        continue;
      }

      const name = property.name;
      const key =
        ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null;

      if (!key) {
        continue;
      }

      objectValue[key] = parseLiteralValue(property.initializer, assets);
    }

    return objectValue;
  }

  return null;
}

function getConstants(
  sourceFile: ts.SourceFile,
  assets: LovableAssetMap
): Map<string, unknown> {
  const constants = new Map<string, unknown>();

  sourceFile.forEachChild((node) => {
    if (!ts.isVariableStatement(node)) {
      return;
    }

    for (const declaration of node.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
        continue;
      }

      constants.set(
        declaration.name.text,
        parseLiteralValue(declaration.initializer, assets)
      );
    }
  });

  return constants;
}

function getMimeType(path: string) {
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".gif")) return "image/gif";
  return "application/octet-stream";
}

async function getAssets(sourceFile: ts.SourceFile, zip: JSZip): Promise<LovableAssetMap> {
  const assets: LovableAssetMap = new Map();
  const imports: Array<{ localName: string; moduleName: string }> = [];

  sourceFile.forEachChild((node) => {
    if (!ts.isImportDeclaration(node) || !node.importClause?.name) {
      return;
    }

    const moduleName = node.moduleSpecifier;

    if (!ts.isStringLiteral(moduleName)) {
      return;
    }

    if (!moduleName.text.includes("/assets/")) {
      return;
    }

    imports.push({
      localName: node.importClause.name.text,
      moduleName: moduleName.text
    });
  });

  for (const assetImport of imports) {
    const assetPath = assetImport.moduleName.replace("@/", "src/");
    const zipEntry = Object.values(zip.files).find((entry) =>
      entry.name.replace(/\\/g, "/").endsWith(assetPath)
    );

    if (!zipEntry) {
      assets.set(assetImport.localName, assetImport.moduleName.replace("@/", "/"));
      continue;
    }

    const base64 = await zipEntry.async("base64");
    assets.set(
      assetImport.localName,
      `data:${getMimeType(zipEntry.name.toLowerCase())};base64,${base64}`
    );
  }

  return assets;
}

function getJsxAttributeValue(
  attribute: ts.JsxAttribute,
  sourceFile: ts.SourceFile,
  constants: Map<string, unknown>,
  assets: LovableAssetMap
): string {
  const initializer = attribute.initializer;

  if (!initializer) {
    return "";
  }

  if (ts.isStringLiteral(initializer)) {
    return initializer.text;
  }

  if (ts.isJsxExpression(initializer) && initializer.expression) {
    return getExpressionText(initializer.expression, sourceFile, constants, assets);
  }

  return "";
}

function collectJsxText(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  constants: Map<string, unknown>,
  assets: LovableAssetMap
): string {
  const parts: string[] = [];

  function visit(child: ts.Node) {
    if (ts.isJsxText(child)) {
      parts.push(child.getText(sourceFile));
      return;
    }

    if (ts.isJsxExpression(child) && child.expression) {
      parts.push(getExpressionText(child.expression, sourceFile, constants, assets));
      return;
    }

    child.forEachChild(visit);
  }

  node.forEachChild(visit);

  return normalizeText(parts.join(" "));
}

function collectNodesFromJsx(
  sourceFile: ts.SourceFile,
  constants: Map<string, unknown>,
  assets: LovableAssetMap
): ExtractedNode[] {
  const nodes: ExtractedNode[] = [];

  function visit(node: ts.Node) {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      const rawTag = opening.tagName.getText(sourceFile);
      const tag = semanticTagMap[rawTag];

      if (tag) {
        const attrs: Record<string, string> = {};

        for (const property of opening.attributes.properties) {
          if (!ts.isJsxAttribute(property)) {
            continue;
          }

          if (!ts.isIdentifier(property.name)) {
            continue;
          }

          const attrName = property.name.text;

          if (["href", "src", "alt", "id"].includes(attrName)) {
            attrs[attrName] = getJsxAttributeValue(
              property,
              sourceFile,
              constants,
              assets
            );
          }
        }

        nodes.push({
          tag,
          attrs,
          text: ts.isJsxElement(node)
            ? collectJsxText(node, sourceFile, constants, assets)
            : ""
        });
      }
    }

    node.forEachChild(visit);
  }

  visit(sourceFile);

  return nodes.filter(
    (node) =>
      node.tag === "img" ||
      node.text ||
      node.attrs.href ||
      node.attrs.src ||
      ["section", "header", "footer", "nav", "main"].includes(node.tag)
  );
}

function renderExtractedNodes(title: string, nodes: ExtractedNode[]): string {
  const body = nodes
    .map((node) => {
      const attrs = Object.entries(node.attrs)
        .filter(([, value]) => value)
        .map(([key, value]) => ` ${key}="${escapeHtml(value)}"`)
        .join("");

      if (node.tag === "img") {
        return `<img${attrs} />`;
      }

      return `<${node.tag}${attrs}>${escapeHtml(node.text)}</${node.tag}>`;
    })
    .join("\n");

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(title)}</title>
  </head>
  <body>
${body}
  </body>
</html>`;
}

function isLowerCaseTag(tagName: string): boolean {
  return tagName[0] === tagName[0]?.toLowerCase();
}

function renderUnknownValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") {
    return escapeHtml(String(value));
  }

  return "";
}

function camelToKebab(value: string): string {
  return value.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
}

function renderStyleObject(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }

  return Object.entries(value as Record<string, unknown>)
    .filter(([, propertyValue]) => propertyValue !== null && propertyValue !== undefined && propertyValue !== "")
    .map(([property, propertyValue]) => `${camelToKebab(property)}:${String(propertyValue)}`)
    .join(";");
}

function getObjectProperty(value: unknown, property: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return (value as Record<string, unknown>)[property] ?? null;
}

function expressionContainsJsx(expression: ts.Expression): boolean {
  if (
    ts.isJsxElement(expression) ||
    ts.isJsxSelfClosingElement(expression) ||
    ts.isJsxFragment(expression)
  ) {
    return true;
  }

  if (ts.isParenthesizedExpression(expression)) {
    return expressionContainsJsx(expression.expression);
  }

  return false;
}

function evaluateExpression(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
  constants: Map<string, unknown>,
  assets: LovableAssetMap,
  scope: RenderScope
): unknown {
  const literal = getStringLiteralValue(expression);

  if (literal !== null) {
    return literal;
  }

  if (ts.isNumericLiteral(expression)) {
    return Number(expression.text);
  }

  if (ts.isArrayLiteralExpression(expression)) {
    return expression.elements.flatMap((element) => {
      if (ts.isSpreadElement(element)) {
        const spreadValue = evaluateExpression(
          element.expression,
          sourceFile,
          constants,
          assets,
          scope
        );

        return Array.isArray(spreadValue) ? spreadValue : [];
      }

      return ts.isExpression(element)
        ? [evaluateExpression(element, sourceFile, constants, assets, scope)]
        : [];
    });
  }

  if (ts.isObjectLiteralExpression(expression)) {
    const objectValue: Record<string, unknown> = {};

    for (const property of expression.properties) {
      if (!ts.isPropertyAssignment(property)) {
        continue;
      }

      const name = property.name;
      const key =
        ts.isIdentifier(name) || ts.isStringLiteral(name)
          ? name.text
          : ts.isNumericLiteral(name)
            ? name.text
            : null;

      if (!key) {
        continue;
      }

      objectValue[key] = evaluateExpression(property.initializer, sourceFile, constants, assets, scope);
    }

    return objectValue;
  }

  if (expression.kind === ts.SyntaxKind.TrueKeyword) {
    return true;
  }

  if (expression.kind === ts.SyntaxKind.FalseKeyword) {
    return false;
  }

  if (ts.isPrefixUnaryExpression(expression)) {
    const value = evaluateExpression(expression.operand, sourceFile, constants, assets, scope);

    if (expression.operator === ts.SyntaxKind.ExclamationToken) {
      return !value;
    }

    if (expression.operator === ts.SyntaxKind.MinusToken) {
      return -Number(value);
    }

    if (expression.operator === ts.SyntaxKind.PlusToken) {
      return Number(value);
    }
  }

  if (ts.isIdentifier(expression)) {
    return (
      scope.get(expression.text) ??
      constants.get(expression.text) ??
      assets.get(expression.text) ??
      ""
    );
  }

  if (ts.isPropertyAccessExpression(expression)) {
    return getObjectProperty(
      evaluateExpression(expression.expression, sourceFile, constants, assets, scope),
      expression.name.text
    );
  }

  if (ts.isParenthesizedExpression(expression)) {
    return evaluateExpression(expression.expression, sourceFile, constants, assets, scope);
  }

  if (ts.isTemplateExpression(expression)) {
    return (
      expression.head.text +
      expression.templateSpans
        .map((span) => {
          const value = evaluateExpression(
            span.expression,
            sourceFile,
            constants,
            assets,
            scope
          );

          return `${renderUnknownValue(value)}${span.literal.text}`;
        })
        .join("")
    );
  }

  if (ts.isBinaryExpression(expression)) {
    if (expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      const left = evaluateExpression(
        expression.left,
        sourceFile,
        constants,
        assets,
        scope
      );

      return left
        ? renderExpression(expression.right, sourceFile, constants, assets, scope)
        : ts.isIdentifier(expression.left) && expressionContainsJsx(expression.right)
          ? renderExpression(expression.right, sourceFile, constants, assets, scope)
        : "";
    }

    if (expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = evaluateExpression(
        expression.left,
        sourceFile,
        constants,
        assets,
        scope
      );
      const right = evaluateExpression(
        expression.right,
        sourceFile,
        constants,
        assets,
        scope
      );

      return `${left ?? ""}${right ?? ""}`;
    }

    const left = evaluateExpression(expression.left, sourceFile, constants, assets, scope);
    const right = evaluateExpression(expression.right, sourceFile, constants, assets, scope);

    switch (expression.operatorToken.kind) {
      case ts.SyntaxKind.EqualsEqualsEqualsToken:
      case ts.SyntaxKind.EqualsEqualsToken:
        return left === right;
      case ts.SyntaxKind.ExclamationEqualsEqualsToken:
      case ts.SyntaxKind.ExclamationEqualsToken:
        return left !== right;
      case ts.SyntaxKind.GreaterThanToken:
        return Number(left) > Number(right);
      case ts.SyntaxKind.GreaterThanEqualsToken:
        return Number(left) >= Number(right);
      case ts.SyntaxKind.LessThanToken:
        return Number(left) < Number(right);
      case ts.SyntaxKind.LessThanEqualsToken:
        return Number(left) <= Number(right);
      case ts.SyntaxKind.PercentToken:
        return Number(left) % Number(right);
      default:
        break;
    }
  }

  if (ts.isConditionalExpression(expression)) {
    const condition = evaluateExpression(
      expression.condition,
      sourceFile,
      constants,
      assets,
      scope
    );

    return renderExpression(
      condition ? expression.whenTrue : expression.whenFalse,
      sourceFile,
      constants,
      assets,
      scope
    );
  }

  if (ts.isCallExpression(expression)) {
    return renderCallExpression(expression, sourceFile, constants, assets, scope);
  }

  if (ts.isNewExpression(expression)) {
    const className = expression.expression.getText(sourceFile);

    if (className === "Date") {
      return new Date();
    }
  }

  if (ts.isJsxElement(expression) || ts.isJsxSelfClosingElement(expression)) {
    return renderJsxNode(expression, sourceFile, constants, assets, scope);
  }

  return "";
}

function renderExpression(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
  constants: Map<string, unknown>,
  assets: LovableAssetMap,
  scope: RenderScope
): string {
  const value = evaluateExpression(expression, sourceFile, constants, assets, scope);

  return typeof value === "string" ? value : renderUnknownValue(value);
}

function renderCallExpression(
  expression: ts.CallExpression,
  sourceFile: ts.SourceFile,
  constants: Map<string, unknown>,
  assets: LovableAssetMap,
  scope: RenderScope
): unknown {
  if (ts.isIdentifier(expression.expression) && expression.expression.text === "Array") {
    const lengthArg = expression.arguments[0];
    const length = lengthArg && ts.isExpression(lengthArg)
      ? Number(evaluateExpression(lengthArg, sourceFile, constants, assets, scope))
      : 0;

    return Number.isFinite(length) && length > 0 ? Array.from({ length }) : [];
  }

  if (
    ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === "toFixed"
  ) {
    const receiver = evaluateExpression(
      expression.expression.expression,
      sourceFile,
      constants,
      assets,
      scope
    );
    const digitsArg = expression.arguments[0];
    const digits = digitsArg && ts.isExpression(digitsArg)
      ? Number(evaluateExpression(digitsArg, sourceFile, constants, assets, scope))
      : 0;

    return Number(receiver).toFixed(Number.isFinite(digits) ? digits : 0);
  }

  if (
    ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === "getFullYear"
  ) {
    const receiver = evaluateExpression(
      expression.expression.expression,
      sourceFile,
      constants,
      assets,
      scope
    );

    return receiver instanceof Date ? receiver.getFullYear() : new Date().getFullYear();
  }

  if (
    !ts.isPropertyAccessExpression(expression.expression) ||
    expression.expression.name.text !== "map"
  ) {
    return "";
  }

  const arrayValue = evaluateExpression(
    expression.expression.expression,
    sourceFile,
    constants,
    assets,
    scope
  );
  const callback = expression.arguments[0];

  if (!Array.isArray(arrayValue) || !callback || !ts.isArrowFunction(callback)) {
    return "";
  }

  return arrayValue
    .map((item, index) => {
      const itemScope = new Map(scope);
      const itemParam = callback.parameters[0]?.name;
      const indexParam = callback.parameters[1]?.name;

      if (itemParam && ts.isIdentifier(itemParam)) {
        itemScope.set(itemParam.text, item);
      }

      if (indexParam && ts.isIdentifier(indexParam)) {
        itemScope.set(indexParam.text, index);
      }

      if (ts.isBlock(callback.body)) {
        for (const statement of callback.body.statements) {
          if (!ts.isVariableStatement(statement)) {
            continue;
          }

          for (const declaration of statement.declarationList.declarations) {
            if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
              continue;
            }

            itemScope.set(
              declaration.name.text,
              evaluateExpression(declaration.initializer, sourceFile, constants, assets, itemScope)
            );
          }
        }

        const returnStatement = callback.body.statements.find(ts.isReturnStatement);

        return returnStatement?.expression
          ? renderExpression(returnStatement.expression, sourceFile, constants, assets, itemScope)
          : "";
      }

      return renderExpression(callback.body, sourceFile, constants, assets, itemScope);
    })
    .join("");
}

function renderJsxAttributes(
  attributes: ts.JsxAttributes,
  sourceFile: ts.SourceFile,
  constants: Map<string, unknown>,
  assets: LovableAssetMap,
  scope: RenderScope
): string {
  const rendered: string[] = [];

  for (const property of attributes.properties) {
    if (!ts.isJsxAttribute(property) || !ts.isIdentifier(property.name)) {
      continue;
    }

    const rawName = property.name.text;
    const attrName = rawName === "className" ? "class" : rawName;

    if (!["class", "href", "src", "alt", "id", "width", "height", "loading", "style"].includes(attrName)) {
      continue;
    }

    const value = property.initializer
      ? ts.isStringLiteral(property.initializer)
        ? property.initializer.text
        : ts.isJsxExpression(property.initializer) && property.initializer.expression
          ? evaluateExpression(
              property.initializer.expression,
              sourceFile,
              constants,
              assets,
              scope
            )
          : ""
      : "";

    if (attrName === "style") {
      const inlineStyle = renderStyleObject(value);

      if (inlineStyle) {
        rendered.push(` style="${escapeHtml(inlineStyle)}"`);
      }

      continue;
    }

    if (typeof value === "string" || typeof value === "number") {
      rendered.push(` ${attrName}="${escapeHtml(String(value))}"`);
    }
  }

  return rendered.join("");
}

function renderJsxTextNode(
  child: ts.JsxText,
  sourceFile: ts.SourceFile,
  previousChild?: ts.JsxChild,
  nextChild?: ts.JsxChild
): string {
  const rawText = child.getText(sourceFile);
  const normalized = normalizeText(rawText);

  if (!normalized) {
    return "";
  }

  const needsLeadingExpressionSpace =
    previousChild && ts.isJsxExpression(previousChild) && !/^[.,;:!?%)]/.test(normalized);
  const needsTrailingExpressionSpace =
    nextChild && ts.isJsxExpression(nextChild) && !/[$#([/-]$/.test(normalized);
  const leadingSpace = /^\s/.test(rawText) || needsLeadingExpressionSpace ? " " : "";
  const trailingSpace = /\s$/.test(rawText) || needsTrailingExpressionSpace ? " " : "";

  return escapeHtml(`${leadingSpace}${normalized}${trailingSpace}`);
}

function renderJsxChildren(
  children: ts.NodeArray<ts.JsxChild>,
  sourceFile: ts.SourceFile,
  constants: Map<string, unknown>,
  assets: LovableAssetMap,
  scope: RenderScope
): string {
  const childList = [...children];

  return childList
    .map((child, index) => {
      if (ts.isJsxText(child)) {
        return renderJsxTextNode(child, sourceFile, childList[index - 1], childList[index + 1]);
      }

      if (ts.isJsxExpression(child) && child.expression) {
        return renderExpression(child.expression, sourceFile, constants, assets, scope);
      }

      return renderJsxNode(child, sourceFile, constants, assets, scope);
    })
    .join("");
}

function renderCustomComponent(
  tagName: string,
  attributes: ts.JsxAttributes,
  sourceFile: ts.SourceFile,
  constants: Map<string, unknown>,
  assets: LovableAssetMap,
  scope: RenderScope
): string {
  if (["Check", "Sparkles", "Heart", "Shield", "Truck", "Star", "Plus", "Minus"].includes(tagName)) {
    return "";
  }

  const props: Record<string, string> = {};

  for (const property of attributes.properties) {
    if (!ts.isJsxAttribute(property) || !ts.isIdentifier(property.name)) {
      continue;
    }

    const initializer = property.initializer;

    props[property.name.text] = initializer
      ? ts.isStringLiteral(initializer)
        ? initializer.text
        : ts.isJsxExpression(initializer) && initializer.expression
          ? renderExpression(
              initializer.expression,
              sourceFile,
              constants,
              assets,
              scope
            )
          : ""
      : "";
  }

  const content = [props.title, props.body].filter(Boolean).join(" ");

  return content
    ? `<div data-lovable-component="${escapeHtml(tagName)}">${escapeHtml(content)}</div>`
    : "";
}

function renderJsxNode(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  constants: Map<string, unknown>,
  assets: LovableAssetMap,
  scope: RenderScope
): string {
  if (ts.isJsxFragment(node)) {
    return renderJsxChildren(node.children, sourceFile, constants, assets, scope);
  }

  if (ts.isJsxSelfClosingElement(node)) {
    const tagName = node.tagName.getText(sourceFile);

    if (!isLowerCaseTag(tagName)) {
      return renderCustomComponent(
        tagName,
        node.attributes,
        sourceFile,
        constants,
        assets,
        scope
      );
    }

    const attrs = renderJsxAttributes(node.attributes, sourceFile, constants, assets, scope);

    return tagName === "img" ? `<img${attrs} />` : `<${tagName}${attrs}></${tagName}>`;
  }

  if (ts.isJsxElement(node)) {
    const tagName = node.openingElement.tagName.getText(sourceFile);

    if (!isLowerCaseTag(tagName)) {
      return renderCustomComponent(
        tagName,
        node.openingElement.attributes,
        sourceFile,
        constants,
        assets,
        scope
      );
    }

    const attrs = renderJsxAttributes(
      node.openingElement.attributes,
      sourceFile,
      constants,
      assets,
      scope
    );
    const children = renderJsxChildren(
      node.children,
      sourceFile,
      constants,
      assets,
      scope
    );

    return `<${tagName}${attrs}>${children}</${tagName}>`;
  }

  return "";
}

function findReturnedJsx(sourceFile: ts.SourceFile, functionName: string): ts.Expression | null {
  let found: ts.Expression | null = null;

  function visit(node: ts.Node) {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === functionName &&
      node.body
    ) {
      const returnStatement = node.body.statements.find(ts.isReturnStatement);
      found = returnStatement?.expression ?? null;
      return;
    }

    node.forEachChild(visit);
  }

  sourceFile.forEachChild(visit);

  return found;
}

function getInitialFunctionScope(
  sourceFile: ts.SourceFile,
  functionName: string,
  constants: Map<string, unknown>,
  assets: LovableAssetMap
): RenderScope {
  const scope: RenderScope = new Map();

  function visit(node: ts.Node) {
    if (
      !ts.isFunctionDeclaration(node) ||
      node.name?.text !== functionName ||
      !node.body
    ) {
      node.forEachChild(visit);
      return;
    }

    for (const statement of node.body.statements) {
      if (ts.isReturnStatement(statement)) {
        return;
      }

      if (!ts.isVariableStatement(statement)) {
        continue;
      }

      for (const declaration of statement.declarationList.declarations) {
        if (!declaration.initializer) {
          continue;
        }

        if (ts.isIdentifier(declaration.name)) {
          scope.set(
            declaration.name.text,
            evaluateExpression(declaration.initializer, sourceFile, constants, assets, scope)
          );
          continue;
        }

        if (
          ts.isArrayBindingPattern(declaration.name) &&
          ts.isCallExpression(declaration.initializer) &&
          ts.isIdentifier(declaration.initializer.expression) &&
          declaration.initializer.expression.text === "useState"
        ) {
          const firstElement = declaration.name.elements[0];
          const firstBinding = firstElement && ts.isBindingElement(firstElement)
            ? firstElement.name
            : null;
          const initialValue = declaration.initializer.arguments[0];

          if (firstBinding && ts.isIdentifier(firstBinding) && initialValue && ts.isExpression(initialValue)) {
            scope.set(
              firstBinding.text,
              evaluateExpression(initialValue, sourceFile, constants, assets, scope)
            );
          }
        }
      }
    }
  }

  sourceFile.forEachChild(visit);
  return scope;
}

function renderStaticLovableHtml(
  sourceFile: ts.SourceFile,
  constants: Map<string, unknown>,
  assets: LovableAssetMap
): string | null {
  const rootExpression = findReturnedJsx(sourceFile, "Index");

  if (!rootExpression) {
    return null;
  }

  const body = renderExpression(
    rootExpression,
    sourceFile,
    constants,
    assets,
    getInitialFunctionScope(sourceFile, "Index", constants, assets)
  );

  return body.trim() ? body : null;
}

function getTitle(sourceFile: ts.SourceFile, constants: Map<string, unknown>): string {
  let title = "Lovable Site";

  function visit(node: ts.Node) {
    if (!ts.isPropertyAssignment(node)) {
      node.forEachChild(visit);
      return;
    }

    const name = node.name;

    if (!ts.isIdentifier(name) || name.text !== "title") {
      node.forEachChild(visit);
      return;
    }

    const parsed = parseLiteralValue(node.initializer);

    if (typeof parsed === "string" && title === "Lovable Site") {
      title = parsed;
    }

    node.forEachChild(visit);
  }

  sourceFile.forEachChild(visit);

  const routeTitle = constants.get("title");
  return typeof routeTitle === "string" ? routeTitle : title;
}

export async function extractLovableProjectHtml(
  zip: JSZip
): Promise<string | null> {
  const routeEntry =
    zip.file(/src\/routes\/index\.(tsx|jsx)$/)[0] ??
    zip.file(/src\/pages\/index\.(tsx|jsx)$/)[0] ??
    zip.file(/src\/App\.(tsx|jsx)$/)[0];

  if (!routeEntry) {
    return null;
  }

  const source = await routeEntry.async("text");
  const sourceFile = ts.createSourceFile(
    routeEntry.name,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const assets = await getAssets(sourceFile, zip);
  const constants = getConstants(sourceFile, assets);
  const renderedHtml = renderStaticLovableHtml(sourceFile, constants, assets);

  if (renderedHtml) {
    return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(getTitle(sourceFile, constants))}</title>
  </head>
  <body>
${renderedHtml}
  </body>
</html>`;
  }

  const nodes = collectNodesFromJsx(sourceFile, constants, assets);

  if (!nodes.length) {
    return null;
  }

  return renderExtractedNodes(getTitle(sourceFile, constants), nodes);
}
