const RECAPTCHA_VERIFY_URL = "https://www.google.com/recaptcha/api/siteverify";
const SENDGRID_SEND_URL = "https://api.sendgrid.com/v3/mail/send";

function json(response, status, payload) {
  response.status(status).json(payload);
}

module.exports = async (request, response) => {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return json(response, 405, { error: "Method not allowed." });
  }

  const body = typeof request.body === "string" ? JSON.parse(request.body || "{}") : request.body || {};
  const name = String(body.name || "").trim();
  const subject = String(body.subject || "").trim();
  const message = String(body.message || "").trim();
  const recaptchaToken = String(body.recaptchaToken || "").trim();

  if (!name || !subject || !message) {
    return json(response, 400, { error: "Name, subject, and message are required." });
  }

  if (!recaptchaToken) {
    return json(response, 400, { error: "Spam protection token is missing." });
  }

  const secret = String(process.env.RECAPTCHA_SECRET_KEY || "").trim();
  if (!secret) {
    return json(response, 500, { error: "reCAPTCHA is not configured." });
  }

  try {
    const verifyResponse = await fetch(RECAPTCHA_VERIFY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        secret,
        response: recaptchaToken,
      }),
    });

    const verifyPayload = await verifyResponse.json();
    const score = Number(verifyPayload.score || 0);
    const action = String(verifyPayload.action || "");

    if (!verifyPayload.success || action !== "contact_form_submit" || score < 0.5) {
      return json(response, 400, { error: "reCAPTCHA verification failed. Please try again." });
    }

    const destination = String(process.env.CONTACT_EMAIL || "on2@on2interactive.com").trim();
    const sendgridApiKey = String(process.env.SENDGRID_API_KEY || "").trim();
    const fromEmail = String(process.env.SENDGRID_FROM_EMAIL || "").trim();

    if (!sendgridApiKey || !fromEmail) {
      return json(response, 500, { error: "Email delivery is not configured." });
    }

    const emailResponse = await fetch(SENDGRID_SEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${sendgridApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [
          {
            to: [{ email: destination }],
            subject: `[ON2 Contact] ${subject}`,
          },
        ],
        from: { email: fromEmail },
        reply_to: { email: fromEmail },
        content: [
          {
            type: "text/plain",
            value: [
              `Name: ${name}`,
              `Subject: ${subject}`,
              "",
              "Message:",
              message,
              "",
              `reCAPTCHA score: ${score}`,
            ].join("\n"),
          },
        ],
      }),
    });

    if (!emailResponse.ok) {
      const sendgridError = await emailResponse.text().catch(() => "");
      console.error("SendGrid delivery failed", sendgridError);
      return json(response, 500, { error: "Unable to deliver your message right now." });
    }

    console.log("ON2 contact submission accepted", {
      to: destination,
      from: fromEmail,
      name,
      subject,
      message,
      score,
      createdAt: new Date().toISOString(),
    });

    return json(response, 200, {
      success: true,
      message: `Thanks. Your message has been received and will be sent to ${destination}.`,
    });
  } catch (error) {
    console.error("Contact submission failed", error);
    return json(response, 500, { error: "Unable to process your message right now." });
  }
};
