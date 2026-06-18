const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'data.json');

function loadDB() {
  try { if (fs.existsSync(DB_PATH)) return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); } catch (e) { console.error('读取出错', e.message); }
  return getDefaultDB();
}
function saveDB() { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8'); }
function getDefaultDB() {
  return {
    users: [{ id: 'admin-1', username: 'admin', password: bcrypt.hashSync('admin123', 10), display_name: '管理员', role: 'admin', created_at: beijingNow() }],
    products: [], stock_log: [], sales: [],
    settings: { low_threshold: 10, critical_threshold: 3, shop_name: '我的便利店', categories: ['饮料','零食','方便食品','日用品','烟酒','冷藏食品','调味品'] }
  };
}
let db = loadDB();

function beijingNow() { const d = new Date(); return new Date(d.getTime() + 8*60*60*1000).toISOString().replace('T',' ').slice(0,19); }
function beijingDate() { return beijingNow().slice(0,10); }
function parseDateRange(s, e) { return { start: s?s+' 00:00:00':'2000-01-01 00:00:00', end: e?e+' 23:59:59':'2099-12-31 23:59:59' }; }

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'cvs-secret';
app.use(cors()); app.use(express.json()); app.use(express.static(path.join(__dirname, 'public')));

function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: '未登录' });
  try { req.user = jwt.verify(h.slice(7), JWT_SECRET); next(); }
  catch (e) { return res.status(401).json({ error: '已过期' }); }
}
function adminOnly(req, res, next) { if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员' }); next(); }
function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2,6); }

// 定期清理3个月前的日志
setInterval(() => {
  const cutoff = new Date(Date.now() - 90*24*60*60*1000 + 8*60*60*1000).toISOString().replace('T',' ').slice(0,19);
  const b = db.stock_log.length;
  db.stock_log = db.stock_log.filter(l => l.time >= cutoff);
  if (db.stock_log.length !== b) saveDB();
}, 86400000);

// ---- 登录 ----
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '请输入账号和密码' });
  const user = db.users.find(u => u.username === username);
  if (!user || !bcrypt.compareSync(password, user.password)) return res.status(401).json({ error: '账号或密码错误' });
  const token = jwt.sign({ id: user.id, username: user.username, display_name: user.display_name, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role } });
});
app.get('/api/me', auth, (req, res) => res.json({ user: req.user }));

// ---- 用户管理 ----
app.get('/api/users', auth, adminOnly, (req, res) => res.json(db.users.map(u => ({ id: u.id, username: u.username, display_name: u.display_name, role: u.role, created_at: u.created_at }))));
app.post('/api/users', auth, adminOnly, (req, res) => {
  const { username, password, display_name, role } = req.body;
  if (!username || !password || !display_name) return res.status(400).json({ error: '请填写完整' });
  if (db.users.find(u => u.username === username)) return res.status(400).json({ error: '已存在' });
  db.users.push({ id: genId(), username, password: bcrypt.hashSync(password, 10), display_name, role: role || 'cashier', created_at: beijingNow() });
  saveDB(); res.json({ success: true });
});
app.put('/api/users/:id', auth, adminOnly, (req, res) => {
  const u = db.users.find(x => x.id === req.params.id); if (!u) return res.status(404).json({ error: '不存在' });
  if (req.body.display_name) u.display_name = req.body.display_name;
  if (req.body.role) u.role = req.body.role;
  if (req.body.password) u.password = bcrypt.hashSync(req.body.password, 10);
  saveDB(); res.json({ success: true });
});
app.delete('/api/users/:id', auth, adminOnly, (req, res) => {
  const idx = db.users.findIndex(x => x.id === req.params.id); if (idx === -1) return res.status(404).json({ error: '不存在' });
  if (db.users[idx].role === 'admin') return res.status(400).json({ error: '不能删除管理员' });
  db.users.splice(idx, 1); saveDB(); res.json({ success: true });
});

// ---- 商品 ----
app.get('/api/products', auth, (req, res) => {
  let list = [...db.products];
  const { search, category, stock_status } = req.query;
  const { low_threshold: low, critical_threshold: critical } = db.settings;
  if (search) { const s = search.toLowerCase(); list = list.filter(p => p.name.toLowerCase().includes(s) || (p.barcode && p.barcode.includes(s)) || (p.supplier && p.supplier.toLowerCase().includes(s))); }
  if (category) list = list.filter(p => p.category === category);
  if (stock_status === 'normal') list = list.filter(p => p.qty > low);
  else if (stock_status === 'low') list = list.filter(p => p.qty <= low && p.qty > critical);
  else if (stock_status === 'critical') list = list.filter(p => p.qty <= critical);
  res.json(list);
});
app.post('/api/products', auth, adminOnly, (req, res) => {
  const { name, barcode, category, supplier, qty, min_stock, cost, price, shelf } = req.body;
  if (!name || !category) return res.status(400).json({ error: '请填写名称和分类' });
  const id = genId();
  db.products.push({ id, name, barcode: barcode||'', category, supplier: supplier||'', qty: qty||0, min_stock: min_stock||5, cost: cost||0, price: price||0, shelf: shelf||'', created_at: beijingNow(), updated_at: beijingNow() });
  saveDB(); res.json({ success: true, id });
});
app.put('/api/products/:id', auth, adminOnly, (req, res) => {
  const p = db.products.find(x => x.id === req.params.id); if (!p) return res.status(404).json({ error: '不存在' });
  Object.assign(p, req.body); p.updated_at = beijingNow(); saveDB(); res.json({ success: true });
});
app.delete('/api/products/:id', auth, adminOnly, (req, res) => {
  db.products = db.products.filter(x => x.id !== req.params.id); saveDB(); res.json({ success: true });
});

