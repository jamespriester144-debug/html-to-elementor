import path from "node:path";

import JSZip from "jszip";
import ts from "typescript";

type LovableAssetMap = Map<string, string>;
type RenderScope = Map<string, unknown>;
type LocalComponentImport = {
  filePath: string;
  exportName: string;
};
type ProjectModule = {
  filePath: string;
  sourceFile: ts.SourceFile;
  constants: Map<string, unknown>;
  assets: LovableAssetMap;
  localComponentImports: Map<string, LocalComponentImport>;
};
type ProjectRenderContext = {
  entryFile: string;
  modules: Map<string, ProjectModule>;
};
type RenderableComponentDeclaration = {
  parameters: ts.NodeArray<ts.ParameterDeclaration>;
  body: ts.ConciseBody;
};
type RootRenderTarget =
  | {
      kind: "expression";
      expression: ts.Expression;
    }
  | {
      kind: "component-reference";
      componentName: string;
    };
type ProjectRenderCandidate = {
  module: ProjectModule;
  target: RootRenderTarget;
  priority: number;
};

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

const ASSET_FILE_PATTERN = /\.(?:png|jpe?g|webp|svg|gif|avif|ico|woff2?|ttf|otf|eot)$/i;
const RENDERABLE_SOURCE_PATTERN = /\.(?:tsx|jsx|ts|js)$/i;
const STYLESHEET_SOURCE_PATTERN = /\.css(?:\?.*)?$/i;
const EXCLUDED_SOURCE_PATTERN = /\.d\.ts$|\.(?:test|spec|stories)\.(?:tsx|jsx|ts|js)$/i;
const NON_RENDERABLE_COMPONENTS = new Set([
  "Check",
  "Sparkles",
  "Heart",
  "Shield",
  "Truck",
  "Star",
  "Plus",
  "Minus"
]);

function normalizeProjectPath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\?.*$/, "").replace(/#.*$/, "");
  return normalized.replace(/^\/+/, "");
}

function isRenderableSourceFile(filePath: string) {
  const normalized = normalizeProjectPath(filePath);
  return RENDERABLE_SOURCE_PATTERN.test(normalized) && !EXCLUDED_SOURCE_PATTERN.test(normalized);
}

function isAssetFile(filePath: string) {
  return ASSET_FILE_PATTERN.test(normalizeProjectPath(filePath));
}

function shouldInlineStylesheetUrl(value: string) {
  const trimmed = value.trim();

  return (
    trimmed.length > 0 &&
    !trimmed.startsWith("data:") &&
    !trimmed.startsWith("#") &&
    !/^(?:https?:|blob:|\/\/)/i.test(trimmed)
  );
}

function resolveProjectSpecifier(currentFilePath: string, specifier: string) {
  const normalizedSpecifier = specifier.trim();

  if (!normalizedSpecifier) {
    return null;
  }

  if (normalizedSpecifier.startsWith("@/")) {
    return normalizeProjectPath(normalizedSpecifier.replace(/^@\//, "src/"));
  }

  if (normalizedSpecifier.startsWith("/")) {
    return normalizeProjectPath(normalizedSpecifier);
  }

  if (normalizedSpecifier.startsWith(".")) {
    return normalizeProjectPath(
      path.posix.join(path.posix.dirname(normalizeProjectPath(currentFilePath)), normalizedSpecifier)
    );
  }

  return null;
}

function resolveZipModulePath(zip: JSZip, currentFilePath: string, specifier: string) {
  const basePath = resolveProjectSpecifier(currentFilePath, specifier);

  if (!basePath) {
    return null;
  }

  const candidates = [
    basePath,
    ...[".tsx", ".jsx", ".ts", ".js"].map((extension) => `${basePath}${extension}`),
    ...[".tsx", ".jsx", ".ts", ".js"].map((extension) => `${basePath}/index${extension}`)
  ].map((candidate) => normalizeProjectPath(candidate));
  const normalizedFileNames = Object.keys(zip.files)
    .filter((entryName) => !zip.files[entryName]?.dir)
    .map((entryName) => normalizeProjectPath(entryName));

  for (const candidate of candidates) {
    if (zip.file(candidate)) {
      return candidate;
    }

    const currentNormalizedPath = normalizeProjectPath(currentFilePath);
    const currentSrcIndex = currentNormalizedPath.indexOf("/src/");
    const currentRootPrefix =
      currentSrcIndex >= 0 ? currentNormalizedPath.slice(0, currentSrcIndex) : "";
    const prefixedCandidate =
      currentRootPrefix && candidate.startsWith("src/")
        ? normalizeProjectPath(`${currentRootPrefix}/${candidate}`)
        : null;

    if (prefixedCandidate && zip.file(prefixedCandidate)) {
      return prefixedCandidate;
    }

    const suffixMatches = normalizedFileNames
      .filter((entryName) => entryName === candidate || entryName.endsWith(`/${candidate}`))
      .sort((left, right) => left.length - right.length || left.localeCompare(right));

    if (suffixMatches[0]) {
      return suffixMatches[0];
    }
  }

  return null;
}

function createSourceFile(filePath: string, source: string) {
  return ts.createSourceFile(
    normalizeProjectPath(filePath),
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
}

async function readZipSourceFile(zip: JSZip, filePath: string) {
  return zip.file(normalizeProjectPath(filePath))?.async("text") ?? null;
}

function isStylesheetSourceFile(specifier: string) {
  return STYLESHEET_SOURCE_PATTERN.test(specifier.trim());
}

function sanitizeProjectStylesheet(source: string) {
  return source
    .split(/\r?\n/)
    .filter((line) => !/^\s*@(?:import|source|custom-variant)\b/i.test(line))
    .join("\n")
    .trim();
}

function getMimeType(path: string) {
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".gif")) return "image/gif";
  if (path.endsWith(".avif")) return "image/avif";
  if (path.endsWith(".ico")) return "image/x-icon";
  if (path.endsWith(".woff2")) return "font/woff2";
  if (path.endsWith(".woff")) return "font/woff";
  if (path.endsWith(".ttf")) return "font/ttf";
  if (path.endsWith(".otf")) return "font/otf";
  if (path.endsWith(".eot")) return "application/vnd.ms-fontobject";
  return "application/octet-stream";
}

async function readZipAssetDataUrl(zip: JSZip, filePath: string) {
  const normalizedPath = normalizeProjectPath(filePath);
  const zipEntry = zip.file(normalizedPath);

  if (!zipEntry) {
    return null;
  }

  const base64 = await zipEntry.async("base64");
  return `data:${getMimeType(normalizedPath.toLowerCase())};base64,${base64}`;
}

async function inlineStylesheetAssetUrls(
  zip: JSZip,
  stylesheetPath: string,
  source: string
) {
  const urlPattern = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
  const matches = [...source.matchAll(urlPattern)];

  if (matches.length === 0) {
    return source;
  }

  let nextSource = source;

  for (const match of matches) {
    const rawUrl = match[2]?.trim();

    if (!rawUrl || !shouldInlineStylesheetUrl(rawUrl)) {
      continue;
    }

    const resolvedAssetPath = resolveZipModulePath(zip, stylesheetPath, rawUrl);

    if (!resolvedAssetPath || !isAssetFile(resolvedAssetPath)) {
      continue;
    }

    const dataUrl = await readZipAssetDataUrl(zip, resolvedAssetPath);

    if (!dataUrl) {
      continue;
    }

    nextSource = nextSource.replace(match[0], `url("${dataUrl}")`);
  }

  return nextSource;
}

async function collectProjectStylesheets(
  project: ProjectRenderContext,
  zip: JSZip
) {
  const stylePaths = new Set<string>();

  for (const module of project.modules.values()) {
    module.sourceFile.forEachChild((node) => {
      if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) {
        return;
      }

      const specifier = node.moduleSpecifier.text;

      if (!isStylesheetSourceFile(specifier)) {
        return;
      }

      const resolvedPath = resolveZipModulePath(zip, module.filePath, specifier);

      if (resolvedPath) {
        stylePaths.add(resolvedPath);
      }
    });
  }

  const stylesheets = await Promise.all(
    [...stylePaths].map(async (stylePath) => {
      const source = await readZipSourceFile(zip, stylePath);

      if (!source) {
        return null;
      }

      const sanitized = sanitizeProjectStylesheet(
        await inlineStylesheetAssetUrls(zip, stylePath, source)
      );

      if (!sanitized) {
        return null;
      }

      return {
        path: stylePath,
        source: sanitized
      };
    })
  );

  return stylesheets.filter(
    (stylesheet): stylesheet is { path: string; source: string } => Boolean(stylesheet)
  );
}

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

