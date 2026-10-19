-- Example rows so the dashboard shows a realistic working state before Upwork is connected.
-- All rows are flagged is_example = 1 and can be removed from the dashboard ("Remove examples").
INSERT OR IGNORE INTO proposals (job_id, title, url, job_type, budget, client_country, keywords, cover_letter, bid, connects, score, status, is_example, created_at)
VALUES
('ex-1', 'Klaviyo Email & SMS Flow Setup for DTC Wellness Brand (Shopify)', 'https://www.upwork.com/jobs/~022110767921732539591', 'fixed', '$400', 'United States', '["Klaviyo","email flows"]',
 'Hi,

A welcome series, abandoned cart and browse abandonment set built together is the fastest win for a wellness brand at your stage. Here is how I would set them up in Klaviyo so each flow hands off cleanly to the next.

I recorded a short video for this: https://www.loom.com/share/example', 400, 12, 91, 'pending', 1, datetime('now', '-6 minutes')),
('ex-2', 'Klaviyo Email Marketing Specialist for Multi-Store DTC E-Commerce', 'https://www.upwork.com/jobs/~022110816426152832821', 'hourly', '$20–50/hr', 'Curacao', '["Klaviyo","email marketing"]',
 'Hi,

Running three stores across NL, DE and FR means one flow library with per-store segments, not three separate setups. I would start by mapping your current flows into one shared structure.

I recorded a short video for this: https://www.loom.com/share/example', 45, 16, 84, 'pending', 1, datetime('now', '-14 minutes')),
('ex-3', 'Retention & Lifecycle Strategist for Shopify Brand (Klaviyo, Email + SMS)', 'https://www.upwork.com/jobs/~022110832642723349845', 'hourly', '$30–70/hr', 'United States', '["Klaviyo"]',
 'Hi,

Repeat purchase is usually a flow problem before it is a campaign problem. In the first week I would audit your Klaviyo setup and fix the post-purchase path.

I recorded a short video for this: https://www.loom.com/share/example', 55, 16, 76, 'pending', 1, datetime('now', '-25 minutes'));

INSERT OR IGNORE INTO proposals (job_id, title, url, job_type, budget, client_country, keywords, cover_letter, bid, connects, score, status, error, is_example, created_at, submitted_at, loom_url)
VALUES
('ex-4', 'Urgent Klaviyo Expert: Audit and Fix Flows + Branded Templates', 'https://www.upwork.com/jobs/~022110547235516591925', 'fixed', '$50', 'United States', '["Klaviyo"]', 'Example letter.', 50, 11, 88, 'submitted', NULL, 1, datetime('now', '-3 hours'), datetime('now', '-170 minutes'), 'https://www.loom.com/share/example'),
('ex-5', 'Klaviyo Technical Specialist (Email & SMS)', 'https://www.upwork.com/jobs/~022110458523424412871', 'fixed', '$200', 'United States', '["Klaviyo"]', 'Example letter.', 200, 13, 81, 'submitted', NULL, 1, datetime('now', '-2 hours'), datetime('now', '-110 minutes'), 'https://www.loom.com/share/example'),
('ex-6', 'Email Campaign Setup and Scheduling in Klaviyo', 'https://www.upwork.com/jobs/~022110427025914399145', 'fixed', '$10', 'United States', '["Klaviyo"]', 'Example letter.', 10, 9, 72, 'approved', NULL, 1, datetime('now', '-40 minutes'), NULL, NULL),
('ex-7', 'Recreate Klaviyo email flows in MailerLite', 'https://www.upwork.com/jobs/~022110363737756052757', 'fixed', '$115', 'Greece', '["Klaviyo","email flows"]', 'Example letter.', 115, 14, 79, 'failed', 'Upwork refused the proposal: you already applied to this job.', 1, datetime('now', '-5 hours'), datetime('now', '-290 minutes'), NULL),
('ex-8', 'Klaviyo Email Marketing Specialist – Base + Commission', 'https://www.upwork.com/jobs/~022110205960817813473', 'fixed', '$100', 'United States', '["Klaviyo"]', 'Example letter.', 100, 12, 71, 'skipped', NULL, 1, datetime('now', '-6 hours'), NULL, NULL);

INSERT OR IGNORE INTO jobs (id, title, status, reason, score, seen_at) VALUES
('ex-j1', 'Example job', 'proposed', 'example', 91, datetime('now', '-6 minutes')),
('ex-j2', 'Example job', 'proposed', 'example', 84, datetime('now', '-14 minutes')),
('ex-j3', 'Example job', 'proposed', 'example', 76, datetime('now', '-25 minutes')),
('ex-j4', 'Example job', 'low_score', 'example', 41, datetime('now', '-30 minutes')),
('ex-j5', 'Example job', 'filtered', 'example', NULL, datetime('now', '-45 minutes')),
('ex-j6', 'Example job', 'filtered', 'example', NULL, datetime('now', '-50 minutes')),
('ex-j7', 'Example job', 'proposed', 'example', 88, datetime('now', '-3 hours')),
('ex-j8', 'Example job', 'proposed', 'example', 81, datetime('now', '-2 hours'));
