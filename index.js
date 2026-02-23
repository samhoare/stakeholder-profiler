const express = require("express");
const cors = require("cors");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const SYSTEM_PROMPT = `You are an expert intelligence analyst producing Vodafone-style stakeholder profiles.
Return ONLY valid JSON (no markdown, no preamble):
{
  "name": "Full name with honours",
  "role": "Current job title",
  "organisation": "Organisation",
  "nationality": "Nationality",
  "positionSince": "Month Year - Present",
  "confidence": "high|medium|low",
  "confidenceNote": "One sentence",
  "background": "4-5 sentence narrative paragraph",
  "education": [{"year": "Year", "institution": "Institution", "qualification": "Qualification"}],
  "honorsAwards": [{"title": "Award name", "detail": "Context sentence"}],
  "licensesCerts": ["Cert name"],
  "career": [{"phase": "Early career", "items": [{"period": "Year-Year", "role": "Title", "organisation": "Org", "detail": "Sentence", "subItems": ["sub detail"]}]}],
  "interestsPriorities": {"intro": "Intro paragraph", "priorities": [{"title": "Name", "detail": "Sentence"}], "personal": "Personal interests sentence"},
  "conversationStarters": [{"category": "Category", "starters": ["Starter"]}],
  "disc": {"primary": "DIRECT|INFLUENTIAL|CONSCIENTIOUS|STEADY", "secondary": "DIRECT|INFLUENTIAL|CONSCIENTIOUS|STEADY", "summary": "Paragraph"},
  "engagementSummary": "3-4 sentence paragraph",
  "engagementOpportunities": ["Opportunity"],
  "social": {"linkedinUrl": "URL or null", "linkedinNote": "Sentence", "linkedinLevel": "high|medium|low|none", "twitter": null, "instagram": null, "youtube": null},
  "events": [{"title": "Event", "detail": "2-3 sentences", "url": "URL or null"}],
  "readingMaterials": [{"title": "Title", "detail": "1-2 sentences", "url": "URL or null"}],
  "sphereOfInfluence": {"reportsTo": {"name": "Name", "role": "Role"}, "peers": [{"name": "Name", "role": "Role"}], "directReports": [{"name": "Name", "role": "Role"}]},
  "sources": ["https://..."]
}
Be specific and grounded. Use null for unknowns.`;

function parseUrls(text) {
  const seen = new Set();
  return (text.match(/https?:\/\/[^\s\)"',<>]+/g) || [])
    .filter(u => { if (seen.has(u)) return false; seen.add(u); return true; })
    .slice(0, 25);
}

async function withRetry(fn, retries = 4, delay = 65000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      const isRetryable = e?.status === 529 || e?.status === 429 ||
                          e?.message?.includes("overloaded") || e?.message?.includes("rate_limit");
      if (isRetryable && i < retries - 1) {
        console.log(`Rate limited, waiting 65s to clear window (attempt ${i + 1}/${retries})`);
        await new Promise(r => setTimeout(r, 65000));
      } else {
        throw e;
      }
    }
  }
}

app.post("/api/profile", async (req, res) => {
  const { name, role, company } = req.body;
  if (!name) return res.status(400).json({ error: "Name is required" });

  req.setTimeout(300000);
  res.setTimeout(300000);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });

  const client = new Anthropic({ apiKey });

  try {
    // Step 1: web search using Sonnet
    let research = "";
    let sources = [];
    try {
      console.log("Starting web search for:", name);
      const searchRes = await withRetry(() => client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2000,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{
          role: "user",
          content: `Search for key facts about ${name}${role ? `, ${role}` : ""}${company ? ` at ${company}` : ""}. Find career history, background, key interests, public speeches or writing. Be concise.`
        }]
      }));
      const texts = (searchRes.content || []).filter(b => b.type === "text").map(b => b.text);
      if (texts.length) research = texts.join("\n").slice(0, 2000);
      sources = parseUrls(research);
      console.log("Web search complete, research length:", research.length);
    } catch (e) {
      console.log("Web search failed:", e.message, "— using training knowledge");
    }

    // Step 2: build profile using Haiku (separate rate pool from Sonnet)
    console.log("Building profile with Haiku...");
    const profileRes = await withRetry(() => client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: `Build a stakeholder profile for:
Name: ${name}
Job Title: ${role || "Unknown"}
Organisation: ${company || "Unknown"}

Research summary:
${research || "Use your training knowledge. Be honest about confidence level."}

Sources found: ${sources.join(", ") || "none"}`
      }]
    }));

    const txt = profileRes.content?.[0]?.text || "";
    let parsed;
    try {
      parsed = JSON.parse(txt.replace(/```json\n?|```/g, "").trim());
      if (!parsed.sources?.length && sources.length) parsed.sources = sources;
    } catch {
      return res.status(500).json({ error: "JSON parse failed", raw: txt.slice(0, 300) });
    }

    console.log("Profile complete for:", name);
    res.json({ profile: parsed });

  } catch (e) {
    console.error("Profile error:", e.status, e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

const server = app.listen(PORT, () => {
  console.log(`✅ Stakeholder Profiler running at http://localhost:${PORT}`);
});
server.timeout = 300000;
server.requestTimeout = 300000;
server.headersTimeout = 310000;