async function getAssets(sourceFile: ts.SourceFile, zip: JSZip): Promise<LovableAssetMap> {
  const assets: LovableAssetMap = new Map();
  const imports: Array<{ localName: string; resolvedPath: string; fallbackPath: string }> = [];
  const currentFilePath = normalizeProjectPath(sourceFile.fileName);

  sourceFile.forEachChild((node) => {
    if (!ts.isImportDeclaration(node) || !node.importClause?.name) {
      return;
    }

    const moduleName = node.moduleSpecifier;

    if (!ts.isStringLiteral(moduleName)) {
      return;
    }

    const resolvedAssetPath = resolveZipModulePath(zip, currentFilePath, moduleName.text);

    if (!resolvedAssetPath || !isAssetFile(resolvedAssetPath)) {
      return;
    }

    imports.push({
      localName: node.importClause.name.text,
      resolvedPath: resolvedAssetPath,
      fallbackPath: normalizeProjectPath(moduleName.text.replace(/^@\//, "src/"))
    });
  });

  for (const assetImport of imports) {
    const dataUrl = await readZipAssetDataUrl(zip, assetImport.resolvedPath);

    if (!dataUrl) {
      assets.set(assetImport.localName, assetImport.fallbackPath);
      continue;
    }

    assets.set(assetImport.localName, dataUrl);
  }

  return assets;
}

function getLocalComponentImports(
  sourceFile: ts.SourceFile,
  zip: JSZip
): Map<string, LocalComponentImport> {
  const currentFilePath = normalizeProjectPath(sourceFile.fileName);
  const componentImports = new Map<string, LocalComponentImport>();

  sourceFile.forEachChild((node) => {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) {
      return;
    }

    const resolvedModulePath = resolveZipModulePath(
      zip,
      currentFilePath,
      node.moduleSpecifier.text
    );

    if (!resolvedModulePath || !isRenderableSourceFile(resolvedModulePath)) {
      return;
    }

    if (node.importClause?.name) {
      componentImports.set(node.importClause.name.text, {
        filePath: resolvedModulePath,
        exportName: "default"
      });
    }

    const namedBindings = node.importClause?.namedBindings;

    if (!namedBindings || !ts.isNamedImports(namedBindings)) {
      return;
    }

    namedBindings.elements.forEach((element) => {
      componentImports.set(element.name.text, {
        filePath: resolvedModulePath,
        exportName: element.propertyName?.text ?? element.name.text
      });
    });
  });

  return componentImports;
}

async function loadProjectModule(
  zip: JSZip,
  filePath: string,
  modules: Map<string, ProjectModule>
): Promise<ProjectModule | null> {
  const normalizedPath = normalizeProjectPath(filePath);
  const cached = modules.get(normalizedPath);

  if (cached) {
    return cached;
  }

  const source = await readZipSourceFile(zip, normalizedPath);

  if (!source) {
    return null;
  }

  const sourceFile = createSourceFile(normalizedPath, source);
  const assets = await getAssets(sourceFile, zip);
  const constants = getConstants(sourceFile, assets);
  const localComponentImports = getLocalComponentImports(sourceFile, zip);
  const module: ProjectModule = {
    filePath: normalizedPath,
    sourceFile,
    constants,
    assets,
    localComponentImports
  };

  modules.set(normalizedPath, module);

  for (const importedModule of localComponentImports.values()) {
    await loadProjectModule(zip, importedModule.filePath, modules);
  }

  for (const [localName, importedModule] of localComponentImports.entries()) {
    const importedValue = resolveImportedBindingValue(importedModule, modules);

    if (importedValue !== undefined) {
      constants.set(localName, importedValue);
    }
  }

  return module;
}

async function createProjectRenderContext(zip: JSZip, entryFile: string) {
  const modules = new Map<string, ProjectModule>();
  const entryModule = await loadProjectModule(zip, entryFile, modules);

  if (!entryModule) {
    return null;
  }

  return {
    entryFile: normalizeProjectPath(entryFile),
    modules
  } satisfies ProjectRenderContext;
}

function resolveImportedBindingValue(
  importedBinding: LocalComponentImport,
  modules: Map<string, ProjectModule>
) {
  const targetModule = modules.get(importedBinding.filePath);

  if (!targetModule) {
    return undefined;
  }

  if (importedBinding.exportName !== "default") {
    return targetModule.constants.get(importedBinding.exportName);
  }

  for (const statement of targetModule.sourceFile.statements) {
    if (!ts.isExportAssignment(statement)) {
      continue;
    }

    if (ts.isIdentifier(statement.expression)) {
      return targetModule.constants.get(statement.expression.text);
    }

    if (ts.isExpression(statement.expression)) {
      return parseLiteralValue(statement.expression, targetModule.assets) ?? undefined;
    }
  }

  return undefined;
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

function renderProjectStyles(styleEntries: Array<{ path: string; source: string }>) {
  if (styleEntries.length === 0) {
    return "";
  }

  return `<style data-converter-v3-project-css>
${styleEntries
  .map(
    (entry) =>
      `/* ${escapeHtml(entry.path)} */\n${entry.source.replace(/<\/style/gi, "<\\/style")}`
  )
  .join("\n\n")}
</style>`;
}

function isLowerCaseTag(tagName: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(tagName);
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

function bindValueToPattern(
  name: ts.BindingName,
  value: unknown,
  scope: RenderScope
) {
  if (ts.isIdentifier(name)) {
    scope.set(name.text, value);
    return;
  }

  if (ts.isObjectBindingPattern(name)) {
    name.elements.forEach((element) => {
      const propertyName =
        element.propertyName && ts.isIdentifier(element.propertyName)
          ? element.propertyName.text
          : ts.isIdentifier(element.name)
            ? element.name.text
            : null;
      const nextValue = propertyName ? getObjectProperty(value, propertyName) : undefined;

      bindValueToPattern(element.name, nextValue, scope);
    });
    return;
  }

  if (ts.isArrayBindingPattern(name)) {
    name.elements.forEach((element, index) => {
      if (!ts.isBindingElement(element)) {
        return;
      }

      const nextValue = Array.isArray(value) ? value[index] : undefined;
      bindValueToPattern(element.name, nextValue, scope);
    });
  }
}

function populateScopeFromStatements(
  statements: readonly ts.Statement[],
  sourceFile: ts.SourceFile,
  constants: Map<string, unknown>,
  assets: LovableAssetMap,
  scope: RenderScope,
  project?: ProjectRenderContext
) {
  for (const statement of statements) {
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

      if (
        ts.isArrayBindingPattern(declaration.name) &&
        ts.isCallExpression(declaration.initializer) &&
        ts.isIdentifier(declaration.initializer.expression) &&
        declaration.initializer.expression.text === "useState"
      ) {
        const firstElement = declaration.name.elements[0];
        const firstBinding =
          firstElement && ts.isBindingElement(firstElement) ? firstElement.name : null;
        const initialValue = declaration.initializer.arguments[0];

        if (firstBinding && initialValue && ts.isExpression(initialValue)) {
          bindValueToPattern(
            firstBinding,
            evaluateExpression(initialValue, sourceFile, constants, assets, scope, project),
            scope
          );
        }

        continue;
      }

      bindValueToPattern(
        declaration.name,
        evaluateExpression(declaration.initializer, sourceFile, constants, assets, scope, project),
        scope
      );
    }
  }
}

function findRenderableComponentDeclaration(
  sourceFile: ts.SourceFile,
  componentName: string
): RenderableComponentDeclaration | null {
  let found: RenderableComponentDeclaration | null = null;

  function visit(node: ts.Node) {
    if (found) {
      return;
    }

    if (ts.isFunctionDeclaration(node) && node.name?.text === componentName && node.body) {
      found = {
        parameters: node.parameters,
        body: node.body
      };
      return;
    }

    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.name.text !== componentName) {
          continue;
        }

        if (
          declaration.initializer &&
          (ts.isArrowFunction(declaration.initializer) ||
            ts.isFunctionExpression(declaration.initializer))
        ) {
          found = {
            parameters: declaration.initializer.parameters,
            body: declaration.initializer.body
          };
          return;
        }
      }
    }

    node.forEachChild(visit);
  }

  sourceFile.forEachChild(visit);
  return found;
}

