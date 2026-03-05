const express = require("express");
const cors = require("cors");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── SYSTEM PROMPT ────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are an expert intelligence analyst producing detailed stakeholder profiles.
You will be given research compiled from multiple targeted searches. Use it thoroughly.
Return ONLY valid JSON (no markdown, no preamble):
{
  "name": "Full name with honours",
  "role": "Current job title",
  "organisation": "Organisation",
  "nationality": "Nationality",
  "positionSince": "Month Year - Present",
  "confidence": "high|medium|low",
  "confidenceNote": "One sentence",
  "background": "4-5 sentence narrative paragraph — be specific, use real details from the research",
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
Be specific and grounded. Use real names, dates, organisations from the research. Use null for unknowns. Never fabricate.`;

// ── HELPERS ───────────────────────────────────────────────────────────────────
function parseUrls(text) {
  const seen = new Set();
  return (text.match(/https?:\/\/[^\s\)"',<>]+/g) || [])
    .filter(u => { if (seen.has(u)) return false; seen.add(u); return true; })
    .slice(0, 30);
}

async function withRetry(fn, retries = 4) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      const isRetryable = e?.status === 529 || e?.status === 429 ||
                          e?.message?.includes("overloaded") || e?.message?.includes("rate_limit");
      if (isRetryable && i < retries - 1) {
        const delay = 65000;
        console.log(`Rate limited, waiting ${delay/1000}s (attempt ${i + 1}/${retries})`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw e;
      }
    }
  }
}

// ── GEMINI SEARCH ─────────────────────────────────────────────────────────────
async function geminiSearch(genAI, query) {
  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-pro",
      tools: [{ googleSearch: {} }],
    });

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: query }] }],
      generationConfig: { maxOutputTokens: 3000 },
    });

    const response = result.response;
    const text = response.text();

    // Extract grounding sources if available
    const groundingMetadata = response.candidates?.[0]?.groundingMetadata;
    const sources = groundingMetadata?.groundingChunks
      ?.map(chunk => chunk.web?.uri)
      .filter(Boolean) || [];

    return { text, sources };
  } catch (e) {
    console.error(`Gemini search failed for query "${query}":`, e.message);
    return { text: "", sources: [] };
  }
}

// ── PARALLEL RESEARCH ─────────────────────────────────────────────────────────
async function runParallelResearch(genAI, name, role, company) {
  const subject = [name, role, company].filter(Boolean).join(", ");

  const queries = [
    // Career & background
    `Detailed career history and professional background of ${subject}. Include previous roles, organisations, career progression and notable achievements.`,

    // Recent activity & news
    `Recent news, announcements, interviews, and public activity by ${subject} in the last 2 years. Include any speeches, press coverage, or notable statements.`,

    // Professional interests & priorities
    `Professional priorities, strategic interests, and areas of focus for ${subject}. What topics do they speak about publicly? What initiatives are they driving?`,

    // Org structure & influence
    `Organisational structure around ${subject}. Who do they report to? Who are their direct reports or close peers? What is their sphere of influence?`,

    // Personal & social
    `LinkedIn profile, social media presence, and personal interests of ${subject}. Any published articles, podcasts, or public writing.`,
  ];

  console.log(`Running ${queries.length} parallel Gemini searches for: ${name}`);

  const results = await Promise.allSettled(
    queries.map(q => geminiSearch(genAI, q))
  );

  const sections = [
    "CAREER & BACKGROUND",
    "RECENT ACTIVITY & NEWS",
    "PROFESSIONAL INTERESTS & PRIORITIES",
    "ORG STRUCTURE & SPHERE OF INFLUENCE",
    "SOCIAL & PERSONAL",
  ];

  let combinedResearch = "";
  const allSources = new Set();

  results.forEach((result, i) => {
    if (result.status === "fulfilled" && result.value.text) {
      combinedResearch += `\n\n## ${sections[i]}\n${result.value.text}`;
      result.value.sources.forEach(s => allSources.add(s));
    }
  });

  // Also extract any URLs mentioned in the text
  parseUrls(combinedResearch).forEach(u => allSources.add(u));

  console.log(`Research complete. Total length: ${combinedResearch.length} chars, Sources: ${allSources.size}`);

  return {
    research: combinedResearch.slice(0, 12000), // generous cap
    sources: [...allSources].slice(0, 30)
  };
}

// ── ROUTE ──────────────────────────────────────────────────────────────────────
app.post("/api/profile", async (req, res) => {
  const { name, role, company } = req.body;
  if (!name) return res.status(400).json({ error: "Name is required" });

  req.setTimeout(360000);
  res.setTimeout(360000);

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;

  if (!anthropicKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });
  if (!geminiKey) return res.status(500).json({ error: "GEMINI_API_KEY not set" });

  const anthropic = new Anthropic({ apiKey: anthropicKey });
  const genAI = new GoogleGenerativeAI(geminiKey);

  try {
    // ── Step 1: Parallel Gemini research ──
    let research = "";
    let sources = [];

    try {
      const result = await runParallelResearch(genAI, name, role, company);
      research = result.research;
      sources = result.sources;
    } catch (e) {
      console.error("Gemini research failed:", e.message, "— falling back to Claude search");

      // Fallback: Claude web search
      try {
        const searchRes = await withRetry(() => anthropic.messages.create({
          model: "claude-sonnet-4-20250514",
          max_tokens: 3000,
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          messages: [{
            role: "user",
            content: `Search thoroughly for: ${name}${role ? `, ${role}` : ""}${company ? ` at ${company}` : ""}. 
Find career history, background, recent news, professional interests, org structure, and social presence.`
          }]
        }));
        const texts = (searchRes.content || []).filter(b => b.type === "text").map(b => b.text);
        if (texts.length) research = texts.join("\n").slice(0, 8000);
        sources = parseUrls(research);
      } catch (e2) {
        console.log("Fallback search also failed:", e2.message, "— using training knowledge only");
      }
    }

    // ── Step 2: Claude Sonnet builds the profile ──
    console.log("Building profile with Claude Sonnet...");

    const profileRes = await withRetry(() => anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 6000,
      system: SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: `Build a detailed stakeholder intelligence profile for:

Name: ${name}
Job Title: ${role || "Unknown"}
Organisation: ${company || "Unknown"}

Research compiled from multiple targeted searches:
${research || "No research available. Use training knowledge and be honest about confidence level."}

Sources found: ${sources.join(", ") || "none"}

Use the research thoroughly. Extract specific facts, dates, names, and quotes where available. Do not pad with generics.`
      }]
    }));

    const txt = profileRes.content?.[0]?.text || "";
    let parsed;
    try {
      parsed = JSON.parse(txt.replace(/```json\n?|```/g, "").trim());
      // Merge in any sources we found that the model may have missed
      if (sources.length) {
        const existing = new Set(parsed.sources || []);
        sources.forEach(s => existing.add(s));
        parsed.sources = [...existing].slice(0, 30);
      }
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
server.timeout = 360000;
server.requestTimeout = 360000;
server.headersTimeout = 370000;
