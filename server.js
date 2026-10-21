const express = require("express");
const cors = require("cors");
const path = require("path");
const Database = require("better-sqlite3");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const cron = require("node-cron");
const bcrypt = require("bcryptjs");
const session = require("express-session");

// ============================================================
// CONFIG
// ============================================================
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "AQ.Ab8RN6KkVX6OXHvnvwhEaTQNdW1K9W7yL5Su9EU3vYJHCzcIWQ";
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || "interview-ready-secret-2026";

// ============================================================
// DATABASE
// ============================================================
const db = new Database("interview_ready.db");
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS daily_content (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT UNIQUE NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    cv TEXT DEFAULT '',
    strengths TEXT DEFAULT '',
    weaknesses TEXT DEFAULT '',
    target_companies TEXT DEFAULT '',
    target_roles TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS progress (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    card_key TEXT NOT NULL,
    UNIQUE(user_id, date, card_key)
  );
  CREATE TABLE IF NOT EXISTS stories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    situation TEXT DEFAULT '',
    task TEXT DEFAULT '',
    action TEXT DEFAULT '',
    result TEXT DEFAULT '',
    tags TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS streaks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER UNIQUE NOT NULL,
    current_streak INTEGER DEFAULT 0,
    longest_streak INTEGER DEFAULT 0,
    last_active_date TEXT DEFAULT ''
  );
`);

// ============================================================
// GEMINI
// ============================================================
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-3.8-flash" });

const DAILY_PROMPT = `You are an MBA interview preparation coach for Indian B-school students preparing for campus placements.

Generate today's complete prep package. Be specific, use real recent trends and data points. Each section must cover a DIFFERENT topic.

Return ONLY a valid JSON object (no markdown, no backticks) with these keys:

{
  "newsBite": {
    "headline": "Compelling headline about one business/economic topic",
    "summary": "150-200 word summary with numbers, company names, Indian business context.",
    "interviewFrame": "3-sentence answer frame for interviews.",
    "category": "One of: Economy, Markets, Technology, FMCG, Banking, Startups, Policy, Global"
  },
  "hrQuestion": {
    "question": "A behavioral HR question for MBA placements",
    "whyAsked": "What the interviewer is testing",
    "starTemplate": {
      "situation": "Prompt for a relevant situation",
      "task": "Your specific responsibility",
      "action": "Steps YOU took",
      "result": "Quantified outcome"
    },
    "sampleOpener": "Strong opening line"
  },
  "guesstimate": {
    "question": "Market sizing question for Indian markets",
    "difficulty": "Easy, Mid, or Tough",
    "approach": ["Step 1","Step 2","Step 3","Step 4"],
    "ballpark": "Rough answer with reasoning"
  },
  "gdTopic": {
    "topic": "Current debatable GD topic",
    "context": "Why this matters now",
    "pointsFor": ["Point 1","Point 2","Point 3"],
    "pointsAgainst": ["Point 1","Point 2","Point 3"],
    "tip": "GD strategy tip"
  },
  "companySpotlight": {
    "name": "Company that recruits MBAs in India",
    "industry": "Sector",
    "brief": "100-word overview with recent news",
    "roles": "Typical MBA roles",
    "likelyQuestion": "Interview question for this company"
  }
}`;

async function getDailyContent() {
  const today = new Date().toISOString().split("T")[0];
  const cached = db.prepare("SELECT content FROM daily_content WHERE date = ?").get(today);
  if (cached) return JSON.parse(cached.content);

  console.log("Generating today's content from Gemini...");
  try {
    const result = await model.generateContent(DAILY_PROMPT);
    const text = result.response.text();
    const cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const content = JSON.parse(cleaned);
    db.prepare("INSERT OR REPLACE INTO daily_content (date, content) VALUES (?, ?)").run(today, JSON.stringify(content));
    console.log("Content generated and cached for", today);
    return content;
  } catch (err) {
    console.error("Gemini API error:", err.message);
    return { newsBite:{headline:"Content loading...",summary:"Please refresh in a moment.",interviewFrame:"Refresh shortly.",category:"System"}, hrQuestion:{question:"Tell me about a time you adapted to change.",whyAsked:"Tests adaptability.",starTemplate:{situation:"Think of a sudden change",task:"Your responsibility",action:"Steps you took",result:"Outcome with numbers"},sampleOpener:"During my internship..."}, guesstimate:{question:"How many coffee shops are in Bangalore?",difficulty:"Mid",approach:["Population ~13M","Working professionals ~4M","1 shop per 500 in commercial areas","~3000-4000 shops"],ballpark:"Around 3,500"}, gdTopic:{topic:"Should MBA education go fully online?",context:"Post-pandemic hybrid learning debate.",pointsFor:["Accessible","Lower costs","Flexible"],pointsAgainst:["Networking needs in-person","Case discussions suffer","Recruiters prefer campus"],tip:"Argue for hybrid."}, companySpotlight:{name:"Marico",industry:"FMCG",brief:"Maker of Parachute, Saffola. Revenue ~10,000 crore.",roles:"Marketing, Sales, Supply Chain",likelyQuestion:"How would you reposition Saffola for Gen Z?"} };
  }
}

// CRON
cron.schedule("0 6 * * *", async () => {
  console.log("[CRON] 6 AM — Generating content...");
  try { await getDailyContent(); } catch(e) { console.error("[CRON]", e.message); }
});
console.log("Scheduled: Daily content generation at 6:00 AM");

// ============================================================
// STREAK HELPER
// ============================================================
function updateStreak(userId) {
  const today = new Date().toISOString().split("T")[0];
  const s = db.prepare("SELECT * FROM streaks WHERE user_id = ?").get(userId);
  if (!s) { db.prepare("INSERT INTO streaks (user_id,current_streak,longest_streak,last_active_date) VALUES (?,1,1,?)").run(userId,today); return 1; }
  if (s.last_active_date === today) return s.current_streak;
  const diff = Math.floor((new Date(today) - new Date(s.last_active_date)) / 86400000);
  const ns = diff === 1 ? s.current_streak + 1 : 1;
  const lg = Math.max(ns, s.longest_streak);
  db.prepare("UPDATE streaks SET current_streak=?,longest_streak=?,last_active_date=? WHERE user_id=?").run(ns,lg,today,userId);
  return ns;
}

// ============================================================
// EXPRESS
// ============================================================
const app = express();
app.use(cors({ credentials: true }));
app.use(express.json());
app.use(session({ secret: SESSION_SECRET, resave: false, saveUninitialized: false, cookie: { maxAge: 30*24*60*60*1000 } }));
app.use(express.static(path.join(__dirname, "public")));

// -- AUTH --
app.post("/api/signup", (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.json({ success:false, error:"All fields required" });
  if (password.length < 4) return res.json({ success:false, error:"Password too short" });
  const exists = db.prepare("SELECT id FROM users WHERE email=?").get(email.toLowerCase());
  if (exists) return res.json({ success:false, error:"Email already registered" });
  const hash = bcrypt.hashSync(password, 10);
  const r = db.prepare("INSERT INTO users (name,email,password) VALUES (?,?,?)").run(name.trim(), email.toLowerCase().trim(), hash);
  req.session.userId = r.lastInsertRowid;
  res.json({ success:true, user:{ id:r.lastInsertRowid, name:name.trim(), email:email.toLowerCase() } });
});

app.post("/api/login", (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.json({ success:false, error:"Email and password required" });
  const user = db.prepare("SELECT * FROM users WHERE email=?").get(email.toLowerCase().trim());
  if (!user) return res.json({ success:false, error:"No account with this email" });
  if (!bcrypt.compareSync(password, user.password)) return res.json({ success:false, error:"Wrong password" });
  req.session.userId = user.id;
  res.json({ success:true, user:{ id:user.id, name:user.name, email:user.email } });
});

app.post("/api/logout", (req, res) => { req.session.destroy(); res.json({ success:true }); });

app.get("/api/me", (req, res) => {
  if (!req.session.userId) return res.json({ loggedIn:false });
  const user = db.prepare("SELECT id,name,email,cv,strengths,weaknesses,target_companies,target_roles FROM users WHERE id=?").get(req.session.userId);
  const streak = db.prepare("SELECT current_streak,longest_streak FROM streaks WHERE user_id=?").get(req.session.userId);
  res.json({ loggedIn:true, user, streak: streak || {current_streak:0,longest_streak:0} });
});

// -- PROFILE --
app.put("/api/profile", (req, res) => {
  if (!req.session.userId) return res.status(401).json({ success:false });
  const { cv,strengths,weaknesses,target_companies,target_roles } = req.body;
  db.prepare("UPDATE users SET cv=?,strengths=?,weaknesses=?,target_companies=?,target_roles=? WHERE id=?").run(cv||'',strengths||'',weaknesses||'',target_companies||'',target_roles||'',req.session.userId);
  res.json({ success:true });
});

// -- PROGRESS --
app.get("/api/progress", (req, res) => {
  if (!req.session.userId) return res.json({ progress:{} });
  const today = new Date().toISOString().split("T")[0];
  const rows = db.prepare("SELECT card_key FROM progress WHERE user_id=? AND date=?").all(req.session.userId, today);
  const p = {}; rows.forEach(r => p[r.card_key] = true);
  res.json({ progress:p });
});

app.post("/api/progress", (req, res) => {
  if (!req.session.userId) return res.status(401).json({ success:false });
  const { card_key, completed } = req.body;
  const today = new Date().toISOString().split("T")[0];
  if (completed) {
    db.prepare("INSERT OR REPLACE INTO progress (user_id,date,card_key) VALUES (?,?,?)").run(req.session.userId,today,card_key);
    const streak = updateStreak(req.session.userId);
    res.json({ success:true, streak });
  } else {
    db.prepare("DELETE FROM progress WHERE user_id=? AND date=? AND card_key=?").run(req.session.userId,today,card_key);
    res.json({ success:true });
  }
});

// -- STORIES --
app.get("/api/stories", (req, res) => {
  if (!req.session.userId) return res.status(401).json({ success:false });
  const stories = db.prepare("SELECT * FROM stories WHERE user_id=? ORDER BY created_at DESC").all(req.session.userId);
  res.json({ stories });
});

app.post("/api/stories", (req, res) => {
  if (!req.session.userId) return res.status(401).json({ success:false });
  const { title,situation,task,action,result,tags } = req.body;
  if (!title) return res.json({ success:false, error:"Title required" });
  const r = db.prepare("INSERT INTO stories (user_id,title,situation,task,action,result,tags) VALUES (?,?,?,?,?,?,?)").run(req.session.userId,title,situation||'',task||'',action||'',result||'',tags||'');
  res.json({ success:true, id:r.lastInsertRowid });
});

app.delete("/api/stories/:id", (req, res) => {
  if (!req.session.userId) return res.status(401).json({ success:false });
  db.prepare("DELETE FROM stories WHERE id=? AND user_id=?").run(req.params.id, req.session.userId);
  res.json({ success:true });
});

// -- CONTENT --
app.get("/api/today", async (req, res) => {
  try { const c = await getDailyContent(); res.json({ success:true, date:new Date().toISOString().split("T")[0], data:c }); }
  catch(e) { res.status(500).json({ success:false, error:"Failed" }); }
});

app.post("/api/regenerate", async (req, res) => {
  const today = new Date().toISOString().split("T")[0];
  db.prepare("DELETE FROM daily_content WHERE date=?").run(today);
  try { const c = await getDailyContent(); res.json({ success:true, data:c }); }
  catch(e) { res.status(500).json({ success:false, error:e.message }); }
});

app.get("/", (req, res) => { res.sendFile(path.join(__dirname, "public", "index.html")); });

app.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(`  InterviewReady is running!`);
  console.log(`  Open http://localhost:${PORT} in your browser`);
  console.log(`========================================\n`);
});