function findDefaultExportComponentDeclaration(
  sourceFile: ts.SourceFile
): RenderableComponentDeclaration | null {
  for (const statement of sourceFile.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) &&
      statement.body
    ) {
      return {
        parameters: statement.parameters,
        body: statement.body
      };
    }

    if (ts.isExportAssignment(statement)) {
      if (ts.isIdentifier(statement.expression)) {
        return findRenderableComponentDeclaration(sourceFile, statement.expression.text);
      }

      if (
        ts.isArrowFunction(statement.expression) ||
        ts.isFunctionExpression(statement.expression)
      ) {
        return {
          parameters: statement.expression.parameters,
          body: statement.expression.body
        };
      }
    }
  }

  return null;
}

function renderComponentDeclaration(params: {
  declaration: RenderableComponentDeclaration;
  module: ProjectModule;
  project: ProjectRenderContext;
  props?: Record<string, unknown>;
}) {
  const scope: RenderScope = new Map();
  const firstParameter = params.declaration.parameters[0];

  if (firstParameter) {
    bindValueToPattern(firstParameter.name, params.props ?? {}, scope);
  }

  if (ts.isBlock(params.declaration.body)) {
    populateScopeFromStatements(
      params.declaration.body.statements,
      params.module.sourceFile,
      params.module.constants,
      params.module.assets,
      scope,
      params.project
    );
    const returnStatement = params.declaration.body.statements.find(ts.isReturnStatement);

    return returnStatement?.expression
      ? renderExpression(
          returnStatement.expression,
          params.module.sourceFile,
          params.module.constants,
          params.module.assets,
          scope,
          params.project
        )
      : "";
  }

  return renderExpression(
    params.declaration.body,
    params.module.sourceFile,
    params.module.constants,
    params.module.assets,
    scope,
    params.project
  );
}

