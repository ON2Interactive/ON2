const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const rootDir = __dirname;
const dataDir = path.join(rootDir, "data");
const projectsPath = path.join(dataDir, "projects.json");
const messagesPath = path.join(dataDir, "messages.json");

const env = loadEnv(path.join(rootDir, ".env"));
const port = Number(env.PORT || process.env.PORT || 3000);
const adminEmail = String(env.ADMIN_EMAIL || process.env.ADMIN_EMAIL || "admin@on2interactive.com").trim().toLowerCase();
const adminPassword = String(env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || "change-this-password");
const sessionSecret = String(env.SESSION_SECRET || process.env.SESSION_SECRET || "on2-interactive-session-secret");

const sessions = new Map();

const publicRoutes = new Map([
  ["/", "index.html"],
  ["/contact", "contact.html"],
  ["/adminlogin", "adminlogin.html"],
  ["/products", "product.html"],
  ["/news", "news.html"],
]);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
};

async function ensureDataFiles() {
  await fsp.mkdir(dataDir, { recursive: true });
  for (const filePath of [projectsPath, messagesPath]) {
    try {
      await fsp.access(filePath, fs.constants.F_OK);
    } catch {
      await fsp.writeFile(filePath, filePath === projectsPath ? "[]" : "[]", "utf8");
    }
  }
}

function loadEnv(filePath) {
  try {
    const contents = fs.readFileSync(filePath, "utf8");
    return contents.split(/\r?\n/).reduce((acc, line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return acc;
      const divider = trimmed.indexOf("=");
      if (divider === -1) return acc;
      const key = trimmed.slice(0, divider).trim();
      const value = trimmed.slice(divider + 1).trim();
      if (key) acc[key] = value;
      return acc;
    }, {});
  } catch {
    return {};
  }
}

function createSessionToken() {
  return crypto
    .createHash("sha256")
    .update(`${Date.now()}-${Math.random()}-${sessionSecret}`)
    .digest("hex");
}

function parseCookies(cookieHeader) {
  return String(cookieHeader || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const [key, ...valueParts] = part.split("=");
      if (!key) return cookies;
      cookies[key] = decodeURIComponent(valueParts.join("=") || "");
      return cookies;
    }, {});
}

function getSession(request) {
  const cookies = parseCookies(request.headers.cookie);
  const token = cookies.on2_admin_session;
  if (!token) return null;
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return { token, ...session };
}

function sendJson(response, statusCode, payload, headers = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
    ...headers,
  });
  response.end(body);
}

function sendRedirect(response, location) {
  response.writeHead(302, { Location: location });
  response.end();
}

