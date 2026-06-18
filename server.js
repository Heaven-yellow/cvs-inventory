const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'data.json');

function loadDB() {
  try {
    if (fs.existsSync(DB_PATH)) return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch(e) { console.error('读取出错', e.message); }
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

// =================================================================
// 北京时间工具
// =================================================================
function beijingNow() {
  const d = new Date();
  const bj = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  return bj.toISOString().replace('T', ' ').slice(0, 19);
}
function beijingDate() { return beijingNow().slice(0, 10); }

// 解析日期范围（北京时间）
function parseDateRange(startDate, endDate) {
  const start = startDate ? startDate + ' 00:00:00' : '2000-01-01 00:00:00';
  const end = endDate ? endDate + ' 23:59:59' : '2099-12-31 23:59:59';
  return { start, end };
}

// =================================================================
// Express
// =================================================================
const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'cvs-secret-change-me';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ error: '未登录' });
  try { req.user = jwt.verify(header.slice(7), JWT_SECRET); next(); }
  catch(e) { return res.status(401).json({ error: '登录已过期' }); }
}
function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可操作' });
  next();
}
function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// =================================================================
// 定期清理3个月前的日志
// =================================================================
function cleanOldLogs() {
  const threeMonthsAgo = new Date();
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
  const cutoff = new Date(threeMonthsAgo.getTime() + 8 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  const before = db.stock_log.length;
  db.stock_log = db.stock_log.filter(l => l.time >= cutoff);
  if (db.stock_log.length !== before) saveDB();
}
// 每天执行一次清理
setInterval(cleanOldLogs, 24 * 60 * 60 * 1000);
cleanOldLogs();

// =================================================================
// 登录
// =================================================================
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '请输入账号和密码' });
  const user = db.users.find(u => u.username === username);
  if (!user || !bcrypt.compareSync(password, user.password)) return res.status(401).json({ error: '账号或密码错误' });
  const token = jwt.sign({ id: user.id, username: user.username, display_name: user.display_name, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role } });
});
app.get('/api/me', auth, (req, res) => res.json({ user: req.user }));

// =================================================================
// 用户管理
// =================================================================
app.get('/api/users', auth, adminOnly, (req, res) => {
  res.json(db.users.map(u => ({ id: u.id, username: u.username, display_name: u.display_name, role: u.role, created_at: u.created_at })));
});
app.post('/api/users', auth, adminOnly, (req, res) => {
  const { username, password, display_name, role } = req.body;
  if (!username || !password || !display_name) return res.status(400).json({ error: '请填写完整信息' });
  if (db.users.find(u => u.username === username)) return res.status(400).json({ error: '账号已存在' });
  db.users.push({ id: genId(), username, password: bcrypt.hashSync(password, 10), display_name, role: role || 'cashier', created_at: beijingNow() });
  saveDB(); res.json({ success: true });
});
app.put('/api/users/:id', auth, adminOnly, (req, res) => {
  const u = db.users.find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  if (req.body.display_name) u.display_name = req.body.display_name;
  if (req.body.role) u.role = req.body.role;
  if (req.body.password) u.password = bcrypt.hashSync(req.body.password, 10);
  saveDB(); res.json({ success: true });
});
app.delete('/api/users/:id', auth, adminOnly, (req, res) => {
  const idx = db.users.findIndex(x => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '用户不存在' });
  if (db.users[idx].role === 'admin') return res.status(400).json({ error: '不能删除管理员' });
  db.users.splice(idx, 1); saveDB(); res.json({ success: true });
});

// =================================================================
// 商品
// =================================================================
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
  db.products.push({ id: genId(), name, barcode: barcode || '', category, supplier: supplier || '', qty: qty || 0, min_stock: min_stock || 5, cost: cost || 0, price: price || 0, shelf: shelf || '', created_at: beijingNow(), updated_at: beijingNow() });
  saveDB(); res.json({ success: true });
});
app.put('/api/products/:id', auth, adminOnly, (req, res) => {
  const p = db.products.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: '商品不存在' });
  Object.assign(p, req.body); p.updated_at = beijingNow();
  saveDB(); res.json({ success: true });
});
app.delete('/api/products/:id', auth, adminOnly, (req, res) => {
  db.products = db.products.filter(x => x.id !== req.params.id); saveDB(); res.json({ success: true });
});