function renderComponentReference(params: {
  module: ProjectModule;
  componentName: string;
  project: ProjectRenderContext;
  props?: Record<string, unknown>;
}) {
  const localDeclaration = findRenderableComponentDeclaration(
    params.module.sourceFile,
    params.componentName
  );

  if (localDeclaration) {
    return renderComponentDeclaration({
      declaration: localDeclaration,
      module: params.module,
      project: params.project,
      props: params.props
    });
  }

  const importedComponent = params.module.localComponentImports.get(params.componentName);

  if (!importedComponent) {
    return "";
  }

  const targetModule = params.project.modules.get(importedComponent.filePath);

  if (!targetModule) {
    return "";
  }

  const targetDeclaration =
    importedComponent.exportName === "default"
      ? findDefaultExportComponentDeclaration(targetModule.sourceFile) ??
        findRenderableComponentDeclaration(targetModule.sourceFile, params.componentName)
      : findRenderableComponentDeclaration(targetModule.sourceFile, importedComponent.exportName);

  if (!targetDeclaration) {
    return "";
  }

  return renderComponentDeclaration({
    declaration: targetDeclaration,
    module: targetModule,
    project: params.project,
    props: params.props
  });
}

function evaluateExpression(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
  constants: Map<string, unknown>,
  assets: LovableAssetMap,
  scope: RenderScope,
  project?: ProjectRenderContext
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
          scope,
          project
        );

        return Array.isArray(spreadValue) ? spreadValue : [];
      }

      return ts.isExpression(element)
        ? [evaluateExpression(element, sourceFile, constants, assets, scope, project)]
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

      objectValue[key] = evaluateExpression(
        property.initializer,
        sourceFile,
        constants,
        assets,
        scope,
        project
      );
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
    const value = evaluateExpression(
      expression.operand,
      sourceFile,
      constants,
      assets,
      scope,
      project
    );

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
      evaluateExpression(
        expression.expression,
        sourceFile,
        constants,
        assets,
        scope,
        project
      ),
      expression.name.text
    );
  }

  if (ts.isElementAccessExpression(expression)) {
    const objectValue = evaluateExpression(
      expression.expression,
      sourceFile,
      constants,
      assets,
      scope,
      project
    );
    const propertyValue = expression.argumentExpression
      ? evaluateExpression(
          expression.argumentExpression,
          sourceFile,
          constants,
          assets,
          scope,
          project
        )
      : undefined;

    if (Array.isArray(objectValue)) {
      return typeof propertyValue === "number" ? objectValue[propertyValue] : undefined;
    }

    if (
      objectValue &&
      typeof objectValue === "object" &&
      (typeof propertyValue === "string" || typeof propertyValue === "number")
    ) {
      return (objectValue as Record<string, unknown>)[String(propertyValue)];
    }

    return null;
  }

  if (ts.isAsExpression(expression)) {
    return evaluateExpression(expression.expression, sourceFile, constants, assets, scope, project);
  }

  if (ts.isSatisfiesExpression(expression)) {
    return evaluateExpression(expression.expression, sourceFile, constants, assets, scope, project);
  }

  if (ts.isNonNullExpression(expression)) {
    return evaluateExpression(expression.expression, sourceFile, constants, assets, scope, project);
  }

  if (ts.isParenthesizedExpression(expression)) {
    return evaluateExpression(expression.expression, sourceFile, constants, assets, scope, project);
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
            scope,
            project
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
        scope,
        project
      );

      return left
        ? renderExpression(expression.right, sourceFile, constants, assets, scope, project)
        : ts.isIdentifier(expression.left) && expressionContainsJsx(expression.right)
          ? renderExpression(expression.right, sourceFile, constants, assets, scope, project)
          : "";
    }

    if (expression.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
      const left = evaluateExpression(
        expression.left,
        sourceFile,
        constants,
        assets,
        scope,
        project
      );

      return left
        ? left
        : evaluateExpression(expression.right, sourceFile, constants, assets, scope, project);
    }

    if (expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
      const left = evaluateExpression(
        expression.left,
        sourceFile,
        constants,
        assets,
        scope,
        project
      );

      return left !== null && left !== undefined && left !== ""
        ? left
        : evaluateExpression(expression.right, sourceFile, constants, assets, scope, project);
    }

    if (expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = evaluateExpression(
        expression.left,
        sourceFile,
        constants,
        assets,
        scope,
        project
      );
      const right = evaluateExpression(
        expression.right,
        sourceFile,
        constants,
        assets,
        scope,
        project
      );

      return `${left ?? ""}${right ?? ""}`;
    }

    const left = evaluateExpression(
      expression.left,
      sourceFile,
      constants,
      assets,
      scope,
      project
    );
    const right = evaluateExpression(
      expression.right,
      sourceFile,
      constants,
      assets,
      scope,
      project
    );

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
      scope,
      project
    );

    return renderExpression(
      condition ? expression.whenTrue : expression.whenFalse,
      sourceFile,
      constants,
      assets,
      scope,
      project
    );
  }

  if (ts.isCallExpression(expression)) {
    return renderCallExpression(expression, sourceFile, constants, assets, scope, project);
  }

  if (ts.isNewExpression(expression)) {
    const className = expression.expression.getText(sourceFile);

    if (className === "Date") {
      return new Date();
    }
  }

  if (ts.isJsxElement(expression) || ts.isJsxSelfClosingElement(expression)) {
    return renderJsxNode(expression, sourceFile, constants, assets, scope, project);
  }

  return "";
}

function renderExpression(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
  constants: Map<string, unknown>,
  assets: LovableAssetMap,
  scope: RenderScope,
  project?: ProjectRenderContext
): string {
  const value = evaluateExpression(expression, sourceFile, constants, assets, scope, project);

  return typeof value === "string" ? value : renderUnknownValue(value);
}

