const express = require('express');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// DB setup
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

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '10mb' }));

// ─── Auth helpers ───

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function requireAdmin(req, res, next) {
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const data = JSON.parse(Buffer.from(token, 'base64').toString());
    const inst = db.prepare('SELECT id, name FROM institutions WHERE id = ? AND phone = ?').get(data.id, data.phone);
    if (!inst) return res.status(401).json({ error: 'Invalid token' });
    req.institution = inst;
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}

// ─── Fish endpoints ───

app.get('/api/fish', (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 50;
  const sort = req.query.sort || 'hot';
  const activity = req.query.activity || '';
  const offset = (page - 1) * limit;

  let whereClause = 'WHERE f.is_visible = 1';
  const params = [];
  if (activity) { whereClause += ' AND f.activity_id = ?'; params.push(activity); }

  let orderClause;
  switch (sort) {
    case 'top': orderClause = '(f.upvotes - f.downvotes) DESC'; break;
    case 'new': orderClause = 'f.created_at DESC'; break;
    case 'hot':
    default: orderClause = `
      (f.upvotes - f.downvotes + 1) * 1.0 / ((julianday('now') - julianday(f.created_at)) * 24 + 2) DESC
    `; break;
  }

  const fish = db.prepare(`
    SELECT f.id, f.name, f.author, f.child_name, f.institution_id, f.activity_id,
           f.color, f.upvotes, f.downvotes, f.score, f.created_at,
           (f.upvotes - f.downvotes) as net_votes,
           i.name as institution_name, a.name as activity_name
    FROM fish f
    LEFT JOIN institutions i ON f.institution_id = i.id
    LEFT JOIN activities a ON f.activity_id = a.id
    ${whereClause}
    ORDER BY ${orderClause}
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const total = db.prepare(`SELECT COUNT(*) as count FROM fish f ${whereClause}`).get(...params);

  res.json({ fish, total: total.count, page, limit });
});

app.get('/api/fish/:id', (req, res) => {
  const fish = db.prepare(`
    SELECT f.*, i.name as institution_name, a.name as activity_name
    FROM fish f
    LEFT JOIN institutions i ON f.institution_id = i.id
    LEFT JOIN activities a ON f.activity_id = a.id
    WHERE f.id = ?
  `).get(req.params.id);
  if (!fish) return res.status(404).json({ error: 'Fish not found' });
  res.json(fish);
});

app.get('/api/fish/:id/thumb', (req, res) => {
  const fish = db.prepare('SELECT image_data FROM fish WHERE id = ?').get(req.params.id);
  if (!fish) return res.status(404).send('Not found');

  const matches = fish.image_data.match(/^data:([a-zA-Z0-9\/+-]+);base64,(.+)$/);
  if (!matches) return res.redirect('/');

  const img = Buffer.from(matches[2], 'base64');
  res.writeHead(200, {
    'Content-Type': matches[1],
    'Content-Length': img.length,
    'Cache-Control': 'public, max-age=86400'
  });
  res.end(img);
});

app.post('/api/fish', (req, res) => {
  const { name, author, child_name, age, phone, image_data, color,
          institution_id, activity_id, device_id } = req.body;
  if (!image_data) return res.status(400).json({ error: 'No image data' });
  if (!name || !name.trim()) return res.status(400).json({ error: 'Fish name is required' });

  const id = uuidv4();
  db.prepare(`
    INSERT INTO fish (id, name, author, child_name, age, phone, image_data, color,
                      institution_id, activity_id, device_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name.trim(), author || '', child_name || '', age || '', phone || '',
         image_data, color || '#333', institution_id || null, activity_id || null, device_id || '');

  res.json({ id, success: true });
});

// Update phone number on a fish
app.put('/api/fish/:id/phone', (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone required' });
  db.prepare('UPDATE fish SET phone = ? WHERE id = ?').run(phone, req.params.id);
  res.json({ success: true });
});

// ─── Vote with anti-spam ───

app.post('/api/fish/:id/vote', (req, res) => {
  const { device_id } = req.body;
  if (!device_id) return res.status(400).json({ error: 'Device ID required' });

  const fishId = req.params.id;
  const today = new Date().toISOString().slice(0, 10);

  // Check existing vote today from this device on this fish
  const existing = db.prepare(
    'SELECT id FROM votes WHERE fish_id = ? AND device_id = ? AND vote_date = ?'
  ).get(fishId, device_id, today);

  if (existing) return res.status(429).json({ error: 'Already voted today', alreadyVoted: true });

  // Record vote
  db.prepare('INSERT INTO votes (id, fish_id, device_id, vote_date) VALUES (?, ?, ?, ?)')
    .run(uuidv4(), fishId, device_id, today);
  db.prepare('UPDATE fish SET upvotes = upvotes + 1, score = (upvotes - downvotes) WHERE id = ?')
    .run(fishId);

  const fish = db.prepare('SELECT upvotes, downvotes, (upvotes - downvotes) as net_votes FROM fish WHERE id = ?')
    .get(fishId);

  res.json({ success: true, votes: fish.net_votes, upvotes: fish.upvotes });
});

// ─── Rankings ───

app.get('/api/rank/individual', (req, res) => {
  const activity = req.query.activity || '';
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 50;
  const offset = (page - 1) * limit;

  let whereClause = 'WHERE f.is_visible = 1';
  const params = [];
  if (activity) { whereClause += ' AND f.activity_id = ?'; params.push(activity); }

  const list = db.prepare(`
    SELECT f.id, f.name, f.child_name, f.author,
           (f.upvotes - f.downvotes) as votes, f.created_at,
           i.name as institution_name, a.name as activity_name
    FROM fish f
    LEFT JOIN institutions i ON f.institution_id = i.id
    LEFT JOIN activities a ON f.activity_id = a.id
    ${whereClause}
    ORDER BY votes DESC, f.created_at ASC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const total = db.prepare(`
    SELECT COUNT(*) as count FROM fish f ${whereClause}
  `).get(...params);

  // Add rank numbers
  list.forEach((item, idx) => item.rank = offset + idx + 1);

  res.json({ list, total: total.count, page, limit });
});

app.get('/api/rank/institution', (req, res) => {
  const list = db.prepare(`
    SELECT i.id, i.name,
           COALESCE(SUM(f.upvotes - f.downvotes), 0) as total_votes,
           COUNT(DISTINCT f.id) as fish_count,
           COUNT(DISTINCT f.child_name || f.device_id) as participant_count
    FROM institutions i
    LEFT JOIN fish f ON f.institution_id = i.id AND f.is_visible = 1
    GROUP BY i.id
    ORDER BY total_votes DESC
  `).all();

  list.forEach((item, idx) => item.rank = idx + 1);
  res.json({ list });
});

app.get('/api/rank/activity', (req, res) => {
  const institutionId = req.query.institution || '';
  let whereClause = '';
  const params = [];
  if (institutionId) { whereClause = 'WHERE a.institution_id = ?'; params.push(institutionId); }

  const list = db.prepare(`
    SELECT a.id, a.name, a.institution_id, i.name as institution_name,
           COALESCE(SUM(f.upvotes - f.downvotes), 0) as total_votes,
           COUNT(DISTINCT f.id) as fish_count,
           COUNT(DISTINCT f.child_name || f.device_id) as participant_count
    FROM activities a
    JOIN institutions i ON a.institution_id = i.id
    LEFT JOIN fish f ON f.activity_id = a.id AND f.is_visible = 1
    ${whereClause}
    GROUP BY a.id
    ORDER BY total_votes DESC
  `).all(...params);

  list.forEach((item, idx) => item.rank = idx + 1);
  res.json({ list });
});

// ─── Activity endpoints ───

app.get('/api/activity/:code', (req, res) => {
  const act = db.prepare(`
    SELECT a.*, i.name as institution_name, i.logo
    FROM activities a
    JOIN institutions i ON a.institution_id = i.id
    WHERE a.code = ?
  `).get(req.params.code);
  if (!act) return res.status(404).json({ error: 'Activity not found' });
  res.json(act);
});

// ─── Stats ───

app.get('/api/stats', (req, res) => {
  const activity = req.query.activity || '';
  let fishWhere = '1=1';
  const params = [];
  if (activity) { fishWhere = 'f.activity_id = ?'; params.push(activity); }

  const totalFish = db.prepare(`SELECT COUNT(*) as count FROM fish f WHERE ${fishWhere}`).get(...params);
  const totalVotes = db.prepare(
    `SELECT COALESCE(SUM(f.upvotes + f.downvotes), 0) as total FROM fish f WHERE ${fishWhere}`
  ).get(...params);
  const votes = db.prepare(
    `SELECT COALESCE(SUM(f.upvotes), 0) as good FROM fish f WHERE ${fishWhere}`
  ).get(...params);

  res.json({
    totalFish: totalFish.count,
    totalVotes: totalVotes.total,
    totalUpvotes: votes.good
  });
});

// ─── Admin endpoints ───

app.post('/api/admin/register', (req, res) => {
  const { name, phone, password } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: '机构名称不能为空' });
  if (!phone || !phone.trim()) return res.status(400).json({ error: '手机号不能为空' });
  if (!password || password.length < 6) return res.status(400).json({ error: '密码至少6位' });

  const existing = db.prepare('SELECT id FROM institutions WHERE phone = ?').get(phone);
  if (existing) return res.status(409).json({ error: '该手机号已注册' });

  const id = uuidv4();
  db.prepare('INSERT INTO institutions (id, name, phone, password_hash) VALUES (?, ?, ?, ?)')
    .run(id, name.trim(), phone.trim(), hashPassword(password));

  const token = Buffer.from(JSON.stringify({ id, phone })).toString('base64');
  res.json({ token, institution: { id, name: name.trim(), phone: phone.trim() } });
});

app.post('/api/admin/login', (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password) return res.status(400).json({ error: 'Phone and password required' });

  const inst = db.prepare('SELECT * FROM institutions WHERE phone = ?').get(phone);
  if (!inst) return res.status(401).json({ error: 'Account not found' });

  if (inst.password_hash !== hashPassword(password)) {
    return res.status(401).json({ error: 'Wrong password' });
  }

  const token = Buffer.from(JSON.stringify({ id: inst.id, phone: inst.phone })).toString('base64');
  res.json({ token, institution: { id: inst.id, name: inst.name, phone: inst.phone } });
});

app.get('/api/admin/dashboard', requireAdmin, (req, res) => {
  const instId = req.institution.id;

  const stats = db.prepare(`
    SELECT
      COUNT(DISTINCT f.id) as total_fish,
      COALESCE(SUM(f.upvotes + f.downvotes), 0) as total_votes,
      COUNT(DISTINCT f.child_name || f.device_id) as participants,
      COUNT(DISTINCT CASE WHEN f.phone != '' THEN f.id END) as leads
    FROM fish f
    WHERE f.institution_id = ? AND f.is_visible = 1
  `).get(instId);

  const fishList = db.prepare(`
    SELECT f.id, f.name, f.child_name, f.age, f.phone,
           (f.upvotes - f.downvotes) as votes, f.created_at,
           CASE WHEN f.phone != '' THEN 1 ELSE 0 END as has_phone
    FROM fish f
    WHERE f.institution_id = ? AND f.is_visible = 1
    ORDER BY votes DESC
  `).all(instId);

  const leads = db.prepare(`
    SELECT f.child_name, f.age, f.phone, f.created_at, f.name as fish_name
    FROM fish f
    WHERE f.institution_id = ? AND f.phone != '' AND f.is_visible = 1
    ORDER BY f.created_at DESC
  `).all(instId);

  const activities = db.prepare(`
    SELECT a.id, a.name, a.code, a.created_at,
           COUNT(DISTINCT f.id) as fish_count,
           COALESCE(SUM(f.upvotes - f.downvotes), 0) as total_votes
    FROM activities a
    LEFT JOIN fish f ON f.activity_id = a.id AND f.is_visible = 1
    WHERE a.institution_id = ?
    GROUP BY a.id
    ORDER BY a.created_at DESC
  `).all(instId);

  res.json({ stats, fishList, leads, activities });
});

app.post('/api/admin/activity', requireAdmin, (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Activity name required' });

  const id = uuidv4();
  const code = req.institution.name.slice(0, 4) + '_' + Date.now().toString(36);
  db.prepare('INSERT INTO activities (id, institution_id, name, code) VALUES (?, ?, ?, ?)')
    .run(id, req.institution.id, name.trim(), code);

  res.json({ id, code, success: true });
});

// ─── Init default institution & activity for testing ───

const existingInst = db.prepare('SELECT id FROM institutions LIMIT 1').get();
if (!existingInst) {
  const instId = uuidv4();
  db.prepare('INSERT INTO institutions (id, name, phone, password_hash) VALUES (?, ?, ?, ?)')
    .run(instId, '番茄田美术', '13800138000', hashPassword('admin123'));
  const actId = uuidv4();
  db.prepare('INSERT INTO activities (id, institution_id, name, code) VALUES (?, ?, ?, ?)')
    .run(actId, instId, '万达广场站', '番茄田_1');
  console.log('  🏫 Created test institution: 番茄田美术 / 13800138000 / admin123');
  console.log(`  🔗 Activity code: 番茄田_1`);
}

app.listen(PORT, () => {
  console.log(`🐟 Fish World running at http://localhost:${PORT}`);
});