async function readJson(filePath) {
  const raw = await fsp.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function writeJson(filePath, value) {
  await fsp.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

async function collectBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function normalizeProject(input) {
  const title = String(input.title || "").trim();
  const slugBase = String(input.slug || title)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return {
    id: String(input.id || slugBase || crypto.randomUUID()).trim(),
    title,
    slug: slugBase || crypto.randomUUID(),
    year: String(input.year || "").trim(),
    category: String(input.category || "").trim(),
    client: String(input.client || "").trim(),
    summary: String(input.summary || "").trim(),
    services: String(input.services || "").trim(),
    image: String(input.image || "").trim(),
    link: String(input.link || "").trim(),
    featured: Boolean(input.featured),
    publishedAt: String(input.publishedAt || new Date().toISOString()),
  };
}

function validateProject(project) {
  if (!project.title) return "Project title is required.";
  if (!project.category) return "Category is required.";
  if (!project.summary) return "Summary is required.";
  return "";
}

async function serveStaticFile(response, filePath) {
  try {
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(rootDir)) {
      sendJson(response, 403, { error: "Forbidden." });
      return;
    }
    const stats = await fsp.stat(resolved);
    if (!stats.isFile()) {
      sendJson(response, 404, { error: "Not found." });
      return;
    }
    const extension = path.extname(resolved).toLowerCase();
    response.writeHead(200, {
      "Content-Type": mimeTypes[extension] || "application/octet-stream",
      "Content-Length": stats.size,
    });
    fs.createReadStream(resolved).pipe(response);
  } catch {
    sendJson(response, 404, { error: "Not found." });
  }
}

async function handleApi(request, response, pathname) {
  if (pathname === "/api/projects" && request.method === "GET") {
    const projects = await readJson(projectsPath);
    const ordered = projects
      .slice()
      .sort((a, b) => new Date(b.publishedAt || 0).getTime() - new Date(a.publishedAt || 0).getTime());
    sendJson(response, 200, { projects: ordered });
    return true;
  }

  if (pathname === "/api/contact" && request.method === "POST") {
    const body = await collectBody(request).catch(() => null);
    if (!body) {
      sendJson(response, 400, { error: "Invalid request body." });
      return true;
    }
    const message = {
      id: crypto.randomUUID(),
      name: String(body.name || "").trim(),
      email: String(body.email || "").trim(),
      subject: String(body.subject || "").trim(),
      message: String(body.message || "").trim(),
      createdAt: new Date().toISOString(),
    };
    if (!message.name || !message.email || !message.subject || !message.message) {
      sendJson(response, 400, { error: "All fields are required." });
      return true;
    }
    const messages = await readJson(messagesPath);
    messages.unshift(message);
    await writeJson(messagesPath, messages);
    sendJson(response, 200, {
      success: true,
      message: `Message received. Replies will be sent to ${env.CONTACT_EMAIL || process.env.CONTACT_EMAIL || "hello@on2interactive.com"}.`,
    });
    return true;
  }

  if (pathname === "/api/admin/login" && request.method === "POST") {
    const body = await collectBody(request).catch(() => null);
    if (!body) {
      sendJson(response, 400, { error: "Invalid request body." });
      return true;
    }
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (email !== adminEmail || password !== adminPassword) {
      sendJson(response, 401, { error: "Invalid admin credentials." });
      return true;
    }
    const token = createSessionToken();
    sessions.set(token, {
      email,
      expiresAt: Date.now() + 1000 * 60 * 60 * 12,
    });
    sendJson(
      response,
      200,
      { success: true },
      {
        "Set-Cookie": `on2_admin_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=43200`,
      }
    );
    return true;
  }

  if (pathname === "/api/admin/logout" && request.method === "POST") {
    const session = getSession(request);
    if (session?.token) sessions.delete(session.token);
    sendJson(
      response,
      200,
      { success: true },
      { "Set-Cookie": "on2_admin_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0" }
    );
    return true;
  }

  if (pathname === "/api/admin/session" && request.method === "GET") {
    const session = getSession(request);
    if (!session) {
      sendJson(response, 401, { authenticated: false });
      return true;
    }
    sendJson(response, 200, { authenticated: true, email: session.email });
    return true;
  }

  if (pathname === "/api/admin/projects") {
    const session = getSession(request);
    if (!session) {
      sendJson(response, 401, { error: "Unauthorized." });
      return true;
    }

    if (request.method === "GET") {
      const projects = await readJson(projectsPath);
      sendJson(response, 200, { projects });
      return true;
    }

    if (request.method === "POST") {
      const body = await collectBody(request).catch(() => null);
      if (!body) {
        sendJson(response, 400, { error: "Invalid request body." });
        return true;
      }
      const project = normalizeProject(body);
      const validationError = validateProject(project);
      if (validationError) {
        sendJson(response, 400, { error: validationError });
        return true;
      }
      const projects = await readJson(projectsPath);
      projects.unshift(project);
      await writeJson(projectsPath, projects);
      sendJson(response, 201, { success: true, project });
      return true;
    }
  }

  if (pathname.startsWith("/api/admin/projects/")) {
    const session = getSession(request);
    if (!session) {
      sendJson(response, 401, { error: "Unauthorized." });
      return true;
    }

    const projectId = decodeURIComponent(pathname.split("/").pop() || "");
    const projects = await readJson(projectsPath);
    const index = projects.findIndex((project) => String(project.id) === projectId);

    if (index === -1) {
      sendJson(response, 404, { error: "Project not found." });
      return true;
    }

    if (request.method === "PUT") {
      const body = await collectBody(request).catch(() => null);
      if (!body) {
        sendJson(response, 400, { error: "Invalid request body." });
        return true;
      }
      const updated = normalizeProject({ ...projects[index], ...body, id: projects[index].id });
      const validationError = validateProject(updated);
      if (validationError) {
        sendJson(response, 400, { error: validationError });
        return true;
      }
      projects[index] = updated;
      await writeJson(projectsPath, projects);
      sendJson(response, 200, { success: true, project: updated });
      return true;
    }

    if (request.method === "DELETE") {
      const removed = projects.splice(index, 1)[0];
      await writeJson(projectsPath, projects);
      sendJson(response, 200, { success: true, project: removed });
      return true;
    }
  }

  return false;
}

const server = http.createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    const pathname = decodeURIComponent(requestUrl.pathname);

    if (pathname.startsWith("/api/")) {
      const handled = await handleApi(request, response, pathname);
      if (!handled) sendJson(response, 404, { error: "Not found." });
      return;
    }

    if (pathname === "/admin") {
      const session = getSession(request);
      if (!session) {
        sendRedirect(response, "/adminlogin");
        return;
      }
      await serveStaticFile(response, path.join(rootDir, "admin.html"));
      return;
    }

    if (pathname.startsWith("/products/")) {
      await serveStaticFile(response, path.join(rootDir, "product.html"));
      return;
    }

    if (pathname.startsWith("/news/")) {
      await serveStaticFile(response, path.join(rootDir, "news.html"));
      return;
    }

    if (publicRoutes.has(pathname)) {
      await serveStaticFile(response, path.join(rootDir, publicRoutes.get(pathname)));
      return;
    }

    await serveStaticFile(response, path.join(rootDir, pathname.replace(/^\/+/, "")));
  } catch (error) {
    sendJson(response, 500, { error: "Internal server error." });
  }
});

ensureDataFiles()
  .then(() => {
    server.listen(port, () => {
      console.log(`ON2 Interactive site running at http://localhost:${port}`);
    });
  })
  .catch((error) => {
    console.error("Failed to prepare site data.", error);
    process.exit(1);
  });