function renderCallExpression(
  expression: ts.CallExpression,
  sourceFile: ts.SourceFile,
  constants: Map<string, unknown>,
  assets: LovableAssetMap,
  scope: RenderScope,
  project?: ProjectRenderContext
): unknown {
  if (ts.isIdentifier(expression.expression) && expression.expression.text === "Array") {
    const lengthArg = expression.arguments[0];
    const length = lengthArg && ts.isExpression(lengthArg)
      ? Number(evaluateExpression(lengthArg, sourceFile, constants, assets, scope, project))
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
      scope,
      project
    );
    const digitsArg = expression.arguments[0];
    const digits = digitsArg && ts.isExpression(digitsArg)
      ? Number(evaluateExpression(digitsArg, sourceFile, constants, assets, scope, project))
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
      scope,
      project
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
    scope,
    project
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

      if (itemParam) {
        bindValueToPattern(itemParam, item, itemScope);
      }

      if (indexParam) {
        bindValueToPattern(indexParam, index, itemScope);
      }

      if (ts.isBlock(callback.body)) {
        populateScopeFromStatements(
          callback.body.statements,
          sourceFile,
          constants,
          assets,
          itemScope,
          project
        );
        const returnStatement = callback.body.statements.find(ts.isReturnStatement);

        return returnStatement?.expression
          ? renderExpression(
              returnStatement.expression,
              sourceFile,
              constants,
              assets,
              itemScope,
              project
            )
          : "";
      }

      return renderExpression(callback.body, sourceFile, constants, assets, itemScope, project);
    })
    .join("");
}