// ---- 日志工具 ----
function addLog(pid, pname, type, qty, note, op) {
  const cutoff = new Date(Date.now() - 90*24*60*60*1000 + 8*60*60*1000).toISOString().replace('T',' ').slice(0,19);
  db.stock_log = db.stock_log.filter(l => l.time >= cutoff);
  db.stock_log.push({ time: beijingNow(), product_id: pid, product_name: pname, type, qty, note: note||'', operator: op||'' });
}

// ---- 入库 ----
app.post('/api/stock/in', auth, (req, res) => {
  const { product_id, qty, cost, note, manual_product } = req.body;
  if (!qty || qty < 1) return res.status(400).json({ error: '数量无效' });
  let p;
  if (manual_product) {
    if (!manual_product.name || !manual_product.category) return res.status(400).json({ error: '请填写名称和分类' });
    const id = genId();
    p = { id, name: manual_product.name, barcode: manual_product.barcode||'', category: manual_product.category, supplier: manual_product.supplier||'', qty: 0, min_stock: manual_product.min_stock||5, cost: 0, price: manual_product.price||0, shelf: manual_product.shelf||'', created_at: beijingNow(), updated_at: beijingNow() };
    db.products.push(p);
  } else {
    if (!product_id) return res.status(400).json({ error: '请选择商品' });
    p = db.products.find(x => x.id === product_id); if (!p) return res.status(404).json({ error: '不存在' });
  }
  p.qty += qty; if (cost !== undefined && cost > 0) p.cost = cost; p.updated_at = beijingNow();
  addLog(p.id, p.name, 'in', qty, note||'入库', req.user.display_name);
  saveDB(); res.json({ success: true, product: p });
});

// ---- 出库 ----
app.post('/api/stock/out', auth, (req, res) => {
  const { product_id, qty, price, note } = req.body;
  if (!qty || qty < 1) return res.status(400).json({ error: '数量无效' });
  if (!product_id) return res.status(400).json({ error: '请选择商品' });
  const p = db.products.find(x => x.id === product_id); if (!p) return res.status(404).json({ error: '不存在' });
  if (qty > p.qty) return res.status(400).json({ error: '库存不足！当前: '+p.qty });
  p.qty -= qty; if (price !== undefined && price > 0) p.price = price; p.updated_at = beijingNow();
  addLog(p.id, p.name, 'out', qty, note||'出库', req.user.display_name);
  saveDB(); res.json({ success: true, product: p });
});

// ---- 售出 ----
app.post('/api/sell', auth, (req, res) => {
  const { items } = req.body;
  if (!items || !Array.isArray(items) || !items.length) return res.status(400).json({ error: '请添加商品' });
  const saleItems = [];
  for (const item of items) {
    const p = db.products.find(x => x.id === item.product_id);
    if (!p) return res.status(404).json({ error: '商品不存在' });
    if (item.qty > p.qty) return res.status(400).json({ error: '「'+p.name+'」库存不足' });
    saleItems.push({ product_id: p.id, product_name: p.name, qty: item.qty, price: item.price||p.price, subtotal: (item.price||p.price)*item.qty });
  }
  const total = saleItems.reduce((s,i) => s+i.subtotal, 0);
  const saleId = genId();
  for (const si of saleItems) { const p = db.products.find(x => x.id === si.product_id); p.qty -= si.qty; addLog(p.id, p.name, 'sell', si.qty, '销售', req.user.display_name); }
  db.sales.push({ id: saleId, total, items: JSON.stringify(saleItems), operator: req.user.display_name, status: 'completed', created_at: beijingNow() });
  saveDB(); res.json({ success: true, sale_id: saleId, total, items: saleItems });
});

// ---- 操作日志 ----
app.get('/api/logs', auth, (req, res) => {
  const { type, start_date, end_date, page=1, page_size=50 } = req.query;
  let logs = db.stock_log.map((l,i) => ({ ...l, _idx: i }));
  if (type) logs = logs.filter(l => l.type === type);
  const { start, end } = parseDateRange(start_date, end_date);
  logs = logs.filter(l => l.time >= start && l.time <= end).sort((a,b) => b.time.localeCompare(a.time));
  const total = logs.length, ps = parseInt(page_size), p = parseInt(page);
  res.json({ logs: logs.slice((p-1)*ps, p*ps), total, page: p, page_size: ps, total_pages: Math.ceil(total/ps) });
});

