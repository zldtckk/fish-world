const express = require('express');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '10mb' }));

// ─── Auth helpers ───

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function decodeToken(token) {
  try {
    return JSON.parse(Buffer.from(token, 'base64').toString());
  } catch { return null; }
}

function requireAdmin(req, res, next) {
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ error: 'No token' });
  const data = decodeToken(token);
  if (!data) return res.status(401).json({ error: 'Invalid token' });
  const inst = db.prepare('SELECT id, name, role FROM institutions WHERE id = ? AND phone = ?').get(data.id, data.phone);
  if (!inst) return res.status(401).json({ error: 'Invalid token' });
  req.institution = inst;
  next();
}

function requireSuperAdmin(req, res, next) {
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ error: 'No token' });
  const data = decodeToken(token);
  if (!data) return res.status(401).json({ error: 'Invalid token' });
  const admin = db.prepare('SELECT id, name FROM institutions WHERE id = ? AND phone = ? AND role = ?').get(data.id, data.phone, 'super_admin');
  if (!admin) return res.status(401).json({ error: 'Not super admin' });
  req.admin = admin;
  next();
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

  const orderMap = {
    top: '(f.upvotes - f.downvotes) DESC',
    new: 'f.created_at DESC',
    hot: '(f.upvotes - f.downvotes + 1) * 1.0 / ((julianday(\'now\') - julianday(f.created_at)) * 24 + 2) DESC',
    random: 'RANDOM()'
  };
  const orderClause = orderMap[sort] || orderMap.hot;

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

app.put('/api/fish/:id/phone', (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone required' });
  db.prepare('UPDATE fish SET phone = ? WHERE id = ?').run(phone, req.params.id);
  res.json({ success: true });
});

// ─── Vote ───