function renderJsxAttributes(
  attributes: ts.JsxAttributes,
  sourceFile: ts.SourceFile,
  constants: Map<string, unknown>,
  assets: LovableAssetMap,
  scope: RenderScope,
  project?: ProjectRenderContext
): string {
  const rendered: string[] = [];

  for (const property of attributes.properties) {
    if (!ts.isJsxAttribute(property) || !ts.isIdentifier(property.name)) {
      continue;
    }

    const rawName = property.name.text;
    const attrName = rawName === "className" ? "class" : rawName;
    const isDataAttribute = attrName.startsWith("data-");
    const isAriaAttribute = attrName.startsWith("aria-");

    if (
      ![
        "class",
        "href",
        "src",
        "srcSet",
        "sizes",
        "alt",
        "id",
        "width",
        "height",
        "loading",
        "poster",
        "target",
        "rel",
        "role",
        "style"
      ].includes(attrName) &&
      !isDataAttribute &&
      !isAriaAttribute
    ) {
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
              scope,
              project
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

function resolveAssetReference(
  tagName: string,
  scope: RenderScope,
  constants: Map<string, unknown>,
  assets: LovableAssetMap
) {
  const value = scope.get(tagName) ?? constants.get(tagName) ?? assets.get(tagName);
  return typeof value === "string" && value.startsWith("data:") ? value : null;
}

function renderGenericComponentAttributes(
  props: Record<string, unknown>,
  omittedKeys: Set<string> = new Set()
) {
  return Object.entries(props)
    .flatMap(([key, value]) => {
      if (omittedKeys.has(key)) {
        return [];
      }

      const attrName =
        key === "className"
          ? "class"
          : key === "srcSet"
            ? "srcset"
            : key === "htmlFor"
              ? "for"
              : key;

      if (
        ![
          "class",
          "href",
          "src",
          "srcSet",
          "sizes",
          "alt",
          "id",
          "width",
          "height",
          "loading",
          "poster",
          "target",
          "rel",
          "role",
          "type",
          "title"
        ].includes(attrName) &&
        !attrName.startsWith("data-") &&
        !attrName.startsWith("aria-")
      ) {
        return [];
      }

      if (typeof value === "string" || typeof value === "number") {
        return [` ${attrName}="${escapeHtml(String(value))}"`];
      }

      if (value === true) {
        return [` ${attrName}="true"`];
      }

      return [];
    })
    .join("");
}

function renderGenericComponentFallback(
  tagName: string,
  props: Record<string, unknown>,
  children?: string
) {
  const resolvedHref =
    typeof props.href === "string" && props.href.trim()
      ? props.href
      : typeof props.to === "string" && props.to.trim()
        ? props.to
        : undefined;
  const resolvedProps = resolvedHref ? { ...props, href: resolvedHref } : props;
  const className =
    typeof resolvedProps.className === "string"
      ? resolvedProps.className
      : typeof resolvedProps.class === "string"
        ? resolvedProps.class
        : undefined;
  const styleValue = renderStyleObject(resolvedProps.style);
  const baseAttrs = renderGenericComponentAttributes(resolvedProps);
  const attrs =
    baseAttrs +
    (className && !/\sclass=/.test(baseAttrs)
      ? ` class="${escapeHtml(className)}"`
      : "") +
    (styleValue ? ` style="${escapeHtml(styleValue)}"` : "");
  const innerHtml =
    typeof children === "string" && children.trim()
      ? children
      : [resolvedProps.title, resolvedProps.body]
          .filter((value) => typeof value === "string" && value.trim())
          .map((value) => escapeHtml(String(value)))
          .join(" ");

  if (typeof resolvedProps.src === "string" && resolvedProps.src.trim()) {
    const imageAttrs =
      renderGenericComponentAttributes(
        resolvedProps,
        new Set(["src", "alt", "className", "class", "style"])
      ) +
      (className ? ` class="${escapeHtml(className)}"` : "") +
      (styleValue ? ` style="${escapeHtml(styleValue)}"` : "");

    return `<img${imageAttrs} src="${escapeHtml(resolvedProps.src)}" alt="${escapeHtml(
      typeof resolvedProps.alt === "string" ? resolvedProps.alt : ""
    )}" />`;
  }

  if (typeof resolvedProps.href === "string" && resolvedProps.href.trim()) {
    return `<a${attrs}>${innerHtml}</a>`;
  }

  if (/button|trigger/i.test(tagName) || resolvedProps.role === "button") {
    return `<button${attrs}>${innerHtml}</button>`;
  }

  return innerHtml ? `<div${attrs}>${innerHtml}</div>` : "";
}

function renderJsxChildren(
  children: ts.NodeArray<ts.JsxChild>,
  sourceFile: ts.SourceFile,
  constants: Map<string, unknown>,
  assets: LovableAssetMap,
  scope: RenderScope,
  project?: ProjectRenderContext
): string {
  const childList = [...children];

  return childList
    .map((child, index) => {
      if (ts.isJsxText(child)) {
        return renderJsxTextNode(child, sourceFile, childList[index - 1], childList[index + 1]);
      }

      if (ts.isJsxExpression(child) && child.expression) {
        return renderExpression(child.expression, sourceFile, constants, assets, scope, project);
      }

      return renderJsxNode(child, sourceFile, constants, assets, scope, project);
    })
    .join("");
}

const ICON_FALLBACK_PATHS: Record<string, string> = {
  Check: '<path d="M5 12.5l4 4L19 6.5"></path>',
  Plus: '<path d="M12 5v14"></path><path d="M5 12h14"></path>',
  Minus: '<path d="M5 12h14"></path>',
  Heart:
    '<path d="M12 20s-6.5-4.2-8.5-8C1.8 8.6 3.9 5 7.8 5c1.8 0 3.2 0.9 4.2 2.2C13 5.9 14.4 5 16.2 5c3.9 0 6 3.6 4.3 7-2 3.8-8.5 8-8.5 8z"></path>',
  Shield: '<path d="M12 3l7 3v5c0 5-3.3 8.1-7 10-3.7-1.9-7-5-7-10V6l7-3z"></path>',
  Truck:
    '<path d="M3 7h10v8H3z"></path><path d="M13 10h4l3 3v2h-7z"></path><circle cx="7.5" cy="17.5" r="1.5"></circle><circle cx="17.5" cy="17.5" r="1.5"></circle>',
  Star:
    '<path d="M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8L12 16.8 6.7 19.6l1-5.8-4.2-4.1 5.9-.9L12 3.5z"></path>',
  Sparkles:
    '<path d="M12 3.5l2.2 5 5.3 2.2-5.3 2.2-2.2 5-2.2-5-5.3-2.2 5.3-2.2 2.2-5z"></path>'
};

function serializeSvgLength(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  return null;
}

function isLikelyIconComponent(tagName: string, props: Record<string, unknown>) {
  if (NON_RENDERABLE_COMPONENTS.has(tagName) || /Icon$/i.test(tagName)) {
    return true;
  }

  const propKeys = Object.keys(props);

  if (propKeys.length === 0 || propKeys.length > 8) {
    return false;
  }

  const iconLikeProps = new Set([
    "class",
    "className",
    "color",
    "size",
    "strokeWidth",
    "width",
    "height",
    "aria-hidden"
  ]);

  return (
    /^[A-Z][A-Za-z0-9]+$/.test(tagName) &&
    propKeys.every((key) => iconLikeProps.has(key))
  );
}

function renderIconFallback(tagName: string, props: Record<string, unknown>) {
  const className =
    typeof props.className === "string"
      ? props.className
      : typeof props.class === "string"
        ? props.class
        : "";
  const width = serializeSvgLength(props.width ?? props.size) ?? "24";
  const height = serializeSvgLength(props.height ?? props.size) ?? width;
  const strokeWidth = serializeSvgLength(props.strokeWidth) ?? "1.5";
  const color = typeof props.color === "string" && props.color.trim() ? props.color.trim() : "currentColor";
  const pathMarkup =
    ICON_FALLBACK_PATHS[tagName] ??
    '<circle cx="12" cy="12" r="8"></circle><path d="M12 8v8"></path><path d="M8 12h8"></path>';
  const attrs = [
    `data-lovable-icon="${escapeHtml(tagName)}"`,
    'viewBox="0 0 24 24"',
    'fill="none"',
    `stroke="${escapeHtml(color)}"`,
    `stroke-width="${escapeHtml(strokeWidth)}"`,
    'stroke-linecap="round"',
    'stroke-linejoin="round"',
    'aria-hidden="true"',
    `width="${escapeHtml(width)}"`,
    `height="${escapeHtml(height)}"`
  ];

  if (className) {
    attrs.push(`class="${escapeHtml(className)}"`);
  }

  return `<svg ${attrs.join(" ")}>${pathMarkup}</svg>`;
}

function renderCustomComponent(
  tagName: string,
  attributes: ts.JsxAttributes,
  sourceFile: ts.SourceFile,
  constants: Map<string, unknown>,
  assets: LovableAssetMap,
  scope: RenderScope,
  project?: ProjectRenderContext,
  children?: string
): string {
  const props: Record<string, unknown> = {};

  for (const property of attributes.properties) {
    if (!ts.isJsxAttribute(property) || !ts.isIdentifier(property.name)) {
      continue;
    }

    const initializer = property.initializer;

    props[property.name.text] = initializer
      ? ts.isStringLiteral(initializer)
        ? initializer.text
        : ts.isJsxExpression(initializer) && initializer.expression
          ? evaluateExpression(
              initializer.expression,
              sourceFile,
              constants,
              assets,
              scope,
              project
            )
          : ""
      : true;
  }

  if (children) {
    props.children = children;
  }

  const assetReference = resolveAssetReference(tagName, scope, constants, assets);

  if (assetReference) {
    return renderGenericComponentFallback(tagName, {
      ...props,
      src: props.src ?? assetReference,
      alt: typeof props.alt === "string" ? props.alt : tagName
    });
  }

  if (NON_RENDERABLE_COMPONENTS.has(tagName)) {
    return renderIconFallback(tagName, props);
  }

  if (project) {
    const currentModule = project.modules.get(normalizeProjectPath(sourceFile.fileName));

    if (currentModule) {
      const renderedComponent = renderComponentReference({
        module: currentModule,
        componentName: tagName,
        project,
        props
      });

      if (renderedComponent.trim()) {
        return renderedComponent;
      }
    }
  }

  if (isLikelyIconComponent(tagName, props)) {
    return renderIconFallback(tagName, props);
  }

  return renderGenericComponentFallback(tagName, props, children);
}

function renderJsxNode(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  constants: Map<string, unknown>,
  assets: LovableAssetMap,
  scope: RenderScope,
  project?: ProjectRenderContext
): string {
  if (ts.isJsxFragment(node)) {
    return renderJsxChildren(node.children, sourceFile, constants, assets, scope, project);
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
        scope,
        project
      );
    }

    const attrs = renderJsxAttributes(
      node.attributes,
      sourceFile,
      constants,
      assets,
      scope,
      project
    );

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
        scope,
        project,
        renderJsxChildren(node.children, sourceFile, constants, assets, scope, project)
      );
    }

    const attrs = renderJsxAttributes(
      node.openingElement.attributes,
      sourceFile,
      constants,
      assets,
      scope,
      project
    );
    const children = renderJsxChildren(
      node.children,
      sourceFile,
      constants,
      assets,
      scope,
      project
    );

    return `<${tagName}${attrs}>${children}</${tagName}>`;
  }

  return "";
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

