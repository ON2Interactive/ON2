const { requireAdmin, sendJson } = require("./_lib/admin");
const { supabaseRequest } = require("./_lib/supabase");
const DEFAULT_IMAGE = "/Assets/Hero-Latest.png";

function normalizePayload(input) {
  const title = String(input.title || "").trim();
  const slug =
    String(input.slug || title)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "";

  return {
    title,
    slug,
    summary: String(input.summary || "").trim(),
    content: String(input.content || "").trim(),
    category: String(input.category || "").trim(),
    client: String(input.client || "").trim(),
    solutions: String(input.solutions || input.services || "").trim(),
    year: String(input.year || "").trim(),
    image_url: DEFAULT_IMAGE,
    published: input.published !== false,
    featured: Boolean(input.featured),
    sort_order: Number(input.sort_order || 0) || 0,
  };
}

module.exports = async (request, response) => {
  const session = requireAdmin(request, response);
  if (!session) return;

  try {
    if (request.method === "GET") {
      const projects = await supabaseRequest("products?select=*&order=sort_order.asc,created_at.desc");
      return sendJson(response, 200, { projects });
    }

    if (request.method === "POST") {
      const body = typeof request.body === "string" ? JSON.parse(request.body || "{}") : request.body || {};
      const payload = normalizePayload(body);
      if (!payload.title || !payload.slug || !payload.summary) {
        return sendJson(response, 400, { error: "Title, slug, and summary are required." });
      }

      const result = await supabaseRequest("products", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(payload),
      });
      return sendJson(response, 201, { success: true, project: Array.isArray(result) ? result[0] : result });
    }

    response.setHeader("Allow", "GET, POST");
    return sendJson(response, 405, { error: "Method not allowed." });
  } catch (error) {
    return sendJson(response, 500, { error: "Unable to process products." });
  }
};