app.post('/api/fish/:id/vote', (req, res) => {
  const { device_id } = req.body;
  if (!device_id) return res.status(400).json({ error: 'Device ID required' });

  const fishId = req.params.id;
  const today = new Date().toISOString().slice(0, 10);

  const existing = db.prepare(
    'SELECT id FROM votes WHERE fish_id = ? AND device_id = ? AND vote_date = ?'
  ).get(fishId, device_id, today);

  if (existing) return res.status(429).json({ error: 'Already voted today', alreadyVoted: true });

  db.prepare('INSERT INTO votes (id, fish_id, device_id, vote_date) VALUES (?, ?, ?, ?)')
    .run(uuidv4(), fishId, device_id, today);
  db.prepare('UPDATE fish SET upvotes = upvotes + 1, score = (upvotes - downvotes) WHERE id = ?').run(fishId);

  const fish = db.prepare('SELECT upvotes, downvotes, (upvotes - downvotes) as net_votes FROM fish WHERE id = ?').get(fishId);
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

  const total = db.prepare(`SELECT COUNT(*) as count FROM fish f ${whereClause}`).get(...params);
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
    WHERE i.role = 'institution'
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
  `).all(params);
  list.forEach((item, idx) => item.rank = idx + 1);
  res.json({ list });
});

// ─── Activities ───

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

// ─── Institutions ───

app.get('/api/institutions', (req, res) => {
  const list = db.prepare(`
    SELECT id, name, logo FROM institutions
    WHERE role = 'institution'
    ORDER BY name ASC
  `).all();
  res.json(list);
});

// ─── Admin auth ───

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
  if (inst.password_hash !== hashPassword(password)) return res.status(401).json({ error: 'Wrong password' });

  const token = Buffer.from(JSON.stringify({ id: inst.id, phone: inst.phone })).toString('base64');
  res.json({ token, institution: { id: inst.id, name: inst.name, phone: inst.phone } });
});

// ─── Admin dashboard ───

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

// ─── Super admin ───

app.get('/api/admin/super/dashboard', requireSuperAdmin, (req, res) => {
  const stats = db.prepare(`
    SELECT
      COUNT(DISTINCT f.id) as total_fish,
      COALESCE(SUM(f.upvotes + f.downvotes), 0) as total_votes,
      COUNT(DISTINCT i.id) as total_institutions,
      COUNT(DISTINCT CASE WHEN f.phone != '' THEN f.id END) as total_leads
    FROM fish f
    LEFT JOIN institutions i ON f.institution_id = i.id
    WHERE f.is_visible = 1
  `).get();

  const leads = db.prepare(`
    SELECT f.child_name, f.age, f.phone, f.created_at, f.name as fish_name,
           i.name as institution_name
    FROM fish f
    LEFT JOIN institutions i ON f.institution_id = i.id
    WHERE f.phone != '' AND f.is_visible = 1
    ORDER BY f.created_at DESC
    LIMIT 500
  `).all();

  const institutions = db.prepare(`
    SELECT i.id, i.name, i.phone, i.created_at,
           COUNT(DISTINCT f.id) as fish_count,
           COUNT(DISTINCT CASE WHEN f.phone != '' THEN f.id END) as lead_count,
           COALESCE(SUM(f.upvotes - f.downvotes), 0) as total_votes
    FROM institutions i
    LEFT JOIN fish f ON f.institution_id = i.id AND f.is_visible = 1
    WHERE i.role = 'institution'
    GROUP BY i.id
    ORDER BY lead_count DESC
  `).all();

  res.json({ stats, leads, institutions });
});

app.get('/api/admin/super/fish', requireSuperAdmin, (req, res) => {
  const fish = db.prepare(`
    SELECT f.id, f.name, f.child_name, f.age, f.phone,
           (f.upvotes - f.downvotes) as votes, f.is_visible, f.created_at,
           i.name as institution_name, f.image_data
    FROM fish f
    LEFT JOIN institutions i ON f.institution_id = i.id
    ORDER BY f.created_at DESC
  `).all();
  res.json({ fish });
});

app.post('/api/admin/super/fish/delete', requireSuperAdmin, (req, res) => {
  const { ids } = req.body;
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids array required' });
  }
  const del = db.prepare('DELETE FROM fish WHERE id = ?');
  const txn = db.transaction((list) => { for (const id of list) del.run(id); });
  txn(ids);
  res.json({ success: true, deleted: ids.length });
});

app.put('/api/admin/super/fish/:id', requireSuperAdmin, (req, res) => {
  const { name, child_name, age, is_visible } = req.body;
  const updates = [];
  const params = [];
  if (name !== undefined) { updates.push('name = ?'); params.push(name); }
  if (child_name !== undefined) { updates.push('child_name = ?'); params.push(child_name); }
  if (age !== undefined) { updates.push('age = ?'); params.push(age); }
  if (is_visible !== undefined) { updates.push('is_visible = ?'); params.push(is_visible ? 1 : 0); }
  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
  params.push(req.params.id);
  db.prepare(`UPDATE fish SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json({ success: true });
});

// ─── Seed data on first run ───

const existingInst = db.prepare('SELECT id FROM institutions LIMIT 1').get();
if (!existingInst) {
  const instId = uuidv4();
  db.prepare('INSERT INTO institutions (id, name, phone, password_hash, role) VALUES (?, ?, ?, ?, ?)')
    .run(instId, '番茄田美术', '13800138000', hashPassword('admin123'), 'institution');
  db.prepare('INSERT INTO activities (id, institution_id, name, code) VALUES (?, ?, ?, ?)')
    .run(uuidv4(), instId, '万达广场站', '番茄田_1');
  console.log('  🏫 Created: 番茄田美术 / 13800138000 / admin123');
  console.log('  🔗 Activity: 番茄田_1');
}

const existingSuper = db.prepare("SELECT id FROM institutions WHERE role = 'super_admin' LIMIT 1").get();
if (!existingSuper) {
  db.prepare('INSERT INTO institutions (id, name, phone, password_hash, role) VALUES (?, ?, ?, ?, ?)')
    .run(uuidv4(), '超级管理员', 'admin', hashPassword('admin888'), 'super_admin');
  console.log('  👑 Super admin: admin / admin888');
}

app.listen(PORT, () => {
  console.log(`🐟 Fish World v2 running at http://localhost:${PORT}`);
});