function getCustomJsxTagName(
  node: ts.JsxElement | ts.JsxSelfClosingElement,
  sourceFile: ts.SourceFile
) {
  const tagName = ts.isJsxElement(node)
    ? node.openingElement.tagName.getText(sourceFile)
    : node.tagName.getText(sourceFile);

  return isLowerCaseTag(tagName) ? null : tagName;
}

function findRouteComponentReference(sourceFile: ts.SourceFile) {
  let componentName: string | null = null;

  function visit(node: ts.Node) {
    if (componentName) {
      return;
    }

    if (ts.isPropertyAssignment(node)) {
      const propertyName =
        ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)
          ? node.name.text
          : null;

      if (
        propertyName &&
        /^(?:component|Component)$/i.test(propertyName) &&
        ts.isIdentifier(node.initializer)
      ) {
        componentName = node.initializer.text;
        return;
      }

      if (
        propertyName === "element" &&
        (ts.isJsxElement(node.initializer) || ts.isJsxSelfClosingElement(node.initializer))
      ) {
        const tagName = getCustomJsxTagName(node.initializer, sourceFile);

        if (tagName) {
          componentName = tagName;
          return;
        }
      }
    }

    node.forEachChild(visit);
  }

  sourceFile.forEachChild(visit);
  return componentName;
}

function findRenderedRootExpression(sourceFile: ts.SourceFile): ts.Expression | null {
  let found: ts.Expression | null = null;

  function visit(node: ts.Node) {
    if (found || !ts.isCallExpression(node)) {
      node.forEachChild(visit);
      return;
    }

    const calleeText = node.expression.getText(sourceFile);
    const jsxArgument = node.arguments.find(
      (argument): argument is ts.Expression =>
        ts.isExpression(argument) &&
        (ts.isJsxElement(argument) ||
          ts.isJsxSelfClosingElement(argument) ||
          ts.isJsxFragment(argument))
    );

    if (
      jsxArgument &&
      (/\.render$/i.test(calleeText) ||
        /(?:^|\.)(?:hydrateRoot|render)$/i.test(calleeText))
    ) {
      found = jsxArgument;
      return;
    }

    node.forEachChild(visit);
  }

  sourceFile.forEachChild(visit);
  return found;
}

function findDefaultExportReference(sourceFile: ts.SourceFile) {
  for (const statement of sourceFile.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) &&
      statement.name
    ) {
      return statement.name.text;
    }

    if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
      return statement.expression.text;
    }
  }

  return null;
}

function findPreferredLocalComponentName(sourceFile: ts.SourceFile) {
  const candidates = ["App", "Index", "Page", "Home", "Root"];
  return candidates.find((candidate) => Boolean(findRenderableComponentDeclaration(sourceFile, candidate))) ?? null;
}

function renderRootTarget(
  target: RootRenderTarget,
  module: ProjectModule,
  project: ProjectRenderContext
) {
  return target.kind === "expression"
    ? renderExpression(
        target.expression,
        module.sourceFile,
        module.constants,
        module.assets,
        new Map(),
        project
      )
    : renderComponentReference({
        module,
        componentName: target.componentName,
        project,
        props: {}
      });
}

function rankProjectRenderCandidate(
  project: ProjectRenderContext,
  module: ProjectModule,
  target: RootRenderTarget
) {
  const normalizedPath = normalizeProjectPath(module.filePath);
  const basename = path.posix.basename(normalizedPath);
  let priority = rankEntryFile(normalizedPath) * 10;

  if (normalizedPath === normalizeProjectPath(project.entryFile)) {
    priority += 100;
  }

  if (/(^|\/)src\/(?:routes|pages)\//i.test(normalizedPath)) {
    priority -= 25;
  }

  if (/(^|\/)(?:index|home|landing|page|screen|view)\.(?:tsx|jsx|ts|js)$/i.test(normalizedPath)) {
    priority -= 12;
  }

  if (/(^|\/)(?:components|ui|hooks|lib|utils|providers?)\//i.test(normalizedPath)) {
    priority += 30;
  }

  if (/^(?:__root|root|layout|router|provider|providers|main|bootstrap|entry(?:-client|-server)?)\./i.test(basename)) {
    priority += 18;
  }

  if (
    target.kind === "component-reference" &&
    /(?:Layout|Provider|Router|Outlet)$/i.test(target.componentName)
  ) {
    priority += 20;
  }

  if (
    target.kind === "expression" &&
    /(?:RouterProvider|BrowserRouter|HashRouter|MemoryRouter|Outlet)/.test(
      target.expression.getText(module.sourceFile)
    )
  ) {
    priority += 25;
  }

  return priority;
}

function collectProjectRenderCandidates(project: ProjectRenderContext) {
  const candidates: ProjectRenderCandidate[] = [];

  for (const module of project.modules.values()) {
    const target = findRootRenderTarget(module.sourceFile);

    if (!target) {
      continue;
    }

    candidates.push({
      module,
      target,
      priority: rankProjectRenderCandidate(project, module, target)
    });
  }

  return candidates.sort((left, right) => {
    if (left.priority !== right.priority) {
      return left.priority - right.priority;
    }

    return left.module.filePath.localeCompare(right.module.filePath);
  });
}

function scoreRenderedHtml(value: string) {
  const text = normalizeText(value.replace(/<[^>]+>/g, " "));
  const semanticNodeCount =
    value.match(/<(?:main|section|article|header|footer|aside|nav|h1|h2|h3|p|img|button|a)\b/gi)
      ?.length ?? 0;

  return text.length + semanticNodeCount * 24;
}

