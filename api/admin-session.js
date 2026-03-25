const { getSession, sendJson } = require("./_lib/admin");

module.exports = async (request, response) => {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return sendJson(response, 405, { error: "Method not allowed." });
  }

  const session = getSession(request);
  if (!session) {
    return sendJson(response, 401, { authenticated: false });
  }

  return sendJson(response, 200, {
    authenticated: true,
    username: session.username,
  });
};
