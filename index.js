const express = require("express");
const cors = require("cors");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Debug: print all env var NAMES on startup (not values, just names)
console.log("ENV VARS AVAILABLE:", Object.keys(process.env).join(", "));

const SYSTEM_PROMPT = `You are an expert intelligence analyst producing Vodafone-style stakeholder profiles.
Given a person's name, job title, and organisation, return ONLY valid JSON (no markdown, no preamble):
{
  "name": "Full name with honours",
  "role": "Current job title",
  "organisation": "Organisation",
  "nationality": "Nationality",
  "positionSince": "Month Year - Present",
  "confidence": "medium",
  "confidenceNote": "Based on training knowledge only",
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
  "social": {"linkedinUrl": null, "linkedinNote": "No profile identified", "linkedinLevel": "none", "twitter": null, "instagram": null, "youtube": null},
  "events": [{"title": "Event", "detail": "2-3 sentences", "url": null}],
  "readingMaterials": [{"title": "Title", "detail": "1-2 sentences", "url": null}],
  "sphereOfInfluence": {"reportsTo": {"name": "Name", "role": "Role"}, "peers": [{"name": "Name", "role": "Role"}], "directReports": [{"name": "Name", "role": "Role"}]},
  "sources": []
}
Be specific and grounded using your training knowledge. Use null for unknowns.`;

async function withRetry(fn, retries = 5, delay = 3000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      const isOverloaded = e?.status === 529 || e?.message?.includes("overloaded");
      if (isOverloaded && i < retries - 1) {
        console.log(`Overloaded, retrying in ${delay}ms (attempt ${i + 1}/${retries})`);
        await new Promise(r => setTimeout(r, delay));
        delay *= 2;
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

  // Try every possible key name variation
  const apiKey = process.env.ANTHROPIC_API_KEY
    || process.env.ANTHROPIC_API_KEY
    || process.env["ANTHROPIC_API_KEY"];

  console.log("API key present:", !!apiKey, "| length:", apiKey ? apiKey.length : 0);
  console.log("All env keys:", Object.keys(process.env).filter(k => k.includes("ANTHROP") || k.includes("API")).join(", "));

  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set. Env keys: " + Object.keys(process.env).join(",") });

  const client = new Anthropic({ apiKey });

  try {
    console.log("Calling Anthropic API...");
    const profileRes = await withRetry(() => client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: `Build a stakeholder profile for: ${name}, ${role || "unknown role"}, ${company || "unknown org"}` }]
    }));

    console.log("API call succeeded");
    const txt = profileRes.content?.[0]?.text || "";
    let parsed;
    try {
      parsed = JSON.parse(txt.replace(/```json\n?|```/g, "").trim());
    } catch {
      return res.status(500).json({ error: "JSON parse failed", raw: txt.slice(0, 300) });
    }
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
  console.log(`✅ Running at http://localhost:${PORT}`);
  console.log(`API key configured: ${!!process.env.ANTHROPIC_API_KEY}`);
});
server.timeout = 300000;
server.requestTimeout = 300000;
server.headersTimeout = 310000;
