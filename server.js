const express = require("express");
const cors = require("cors");
const path = require("path");
const Database = require("better-sqlite3");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const cron = require("node-cron");

// ============================================================
// CONFIG
// ============================================================
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "PASTE_YOUR_GEMINI_API_KEY_HERE";
const PORT = process.env.PORT || 3000;

// ============================================================
// DATABASE SETUP
// ============================================================
const db = new Database("interview_ready.db");
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS daily_content (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT UNIQUE NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

// ============================================================
// GEMINI AI SETUP
// ============================================================
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-3.8-flash" });

const DAILY_PROMPT = `You are an MBA interview preparation coach for Indian B-school students preparing for campus placements.

Generate today's complete prep package. Be specific, use real recent trends and data points you know about. Make sure each section covers a DIFFERENT topic — do not repeat the same company or theme across sections.

Return ONLY a valid JSON object (no markdown, no backticks, no explanation) with these exact keys:

{
  "newsBite": {
    "headline": "A compelling headline about one important business/economic topic",
    "summary": "A 150-200 word summary explaining the topic clearly. Include numbers, company names, and specifics. Make it relevant to Indian business context.",
    "interviewFrame": "A 3-sentence answer frame: how to respond if an interviewer asks about this topic. Start with context, add your analysis, end with implications.",
    "category": "One of: Economy, Markets, Technology, FMCG, Banking, Startups, Policy, Global"
  },
  "hrQuestion": {
    "question": "A behavioral HR question commonly asked in MBA campus placements",
    "whyAsked": "One sentence on what the interviewer is really testing",
    "starTemplate": {
      "situation": "Prompt to help them think of a relevant situation",
      "task": "What was your specific responsibility",
      "action": "What steps did YOU take (not the team)",
      "result": "Quantify the outcome — use numbers"
    },
    "sampleOpener": "A strong opening line to start the answer"
  },
  "guesstimate": {
    "question": "A market sizing or estimation question relevant to Indian markets",
    "difficulty": "One of: Easy, Mid, Tough",
    "approach": [
      "Step 1 of solving this",
      "Step 2",
      "Step 3",
      "Step 4"
    ],
    "ballpark": "The rough final answer with reasoning"
  },
  "gdTopic": {
    "topic": "A current, debatable topic suitable for MBA group discussions",
    "context": "One sentence of context about why this topic matters now",
    "pointsFor": [
      "First argument in favor",
      "Second argument in favor",
      "Third argument in favor"
    ],
    "pointsAgainst": [
      "First argument against",
      "Second argument against",
      "Third argument against"
    ],
    "tip": "A short GD strategy tip for this topic"
  },
  "companySpotlight": {
    "name": "Name of a company that actively recruits from MBA campuses in India",
    "industry": "The company's sector",
    "brief": "100-word overview — what the company does, its recent performance or news, why it's interesting for MBA graduates",
    "roles": "What roles it typically hires MBAs for",
    "likelyQuestion": "One interview question this company is known to ask or that's relevant to their business"
  }
}`;

// ============================================================
// GENERATE OR FETCH DAILY CONTENT
// ============================================================
async function getDailyContent() {
  const today = new Date().toISOString().split("T")[0];

  const cached = db.prepare("SELECT content FROM daily_content WHERE date = ?").get(today);
  if (cached) {
    return JSON.parse(cached.content);
  }

  console.log("Generating today's content from Gemini...");
  try {
    const result = await model.generateContent(DAILY_PROMPT);
    const text = result.response.text();
    const cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const content = JSON.parse(cleaned);

    db.prepare("INSERT OR REPLACE INTO daily_content (date, content) VALUES (?, ?)").run(
      today,
      JSON.stringify(content)
    );

    console.log("Content generated and cached for", today);
    return content;
  } catch (err) {
    console.error("Gemini API error:", err.message);
    return {
      newsBite: {
        headline: "Content generation in progress",
        summary: "Today's content is being prepared. Please refresh in a minute.",
        interviewFrame: "Please refresh the page shortly.",
        category: "System"
      },
      hrQuestion: {
        question: "Tell me about a time you had to adapt quickly to a major change.",
        whyAsked: "Tests adaptability and resilience under pressure.",
        starTemplate: {
          situation: "Think of when plans changed suddenly",
          task: "What was expected of you despite the change",
          action: "How did you adjust your approach",
          result: "What was the outcome — use a number"
        },
        sampleOpener: "During my internship, the product roadmap shifted entirely two weeks in..."
      },
      guesstimate: {
        question: "How many haircuts happen in Delhi every day?",
        difficulty: "Mid",
        approach: ["Delhi population: ~20 million", "50% male with cuts every 3-4 weeks = ~350K/day", "50% female with cuts every 3-4 months = ~100K/day", "Add children and grooming services"],
        ballpark: "Approximately 400,000-500,000 haircuts per day"
      },
      gdTopic: {
        topic: "Should India prioritize manufacturing over services?",
        context: "The PLI scheme is pushing Make in India, but services remain India's strength.",
        pointsFor: ["Manufacturing creates mass employment", "Reduces import dependence", "China+1 opportunity"],
        pointsAgainst: ["India's edge is in IT/services", "Manufacturing needs infrastructure India lacks", "Automation reduces factory jobs"],
        tip: "Argue for a balanced approach with sector-specific priorities."
      },
      companySpotlight: {
        name: "Asian Paints",
        industry: "Consumer Goods",
        brief: "India's largest paint company with ~55% market share and ₹35,000+ crore revenue. Expanding into home decor services.",
        roles: "Sales, Marketing, Supply Chain, Finance",
        likelyQuestion: "How would you convince a small-town dealer to switch to Asian Paints?"
      }
    };
  }
}

// ============================================================
// CRON: Auto-generate content at 6:00 AM daily
// ============================================================
cron.schedule("0 6 * * *", async () => {
  console.log("\n[CRON] 6:00 AM — Generating today's content...");
  try {
    await getDailyContent();
    console.log("[CRON] Content ready for today!");
  } catch (err) {
    console.error("[CRON] Failed:", err.message);
  }
});

console.log("Scheduled: Daily content generation at 6:00 AM");

// ============================================================
// EXPRESS SERVER
// ============================================================
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/today", async (req, res) => {
  try {
    const content = await getDailyContent();
    res.json({ success: true, date: new Date().toISOString().split("T")[0], data: content });
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to load content" });
  }
});

app.post("/api/regenerate", async (req, res) => {
  const today = new Date().toISOString().split("T")[0];
  db.prepare("DELETE FROM daily_content WHERE date = ?").run(today);
  try {
    const content = await getDailyContent();
    res.json({ success: true, data: content });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/history", (req, res) => {
  const rows = db.prepare("SELECT date FROM daily_content ORDER BY date DESC LIMIT 30").all();
  res.json({ dates: rows.map(r => r.date) });
});

app.get("/api/day/:date", (req, res) => {
  const row = db.prepare("SELECT content FROM daily_content WHERE date = ?").get(req.params.date);
  if (row) {
    res.json({ success: true, date: req.params.date, data: JSON.parse(row.content) });
  } else {
    res.json({ success: false, error: "No content for this date" });
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(`  InterviewReady is running!`);
  console.log(`  Open http://localhost:${PORT} in your browser`);
  console.log(`========================================\n`);
});
