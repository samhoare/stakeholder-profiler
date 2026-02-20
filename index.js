require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are an expert intelligence analyst producing Vodafone-style stakeholder profiles.
Given a person's name, job title, organisation, and web research, return ONLY valid JSON (no markdown, no preamble):
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

app.get("/api/profile", async (req, res) => {
  const { name, role, company } = req.query;

  if (!name) {
    return res.status(400).json({ error: "Name is required" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (res.flush) res.flush();
  };

  // Ping every 15s to keep the connection alive through Railway's proxy
  const keepalive = setInterval(() => {
    res.write(": keepalive\n\n");
    if (res.flush) res.flush();
  }, 15000);

  const done = () => {
    clearInterval(keepalive);
    res.end();
  };

  try {
    send("status", { message: "Searching web for public information…" });

    let research = "";
    try {
      const searchRes = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 3000,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{
          role: "user",
          content: `Search for comprehensive public information about ${name}${role ? `, ${role}` : ""}${company ? ` at ${company}` : ""}. Find: career history, biographical details, speeches, events, publications, LinkedIn profile, awards, news coverage. Include all source URLs.`
        }]
      });

      const texts = (searchRes.content || [])
        .filter(b => b.type === "text")
        .map(b => b.text);
      if (texts.length) research = texts.join("\n");
    } catch (e) {
      send("status", { message: "Web search unavailable — using training knowledge…" });
    }

    send("status", { message: "Analysing and building profile…" });

    const profileRes = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 5000,
      system: SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: `Build a stakeholder profile for:
Name: ${name}
Job Title: ${role || "Unknown"}
Organisation: ${company || "Unknown"}

Web research findings:
${research || "No web research available — use your training knowledge. Note confidence level honestly."}

Extract all URLs from the research for the sources array. Be specific and grounded.`
      }]
    });

    const txt = profileRes.content?.[0]?.text || "";
    let parsed;
    try {
      parsed = JSON.parse(txt.replace(/```json\n?|```/g, "").trim());
      if (!parsed.sources?.length && research) {
        parsed.sources = parseUrls(research);
      }
    } catch {
      send("error", { message: "Failed to parse profile output" });
      done();
      return;
    }

    send("done", { profile: parsed });
  } catch (e) {
    send("error", { message: e.message || "Unknown error" });
  }

  done();
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

app.listen(PORT, () => {
  console.log(`\n✅ Stakeholder Profiler running at http://localhost:${PORT}\n`);
});
