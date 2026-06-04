const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbDir = path.join(__dirname, 'data');
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(path.join(dbDir, 'fish.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS institutions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    logo TEXT DEFAULT '',
    role TEXT DEFAULT 'institution',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS activities (
    id TEXT PRIMARY KEY,
    institution_id TEXT NOT NULL REFERENCES institutions(id),
    name TEXT NOT NULL,
    code TEXT NOT NULL UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS fish (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT '',
    child_name TEXT DEFAULT '',
    age TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    institution_id TEXT REFERENCES institutions(id),
    activity_id TEXT REFERENCES activities(id),
    image_data TEXT NOT NULL,
    color TEXT DEFAULT '#333',
    upvotes INTEGER DEFAULT 0,
    downvotes INTEGER DEFAULT 0,
    score REAL DEFAULT 0,
    is_visible INTEGER DEFAULT 1,
    device_id TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS votes (
    id TEXT PRIMARY KEY,
    fish_id TEXT NOT NULL REFERENCES fish(id),
    device_id TEXT NOT NULL,
    vote_date TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(fish_id, device_id, vote_date)
  );

  CREATE INDEX IF NOT EXISTS idx_fish_institution ON fish(institution_id);
  CREATE INDEX IF NOT EXISTS idx_fish_activity ON fish(activity_id);
  CREATE INDEX IF NOT EXISTS idx_votes_lookup ON votes(fish_id, device_id, vote_date);
`);

// Migrations
try { db.exec("ALTER TABLE institutions ADD COLUMN role TEXT DEFAULT 'institution'"); } catch (e) {}

module.exports = db;