// =================================================================
// 入库 / 出库 / 售出
// =================================================================
function addLog(productId, productName, type, qty, note, operator) {
  // 清理旧日志
  const threeMonthsAgo = new Date();
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
  const cutoff = new Date(threeMonthsAgo.getTime() + 8 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  db.stock_log = db.stock_log.filter(l => l.time >= cutoff);

  db.stock_log.push({ time: beijingNow(), product_id: productId, product_name: productName, type, qty, note: note || '', operator: operator || '' });
}

app.post('/api/stock/in', auth, (req, res) => {
  const { product_id, qty, cost, note, manual_product } = req.body;
  if (!qty || qty < 1) return res.status(400).json({ error: '请输入有效数量' });
  let p;
  if (manual_product) {
    if (!manual_product.name || !manual_product.category) return res.status(400).json({ error: '请填写名称和分类' });
    p = { id: genId(), name: manual_product.name, barcode: manual_product.barcode || '', category: manual_product.category, supplier: manual_product.supplier || '', qty: 0, min_stock: manual_product.min_stock || 5, cost: 0, price: manual_product.price || 0, shelf: manual_product.shelf || '', created_at: beijingNow(), updated_at: beijingNow() };
    db.products.push(p);
  } else {
    if (!product_id) return res.status(400).json({ error: '请选择商品' });
    p = db.products.find(x => x.id === product_id);
    if (!p) return res.status(404).json({ error: '商品不存在' });
  }
  p.qty += qty;
  if (cost !== undefined && cost > 0) p.cost = cost;
  p.updated_at = beijingNow();
  addLog(p.id, p.name, 'in', qty, note || '入库', req.user.display_name);
  saveDB();
  res.json({ success: true, product: p });
});

app.post('/api/stock/out', auth, (req, res) => {
  const { product_id, qty, price, note } = req.body;
  if (!qty || qty < 1) return res.status(400).json({ error: '请输入有效数量' });
  if (!product_id) return res.status(400).json({ error: '请选择商品' });
  const p = db.products.find(x => x.id === product_id);
  if (!p) return res.status(404).json({ error: '商品不存在' });
  if (qty > p.qty) return res.status(400).json({ error: `库存不足！当前库存: ${p.qty}` });
  p.qty -= qty;
  if (price !== undefined && price > 0) p.price = price;
  p.updated_at = beijingNow();
  addLog(p.id, p.name, 'out', qty, note || '出库', req.user.display_name);
  saveDB();
  res.json({ success: true, product: p });
});

// =================================================================
// 售出（销售扣库存）
// =================================================================
app.post('/api/sell', auth, (req, res) => {
  const { items } = req.body;
  if (!items || !Array.isArray(items) || items.length === 0) return res.status(400).json({ error: '请添加商品' });

  const saleItems = [];
  for (const item of items) {
    const p = db.products.find(x => x.id === item.product_id);
    if (!p) return res.status(404).json({ error: `商品 ${item.product_name || item.product_id} 不存在` });
    if (item.qty > p.qty) return res.status(400).json({ error: `「${p.name}」库存不足（剩余 ${p.qty}）` });
    saleItems.push({ product_id: p.id, product_name: p.name, qty: item.qty, price: item.price || p.price, subtotal: (item.price || p.price) * item.qty });
  }

  const total = saleItems.reduce((s, i) => s + i.subtotal, 0);
  const saleId = genId();

  for (const si of saleItems) {
    const p = db.products.find(x => x.id === si.product_id);
    p.qty -= si.qty;
    addLog(p.id, p.name, 'sell', si.qty, '销售', req.user.display_name);
  }

  db.sales.push({ id: saleId, total, items: JSON.stringify(saleItems), operator: req.user.display_name, status: 'completed', created_at: beijingNow() });
  // 也清理旧销售记录（可选）
  saveDB();
  res.json({ success: true, sale_id: saleId, total, items: saleItems });
});

app.get('/api/sales', auth, (req, res) => {
  const { start_date, end_date } = req.query;
  const { start, end } = parseDateRange(start_date, end_date);
  let list = db.sales.filter(s => s.created_at >= start && s.created_at <= end);
  res.json(list.reverse());
});

// =================================================================
// 操作日志（带筛选）
// =================================================================
app.get('/api/logs', auth, (req, res) => {
  const { type, start_date, end_date, page = 1, page_size = 50 } = req.query;
  let logs = [...db.stock_log];

  if (type) logs = logs.filter(l => l.type === type);
  const { start, end } = parseDateRange(start_date, end_date);
  logs = logs.filter(l => l.time >= start && l.time <= end);

  // 按时间倒序
  logs.sort((a, b) => b.time.localeCompare(a.time));

  const total = logs.length;
  const p = parseInt(page);
  const ps = parseInt(page_size);
  const paged = logs.slice((p - 1) * ps, p * ps);

  res.json({ logs: paged, total, page: p, page_size: ps, total_pages: Math.ceil(total / ps) });
});

// =================================================================
// Dashboard
// =================================================================
app.get('/api/dashboard', auth, (req, res) => {
  const { low_threshold: low, critical_threshold: critical } = db.settings;
  const today = beijingDate();
  const todayStr = today + ' 00:00:00';
  const todayEnd = today + ' 23:59:59';

  const todaySales = db.sales.filter(s => s.created_at >= todayStr && s.created_at <= todayEnd);
  const todaySellLogs = db.stock_log.filter(l => l.time >= todayStr && l.time <= todayEnd && l.type === 'sell');
  const todayInLogs = db.stock_log.filter(l => l.time >= todayStr && l.time <= todayEnd && l.type === 'in');

  const totalSellQty = todaySellLogs.reduce((s, l) => s + l.qty, 0);
  const totalInQty = todayInLogs.reduce((s, l) => s + l.qty, 0);

  res.json({
    totalProducts: db.products.length,
    totalValue: db.products.reduce((s, p) => s + (p.qty || 0) * (p.cost || 0), 0),
    lowStock: db.products.filter(p => p.qty <= low && p.qty > critical).length,
    criticalStock: db.products.filter(p => p.qty <= critical).length,
    lowItems: db.products.filter(p => p.qty <= low).sort((a, b) => a.qty - b.qty),
    todaySales: { count: todaySales.length, total: todaySales.reduce((s, x) => s + x.total, 0), sellQty: totalSellQty, inQty: totalInQty },
    recentLogs: db.stock_log.slice(-10).reverse()
  });
});

// =================================================================
// 报表
// =================================================================
app.get('/api/reports', auth, (req, res) => {
  const { type, start_date, end_date } = req.query; // type: daily, weekly, monthly, yearly

  const { start, end } = parseDateRange(start_date, end_date);
  let logs = db.stock_log.filter(l => l.time >= start && l.time <= end);
  let salesList = db.sales.filter(s => s.created_at >= start && s.created_at <= end);

  // 按分类统计
  const catMap = {};
  db.products.forEach(p => {
    const c = p.category || '未分类';
    if (!catMap[c]) catMap[c] = { count: 0, qty: 0, value: 0 };
    catMap[c].count++; catMap[c].qty += p.qty || 0; catMap[c].value += (p.qty || 0) * (p.cost || 0);
  });

  // 销售统计
  const sellLogs = logs.filter(l => l.type === 'sell');
  const totalSales = salesList.reduce((s, x) => s + x.total, 0);
  const totalSellQty = sellLogs.reduce((s, l) => s + l.qty, 0);
  const totalSellItems = sellLogs.length;

  // 入库统计
  const inLogs = logs.filter(l => l.type === 'in');
  const totalInQty = inLogs.reduce((s, l) => s + l.qty, 0);
  const totalInCount = inLogs.length;

  // 出库统计（非销售）
  const outLogs = logs.filter(l => l.type === 'out');
  const totalOutQty = outLogs.reduce((s, l) => s + l.qty, 0);

  // 商品销售排行
  const sellMap = {};
  sellLogs.forEach(l => {
    if (!sellMap[l.product_name]) sellMap[l.product_name] = { name: l.product_name, qty: 0, count: 0 };
    sellMap[l.product_name].qty += l.qty;
    sellMap[l.product_name].count++;
  });
  const topSell = Object.values(sellMap).sort((a, b) => b.qty - a.qty).slice(0, 10);

  res.json({
    summary: { totalSales, totalSellQty, totalSellItems, totalInQty, totalInCount, totalOutQty },
    categoryReport: catMap,
    topSell,
    sales: salesList.map(s => ({ ...s, items: JSON.parse(s.items) })),
    logs
  });
});

// =================================================================
// 设置
// =================================================================
app.get('/api/settings', auth, (req, res) => res.json(db.settings));
app.put('/api/settings', auth, adminOnly, (req, res) => {
  Object.assign(db.settings, req.body); saveDB(); res.json({ success: true });
});

// =================================================================
// 前端路由
// =================================================================
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// =================================================================
// 启动
// =================================================================
app.listen(PORT, '0.0.0.0', () => {
  console.log('🏪 便利店库存系统 v2.0 已启动');
  console.log(`📡 地址: http://0.0.0.0:${PORT}`);
  console.log(`🔑 默认管理员: admin / admin123`);
  console.log(`📁 数据文件: ${DB_PATH}`);
});
