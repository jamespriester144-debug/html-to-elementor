import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

type LocalRenderServer = {
  origin: string;
  close: () => Promise<void>;
};

function getContentType(filePath: string) {
  const lowerPath = filePath.toLowerCase();

  if (lowerPath.endsWith(".html")) return "text/html; charset=utf-8";
  if (lowerPath.endsWith(".css")) return "text/css; charset=utf-8";
  if (lowerPath.endsWith(".js") || lowerPath.endsWith(".mjs")) {
    return "text/javascript; charset=utf-8";
  }
  if (lowerPath.endsWith(".json")) return "application/json; charset=utf-8";
  if (lowerPath.endsWith(".svg")) return "image/svg+xml";
  if (lowerPath.endsWith(".png")) return "image/png";
  if (lowerPath.endsWith(".jpg") || lowerPath.endsWith(".jpeg")) return "image/jpeg";
  if (lowerPath.endsWith(".gif")) return "image/gif";
  if (lowerPath.endsWith(".webp")) return "image/webp";
  if (lowerPath.endsWith(".avif")) return "image/avif";
  if (lowerPath.endsWith(".woff2")) return "font/woff2";
  if (lowerPath.endsWith(".woff")) return "font/woff";
  if (lowerPath.endsWith(".ttf")) return "font/ttf";

  return "application/octet-stream";
}

function normalizeRequestPath(request: IncomingMessage) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const decodedPath = decodeURIComponent(url.pathname);

  return decodedPath === "/" ? "/index.html" : decodedPath;
}

async function resolveFilePath(documentRoot: string, requestPath: string) {
  const normalizedRelativePath = requestPath
    .replace(/^\/+/, "")
    .split("/")
    .filter(Boolean)
    .reduce<string[]>((parts, part) => {
      if (part === ".") {
        return parts;
      }

      if (part === "..") {
        parts.pop();
        return parts;
      }

      parts.push(part);
      return parts;
    }, [])
    .join(path.sep);
  const resolvedPath = path.resolve(documentRoot, normalizedRelativePath);
  const resolvedRoot = path.resolve(documentRoot);

  if (!resolvedPath.startsWith(resolvedRoot)) {
    throw new Error("Path traversal blocked.");
  }

  const fileStat = await stat(resolvedPath);

  if (fileStat.isDirectory()) {
    return path.join(resolvedPath, "index.html");
  }

  return resolvedPath;
}

async function handleFileRequest(
  documentRoot: string,
  request: IncomingMessage,
  response: ServerResponse
) {
  try {
    const requestPath = normalizeRequestPath(request);
    const filePath = await resolveFilePath(documentRoot, requestPath);
    const body = await readFile(filePath);
    response.statusCode = 200;
    response.setHeader("Content-Type", getContentType(filePath));
    response.setHeader("Cache-Control", "no-store");
    response.end(body);
  } catch {
    response.statusCode = 404;
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.end("Not Found");
  }
}

export async function startLocalRenderServer(documentRoot: string): Promise<LocalRenderServer> {
  const server = createServer((request, response) => {
    void handleFileRequest(documentRoot, request, response);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Nao foi possivel inicializar o servidor local de renderizacao.");
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      }).catch(() => undefined);
    }
  };
}
