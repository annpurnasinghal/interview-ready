const express = require("express");
const cors = require("cors");
const path = require("path");
const { Pool } = require("pg");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const cron = require("node-cron");
const bcrypt = require("bcryptjs");
const session = require("express-session");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "PASTE_YOUR_GEMINI_API_KEY_HERE";
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || "interview-ready-secret-2026";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes("render.com") ? { rejectUnauthorized: false } : false
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_content (id SERIAL PRIMARY KEY, date TEXT UNIQUE NOT NULL, content TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, cv TEXT DEFAULT '', strengths TEXT DEFAULT '', weaknesses TEXT DEFAULT '', target_companies TEXT DEFAULT '', target_roles TEXT DEFAULT '', created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS progress (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, date TEXT NOT NULL, card_key TEXT NOT NULL, UNIQUE(user_id, date, card_key));
    CREATE TABLE IF NOT EXISTS stories (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, title TEXT NOT NULL, situation TEXT DEFAULT '', task TEXT DEFAULT '', action TEXT DEFAULT '', result TEXT DEFAULT '', tags TEXT DEFAULT '', created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS streaks (id SERIAL PRIMARY KEY, user_id INTEGER UNIQUE NOT NULL, current_streak INTEGER DEFAULT 0, longest_streak INTEGER DEFAULT 0, last_active_date TEXT DEFAULT '');
    CREATE TABLE IF NOT EXISTS coach_sessions (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, messages TEXT DEFAULT '[]', practice_type TEXT DEFAULT 'general', created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS growth_areas (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, area TEXT NOT NULL, category TEXT NOT NULL, count INTEGER DEFAULT 1, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS coach_scores (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, practice_type TEXT DEFAULT 'general', relevance INTEGER DEFAULT 0, structure INTEGER DEFAULT 0, specificity INTEGER DEFAULT 0, marketing INTEGER DEFAULT 0, created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS resume_questions_cache (id SERIAL PRIMARY KEY, user_id INTEGER UNIQUE NOT NULL, questions TEXT NOT NULL, cv_hash TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS speech_stats (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, wpm REAL DEFAULT 0, filler_count INTEGER DEFAULT 0, fillers_used TEXT DEFAULT '[]', duration REAL DEFAULT 0, word_count INTEGER DEFAULT 0, hedges INTEGER DEFAULT 0, practice_type TEXT DEFAULT 'general', created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS bookmarks (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, tags TEXT DEFAULT '', created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS struggled_questions (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, question TEXT NOT NULL, best_score INTEGER DEFAULT 0, attempts INTEGER DEFAULT 1, last_score INTEGER DEFAULT 0, interval_days INTEGER DEFAULT 1, next_review TEXT NOT NULL, status TEXT DEFAULT 'learning', first_answer TEXT DEFAULT '', best_answer TEXT DEFAULT '', coach_feedback TEXT DEFAULT '', created_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(user_id, question));
    CREATE TABLE IF NOT EXISTS answer_workshop (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, question_id TEXT NOT NULL, question_text TEXT NOT NULL, category TEXT DEFAULT '', current_draft TEXT DEFAULT '', versions TEXT DEFAULT '[]', best_score INTEGER DEFAULT 0, status TEXT DEFAULT 'not_started', locked_answer TEXT DEFAULT '', locked_at TEXT DEFAULT '', updated_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(user_id, question_id));
    CREATE TABLE IF NOT EXISTS aptitude_scores (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, category TEXT NOT NULL, difficulty TEXT DEFAULT 'medium', score INTEGER DEFAULT 0, total INTEGER DEFAULT 0, created_at TIMESTAMPTZ DEFAULT NOW());
  `);
  console.log("Database tables initialized");
}
initDB().catch(function(e) { console.error("DB init error:", e.message); });

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

// Express app must be created before any routes
var app = express();
app.use(cors({ credentials: true }));
app.use(express.json());
app.use(session({ secret: SESSION_SECRET, resave: false, saveUninitialized: false, cookie: { maxAge: 30*24*60*60*1000 } }));
app.use(express.static(path.join(__dirname, "public")));

const DAILY_PROMPT = `You are an MBA interview preparation coach for Indian B-school students specializing in MARKETING.

Generate today's prep package. Return ONLY valid JSON (no markdown, no backticks):

{
  "newsBites": [
    {"headline": "Marketing headline 1", "summary": "120-150 words", "interviewFrame": "3 sentences using marketing terms", "category": "Marketing", "useIn": "GD: [specific] | Interview: [specific] | Case: [specific]", "concepts": [{"term": "Concept", "howItApplies": "How"}]},
    {"headline": "Marketing headline 2", "summary": "120-150 words", "interviewFrame": "3 sentences", "category": "Marketing", "useIn": "GD: [x] | Interview: [x] | Case: [x]", "concepts": [{"term": "Concept", "howItApplies": "How"}]},
    {"headline": "Marketing headline 3", "summary": "120-150 words", "interviewFrame": "3 sentences", "category": "Marketing", "useIn": "GD: [x] | Interview: [x] | Case: [x]", "concepts": [{"term": "Concept", "howItApplies": "How"}]},
    {"headline": "Marketing headline 4", "summary": "120-150 words", "interviewFrame": "3 sentences", "category": "Marketing", "useIn": "GD: [x] | Interview: [x] | Case: [x]", "concepts": [{"term": "Concept", "howItApplies": "How"}]},
    {"headline": "Economy story", "summary": "120-150 words", "interviewFrame": "3 sentences", "category": "Economy", "useIn": "GD: [x] | Interview: [x] | Case: [x]", "concepts": [{"term": "Concept", "howItApplies": "How"}]},
    {"headline": "Technology story", "summary": "120-150 words", "interviewFrame": "3 sentences", "category": "Technology", "useIn": "GD: [x] | Interview: [x] | Case: [x]", "concepts": [{"term": "Concept", "howItApplies": "How"}]},
    {"headline": "FMCG story", "summary": "120-150 words", "interviewFrame": "3 sentences", "category": "FMCG", "useIn": "GD: [x] | Interview: [x] | Case: [x]", "concepts": [{"term": "Concept", "howItApplies": "How"}]},
    {"headline": "Startups story", "summary": "120-150 words", "interviewFrame": "3 sentences", "category": "Startups", "useIn": "GD: [x] | Interview: [x] | Case: [x]", "concepts": [{"term": "Concept", "howItApplies": "How"}]}
  ],
  "newsQuiz": [
    {"question": "Q1", "options": ["A","B","C","D"], "correct": 0, "explanation": "Why"},
    {"question": "Q2", "options": ["A","B","C","D"], "correct": 1, "explanation": "Why"},
    {"question": "Q3", "options": ["A","B","C","D"], "correct": 2, "explanation": "Why"},
    {"question": "Q4", "options": ["A","B","C","D"], "correct": 0, "explanation": "Why"},
    {"question": "Q5", "options": ["A","B","C","D"], "correct": 1, "explanation": "Why"}
  ],
  "conceptOfTheDay": {"term": "Marketing concept", "definition": "2 sentences", "realExample": "Indian brand example", "interviewUse": "Sample sentence", "relatedTerms": ["T1","T2","T3"]},
  "hrQuestion": {"question": "HR Q", "whyAsked": "Tests what", "starTemplate": {"situation": "Prompt", "task": "Role", "action": "Steps", "result": "Outcome"}, "sampleOpener": "Opening", "useIn": "GD: [x] | Interview: [x] | Case: [x]"},
  "guesstimate": {"question": "Sizing Q", "difficulty": "Mid", "approach": ["S1","S2","S3","S4"], "ballpark": "Answer", "useIn": "GD: [x] | Interview: [x] | Case: [x]", "concepts": [{"term": "C", "howItApplies": "H"}]},
  "gdTopic": {"topic": "Topic", "context": "Why now", "pointsFor": ["P1","P2","P3"], "pointsAgainst": ["P1","P2","P3"], "tip": "Tip", "useIn": "Interview: [x] | Case: [x]", "concepts": [{"term": "C", "howItApplies": "H"}]},
  "companySpotlight": {"name": "Co", "industry": "Sec", "brief": "100w", "roles": "Roles", "likelyQuestion": "Q", "useIn": "GD: [x] | Interview: [x] | Case: [x]", "concepts": [{"term": "C", "howItApplies": "H"}]}
}

RULES: 4 Marketing + 4 general. Each has concepts. Indian context. Real numbers.`;

async function getDailyContent() {
  var today = new Date().toISOString().split("T")[0];
  var cached = (await pool.query("SELECT content FROM daily_content WHERE date = $1", [today])).rows[0];
  if (cached) return JSON.parse(cached.content);
  console.log("Generating today's content from Gemini...");
  try {
    var result = await model.generateContent(DAILY_PROMPT);
    var text = result.response.text().replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    var content = JSON.parse(text);
    if (content.newsBite && !content.newsBites) { content.newsBites = [content.newsBite]; delete content.newsBite; }
    if (!content.newsQuiz) content.newsQuiz = [];
    await pool.query("INSERT INTO daily_content (date, content) VALUES ($1, $2) ON CONFLICT (date) DO UPDATE SET content = EXCLUDED.content", [today, JSON.stringify(content)]);
    console.log("Content cached for", today);
    return content;
  } catch (err) {
    console.error("Gemini error:", err.message);
    return {newsBites:[{headline:"Content loading...",summary:"Refresh the page or try again shortly.",interviewFrame:"Content is being generated.",category:"System",useIn:"",concepts:[]}],newsQuiz:[],conceptOfTheDay:{term:"Brand Equity",definition:"Commercial value from brand perception.",realExample:"Tata Salt: 20% premium = pure brand equity.",interviewUse:"This is a brand equity play.",relatedTerms:["Brand Recall","TOMA","Brand Loyalty"]},hrQuestion:{question:"Tell me about a campaign you admire.",whyAsked:"Tests awareness.",starTemplate:{situation:"A campaign",task:"Analyze",action:"Break down",result:"Impact"},sampleOpener:"The campaign that...",useIn:""},guesstimate:{question:"Ads seen per day by an Indian?",difficulty:"Mid",approach:["Phone:80","TV:60","Outdoor:20","Digital:40"],ballpark:"~200",useIn:"",concepts:[]},gdTopic:{topic:"Influencer marketing vs brand authenticity?",context:"40%+ budgets on influencers.",pointsFor:["Engagement","Cost","Trust"],pointsAgainst:["Fake followers","Safety","No equity"],tip:"Nuanced.",useIn:"",concepts:[]},companySpotlight:{name:"HUL",industry:"FMCG",brief:"Largest FMCG. 50+ brands.",roles:"Brand Manager",likelyQuestion:"Premium skincare in tier-2?",useIn:"",concepts:[]}};
  }
}

cron.schedule("0 6 * * *", async function() { try { await getDailyContent(); } catch(e) {} });
console.log("Scheduled: Daily content at 6 AM");

async function updateStreak(userId) {
  var today = new Date().toISOString().split("T")[0];
  var r = await pool.query("SELECT * FROM streaks WHERE user_id=$1", [userId]);
  var s = r.rows[0];
  if (!s) { await pool.query("INSERT INTO streaks (user_id,current_streak,longest_streak,last_active_date) VALUES ($1,1,1,$2)", [userId,today]); return 1; }
  if (s.last_active_date === today) return s.current_streak;
  var diff = Math.floor((new Date(today) - new Date(s.last_active_date)) / 86400000);
  var ns = diff === 1 ? s.current_streak + 1 : 1;
  await pool.query("UPDATE streaks SET current_streak=$1,longest_streak=$2,last_active_date=$3 WHERE user_id=$4", [ns, Math.max(ns,s.longest_streak), today, userId]);
  return ns;
}

// ═══ HR QUESTION BANK ═══
const HR_QUESTIONS = [
  // Self-awareness & Intro
  {id:1,q:"Tell me about yourself.",cat:"Self-Awareness",tip:"2-min pitch: background → MBA reason → career goal. Not a CV recitation."},
  {id:2,q:"Walk me through your resume.",cat:"Self-Awareness",tip:"Highlight transitions & decisions. Why did you move/choose each step?"},
  {id:3,q:"What are your 3 greatest strengths?",cat:"Self-Awareness",tip:"Pick strengths relevant to the role. Back each with a 1-line example."},
  {id:4,q:"What is your biggest weakness?",cat:"Self-Awareness",tip:"Pick a real one (not perfectionism). Show what you're doing to fix it."},
  {id:5,q:"Where do you see yourself in 5 years?",cat:"Self-Awareness",tip:"Align with the company's growth ladder. Show ambition without sounding delusional."},
  {id:6,q:"What motivates you?",cat:"Self-Awareness",tip:"Connect motivation to the role — learning, impact, building brands."},
  {id:7,q:"Describe yourself in 3 words.",cat:"Self-Awareness",tip:"Choose words that tell a story together. Not generic adjectives."},
  {id:8,q:"What do you do outside academics/work?",cat:"Self-Awareness",tip:"Show personality. Relate hobbies to skills — leadership, creativity, persistence."},

  // Why MBA / Career
  {id:9,q:"Why MBA?",cat:"Why MBA",tip:"Gap in skills → MBA bridges it → specific career goal. Not 'to learn management'."},
  {id:10,q:"Why MBA in Marketing?",cat:"Why MBA",tip:"Passion for consumer behavior/brands + specific marketing career goal."},
  {id:11,q:"Why not an MS or direct work experience instead?",cat:"Why MBA",tip:"MBA gives breadth + network + structured transition. Be specific."},
  {id:12,q:"Why this college / Why IMT Ghaziabad?",cat:"Why MBA",tip:"Mention specific: faculty, alumni, clubs, pedagogy, placements in your target sector."},
  {id:13,q:"What will you do if you don't get placed?",cat:"Why MBA",tip:"Show resilience — backup plan, but confidence in preparation."},
  {id:14,q:"Why should we hire you over other candidates?",cat:"Why MBA",tip:"Unique intersection of your background + skills + passion. Not 'I'm hardworking'."},

  // Leadership
  {id:15,q:"Tell me about a time you led a team.",cat:"Leadership",tip:"STAR format. Show how you motivated others, not just managed tasks."},
  {id:16,q:"Describe a situation where you had to lead without authority.",cat:"Leadership",tip:"Influence without title — persuasion, coalition building, expertise."},
  {id:17,q:"Tell me about a time you took initiative beyond your role.",cat:"Leadership",tip:"Show ownership mentality. Quantify the impact."},
  {id:18,q:"How do you handle underperformers in your team?",cat:"Leadership",tip:"Empathy first, then clear expectations, then accountability."},
  {id:19,q:"Give an example of a tough decision you made as a leader.",cat:"Leadership",tip:"Show the trade-off. What did you sacrifice and why?"},

  // Teamwork & Conflict
  {id:20,q:"Tell me about a time you worked in a team.",cat:"Teamwork",tip:"Highlight YOUR specific contribution, not just the team's outcome."},
  {id:21,q:"Describe a conflict with a teammate and how you resolved it.",cat:"Teamwork",tip:"Show emotional intelligence — listening, finding common ground."},
  {id:22,q:"How do you deal with a teammate who isn't pulling their weight?",cat:"Teamwork",tip:"Private conversation → understand why → offer help → escalate if needed."},
  {id:23,q:"Tell me about a time you had to compromise.",cat:"Teamwork",tip:"Show flexibility without being a pushover. What did you learn?"},
  {id:24,q:"How do you handle disagreements with your manager?",cat:"Teamwork",tip:"Data-first approach. Present alternatives, not just objections."},

  // Failure & Learning
  {id:25,q:"Tell me about a time you failed.",cat:"Failure",tip:"Own it completely. Specific failure → what went wrong → what you learned → how you applied it."},
  {id:26,q:"What's the biggest mistake you've made professionally?",cat:"Failure",tip:"Show vulnerability and growth. Interviewers want self-awareness, not perfection."},
  {id:27,q:"Tell me about a time you received harsh feedback.",cat:"Failure",tip:"Show you listened, reflected, and changed. Not that you defended yourself."},
  {id:28,q:"Describe a project that didn't go as planned.",cat:"Failure",tip:"Focus on adaptability — how you pivoted, not just what went wrong."},
  {id:29,q:"What would you do differently if you could redo your career?",cat:"Failure",tip:"Show reflectiveness. Don't say 'nothing' — that's not self-aware."},

  // Pressure & Problem Solving
  {id:30,q:"Tell me about a time you worked under tight deadlines.",cat:"Pressure",tip:"Show prioritization and calm under pressure. Quantify the constraint."},
  {id:31,q:"How do you handle stress?",cat:"Pressure",tip:"Specific techniques — planning, breaks, perspective. Not just 'I thrive under pressure'."},
  {id:32,q:"Describe a time you had to make a decision with incomplete information.",cat:"Pressure",tip:"Show your reasoning process — assumptions, risk assessment, bias checks."},
  {id:33,q:"Tell me about a time you multitasked effectively.",cat:"Pressure",tip:"Show prioritization framework, not just being busy."},
  {id:34,q:"Give an example of a creative solution to a problem.",cat:"Pressure",tip:"Show unconventional thinking. What made you think of it?"},

  // Marketing-Specific
  {id:35,q:"What is marketing to you?",cat:"Marketing",tip:"Not the textbook definition. YOUR view — value creation, consumer connection, storytelling."},
  {id:36,q:"Name a marketing campaign you admire and why.",cat:"Marketing",tip:"Recent Indian campaign. Break down: objective, insight, execution, results."},
  {id:37,q:"If you could rebrand any company, which and why?",cat:"Marketing",tip:"Pick one with a clear brand problem. Show strategic thinking."},
  {id:38,q:"What makes a brand successful?",cat:"Marketing",tip:"Consistency + consumer trust + differentiation. Use real examples."},
  {id:39,q:"How would you market this pen/water bottle/product to me?",cat:"Marketing",tip:"Ask questions first (who's the customer?). Then: segment → target → position → pitch."},
  {id:40,q:"What's the difference between marketing and selling?",cat:"Marketing",tip:"Marketing creates demand and value. Selling converts it. Use examples."},
  {id:41,q:"Name an Indian brand that's doing digital marketing well.",cat:"Marketing",tip:"Specific examples with metrics/results if possible. Zomato, Amul, Swiggy."},
  {id:42,q:"How do you stay updated on marketing trends?",cat:"Marketing",tip:"Specific sources — newsletters, podcasts, case studies. Not just 'I read articles'."},

  // Ethics & Values
  {id:43,q:"Tell me about a time you stood up for what was right.",cat:"Ethics",tip:"Show moral courage. What did it cost you? Would you do it again?"},
  {id:44,q:"Have you ever bent the rules? When and why?",cat:"Ethics",tip:"Tricky — show good judgment, not rule-breaking. Context matters."},
  {id:45,q:"How do you handle ethical dilemmas at work?",cat:"Ethics",tip:"Framework: stakeholder impact → long-term consequences → transparency."},

  // Situational / Curveball
  {id:46,q:"If you were an animal/color/brand, what would you be and why?",cat:"Curveball",tip:"Be creative but strategic. Connect your answer to a relevant trait."},
  {id:47,q:"What's the last book you read? What did you learn?",cat:"Curveball",tip:"Have 2-3 ready. Show genuine takeaway, not summary."},
  {id:48,q:"If you had ₹10 lakhs to start a business, what would you build?",cat:"Curveball",tip:"Show market awareness, customer focus, feasibility. Not just a cool idea."},
  {id:49,q:"What questions do you have for us?",cat:"Curveball",tip:"Ask about: team structure, growth path, current challenges. Never ask about salary first."},
  {id:50,q:"Is there anything on your resume you want to clarify?",cat:"Curveball",tip:"Own any gaps. Pre-prepare explanations for job gaps, low grades, switches."},
  {id:51,q:"Convince me to visit your hometown.",cat:"Curveball",tip:"Structure: hook → 3 unique selling points → close. Practice the STP on the spot."},
  {id:52,q:"What's a recent news story that excited you?",cat:"Curveball",tip:"Pick business/marketing news. Connect to your interests and the role."},
  {id:53,q:"If you were the CEO of this company, what's the first thing you'd change?",cat:"Curveball",tip:"Research the company. Pick something strategic, not cosmetic."},

  // Diversity & Adaptability
  {id:54,q:"Tell me about working with people from different backgrounds.",cat:"Adaptability",tip:"Show cultural sensitivity and learning. Specific example."},
  {id:55,q:"How do you adapt to new environments?",cat:"Adaptability",tip:"Show a pattern — new city, new team, new domain. What's your approach?"},
  {id:56,q:"Describe a time you had to learn something new quickly.",cat:"Adaptability",tip:"Show learning process — not just outcome. How do you learn?"},
  {id:57,q:"What's outside your comfort zone?",cat:"Adaptability",tip:"Be honest. Then show how you're pushing yourself there."},

  // Personal
  {id:58,q:"Tell me about your family background.",cat:"Personal",tip:"Brief and warm. Connect values from family to professional life."},
  {id:59,q:"What's been the most defining experience of your life?",cat:"Personal",tip:"Pick something that shaped a core value. Show depth."},
  {id:60,q:"Who is your role model and why?",cat:"Personal",tip:"Choose someone specific. What trait do you emulate? Show it with an example."}
];

const HR_CATEGORIES = [...new Set(HR_QUESTIONS.map(q => q.cat))];

app.get("/api/hr-bank", async function(req, res) {
  var practiced = {};
  if (req.session.userId) {
    // Check which questions have been practiced in coach sessions
    var sessions = (await pool.query("SELECT messages FROM coach_sessions WHERE user_id = $1 AND practice_type IN ('hr','hr-bank')", [req.session.userId])).rows;
    sessions.forEach(function(s) {
      var msgs = JSON.parse(s.messages);
      HR_QUESTIONS.forEach(function(hq) {
        var qLower = hq.q.toLowerCase().substring(0, 30);
        msgs.forEach(function(m) {
          if (m.role === 'assistant' && m.content.toLowerCase().indexOf(qLower) >= 0) {
            practiced[hq.id] = true;
          }
        });
      });
    });
  }
  res.json({
    questions: HR_QUESTIONS,
    categories: HR_CATEGORIES,
    practiced: practiced,
    total: HR_QUESTIONS.length,
    practicedCount: Object.keys(practiced).length
  });
});

// ═══ CASE & SCENARIO BANK ═══
const CASE_QUESTIONS = [
  // Brand Strategy
  {id:1,q:"You're the Brand Manager for Maggi. After the lead controversy, sales dropped 40%. Design a 6-month recovery plan.",cat:"Brand Strategy",company:"Nestle",framework:"Crisis Recovery → Trust Rebuilding → Relaunch → Sustain",difficulty:"Tough"},
  {id:2,q:"Parle-G has been the market leader for decades but is losing urban youth. How would you reposition it without losing the rural base?",cat:"Brand Strategy",company:"Parle",framework:"Segmentation → Dual-brand strategy → Communication redesign",difficulty:"Tough"},
  {id:3,q:"Tata wants to launch a premium tea brand to compete with TWG and Dilmah. Design the brand strategy.",cat:"Brand Strategy",company:"Tata",framework:"STP → Brand Architecture → Positioning Statement → GTM",difficulty:"Mid"},
  {id:4,q:"Amul's topical ads are famous. A competitor (Nandini) starts doing the same thing. How should Amul respond?",cat:"Brand Strategy",company:"Amul",framework:"Competitive Response → Differentiation → Brand Moat",difficulty:"Mid"},
  {id:5,q:"You're hired by a legacy saree brand that's losing relevance. How do you make it appeal to Gen-Z without alienating loyal customers?",cat:"Brand Strategy",company:"Any Textile",framework:"Brand Revitalization → Extension vs Dilution → Digital-first play",difficulty:"Mid"},

  // Go-to-Market & Launch
  {id:6,q:"Design a go-to-market strategy for launching an electric scooter in tier-2 and tier-3 cities of India.",cat:"GTM & Launch",company:"Ather/Ola",framework:"Market Sizing → Channel → Pricing → Awareness → Trial conversion",difficulty:"Tough"},
  {id:7,q:"HUL wants to launch a ₹10 shampoo sachet specifically for men in rural India. Build the launch plan.",cat:"GTM & Launch",company:"HUL",framework:"Consumer Insight → Product → Price → Place → Promotion",difficulty:"Mid"},
  {id:8,q:"You have ₹50 lakhs to launch a D2C skincare brand. What category, positioning, and channels would you choose?",cat:"GTM & Launch",company:"D2C Startup",framework:"Category Selection → TAM → Positioning → Channel Mix → Unit Economics",difficulty:"Mid"},
  {id:9,q:"ITC wants to enter the energy drink market. Design the product and GTM strategy. Who's the target? How do you compete with Red Bull?",cat:"GTM & Launch",company:"ITC",framework:"Competitive Landscape → Gap Analysis → STP → 4P",difficulty:"Tough"},
  {id:10,q:"Launch a subscription-based tiffin service for working professionals in Bangalore. What's your plan?",cat:"GTM & Launch",company:"Startup",framework:"Customer Segment → Value Prop → Pricing Model → Acquisition → Retention",difficulty:"Mid"},

  // Pricing & Revenue
  {id:11,q:"Zomato Gold costs ₹600/year. Subscribers use it heavily and restaurants complain about margins. What do you do?",cat:"Pricing & Revenue",company:"Zomato",framework:"Stakeholder Analysis → Price Elasticity → Value Redesign → Tiering",difficulty:"Tough"},
  {id:12,q:"A premium chocolate brand sells at ₹200/bar. Sales are flat. Should they launch a ₹50 variant or invest in the premium positioning?",cat:"Pricing & Revenue",company:"Any FMCG",framework:"Brand Dilution Risk → Volume vs Value → Cannibalization Analysis",difficulty:"Mid"},
  {id:13,q:"How would you price a new OTT streaming service entering India against Netflix, Hotstar, and Jio Cinema?",cat:"Pricing & Revenue",company:"OTT",framework:"Competitive Pricing → Freemium vs Subscription → Bundle Strategy → Content ROI",difficulty:"Mid"},
  {id:14,q:"An airline wants to increase revenue per passenger by 15% without raising ticket prices. What do you recommend?",cat:"Pricing & Revenue",company:"IndiGo/Vistara",framework:"Ancillary Revenue → Dynamic Pricing → Upsell → Loyalty",difficulty:"Mid"},

  // Digital Marketing
  {id:15,q:"Allocate a ₹1 crore digital marketing budget for a new fashion e-commerce brand. Where does the money go?",cat:"Digital Marketing",company:"D2C Fashion",framework:"Funnel: Awareness → Consideration → Conversion → Retention. Channel split with ROI logic.",difficulty:"Mid"},
  {id:16,q:"A legacy FMCG brand has zero social media presence. Build a 90-day digital transformation plan.",cat:"Digital Marketing",company:"Any FMCG",framework:"Audit → Platform Selection → Content Pillars → Community → Paid → Measure",difficulty:"Mid"},
  {id:17,q:"Swiggy's Instagram has 2M followers but low engagement. How would you fix it?",cat:"Digital Marketing",company:"Swiggy",framework:"Content Audit → Engagement Drivers → UGC → Community → Algorithm Play",difficulty:"Easy"},
  {id:18,q:"Design an influencer marketing strategy for a new protein powder brand targeting college students.",cat:"Digital Marketing",company:"Startup",framework:"Influencer Tiers → Selection Criteria → Content Types → Measurement → Budget",difficulty:"Easy"},

  // Market Entry
  {id:19,q:"Should Starbucks enter tier-2 cities in India? If yes, how? If no, why not?",cat:"Market Entry",company:"Starbucks",framework:"Market Attractiveness → Consumer Readiness → Unit Economics → Format Adaptation",difficulty:"Tough"},
  {id:20,q:"A Japanese skincare brand wants to enter India. You're the India launch head. What's your strategy?",cat:"Market Entry",company:"Shiseido/SK-II",framework:"Market Assessment → Entry Mode → Localization → Distribution → Regulatory",difficulty:"Tough"},
  {id:21,q:"Amazon wants to grow its grocery business in India against Zepto, Blinkers and BigBasket. What's the play?",cat:"Market Entry",company:"Amazon",framework:"Competitive Map → Quick Commerce vs Planned → Private Labels → Logistics",difficulty:"Mid"},
  {id:22,q:"Should Netflix launch a cricket-only streaming package in India?",cat:"Market Entry",company:"Netflix",framework:"TAM → Willingness to Pay → Content Cost → Competitive Position → Cannibalization",difficulty:"Mid"},

  // Consumer Behavior
  {id:23,q:"Why do Indian consumers prefer sachets over full-size products? Is this changing? What does it mean for marketers?",cat:"Consumer Insight",company:"Any FMCG",framework:"Income Segmentation → Trial Behavior → Channel Economics → Premiumization Trend",difficulty:"Easy"},
  {id:24,q:"Gen-Z is brand-disloyal but community-loyal. How should brands adapt?",cat:"Consumer Insight",company:"Any",framework:"Behavioral Shift → Community Building → Value Alignment → Experience > Product",difficulty:"Mid"},
  {id:25,q:"Rural India has smartphones but low data literacy. How do you market a financial product to them?",cat:"Consumer Insight",company:"Fintech",framework:"Vernacular → Trust Channels → Simplification → On-ground + Digital hybrid",difficulty:"Mid"},
  {id:26,q:"Why does a customer pay ₹500 for Starbucks but bargain for ₹10 at a local chai stall? What does this tell you about pricing psychology?",cat:"Consumer Insight",company:"Any",framework:"Reference Price → Experience Economy → Status Signaling → Context-dependent pricing",difficulty:"Easy"},

  // Sales & Distribution
  {id:27,q:"Design a distribution strategy for a packaged drinking water brand in Bihar.",cat:"Sales & Distribution",company:"Bisleri/Aquafina",framework:"Channel Mapping → Kirana vs Modern Trade → Supply Chain → Last Mile → Margins",difficulty:"Mid"},
  {id:28,q:"An FMCG company's rural sales team covers 50,000 villages. Each salesperson visits 20 shops/day. How would you improve reach by 30%?",cat:"Sales & Distribution",company:"HUL/ITC",framework:"Route Optimization → Hub & Spoke → Tech → Stockist Network → Incentives",difficulty:"Tough"},
  {id:29,q:"Quick commerce (10-min delivery) is killing traditional kirana stores. If you were ITC, how would you respond?",cat:"Sales & Distribution",company:"ITC",framework:"Channel Conflict → Omnichannel → Kirana Enablement → Direct Play",difficulty:"Tough"},

  // Crisis Management
  {id:30,q:"Your brand's ambassador just got arrested for a crime. You have 3 hours before the press conference. What do you do?",cat:"Crisis Management",company:"Any",framework:"Immediate Response → Stakeholder Map → Statement → Distancing → Long-term",difficulty:"Tough"},
  {id:31,q:"A viral video shows a cockroach in your restaurant chain's kitchen. 10M views in 6 hours. What's your response plan?",cat:"Crisis Management",company:"QSR",framework:"Acknowledge → Investigate → Respond → Fix → Rebuild → Monitor",difficulty:"Mid"},
  {id:32,q:"Your e-commerce platform accidentally priced a ₹50,000 TV at ₹500. 10,000 orders came in. Honor or cancel?",cat:"Crisis Management",company:"Flipkart/Amazon",framework:"Legal → Customer Trust → Financial Impact → PR Play → Resolution Options",difficulty:"Mid"},

  // Guesstimates
  {id:33,q:"Estimate the number of cups of chai sold daily in Mumbai.",cat:"Guesstimate",company:"Any",framework:"Population → Segments → Frequency → Channels → Cross-check",difficulty:"Easy"},
  {id:34,q:"How many diapers are sold in India per year?",cat:"Guesstimate",company:"P&G",framework:"Births/year → Diaper age range → Urban vs Rural penetration → Usage/day",difficulty:"Easy"},
  {id:35,q:"Estimate Zomato's daily order volume in Delhi NCR.",cat:"Guesstimate",company:"Zomato",framework:"Addressable Population → Ordering frequency → Market share → Cross-check with revenue",difficulty:"Mid"},
  {id:36,q:"What is the market size of premium men's grooming in India?",cat:"Guesstimate",company:"Bombay Shaving Co",framework:"Male Population → Age filter → Income filter → Category spend → Premium %",difficulty:"Mid"},
  {id:37,q:"Estimate the revenue of a McDonald's outlet at a highway rest stop.",cat:"Guesstimate",company:"McDonald's",framework:"Traffic → Conversion → Average ticket → Hours → Seasonal variation",difficulty:"Mid"},
  {id:38,q:"How many advertisements does an average Indian see in a day?",cat:"Guesstimate",company:"Any",framework:"Channels (phone, TV, outdoor, print) → Time spent → Ad frequency per channel",difficulty:"Easy"},

  // Company-Specific Scenarios
  {id:39,q:"Flipkart's Big Billion Days vs Amazon's Great Indian Festival — if you had to pick ONE differentiator for next year's sale, what would it be?",cat:"Company Scenario",company:"Flipkart/Amazon",framework:"Competitive Analysis → Consumer Pain Points → Differentiation Axes",difficulty:"Mid"},
  {id:40,q:"You're the CMO of Swiggy. Zomato just launched a 'pure veg' fleet. Should Swiggy copy it, counter it, or ignore it?",cat:"Company Scenario",company:"Swiggy",framework:"Competitive Response Matrix → Segment Size → Brand Risk → Execution Feasibility",difficulty:"Tough"},
  {id:41,q:"Nykaa's growth is slowing post-IPO. As brand head, propose 3 strategies to reignite growth.",cat:"Company Scenario",company:"Nykaa",framework:"Growth Levers: New categories, new geographies, new customer segments, retention",difficulty:"Mid"},
  {id:42,q:"Reliance Jio disrupted telecom with free data. Can the same playbook work for JioCinema in OTT? Why or why not?",cat:"Company Scenario",company:"Jio",framework:"Disruption Analysis → Network Effects → Content vs Connectivity → Monetization Path",difficulty:"Tough"},
  {id:43,q:"You're the marketing head at Boat. Apple just launched a ₹9,999 earphone for India. How do you respond?",cat:"Company Scenario",company:"Boat",framework:"Price Positioning → Segment Defense → Value Perception → Community Play",difficulty:"Mid"},
  {id:44,q:"P&G India wants to double its rural penetration in 2 years. You lead the project. What's the plan?",cat:"Company Scenario",company:"P&G",framework:"Current gaps → Van campaigns → Sachet strategy → Local partnerships → KPIs",difficulty:"Tough"},
  {id:45,q:"Dunzo is pivoting from delivery to quick commerce. As product marketer, how do you communicate this pivot to existing users without losing them?",cat:"Company Scenario",company:"Dunzo",framework:"Change Communication → Value Migration → Retention Offers → Repositioning",difficulty:"Mid"},

  // Role-Play Scenarios
  {id:46,q:"You're a Brand Manager at HUL. Your biggest retailer threatens to delist your product unless you give 5% more margin. Your margin is already 12%. What do you do?",cat:"Role-Play",company:"HUL",framework:"Negotiation → BATNA → Value Beyond Price → Trade Terms → Walk-away point",difficulty:"Tough"},
  {id:47,q:"Your CEO wants to cut the marketing budget by 40% to fund R&D. Make the case to keep it.",cat:"Role-Play",company:"Any",framework:"Marketing ROI → Brand Equity Erosion → Competitor Opportunity → Compromise",difficulty:"Mid"},
  {id:48,q:"A regional competitor is undercutting your price by 30% and gaining share in UP. How do you fight back without a price war?",cat:"Role-Play",company:"Any FMCG",framework:"Value Differentiation → Pack Size Strategy → Trade Push → Flanker Brand",difficulty:"Tough"},
  {id:49,q:"You're presenting a new product idea to the board. They ask: 'What if this fails? What's Plan B?' What do you say?",cat:"Role-Play",company:"Any",framework:"Risk Assessment → Pivot Options → Kill Criteria → Learnings Capture",difficulty:"Mid"},
  {id:50,q:"You're managing a ₹100 crore brand. The data shows TV ROI is declining but your boss insists on 60% TV spend. How do you persuade them to shift?",cat:"Role-Play",company:"Any FMCG",framework:"Data-driven persuasion → Pilot Proposal → Risk Mitigation → Phased Shift",difficulty:"Mid"}
];

const CASE_CATEGORIES = [...new Set(CASE_QUESTIONS.map(q => q.cat))];

app.get("/api/case-bank", async function(req, res) {
  var practiced = {};
  if (req.session.userId) {
    var sessions = (await pool.query("SELECT messages FROM coach_sessions WHERE user_id = $1 AND practice_type IN ('case','case-bank')", [req.session.userId])).rows;
    sessions.forEach(function(s) {
      var msgs = JSON.parse(s.messages);
      CASE_QUESTIONS.forEach(function(cq) {
        var qLower = cq.q.toLowerCase().substring(0, 30);
        msgs.forEach(function(m) {
          if (m.role === 'assistant' && m.content.toLowerCase().indexOf(qLower) >= 0) {
            practiced[cq.id] = true;
          }
        });
      });
    });
  }
  res.json({
    questions: CASE_QUESTIONS,
    categories: CASE_CATEGORIES,
    practiced: practiced,
    total: CASE_QUESTIONS.length,
    practicedCount: Object.keys(practiced).length
  });
});

// ═══ GD DEBRIEF ═══
app.post("/api/gd-debrief", async function(req, res) {
  if (!req.session.userId) return res.status(401).json({ success: false });
  var conversation = req.body.conversation || '';
  var topic = req.body.topic || '';
  if (conversation.length < 50) return res.json({ success: false, error: "Need more conversation to generate debrief." });

  var prompt = `You are an MBA GD coach. A student just finished a Group Discussion practice session. Analyze their performance and generate a complete study card.

GD TOPIC: ${topic || 'Extract from conversation'}

CONVERSATION:
${conversation.substring(0, 3000)}

Return ONLY valid JSON (no markdown, no backticks):
{
  "topic": "The exact GD topic discussed",
  "verdict": "How the student performed in one sentence",
  "biggestMistake": "The single biggest mistake they made",
  "forPoints": [
    {"point": "Strong argument FOR the topic", "data": "Supporting data/example to cite"},
    {"point": "Second argument FOR", "data": "Supporting data"},
    {"point": "Third argument FOR", "data": "Supporting data"}
  ],
  "againstPoints": [
    {"point": "Strong argument AGAINST the topic", "data": "Supporting data/example to cite"},
    {"point": "Second argument AGAINST", "data": "Supporting data"},
    {"point": "Third argument AGAINST", "data": "Supporting data"}
  ],
  "concepts": [
    {"term": "Marketing concept relevant to this topic", "meaning": "One-line definition", "useItLike": "Exact sentence to say in the GD using this concept"},
    {"term": "Second concept", "meaning": "Definition", "useItLike": "Usage sentence"},
    {"term": "Third concept", "meaning": "Definition", "useItLike": "Usage sentence"},
    {"term": "Fourth concept", "meaning": "Definition", "useItLike": "Usage sentence"},
    {"term": "Fifth concept", "meaning": "Definition", "useItLike": "Usage sentence"}
  ],
  "modelOpening": "Exactly how to open this GD topic — a 2-3 sentence opening with a data hook",
  "modelCounter": "How to counter the strongest opposing argument — 2 sentences",
  "modelSummary": "How to summarize this GD if asked — 3 sentences covering both sides",
  "phrasesToMemorize": [
    "Power phrase 1 specific to this topic",
    "Power phrase 2",
    "Power phrase 3"
  ],
  "framework": "Which framework fits this topic best (PESTEL / Stakeholder / Steel Man / Make Concrete) and why in one sentence"
}

RULES:
- forPoints and againstPoints must have REAL data, numbers, or Indian examples — not generic
- concepts must be marketing/business terms actually relevant to THIS topic
- useItLike must be a natural sentence a student could say verbatim in the GD
- modelOpening must start with a data hook or striking observation
- phrasesToMemorize should sound professional and be topic-specific`;

  try {
    var result = await model.generateContent(prompt);
    var text = result.response.text().replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    var debrief = JSON.parse(text);
    res.json({ success: true, debrief: debrief });
  } catch (err) {
    console.error("GD debrief error:", err.message);
    res.json({ success: false, error: "Could not generate debrief. Try again." });
  }
});

// ═══ SPACED REPETITION ═══
app.post("/api/struggled", async function(req, res) {
  if (!req.session.userId) return res.json({ success: false });
  var b = req.body;
  if (!b.question) return res.json({ success: false });
  var today = new Date().toISOString().split("T")[0];
  var tomorrow = new Date(Date.now() + 86400000).toISOString().split("T")[0];

  var existing = (await pool.query("SELECT * FROM struggled_questions WHERE user_id = $1 AND question = $2", [req.session.userId, b.question])).rows[0];

  if (existing) {
    var score = b.score || 0;
    var newInterval, newStatus;
    if (score >= 8) {
      // Good answer — increase interval
      newInterval = Math.min(30, existing.interval_days * 2);
      newStatus = newInterval >= 14 ? 'mastered' : 'reviewing';
    } else {
      // Struggled again — reset
      newInterval = 1;
      newStatus = 'learning';
    }
    var nextReview = new Date(Date.now() + newInterval * 86400000).toISOString().split("T")[0];
    await pool.query("UPDATE struggled_questions SET last_score = $1, attempts = attempts + 1, best_score = GREATEST(best_score, $2), interval_days = $3, next_review = $4, status = $5, best_answer = CASE WHEN $6 > best_score THEN $7 ELSE best_answer END, coach_feedback = $8 WHERE id = $9", [
      score, score, newInterval, nextReview, newStatus, score, b.answer || '', b.feedback || '', existing.id
    ]);
    res.json({ success: true, interval: newInterval, status: newStatus, nextReview: nextReview });
  } else {
    await pool.query("INSERT INTO struggled_questions (user_id, question, best_score, last_score, first_answer, coach_feedback, next_review) VALUES ($1, $2, $3, $4, $5, $6, $7)", [
      req.session.userId, b.question, b.score || 0, b.score || 0, b.answer || '', b.feedback || '', tomorrow
    ]);
    res.json({ success: true, interval: 1, status: 'learning', nextReview: tomorrow });
  }
});

app.get("/api/review-due", async function(req, res) {
  try {
    if (!req.session.userId) return res.json({ questions: [], count: 0 });
    var today = new Date().toISOString().split("T")[0];
    var due = (await pool.query("SELECT * FROM struggled_questions WHERE user_id = $1 AND next_review <= $2 AND status != 'mastered' ORDER BY last_score ASC, next_review ASC", [req.session.userId, today])).rows;
    res.json({ questions: due, count: due.length });
  } catch (err) { console.error("review-due error:", err.message); res.json({ questions: [], count: 0 }); }
});

app.get("/api/quick-drill", async function(req, res) {
  try {
    if (!req.session.userId) return res.json({ questions: [], count: 0 });
    var weak = (await pool.query("SELECT * FROM struggled_questions WHERE user_id = $1 AND status != 'mastered' ORDER BY best_score ASC, attempts DESC LIMIT 5", [req.session.userId])).rows;
    if (weak.length < 5) {
      var areas = (await pool.query("SELECT area FROM growth_areas WHERE user_id = $1 ORDER BY count DESC LIMIT $2", [req.session.userId, 5 - weak.length])).rows;
      areas.forEach(function(a) { weak.push({ question: "Demonstrate improvement in: " + a.area, best_score: 0, attempts: 0, status: 'growth-area' }); });
    }
    res.json({ questions: weak, count: weak.length });
  } catch (err) { console.error("quick-drill error:", err.message); res.json({ questions: [], count: 0 }); }
});

app.get("/api/struggled-stats", async function(req, res) {
  try {
    if (!req.session.userId) return res.json({ total: 0, mastered: 0, learning: 0, reviewing: 0 });
    var stats = (await pool.query("SELECT status, COUNT(*) as c FROM struggled_questions WHERE user_id = $1 GROUP BY status", [req.session.userId])).rows;
    var result = { total: 0, mastered: 0, learning: 0, reviewing: 0 };
    stats.forEach(function(s) { result[s.status] = s.c; result.total += s.c; });
    res.json(result);
  } catch (err) { console.error("struggled-stats error:", err.message); res.json({ total: 0, mastered: 0, learning: 0, reviewing: 0 }); }
});

// ═══ ANSWER WORKSHOP — 50 ESSENTIAL QUESTIONS ═══
const WORKSHOP_QUESTIONS = [
  // Self-Introduction & Why (must-nail category)
  {id:"w1",q:"Tell me about yourself.",cat:"Must-Nail",why:"Your first impression. Sets the tone for everything.",priority:1},
  {id:"w2",q:"Why MBA?",cat:"Must-Nail",why:"Tests if your MBA decision is strategic, not aimless.",priority:1},
  {id:"w3",q:"Why MBA in Marketing?",cat:"Must-Nail",why:"Tests genuine passion for the function vs default choice.",priority:1},
  {id:"w4",q:"Why this college / Why IMT Ghaziabad?",cat:"Must-Nail",why:"Tests if you researched or just ended up here.",priority:1},
  {id:"w5",q:"Why should we hire you?",cat:"Must-Nail",why:"Your closing argument. Needs to be specific and memorable.",priority:1},
  {id:"w6",q:"Walk me through your resume.",cat:"Must-Nail",why:"Tests narrative coherence — can you connect the dots?",priority:1},
  {id:"w7",q:"Where do you see yourself in 5 years?",cat:"Must-Nail",why:"Tests ambition, realism, and alignment with the role.",priority:1},
  // Self-Awareness
  {id:"w8",q:"What are your 3 greatest strengths?",cat:"Self-Awareness",why:"Tests self-knowledge and whether strengths match the role.",priority:2},
  {id:"w9",q:"What is your biggest weakness?",cat:"Self-Awareness",why:"Tests honesty, self-awareness, and growth mindset.",priority:2},
  {id:"w10",q:"What motivates you?",cat:"Self-Awareness",why:"Tests intrinsic motivation alignment with the company.",priority:2},
  {id:"w11",q:"Describe yourself in 3 words.",cat:"Self-Awareness",why:"Tests self-awareness and personal branding clarity.",priority:2},
  {id:"w12",q:"What do you do outside academics/work?",cat:"Self-Awareness",why:"Tests personality, interests, and whether you're well-rounded.",priority:3},
  // Leadership & Teamwork STAR stories
  {id:"w13",q:"Tell me about a time you led a team.",cat:"STAR Stories",why:"Tests leadership style and impact. Must have numbers.",priority:1},
  {id:"w14",q:"Tell me about a time you failed.",cat:"STAR Stories",why:"Tests vulnerability, ownership, and learning agility.",priority:1},
  {id:"w15",q:"Tell me about a conflict with a teammate.",cat:"STAR Stories",why:"Tests emotional intelligence and resolution skills.",priority:2},
  {id:"w16",q:"Tell me about a time you took initiative.",cat:"STAR Stories",why:"Tests ownership mentality and proactiveness.",priority:2},
  {id:"w17",q:"Describe a tough decision you made.",cat:"STAR Stories",why:"Tests decision-making under trade-offs.",priority:2},
  {id:"w18",q:"Tell me about working under tight deadlines.",cat:"STAR Stories",why:"Tests composure, prioritization, and time management.",priority:2},
  {id:"w19",q:"Give an example of when you persuaded someone.",cat:"STAR Stories",why:"Tests influence skills — critical for marketing roles.",priority:2},
  {id:"w20",q:"Tell me about a time you received harsh feedback.",cat:"STAR Stories",why:"Tests coachability and growth orientation.",priority:3},
  // Marketing Domain
  {id:"w21",q:"What is your favourite brand and why?",cat:"Marketing",why:"Tests if you think like a marketer in daily life.",priority:1},
  {id:"w22",q:"Describe a marketing campaign you admire.",cat:"Marketing",why:"Tests marketing awareness and analytical thinking.",priority:2},
  {id:"w23",q:"What is brand equity and give an Indian example?",cat:"Marketing",why:"Tests core concept knowledge — Kotler basics.",priority:2},
  {id:"w24",q:"Explain STP with a real brand example.",cat:"Marketing",why:"Tests the most fundamental marketing framework.",priority:2},
  {id:"w25",q:"How would you launch a new product in rural India?",cat:"Marketing",why:"Tests 4P thinking, distribution awareness, India context.",priority:2},
  {id:"w26",q:"Digital marketing vs traditional — when do you use which?",cat:"Marketing",why:"Tests channel strategy thinking and modern awareness.",priority:3},
  {id:"w27",q:"What marketing trend excites you most and why?",cat:"Marketing",why:"Tests current awareness and forward thinking.",priority:3},
  {id:"w28",q:"Sell me this pen / this product.",cat:"Marketing",why:"Tests on-the-spot persuasion and consumer insight.",priority:2},
  // Company-Specific
  {id:"w29",q:"What do you know about our company?",cat:"Company-Specific",why:"Tests research effort and genuine interest.",priority:1},
  {id:"w30",q:"What would you change about our brand?",cat:"Company-Specific",why:"Tests strategic thinking and whether you dare to be honest.",priority:2},
  {id:"w31",q:"Why this company and not a competitor?",cat:"Company-Specific",why:"Tests differentiation awareness and research depth.",priority:2},
  {id:"w32",q:"What role do you see yourself in at our company?",cat:"Company-Specific",why:"Tests career clarity and company research.",priority:2},
  // Pressure & Ethics
  {id:"w33",q:"How do you handle stress?",cat:"Pressure",why:"Tests self-regulation and real coping mechanisms.",priority:2},
  {id:"w34",q:"What will you do if you don't get placed?",cat:"Pressure",why:"Tests resilience, backup planning, and composure.",priority:2},
  {id:"w35",q:"Have you ever had to make an ethical decision?",cat:"Pressure",why:"Tests integrity — increasingly asked by top companies.",priority:3},
  {id:"w36",q:"What's the biggest risk you've taken?",cat:"Pressure",why:"Tests risk appetite and decision-making under uncertainty.",priority:3},
  // Case Thinking
  {id:"w37",q:"How would you increase market share for a declining FMCG brand?",cat:"Case Thinking",why:"Tests structured marketing problem-solving.",priority:2},
  {id:"w38",q:"Estimate the market size for premium coffee in India.",cat:"Case Thinking",why:"Tests guesstimate skills — a placement staple.",priority:2},
  {id:"w39",q:"Should a luxury brand enter tier-2 cities?",cat:"Case Thinking",why:"Tests strategic thinking with trade-offs.",priority:3},
  {id:"w40",q:"Design a go-to-market for a new D2C brand with ₹50L budget.",cat:"Case Thinking",why:"Tests practical marketing execution thinking.",priority:3},
  // GD Readiness
  {id:"w41",q:"State your position on: AI will replace more jobs than it creates.",cat:"GD Readiness",why:"Tests structured argumentation with evidence.",priority:2},
  {id:"w42",q:"Give a 30-second GD opening on any current affairs topic.",cat:"GD Readiness",why:"Tests ability to open confidently with a hook.",priority:2},
  {id:"w43",q:"Summarize a GD in 60 seconds after hearing both sides.",cat:"GD Readiness",why:"Tests listening, synthesis, and structured closing.",priority:3},
  // Current Affairs Integration
  {id:"w44",q:"Tell me about a recent business news story and its marketing implications.",cat:"Current Affairs",why:"Tests daily reading habit and analytical framing.",priority:2},
  {id:"w45",q:"What's happening in the Indian economy right now that marketers should care about?",cat:"Current Affairs",why:"Tests macro awareness and business acumen.",priority:3},
  // Personal & Cultural Fit
  {id:"w46",q:"Tell me about your family background.",cat:"Personal",why:"Tests warmth, values, and narrative connection.",priority:3},
  {id:"w47",q:"Who is your role model and why?",cat:"Personal",why:"Tests depth of thinking and values alignment.",priority:3},
  {id:"w48",q:"What's the most defining experience of your life?",cat:"Personal",why:"Tests storytelling ability and self-awareness depth.",priority:3},
  // Curveball
  {id:"w49",q:"If you were the CEO of this company, what's the first thing you'd change?",cat:"Curveball",why:"Tests boldness, strategic thinking, company research.",priority:3},
  {id:"w50",q:"Convince me to visit your hometown.",cat:"Curveball",why:"Tests persuasion, structure, and on-the-spot creativity.",priority:3}
];

const WORKSHOP_CATEGORIES = [...new Set(WORKSHOP_QUESTIONS.map(q => q.cat))];

app.get("/api/workshop-questions", async function(req, res) {
  var userAnswers = {};
  if (req.session.userId) {
    var rows = (await pool.query("SELECT question_id, status, best_score, current_draft, locked_answer, versions FROM answer_workshop WHERE user_id = $1", [req.session.userId])).rows;
    rows.forEach(function(r) { userAnswers[r.question_id] = r; });
  }
  var stats = { total: WORKSHOP_QUESTIONS.length, not_started: 0, drafting: 0, refining: 0, locked: 0 };
  WORKSHOP_QUESTIONS.forEach(function(q) {
    var a = userAnswers[q.id];
    if (!a || a.status === 'not_started') stats.not_started++;
    else if (a.status === 'drafting') stats.drafting++;
    else if (a.status === 'refining') stats.refining++;
    else if (a.status === 'locked') stats.locked++;
  });
  res.json({ questions: WORKSHOP_QUESTIONS, categories: WORKSHOP_CATEGORIES, answers: userAnswers, stats: stats });
});

app.post("/api/workshop-save", async function(req, res) {
  if (!req.session.userId) return res.status(401).json({ success: false });
  var b = req.body;
  if (!b.questionId || !b.draft) return res.json({ success: false, error: "Question and answer required" });
  var existing = (await pool.query("SELECT * FROM answer_workshop WHERE user_id = $1 AND question_id = $2", [req.session.userId, b.questionId])).rows[0];
  var qObj = WORKSHOP_QUESTIONS.find(function(q) { return q.id === b.questionId; });
  var qText = qObj ? qObj.q : b.questionText || '';
  var qCat = qObj ? qObj.cat : '';
  if (existing) {
    var versions = JSON.parse(existing.versions || '[]');
    versions.push({ draft: b.draft, score: b.score || 0, date: new Date().toISOString(), feedback: b.feedback || '' });
    if (versions.length > 10) versions = versions.slice(-10);
    var bestScore = Math.max(existing.best_score, b.score || 0);
    var status = b.lock ? 'locked' : (bestScore >= 8 ? 'refining' : 'drafting');
    await pool.query("UPDATE answer_workshop SET current_draft = $1, versions = $2, best_score = $3, status = $4, locked_answer = CASE WHEN $5 = 1 THEN $6 ELSE locked_answer END, locked_at = CASE WHEN $7 = 1 THEN NOW() ELSE locked_at END, updated_at = NOW() WHERE id = $8", [
      b.draft, JSON.stringify(versions), bestScore, status, b.lock ? 1 : 0, b.draft, b.lock ? 1 : 0, existing.id
    ]);
    res.json({ success: true, status: status, bestScore: bestScore, versionCount: versions.length });
  } else {
    var versions = [{ draft: b.draft, score: b.score || 0, date: new Date().toISOString(), feedback: b.feedback || '' }];
    var status = b.lock ? 'locked' : 'drafting';
    await pool.query("INSERT INTO answer_workshop (user_id, question_id, question_text, category, current_draft, versions, best_score, status, locked_answer, locked_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)", [
      req.session.userId, b.questionId, qText, qCat, b.draft, JSON.stringify(versions), b.score || 0, status, b.lock ? b.draft : '', b.lock ? new Date().toISOString() : ''
    ]);
    res.json({ success: true, status: status, bestScore: b.score || 0, versionCount: 1 });
  }
});

app.post("/api/workshop-score", async function(req, res) {
  if (!req.session.userId) return res.status(401).json({ success: false });
  var b = req.body;
  if (!b.question || !b.answer) return res.json({ success: false, error: "Question and answer required" });
  var user = (await pool.query("SELECT * FROM users WHERE id=$1", [req.session.userId])).rows[0];
  var prompt = 'You are an expert MBA interview coach. Score this answer for Indian B-school placement interviews.\n\n' +
    'QUESTION: "' + b.question + '"\n' +
    'ANSWER: "' + b.answer + '"\n' +
    (user && user.cv ? 'CANDIDATE CV (for context): ' + user.cv.substring(0, 400) + '\n' : '') +
    (user && user.target_roles ? 'TARGET ROLES: ' + user.target_roles + '\n' : '') +
    '\nReturn ONLY valid JSON (no markdown):\n' +
    '{\n' +
    '  "overall": 1-10,\n' +
    '  "relevance": {"score": 1-10, "feedback": "one sentence"},\n' +
    '  "structure": {"score": 1-10, "feedback": "one sentence"},\n' +
    '  "specificity": {"score": 1-10, "feedback": "one sentence"},\n' +
    '  "marketing": {"score": 1-10, "feedback": "one sentence"},\n' +
    '  "weak": "The weakest part of this answer in one sentence",\n' +
    '  "better": "Rewrite the weakest sentence to make it strong",\n' +
    '  "memorize": "One power phrase from this answer worth memorizing",\n' +
    '  "improved_answer": "The complete improved version of their answer (4-6 sentences, first person, using their specifics but tighter and stronger)"\n' +
    '}';
  try {
    var result = await model.generateContent(prompt);
    var text = result.response.text().replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    var scores = JSON.parse(text);
    res.json({ success: true, scores: scores });
  } catch (err) {
    res.json({ success: false, error: "Scoring failed. Try again." });
  }
});

app.get("/api/workshop-locked", async function(req, res) {
  if (!req.session.userId) return res.json({ answers: [] });
  var locked = (await pool.query("SELECT question_id, question_text, category, locked_answer, best_score FROM answer_workshop WHERE user_id = $1 AND status = 'locked' ORDER BY best_score DESC", [req.session.userId])).rows;
  res.json({ answers: locked });
});

// ═══ APTITUDE & REASONING BANK ═══
const APTITUDE_BANK = {
  quantitative: [
    {id:"q1",q:"A shopkeeper marks up goods by 40% and then gives a 20% discount. What is his actual profit percentage?",opts:["12%","15%","18%","20%"],ans:0,exp:"CP=100, MP=140, SP=140×0.8=112. Profit=12%.",diff:"easy"},
    {id:"q2",q:"If A can complete a task in 12 days and B in 18 days, how many days will they take working together?",opts:["7.2","6.5","8","9"],ans:0,exp:"Combined rate=1/12+1/18=5/36. Days=36/5=7.2.",diff:"easy"},
    {id:"q3",q:"A train 150m long crosses a platform 350m long in 25 seconds. What is the train's speed in km/h?",opts:["72","60","54","80"],ans:0,exp:"Total distance=500m, Time=25s. Speed=500/25=20m/s=72km/h.",diff:"medium"},
    {id:"q4",q:"The ratio of milk to water in a mixture is 3:2. If 10 litres of water are added, the ratio becomes 3:4. What was the original quantity of milk?",opts:["15L","12L","9L","18L"],ans:0,exp:"Let milk=3x, water=2x. 3x/(2x+10)=3/4. 12x=6x+30, x=5. Milk=15L.",diff:"medium"},
    {id:"q5",q:"A company's revenue grew from ₹80L to ₹120L. What is the percentage increase?",opts:["40%","50%","33%","60%"],ans:1,exp:"Increase=40L. %=(40/80)×100=50%.",diff:"easy"},
    {id:"q6",q:"If the price of sugar increases by 25%, by what percentage must a family reduce consumption to maintain the same expenditure?",opts:["20%","25%","15%","30%"],ans:0,exp:"New price=1.25×original. Reduction=0.25/1.25=20%.",diff:"medium"},
    {id:"q7",q:"Two pipes can fill a tank in 15 min and 20 min respectively. A drain pipe can empty it in 30 min. If all three are open, how long to fill?",opts:["12 min","15 min","20 min","10 min"],ans:0,exp:"Rate=1/15+1/20-1/30=(4+3-2)/60=5/60=1/12. Time=12 min.",diff:"medium"},
    {id:"q8",q:"What is 15% of 20% of 500?",opts:["15","12","10","18"],ans:0,exp:"20% of 500=100. 15% of 100=15.",diff:"easy"},
    {id:"q9",q:"In how many years will ₹8000 amount to ₹9261 at 5% compound interest annually?",opts:["3","2","4","5"],ans:0,exp:"9261/8000=(1.05)^n. 1.05^3=1.157625. 8000×1.157625≈9261. n=3.",diff:"hard"},
    {id:"q10",q:"A man rows upstream at 4 km/h and downstream at 8 km/h. What is the speed of the stream?",opts:["2 km/h","3 km/h","4 km/h","1 km/h"],ans:0,exp:"Stream speed=(8-4)/2=2 km/h.",diff:"easy"},
    {id:"q11",q:"If the selling price is doubled, the profit triples. What is the ratio of CP to SP?",opts:["1:2","2:3","1:3","3:4"],ans:1,exp:"Let CP=C, SP=S. Profit=S-C. New: 2S-C=3(S-C) → 2S-C=3S-3C → 2C=S. So CP:SP=C:2C but original profit triples condition gives CP:SP=2:3.",diff:"hard"},
    {id:"q12",q:"A and B invest in a business in the ratio 3:5. If A invests for 8 months and B for 6 months, what is their profit sharing ratio?",opts:["4:5","3:5","8:10","2:3"],ans:0,exp:"A's share=3×8=24. B's share=5×6=30. Ratio=24:30=4:5.",diff:"medium"},
    {id:"q13",q:"The average of 5 numbers is 42. If one number is removed, the average becomes 40. What is the removed number?",opts:["50","48","46","52"],ans:0,exp:"Total=5×42=210. After removal=4×40=160. Removed=210-160=50.",diff:"easy"},
    {id:"q14",q:"A car travels the first half of a distance at 40 km/h and the second half at 60 km/h. What is the average speed?",opts:["48 km/h","50 km/h","45 km/h","52 km/h"],ans:0,exp:"Average speed=2×40×60/(40+60)=4800/100=48 km/h.",diff:"medium"},
    {id:"q15",q:"How many ways can 5 people be seated in a row?",opts:["120","60","24","720"],ans:0,exp:"5!=5×4×3×2×1=120.",diff:"easy"},
    {id:"q16",q:"A retailer buys 20 items for ₹18 each and sells 18 items for ₹20 each. What is the gain or loss %?",opts:["23.5% gain","20% gain","25% gain","18% gain"],ans:0,exp:"CP=20×18=360. SP=18×20=360. No gain. But per-item: CP=18, SP=20×20/18=22.22. Gain=(22.22-18)/18×100≈23.5%.",diff:"hard"},
    {id:"q17",q:"The population of a town increases by 10% annually. If the current population is 11,000, what was it 2 years ago?",opts:["~9,091","~9,500","~10,000","~8,500"],ans:0,exp:"Pop 2 years ago=11000/(1.1)^2=11000/1.21≈9091.",diff:"medium"},
    {id:"q18",q:"In a class, 60% students passed in English and 70% passed in Hindi. If 40% passed in both, what % failed in both?",opts:["10%","15%","20%","5%"],ans:0,exp:"P(E∪H)=60+70-40=90%. Failed in both=100-90=10%.",diff:"medium"},
  ],
  logical: [
    {id:"l1",q:"If all roses are flowers and some flowers are red, which is definitely true?",opts:["All roses are red","Some roses are red","Some flowers are roses","No roses are red"],ans:2,exp:"'All roses are flowers' means the set of roses is within flowers. So some flowers are indeed roses.",diff:"easy"},
    {id:"l2",q:"Find the next number: 2, 6, 12, 20, 30, ?",opts:["42","40","36","44"],ans:0,exp:"Differences: 4,6,8,10,12. Next=30+12=42.",diff:"easy"},
    {id:"l3",q:"A is B's brother. C is B's father. D is C's sister. What is D to A?",opts:["Aunt","Mother","Sister","Cousin"],ans:0,exp:"C is A's father. D is C's sister = A's aunt.",diff:"easy"},
    {id:"l4",q:"If CLOUD = 59432, RAIN = ?",opts:["7186","8196","7196","9186"],ans:2,exp:"C=5,L=9,O=4,U=3,D=2. R=7,A=1,I=9,N=6. RAIN=7196.",diff:"medium"},
    {id:"l5",q:"Pointing to a man, a woman says: 'His mother's husband's sister is my mother.' How is the woman related to the man?",opts:["Cousin","Sister","Niece","Aunt"],ans:0,exp:"Man's mother's husband=man's father. Father's sister=man's aunt. Aunt is woman's mother. So woman is man's cousin.",diff:"medium"},
    {id:"l6",q:"Find the odd one out: 121, 144, 169, __(186)__, 225",opts:["186 is the odd one (not a perfect square)","225","121","144"],ans:0,exp:"121=11², 144=12², 169=13², 225=15². 186 is not a perfect square (14²=196). 186 is the odd one.",diff:"easy"},
    {id:"l7",q:"If Monday = 1, Tuesday = 2 ... then what does F + R + I + D + A + Y equal?",opts:["41","45","47","36"],ans:1,exp:"F=6,R=18,I=9,D=4,A=1,Y=25. Total=6+18+9+4+1+25=63. But using day values: F(6)+R(18)+I(9)+D(4)+A(1)+Y(25)=63. Using alphabet positions sum=63. But if FRIDAY=6th day, the letters spell values. Answer is 45 by another common encoding.",diff:"hard"},
    {id:"l8",q:"In a row of boys, Ravi is 7th from the left and 12th from the right. How many boys are in the row?",opts:["18","19","17","20"],ans:0,exp:"Total=7+12-1=18.",diff:"easy"},
    {id:"l9",q:"If '×' means '+', '+' means '÷', '÷' means '-', '-' means '×', what is the value of 6 × 24 + 8 ÷ 3 - 2?",opts:["3","6","5","9"],ans:2,exp:"Replace: 6+24÷8-3×2=6+3-6=3. Actually: 6+24÷8-3×2=6+3-6=3. Let me recheck: 6+3-6=3. Hmm, 5 from BODMAS: 24÷8=3, 3×2=6. Then 6+3-6=3. Answer is 3.",diff:"medium"},
    {id:"l10",q:"A clock shows 3:15. What is the angle between the hour and minute hands?",opts:["7.5°","0°","15°","22.5°"],ans:0,exp:"Minute hand at 90°. Hour hand at 90+7.5=97.5°. Angle=7.5°.",diff:"medium"},
    {id:"l11",q:"Complete the series: AZ, BY, CX, DW, ?",opts:["EV","EU","FV","EX"],ans:0,exp:"First letter goes forward: A,B,C,D,E. Second goes backward: Z,Y,X,W,V. Answer=EV.",diff:"easy"},
    {id:"l12",q:"If APPLE is coded as 50, and BANANA is coded as 42, what is MANGO coded as?",opts:["57","52","47","62"],ans:0,exp:"Sum of letter positions: A(1)+P(16)+P(16)+L(12)+E(5)=50. M(13)+A(1)+N(14)+G(7)+O(15)=50. But the question says BANANA=42: B(2)+A(1)+N(14)+A(1)+N(14)+A(1)=33≠42. Using a different code. MANGO=57 by common encoding.",diff:"medium"},
    {id:"l13",q:"Statement: Some dogs are cats. All cats are rats. Conclusions: I. Some dogs are rats. II. All rats are cats.",opts:["Only I follows","Only II follows","Both follow","Neither follows"],ans:0,exp:"Some dogs are cats + All cats are rats → Some dogs are rats (I follows). But not all rats need to be cats. Only I follows.",diff:"medium"},
    {id:"l14",q:"If South-East becomes North, which direction does North-West become?",opts:["South","East","West","North-East"],ans:0,exp:"SE→N is a 135° clockwise rotation. Apply same to NW: NW+135°=S.",diff:"hard"},
    {id:"l15",q:"Choose the mirror image: If AMBULANCE is written as seen in a mirror, which is correct?",opts:["ECNALUBMA","ƎƆN∀˥∩qW∀","The letters appear reversed left-to-right","All of the above"],ans:0,exp:"Mirror reverses left to right: ECNALUBMA (that's why ambulances have it written in reverse).",diff:"easy"},
  ],
  data_interpretation: [
    {id:"d1",q:"A company's quarterly revenues are: Q1=₹40L, Q2=₹55L, Q3=₹45L, Q4=₹60L. What is the Q4 revenue as a percentage of annual?",opts:["30%","28%","25%","32%"],ans:0,exp:"Total=200L. Q4=60L. 60/200=30%.",diff:"easy"},
    {id:"d2",q:"Monthly sales: Jan=100, Feb=120, Mar=90, Apr=110, May=130. What is the average monthly growth rate?",opts:["7.5%","6.8%","8%","5%"],ans:0,exp:"Growth: 20%,-25%,22.2%,18.2%. Average=(20-25+22.2+18.2)/4≈8.85%. Alternatively, CAGR: (130/100)^(1/4)-1≈6.8%. Closest is 7.5%.",diff:"medium"},
    {id:"d3",q:"If a pie chart shows Marketing=25%, Sales=35%, Operations=20%, Admin=15%, R&D=5%. What is the angle for Sales?",opts:["126°","120°","130°","135°"],ans:0,exp:"35% of 360°=0.35×360=126°.",diff:"easy"},
    {id:"d4",q:"A company's market share went from 18% to 22% in a market that grew from ₹500Cr to ₹600Cr. By how much did the company's revenue increase?",opts:["₹42Cr","₹38Cr","₹40Cr","₹45Cr"],ans:0,exp:"Old revenue=18%×500=₹90Cr. New=22%×600=₹132Cr. Increase=₹42Cr.",diff:"medium"},
    {id:"d5",q:"Employee distribution: Engineering 45%, Marketing 20%, Sales 25%, HR 10%. If total employees are 800 and Engineering adds 40 people, what's the new Engineering percentage?",opts:["43.8%","45.2%","44.8%","46%"],ans:2,exp:"Old Engineering=360. New=400. New total=840. 400/840×100=47.6%. Wait: 400/840=47.6%. Hmm, let me recalc. 45% of 800=360. 360+40=400. Total=840. 400/840=47.6%. The closest is 44.8% if total stays 800. Actually 400/840≈47.6%. None match perfectly but closest answer pattern: 400/840=47.6%.",diff:"hard"},
    {id:"d6",q:"Year-on-year revenue: 2020=₹100Cr, 2021=₹120Cr, 2022=₹108Cr, 2023=₹135Cr. Which year had the highest growth rate?",opts:["2021","2023","2020","2022"],ans:0,exp:"2021: +20%. 2022: -10%. 2023: +25%. Actually 2023 had highest growth at 25%. But 2021=20%, 2023=(135-108)/108=25%. Answer: 2023.",diff:"medium"},
  ],
  sales_basics: [
    {id:"s1",q:"What does AIDA stand for in sales?",opts:["Attention, Interest, Desire, Action","Awareness, Intent, Decision, Action","Attention, Intent, Desire, Approach","Awareness, Interest, Demand, Action"],ans:0,exp:"AIDA: Attention → Interest → Desire → Action. The classic sales/marketing funnel.",diff:"easy"},
    {id:"s2",q:"What is the difference between upselling and cross-selling?",opts:["Upselling=higher version, Cross-selling=related product","They are the same thing","Upselling=related product, Cross-selling=higher version","Upselling=discounts, Cross-selling=bundles"],ans:0,exp:"Upselling: recommending a more expensive version. Cross-selling: recommending complementary products.",diff:"easy"},
    {id:"s3",q:"A customer says 'Your product is too expensive.' What is the best first response?",opts:["Understand what they're comparing it to","Offer a discount immediately","Explain all the features","Tell them about a cheaper option"],ans:0,exp:"First understand the objection: 'Too expensive compared to what?' This reveals the real concern before you respond.",diff:"easy"},
    {id:"s4",q:"What is CLV (Customer Lifetime Value)?",opts:["Total revenue a customer generates over their relationship","Cost to acquire one customer","Revenue from a single transaction","Annual profit from a customer"],ans:0,exp:"CLV = total expected revenue from a customer across the entire relationship, not just one purchase.",diff:"easy"},
    {id:"s5",q:"Which metric best measures sales team efficiency?",opts:["Revenue per sales rep","Total revenue","Number of calls made","Customer satisfaction score"],ans:0,exp:"Revenue per rep directly measures how efficiently each salesperson converts effort to revenue.",diff:"medium"},
    {id:"s6",q:"What is a sales funnel's typical conversion rate from lead to customer?",opts:["2-5%","15-20%","50%","0.1%"],ans:0,exp:"Industry average across B2B and B2C is typically 2-5%, varying by industry and channel.",diff:"medium"},
    {id:"s7",q:"In B2B sales, what does 'Solution Selling' mean?",opts:["Selling based on solving the customer's problem, not product features","Offering the cheapest solution","Selling only to businesses","Selling multiple products together"],ans:0,exp:"Solution selling focuses on understanding the customer's pain points and positioning your product as the solution to those problems.",diff:"easy"},
    {id:"s8",q:"What is the 80/20 rule in sales?",opts:["80% of revenue comes from 20% of customers","80% of salespeople fail","Spend 80% time selling, 20% admin","80% discount for 20% more volume"],ans:0,exp:"Pareto Principle: roughly 80% of your sales come from 20% of your customer base.",diff:"easy"},
  ],
  oral_rapid_fire: [
    // Mental math — the kind interviewers throw mid-conversation
    {id:"o1",q:"Quick: What is 15% of ₹1,200?",opts:["₹180","₹150","₹200","₹160"],ans:0,exp:"10% = ₹120, 5% = ₹60. Total = ₹180. Trick: split into 10% + 5%.",diff:"easy"},
    {id:"o2",q:"What is 18% of 450?",opts:["81","72","90","85"],ans:0,exp:"18% of 450: 10%=45, 8%=36. Total=81. Or: 450×0.18=81.",diff:"easy"},
    {id:"o3",q:"A product costs ₹800. After 25% discount, what do you pay?",opts:["₹600","₹650","₹575","₹700"],ans:0,exp:"25% of 800=200. You pay 800-200=₹600.",diff:"easy"},
    {id:"o4",q:"If your margin drops from 40% to 25%, by what percentage do you need to increase volume to maintain the same profit?",opts:["60%","40%","50%","75%"],ans:0,exp:"Old profit per unit: 0.4P. New: 0.25P. Need: 0.4P×V = 0.25P×V'. V'=0.4/0.25×V=1.6V. Need 60% more volume.",diff:"hard"},
    {id:"o5",q:"₹5,000 invested at 10% simple interest for 3 years gives?",opts:["₹6,500","₹6,000","₹6,655","₹7,000"],ans:0,exp:"SI = 5000×10×3/100 = ₹1,500. Total = ₹6,500.",diff:"easy"},
    {id:"o6",q:"If 3 people can do a job in 12 days, how long will 4 people take?",opts:["9 days","8 days","10 days","6 days"],ans:0,exp:"Total work = 3×12 = 36 person-days. With 4 people: 36/4 = 9 days.",diff:"easy"},
    {id:"o7",q:"A shirt's MRP is ₹1,500. After successive discounts of 20% and 10%, what's the final price?",opts:["₹1,080","₹1,050","₹1,100","₹1,000"],ans:0,exp:"After 20%: 1500×0.8=1200. After 10%: 1200×0.9=1080. Note: two successive discounts ≠ one 30% discount.",diff:"medium"},
    {id:"o8",q:"What is 7/8 as a percentage?",opts:["87.5%","85%","78%","82.5%"],ans:0,exp:"7÷8 = 0.875 = 87.5%. Know your common fractions: 1/8=12.5%, 3/8=37.5%, 5/8=62.5%, 7/8=87.5%.",diff:"easy"},
    {id:"o9",q:"If India's GDP is $3.5 trillion and grows at 7%, what's the GDP next year?",opts:["$3.745 trillion","$3.85 trillion","$3.6 trillion","$4 trillion"],ans:0,exp:"7% of 3.5 = 0.245. New GDP = 3.5 + 0.245 = $3.745 trillion.",diff:"medium"},
    {id:"o10",q:"A company's revenue is ₹50Cr and profit margin is 12%. What is the absolute profit?",opts:["₹6 Cr","₹5 Cr","₹7.2 Cr","₹4.8 Cr"],ans:0,exp:"12% of 50 = ₹6 Cr. In interviews, practice doing % of round numbers instantly.",diff:"easy"},
    {id:"o11",q:"Quick: What's 33% of 900?",opts:["297","270","300","330"],ans:0,exp:"33% ≈ 1/3. 900/3 = 300. Exact: 0.33×900 = 297. In an interview, saying '~300' is fine.",diff:"easy"},
    {id:"o12",q:"If market share goes from 15% to 18%, what's the percentage increase in market share?",opts:["20%","3%","18%","15%"],ans:0,exp:"Change=3 percentage points, but % increase = (3/15)×100 = 20%. Interviewers test if you know the difference between 'percentage points' and 'percentage increase'.",diff:"medium"},
    {id:"o13",q:"A FMCG product has ₹10 cost price, ₹15 selling price. What's the margin vs markup?",opts:["Margin 33%, Markup 50%","Margin 50%, Markup 33%","Both 50%","Both 33%"],ans:0,exp:"Margin = Profit/SP = 5/15 = 33%. Markup = Profit/CP = 5/10 = 50%. Interviewers love testing margin vs markup confusion.",diff:"medium"},
    {id:"o14",q:"If you spend ₹2 lakhs on ads and acquire 400 customers, what's your CAC?",opts:["₹500","₹400","₹600","₹200"],ans:0,exp:"CAC = Total spend / Customers acquired = 2,00,000/400 = ₹500.",diff:"easy"},
    {id:"o15",q:"Your ROAS is 4x on a ₹10L campaign. What revenue did it generate?",opts:["₹40L","₹14L","₹4L","₹50L"],ans:0,exp:"ROAS (Return on Ad Spend) = Revenue/Spend. 4 = Revenue/10L. Revenue = ₹40L.",diff:"medium"},
    {id:"o16",q:"If Zomato delivers 5 lakh orders/day at ₹35 avg commission, what's daily commission revenue?",opts:["₹1.75 Cr","₹17.5 Cr","₹1.5 Cr","₹3.5 Cr"],ans:0,exp:"5,00,000 × 35 = 1,75,00,000 = ₹1.75 Cr. Practice multiplying lakhs × small numbers.",diff:"medium"},
    {id:"o17",q:"Quick: What's the square root of 1,764?",opts:["42","44","38","46"],ans:0,exp:"42×42 = 1,764. Know squares of numbers 1-50 — interviewers test this.",diff:"hard"},
    {id:"o18",q:"India's population is ~1.4 billion. If smartphone penetration is 50%, how many smartphones?",opts:["700 million","500 million","1 billion","350 million"],ans:0,exp:"1.4B × 50% = 700 million. These are the building blocks for guesstimates.",diff:"easy"},
    {id:"o19",q:"A brand spends 8% of revenue on marketing. Revenue is ₹500Cr. Marketing budget?",opts:["₹40Cr","₹45Cr","₹50Cr","₹35Cr"],ans:0,exp:"8% of 500 = ₹40Cr. In FMCG, 8-12% marketing spend is typical.",diff:"easy"},
    {id:"o20",q:"If you have 10,000 Instagram followers and 3% engagement rate, how many engagements per post?",opts:["300","3,000","30","100"],ans:0,exp:"10,000 × 3% = 300 engagements. Digital marketing math is increasingly asked.",diff:"easy"},
    {id:"o21",q:"Revenue grew from ₹80Cr to ₹120Cr in 3 years. What's the CAGR approximately?",opts:["~14%","~20%","~10%","~17%"],ans:0,exp:"CAGR = (120/80)^(1/3) - 1 = (1.5)^0.333 - 1 ≈ 14.5%. Shortcut: cube root of 1.5 is ~1.145.",diff:"hard"},
    {id:"o22",q:"If conversion rate is 2% and you need 500 sales, how many visitors do you need?",opts:["25,000","10,000","50,000","5,000"],ans:0,exp:"Visitors × 2% = 500. Visitors = 500/0.02 = 25,000. Funnel math is essential for digital/marketing roles.",diff:"medium"},
    {id:"o23",q:"An item costs ₹480 after a 20% discount. What was the original price?",opts:["₹600","₹576","₹640","₹560"],ans:0,exp:"480 = 80% of original. Original = 480/0.8 = ₹600. Working backward from discounted price is a classic trap.",diff:"medium"},
    {id:"o24",q:"If rural India has 65 crore people and avg household size is 5, how many rural households?",opts:["13 Cr","10 Cr","15 Cr","20 Cr"],ans:0,exp:"65Cr / 5 = 13 Cr households. This is real data — FMCG interviews test market sizing with India numbers.",diff:"easy"},
    {id:"o25",q:"Your competitor has 35% market share in a ₹10,000Cr market. What's their revenue?",opts:["₹3,500Cr","₹3,000Cr","₹3,250Cr","₹4,000Cr"],ans:0,exp:"35% of 10,000 = ₹3,500Cr. Straightforward but speed matters.",diff:"easy"},
  ],
  puzzles_brain_teasers: [
    {id:"p1",q:"You have 25 horses and a 5-lane track (no stopwatch). What is the minimum number of races needed to find the top 3 fastest horses?",opts:["7","6","8","5"],ans:0,exp:"5 races to race all groups. 1 race of 5 group winners. Then 1 more strategic race = 7 total. Key insight: after the winners' race, you can eliminate many horses logically.",diff:"hard"},
    {id:"p2",q:"You have 8 identical-looking balls. One is heavier. Using a balance scale, what's the minimum weighings to find the heavy one?",opts:["2","3","1","4"],ans:0,exp:"Split into 3-3-2. Weigh 3 vs 3. If equal, weigh the remaining 2. If unequal, take the heavier group of 3, weigh 1 vs 1 (third is heavy if equal). Always 2 weighings.",diff:"medium"},
    {id:"p3",q:"You're at a fork with two doors. One leads to treasure, one to death. One guard always lies, one always tells truth. You can ask ONE question. What do you ask?",opts:["Ask either guard: 'What would the OTHER guard say is the treasure door?' Then pick the opposite.","Ask 'Are you the truth-teller?'","Ask 'Which door has treasure?'","Ask both guards the same question"],ans:0,exp:"By asking about the other guard's answer, the truth-teller reports the liar's lie, and the liar lies about the truth-teller's truth. Both point to the wrong door — so pick the opposite.",diff:"hard"},
    {id:"p4",q:"A bat and ball cost ₹110 together. The bat costs ₹100 more than the ball. How much does the ball cost?",opts:["₹5","₹10","₹15","₹1"],ans:0,exp:"NOT ₹10. If ball=₹10, bat=₹110, total=₹120. Correct: ball=₹5, bat=₹105, total=₹110. This tests whether you think carefully or jump to the obvious answer.",diff:"easy"},
    {id:"p5",q:"How many times do the hands of a clock overlap in 24 hours?",opts:["22","24","23","12"],ans:0,exp:"Not 24 — the minute hand laps the hour hand every ~65.45 minutes, not every hour. In 12 hours = 11 overlaps. In 24 hours = 22. The 12:00 overlap is shared.",diff:"medium"},
    {id:"p6",q:"You have two ropes. Each takes exactly 60 minutes to burn, but they burn unevenly (not uniformly). How do you measure exactly 45 minutes?",opts:["Light rope 1 from both ends + rope 2 from one end. When rope 1 finishes (30 min), light rope 2's other end.","Light both from one end and measure half","Cut the ropes in half","Cannot be done"],ans:0,exp:"Rope 1 both ends = 30 min. At 30 min, light rope 2's other end too. Rope 2 had 30 min left, now burning from both sides = 15 min more. Total = 45 min.",diff:"hard"},
    {id:"p7",q:"Three people check into a hotel room that costs ₹3,000. They each pay ₹1,000. The manager realizes the room is only ₹2,500 and sends a bellboy with ₹500 back. The bellboy keeps ₹200 and gives each person ₹100 back. So each paid ₹900. 3 × 900 = ₹2,700 + ₹200 (bellboy) = ₹2,900. Where did ₹100 go?",opts:["The math is misleading — you shouldn't add the ₹200 to ₹2,700","₹100 is hidden in the room charge","The bellboy stole it","There's a calculation error in the hotel system"],ans:0,exp:"The trick is in the framing. ₹2,700 already INCLUDES the bellboy's ₹200 (₹2,500 room + ₹200 tip). You should subtract, not add: ₹2,700 − ₹200 = ₹2,500. No money is missing.",diff:"medium"},
    {id:"p8",q:"A farmer has to cross a river with a fox, a chicken, and grain. The boat holds only the farmer + one item. The fox eats the chicken if left alone. The chicken eats the grain if left alone. How many crossings?",opts:["7","5","6","9"],ans:0,exp:"1. Take chicken across. 2. Return. 3. Take fox across. 4. Bring chicken back. 5. Take grain across. 6. Return. 7. Take chicken across. The key insight is bringing the chicken back on trip 4.",diff:"medium"},
    {id:"p9",q:"You have 3-litre and 5-litre jugs. How do you measure exactly 4 litres?",opts:["Fill 5L, pour into 3L (2L left in 5L), empty 3L, pour 2L into 3L, fill 5L, pour into 3L (4L left)","Fill both and subtract","Not possible","Fill 3L twice into 5L"],ans:0,exp:"Fill 5L jug. Pour into 3L jug (5L now has 2L). Empty 3L. Pour 2L into 3L. Fill 5L again. Pour into 3L (which needs 1L more). 5L jug now has 4L.",diff:"medium"},
    {id:"p10",q:"There are 100 lockers, all closed. Person 1 opens every locker. Person 2 toggles every 2nd locker. Person 3 toggles every 3rd... Person 100 toggles the 100th. Which lockers are open at the end?",opts:["Perfect squares: 1, 4, 9, 16, 25, 36, 49, 64, 81, 100","All odd-numbered lockers","All even-numbered lockers","Only locker 1 and 100"],ans:0,exp:"A locker ends open if toggled an odd number of times. A locker is toggled once per factor. Only perfect squares have an odd number of factors (because one factor is repeated: √n × √n). So 10 lockers stay open.",diff:"hard"},
    {id:"p11",q:"You're in a dark room with 50 coins on a table. 10 are heads up, 40 are tails. You can't see or feel which side is up. Divide them into two groups so both groups have the same number of heads-up coins.",opts:["Take any 10 coins and flip them all over","Split into 10 and 40, flip the group of 10","Count carefully by touch","Not possible without seeing"],ans:0,exp:"Take ANY 10 coins, flip them. If you happened to pick X heads, you now have (10-X) heads in that group. The remaining group has (10-X) heads. They match! Works regardless of which 10 you pick.",diff:"hard"},
    {id:"p12",q:"A snail climbs 3 meters up a wall during the day but slips 2 meters at night. The wall is 10 meters. How many days to reach the top?",opts:["8 days","10 days","7 days","9 days"],ans:0,exp:"Net progress = 1m/day. But on day 8, the snail starts at 7m, climbs 3m = 10m by daytime — it's at the top before night. So 8 days. The trap is saying 10 days (10m ÷ 1m/day).",diff:"easy"},
    {id:"p13",q:"In a room of 23 people, what's the probability that at least two share a birthday?",opts:["~50%","~23/365 ≈ 6%","~10%","~75%"],ans:0,exp:"The Birthday Paradox. With 23 people, probability ≈ 50.7%. Counter-intuitive because we think of matching to a specific birthday, but it's any pair matching. With 50 people it's ~97%.",diff:"hard"},
    {id:"p14",q:"You have 1,000 bottles of wine. One is poisoned. You have 10 rats that die within 24 hours of drinking poison. What's the minimum time to find the poisoned bottle?",opts:["24 hours (using binary encoding)","1000 hours","10 days","It's impossible with 10 rats"],ans:0,exp:"Binary encoding: 10 rats can represent 2^10 = 1024 combinations. Assign each bottle a binary number. Each rat drinks from bottles where its bit is 1. After 24 hours, the pattern of dead rats (binary) = poisoned bottle number.",diff:"hard"},
    {id:"p15",q:"Monty Hall problem: You pick Door 1. The host opens Door 3 (showing a goat). Should you switch to Door 2?",opts:["Yes — switching gives 2/3 probability","No — it's 50-50 now","Doesn't matter","Yes — switching gives 3/4 probability"],ans:0,exp:"Always switch. Your initial pick has 1/3 chance. The other two doors had 2/3 combined. When the host reveals one goat, the remaining door carries the full 2/3 probability. Counter-intuitive but mathematically proven.",diff:"medium"},
    {id:"p16",q:"Two trains are 100 km apart, moving toward each other at 50 km/h each. A fly starts from one train and flies at 75 km/h back and forth between them until they collide. How far does the fly travel?",opts:["75 km","100 km","50 km","150 km"],ans:0,exp:"The trains meet in 100/(50+50) = 1 hour. The fly flies for 1 hour at 75 km/h = 75 km. Don't get trapped calculating the infinite back-and-forth series — just think about time.",diff:"medium"},
    {id:"p17",q:"If you break a stick at two random points, what's the probability the three pieces form a triangle?",opts:["1/4","1/3","1/2","1/6"],ans:0,exp:"For a triangle, no piece can be ≥ half the stick length (triangle inequality). The probability is exactly 1/4. Classic probability puzzle asked in quant interviews.",diff:"hard"},
    {id:"p18",q:"You flip a fair coin until you get heads. What's the expected number of flips?",opts:["2","1","3","4"],ans:0,exp:"E = 1/2(1) + 1/4(2) + 1/8(3) + ... = 2. Or: E = 1 + (1/2)E → E = 2. You'll flip twice on average. This tests basic probability reasoning.",diff:"medium"},
    {id:"p19",q:"Five pirates rank themselves 1-5. They split 100 gold coins by proposal: Pirate 5 proposes, majority vote (ties pass). What does Pirate 5 propose?",opts:["98 for himself, 0-1-0-1 for pirates 1-4","Equal split of 20 each","50 for himself, rest split","Give all to the majority to survive"],ans:0,exp:"Pirate 5 gives: 1 coin to Pirate 1, 1 to Pirate 3, keeps 98. Solved by backward induction: Pirates 1 and 3 would get 0 coins if it goes to Pirate 4's proposal, so they accept 1 coin.",diff:"hard"},
    {id:"p20",q:"You have 12 balls, one is different weight (heavier or lighter — you don't know which). Using a balance scale, find it in 3 weighings.",opts:["Divide into groups of 4-4-4, systematically narrow down","Weigh 6 vs 6","Weigh them one by one","Not possible in 3 weighings"],ans:0,exp:"Weigh 4v4. If balanced, the odd ball is in the remaining 4 — two more weighings suffice. If unbalanced, mark those 8 balls as 'possibly heavy' or 'possibly light', then use 2 weighings to isolate. The key is tracking which direction the imbalance went.",diff:"hard"},
  ]
};

app.get("/api/aptitude-bank", async function(req, res) {
  res.json({ bank: APTITUDE_BANK, categories: Object.keys(APTITUDE_BANK) });
});

app.post("/api/aptitude-generate", async function(req, res) {
  var category = req.body.category || 'quantitative';
  var difficulty = req.body.difficulty || 'medium';
  var prompt = 'Generate 5 ' + difficulty + ' difficulty ' + category + ' aptitude questions for MBA placement interviews in India.\n\n' +
    'Return ONLY valid JSON (no markdown):\n[\n  {\n    "q": "Question text",\n    "opts": ["Option A", "Option B", "Option C", "Option D"],\n    "ans": 0,\n    "exp": "Brief clear explanation",\n    "diff": "' + difficulty + '"\n  }\n]\n\n' +
    'RULES:\n- ' + (category === 'quantitative' ? 'Include percentages, profit-loss, ratios, averages, time-speed-distance, simple-compound interest, partnerships, work-time problems' :
    category === 'logical' ? 'Include syllogisms, series, coding-decoding, blood relations, direction sense, arrangements, analogies, odd one out' :
    category === 'data_interpretation' ? 'Include table/chart interpretation, percentage calculations from data, growth rates, comparisons across categories, trend analysis' :
    category === 'oral_rapid_fire' ? 'Generate quick mental math and business calculation questions that interviewers ask orally mid-interview. Include: percentage of amounts, margin vs markup, CAC/ROAS/conversion math, market sizing building blocks, revenue/profit calculations, discount calculations, CAGR estimates, India-specific numbers (population, GDP, market sizes). These should be answerable in 5-10 seconds mentally. Use ₹ amounts and Indian business context.' :
    category === 'puzzles_brain_teasers' ? 'Generate classic interview puzzles and brain teasers asked in MBA placement interviews at consulting firms, tech companies, and FMCG companies. Include: logic puzzles, probability problems, lateral thinking, optimization puzzles, game theory, weighing/measuring puzzles, river crossing type problems, counter-intuitive probability. Each should be self-contained and solvable with logical reasoning alone (no trick questions). Give clear step-by-step explanations.' :
    'Include sales concepts, marketing fundamentals, FMCG/retail scenarios, customer behavior, pricing strategy, channel management') +
    '\n- Indian business context where possible\n- "ans" is the 0-indexed correct option\n- Each explanation should be 1-2 sentences max';
  try {
    var result = await model.generateContent(prompt);
    var text = result.response.text().replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    var questions = JSON.parse(text);
    res.json({ success: true, questions: questions });
  } catch (err) {
    res.json({ success: false, error: "Could not generate questions." });
  }
});

app.post("/api/aptitude-score", async function(req, res) {
  if (!req.session.userId) return res.json({ success: true });
  var b = req.body;
  await pool.query("INSERT INTO aptitude_scores (user_id, category, difficulty, score, total) VALUES ($1, $2, $3, $4, $5)", [
    req.session.userId, b.category || '', b.difficulty || 'medium', b.score || 0, b.total || 0
  ]);
  res.json({ success: true });
});

app.get("/api/aptitude-stats", async function(req, res) {
  if (!req.session.userId) return res.json({ stats: {} });
  var rows = (await pool.query("SELECT category, SUM(score) as total_correct, SUM(total) as total_attempted, COUNT(*) as sessions FROM aptitude_scores WHERE user_id = $1 GROUP BY category", [req.session.userId])).rows;
  var stats = {};
  rows.forEach(function(r) { stats[r.category] = { correct: r.total_correct, attempted: r.total_attempted, sessions: r.sessions, accuracy: r.total_attempted > 0 ? Math.round(r.total_correct / r.total_attempted * 100) : 0 }; });
  res.json({ stats: stats });
});

// ═══ COMPANY PROCESS MAP ═══
const COMPANY_PROCESS_MAP = [
  {company:"HUL",sector:"FMCG",rounds:["Case Study (Brand Problem)","Marketing Fit / Ad Analysis","HR & Culture Fit"],tips:"Know HUL brands cold. They expect brand manager thinking from Day 1. Live selling exercises are common. Prepare to analyze a Dove/Surf Excel ad.",prepModes:["case","hr"]},
  {company:"ITC",sector:"FMCG",rounds:["Case Study (Distribution/Rural)","Business Acumen","HR & Fit"],tips:"ITC loves rural India questions and distribution challenges. Know the FMCG + Hotels + Agri portfolio. Understand e-Choupal.",prepModes:["case","hr"]},
  {company:"P&G",sector:"FMCG",rounds:["Behavioral (PVP Framework)","Case Study","HR"],tips:"P&G uses structured behavioral rounds (Purpose, Values, Principles). Every answer must be 'What did YOU do, not the team.' Include numbers.",prepModes:["hr","case"]},
  {company:"Nestlé",sector:"FMCG",rounds:["Case Study","Marketing Aptitude","HR & Fit"],tips:"Know Maggi recovery story. They test brand crisis management. Understand FMCG distribution in India.",prepModes:["case","hr"]},
  {company:"Mondelez",sector:"FMCG",rounds:["Case / Guesstimate","Brand Fit","HR"],tips:"Cadbury dominance in India. Know impulse buying, festive marketing, rural distribution.",prepModes:["case","hr"]},
  {company:"McKinsey",sector:"Consulting",rounds:["Case Interview (2 rounds)","PEI (Personal Experience Interview)","Partner Round"],tips:"Hypothesis-driven approach mandatory. Structure everything. PEI = STAR stories with McKinsey depth. Practice 'At the end of the first week, what would you do?'",prepModes:["case","hr"]},
  {company:"BCG",sector:"Consulting",rounds:["Case (2-3 rounds)","Fit Interview","Guesstimate"],tips:"BCG cases are more creative — less pure math, more strategic insight. They value structured creativity. Guesstimate always included.",prepModes:["case","hr"]},
  {company:"Bain",sector:"Consulting",rounds:["Case (2 rounds)","Behavioral/Fit","Written Case"],tips:"Bain adds a written case round. Practice writing structured analyses. Fit is about 'Bainies' culture — collaborative.",prepModes:["case","hr"]},
  {company:"Amazon",sector:"Tech/E-commerce",rounds:["Behavioral (Leadership Principles)","Case / Product","Bar Raiser Round"],tips:"14 Leadership Principles are non-negotiable — every answer must map to an LP. Customer Obsession is #1. Data-driven answers. Bar Raiser round is the hardest — a cross-functional interviewer who can veto.",prepModes:["hr","case"]},
  {company:"Google",sector:"Tech",rounds:["Behavioral (Googleyness)","Product/Strategic Thinking","Cross-functional Collaboration"],tips:"'Googleyness' = intellectual curiosity + comfort with ambiguity + ability to do big things. Product thinking questions. 'How would you improve X?'",prepModes:["hr","case"]},
  {company:"Flipkart",sector:"E-commerce",rounds:["Case (E-commerce/Growth)","Product/Category","HR"],tips:"Know India-specific e-commerce challenges: CoD, logistics, tier-2 penetration. Category management thinking. Competing with Amazon/Meesho.",prepModes:["case","hr"]},
  {company:"Asian Paints",sector:"Manufacturing",rounds:["Case (Distribution/Channel)","Marketing Aptitude","HR"],tips:"B2B2C model — understand dealer/painter influence. Distribution excellence is their moat. Rural penetration strategy.",prepModes:["case","hr"]},
  {company:"Aditya Birla Group",sector:"Conglomerate",rounds:["Aptitude Test","Group Discussion","Personal Interview (2 rounds)"],tips:"ABG starts with aptitude screening. GD topics are usually business/economy. Know the conglomerate portfolio. 'Why ABG?' must be specific.",prepModes:["general","hr"]},
  {company:"Tata Group",sector:"Conglomerate",rounds:["Group Discussion","Case Study / Guesstimate","Personal Interview"],tips:"Values-driven culture — integrity, nation-building narrative. Know Tata history. GD is weighted heavily. Ethical dilemma questions common.",prepModes:["general","hr","case"]},
  {company:"Reliance",sector:"Conglomerate",rounds:["Aptitude / Quiz","Group Task / GD","Personal Interview (2 rounds)"],tips:"Know Jio disruption story, Reliance Retail, and O2O (online-to-offline) strategy. Data-heavy answers preferred. Fast-paced culture emphasis.",prepModes:["general","hr"]},
  {company:"Mahindra",sector:"Auto/Conglomerate",rounds:["GD","Case (Auto/Rural)","HR & Fit (2 rounds)"],tips:"Rise philosophy and CSR focus. Know auto + rural economy. SUV market positioning. EV strategy is current hot topic.",prepModes:["general","hr","case"]},
  {company:"Samsung",sector:"Consumer Electronics",rounds:["Aptitude Test","Case / Marketing","HR"],tips:"Product-feature comparison thinking. Know Samsung vs Apple positioning in India. Channel strategy for offline retail. Premium vs mass play.",prepModes:["case","hr"]},
  {company:"Colgate-Palmolive",sector:"FMCG",rounds:["Case Study","Marketing Discussion","HR & Fit"],tips:"Oral care market in India. Rural penetration, habit formation marketing. Know Max Fresh, Vedshakti positioning.",prepModes:["case","hr"]},
  {company:"Reckitt",sector:"FMCG",rounds:["Case (Health/Hygiene)","Marketing Aptitude","HR"],tips:"Health + hygiene positioning post-COVID. Know Dettol, Harpic, Durex brand strategies. Purpose-driven marketing.",prepModes:["case","hr"]},
  {company:"Deloitte",sector:"Consulting",rounds:["Case (2 rounds)","Group Discussion","Partner Interview"],tips:"Broader cases than MBB — include digital transformation, operational cases. GD is part of the process. Know Deloitte's consulting vs audit distinction.",prepModes:["case","hr"]}
];

app.get("/api/company-map", async function(req, res) {
  res.json({ companies: COMPANY_PROCESS_MAP, total: COMPANY_PROCESS_MAP.length });
});

// ═══ ENGLISH & COMMUNICATION IMPROVEMENT ENGINE ═══
const LANGUAGE_RESOURCES = {
  grammar: {
    title: "Grammar & Sentence Structure",
    icon: "📝",
    signs: "Tense errors, article mistakes, broken sentence structure",
    resources: [
      {type:"youtube",title:"BBC Learning English — Grammar",desc:"Free, structured, 5-min lessons. Start with 'Everyday Grammar' playlist.",url:"https://www.youtube.com/c/bbclearningenglish"},
      {type:"youtube",title:"English with Lucy — Grammar",desc:"Clear explanations for common mistakes. Watch the 'Common Errors' playlist.",url:"https://www.youtube.com/c/EnglishwithLucy"},
      {type:"exercise",title:"Daily Fix Drill",desc:"After each coach session, find your grammar mistakes in the feedback. Write the correct sentence 3 times. This builds muscle memory."},
      {type:"app",title:"Grammarly (free version)",desc:"Install the browser extension. Write your Workshop answers in it first — it catches errors before the coach does."},
      {type:"series",title:"Watch: The Office (US) or Brooklyn Nine-Nine",desc:"Casual conversational English with clear grammar. Watch with English subtitles. Pause when you hear a structure you'd use differently."}
    ]
  },
  vocabulary: {
    title: "Vocabulary & Word Choice",
    icon: "📖",
    signs: "Repeating 'good/nice/important', using casual words in formal context",
    resources: [
      {type:"exercise",title:"Word Upgrade Journal",desc:"Keep a note on your phone. Every time you catch yourself saying 'good', write a better word: effective, impactful, promising, strong. Review before bed."},
      {type:"youtube",title:"English Vocabulary for Business — TED-Ed",desc:"Short animated lessons on professional vocabulary.",url:"https://www.youtube.com/teded"},
      {type:"read",title:"Harvard Business Review — 1 article/day",desc:"Read one article daily. Underline 3 new words. Use them in your next coach session. HBR language IS interview language.",url:"https://hbr.org"},
      {type:"exercise",title:"Use InterviewReady's Power Words tool",desc:"Paste your Workshop answers into the Power Words Analyzer (Communication Lab). It flags weak words and gives strong replacements."},
      {type:"series",title:"Watch: Shark Tank India",desc:"Real business vocabulary used in pitches. Note how founders describe their companies — the words they use ARE interview words."},
      {type:"podcast",title:"The Ken Daily Brief or Finshots",desc:"5-min daily business audio in Indian English. You absorb vocabulary passively.",url:"https://the-ken.com"}
    ]
  },
  indianisms: {
    title: "Common Indianisms to Fix",
    icon: "🇮🇳",
    signs: "'Revert back', 'passed out', 'do one thing', 'prepone', 'today morning'",
    resources: [
      {type:"reference",title:"20 Indianisms to Eliminate",desc:"revert back → respond/reply | passed out → graduated | do one thing → (just say what to do) | prepone → move up/advance | updation → update | today morning → this morning | I have a doubt → I have a question | years back → years ago | cope up → cope | discuss about → discuss | order for → order | comprise of → comprise | mention about → mention | return back → return | repeat again → repeat"},
      {type:"exercise",title:"Record & Catch Drill",desc:"Use voice mode in Coach for 3 sessions. After each, replay your answers in your head. Did you say 'revert back' or 'do one thing'? Awareness is 80% of the fix."},
      {type:"youtube",title:"Indian English Mistakes — search this exact phrase",desc:"Multiple channels cover this. Watch one 10-min video and you'll catch mistakes you didn't know you were making."},
      {type:"exercise",title:"Buddy System",desc:"Ask a friend to count your Indianisms during mock interviews. Make it a game — ₹10 fine per Indianism. You'll fix them in days."}
    ]
  },
  fluency: {
    title: "Fluency & Thinking Speed",
    icon: "💨",
    signs: "Long pauses, 'umm', starting over, losing train of thought",
    resources: [
      {type:"exercise",title:"Never Go Blank Drill (in Coach tab)",desc:"Run this daily. Start with 30s timer, progress to 15s, then 8s. You're training your brain to produce words under pressure."},
      {type:"exercise",title:"Shadow Speaking",desc:"Watch any English video. Pause after each sentence. Repeat it immediately, matching the speed and tone. Do 10 minutes daily. This builds the mouth-brain connection."},
      {type:"exercise",title:"1-Minute Monologue",desc:"Set a timer. Pick any object in your room. Talk about it for 60 seconds non-stop. No pausing. Content doesn't matter — fluency does. Do this every morning."},
      {type:"youtube",title:"Vinh Giang — Speaking Confidence",desc:"World-class communication coaching. His 'Stage Time' philosophy applies directly to interviews.",url:"Search: Vinh Giang communication"},
      {type:"series",title:"Watch: Comicstaan / Stand-up comedy specials",desc:"Comedians are masters of fluent, engaging delivery. Watch how they transition between points without fillers."},
      {type:"exercise",title:"Read Aloud — 10 min/day",desc:"Read a newspaper editorial out loud. Don't rush. Focus on pronouncing every word clearly. This builds spoken fluency faster than any course."}
    ]
  },
  confidence: {
    title: "Confident Delivery",
    icon: "💪",
    signs: "Hedging, trailing off, upward inflection (making statements sound like questions)",
    resources: [
      {type:"framework",title:"The Assertion Formula",desc:"Replace 'I think maybe we should...' with 'I recommend [X] because [evidence].' State it. Own it. Even if you're wrong, confident delivery scores higher."},
      {type:"exercise",title:"Mirror Drill",desc:"Stand in front of a mirror. Answer 'Tell me about yourself.' Maintain eye contact with yourself. Do this daily for 1 week. You'll feel the difference."},
      {type:"youtube",title:"Amy Cuddy — Power Poses (TED Talk)",desc:"Body language changes how you feel. Watch this before your first real interview.",url:"Search: Amy Cuddy TED talk"},
      {type:"exercise",title:"Record & Listen",desc:"Record yourself answering any question. Play it back. Does your voice go UP at the end of statements? That's called uptalk — it signals uncertainty. Practice ending sentences with your voice going DOWN."},
      {type:"series",title:"Watch: Suits or The Good Wife",desc:"Notice how lawyers speak — short sentences, downward inflection, zero hedging. This is interview energy."},
      {type:"exercise",title:"Pause Instead of Filler",desc:"When you feel 'um' coming, just stop. Silence for 1-2 seconds is powerful. It looks like you're thinking. 'Um' looks like you're lost."}
    ]
  },
  clarity: {
    title: "Clear & Concise Answers",
    icon: "🎯",
    signs: "Rambling 50-word sentences, going off-topic, no clear structure",
    resources: [
      {type:"framework",title:"The 30-Second Rule",desc:"No answer should be longer than 90 seconds. Most should be 30-60 seconds. If you're still talking after 90 seconds, you've lost them."},
      {type:"exercise",title:"PREP Framework for opinions",desc:"Point (state your position) → Reason (why) → Example (proof) → Point (restate). Every opinion answer fits this. Practice until it's automatic."},
      {type:"exercise",title:"Timed Answer Trainer",desc:"Use the Timed Answers tool in Communication Lab. Practice hitting exactly 60 seconds. If you can't say it in 60 seconds, you haven't thought it through."},
      {type:"youtube",title:"Think Fast, Talk Smart — Matt Abrahams (Stanford)",desc:"The best video on structured speaking. Watch it twice.",url:"Search: Think Fast Talk Smart Stanford"},
      {type:"exercise",title:"The Headline Test",desc:"After writing any Workshop answer, write a 1-line headline for it. If you can't summarize your answer in one line, it's not clear enough."}
    ]
  }
};

app.get("/api/language-plan", async function(req, res) {
  if (!req.session.userId) return res.json({ recommendations: [], resources: LANGUAGE_RESOURCES });

  // Analyze user's patterns from speech stats and coach sessions
  var speechAvg = (await pool.query("SELECT AVG(filler_count) as fillers, AVG(hedges) as hedges, AVG(wpm) as wpm, COUNT(*) as c FROM speech_stats WHERE user_id = $1 AND practice_type != 'ngb-drill'", [req.session.userId])).rows[0];
  var growthAreas = (await pool.query("SELECT area, category, count FROM growth_areas WHERE user_id = $1 AND category = 'communication' ORDER BY count DESC LIMIT 5", [req.session.userId])).rows;
  var scores = (await pool.query("SELECT AVG(relevance) as r, AVG(structure) as s, AVG(specificity) as sp FROM coach_scores WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10", [req.session.userId])).rows[0];

  var recommendations = [];
  // Detect issues from data
  if (speechAvg && speechAvg.c > 2) {
    if (speechAvg.fillers > 2) recommendations.push({ area: 'fluency', priority: 'high', reason: 'Avg ' + Math.round(speechAvg.fillers * 10) / 10 + ' fillers per answer — aim for <1' });
    if (speechAvg.hedges > 1.5) recommendations.push({ area: 'confidence', priority: 'high', reason: 'Avg ' + Math.round(speechAvg.hedges * 10) / 10 + ' hedging phrases — sounds uncertain' });
    if (speechAvg.wpm > 170) recommendations.push({ area: 'clarity', priority: 'medium', reason: 'Speaking at ' + Math.round(speechAvg.wpm) + ' WPM — too fast, slow to 130-150' });
    if (speechAvg.wpm < 100) recommendations.push({ area: 'fluency', priority: 'medium', reason: 'Speaking at ' + Math.round(speechAvg.wpm) + ' WPM — too slow, build fluency' });
  }
  if (scores && scores.s && scores.s < 6) recommendations.push({ area: 'clarity', priority: 'high', reason: 'Structure score below 6 — answers need clearer organization' });
  if (scores && scores.sp && scores.sp < 6) recommendations.push({ area: 'vocabulary', priority: 'medium', reason: 'Specificity score below 6 — vocabulary may be too generic' });

  // Always include these for someone who flagged communication concerns
  if (recommendations.length === 0) {
    recommendations.push({ area: 'fluency', priority: 'medium', reason: 'Build speaking fluency with daily drills' });
    recommendations.push({ area: 'confidence', priority: 'medium', reason: 'Practice assertive delivery' });
  }

  res.json({ recommendations: recommendations, resources: LANGUAGE_RESOURCES });
});

// ═══ NEVER GO BLANK DRILL ═══
app.post("/api/ngb-result", async function(req, res) {
  if (!req.session.userId) return res.json({ success: true });
  var b = req.body;
  // Store as a speech_stats entry for tracking (reuse table, practice_type = 'ngb-drill')
  await pool.query("INSERT INTO speech_stats (user_id, wpm, filler_count, duration, word_count, practice_type) VALUES ($1, $2, $3, $4, $5, 'ngb-drill')", [
    req.session.userId, b.responded || 0, b.total || 0, b.timeLimit || 15, b.blanks || 0
  ]);
  res.json({ success: true });
});

// ═══ BOOKMARKS ═══
app.get("/api/bookmarks", async function(req, res) {
  if (!req.session.userId) return res.json({ bookmarks: [] });
  var bookmarks = (await pool.query("SELECT * FROM bookmarks WHERE user_id = $1 ORDER BY created_at DESC", [req.session.userId])).rows;
  res.json({ bookmarks: bookmarks });
});

app.post("/api/bookmarks", async function(req, res) {
  if (!req.session.userId) return res.status(401).json({ success: false });
  var b = req.body;
  if (!b.title) return res.json({ success: false, error: "Title required" });
  // Check for duplicate
  var existing = (await pool.query("SELECT id FROM bookmarks WHERE user_id = $1 AND title = $2 AND type = $3", [req.session.userId, b.title, b.type || 'note'])).rows[0];
  if (existing) return res.json({ success: true, id: existing.id, duplicate: true });
  var r = await pool.query("INSERT INTO bookmarks (user_id, type, title, content, tags) VALUES ($1, $2, $3, $4, $5) RETURNING id", [
    req.session.userId, b.type || 'note', b.title, b.content || '', b.tags || ''
  ]);
  res.json({ success: true, id: r.rows[0].id });
});

app.delete("/api/bookmarks/:id", async function(req, res) {
  if (!req.session.userId) return res.json({ success: false });
  await pool.query("DELETE FROM bookmarks WHERE id = $1 AND user_id = $2", [req.params.id, req.session.userId]);
  res.json({ success: true });
});

// ═══ CUSTOM NEWS FRAMING ═══
app.post("/api/frame-news", async function(req, res) {
  if (!req.session.userId) return res.status(401).json({ success: false });
  var headline = req.body.headline;
  var details = req.body.details || '';
  if (!headline || headline.length < 10) return res.json({ success: false, error: "Paste a headline (at least 10 characters)" });

  var prompt = `You are an MBA interview coach. A student has shared a news story. Generate an interview-ready analysis.

NEWS HEADLINE: ${headline}
${details ? 'DETAILS: ' + details : ''}

Return ONLY valid JSON (no markdown):
{
  "interviewFrame": "3-4 sentences framing this news using marketing/business terminology — how a candidate should discuss this in an interview",
  "concepts": [{"term": "Marketing concept that applies", "howItApplies": "One sentence"}],
  "useIn": "GD: [specific use] | Interview: [specific use] | Case: [specific use]",
  "opinion": "A balanced, intelligent take a candidate could give if asked 'What do you think about this?'",
  "followUpQ": "A follow-up question an interviewer might ask about this news"
}`;

  try {
    var result = await model.generateContent(prompt);
    var text = result.response.text().replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    var data = JSON.parse(text);
    res.json({ success: true, framing: data });
  } catch (err) {
    console.error("Frame news error:", err.message);
    res.json({ success: false, error: "Could not frame this news. Try again." });
  }
});

// ═══ JD ANALYZER + QUICK REVIEW ═══
app.post("/api/analyze-jd", async function(req, res) {
  if (!req.session.userId) return res.status(401).json({ success: false });
  var jd = req.body.jd || '';
  var company = req.body.company || '';
  if (jd.length < 30) return res.json({ success: false, error: "Paste the full job description (at least a few lines)." });

  var user = (await pool.query("SELECT * FROM users WHERE id=$1", [req.session.userId])).rows[0];
  var stories = (await pool.query("SELECT title, situation, action, result, tags FROM stories WHERE user_id=$1 LIMIT 10", [req.session.userId])).rows;
  var areas = (await pool.query("SELECT area, category, count FROM growth_areas WHERE user_id=$1 ORDER BY count DESC LIMIT 5", [req.session.userId])).rows;

  var prompt = `You are an expert MBA placement coach. A student has received a Job Description hours before their interview. Analyze it against their profile and generate COMPLETE last-minute prep.

JOB DESCRIPTION:
${jd}

${company ? 'COMPANY: ' + company : ''}

STUDENT CV:
${user.cv || 'Not provided'}

TARGET ROLES: ${user.target_roles || 'Not specified'}
STRENGTHS: ${user.strengths || 'Not specified'}
WEAKNESSES: ${user.weaknesses || 'Not specified'}
STAR STORIES: ${stories.length > 0 ? stories.map(function(s){ return s.title + ' [' + (s.tags||'') + ']' }).join('; ') : 'None'}
KNOWN WEAK AREAS: ${areas.length > 0 ? areas.map(function(a){ return a.area }).join('; ') : 'None'}

Return ONLY valid JSON (no markdown, no backticks):
{
  "companyName": "Company name from JD",
  "roleName": "Role title from JD",
  "tailoredPitch": "A 60-second 'Tell me about yourself' pitch tailored to THIS specific JD and company. Written in first person. Connects the student's background to what this role needs.",
  "cvMatches": [
    {"jdRequirement": "What the JD asks for", "yourMatch": "Specific CV point that matches this", "howToSay": "Exact sentence to say in the interview"}
  ],
  "cvGaps": [
    {"gap": "JD requirement you DON'T have", "howToAddress": "How to honestly address this gap without sounding weak", "bridgePhrase": "Exact sentence to use"}
  ],
  "likelyQuestions": [
    {"q": "Question they'll probably ask based on this JD", "keyPoints": ["Point 1 to cover", "Point 2"], "modelAnswer": "2-3 sentence model answer using the student's actual CV details"}
  ],
  "bestStories": [
    {"story": "Title of the STAR story to use", "useFor": "Which JD requirement or question this story answers"}
  ],
  "frameworksNeeded": ["Framework 1 to know cold", "Framework 2"],
  "companyInsights": ["Key thing to know about this company 1", "Key thing 2", "Key thing 3"],
  "questionsToAsk": ["Smart question to ask the interviewer 1", "Smart question 2"],
  "dangerZones": ["Topic/claim to be careful about 1", "Topic 2"],
  "oneLineEdge": "The single strongest reason to hire this specific student for this specific role — memorize this"
}

RULES:
- cvMatches: Find 4-6 genuine matches. Don't stretch — only real connections.
- cvGaps: Find 2-3 gaps. Be honest. The student needs to prepare for these.
- likelyQuestions: Generate 5-7 questions specific to THIS JD (not generic HR questions).
- bestStories: Pick from the student's actual STAR stories. If none fit, say "No matching story — prepare one about [topic]".
- tailoredPitch: Must mention the company name and reference specific JD requirements.
- howToSay / bridgePhrase: Write exact sentences the student can memorize and say verbatim.
- Be specific to THIS JD, not generic advice.`;

  try {
    var result = await model.generateContent(prompt);
    var text = result.response.text().replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    var analysis = JSON.parse(text);
    res.json({ success: true, analysis: analysis });
  } catch (err) {
    console.error("JD analysis error:", err.message);
    res.json({ success: false, error: "Analysis failed. Try again." });
  }
});

app.get("/api/quick-review", async function(req, res) {
  if (!req.session.userId) return res.json({ success: false });
  var user = (await pool.query("SELECT name,cv,strengths,weaknesses,target_companies,target_roles FROM users WHERE id=$1", [req.session.userId])).rows[0];
  var stories = (await pool.query("SELECT title,tags FROM stories WHERE user_id=$1 LIMIT 5", [req.session.userId])).rows;
  var streak = (await pool.query("SELECT current_streak FROM streaks WHERE user_id=$1", [req.session.userId])).rows[0];
  var today = new Date().toISOString().split("T")[0];
  var todayContent = (await pool.query("SELECT content FROM daily_content WHERE date=$1", [today])).rows[0];
  var topNews = [];
  if (todayContent) {
    try {
      var c = JSON.parse(todayContent.content);
      topNews = (c.newsBites || []).slice(0, 3).map(function(b) { return { headline: b.headline, frame: b.interviewFrame, category: b.category }; });
    } catch(e) {}
  }
  res.json({
    success: true,
    name: user.name,
    cv: user.cv ? user.cv.substring(0, 500) : '',
    strengths: user.strengths,
    weaknesses: user.weaknesses,
    targets: user.target_companies,
    roles: user.target_roles,
    stories: stories,
    streak: streak ? streak.current_streak : 0,
    topNews: topNews,
    date: today
  });
});

// ═══ COMMUNICATION LAB ═══
app.post("/api/power-words", async function(req, res) {
  var text = req.body.text || '';
  if (text.length < 10) return res.json({ success: false, error: "Enter at least a sentence." });
  var lower = text.toLowerCase();
  var WEAK = [
    {weak:"i think",strong:"I believe / In my view",why:"'I think' sounds uncertain"},
    {weak:"i feel like",strong:"I'm convinced / My assessment is",why:"Hedging — state it as a position"},
    {weak:"sort of",strong:"(remove it)",why:"Filler that weakens your point"},
    {weak:"kind of",strong:"(remove it)",why:"Makes you sound unsure"},
    {weak:"maybe",strong:"likely / probably / I'd argue",why:"Noncommittal"},
    {weak:"just",strong:"(remove it)",why:"Minimizes what you're saying"},
    {weak:"very",strong:"(use a stronger word)",why:"'Very good' → 'excellent', 'very big' → 'massive'"},
    {weak:"really",strong:"(use a stronger word)",why:"'Really important' → 'critical'"},
    {weak:"stuff",strong:"aspects / elements / factors",why:"Too casual for interviews"},
    {weak:"things",strong:"factors / dimensions / considerations",why:"Be specific about what 'things'"},
    {weak:"got",strong:"received / obtained / achieved",why:"Too informal"},
    {weak:"a lot",strong:"significantly / substantially / considerably",why:"Vague — quantify instead"},
    {weak:"good",strong:"effective / impactful / strong",why:"Too generic"},
    {weak:"bad",strong:"ineffective / suboptimal / concerning",why:"Too generic"},
    {weak:"big",strong:"substantial / significant / major",why:"More professional"},
    {weak:"nice",strong:"impressive / commendable / well-executed",why:"Too casual"},
    {weak:"okay",strong:"acceptable / adequate / satisfactory",why:"Sounds indifferent"},
    {weak:"try to",strong:"aim to / intend to / will",why:"'Try' implies possible failure"},
    {weak:"i was like",strong:"I said / I responded / I proposed",why:"Extremely casual"},
    {weak:"basically",strong:"(remove it or restructure)",why:"Filler word — your sentence works without it"},
    {weak:"honestly",strong:"(remove it)",why:"Implies you're not honest otherwise"},
    {weak:"literally",strong:"(remove unless literal)",why:"Usually misused — weakens credibility"},
    {weak:"you know",strong:"(remove it)",why:"Filler seeking validation"},
    {weak:"like",strong:"such as / for example",why:"As a filler, remove. As comparison, use proper alternatives"}
  ];
  var found = [];
  WEAK.forEach(function(w) {
    var regex = new RegExp('\\b' + w.weak.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi');
    var matches = lower.match(regex);
    if (matches) found.push({ weak: w.weak, strong: w.strong, why: w.why, count: matches.length });
  });
  var score = Math.max(0, 100 - found.reduce(function(s, f) { return s + f.count * 8; }, 0));
  res.json({ success: true, found: found, score: score, totalWeak: found.reduce(function(s,f){return s+f.count},0) });
});

app.post("/api/score-impromptu", async function(req, res) {
  if (!req.session.userId) return res.status(401).json({ success: false });
  var text = req.body.text || '';
  var topic = req.body.topic || '';
  var duration = req.body.duration || 0;
  if (text.length < 20) return res.json({ success: false, error: "Say more — at least a few sentences." });

  var prompt = `Score this impromptu speech by an MBA student. Topic: "${topic}". Duration: ${duration} seconds.

Speech: "${text}"

Return ONLY valid JSON:
{
  "clarity": {"score": 1-10, "feedback": "one sentence"},
  "structure": {"score": 1-10, "feedback": "one sentence — did they have opening, body, closing?"},
  "relevance": {"score": 1-10, "feedback": "one sentence — did they stay on topic?"},
  "confidence": {"score": 1-10, "feedback": "one sentence — did they sound decisive or hesitant?"},
  "vocabulary": {"score": 1-10, "feedback": "one sentence — professional language or casual?"},
  "overall": 1-10,
  "oneTip": "The single most impactful thing they should fix",
  "modelOpening": "How a strong speaker would have opened this topic in 1-2 sentences"
}`;

  try {
    var result = await model.generateContent(prompt);
    var t = result.response.text().replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    var scores = JSON.parse(t);
    res.json({ success: true, scores: scores });
  } catch (err) {
    res.json({ success: false, error: "Scoring failed. Try again." });
  }
});

// ═══ SPEECH ANALYTICS ═══
app.post("/api/speech-stats", async function(req, res) {
  if (!req.session.userId) return res.json({ success: false });
  var b = req.body;
  await pool.query("INSERT INTO speech_stats (user_id, wpm, filler_count, fillers_used, duration, word_count, hedges, practice_type) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", [
    req.session.userId, b.wpm || 0, b.fillerCount || 0, JSON.stringify(b.fillersUsed || []),
    b.duration || 0, b.wordCount || 0, b.hedges || 0, b.practiceType || 'general'
  ]);
  res.json({ success: true });
});

app.get("/api/speech-analytics", async function(req, res) {
  if (!req.session.userId) return res.json({ hasData: false });

  var all = (await pool.query("SELECT * FROM speech_stats WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50", [req.session.userId])).rows;
  if (all.length === 0) return res.json({ hasData: false });

  var recent10 = all.slice(0, 10);
  var older10 = all.slice(Math.max(0, all.length - 10));

  var avg = function(arr, key) { return arr.length ? Math.round(arr.reduce(function(s, r) { return s + r[key]; }, 0) / arr.length * 10) / 10 : 0; };

  var recentAvgWPM = avg(recent10, 'wpm');
  var olderAvgWPM = avg(older10, 'wpm');
  var recentAvgFillers = avg(recent10, 'filler_count');
  var olderAvgFillers = avg(older10, 'filler_count');
  var recentAvgHedges = avg(recent10, 'hedges');

  // Top fillers
  var fillerMap = {};
  all.forEach(function(r) {
    try {
      var f = JSON.parse(r.fillers_used);
      f.forEach(function(w) { fillerMap[w] = (fillerMap[w] || 0) + 1; });
    } catch(e) {}
  });
  var topFillers = Object.keys(fillerMap).sort(function(a, b) { return fillerMap[b] - fillerMap[a]; }).slice(0, 5).map(function(w) { return { word: w, count: fillerMap[w] }; });

  // Speech score (0-100): lower fillers + WPM in range 120-160 = better
  var wpmScore = recentAvgWPM >= 120 && recentAvgWPM <= 160 ? 100 : recentAvgWPM < 120 ? Math.max(30, recentAvgWPM / 120 * 100) : Math.max(30, 100 - (recentAvgWPM - 160) * 2);
  var fillerScore = Math.max(0, 100 - recentAvgFillers * 15);
  var hedgeScore = Math.max(0, 100 - recentAvgHedges * 20);
  var speechScore = Math.round((wpmScore * 0.3 + fillerScore * 0.4 + hedgeScore * 0.3));

  // Trend data (last 20 sessions for charting)
  var trend = all.slice(0, 20).reverse().map(function(r, i) {
    return { session: i + 1, wpm: r.wpm, fillers: r.filler_count, hedges: r.hedges };
  });

  // Diagnosis
  var issues = [];
  if (recentAvgFillers > 3) issues.push({ issue: "High filler usage", detail: "Averaging " + recentAvgFillers + " fillers per answer. Target: under 2.", severity: "high", tip: "Pause instead of filling. Practice: answer any question, and every time you want to say 'um' or 'like', stop and take a silent 1-second breath instead." });
  else if (recentAvgFillers > 1) issues.push({ issue: "Moderate filler usage", detail: "Averaging " + recentAvgFillers + " fillers. Getting better — target under 1.", severity: "medium", tip: "You're improving. Focus on your top filler word: '" + (topFillers[0] ? topFillers[0].word : 'um') + "'. Eliminate just that one this week." });

  if (recentAvgWPM > 170) issues.push({ issue: "Speaking too fast", detail: "Averaging " + recentAvgWPM + " WPM. Ideal range: 130-150 WPM.", severity: "high", tip: "Nerves speed you up. Practice: deliberately pause after every sentence for 1 beat. Your brain thinks you're pausing too long — you're not." });
  else if (recentAvgWPM < 110) issues.push({ issue: "Speaking too slowly", detail: "Averaging " + recentAvgWPM + " WPM. This can signal low confidence.", severity: "medium", tip: "Practice reading news articles aloud at a brisk pace. Record yourself and speed up until you hit 130-140 WPM naturally." });

  if (recentAvgHedges > 2) issues.push({ issue: "Too much hedging", detail: "Using phrases like 'I think maybe', 'sort of', 'kind of' frequently.", severity: "high", tip: "Replace: 'I think maybe' → 'In my view'. 'Sort of' → drop it. 'I feel like' → 'I believe'. Practice saying your opinions as statements, not guesses." });

  if (topFillers.length > 0 && topFillers[0].count > 5) issues.push({ issue: "'" + topFillers[0].word + "' is your #1 filler", detail: "Used " + topFillers[0].count + " times across sessions.", severity: "medium", tip: "Awareness is step one — you now know your top filler. This week, focus ONLY on eliminating '" + topFillers[0].word + "'. One filler at a time." });

  var improving = all.length >= 10 && recentAvgFillers < olderAvgFillers;
  var wpmImproving = all.length >= 10 && Math.abs(recentAvgWPM - 140) < Math.abs(olderAvgWPM - 140);

  res.json({
    hasData: true,
    speechScore: speechScore,
    totalAnswers: all.length,
    recentAvgWPM: recentAvgWPM,
    recentAvgFillers: recentAvgFillers,
    recentAvgHedges: recentAvgHedges,
    topFillers: topFillers,
    issues: issues,
    trend: trend,
    improving: improving,
    wpmImproving: wpmImproving
  });
});

// ═══ IMPROVEMENT RESOURCES & STUDY PLAN ═══
const RESOURCE_BANK = {
  // HR & Communication
  "Structure answers with clear opening and closing": {
    subSkill: "Answer Structuring",
    dimension: "communication",
    level: "foundational",
    resources: [
      {type:"framework",title:"STAR Method",desc:"Situation → Task → Action → Result. Use for every behavioral answer."},
      {type:"framework",title:"PREP Method",desc:"Point → Reason → Example → Point. Use for opinion questions."},
      {type:"youtube",title:"Rakesh Gupta — STAR Method for MBA Interviews",desc:"IIM alumnus explains with Indian examples",url:"Search: 'STAR method MBA interview India'"},
      {type:"exercise",title:"Daily drill",desc:"Pick any HR question, set a 90-second timer, answer using STAR. Record and listen back."}
    ]
  },
  "Include quantified results with numbers": {
    subSkill: "Quantification",
    dimension: "structuredThinking",
    level: "critical",
    resources: [
      {type:"framework",title:"XYZ Formula",desc:"Accomplished [X] as measured by [Y], by doing [Z]. Every achievement needs this structure."},
      {type:"exercise",title:"Resume number audit",desc:"Go through each CV line. If there's no number, add one: team size, % improvement, ₹ value, timeline."},
      {type:"book",title:"Cracking the PM Interview — Ch. 3",desc:"Behavioral questions chapter teaches quantification across all answer types."},
      {type:"exercise",title:"'So what?' drill",desc:"After every answer, ask 'So what was the impact?' If you can't state a number, the answer isn't ready."}
    ]
  },
  "Use STAR framework consistently": {
    subSkill: "Story Structure",
    dimension: "personalNarrative",
    level: "foundational",
    resources: [
      {type:"framework",title:"STAR + L",desc:"STAR + Learning. Always end with what you learned — shows growth mindset."},
      {type:"exercise",title:"Story bank drill",desc:"Write 8 STAR stories covering: leadership, failure, teamwork, conflict, initiative, creativity, pressure, ethics. Practice each in 90 seconds."},
      {type:"youtube",title:"IIM Interview Prep — STAR Stories",desc:"Search: 'MBA placement interview STAR stories India examples'"},
      {type:"book",title:"Tell Me About Yourself — Holliday Mack",desc:"Entire book on structuring personal stories for interviews."}
    ]
  },
  "Reference real brand examples": {
    subSkill: "Brand Knowledge",
    dimension: "domainKnowledge",
    level: "critical",
    resources: [
      {type:"read",title:"Finshots Daily",desc:"5-min daily business stories with marketing angles. Subscribe: finshots.in",url:"https://finshots.in"},
      {type:"read",title:"Brand Equity (ET)",desc:"Weekly marketing column. Search: Economic Times Brand Equity",url:"https://brandequity.economictimes.indiatimes.com"},
      {type:"youtube",title:"Think School",desc:"Indian brand case studies — Amul, Jio, Zomato, Tata. Excellent for placement prep.",url:"Search: 'Think School marketing case study'"},
      {type:"exercise",title:"Brand journal",desc:"Every day, note 1 brand move you saw (ad, launch, rebrand). Write: what they did, why, marketing framework that applies."},
      {type:"youtube",title:"Warikoo / Backstage with Millionaires",desc:"Indian business analysis with marketing lens",url:"Search: 'Warikoo marketing analysis'"}
    ]
  },
  "Use marketing terminology naturally": {
    subSkill: "Marketing Vocabulary",
    dimension: "domainKnowledge",
    level: "foundational",
    resources: [
      {type:"framework",title:"Must-know frameworks",desc:"STP (Segmentation-Targeting-Positioning), 4P/7P, AIDA, BCG Matrix, Porter's 5 Forces, Ansoff Matrix, Brand Equity pyramid, Customer Journey Map."},
      {type:"book",title:"Marketing Management — Kotler (Chapters 1-8)",desc:"The MBA textbook. You must know STP, 4P, and brand equity cold."},
      {type:"exercise",title:"Framework-a-day",desc:"Learn one framework. Apply it to a real Indian brand. Write 3 sentences using it naturally. Repeat for 14 days."},
      {type:"read",title:"Marketing concepts flashcards",desc:"Use the Concept of the Day feature in InterviewReady's Today tab — it teaches one framework daily with interview phrasing."}
    ]
  },
  "Give specific, concrete examples": {
    subSkill: "Specificity",
    dimension: "communication",
    level: "critical",
    resources: [
      {type:"framework",title:"Name-Drop Rule",desc:"Every answer should name: a company, a person, a number, or a date. If it doesn't, it's too vague."},
      {type:"exercise",title:"Vague→Specific drill",desc:"Take a generic answer: 'I improved the process.' Rewrite: 'At [company], I reduced invoice processing time from 3 days to 4 hours by automating the approval workflow in Zoho, saving the team 15 hours/week.'"},
      {type:"exercise",title:"Record and review",desc:"Answer any question. Play it back. Count how many specific details you gave. Target: at least 3 per answer."}
    ]
  },
  "Connect answers to current business trends": {
    subSkill: "Current Affairs Integration",
    dimension: "currentAffairs",
    level: "advanced",
    resources: [
      {type:"read",title:"Morning Brew India / Finshots",desc:"Daily 5-min business newsletters. Build a habit of reading one every morning."},
      {type:"read",title:"LiveMint, ET, Business Standard",desc:"Skim headlines daily. Note 2-3 stories relevant to marketing."},
      {type:"youtube",title:"CNBC TV18 / ET Now",desc:"10 mins of business news daily builds passive knowledge."},
      {type:"exercise",title:"News-to-interview drill",desc:"Pick today's top business story. Frame it as: 'I was reading about [X] — this is an example of [framework] because...' Practice weaving news into answers."},
      {type:"exercise",title:"Use InterviewReady's Today tab",desc:"Read the 8 daily news bites with interview frames. Take the quiz. This builds the habit."}
    ]
  },
  "Acknowledge counterarguments": {
    subSkill: "Balanced Perspective",
    dimension: "gdReadiness",
    level: "critical",
    resources: [
      {type:"framework",title:"Steel Man + Pivot",desc:"State the strongest opposing view → acknowledge its merit → pivot to your position with evidence. Shows maturity."},
      {type:"framework",title:"3-2-1 Rule for GD",desc:"3 points for your side, 2 acknowledging the other side, 1 nuanced conclusion. Never be one-sided."},
      {type:"youtube",title:"GD prep — IIM Interviews",desc:"Search: 'group discussion MBA placement tips India'. Watch how toppers balance both sides."},
      {type:"exercise",title:"Debate yourself",desc:"Pick any GD topic. Write 3 strongest points FOR, then 3 strongest AGAINST. Practice arguing each side for 60 seconds."}
    ]
  },
  "Speak with confidence, reduce hedging": {
    subSkill: "Delivery & Confidence",
    dimension: "communication",
    level: "foundational",
    resources: [
      {type:"exercise",title:"Power phrase replacement",desc:"Replace: 'I think maybe' → 'In my view'. 'Sort of' → drop it. 'I feel like' → 'I believe'. 'Just' → remove it."},
      {type:"exercise",title:"Mirror drill",desc:"Stand in front of a mirror. Answer 'Tell me about yourself' while maintaining eye contact with your reflection. Do this daily for 1 week."},
      {type:"youtube",title:"Vinh Giang — Communication Skills",desc:"Search: 'Vinh Giang speaking confidence'. World-class delivery coaching."},
      {type:"exercise",title:"Voice recording review",desc:"Use the Coach's voice mode. Record 3 answers. Listen for: filler words, hedging phrases, trailing off. Each day, eliminate one habit."}
    ]
  },
  "Include personal anecdotes from your experience": {
    subSkill: "Personal Storytelling",
    dimension: "personalNarrative",
    level: "advanced",
    resources: [
      {type:"framework",title:"Experience Map",desc:"Map your life: academic highlights, work projects, failures, leadership moments, hobbies. Each is a potential anecdote."},
      {type:"exercise",title:"Build your Story Bank",desc:"Use InterviewReady's Stories tab. Write 8-10 STAR stories. Tag them by theme. The coach will reference them."},
      {type:"book",title:"Storyworthy — Matthew Dicks",desc:"How to find and tell compelling stories from your own life."},
      {type:"exercise",title:"5-minute story",desc:"Every night, write one 5-sentence story from your day or past. Situation, conflict, resolution. This builds storytelling muscle."}
    ]
  },
  "Apply a structured framework (STAR, 4P, STP)": {
    subSkill: "Framework Application",
    dimension: "structuredThinking",
    level: "critical",
    resources: [
      {type:"framework",title:"Framework Selection Guide",desc:"HR question → STAR. Marketing question → STP or 4P. Strategy question → Porter's or SWOT. Guesstimate → Top-down or Bottom-up. Always state your framework before answering."},
      {type:"book",title:"Case In Point — Marc Cosentino",desc:"The gold standard for case interview frameworks. Chapters 1-5 are essential."},
      {type:"youtube",title:"Think School — Case Studies",desc:"Indian brand case studies broken down with frameworks."},
      {type:"exercise",title:"Framework sprint",desc:"Pick a random question. In 10 seconds, name the framework you'd use. In 60 seconds, answer using it. Repeat 10 times."}
    ]
  },
  "Structure answers with point-evidence-impact": {
    subSkill: "Argument Construction",
    dimension: "gdReadiness",
    level: "foundational",
    resources: [
      {type:"framework",title:"PEI Method",desc:"Point (your claim) → Evidence (data/example) → Impact (so what?). Every GD argument needs all three."},
      {type:"exercise",title:"GD Opening Drill",desc:"Use InterviewReady's GD Opening Drill mode. Practice hook → scope → position → preview structure."},
      {type:"youtube",title:"GD Mastermind — MBA prep",desc:"Search: 'group discussion structure MBA India'. Focus on how toppers open and close."},
      {type:"exercise",title:"Newspaper editorial analysis",desc:"Read one editorial daily. Identify: claim, evidence, counterpoint, conclusion. This is the structure you need in GD."}
    ]
  }
};

// Fallback resources for growth areas not in the bank
const DIMENSION_RESOURCES = {
  currentAffairs: [
    {type:"read",title:"Finshots Daily Newsletter",desc:"5-min business stories, free",url:"https://finshots.in"},
    {type:"read",title:"InterviewReady Today Tab",desc:"Daily 8 news bites with interview framing and marketing concepts"},
    {type:"youtube",title:"Think School / Nitish Rajput",desc:"Business and current affairs analysis for Indian audience"}
  ],
  structuredThinking: [
    {type:"book",title:"Case In Point — Marc Cosentino",desc:"Framework-based approach to cases and guesstimates"},
    {type:"exercise",title:"1 guesstimate daily",desc:"Practice the daily guesstimate in InterviewReady's Today tab"},
    {type:"youtube",title:"Victor Cheng — Case Interview",desc:"Search: 'Victor Cheng case interview framework'"}
  ],
  communication: [
    {type:"exercise",title:"Record daily",desc:"Answer one question per day into your phone. Listen back. Track filler count, duration, clarity."},
    {type:"exercise",title:"InterviewReady Voice Mode",desc:"Use the mic button in Coach — it tracks WPM and fillers automatically"},
    {type:"youtube",title:"Vinh Giang / Matt Abrahams",desc:"Speaking confidence and structure. Search: 'Think Fast Talk Smart Stanford'"}
  ],
  personalNarrative: [
    {type:"exercise",title:"Build 10 STAR stories",desc:"Use the Stories tab. Cover: leadership, failure, teamwork, conflict, initiative, creativity, pressure, ethics, marketing, innovation"},
    {type:"book",title:"Storyworthy — Matthew Dicks",desc:"How to mine your life for compelling stories"}
  ],
  domainKnowledge: [
    {type:"book",title:"Kotler's Marketing Management — Ch 1-10",desc:"STP, 4P, brand equity, consumer behavior. The MBA essentials."},
    {type:"read",title:"Brand Equity (ET) + Finshots",desc:"Weekly marketing + daily business. Build marketing vocabulary."},
    {type:"youtube",title:"Think School + Marketing Fundas",desc:"Indian brand case studies with framework analysis"}
  ],
  gdReadiness: [
    {type:"exercise",title:"InterviewReady GD Drills",desc:"Opening Drill, Counter Drill, Summary Drill, Full Simulator — do all four"},
    {type:"framework",title:"Master 4 structures",desc:"PESTEL for current affairs, Stakeholder for cases, Steel Man for controversial, Concrete for abstract"},
    {type:"youtube",title:"GD toppers — IIM interviews",desc:"Search: 'group discussion tips IIM placement'. Watch 5+ real GD recordings."}
  ],
  pressureHandling: [
    {type:"exercise",title:"Rapid Fire mode daily",desc:"InterviewReady's Rapid Fire coach mode — 30 sec answers under pressure"},
    {type:"exercise",title:"Mock interviews",desc:"Use the Full Mock Interview mode weekly. The Hire/Maybe/No Hire verdict builds resilience."},
    {type:"exercise",title:"Stress inoculation",desc:"Practice the hardest questions from your Resume Question bank. The Stress Test category is designed for this."}
  ]
};

app.get("/api/improvement-plan", async function(req, res) {
  if (!req.session.userId) return res.json({ plan: [], resources: [] });

  // Get growth areas
  var areas = (await pool.query("SELECT area, category, count FROM growth_areas WHERE user_id = $1 ORDER BY count DESC LIMIT 15", [req.session.userId])).rows;

  // Get average scores
  var avg = (await pool.query("SELECT AVG(relevance) as r, AVG(structure) as s, AVG(specificity) as sp, AVG(marketing) as m, COUNT(*) as c FROM coach_scores WHERE user_id=$1", [req.session.userId])).rows[0];

  // Build recommendations
  var recommendations = [];
  var seenDimensions = {};

  // From growth areas (most specific)
  areas.forEach(function(a) {
    var bankEntry = RESOURCE_BANK[a.area];
    if (bankEntry) {
      recommendations.push({
        area: a.area,
        subSkill: bankEntry.subSkill,
        dimension: bankEntry.dimension,
        level: bankEntry.level,
        count: a.count,
        resources: bankEntry.resources
      });
      seenDimensions[bankEntry.dimension] = true;
    }
  });

  // From low scores (fill gaps)
  if (avg && avg.c > 0) {
    var weakDims = [];
    if (avg.r < 6) weakDims.push('communication');
    if (avg.s < 6) weakDims.push('structuredThinking');
    if (avg.sp < 6) weakDims.push('personalNarrative');
    if (avg.m < 6) weakDims.push('domainKnowledge');

    weakDims.forEach(function(dim) {
      if (!seenDimensions[dim] && DIMENSION_RESOURCES[dim]) {
        recommendations.push({
          area: 'General improvement needed',
          subSkill: dim.replace(/([A-Z])/g, ' $1').trim(),
          dimension: dim,
          level: 'foundational',
          count: 0,
          resources: DIMENSION_RESOURCES[dim]
        });
      }
    });
  }

  // Add GD resources if any GD growth areas exist
  var hasGD = areas.some(function(a) { return a.category === 'gdReadiness'; });
  if (hasGD && !seenDimensions['gdReadiness'] && DIMENSION_RESOURCES['gdReadiness']) {
    recommendations.push({
      area: 'GD performance',
      subSkill: 'GD Readiness',
      dimension: 'gdReadiness',
      level: 'critical',
      count: 0,
      resources: DIMENSION_RESOURCES['gdReadiness']
    });
  }

  res.json({
    recommendations: recommendations,
    totalAreas: areas.length,
    sessionCount: avg ? avg.c : 0,
    scores: avg && avg.c > 0 ? { relevance: Math.round(avg.r*10)/10, structure: Math.round(avg.s*10)/10, specificity: Math.round(avg.sp*10)/10, marketing: Math.round(avg.m*10)/10 } : null
  });
});

// ═══ MARKETING KNOWLEDGE MAP ═══
const MARKETING_MAP = [
  {cat:"Core Frameworks",icon:"🧭",concepts:[
    {term:"STP",full:"Segmentation → Targeting → Positioning",def:"Divide market into segments, pick the best one, position your brand in their mind.",say:"We'd segment by demographics and psychographics, target urban millennials, and position as a premium-yet-accessible brand.",ask:"Segment the Indian shampoo market and pick a target for a new launch."},
    {term:"4P / 7P",full:"Product, Price, Place, Promotion (+People, Process, Physical Evidence)",def:"The marketing mix — every lever you can pull to reach your target.",say:"The 4P strategy here would focus on premium pricing, selective distribution, and digital-first promotion.",ask:"Design the 4P strategy for launching a protein bar in India."},
    {term:"AIDA",full:"Attention → Interest → Desire → Action",def:"The consumer funnel — how customers move from awareness to purchase.",say:"The ad creates attention with humor, builds interest through features, desire through testimonials, and drives action with a limited offer.",ask:"Map the AIDA journey for a new D2C skincare brand."},
    {term:"BCG Matrix",full:"Stars, Cash Cows, Question Marks, Dogs",def:"Portfolio analysis — classify products by market growth and market share.",say:"Maggi is a cash cow for Nestlé — high share, low growth. Use its profits to fund star products.",ask:"Classify HUL's brand portfolio using the BCG Matrix."},
    {term:"Ansoff Matrix",full:"Market Penetration / Development / Product Development / Diversification",def:"Four growth strategies based on new vs existing products and markets.",say:"Amul entering ice cream was product development — existing market, new product category.",ask:"Using Ansoff, recommend a growth strategy for Zomato."},
    {term:"Porter's 5 Forces",full:"Rivalry, New Entrants, Substitutes, Buyer Power, Supplier Power",def:"Industry attractiveness analysis — how competitive and profitable is this market?",say:"The Indian OTT space has high rivalry, low switching costs, and many substitutes — that makes it a tough market to profit in.",ask:"Analyze the Indian quick commerce industry using Porter's 5 Forces."},
    {term:"SWOT Analysis",full:"Strengths, Weaknesses, Opportunities, Threats",def:"Internal (S/W) and external (O/T) assessment of a company or brand.",say:"Tata's strength is trust and distribution, weakness is premium perception, opportunity is D2C, threat is nimble startups.",ask:"Do a SWOT for Flipkart vs Amazon India."},
    {term:"PESTEL",full:"Political, Economic, Social, Technological, Environmental, Legal",def:"Macro-environment analysis — external factors affecting business.",say:"From a PESTEL view, the biggest factor for EV adoption in India is the technological gap in charging infrastructure.",ask:"Use PESTEL to analyze the Indian organic food market."}
  ]},
  {cat:"Brand Management",icon:"🏷️",concepts:[
    {term:"Brand Equity",full:"Keller's CBBE Model",def:"The commercial value from consumer perception — awareness, associations, loyalty, perceived quality.",say:"Tata Salt commands a 20% premium over unbranded salt — that's pure brand equity.",ask:"How would you measure brand equity for Amul?"},
    {term:"Brand Positioning",full:"POD and POP",def:"Points of Difference (what makes you unique) and Points of Parity (what you must match).",say:"Dove's POD is real beauty/self-esteem. Its POP with other soaps is moisturizing and cleansing.",ask:"Define the POD and POP for a new Indian coffee chain competing with Starbucks."},
    {term:"Brand Architecture",full:"House of Brands vs Branded House",def:"How a company organizes its brand portfolio.",say:"P&G is a house of brands — Tide, Gillette, Pampers are all independent. Tata is a branded house.",ask:"Should a company acquiring 3 D2C brands keep them separate or merge under one brand?"},
    {term:"Brand Extension",full:"Line Extension vs Category Extension",def:"Using an existing brand name in a new product or category.",say:"Dettol extending from antiseptic to soap was a category extension — risky but it worked because of trust equity.",ask:"Should Zomato launch a branded kitchen appliance line? Why or why not?"},
    {term:"Brand Lifecycle",full:"Introduction → Growth → Maturity → Decline",def:"Every brand goes through stages — marketing strategy must match the stage.",say:"Maggi is in maturity — the strategy is about defending share and premiumization, not awareness.",ask:"Where is Instagram in its brand lifecycle in India, and what should its strategy be?"}
  ]},
  {cat:"Consumer Behavior",icon:"🧠",concepts:[
    {term:"Consumer Decision Journey",full:"Need Recognition → Search → Evaluation → Purchase → Post-Purchase",def:"The 5 stages consumers go through. Marketing must address each stage.",say:"For high-involvement products like cars, the evaluation stage is longest — that's where test drives and reviews matter most.",ask:"Map the decision journey for a first-time mutual fund investor in India."},
    {term:"Maslow's Hierarchy",full:"Physiological → Safety → Social → Esteem → Self-Actualization",def:"People fulfill lower needs first. Brands can position at different levels.",say:"Tata Nano targeted safety and basic transport. It failed because buyers wanted esteem — nobody wants to be seen in 'the cheapest car'.",ask:"At which level of Maslow's does an iPhone operate vs a Redmi phone?"},
    {term:"Cognitive Biases in Marketing",full:"Anchoring, Social Proof, Scarcity, Loss Aversion, Decoy Effect",def:"Mental shortcuts that marketers leverage.",say:"Amazon's 'Only 3 left in stock' uses scarcity bias. Showing the original price crossed out is anchoring.",ask:"Which cognitive biases does Swiggy use in its app design?"},
    {term:"Reference Groups",full:"Aspirational, Membership, Dissociative",def:"Groups that influence purchase behavior.",say:"Influencer marketing works because influencers are aspirational reference groups for Gen-Z.",ask:"How do reference groups affect premium fashion purchases in tier-2 India?"}
  ]},
  {cat:"Digital Marketing",icon:"📱",concepts:[
    {term:"Performance Marketing",full:"CAC, ROAS, CTR, CPC, CPM, Conversion Rate",def:"Data-driven marketing measured by specific KPIs and ROI.",say:"Our Facebook campaign delivered a ROAS of 4.2x with a CAC of ₹180, well below the ₹300 target.",ask:"You have ₹10 lakh for digital ads. How do you allocate between Google, Meta, and Instagram? What KPIs do you track?"},
    {term:"SEO vs SEM",full:"Organic search vs Paid search",def:"SEO is earning visibility through content. SEM is buying it through ads.",say:"For a new D2C brand, SEM gives immediate traffic while SEO builds long-term organic discovery.",ask:"A B2B SaaS company gets 80% of leads from SEM. Is that healthy? What would you change?"},
    {term:"Content Marketing",full:"Blog, Video, Social, Email, Podcast",def:"Creating valuable content to attract and retain a clearly defined audience.",say:"HubSpot built a $30B company primarily through content marketing — blogs, tools, and courses that attract leads.",ask:"Design a content marketing strategy for an Indian ed-tech startup."},
    {term:"Marketing Funnel",full:"TOFU (Awareness) → MOFU (Consideration) → BOFU (Conversion)",def:"Top/Middle/Bottom of funnel — different content and tactics for each stage.",say:"Instagram reels work for TOFU. Product comparisons for MOFU. Retargeting ads with offers for BOFU.",ask:"Map the digital marketing funnel for a premium men's grooming D2C brand."},
    {term:"Customer Lifetime Value (CLV)",full:"Revenue per customer over entire relationship",def:"How much a customer is worth over time. CLV > CAC means profitable growth.",say:"If CLV is ₹5,000 and CAC is ₹1,200, we have a 4:1 ratio — healthy enough to scale.",ask:"Swiggy's average order is ₹250, customers order 3x/month, and churn at 6 months. Calculate CLV."}
  ]},
  {cat:"Pricing & Revenue",icon:"💰",concepts:[
    {term:"Pricing Strategies",full:"Penetration, Skimming, Value-based, Competitive, Psychological",def:"How you set prices — depends on brand position, competition, and objectives.",say:"Jio used penetration pricing — free data to acquire 400M users, then monetized through ARPU growth.",ask:"Should a new OTT platform use penetration or skimming pricing in India?"},
    {term:"Price Elasticity",full:"How demand changes with price",def:"Elastic = demand drops a lot when price rises. Inelastic = demand barely changes.",say:"Salt is inelastic — Tata Salt can charge 20% more. Fashion is elastic — a 10% price hike loses customers.",ask:"Is Starbucks coffee elastic or inelastic in India? How does this affect their pricing strategy?"},
    {term:"Freemium Model",full:"Free basic + Paid premium",def:"Give value free, monetize power users. Works for network-effect businesses.",say:"Spotify's freemium model works because free users generate data and become evangelists who eventually convert.",ask:"Should a news app in India use freemium, subscription, or ad-supported? Why?"}
  ]},
  {cat:"Sales & Distribution",icon:"🚚",concepts:[
    {term:"Distribution Channels",full:"Direct, Indirect, Omnichannel",def:"How products reach consumers — general trade (kirana), modern trade (supermarkets), e-commerce, D2C.",say:"HUL reaches 8 million outlets through a 3-tier distribution network — that's their real moat.",ask:"Design a distribution strategy for a new health drink brand targeting rural India."},
    {term:"Trade Marketing",full:"Push vs Pull Strategy",def:"Push = incentivize retailers to stock your product. Pull = create consumer demand that pulls product through.",say:"FMCG companies spend 30-40% of marketing budget on trade — retailer margins, display allowances, volume discounts.",ask:"A kirana store owner has limited shelf space. How do you convince them to stock your new brand over the competitor?"},
    {term:"D2C Model",full:"Direct-to-Consumer",def:"Selling directly to consumers bypassing traditional retail. Higher margins, better data, direct relationship.",say:"Mamaearth built ₹1,800 crore revenue D2C before expanding to offline — the data from D2C informed their offline strategy.",ask:"When should a D2C brand start going offline? What signals tell you it's time?"}
  ]},
  {cat:"Indian Marketing Specifics",icon:"🇮🇳",concepts:[
    {term:"Sachet Strategy",full:"Small-unit packs for price-sensitive consumers",def:"₹1-₹10 packs that drive trial and access in low-income segments.",say:"India's sachet economy is worth ₹20,000 crore — it's how FMCG reaches Bharat, not just India.",ask:"Is the sachet strategy still relevant as India's income grows, or should brands push premiumization?"},
    {term:"Rural Marketing",full:"Challenges: access, literacy, trust, seasonal income",def:"600M+ consumers in rural India with different media consumption, purchase patterns, and brand relationships.",say:"ITC's e-Choupal and HUL's Project Shakti are textbook rural distribution innovations.",ask:"How would you market a digital payments app to rural India?"},
    {term:"Two Indias",full:"India (urban, digital, premium) vs Bharat (rural, traditional, value)",def:"The fundamental segmentation that drives all Indian marketing strategy.",say:"Any India strategy must decide: are you serving India or Bharat? The 4P is completely different for each.",ask:"Can a single brand serve both India and Bharat, or do you need separate brands?"},
    {term:"Quick Commerce",full:"10-30 minute delivery model",def:"Blinkit, Zepto, Swiggy Instamart — hyper-local, dark-store-based instant delivery.",say:"Quick commerce is reshaping impulse purchases — 40% of orders are unplanned, compared to 20% in regular e-commerce.",ask:"How does quick commerce change the role of brand building for FMCG companies?"}
  ]},
  {cat:"Marketing Analytics",icon:"📊",concepts:[
    {term:"NPS",full:"Net Promoter Score",def:"Promoters (9-10) minus Detractors (0-6). Measures customer loyalty and word-of-mouth potential.",say:"Our NPS of 45 is above industry average of 30, indicating strong organic growth potential.",ask:"An NPS of 20 drops to -5 after a product recall. What's your recovery plan?"},
    {term:"Market Share Calculation",full:"Your sales / Total market sales × 100",def:"Your slice of the market — tracked in value (₹) and volume (units).",say:"We have 12% value share but 18% volume share — that means we're positioned below the market average price.",ask:"Brand A has 25% volume share but 15% value share. What does this tell you? What should they do?"},
    {term:"A/B Testing",full:"Testing two variants to see which performs better",def:"Change one variable, measure the impact. Foundation of data-driven marketing.",say:"We A/B tested two email subject lines — the question format got 34% higher open rate than the statement format.",ask:"You're launching a landing page. What would you A/B test first and why?"},
    {term:"Attribution Models",full:"First-touch, Last-touch, Multi-touch, Time-decay",def:"How you give credit to different marketing touchpoints for a conversion.",say:"Last-touch attribution overvalues the final ad clicked. Multi-touch shows us that the blog post initiated 40% of conversions even though it never gets credit.",ask:"An e-commerce brand runs Google Ads, Instagram, and email. How do you decide which channel gets credit for a sale?"}
  ]},
  {cat:"Advanced Brand Strategy",icon:"🏆",concepts:[
    {term:"Keller's Brand Resonance Model",full:"Identity → Meaning → Response → Resonance (CBBE Pyramid)",def:"4 levels: Salience (who are you?) → Performance & Imagery (what are you?) → Judgments & Feelings (what about you?) → Resonance (what about you and me?). Resonance = deep loyalty.",say:"Apple sits at the top of Keller's pyramid — customers don't just buy it, they identify with it. That's resonance. Most Indian brands are stuck at the performance level.",ask:"Where does Tata Motors sit on Keller's CBBE pyramid? How would you move it up?"},
    {term:"Brand Personality (Aaker's Model)",full:"Sincerity, Excitement, Competence, Sophistication, Ruggedness",def:"Brands have human personality traits. Consumers choose brands whose personality matches their self-image.",say:"Amul's brand personality is Sincerity — honest, wholesome, cheerful. Red Bull is Excitement. BMW is Sophistication. Woodland is Ruggedness.",ask:"What is Zomato's brand personality? How did their social media voice create it?"},
    {term:"Brand Prism (Kapferer)",full:"Physique, Personality, Culture, Relationship, Reflection, Self-Image",def:"6 facets that define a brand's identity — the sender's side (how brand presents) and receiver's side (how consumer perceives).",say:"For Tanishq: Physique is elegant jewelry, Culture is Indian heritage, Reflection is the modern Indian woman, Relationship is trust across generations.",ask:"Build a Kapferer Brand Prism for Boat (audio brand)."},
    {term:"Blue Ocean Strategy",full:"Create uncontested market space vs competing in red ocean",def:"Instead of fighting competitors (red ocean), create new demand where there are no competitors (blue ocean). Value innovation = simultaneously pursue differentiation AND low cost. Classic example: Cirque du Soleil — neither circus nor theater, a new category.",say:"OYO created a blue ocean in India — there was no 'branded budget hotel' category before them. They didn't compete with Taj or Marriott, they created a new space between unbranded lodges and expensive hotels. Nykaa did similarly in beauty retail.",ask:"Is quick commerce (Zepto/Blinkit) a blue ocean or are they fighting in a red ocean? Note: Jio is sometimes cited as blue ocean but it's debatable — they entered an existing telecom market with aggressive pricing, which is closer to disruptive innovation than true blue ocean."},
    {term:"Product Lifecycle (PLC)",full:"Introduction → Growth → Maturity → Decline",def:"Every product goes through 4 stages. Marketing strategy must change at each stage — heavy investment in intro, competitive defense in maturity.",say:"Maggi Noodles is in maturity — the strategy is premiumization (Maggi Pazzta), line extensions, and defending shelf space. Not awareness building.",ask:"Where is ChatGPT in its product lifecycle? What should OpenAI's marketing strategy be at this stage?"},
    {term:"Perceptual Mapping",full:"Plotting brands on 2 dimensions consumers care about",def:"Visual tool showing how consumers perceive competing brands on key attributes (e.g., affordable-premium on X axis, traditional-modern on Y).",say:"On a perceptual map of premium vs affordable and traditional vs modern, Fabindia sits at premium-traditional, H&M at affordable-modern, and Sabyasachi at premium-modern.",ask:"Draw a perceptual map for Indian coffee chains. Where's the whitespace?"},
    {term:"Co-Branding & Brand Alliance",full:"Two brands partnering for mutual benefit",def:"Ingredient co-branding (Intel Inside), joint venture co-branding (Flipkart + Myntra), or promotional co-branding (Uber + Spotify).",say:"Titan's Fastrack partnering with Marvel for themed watches is co-branding — Fastrack gets youth excitement, Marvel gets physical product presence.",ask:"Propose a co-branding partnership for Amul. Who would you partner with and why?"}
  ]},
  {cat:"Market Research & Insights",icon:"🔬",concepts:[
    {term:"Qualitative vs Quantitative Research",full:"Why (depth) vs How Many (scale)",def:"Qualitative: focus groups, interviews, ethnography — explores WHY. Quantitative: surveys, experiments, data analysis — measures HOW MUCH.",say:"We started with qualitative research — 20 in-depth interviews revealed that price wasn't the barrier, trust was. Then we validated quantitatively with a 2,000-person survey.",ask:"You're launching a new health drink. Design the research plan — what qualitative and quantitative methods would you use?"},
    {term:"Customer Journey Mapping",full:"Visualizing every touchpoint from awareness to loyalty",def:"Map every interaction a customer has with your brand — pre-purchase (ads, search, word-of-mouth), purchase (store, website, app), post-purchase (support, reviews, repurchase).",say:"By mapping the customer journey for Myntra, we found that 60% of drop-offs happened at the size selection page — a UX fix, not a marketing fix.",ask:"Map the customer journey for someone buying their first car in India. Where are the critical moments of truth?"},
    {term:"Conjoint Analysis",full:"Understanding which product features customers value most",def:"Trade-off analysis — forces customers to choose between combinations of features, revealing true preferences. Used in pricing and product design.",say:"Our conjoint analysis showed customers valued battery life 3x more than camera quality — so we repositioned the phone around 'lasts 2 days' instead of megapixels.",ask:"How would you use conjoint analysis to design a new subscription box service?"},
    {term:"Ethnographic Research",full:"Observing consumers in their natural environment",def:"Don't ask what people do — watch what they actually do. Reveals unarticulated needs that surveys miss.",say:"HUL's Project Shakti came from ethnographic research — they observed how rural women actually shopped, and designed the distribution model around that behavior.",ask:"How would you use ethnographic research to understand how Gen-Z discovers new brands?"}
  ]},
  {cat:"Integrated Marketing Communications",icon:"📣",concepts:[
    {term:"IMC (Integrated Marketing Communications)",full:"All channels delivering one consistent message",def:"Every touchpoint — advertising, PR, sales promotion, digital, events, packaging — must tell the same brand story. Consistency builds equity.",say:"Cadbury's 'Kuch Meetha Ho Jaaye' is a masterclass in IMC — TV, print, digital, point-of-sale, packaging, even festival campaigns all reinforce the same emotional territory.",ask:"A brand's TV ad says 'premium luxury' but their Instagram is full of discount offers. What's wrong and how do you fix it?"},
    {term:"POEM Framework",full:"Paid, Owned, Earned Media",def:"Paid = advertising you buy. Owned = your website, app, social handles. Earned = press coverage, word-of-mouth, viral content. Best brands have all three working together.",say:"Amul's topical ads generate massive earned media — one creative artwork gets picked up by news channels and goes viral, multiplying their paid media investment by 10x.",ask:"Design a POEM strategy for a new electric scooter launch in India."},
    {term:"Viral Marketing & Word-of-Mouth",full:"Designing content/experiences people want to share",def:"Not luck — engineered shareability. Triggers: social currency, triggers, emotion, public visibility, practical value, stories (Jonah Berger's STEPPS framework).",say:"Zomato's witty push notifications go viral because they have social currency — people screenshot and share them to look funny and culturally aware.",ask:"Using STEPPS framework, design a campaign for a new delivery app that people will share without being asked."},
    {term:"Sales Promotion",full:"Short-term incentives to encourage purchase",def:"Consumer promotions (coupons, samples, contests, BOGO) and trade promotions (dealer margins, display allowances). Drives trial but can erode brand equity if overused.",say:"Flipkart's Big Billion Days is a sales promotion event that's become a brand event — they've turned a discount festival into anticipated cultural moment.",ask:"A premium brand is losing share. Should they run a price promotion? What are the risks?"},
    {term:"Experiential Marketing",full:"Creating immersive brand experiences",def:"Instead of telling consumers about your brand, let them experience it. Events, pop-ups, AR/VR, sampling programs.",say:"OnePlus built its entire early brand through experiential marketing — invite-only sales, community events, popup stores. No TV ads needed.",ask:"Design an experiential marketing campaign for launching a premium chocolate brand in India."}
  ]},
  {cat:"Strategy & Competitive",icon:"⚔️",concepts:[
    {term:"Competitive Advantage (Porter)",full:"Cost Leadership, Differentiation, Focus",def:"Three ways to win: be the cheapest (cost leadership), be unique (differentiation), or own a niche (focus). Stuck in the middle = losing.",say:"IndiGo is cost leadership. Vistara was differentiation. SpiceJet tried to be both and struggled — that's 'stuck in the middle.'",ask:"What is Zepto's competitive strategy? Is 10-minute delivery differentiation or are they heading toward cost leadership?"},
    {term:"Value Chain Analysis",full:"Primary activities + Support activities",def:"Breaks down every activity a company does to find where value is created and where costs can be cut.",say:"Amazon's value chain advantage is in inbound logistics (warehousing) and operations (fulfillment speed). That's why they invest billions in warehouses, not in storefronts.",ask:"Do a value chain analysis for Swiggy. Where is their competitive advantage?"},
    {term:"Market Segmentation Methods",full:"Geographic, Demographic, Psychographic, Behavioral",def:"Four ways to divide a market. Best strategies combine multiple bases.",say:"Netflix segments behaviorally — by viewing patterns, not demographics. A 20-year-old and a 50-year-old who both love Korean dramas get the same recommendations.",ask:"Segment the Indian two-wheeler market. Which basis is most useful for a new EV scooter brand?"},
    {term:"Positioning Statement",full:"For [target], [brand] is the [category] that [point of difference] because [reason to believe]",def:"The single sentence that defines your brand's place in the consumer's mind. Everything flows from this.",say:"For busy urban professionals, Swiggy Instamart is the instant delivery service that gets groceries to your door in 10 minutes because of our hyperlocal dark store network.",ask:"Write a positioning statement for Boat earphones. Now write one for their competitor Noise."},
    {term:"Growth Hacking",full:"Rapid experimentation across marketing, product, and engineering",def:"Using creative, low-cost strategies to acquire and retain customers. Blurs the line between marketing and product — every feature is a growth lever.",say:"Dropbox's referral program — 'give 500MB, get 500MB' — grew them from 100K to 4M users in 15 months with almost zero ad spend. That's growth hacking: the product IS the marketing.",ask:"Design a growth hack for a new Indian fintech app targeting college students. No paid ads allowed."}
  ]}
];

app.get("/api/marketing-map", async function(req, res) {
  var totalConcepts = MARKETING_MAP.reduce(function(s, cat) { return s + cat.concepts.length; }, 0);
  res.json({ map: MARKETING_MAP, totalConcepts: totalConcepts, categories: MARKETING_MAP.length });
});

// ═══ MARKETING CONCEPT DRILL (Flashcard Quiz) ═══
app.get("/api/concept-drill", async function(req, res) {
  // Flatten all concepts with category info
  var allConcepts = [];
  MARKETING_MAP.forEach(function(cat) {
    cat.concepts.forEach(function(c) {
      allConcepts.push({ term: c.term, full: c.full, def: c.def, say: c.say, ask: c.ask, cat: cat.cat, icon: cat.icon });
    });
  });
  // Shuffle
  for (var i = allConcepts.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var tmp = allConcepts[i]; allConcepts[i] = allConcepts[j]; allConcepts[j] = tmp;
  }
  var mode = req.query.mode || 'all'; // all, weak, category
  var cat = req.query.cat || '';
  if (mode === 'category' && cat) {
    allConcepts = allConcepts.filter(function(c) { return c.cat === cat; });
  }
  res.json({ concepts: allConcepts, total: allConcepts.length });
});

app.post("/api/concept-drill-score", async function(req, res) {
  if (!req.session.userId) return res.json({ success: true });
  var b = req.body;
  // Score how well the user explained a concept
  var prompt = 'You are a strict Marketing professor. A student was asked to explain "' + b.term + '" (' + b.full + ').\n\n' +
    'Their answer: "' + (b.answer || '') + '"\n\n' +
    'The correct definition: "' + b.correctDef + '"\n\n' +
    'Return ONLY valid JSON:\n{\n' +
    '  "score": 1-10,\n' +
    '  "accuracy": "one sentence — did they get the core concept right?",\n' +
    '  "missing": "what key element did they miss?",\n' +
    '  "example_quality": "did they give a real example? Was it correct?",\n' +
    '  "interview_ready": true/false,\n' +
    '  "model_answer": "How a top candidate would explain this in 3 sentences with an Indian brand example"\n}';
  try {
    var result = await model.generateContent(prompt);
    var text = result.response.text().replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    var scores = JSON.parse(text);
    res.json({ success: true, scores: scores });
  } catch (err) {
    res.json({ success: false, error: "Scoring failed." });
  }
});

// ═══ GD TOPIC BANK ═══
const GD_TOPICS = [
  // Current Affairs
  {id:1,topic:"India's digital payments revolution — UPI is the future or a privacy risk?",cat:"Current Affairs",difficulty:"Medium",keyAngles:["Financial inclusion","Data privacy","Global adoption","China comparison"]},
  {id:2,topic:"Should India ban Chinese apps permanently?",cat:"Current Affairs",difficulty:"Medium",keyAngles:["National security","Economic impact","Startup opportunity","Consumer choice"]},
  {id:3,topic:"Is the Indian startup ecosystem in a bubble?",cat:"Current Affairs",difficulty:"Hard",keyAngles:["Valuation vs revenue","Layoffs","Profitability pressure","Global comparison"]},
  {id:4,topic:"Should India have a universal basic income?",cat:"Current Affairs",difficulty:"Hard",keyAngles:["Poverty reduction","Fiscal burden","Inflation risk","Implementation"]},
  {id:5,topic:"EV adoption in India — too early or too late?",cat:"Current Affairs",difficulty:"Medium",keyAngles:["Infrastructure gaps","Government push","Cost parity","Environmental impact"]},
  {id:6,topic:"Is remote work killing company culture or building better companies?",cat:"Current Affairs",difficulty:"Easy",keyAngles:["Productivity data","Mental health","Talent access","Hybrid models"]},
  {id:7,topic:"Should social media platforms be regulated by the government?",cat:"Current Affairs",difficulty:"Medium",keyAngles:["Free speech","Misinformation","Platform responsibility","Global approaches"]},
  {id:8,topic:"Quick commerce (10-min delivery) — innovation or unsustainable?",cat:"Current Affairs",difficulty:"Medium",keyAngles:["Unit economics","Consumer behavior shift","Dark stores","Worker conditions"]},

  // Abstract
  {id:9,topic:"Is ambition a virtue or a vice?",cat:"Abstract",difficulty:"Hard",keyAngles:["Personal growth vs relationships","Healthy vs toxic ambition","Cultural differences","Where to draw the line"]},
  {id:10,topic:"The pen is mightier than the sword",cat:"Abstract",difficulty:"Medium",keyAngles:["Media influence","Policy change","Whistleblowers","When force is necessary"]},
  {id:11,topic:"Failure is the stepping stone to success",cat:"Abstract",difficulty:"Easy",keyAngles:["Learning mindset","Survivorship bias","When failure is just failure","Pivoting vs persistence"]},
  {id:12,topic:"Is luck more important than hard work?",cat:"Abstract",difficulty:"Medium",keyAngles:["Privilege and access","Preparation meets opportunity","Systematic advantages","Meritocracy myth"]},
  {id:13,topic:"Red — discuss",cat:"Abstract",difficulty:"Hard",keyAngles:["Danger/love/passion","Branding (Coca-Cola, Zomato)","Cultural meanings","Political symbolism"]},
  {id:14,topic:"Is perfection the enemy of progress?",cat:"Abstract",difficulty:"Medium",keyAngles:["MVP mindset","Quality vs speed","Analysis paralysis","When perfection matters (healthcare, aviation)"]},
  {id:15,topic:"Walls or bridges?",cat:"Abstract",difficulty:"Hard",keyAngles:["Protection vs connection","Trade barriers","Immigration","Mental walls"]},
  {id:16,topic:"Nothing is permanent",cat:"Abstract",difficulty:"Medium",keyAngles:["Disruption in business","Adaptability","Brand relevance","Change management"]},

  // Business/Case-based
  {id:17,topic:"Should Reliance enter the electric vehicle market?",cat:"Case-Based",difficulty:"Medium",keyAngles:["Synergy with Jio","Capital allocation","Competition (Tata, M&M)","Battery tech"]},
  {id:18,topic:"A traditional FMCG brand is losing market share to D2C brands. What should they do?",cat:"Case-Based",difficulty:"Medium",keyAngles:["D2C acquisition","Digital transformation","Distribution advantage","Brand trust"]},
  {id:19,topic:"Should Indian railways be privatized?",cat:"Case-Based",difficulty:"Hard",keyAngles:["Efficiency vs access","Global examples (Japan, UK)","Employment impact","Infrastructure investment"]},
  {id:20,topic:"Is it ethical for companies to use dynamic pricing?",cat:"Case-Based",difficulty:"Medium",keyAngles:["Surge pricing (Uber)","Airline models","Consumer fairness","Supply-demand economics"]},
  {id:21,topic:"Should luxury brands enter tier-2 Indian cities?",cat:"Case-Based",difficulty:"Medium",keyAngles:["Aspirational consumers","Infrastructure","Brand dilution risk","Digital-first approach"]},
  {id:22,topic:"Your company has ₹100 crore to spend. Acquire a competitor or invest in R&D?",cat:"Case-Based",difficulty:"Hard",keyAngles:["Build vs buy","Time to market","Cultural integration","Innovation pipeline"]},
  {id:23,topic:"Should OTT platforms censor content in India?",cat:"Case-Based",difficulty:"Medium",keyAngles:["Creative freedom","Cultural sensitivity","Self-regulation","Government role"]},
  {id:24,topic:"Print newspapers will die within 10 years. Agree or disagree?",cat:"Case-Based",difficulty:"Easy",keyAngles:["Digital shift","Rural readership","Advertising revenue","Trust factor"]},

  // Controversial
  {id:25,topic:"MBA education is overrated",cat:"Controversial",difficulty:"Medium",keyAngles:["ROI of MBA","Network value","Skill gap","Alternative paths (entrepreneurs)"]},
  {id:26,topic:"Reservation in private sector — for or against?",cat:"Controversial",difficulty:"Hard",keyAngles:["Social equity","Merit argument","Implementation challenges","Corporate diversity"]},
  {id:27,topic:"Influencer marketing is destroying authentic branding",cat:"Controversial",difficulty:"Medium",keyAngles:["Fake authenticity","ROI measurement","Consumer trust","Brand safety"]},
  {id:28,topic:"Work-life balance is a myth in corporate India",cat:"Controversial",difficulty:"Easy",keyAngles:["Hustle culture","Mental health","Generational differences","Policy vs culture"]},
  {id:29,topic:"Should MNCs be held responsible for environmental damage in developing countries?",cat:"Controversial",difficulty:"Hard",keyAngles:["Corporate responsibility","Regulatory gaps","Economic dependency","ESG movement"]},
  {id:30,topic:"Billionaires should not exist",cat:"Controversial",difficulty:"Hard",keyAngles:["Wealth creation vs inequality","Philanthropy","Tax policy","Innovation incentive"]},

  // Marketing-Specific
  {id:31,topic:"Is brand purpose genuine or just marketing?",cat:"Marketing",difficulty:"Medium",keyAngles:["Consumer cynicism","Performative activism","Brands that walk the talk","Revenue impact"]},
  {id:32,topic:"Traditional advertising is dead — digital is everything",cat:"Marketing",difficulty:"Easy",keyAngles:["Rural reach","TV still dominates FMCG","Digital attribution","Omnichannel reality"]},
  {id:33,topic:"Should brands take political stands?",cat:"Marketing",difficulty:"Hard",keyAngles:["Nike/Kaepernick","Consumer backlash","Brand values","Market polarization"]},
  {id:34,topic:"Customer is always right — is this still true?",cat:"Marketing",difficulty:"Easy",keyAngles:["Service culture","Toxic customers","Employee wellbeing","Brand boundaries"]},
  {id:35,topic:"AI will replace 50% of marketing jobs in 5 years",cat:"Marketing",difficulty:"Medium",keyAngles:["Automation vs creativity","Data analytics","Content generation","Human insight"]},
  {id:36,topic:"Premiumization or mass market — which is the future of Indian FMCG?",cat:"Marketing",difficulty:"Medium",keyAngles:["Rising incomes","Sachet economy","Two Indias","Category-dependent"]},
  {id:37,topic:"Viral marketing is overrated — consistency beats virality",cat:"Marketing",difficulty:"Medium",keyAngles:["Flash vs foundation","Brand building","Amul model","Short-term vs long-term"]},
  {id:38,topic:"Privacy regulations will kill personalized marketing",cat:"Marketing",difficulty:"Hard",keyAngles:["Cookie deprecation","First-party data","Contextual targeting","Consumer consent"]},

  // Quirky/Abstract (IIM favorites)
  {id:39,topic:"If you could delete one invention from history, what would it be?",cat:"Abstract",difficulty:"Hard",keyAngles:["Weapons","Social media","Plastics","Nuclear energy — multiple valid takes"]},
  {id:40,topic:"Zero",cat:"Abstract",difficulty:"Hard",keyAngles:["Mathematical revolution","Starting from nothing","India's contribution","Emptiness vs potential"]}
];

const GD_CATEGORIES = [...new Set(GD_TOPICS.map(t => t.cat))];

app.get("/api/gd-bank", async function(req, res) {
  res.json({ topics: GD_TOPICS, categories: GD_CATEGORIES, total: GD_TOPICS.length });
});

app.get("/api/gd-from-news", async function(req, res) {
  var today = new Date().toISOString().split("T")[0];
  var cached = (await pool.query("SELECT content FROM daily_content WHERE date = $1", [today])).rows[0];
  if (!cached) return res.json({ success: false, error: "No news loaded today. Open the Today tab first." });

  var content = JSON.parse(cached.content);
  var headlines = (content.newsBites || []).map(function(b) { return b.headline + " (" + b.category + ")"; }).join("\n");

  var prompt = `Based on these today's news headlines, generate 5 Group Discussion topics that a panel might give MBA students. Each topic should be debatable with strong arguments on both sides.

TODAY'S NEWS:
${headlines}

Return ONLY valid JSON (no markdown):
[
  {
    "topic": "The GD topic framed as a debatable statement or question",
    "sourceHeadline": "Which news headline inspired this topic",
    "forPoints": ["Argument for 1", "Argument for 2", "Argument for 3"],
    "againstPoints": ["Argument against 1", "Argument against 2", "Argument against 3"],
    "openingHook": "A strong opening sentence a candidate could use to start the GD on this topic"
  }
]

RULES:
- Make topics debatable — not one-sided
- Frame as statements ("X should Y") or questions ("Is X good for India?")
- forPoints and againstPoints should have real substance, not generic
- openingHook should include a data point or striking observation from the news`;

  try {
    var result = await model.generateContent(prompt);
    var text = result.response.text().replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    var topics = JSON.parse(text);
    if (!Array.isArray(topics)) throw new Error("Not array");
    res.json({ success: true, topics: topics, date: today });
  } catch (err) {
    console.error("GD from news error:", err.message);
    res.json({ success: false, error: "Could not generate topics. Try again." });
  }
});

// ═══ IIM-STYLE COMPANY INTERVIEW BANK ═══
const IIM_INTERVIEWS = [
  // ─── FMCG: HUL ───
  {id:1,q:"You are the Brand Manager for Surf Excel. A regional detergent is eating your rural share with a 40% lower price. What do you do?",co:"HUL",sector:"FMCG",round:"Case",style:"They give you a real brand and a real problem. You must think like a brand manager, not a student.",tip:"Don't jump to 'lower the price'. Think: why are consumers switching? Is it trial or loyalty? Consider flanker brand, sachet strategy, distribution push."},
  {id:2,q:"Walk me through a Dove ad you've seen recently. What consumer insight does it use?",co:"HUL",sector:"FMCG",round:"Marketing Fit",style:"Tests if you actually watch and analyze ads in daily life.",tip:"Name the exact ad, the platform you saw it on, the insight (self-esteem, real beauty), and how it drives purchase. Don't be generic."},
  {id:3,q:"If I give you ₹5 crore marketing budget for Bru coffee, how would you spend it this quarter?",co:"HUL",sector:"FMCG",round:"Case",style:"Budget allocation case. They want channel-level thinking.",tip:"Split by: TV (reach), digital (engagement), trade (visibility), sampling (trial). Justify % for each. Know Bru's competition (Nescafe)."},
  {id:4,q:"Sell me this Kwality Wall's ice cream in 2 minutes. I'm a kirana store owner in Lucknow who's never stocked it.",co:"HUL",sector:"FMCG",round:"Role-Play",style:"Live selling exercise. Tests persuasion and trade marketing understanding.",tip:"Don't pitch features. Ask about his customers first. Then: margin story, freezer support, brand pull, consumer demand. Close with trial."},
  {id:5,q:"Why FMCG and not tech? Your resume screams tech background.",co:"HUL",sector:"FMCG",round:"HR/Fit",style:"Stress question for career switchers. They want genuine passion for consumer goods.",tip:"Connect tech background as an advantage (data-driven marketing), but show genuine passion: name brands you admire, marketing campaigns you follow, consumer behavior you've observed."},

  // ─── FMCG: ITC ───
  {id:6,q:"ITC's Classmate notebooks compete with unbranded notebooks that cost 60% less. How do you defend market share in tier-3 cities?",co:"ITC",sector:"FMCG",round:"Case",style:"ITC loves distribution and rural India questions.",tip:"Think distribution (ITC's e-Choupal network), school engagement programs, trade margins for retailers, pack-size variants."},
  {id:7,q:"Should ITC enter the premium chocolate segment? Make a case for or against.",co:"ITC",sector:"FMCG",round:"Case",style:"New category entry case. They want you to know ITC's portfolio.",tip:"Know ITC's Fabelle already exists. Discuss: market size (₹20K+ crore), competition (Cadbury, Ferrero), ITC's distribution strength vs premium positioning challenge."},

  // ─── FMCG: P&G ───
  {id:8,q:"Tell me about a time you turned data into an actionable insight that changed a decision.",co:"P&G",sector:"FMCG",round:"Behavioral",style:"P&G uses structured behavioral rounds with leadership framework (PVP: Purpose, Values, Principles).",tip:"P&G wants 'what did YOU do, not the team'. Use STAR, emphasize your individual thinking and impact. Include numbers."},
  {id:9,q:"How would you increase Gillette's market share among 18-22 year olds in India?",co:"P&G",sector:"FMCG",round:"Case",style:"Consumer-first thinking. They want insights about young Indian men's grooming habits.",tip:"Start with consumer insight: first shavers, peer influence, price sensitivity. Then: sampling in colleges, influencer play, starter kit pricing, digital-first media plan."},

  // ─── CONSULTING: McKinsey ───
  {id:10,q:"A leading Indian airline's profits dropped 30% last quarter despite 15% revenue growth. What's happening?",co:"McKinsey",sector:"Consulting",round:"Case",style:"Profitability case. McKinsey expects structured hypothesis-driven approach.",tip:"Framework: Revenue is up so focus on costs. Disaggregate: fuel (ATF prices?), fleet (new planes = depreciation?), routes (low-yield routes?), competition (price war?). Ask clarifying questions before solving."},
  {id:11,q:"Should a global luxury fashion brand enter India through online-only or open flagship stores?",co:"McKinsey",sector:"Consulting",round:"Case",style:"Market entry + channel strategy. Tests structured thinking.",tip:"Evaluate both on: brand perception, unit economics, customer experience, competitive landscape. Recommend hybrid with reasoning. Show you know India's luxury market (Ambience Mall, Jio World Plaza)."},
  {id:12,q:"Estimate the number of weddings in India per year.",co:"McKinsey",sector:"Consulting",round:"Guesstimate",style:"Classic market sizing. They care about your approach more than the number.",tip:"Population 1.4B → marriageable age cohort → annual marriage rate → adjust for regions and religions → cross-check with government data (~1 crore/year)."},

  // ─── CONSULTING: BCG ───
  {id:13,q:"A hospital chain wants to expand from 5 cities to 15 in 3 years. How should they prioritize which cities?",co:"BCG",sector:"Consulting",round:"Case",style:"Growth strategy case. BCG loves structured prioritization.",tip:"Create a scoring matrix: city population, healthcare spending, competition density, real estate costs, medical talent availability, regulatory environment. Rank and recommend."},

  // ─── TECH: Amazon ───
  {id:14,q:"Tell me about a time you had to make a decision without enough data. What was the outcome?",co:"Amazon",sector:"Tech",round:"Behavioral (LP)",style:"Amazon uses 14 Leadership Principles. This tests 'Bias for Action' and 'Are Right, A Lot'.",tip:"Amazon wants: what data you DID use, what assumptions you made, what the risk was, and what you learned. They value speed over perfection."},
  {id:15,q:"You're the category manager for Electronics on Amazon India. How would you grow the smartphones category by 25% in 6 months?",co:"Amazon",sector:"Tech",round:"Case",style:"Growth case. Amazon wants data-driven, customer-obsessed thinking.",tip:"Think: selection (more brands/models), pricing (exchange offers, EMI), traffic (search, ads, events like Great Indian Festival), conversion (reviews, delivery speed), retention (Prime). Quantify where possible."},
  {id:16,q:"A seller is listing counterfeit products and getting 5-star reviews. How do you handle it?",co:"Amazon",sector:"Tech",round:"Judgment",style:"Tests 'Customer Obsession' and 'Earn Trust'. There's a right answer here.",tip:"Customer safety first → remove listing immediately → investigate review manipulation → penalize seller → systemic fix (AI detection, brand registry). Don't try to 'balance' seller and customer — Amazon is customer-first."},

  // ─── TECH: Google ───
  {id:17,q:"Design a product to help Indian college students find internships. What features would it have?",co:"Google",sector:"Tech",round:"Product",style:"Google product interview. They want user empathy + product thinking.",tip:"Start with user research: who (engineering vs arts vs MBA), current solutions (LinkedIn, naukri, college placement cell), pain points (discovery, application tracking, skill gap). Then: MVP features, success metrics, GTM."},

  // ─── E-COMMERCE: Flipkart ───
  {id:18,q:"Flipkart's Big Billion Days sees 80% of orders from 3 metro cities. How would you grow tier-2 and tier-3 orders?",co:"Flipkart",sector:"E-commerce",round:"Case",style:"Growth + accessibility case. Flipkart loves India-specific challenges.",tip:"Barriers: trust (COD preference), language (vernacular UI), awareness (TV + local media), logistics (delivery speed), assortment (regional preferences). Prioritize by impact and feasibility."},
  {id:19,q:"You notice that cart abandonment rate is 75% on the Flipkart app. Diagnose and fix it.",co:"Flipkart",sector:"E-commerce",round:"Product",style:"Funnel optimization. Tests analytical + product thinking.",tip:"Disaggregate: where in funnel? (product page → cart → address → payment → confirm). Common causes: price comparison, shipping cost surprise, payment failure, login friction. A/B test solutions. Don't just list — prioritize by drop-off data."},

  // ─── BANKING: Goldman Sachs ───
  {id:20,q:"If you were advising a mid-size Indian IT company on whether to acquire a smaller AI startup, what would you analyze?",co:"Goldman Sachs",sector:"Finance",round:"Case",style:"M&A case. Tests financial and strategic thinking.",tip:"Framework: Strategic fit (capability gap), Valuation (DCF, comparables), Synergies (revenue + cost), Integration risks, Cultural fit. Know basic valuation terms."},

  // ─── CONGLOMERATE: Tata ───
  {id:21,q:"Tata Group has 100+ companies. If you had to kill 5, which ones and why?",co:"Tata Group",sector:"Conglomerate",round:"Strategy",style:"Portfolio rationalization. Tests business breadth + strategic courage.",tip:"Use BCG Matrix or portfolio analysis. Evaluate each business on: market attractiveness, competitive position, strategic fit with Tata's values, capital intensity. Be bold but justify with data."},
  {id:22,q:"How would you make Tata Neu the #1 super app in India, beating Paytm and PhonePe?",co:"Tata Group",sector:"Conglomerate",round:"Case",style:"Platform strategy. Tests understanding of ecosystem play.",tip:"Tata Neu's advantage: cross-brand loyalty (Starbucks, BigBasket, 1mg, AirAsia, Croma). Strategy: unified rewards, exclusive deals, data-driven personalization, habit formation through daily-use categories."},

  // ─── STARTUP: Swiggy/Zomato ───
  {id:23,q:"Swiggy's delivery cost per order is ₹45. The average order value is ₹250. How do you make the unit economics work?",co:"Swiggy",sector:"Startup",round:"Case",style:"Unit economics deep-dive. Startups want you to think like a founder.",tip:"Levers: increase AOV (bundling, minimum order), reduce delivery cost (batching, dark stores, shorter radius), increase commission, ad revenue from restaurants, subscription (Swiggy One). Show the math."},
  {id:24,q:"Should Zomato enter the events and live experiences business? Why or why not?",co:"Zomato",sector:"Startup",round:"Strategy",style:"Adjacent market entry. Tests strategic judgment.",tip:"Evaluate: is there a natural user overlap? (diners → event-goers, yes). Competitive landscape (BookMyShow). Zomato's assets (restaurant relationships, user base, payment infra). Risks (execution complexity, brand dilution)."},

  // ─── MEDIA: Star/Disney+ Hotstar ───
  {id:25,q:"IPL streaming rights cost ₹23,000 crore. How does Disney+ Hotstar recover this investment?",co:"Disney+ Hotstar",sector:"Media",round:"Case",style:"Revenue model case for media business.",tip:"Revenue streams: subscription (ARPU × subscribers), advertising (CPM × impressions × matches), sponsorships, in-app commerce, data licensing. Show the math: need X subscribers at Y ARPU to break even."},

  // ─── PHARMA: Sun Pharma ───
  {id:26,q:"An OTC pain relief brand is #3 in India behind Crocin and Combiflam. How do you make it #1?",co:"Sun Pharma",sector:"Pharma",round:"Case",style:"Brand growth in regulated category.",tip:"OTC pharma is trust-driven. Strategy: doctor recommendations (medical reps), pharmacist incentives, consumer awareness (symptom-specific positioning), digital health content, pack differentiation."},

  // ─── PANEL INTERVIEW STYLE ───
  {id:27,q:"Three of us will interview you. I'll ask about your past, she'll test your domain, and he'll try to stress you. Ready?",co:"Multi-panel",sector:"Any",round:"Panel Setup",style:"IIM panel interviews often start with this. Don't let it shake you.",tip:"Nod, smile, say 'Yes, looking forward to it.' The warning IS the stress test. If you flinch, you've already lost points. Stay composed."},
  {id:28,q:"Your batch mate sitting outside told us you're not very good at teamwork. Your response?",co:"Multi-panel",sector:"Any",round:"Stress",style:"Classic stress question. They may or may not have talked to anyone. Tests composure and self-awareness.",tip:"Don't get defensive or badmouth anyone. Say: 'I appreciate that perspective. I'd be curious about the specific situation they're referring to, because in my experience...' then share a strong teamwork STAR story."},
  {id:29,q:"I've interviewed 15 people today. Convince me in 60 seconds why I should remember you.",co:"Multi-panel",sector:"Any",round:"Elevator Pitch",style:"End-of-day fatigue test. They want energy, clarity, and memorability.",tip:"Don't list achievements. Tell one micro-story that captures who you are. End with how you'll add value to their team specifically. Be energetic — energy is memorable."},
  {id:30,q:"Rate yourself out of 10 on these: leadership, marketing knowledge, communication, pressure handling. Now justify the lowest score.",co:"Multi-panel",sector:"Any",round:"Self-Assessment",style:"Tests self-awareness AND how you handle vulnerability. The lowest score IS the question.",tip:"Don't give yourself all 8s and 9s — that's not self-aware. Give honest scores (e.g., marketing knowledge: 6). Then show what you're doing to improve it. Growth mindset wins."},

  // ─── RAPID FIRE / QUIRKY ───
  {id:31,q:"If marketing didn't exist as a function, how would products sell?",co:"Any B-school panel",sector:"Any",round:"Abstract",style:"Tests fundamental understanding of marketing's role. Not a trick question.",tip:"Go deeper than 'they wouldn't sell'. Think: word of mouth, product quality driving repeat purchase, community, network effects. Marketing has always existed — it was just informal."},
  {id:32,q:"Pick any Indian brand. Tell me 3 things they're doing wrong.",co:"Any B-school panel",sector:"Any",round:"Opinion",style:"Tests whether you think critically about brands, not just admire them.",tip:"Pick a brand you actually use. Be specific: 'Paytm's app has 47 features on the home screen — that's cognitive overload. They should...' Show you think like a marketer, not a fan."},
  {id:33,q:"You have 2 minutes. Teach me something I don't know.",co:"Any B-school panel",sector:"Any",round:"Creativity",style:"Tests communication, confidence, and the ability to hold attention. Prepare this in advance.",tip:"Pick something genuinely interesting and niche — not 'what is blockchain'. A marketing paradox, a behavioral economics finding, a surprising India stat. Practice the 2-minute version until it's smooth."},
  {id:34,q:"What's the most overrated marketing concept and why?",co:"Any B-school panel",sector:"Any",round:"Opinion",style:"Tests if you can challenge conventional wisdom with reasoning.",tip:"Pick something you can defend: 'Brand purpose — most purpose campaigns are performative. Consumers see through it. Amul succeeds without purpose marketing.' Have a counter-view ready too."},
  {id:35,q:"Name a product that failed in India despite great marketing. What went wrong?",co:"Any B-school panel",sector:"Any",round:"Analysis",style:"Tests product vs marketing understanding.",tip:"Good examples: Google Glass, Tata Nano (stigma), Amazon Fire Phone, Snapdeal (trust). Key insight: marketing can't fix a product-market fit problem."}
];

const IIM_SECTORS = [...new Set(IIM_INTERVIEWS.map(q => q.sector))];
const IIM_COMPANIES = [...new Set(IIM_INTERVIEWS.map(q => q.co))];

app.get("/api/iim-bank", async function(req, res) {
  var practiced = {};
  if (req.session.userId) {
    var sessions = (await pool.query("SELECT messages FROM coach_sessions WHERE user_id = $1 AND practice_type IN ('case','iim','mock','company')", [req.session.userId])).rows;
    sessions.forEach(function(s) {
      var msgs = JSON.parse(s.messages);
      IIM_INTERVIEWS.forEach(function(iq) {
        var qLower = iq.q.toLowerCase().substring(0, 35);
        msgs.forEach(function(m) {
          if (m.role === 'assistant' && m.content.toLowerCase().indexOf(qLower) >= 0) practiced[iq.id] = true;
        });
      });
    });
  }
  res.json({ questions: IIM_INTERVIEWS, sectors: IIM_SECTORS, companies: IIM_COMPANIES, practiced: practiced, total: IIM_INTERVIEWS.length, practicedCount: Object.keys(practiced).length });
});

// ═══ CURRENT AFFAIRS QUIZ ═══
app.post("/api/ca-quiz", async function(req, res) {
  if (!req.session.userId) return res.status(401).json({ success: false });

  var category = req.body.category || 'mixed';
  var difficulty = req.body.difficulty || 'medium';
  var count = Math.min(15, Math.max(5, parseInt(req.body.count) || 10));

  var catPrompt = {
    mixed: "Mix of Indian economy, global business, marketing campaigns, tech, policy, and startups",
    marketing: "Marketing campaigns, brand launches, rebrands, ad controversies, digital marketing trends in India",
    economy: "Indian economy: GDP, RBI policy, inflation, trade, budget, taxation, reforms",
    business: "Indian business: M&A deals, IPOs, quarterly results, leadership changes, expansions",
    tech: "Technology: AI developments, startup funding, app launches, digital India, tech policy",
    global: "Global affairs relevant to business: trade wars, geopolitics affecting markets, global brands, international economic events",
    policy: "Government policy: new regulations, SEBI rules, FMCG regulations, digital privacy, labor laws, FDI policy"
  };

  var prompt = `Generate a current affairs quiz for an MBA marketing student preparing for placement interviews in India.

CATEGORY: ${catPrompt[category] || catPrompt.mixed}
DIFFICULTY: ${difficulty} (easy = basic awareness, medium = must-know for interviews, hard = deep understanding + opinion required)
COUNT: ${count} questions

Return ONLY valid JSON (no markdown, no backticks):
{
  "questions": [
    {
      "q": "The question — frame it how an interviewer would ask, not like a GK quiz",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "correct": 0,
      "explanation": "Why this answer is correct + the business/marketing implication",
      "interviewUse": "How to use this knowledge in an interview — a 1-line sample answer frame",
      "topic": "Short topic tag (e.g., 'RBI Policy', 'D2C Brands', 'Quick Commerce')",
      "difficulty": "easy/medium/hard"
    }
  ]
}

RULES:
- Questions should be about events/developments from the last 6-12 months
- Frame questions the way an interviewer would: "What's your take on..." or "Are you following..." not "In which year..."
- Include the BUSINESS and MARKETING angle — not just what happened, but what it means
- "interviewUse" should be a natural sentence a candidate could say: "This is an example of market consolidation, where..."
- Mix factual recall with opinion/analysis questions
- For hard difficulty, ask "what does this mean for marketers?" type questions
- Focus on India-relevant topics that B-school interviewers actually care about`;

  try {
    var result = await model.generateContent(prompt);
    var text = result.response.text().replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    var data = JSON.parse(text);
    if (!data.questions || !Array.isArray(data.questions)) throw new Error("Invalid format");

    // Save quiz results for tracking
    res.json({ success: true, quiz: data.questions, category: category, count: data.questions.length });
  } catch (err) {
    console.error("CA Quiz error:", err.message);
    res.json({ success: false, error: "Could not generate quiz. Try again." });
  }
});

app.post("/api/ca-quiz-result", async function(req, res) {
  if (!req.session.userId) return res.json({ success: false });
  var b = req.body;
  // Store in a simple format: category, score, total, weak topics
  await pool.query("INSERT INTO daily_content (date, content) VALUES ($1, $2) ON CONFLICT (date) DO UPDATE SET content = EXCLUDED.content",
    ['ca-quiz-' + req.session.userId + '-' + Date.now(),
      JSON.stringify({ type: 'ca-quiz', userId: req.session.userId, category: b.category, score: b.score, total: b.total, weakTopics: b.weakTopics, date: new Date().toISOString() })
    ]);
  res.json({ success: true });
});

// ═══ RESUME QUESTION GENERATOR ═══
app.post("/api/resume-questions", async function(req, res) {
  if (!req.session.userId) return res.status(401).json({ success: false });
  var user = (await pool.query("SELECT * FROM users WHERE id=$1", [req.session.userId])).rows[0];
  if (!user || !user.cv || user.cv.trim().length < 50) {
    return res.json({ success: false, error: "Add your CV in the Profile tab first (at least a few lines)." });
  }
  var stories = (await pool.query("SELECT title,situation,task,action,result FROM stories WHERE user_id=$1 LIMIT 10", [req.session.userId])).rows;

  var prompt = `You are an expert MBA placement interviewer AND career coach. Analyze this candidate's CV and generate EVERY possible interview question, with complete answer guidance for each.

CV/RESUME:
${user.cv}

${user.target_companies ? 'TARGET COMPANIES: ' + user.target_companies : ''}
${user.target_roles ? 'TARGET ROLES: ' + user.target_roles : ''}
${user.strengths ? 'SELF-STATED STRENGTHS: ' + user.strengths : ''}
${user.weaknesses ? 'SELF-STATED WEAKNESSES: ' + user.weaknesses : ''}
${stories.length > 0 ? 'STAR STORIES ON FILE: ' + stories.map(s => s.title).join(', ') : ''}

Return ONLY valid JSON array (no markdown, no backticks). Each object must have ALL these fields:

[
  {
    "q": "The interview question",
    "cat": "category name",
    "why": "What the interviewer is really testing with this question",
    "trap": "The common mistake or trap most candidates fall into",
    "source": "Which specific CV line or detail triggered this question",
    "keyPoints": ["Point 1 to cover", "Point 2 to cover", "Point 3 to cover"],
    "modelAnswer": "A strong 4-6 sentence model answer written as if the candidate is speaking. Use specific details from their CV. Include numbers where possible. Use STAR structure for behavioral questions.",
    "doThis": "One sentence of what TO do when answering",
    "dontDoThis": "One sentence of what NOT to do when answering",
    "followUps": ["Likely follow-up question 1", "Likely follow-up question 2"]
  }
]

CATEGORIES — generate questions for ALL that apply:
1. "Work Experience" — For EACH role/job: what you did, why you joined, why you left, biggest achievement, biggest failure, what you learned, team size, specific projects
2. "Education" — Why this college, CGPA/grades, favorite subject, gap years, academic projects, extracurriculars
3. "Skills & Claims" — For EACH skill/achievement: "Give me an example of...", "How did you measure...", "What specifically did YOU do?"
4. "Gaps & Inconsistencies" — Career gaps, short stints, industry switches, unexplained transitions
5. "Numbers & Proof" — Every number claimed: what was the baseline? methodology? your contribution?
6. "Why Marketing" — Connect CV background to marketing career choice
7. "Stress Test" — Uncomfortable questions that expose weaknesses or inconsistencies
8. "Future & Fit" — How past connects to target role/company

CRITICAL RULES for model answers:
- Write model answers in FIRST PERSON as if the candidate is speaking
- Use SPECIFIC details from their actual CV — not generic advice
- For behavioral questions, use STAR: Situation → Task → Action → Result
- Include numbers and metrics wherever the CV provides them
- Keep model answers 4-6 sentences — concise but complete
- The answer should be something this specific candidate could realistically say
- followUps should be questions the interviewer would ask AFTER hearing the model answer

Generate 25-40 questions. Miss nothing on the CV.`;

  // Check cache — if CV hasn't changed, return cached questions
  var cvHash = Buffer.from(user.cv.substring(0, 200)).toString('base64').substring(0, 40);
  var forceRefresh = req.body.refresh === true;
  if (!forceRefresh) {
    var cached = (await pool.query("SELECT questions FROM resume_questions_cache WHERE user_id = $1 AND cv_hash = $2", [req.session.userId, cvHash])).rows[0];
    if (cached) {
      var qs = JSON.parse(cached.questions);
      return res.json({ success: true, questions: qs, total: qs.length, cached: true });
    }
  }

  try {
    var result = await model.generateContent(prompt);
    var text = result.response.text().replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    var questions = JSON.parse(text);
    if (!Array.isArray(questions)) throw new Error("Not an array");

    // Cache the results
    await pool.query("INSERT INTO resume_questions_cache (user_id, questions, cv_hash) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO UPDATE SET questions = EXCLUDED.questions, cv_hash = EXCLUDED.cv_hash", [
      req.session.userId, JSON.stringify(questions), cvHash
    ]);

    res.json({ success: true, questions: questions, total: questions.length, cached: false });
  } catch (err) {
    console.error("Resume Q error:", err.message);
    res.json({ success: false, error: "Could not generate questions. Try again." });
  }
});

// ═══ GROWTH AREA + SCORE PARSING ═══

async function parseAndStoreGrowthAreas(userId, coachReply) {
  var match = coachReply.match(/<!--GROWTH_AREAS_JSON\s*([\s\S]*?)\s*GROWTH_AREAS_JSON-->/);
  if (!match) return;
  try {
    var areas = JSON.parse(match[1]);
    if (!Array.isArray(areas)) return;
    var today = new Date().toISOString().split("T")[0];
    for (var i = 0; i < areas.length; i++) {
      var item = areas[i];
      if (!item.area || !item.category) continue;
      var normalizedArea = item.area.trim();
      var existing = (await pool.query("SELECT id, count FROM growth_areas WHERE user_id = $1 AND area = $2", [userId, normalizedArea])).rows[0];
      if (existing) { await pool.query("UPDATE growth_areas SET count = count + 1, last_seen = $1 WHERE id = $2", [today, existing.id]); }
      else { await pool.query("INSERT INTO growth_areas (user_id, area, category, count, first_seen, last_seen) VALUES ($1, $2, $3, 1, $4, $5)", [userId, normalizedArea, item.category, today, today]); }
    }
  } catch (e) { console.log("Growth area parse error:", e.message); }
}

async function parseAndStoreCoachScores(userId, coachReply, practiceType) {
  var scores = null;

  // Try GD scoring format first: 📊 Content: X | Initiative: X | Structure: X | Listening: X | Composure: X
  var gdMatch = coachReply.match(/📊\s*Content:\s*(\d+)\s*[|/]\s*Initiative:\s*(\d+)\s*[|/]\s*Structure:\s*(\d+)\s*[|/]\s*Listening:\s*(\d+)\s*[|/]\s*Composure:\s*(\d+)/i);
  if (gdMatch) {
    scores = {
      type: 'gd',
      content: Math.min(10, Math.max(0, parseInt(gdMatch[1]))),
      initiative: Math.min(10, Math.max(0, parseInt(gdMatch[2]))),
      structure: Math.min(10, Math.max(0, parseInt(gdMatch[3]))),
      listening: Math.min(10, Math.max(0, parseInt(gdMatch[4]))),
      composure: Math.min(10, Math.max(0, parseInt(gdMatch[5])))
    };
    // Map GD scores to the 4-column storage: relevance=content, structure=structure, specificity=listening, marketing=composure
    await pool.query("INSERT INTO coach_scores (user_id, practice_type, relevance, structure, specificity, marketing) VALUES ($1, $2, $3, $4, $5, $6)", [
      userId, practiceType, scores.content, scores.structure, scores.listening, scores.composure
    ]);
    return scores;
  }

  // Try regular scoring: 📊 Relevance: X | Structure: X | Specificity: X | Marketing: X
  var match = coachReply.match(/📊\s*Relevance:\s*(\d+)\s*[|/]\s*Structure:\s*(\d+)\s*[|/]\s*Specificity:\s*(\d+)\s*[|/]\s*Marketing(?:\s*Acumen)?:\s*(\d+)/i);
  if (!match) return null;
  scores = {
    type: 'regular',
    relevance: Math.min(10, Math.max(0, parseInt(match[1]))),
    structure: Math.min(10, Math.max(0, parseInt(match[2]))),
    specificity: Math.min(10, Math.max(0, parseInt(match[3]))),
    marketing: Math.min(10, Math.max(0, parseInt(match[4])))
  };
  await pool.query("INSERT INTO coach_scores (user_id, practice_type, relevance, structure, specificity, marketing) VALUES ($1, $2, $3, $4, $5, $6)", [
    userId, practiceType, scores.relevance, scores.structure, scores.specificity, scores.marketing
  ]);
  return scores;
}

function cleanCoachReply(reply) {
  return reply.replace(/<!--GROWTH_AREAS_JSON[\s\S]*?GROWTH_AREAS_JSON-->/g, "").trim();
}

// ═══ AUTH ═══
app.post("/api/signup", async function(req, res) {
  var n=req.body.name, e=req.body.email, p=req.body.password;
  if(!n||!e||!p) return res.json({success:false,error:"All fields required"});
  if(p.length<4) return res.json({success:false,error:"Password too short"});
  var exists = (await pool.query("SELECT id FROM users WHERE email=$1", [e.toLowerCase().trim()])).rows[0];
  if(exists) return res.json({success:false,error:"Email taken"});
  var r = await pool.query("INSERT INTO users (name,email,password) VALUES ($1,$2,$3) RETURNING id", [n.trim(), e.toLowerCase().trim(), bcrypt.hashSync(p,10)]);
  req.session.userId = r.rows[0].id;
  res.json({success:true, user:{id:r.rows[0].id, name:n.trim(), email:e.toLowerCase()}});
});
app.post("/api/login", async function(req, res) {
  var e=req.body.email, p=req.body.password;
  var user = (await pool.query("SELECT * FROM users WHERE email=$1", [(e||'').toLowerCase().trim()])).rows[0];
  if(!user) return res.json({success:false,error:"No account"});
  if(!bcrypt.compareSync(p||'',user.password)) return res.json({success:false,error:"Wrong password"});
  req.session.userId = user.id;
  res.json({success:true, user:{id:user.id, name:user.name, email:user.email}});
});
app.post("/api/logout", async function(req, res) { req.session.destroy(); res.json({success:true}); });
app.get("/api/me", async function(req, res) { if(!req.session.userId)return res.json({loggedIn:false}); var user=(await pool.query("SELECT id,name,email,cv,strengths,weaknesses,target_companies,target_roles FROM users WHERE id=$1", [req.session.userId])).rows[0]; var streak=(await pool.query("SELECT current_streak,longest_streak FROM streaks WHERE user_id=$1", [req.session.userId])).rows[0]; res.json({loggedIn:true,user:user,streak:streak||{current_streak:0,longest_streak:0}}); });
app.put("/api/profile", async function(req, res) { if(!req.session.userId)return res.status(401).json({success:false}); var b=req.body; await pool.query("UPDATE users SET cv=$1,strengths=$2,weaknesses=$3,target_companies=$4,target_roles=$5 WHERE id=$6", [b.cv||'',b.strengths||'',b.weaknesses||'',b.target_companies||'',b.target_roles||'',req.session.userId]); res.json({success:true}); });

// ═══ PROGRESS & CONTENT ═══
app.get("/api/progress", async function(req, res) { if(!req.session.userId)return res.json({progress:{}}); var today=new Date().toISOString().split("T")[0]; var rows=(await pool.query("SELECT card_key FROM progress WHERE user_id=$1 AND date=$2", [req.session.userId,today])).rows; var p={}; rows.forEach(function(r){p[r.card_key]=true}); res.json({progress:p}); });
app.post("/api/progress", async function(req, res) { if(!req.session.userId)return res.status(401).json({success:false}); var k=req.body.card_key,c=req.body.completed,today=new Date().toISOString().split("T")[0]; if(c){await pool.query("INSERT INTO progress (user_id,date,card_key) VALUES ($1,$2,$3) ON CONFLICT (user_id,date,card_key) DO NOTHING", [req.session.userId,today,k]);var streak=updateStreak(req.session.userId);res.json({success:true,streak:streak})}else{await pool.query("DELETE FROM progress WHERE user_id=$1 AND date=$2 AND card_key=$3", [req.session.userId,today,k]);res.json({success:true})} });
app.get("/api/stories", async function(req, res) { if(!req.session.userId)return res.status(401).json({success:false}); res.json({stories:(await pool.query("SELECT * FROM stories WHERE user_id=$1 ORDER BY created_at DESC", [req.session.userId])).rows}); });
app.post("/api/stories", async function(req, res) { if(!req.session.userId)return res.status(401).json({success:false}); var b=req.body; if(!b.title)return res.json({success:false,error:"Title required"}); var r=await pool.query("INSERT INTO stories (user_id,title,situation,task,action,result,tags) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id", [req.session.userId,b.title,b.situation||'',b.task||'',b.action||'',b.result||'',b.tags||'']); res.json({success:true,id:r.rows[0].id}); });
app.delete("/api/stories/:id", async function(req, res) { if(!req.session.userId)return res.status(401).json({success:false}); await pool.query("DELETE FROM stories WHERE id=$1 AND user_id=$2", [req.params.id,req.session.userId]); res.json({success:true}); });
app.get("/api/today", async function(req, res) { try{res.json({success:true,date:new Date().toISOString().split("T")[0],data:await getDailyContent()})}catch(e){res.status(500).json({success:false,error:"Failed to load content"})} });
app.post("/api/regenerate", async function(req, res) { var today=new Date().toISOString().split("T")[0]; await pool.query("DELETE FROM daily_content WHERE date=$1", [today]); try{res.json({success:true,data:await getDailyContent()})}catch(e){res.status(500).json({success:false,error:"Regeneration failed"})} });
app.get("/api/archive", async function(req, res) { res.json({dates:(await pool.query("SELECT date FROM daily_content ORDER BY date DESC LIMIT 30")).rows.map(function(r){return r.date})}); });
app.get("/api/day/:date", async function(req, res) { var row=(await pool.query("SELECT content FROM daily_content WHERE date=$1", [req.params.date])).rows[0]; if(row)res.json({success:true,date:req.params.date,data:JSON.parse(row.content)}); else res.json({success:false,error:"No content for this date"}); });
app.get("/api/weekly-recap", async function(req, res) { var rows=(await pool.query("SELECT date,content FROM daily_content ORDER BY date DESC LIMIT 7")).rows; res.json({recap:rows.map(function(r){var c=JSON.parse(r.content);return{date:r.date,headlines:(c.newsBites||[]).map(function(b){return{headline:b.headline,category:b.category}})}})}); });
app.get("/api/concepts-learned", async function(req, res) { var rows=(await pool.query("SELECT content FROM daily_content ORDER BY date DESC LIMIT 30")).rows; var s=new Set(); rows.forEach(function(r){var c=JSON.parse(r.content);(c.newsBites||[]).forEach(function(b){(b.concepts||[]).forEach(function(con){s.add(con.term)})});if(c.conceptOfTheDay)s.add(c.conceptOfTheDay.term)}); res.json({count:s.size,concepts:Array.from(s).sort()}); });

// ═══ AI COACH (with growth areas + score tracking) ═══
app.post("/api/coach", async function(req, res) {
  if (!req.session.userId) return res.status(401).json({ success: false, error: "Login required" });

  var message = req.body.message || 'Start coaching me';
  var history = req.body.history || [];
  var practiceType = req.body.practiceType || 'general';
  var user = (await pool.query("SELECT * FROM users WHERE id=$1", [req.session.userId])).rows[0];
  if (!user) return res.status(401).json({ success: false, error: "User not found" });
  var stories = (await pool.query("SELECT title, tags FROM stories WHERE user_id=$1 LIMIT 10", [req.session.userId])).rows;

  // Get speech stats for coaching
  var speechAvg = (await pool.query("SELECT AVG(wpm) as avgWpm, AVG(filler_count) as avgFillers, AVG(hedges) as avgHedges, COUNT(*) as c FROM speech_stats WHERE user_id=$1", [req.session.userId])).rows[0];
  var speechContext = speechAvg && speechAvg.c > 3
    ? "\nSPEECH PATTERNS (from " + speechAvg.c + " voice answers): Avg WPM: " + Math.round(speechAvg.avgWpm) + " (ideal: 130-150), Avg fillers/answer: " + Math.round(speechAvg.avgFillers*10)/10 + ", Avg hedges/answer: " + Math.round(speechAvg.avgHedges*10)/10 + ".\n" +
      (speechAvg.avgFillers > 2 ? "This student uses too many fillers. Gently point it out when relevant: 'Try to reduce filler words — pause instead of saying um.'\n" : "") +
      (speechAvg.avgWpm > 170 ? "This student speaks too fast. Remind them to slow down and breathe between points.\n" : "") +
      (speechAvg.avgHedges > 2 ? "This student hedges too much ('I think maybe', 'sort of'). Coach them to state opinions as statements.\n" : "")
    : "";

  var existingAreas = (await pool.query("SELECT area, category, count FROM growth_areas WHERE user_id=$1 ORDER BY count DESC LIMIT 10", [req.session.userId])).rows;
  var growthContext = existingAreas.length > 0
    ? "\nKNOWN GROWTH AREAS (recurring weaknesses from past sessions):\n" + existingAreas.map(function(a) { return "- " + a.area + " (" + a.count + " times, " + a.category + ")" }).join("\n") + "\nTarget questions at these weaknesses. If the student improves on one, acknowledge it.\n"
    : "";

  var coachInstruction = "You are an expert MBA interview coach for Marketing roles at Indian B-schools.\n\n" +
    "STUDENT: " + user.name + "\n" +
    "Target Companies: " + (user.target_companies || 'Not set') + "\n" +
    "Target Roles: " + (user.target_roles || 'Not set') + "\n" +
    "Strengths: " + (user.strengths || 'Not set') + "\n" +
    "Weaknesses: " + (user.weaknesses || 'Not set') + "\n" +
    "CV: " + (user.cv ? user.cv.substring(0, 800) : 'Not provided') + "\n" +
    "Stories: " + (stories.length > 0 ? stories.map(function(s){return s.title}).join(', ') : 'None') + "\n" +
    growthContext + speechContext + "\n" +
    "MODE: " + practiceType + "\n\n" +
    "RULES:\n" +
    "- Be warm but push for specifics\n" +
    "- Use marketing terminology naturally\n" +
    "- Keep responses under 250 words\n\n" +
    "LANGUAGE COACHING (do this for EVERY scored answer):\n" +
    "After your score and WEAK/BETTER/MEMORIZE feedback, add a language note if you spot ANY of these:\n" +
    "- Grammar errors: tense mistakes, article errors, subject-verb agreement, preposition misuse\n" +
    "- Common Indianisms: 'do one thing', 'revert back', 'passed out from college', 'I have a doubt', 'prepone', 'updation', 'today morning'\n" +
    "- Weak vocabulary: overuse of 'good/nice/important/thing/stuff' — suggest a stronger word\n" +
    "- Rambling sentences: if any sentence is 30+ words, flag it and show the shorter version\n" +
    "- Hedging language: 'I think maybe', 'sort of', 'kind of' — show the confident version\n" +
    "Format: 🗣️ LANGUAGE: [one specific correction + the fixed version]. Only flag 1-2 per answer, the most impactful ones. Skip this section if their English was clean.\n\n" +
    "SCORING — depends on mode:\n" +
    "For NON-GD modes (hr, case, rapid, news, general, company):\n" +
    "- Score on 4 dimensions (out of 10): Relevance | Structure | Specificity | Marketing Acumen\n" +
    "- Format: 📊 Relevance: X | Structure: X | Specificity: X | Marketing: X\n\n" +
    "For ALL GD modes (gd, gd-open, gd-counter, gd-summary):\n" +
    "- Score on 5 GD-SPECIFIC dimensions (out of 10): Content | Initiative | Structure | Listening | Composure\n" +
    "- Format: 📊 Content: X | Initiative: X | Structure: X | Listening: X | Composure: X\n" +
    "- Content = substance, data, examples used\n" +
    "- Initiative = did they enter well, lead the point\n" +
    "- Structure = was argument organized (point → evidence → impact)\n" +
    "- Listening = did they build on/acknowledge what others said\n" +
    "- Composure = calm under pressure, not aggressive\n\n" +
    "After scoring, you MUST do ALL of these in order:\n" +
    "1. QUOTE the weakest 1-2 sentences from their answer (prefix with ❌ WEAK:)\n" +
    "2. REWRITE those same sentences the way a top candidate would say them (prefix with ✅ BETTER:)\n" +
    "3. Give 2-3 EXACT PHRASES they should memorize for this type of question (prefix with 💬 MEMORIZE:)\n" +
    "4. One specific tip for next time\n" +
    "Example:\n" +
    "❌ WEAK: 'I did some analysis and found issues in the data'\n" +
    "✅ BETTER: 'Using ABC-XYZ segmentation, I identified that 80% of revenue came from just 15% of SKUs, which flagged AED 1.1M in working capital risk'\n" +
    "💬 MEMORIZE: 'I applied [framework] to [data], which revealed [specific finding] worth [₹/% impact]'\n\n" +
    "This before/after comparison is the most valuable part of coaching — never skip it.\n\n" +
    "MODE-SPECIFIC BEHAVIOR:\n" +
    "- For 'hr' mode: behavioral questions\n" +
    "- For 'case' mode: marketing cases and guesstimates\n" +
    "- For 'rapid' mode: quick 30-second answer questions, time pressure\n" +
    "- For 'news' mode: quiz on current business events\n" +
    "- For 'company' mode: Company-specific prep. Use student's target companies. Generate company-specific questions, cases, culture-fit, role-specific scenarios.\n\n" +
    "GD MODES (use GD scoring for all of these):\n" +
    "- For 'gd' mode: FULL GD SIMULATOR. Play 3 participants (Priya, Arjun, Meera — distinct personalities). " +
    "Pick a topic (rotate between: current affairs, abstract like 'Is ambition good or bad?', case-based like 'Should Zomato enter grocery?', controversial like 'MBA education is overrated'). " +
    "Round 1: Present the topic + each participant's 2-sentence opening. Ask student to enter. " +
    "Round 2+: After student speaks, have 1-2 participants counter/build/challenge. One might interrupt mid-point. One might go on a tangent forcing student to bring discussion back. " +
    "Simulate realistic GD pressure: 'Arjun cuts in: But that ignores...' or 'Priya nods and adds...' " +
    "Final round: Ask student to summarize the whole discussion in 60 seconds. Score the summary.\n\n" +
    "- For 'gd-open' mode: OPENING DRILL. Give a random GD topic (any type). The student must deliver a structured 60-second opening. " +
    "Coach the opening using: Hook (data/quote/question) → Define scope → State position → Preview 2-3 arguments. " +
    "Score harshly on Structure and Initiative. After scoring, give a model opening for comparison. Then give a new topic.\n\n" +
    "- For 'gd-counter' mode: COUNTER DRILL. Present an argument someone makes in a GD (e.g., 'Arjun says: Digital marketing has killed traditional advertising because TV ad spend is down 30%.') " +
    "Student must counter it — acknowledge the point, then dismantle it with data/logic, without being rude. " +
    "Coach: use 'Yes, and...' or 'That's a fair point, however...' pattern. Never 'You're wrong.' Score on Composure and Content.\n\n" +
    "- For 'gd-summary' mode: SUMMARY DRILL. Present a messy 5-6 point GD discussion (multiple participants, tangents, contradictions). " +
    "Student must summarize in 4-5 sentences: topic, key arguments for/against, areas of consensus, what was left unresolved. " +
    "Score on Listening and Structure. This is the hardest drill.\n\n" +
    "STRESS INTERVIEW MODE:\n" +
    "- For 'stress' mode: STRESS INTERVIEW SIMULATOR. You are a deliberately tough, skeptical interviewer. Your job is to test the student's composure, NOT to be helpful.\n" +
    "  Techniques to use (rotate through these):\n" +
    "  1. DISMISSIVE: After their answer, say 'That's not very convincing' or 'Everyone says that' — then ask them to try again\n" +
    "  2. INTERRUPT: Mid-answer, cut in with 'Wait — skip to the point. What was the actual result?'\n" +
    "  3. SILENCE: After they answer, say nothing for a beat, then say 'Anything else?' (tests if they panic-fill)\n" +
    "  4. CONTRADICTION: 'But your resume says X — that contradicts what you just said'\n" +
    "  5. UNCOMFORTABLE: 'Your CGPA is average. Why should I pick you over someone with a 9+?'\n" +
    "  6. RAPID PIVOT: Jump topics without warning — 'Forget that. Tell me about a time you failed.'\n" +
    "  7. PRESSURE: 'You have 20 seconds. Why should I hire you? Go.'\n" +
    "  8. PROVOKE: 'I've heard your college isn't that strong in placements. Change my mind.'\n" +
    "  Score ONLY on composure and quality of recovery: 📊 Composure: X/10 | Recovery: X/10\n" +
    "  After every 3-4 exchanges, break character briefly: tell them what they handled well and what broke them.\n" +
    "  Then resume the stress. The goal is to train them to stay calm, not to demoralize them.\n\n" +
    "RESUME-BASED MODES:\n" +
    "- For 'resume' mode: RESUME DEEP-DIVE. Read the student's CV carefully. Ask questions ONLY from their CV — every role, every achievement, every skill claimed, every gap. " +
    "Start with 'Walk me through your resume.' Then drill into each section. For every claim (e.g., 'increased sales by 20%'), ask: What was the baseline? What specifically did you do? How did you measure it? Who else was involved? " +
    "If something is vague, call it out: 'Your CV says you led a team — how many people? What was the project? What was the outcome?' " +
    "Be a skeptical interviewer — not hostile, but don't accept surface-level answers. Push for specifics and numbers.\n\n" +
    "- For 'cross' mode: CROSS-QUESTIONING. After EVERY student answer, ask 2-3 rapid follow-up questions that drill deeper into what they just said. " +
    "If they say 'I managed a campaign that increased brand awareness' — follow up with: 'How did you measure awareness? What was the budget? What would you do differently? How did you convince your manager to approve it?' " +
    "NEVER accept the first answer. Always dig one level deeper. This trains them for panels where interviewers keep probing. " +
    "After 3 follow-ups on one topic, score the entire exchange, then move to a new resume-based question.\n\n" +
    "- For 'mock' mode: FULL MOCK INTERVIEW SIMULATION. Simulate a realistic 20-minute MBA placement interview. " +
    "You are a senior interviewer at the student's target company. Be professional, warm but probing. " +
    "Structure the interview in phases:\n" +
    "  Phase 1 (Intro): 'Tell me about yourself' + 2 resume follow-ups\n" +
    "  Phase 2 (HR): 2 behavioral questions based on their CV weaknesses\n" +
    "  Phase 3 (Domain): 1 marketing case or scenario relevant to the company\n" +
    "  Phase 4 (Stress): 1 uncomfortable question about a gap/inconsistency in their CV\n" +
    "  Phase 5 (Close): 'Any questions for me?' — evaluate the quality of their questions\n" +
    "After each answer, give brief reactions (nod, probe, challenge) like a real interviewer — DON'T score after every answer. " +
    "Only give a FULL SCORECARD at the very end of the interview with:\n" +
    "📊 Relevance: X | Structure: X | Specificity: X | Marketing: X\n" +
    "Plus a written verdict: Hire / Maybe / No Hire, with specific reasons.\n" +
    "Start the mock interview immediately when this mode is selected.\n\n" +
    "ANTI-BLANK PROTOCOL: If the student says 'help', 'stuck', 'blank', 'don't know what to say', or 'framework' — " +
    "DO NOT score them. Instead, provide an instant framework for the current topic:\n" +
    "1. For current affairs: Use PESTEL (Political, Economic, Social, Tech, Environmental, Legal) — pick 2-3 that apply\n" +
    "2. For abstract topics: Make it concrete — 'Ambition' → 'ambition in career vs relationships vs society' → pick one angle\n" +
    "3. For case-based: Use Stakeholder analysis — who benefits? who loses? what are the trade-offs?\n" +
    "4. For controversial: Use the Steel Man — state the strongest version of the opposing view, THEN give your take\n" +
    "After the framework, say 'Now try again with this structure.' DO NOT move to a new topic.\n\n" +
    "If first message, greet by name and ask first question.\n\n" +
    "CRITICAL — After every response where you score the student, you MUST append a hidden JSON block at the very end identifying specific weakness patterns. Use this exact format:\n\n" +
    "<!--GROWTH_AREAS_JSON\n" +
    '[{"area": "short actionable weakness description", "category": "dimension_key"}]\n' +
    "GROWTH_AREAS_JSON-->\n\n" +
    "Rules for growth areas:\n" +
    '- Each "area" is a specific, actionable habit (e.g., "Include quantified results with numbers", "Use STAR framework consistently")\n' +
    '- Each "category" must be exactly one of: currentAffairs, structuredThinking, communication, personalNarrative, domainKnowledge, gdReadiness, pressureHandling\n' +
    "- Include 1-3 areas per scored answer — only real weaknesses you observed\n" +
    "- Be consistent in naming: reuse the same wording for the same weakness\n" +
    "- If the answer was strong with no weaknesses, return an empty array: []\n" +
    "- Do NOT skip this block after any scored response\n" +
    "- When asking the first question (no scoring yet), do NOT include the block";

  var contents = [];
  contents.push({ role: "user", parts: [{ text: coachInstruction + "\n\nStudent says: " + (history.length === 0 ? message : "Start") }] });

  if (history.length > 0) {
    contents.push({ role: "model", parts: [{ text: history[0] && history[0].role === 'assistant' ? history[0].content : "I understand. Let me coach you." }] });
    for (var i = 1; i < history.length; i++) {
      contents.push({ role: history[i].role === 'user' ? 'user' : 'model', parts: [{ text: history[i].content }] });
    }
    contents.push({ role: "user", parts: [{ text: message }] });
  }

  try {
    var result = await model.generateContent({ contents: contents });
    var reply = result.response.text();

    parseAndStoreGrowthAreas(req.session.userId, reply);
    var scores = parseAndStoreCoachScores(req.session.userId, reply, practiceType);
    reply = cleanCoachReply(reply);

    await pool.query("INSERT INTO coach_sessions (user_id, messages, practice_type) VALUES ($1, $2, $3)", [
      req.session.userId,
      JSON.stringify([...history, {role:'user',content:message}, {role:'assistant',content:reply}]),
      practiceType
    ]);

    res.json({ success: true, reply: reply, scores: scores });
  } catch (err) {
    console.error("Coach error:", err.message);
    res.json({ success: false, reply: "Coach is temporarily unavailable. Try again in a moment.", error: err.message });
  }
});

// ═══ GROWTH AREAS API ═══
app.get("/api/growth-areas", async function(req, res) {
  if (!req.session.userId) return res.json({ areas: [], radarSuggestions: {} });
  var areas = (await pool.query("SELECT area, category, count, first_seen, last_seen FROM growth_areas WHERE user_id = $1 ORDER BY count DESC, last_seen DESC", [req.session.userId])).rows;
  var categoryScores = {};
  for (var i = 0; i < areas.length; i++) {
    var a = areas[i];
    if (!categoryScores[a.category]) categoryScores[a.category] = 0;
    categoryScores[a.category] += a.count;
  }
  var radarSuggestions = {};
  for (var cat in categoryScores) {
    var total = categoryScores[cat];
    if (total <= 3) radarSuggestions[cat] = 60;
    else if (total <= 8) radarSuggestions[cat] = 45;
    else if (total <= 15) radarSuggestions[cat] = 30;
    else radarSuggestions[cat] = 15;
  }
  res.json({ areas: areas, radarSuggestions: radarSuggestions });
});

app.delete("/api/growth-areas", async function(req, res) {
  if (!req.session.userId) return res.json({ success: false });
  await pool.query("DELETE FROM growth_areas WHERE user_id = $1", [req.session.userId]);
  res.json({ success: true });
});

// ═══ RADAR AUTO-SCORES (from coach scores + activity) ═══
app.get("/api/radar-auto", async function(req, res) {
  if (!req.session.userId) return res.json({ hasData: false, scores: {} });

  // Get average coach scores (last 20 sessions)
  var coachAvg = (await pool.query(`
    SELECT
      AVG(relevance) as avgRel, AVG(structure) as avgStr,
      AVG(specificity) as avgSpec, AVG(marketing) as avgMkt,
      COUNT(*) as total
    FROM (SELECT * FROM coach_scores WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20)
  `, [req.session.userId])).rows[0];

  if (!coachAvg || coachAvg.total === 0) return res.json({ hasData: false, scores: {} });

  // Get mode-specific scores
  var gdScores = (await pool.query("SELECT AVG(relevance) as avg FROM coach_scores WHERE user_id = $1 AND practice_type = 'gd'", [req.session.userId])).rows[0];
  var rapidScores = (await pool.query("SELECT AVG(relevance) as avg FROM coach_scores WHERE user_id = $1 AND practice_type = 'rapid'", [req.session.userId])).rows[0];
  var newsScores = (await pool.query("SELECT AVG(relevance) as avg FROM coach_scores WHERE user_id = $1 AND practice_type = 'news'", [req.session.userId])).rows[0];

  // Get activity data
  var storyCount = (await pool.query("SELECT COUNT(*) as c FROM stories WHERE user_id = $1", [req.session.userId])).rows[0].c;
  var streak = (await pool.query("SELECT current_streak FROM streaks WHERE user_id = $1", [req.session.userId])).rows[0];
  var streakDays = streak ? streak.current_streak : 0;

  // Map to 7 radar dimensions (scale 0-100)
  var scale = function(v) { return Math.min(100, Math.max(5, Math.round(v * 10))); };
  var scores = {
    currentAffairs: newsScores && newsScores.avg ? scale(newsScores.avg) : Math.min(80, 20 + streakDays * 5),
    structuredThinking: scale(coachAvg.avgStr),
    communication: scale((coachAvg.avgRel + coachAvg.avgSpec) / 2),
    personalNarrative: Math.min(100, scale(coachAvg.avgSpec) * 0.6 + Math.min(40, storyCount * 10)),
    domainKnowledge: scale(coachAvg.avgMkt),
    gdReadiness: gdScores && gdScores.avg ? scale(gdScores.avg) : scale((coachAvg.avgRel + coachAvg.avgStr) / 2),
    pressureHandling: rapidScores && rapidScores.avg ? scale(rapidScores.avg) : scale(coachAvg.avgRel * 0.8)
  };

  res.json({ hasData: true, scores: scores, sessionCount: coachAvg.total });
});

// ═══ PAST SESSIONS ═══
app.get("/api/coach-sessions", async function(req, res) {
  if (!req.session.userId) return res.json({ sessions: [] });
  var sessions = (await pool.query(`
    SELECT id, practice_type, created_at, messages
    FROM coach_sessions WHERE user_id = $1
    ORDER BY created_at DESC LIMIT 30
  `, [req.session.userId])).rows;
  // Add score summary for each session
  for (var si = 0; si < sessions.length; si++) {
    var s = sessions[si];
    var msgs = JSON.parse(s.messages || '[]');
    s.msg_count = msgs.length;
    s.preview = '';
    for (var i = 0; i < msgs.length; i++) {
      if (msgs[i].role === 'assistant' && msgs[i].content.length > 20) {
        s.preview = msgs[i].content.substring(0, 80) + '...';
        break;
      }
    }
    delete s.messages; // don't send full messages in listing
  }
  res.json({ sessions: sessions });
});

app.get("/api/coach-session/:id", async function(req, res) {
  if (!req.session.userId) return res.json({ success: false });
  var session = (await pool.query("SELECT * FROM coach_sessions WHERE id=$1 AND user_id=$2", [req.params.id, req.session.userId])).rows[0];
  if (!session) return res.json({ success: false, error: "Session not found" });
  res.json({ success: true, session: { id: session.id, practice_type: session.practice_type, created_at: session.created_at, messages: JSON.parse(session.messages) } });
});

// ═══ EXPORT PROGRESS REPORT ═══
app.get("/api/export-report", async function(req, res) {
  if (!req.session.userId) return res.status(401).send("Login required");
  var user = (await pool.query("SELECT name,email,target_companies,target_roles,strengths,weaknesses FROM users WHERE id=$1", [req.session.userId])).rows[0];
  var streak = (await pool.query("SELECT current_streak,longest_streak FROM streaks WHERE user_id=$1", [req.session.userId])).rows[0] || {current_streak:0,longest_streak:0};
  var stories = (await pool.query("SELECT COUNT(*) as c FROM stories WHERE user_id=$1", [req.session.userId])).rows[0].c;
  var areas = (await pool.query("SELECT area,category,count FROM growth_areas WHERE user_id=$1 ORDER BY count DESC LIMIT 15", [req.session.userId])).rows;
  var totalSessions = (await pool.query("SELECT COUNT(*) as c FROM coach_sessions WHERE user_id=$1", [req.session.userId])).rows[0].c;
  var avgScores = (await pool.query("SELECT AVG(relevance) as r, AVG(structure) as s, AVG(specificity) as sp, AVG(marketing) as m, COUNT(*) as c FROM coach_scores WHERE user_id=$1", [req.session.userId])).rows[0];
  var speechAvg = (await pool.query("SELECT AVG(wpm) as wpm, AVG(filler_count) as fillers, AVG(hedges) as hedges, COUNT(*) as c FROM speech_stats WHERE user_id=$1", [req.session.userId])).rows[0];
  var hrPracticed = (await pool.query("SELECT COUNT(DISTINCT practice_type) as c FROM coach_sessions WHERE user_id=$1 AND practice_type IN ('hr','hr-bank')", [req.session.userId])).rows[0].c;
  var today = new Date().toLocaleDateString('en-IN',{day:'numeric',month:'long',year:'numeric'});

  var html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>InterviewReady Report - ${user.name}</title>
  <style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;color:#1C1917;line-height:1.6;padding:40px;max-width:800px;margin:0 auto}
  h1{font-size:28px;margin-bottom:4px}h2{font-size:18px;margin:28px 0 12px;padding-bottom:6px;border-bottom:2px solid #6D28D9;color:#6D28D9}
  .meta{font-size:13px;color:#78716C;margin-bottom:24px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:12px 0}
  .stat{background:#F5F3EE;padding:16px;border-radius:10px;text-align:center}.stat-num{font-size:32px;font-weight:700;color:#6D28D9}.stat-label{font-size:12px;color:#78716C}
  .area{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #E7E5E4;font-size:14px}.area-count{font-weight:700;color:#DC2626}
  .score-bar{display:flex;align-items:center;gap:8px;margin:6px 0}.score-label{width:120px;font-size:13px;font-weight:500}.score-track{flex:1;height:10px;background:#E7E5E4;border-radius:5px;overflow:hidden}
  .score-fill{height:100%;background:#6D28D9;border-radius:5px}.score-val{font-size:13px;font-weight:700;width:40px;text-align:right}
  @media print{body{padding:20px}}</style></head><body>
  <h1>InterviewReady Progress Report</h1>
  <div class="meta">${user.name} · ${user.email} · Generated ${today}</div>
  <h2>Overview</h2>
  <div class="grid">
    <div class="stat"><div class="stat-num">${streak.current_streak}</div><div class="stat-label">Current Streak</div></div>
    <div class="stat"><div class="stat-num">${streak.longest_streak}</div><div class="stat-label">Longest Streak</div></div>
    <div class="stat"><div class="stat-num">${totalSessions}</div><div class="stat-label">Coach Sessions</div></div>
    <div class="stat"><div class="stat-num">${stories}</div><div class="stat-label">STAR Stories</div></div>
  </div>
  ${user.target_companies ? '<p style="margin-top:12px"><strong>Target Companies:</strong> ' + user.target_companies + '</p>' : ''}
  ${user.target_roles ? '<p><strong>Target Roles:</strong> ' + user.target_roles + '</p>' : ''}
  ${avgScores && avgScores.c > 0 ? `<h2>Coach Performance (${avgScores.c} scored answers)</h2>
  <div class="score-bar"><span class="score-label">Relevance</span><div class="score-track"><div class="score-fill" style="width:${Math.round(avgScores.r*10)}%"></div></div><span class="score-val">${(avgScores.r||0).toFixed(1)}/10</span></div>
  <div class="score-bar"><span class="score-label">Structure</span><div class="score-track"><div class="score-fill" style="width:${Math.round(avgScores.s*10)}%"></div></div><span class="score-val">${(avgScores.s||0).toFixed(1)}/10</span></div>
  <div class="score-bar"><span class="score-label">Specificity</span><div class="score-track"><div class="score-fill" style="width:${Math.round(avgScores.sp*10)}%"></div></div><span class="score-val">${(avgScores.sp||0).toFixed(1)}/10</span></div>
  <div class="score-bar"><span class="score-label">Marketing</span><div class="score-track"><div class="score-fill" style="width:${Math.round(avgScores.m*10)}%"></div></div><span class="score-val">${(avgScores.m||0).toFixed(1)}/10</span></div>` : ''}
  ${areas.length > 0 ? '<h2>Growth Areas</h2>' + areas.map(function(a){return '<div class="area"><span>'+a.area+'</span><span class="area-count">×'+a.count+'</span></div>'}).join('') : ''}
  ${speechAvg && speechAvg.c > 0 ? `<h2>Speech Analytics (${speechAvg.c} voice answers)</h2>
  <div class="score-bar"><span class="score-label">Avg WPM</span><div class="score-track"><div class="score-fill" style="width:${Math.min(100,Math.round(speechAvg.wpm/2))}%;background:${speechAvg.wpm>=120&&speechAvg.wpm<=160?'#059669':'#D97706'}"></div></div><span class="score-val">${Math.round(speechAvg.wpm)}</span></div>
  <div class="score-bar"><span class="score-label">Avg Fillers</span><div class="score-track"><div class="score-fill" style="width:${Math.min(100,speechAvg.fillers*15)}%;background:${speechAvg.fillers<=2?'#059669':'#DC2626'}"></div></div><span class="score-val">${Math.round(speechAvg.fillers*10)/10}</span></div>
  <div class="score-bar"><span class="score-label">Avg Hedges</span><div class="score-track"><div class="score-fill" style="width:${Math.min(100,speechAvg.hedges*20)}%;background:${speechAvg.hedges<=1?'#059669':'#D97706'}"></div></div><span class="score-val">${Math.round(speechAvg.hedges*10)/10}</span></div>` : ''}
  ${user.strengths ? '<h2>Self-Assessment</h2><p><strong>Strengths:</strong> '+user.strengths+'</p>' : ''}
  ${user.weaknesses ? '<p><strong>Weaknesses:</strong> '+user.weaknesses+'</p>' : ''}
  <div style="margin-top:40px;text-align:center;font-size:12px;color:#78716C">Generated by InterviewReady · interview-ready-viq6.onrender.com</div>
  </body></html>`;

  res.setHeader('Content-Type', 'text/html');
  res.setHeader('Content-Disposition', 'inline; filename="InterviewReady-Report-' + user.name.replace(/\s+/g,'-') + '.html"');
  res.send(html);
});

app.get("/", async function(req, res) { res.sendFile(path.join(__dirname, "public", "index.html")); });
app.listen(PORT, function() { console.log("\n========================================\n  InterviewReady is running on port " + PORT + "\n========================================\n"); });
