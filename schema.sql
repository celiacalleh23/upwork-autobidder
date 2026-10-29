-- Settings and runtime state (JSON values): settings, state, oauth tokens
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Every job the scanner has looked at, so it never processes one twice
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,               -- Upwork numeric job id
  title TEXT NOT NULL,
  url TEXT,
  job_type TEXT,                     -- hourly | fixed
  budget TEXT,
  client_country TEXT,
  posted_at TEXT,
  seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL,              -- filtered | matched (passed filters, waiting for scoring) | low_score | proposed | error
  reason TEXT,
  score INTEGER,
  win_score INTEGER,                 -- sub-score: similarity to jobs Rafa won (0-100, null = no past wins)
  profile_score INTEGER,             -- sub-score: fit with Rafa's profile (0-100)
  proposals_tier TEXT,               -- e.g. "5 to 10", from the search result
  analysis TEXT,                     -- JSON {pros, cons}: why this job is good or bad (dashboard)
  skills TEXT                        -- JSON array of the Upwork skills on the post (keyword trends)
);
CREATE INDEX IF NOT EXISTS jobs_seen ON jobs(seen_at);

-- Proposals the pipeline prepared (the review queue and the activity log)
CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT,
  job_type TEXT,
  budget TEXT,
  client_country TEXT,
  keywords TEXT,                     -- JSON array of matched keywords
  cover_letter TEXT NOT NULL,
  bid REAL,
  create_params TEXT NOT NULL DEFAULT '{}',
  loom_url TEXT,
  loom_video_id TEXT,                -- the job's own Loom copy (M5), deleted after settings.loom.deleteAfterDays
  loom_deleted_at TEXT,
  approved_at TEXT,                  -- when it was approved, and how: 'dashboard' (Approve button) or 'auto-submit'
  approved_via TEXT,
  connects INTEGER,
  boost_connects INTEGER,            -- Connects bid to boost it (charged only if it lands in a paid slot)
  score INTEGER,
  win_score INTEGER,                 -- sub-scores behind score, kept for the M7 results report
  profile_score INTEGER,
  preview_id TEXT,
  preview_expires TEXT,
  status TEXT NOT NULL,              -- pending | submitting | submitted | failed | skipped | unknown
  upwork_proposal_id TEXT,
  error TEXT,
  is_example INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  submitted_at TEXT
);
CREATE INDEX IF NOT EXISTS proposals_status ON proposals(status);
CREATE INDEX IF NOT EXISTS proposals_created ON proposals(created_at);
CREATE UNIQUE INDEX IF NOT EXISTS proposals_job ON proposals(job_id);

-- Keyword trends: one row per keyword looked up from the dashboard (data = the KeywordInsight JSON)
CREATE TABLE IF NOT EXISTS keyword_lookups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword TEXT NOT NULL,             -- lower case
  mode TEXT NOT NULL,                -- title | anywhere
  at TEXT NOT NULL,                  -- ISO time
  per_day REAL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS keyword_lookups_kw ON keyword_lookups(keyword, mode, at);

-- One row per cron pass
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  scanned INTEGER DEFAULT 0,
  new_jobs INTEGER DEFAULT 0,
  matched INTEGER DEFAULT 0,
  submitted INTEGER DEFAULT 0,
  queued INTEGER DEFAULT 0,
  errors INTEGER DEFAULT 0,
  note TEXT
);
