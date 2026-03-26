const crypto = require("crypto");

const { requireAdmin, sendJson } = require("./_lib/admin");

function getStorageConfig() {
  const url = String(process.env.SUPABASE_URL || "").trim();
  const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  const bucket = String(process.env.SUPABASE_STORAGE_BUCKET || "on2-media").trim();

  if (!url || !serviceRoleKey) {
    throw new Error("Supabase storage is not configured.");
  }

  return { url, serviceRoleKey, bucket };
}

function sanitizeSegment(value, fallback) {
  const cleaned = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || fallback;
}

module.exports = async (request, response) => {
  const session = requireAdmin(request, response);
  if (!session) return;

  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return sendJson(response, 405, { error: "Method not allowed." });
  }

  try {
    const body = typeof request.body === "string" ? JSON.parse(request.body || "{}") : request.body || {};
    const folder = sanitizeSegment(body.folder || "uploads", "uploads");
    const fileName = String(body.fileName || "").trim();
    const contentType = String(body.contentType || "application/octet-stream").trim();
    const base64Data = String(body.base64Data || "").trim();

    if (!fileName || !base64Data) {
      return sendJson(response, 400, { error: "Image file is required." });
    }

    const { url, serviceRoleKey, bucket } = getStorageConfig();
    const safeName = sanitizeSegment(fileName, "upload");
    const extensionMatch = safeName.match(/(\.[a-z0-9]+)$/i);
    const extension = extensionMatch ? extensionMatch[1] : "";
    const objectPath = `${folder}/${Date.now()}-${crypto.randomUUID()}${extension}`;
    const buffer = Buffer.from(base64Data, "base64");

    const uploadResponse = await fetch(
      `${url}/storage/v1/object/${encodeURIComponent(bucket)}/${objectPath}`,
      {
        method: "POST",
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          "Content-Type": contentType,
          "x-upsert": "true",
        },
        body: buffer,
      }
    );

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text().catch(() => "");
      return sendJson(response, 500, {
        error: errorText || `Unable to upload image to bucket "${bucket}".`,
      });
    }

    return sendJson(response, 200, {
      success: true,
      path: objectPath,
      bucket,
      url: `${url}/storage/v1/object/public/${bucket}/${objectPath}`,
    });
  } catch (error) {
    return sendJson(response, 500, { error: error.message || "Unable to upload image." });
  }
};
