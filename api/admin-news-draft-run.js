const { requireAdmin, sendJson } = require("./_lib/admin");
const { supabaseRequest } = require("./_lib/supabase");

const GOOGLE_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent";
const SENDGRID_SEND_URL = "https://api.sendgrid.com/v3/mail/send";

const APPROVED_SOURCES = [
  {
    name: "OpenAI Blog",
    domain: "openai.com",
    url: "https://openai.com/news/",
  },
  {
    name: "Anthropic Newsroom",
    domain: "anthropic.com",
    url: "https://www.anthropic.com/news",
  },
  {
    name: "NVIDIA Developer Blog",
    domain: "developer.nvidia.com",
    url: "https://developer.nvidia.com/blog/",
  },
  {
    name: "Google DeepMind Blog",
    domain: "deepmind.google",
    url: "https://deepmind.google/discover/blog/",
  },
  {
    name: "Meta AI Blog",
    domain: "ai.meta.com",
    url: "https://ai.meta.com/blog/",
  },
];

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function toIsoDate(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString();
  }
  return date.toISOString();
}

async function fetchExistingSlugs() {
  const rows = await supabaseRequest("ai_news?select=slug,title");
  return new Set((Array.isArray(rows) ? rows : []).map((row) => String(row.slug || "").trim()).filter(Boolean));
}

async function generateDraftCandidates() {
  const apiKey = String(process.env.GOOGLE_GENERATIVE_AI_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("Google Generative AI is not configured.");
  }

  const today = new Date().toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const prompt = [
    `Today is ${today}.`,
    "Use web search and find the most relevant recent AI news items from only these approved sources:",
    ...APPROVED_SOURCES.map((source) => `- ${source.name} (${source.url})`),
    "Return up to 3 items only.",
    "Prioritize actual product launches, API releases, model launches, major research updates, or significant AI infrastructure announcements.",
    "Ignore non-AI corporate news, opinion pieces, and duplicate coverage of the same announcement.",
    "For each item, return JSON with these exact keys:",
    "title, summary, content, source_name, source_url, published_at",
    "Rules:",
    "- title must be the actual article title",
    "- summary must be 1 concise sentence for a homepage row",
    "- content must be 2 short paragraphs in plain text summarizing why it matters for AI product builders",
    "- source_name must match one approved source",
    "- source_url must be the direct article URL from the approved source",
    "- published_at should be ISO 8601 if available, otherwise an empty string",
    "- do not include markdown code fences",
    "- output must be valid JSON matching the schema exactly",
  ].join("\n");

  const response = await fetch(`${GOOGLE_API_URL}?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
      ],
      tools: [{ google_search: {} }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            items: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  title: { type: "STRING" },
                  summary: { type: "STRING" },
                  content: { type: "STRING" },
                  source_name: { type: "STRING" },
                  source_url: { type: "STRING" },
                  published_at: { type: "STRING" },
                },
                required: ["title", "summary", "content", "source_name", "source_url", "published_at"],
              },
            },
          },
          required: ["items"],
        },
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(errorText || "Unable to fetch AI news candidates.");
  }

  const payload = await response.json();
  const text = payload?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "{}";
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Gemini returned non-JSON output: ${text.slice(0, 300)}`);
  }
  return Array.isArray(parsed.items) ? parsed.items : [];
}

async function insertDrafts(items) {
  const existingSlugs = await fetchExistingSlugs();
  const drafts = [];

  for (const item of items) {
    const title = String(item.title || "").trim();
    const summary = String(item.summary || "").trim();
    const content = String(item.content || "").trim();
    const sourceName = String(item.source_name || "").trim();
    const sourceUrl = String(item.source_url || "").trim();
    const publishedAt = toIsoDate(item.published_at);
    const slugBase = slugify(title);
    if (!title || !summary || !content || !sourceName || !sourceUrl || !slugBase) continue;

    let slug = slugBase;
    let counter = 2;
    while (existingSlugs.has(slug)) {
      slug = `${slugBase}-${counter}`;
      counter += 1;
    }
    existingSlugs.add(slug);

    const result = await supabaseRequest("ai_news", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        title,
        slug,
        summary,
        content,
        source_name: sourceName,
        source_url: sourceUrl,
        image_url: "",
        published: false,
        featured: false,
        published_at: publishedAt,
      }),
    });

    const record = Array.isArray(result) ? result[0] : result;
    if (record) drafts.push(record);
  }

  return drafts;
}

async function sendReviewEmail(items) {
  const sendgridApiKey = String(process.env.SENDGRID_API_KEY || "").trim();
  const fromEmail = String(process.env.SENDGRID_FROM_EMAIL || "").trim();
  const destination =
    String(process.env.ADMIN_USERNAME || "").trim() ||
    String(process.env.CONTACT_EMAIL || "on2@on2interactive.com").trim();

  if (!sendgridApiKey || !fromEmail || !destination || !items.length) return;

  const lines = [
    "New AI news drafts are ready for review in the ON2 admin.",
    "",
    ...items.flatMap((item, index) => [
      `${index + 1}. ${item.title}`,
      `Source: ${item.source_name}`,
      `URL: ${item.source_url}`,
      `Draft slug: ${item.slug}`,
      "",
      `${item.summary}`,
      "",
    ]),
    "Review here:",
    "https://on2interactive.vercel.app/admin#news",
  ];

  await fetch(SENDGRID_SEND_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${sendgridApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      personalizations: [
        {
          to: [{ email: destination }],
          subject: `[ON2 Admin] ${items.length} AI news draft${items.length === 1 ? "" : "s"} ready for review`,
        },
      ],
      from: { email: fromEmail },
      reply_to: { email: fromEmail },
      content: [
        {
          type: "text/plain",
          value: lines.join("\n"),
        },
      ],
    }),
  });
}

module.exports = async (request, response) => {
  const session = requireAdmin(request, response);
  if (!session) return;

  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return sendJson(response, 405, { error: "Method not allowed." });
  }

  try {
    const candidates = await generateDraftCandidates();
    if (!candidates.length) {
      return sendJson(response, 200, { success: true, created: 0, items: [] });
    }

    const drafts = await insertDrafts(candidates.slice(0, 3));
    await sendReviewEmail(drafts);

    return sendJson(response, 200, {
      success: true,
      created: drafts.length,
      items: drafts,
    });
  } catch (error) {
    console.error("AI news draft run failed", error);
    return sendJson(response, 500, {
      error: error.message || "Unable to create AI news drafts right now.",
    });
  }
};
