const { clearSessionCookie, sendJson } = require("./_lib/admin");

module.exports = async (request, response) => {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return sendJson(response, 405, { error: "Method not allowed." });
  }

  return sendJson(response, 200, { success: true }, { "Set-Cookie": clearSessionCookie() });
};
