const { createSessionCookie, hasAdminCredentials, isValidAdmin, sendJson } = require("./_lib/admin");

module.exports = async (request, response) => {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return sendJson(response, 405, { error: "Method not allowed." });
  }

  const body = typeof request.body === "string" ? JSON.parse(request.body || "{}") : request.body || {};
  const username = String(body.username || body.email || "").trim();
  const password = String(body.password || "").trim();

  if (!hasAdminCredentials()) {
    return sendJson(response, 500, { error: "Admin credentials are not configured in Vercel." });
  }

  if (!username || !password) {
    return sendJson(response, 400, { error: "Username and password are required." });
  }

  if (!isValidAdmin(username, password)) {
    return sendJson(response, 401, { error: "Invalid admin credentials." });
  }

  const cookie = createSessionCookie(username);
  return sendJson(response, 200, { success: true }, { "Set-Cookie": cookie });
};