// ---- 删除日志（撤回操作） ----
app.delete('/api/logs/:idx', auth, adminOnly, (req, res) => {
  const idx = parseInt(req.params.idx);
  if (isNaN(idx) || idx < 0 || idx >= db.stock_log.length) return res.status(404).json({ error: '日志不存在' });
  const log = db.stock_log[idx];
  if (log.type === 'in') { const p = db.products.find(x => x.id === log.product_id); if (p) { p.qty -= log.qty; if (p.qty < 0) p.qty = 0; p.updated_at = beijingNow(); } }
  else if (log.type === 'out' || log.type === 'sell') { const p = db.products.find(x => x.id === log.product_id); if (p) { p.qty += log.qty; p.updated_at = beijingNow(); } }
  db.stock_log.splice(idx, 1); saveDB(); res.json({ success: true, message: '已撤回，库存已恢复' });
});

// ---- Dashboard ----
app.get('/api/dashboard', auth, (req, res) => {
  const { low_threshold: low, critical_threshold: critical } = db.settings;
  const todayStart = beijingDate()+' 00:00:00', todayEnd = beijingDate()+' 23:59:59';
  const todaySales = db.sales.filter(s => s.created_at >= todayStart && s.created_at <= todayEnd);
  const todaySellLogs = db.stock_log.filter(l => l.time >= todayStart && l.time <= todayEnd && l.type === 'sell');
  const todayInLogs = db.stock_log.filter(l => l.time >= todayStart && l.time <= todayEnd && l.type === 'in');
  res.json({
    totalProducts: db.products.length,
    totalValue: db.products.reduce((s,p) => s+(p.qty||0)*(p.cost||0), 0),
    lowStock: db.products.filter(p => p.qty <= low && p.qty > critical).length,
    criticalStock: db.products.filter(p => p.qty <= critical).length,
    lowItems: db.products.filter(p => p.qty <= low).sort((a,b) => a.qty-b.qty),
    todaySales: { count: todaySales.length, total: todaySales.reduce((s,x) => s+x.total, 0), sellQty: todaySellLogs.reduce((s,l) => s+l.qty, 0), inQty: todayInLogs.reduce((s,l) => s+l.qty, 0) },
    recentLogs: db.stock_log.slice(-10).reverse()
  });
});

// ---- 报表 ----
app.get('/api/reports', auth, (req, res) => {
  const { start_date, end_date } = req.query;
  const { start, end } = parseDateRange(start_date, end_date);
  const logs = db.stock_log.filter(l => l.time >= start && l.time <= end);
  const salesList = db.sales.filter(s => s.created_at >= start && s.created_at <= end);
  const catMap = {};
  db.products.forEach(p => { const c = p.category||'未分类'; if (!catMap[c]) catMap[c] = { count:0, qty:0, value:0 }; catMap[c].count++; catMap[c].qty += p.qty||0; catMap[c].value += (p.qty||0)*(p.cost||0); });
  const sellLogs = logs.filter(l => l.type === 'sell');
  const inLogs = logs.filter(l => l.type === 'in');
  const outLogs = logs.filter(l => l.type === 'out');
  const sellMap = {};
  sellLogs.forEach(l => { if (!sellMap[l.product_name]) sellMap[l.product_name] = { name: l.product_name, qty:0, count:0 }; sellMap[l.product_name].qty += l.qty; sellMap[l.product_name].count++; });
  res.json({
    summary: { totalSales: salesList.reduce((s,x) => s+x.total, 0), totalSellQty: sellLogs.reduce((s,l) => s+l.qty, 0), totalSellItems: sellLogs.length, totalInQty: inLogs.reduce((s,l) => s+l.qty, 0), totalInCount: inLogs.length, totalOutQty: outLogs.reduce((s,l) => s+l.qty, 0) },
    categoryReport: catMap, topSell: Object.values(sellMap).sort((a,b) => b.qty-a.qty).slice(0,10), sales: salesList.map(s => ({...s, items: JSON.parse(s.items)})), logs
  });
});

// ---- 设置 ----
app.get('/api/settings', auth, (req, res) => res.json(db.settings));
app.put('/api/settings', auth, adminOnly, (req, res) => { Object.assign(db.settings, req.body); saveDB(); res.json({ success: true }); });

// ---- 前端 ----
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---- 启动 ----
app.listen(PORT, '0.0.0.0', () => {
  console.log('🏪 便利店库存 v2.1');
  console.log('📡 http://0.0.0.0:'+PORT);
  console.log('🔑 admin / admin123');
  console.log('📁 '+DB_PATH);
});