function findRootRenderTarget(sourceFile: ts.SourceFile): RootRenderTarget | null {
  const renderedRootExpression = findRenderedRootExpression(sourceFile);

  if (renderedRootExpression) {
    return {
      kind: "expression",
      expression: renderedRootExpression
    };
  }

  const routeComponent = findRouteComponentReference(sourceFile);

  if (routeComponent) {
    return {
      kind: "component-reference",
      componentName: routeComponent
    };
  }

  const defaultExportComponent = findDefaultExportReference(sourceFile);

  if (defaultExportComponent) {
    return {
      kind: "component-reference",
      componentName: defaultExportComponent
    };
  }

  const preferredLocalComponent = findPreferredLocalComponentName(sourceFile);

  if (preferredLocalComponent) {
    return {
      kind: "component-reference",
      componentName: preferredLocalComponent
    };
  }

  return null;
}

function renderStaticLovableHtml(project: ProjectRenderContext): string | null {
  const entryModule = project.modules.get(project.entryFile);

  if (!entryModule) {
    return null;
  }

  const target = findRootRenderTarget(entryModule.sourceFile);

  if (!target) {
    return null;
  }

  const body = renderRootTarget(target, entryModule, project).trim();

  if (body) {
    return body;
  }

  const seenOutputs = new Set<string>(body ? [body] : []);
  let bestFallbackOutput = "";
  let bestFallbackScore = -1;

  for (const candidate of collectProjectRenderCandidates(project)) {
    if (candidate.module.filePath === entryModule.filePath) {
      continue;
    }

    const renderedCandidate = renderRootTarget(candidate.target, candidate.module, project).trim();

    if (!renderedCandidate || seenOutputs.has(renderedCandidate)) {
      continue;
    }

    seenOutputs.add(renderedCandidate);
    const candidateScore = scoreRenderedHtml(renderedCandidate) - candidate.priority;

    if (candidateScore > bestFallbackScore) {
      bestFallbackOutput = renderedCandidate;
      bestFallbackScore = candidateScore;
    }
  }

  return bestFallbackOutput || null;
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

function rankEntryFile(filePath: string) {
  const normalized = normalizeProjectPath(filePath);

  if (/src\/main\.(?:tsx|jsx|ts|js)$/i.test(normalized)) {
    return 0;
  }

  if (/src\/index\.(?:tsx|jsx|ts|js)$/i.test(normalized)) {
    return 1;
  }

  if (/src\/App\.(?:tsx|jsx|ts|js)$/i.test(normalized)) {
    return 2;
  }

  if (/src\/(?:Root|root|entry(?:-client|-server)?)\.(?:tsx|jsx|ts|js)$/i.test(normalized)) {
    return 3;
  }

  if (/src\/(?:routes|pages)\/index\.(?:tsx|jsx|ts|js)$/i.test(normalized)) {
    return 4;
  }

  if (/src\/(?:routes|pages)\//i.test(normalized)) {
    return 5;
  }

  if (/\.(?:tsx|jsx)$/i.test(normalized)) {
    return 6;
  }

  return 7;
}

async function findHtmlLinkedEntry(zip: JSZip) {
  const htmlEntries = Object.keys(zip.files)
    .map((name) => normalizeProjectPath(name))
    .filter((name) => /(?:^|\/)index\.html$/i.test(name) || name.toLowerCase().endsWith(".html"))
    .sort((left, right) => {
      const leftPriority = /(?:^|\/)index\.html$/i.test(left) ? 0 : 1;
      const rightPriority = /(?:^|\/)index\.html$/i.test(right) ? 0 : 1;

      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority;
      }

      return left.length - right.length || left.localeCompare(right);
    });

  for (const htmlEntry of htmlEntries) {
    const html = await readZipSourceFile(zip, htmlEntry);

    if (!html) {
      continue;
    }

    for (const match of html.matchAll(
      /<script[^>]+type=["']module["'][^>]+src=["']([^"']+)["']/gi
    )) {
      const candidate = resolveZipModulePath(zip, htmlEntry, match[1]);

      if (candidate && isRenderableSourceFile(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

async function pickLovableEntryFile(zip: JSZip, preferredEntryFile?: string | null) {
  const normalizedPreferredEntry = preferredEntryFile ? normalizeProjectPath(preferredEntryFile) : null;

  if (normalizedPreferredEntry && zip.file(normalizedPreferredEntry)) {
    return normalizedPreferredEntry;
  }

  const htmlLinkedEntry = await findHtmlLinkedEntry(zip);

  if (htmlLinkedEntry) {
    return htmlLinkedEntry;
  }

  const candidates = Object.keys(zip.files)
    .map((name) => normalizeProjectPath(name))
    .filter((name) => isRenderableSourceFile(name) && /(^|\/)src\//i.test(name))
    .sort((left, right) => {
      const leftRank = rankEntryFile(left);
      const rightRank = rankEntryFile(right);

      if (leftRank !== rightRank) {
        return leftRank - rightRank;
      }

      return left.length - right.length || left.localeCompare(right);
    });

  return candidates[0] ?? null;
}

export async function extractLovableProjectHtml(
  zip: JSZip,
  options: {
    entryFile?: string | null;
  } = {}
): Promise<string | null> {
  const entryFile = await pickLovableEntryFile(zip, options.entryFile);

  if (!entryFile) {
    return null;
  }

  const project = await createProjectRenderContext(zip, entryFile);

  if (!project) {
    return null;
  }

  const entryModule = project.modules.get(project.entryFile);

  if (!entryModule) {
    return null;
  }

  const projectStyles = renderProjectStyles(
    await collectProjectStylesheets(project, zip)
  );

  const renderedHtml = renderStaticLovableHtml(project);

  if (renderedHtml) {
    return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(getTitle(entryModule.sourceFile, entryModule.constants))}</title>
    ${projectStyles}
  </head>
  <body>
${renderedHtml}
  </body>
</html>`;
  }

  const nodes = collectNodesFromJsx(
    entryModule.sourceFile,
    entryModule.constants,
    entryModule.assets
  );

  if (!nodes.length) {
    return null;
  }

  const extractedHtml = renderExtractedNodes(
    getTitle(entryModule.sourceFile, entryModule.constants),
    nodes
  );

  if (!projectStyles) {
    return extractedHtml;
  }

  return extractedHtml.replace("</head>", `  ${projectStyles}\n  </head>`);
}
