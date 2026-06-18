const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');

// =================================================================
// JSON 文件数据库
// =================================================================
const DB_PATH = path.join(__dirname, 'data.json');

function loadDB() {
  try {
    if (fs.existsSync(DB_PATH)) {
      return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    }
  } catch(e) { console.error('读取出错，重置数据', e.message); }
  return getDefaultDB();
}

function saveDB() {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
}

function getDefaultDB() {
  return {
    users: [
      { id: 'admin-1', username: 'admin', password: bcrypt.hashSync('admin123', 10), display_name: '管理员', role: 'admin', created_at: new Date().toLocaleString('zh-CN') }
    ],
    products: [],
    stock_log: [],
    sales: [],
    settings: {
      low_threshold: 10,
      critical_threshold: 3,
      shop_name: '我的便利店',
      categories: ['饮料','零食','方便食品','日用品','烟酒','冷藏食品','调味品']
    }
  };
}

let db = loadDB();

// =================================================================
// Express
// =================================================================
const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'cvs-secret-change-me';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// =================================================================
// Auth 中间件
// =================================================================
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ error: '未登录' });
  try {
    req.user = jwt.verify(header.slice(7), JWT_SECRET);
    next();
  } catch(e) { return res.status(401).json({ error: '登录已过期' }); }
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可操作' });
  next();
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// =================================================================
// 登录
// =================================================================
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '请输入账号和密码' });
  const user = db.users.find(u => u.username === username);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: '账号或密码错误' });
  }
  const token = jwt.sign(
    { id: user.id, username: user.username, display_name: user.display_name, role: user.role },
    JWT_SECRET, { expiresIn: '30d' }
  );
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
  db.users.push({ id: genId(), username, password: bcrypt.hashSync(password, 10), display_name, role: role || 'cashier', created_at: new Date().toLocaleString('zh-CN') });
  saveDB();
  res.json({ success: true });
});

app.put('/api/users/:id', auth, adminOnly, (req, res) => {
  const u = db.users.find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  if (req.body.display_name) u.display_name = req.body.display_name;
  if (req.body.role) u.role = req.body.role;
  if (req.body.password) u.password = bcrypt.hashSync(req.body.password, 10);
  saveDB();
  res.json({ success: true });
});

app.delete('/api/users/:id', auth, adminOnly, (req, res) => {
  const idx = db.users.findIndex(x => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '用户不存在' });
  if (db.users[idx].role === 'admin') return res.status(400).json({ error: '不能删除管理员' });
  db.users.splice(idx, 1);
  saveDB();
  res.json({ success: true });
});

// =================================================================
// 商品
// =================================================================
app.get('/api/products', auth, (req, res) => {
  let list = [...db.products];
  const { search, category, stock_status } = req.query;
  const { low_threshold: low, critical_threshold: critical } = db.settings;
  if (search) {
    const s = search.toLowerCase();
    list = list.filter(p => p.name.toLowerCase().includes(s) || (p.barcode && p.barcode.includes(s)) || (p.supplier && p.supplier.toLowerCase().includes(s)));
  }
  if (category) list = list.filter(p => p.category === category);
  if (stock_status === 'normal') list = list.filter(p => p.qty > low);
  else if (stock_status === 'low') list = list.filter(p => p.qty <= low && p.qty > critical);
  else if (stock_status === 'critical') list = list.filter(p => p.qty <= critical);
  res.json(list);
});

app.post('/api/products', auth, adminOnly, (req, res) => {
  const { name, barcode, category, supplier, qty, min_stock, cost, price, shelf } = req.body;
  if (!name || !category) return res.status(400).json({ error: '请填写名称和分类' });
  db.products.push({
    id: genId(), name, barcode: barcode || '', category, supplier: supplier || '',
    qty: qty || 0, min_stock: min_stock || 5, cost: cost || 0, price: price || 0, shelf: shelf || '',
    created_at: new Date().toLocaleString('zh-CN'), updated_at: new Date().toLocaleString('zh-CN')
  });
  saveDB();
  res.json({ success: true });
});

app.put('/api/products/:id', auth, adminOnly, (req, res) => {
  const p = db.products.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: '商品不存在' });
  Object.assign(p, req.body);
  p.updated_at = new Date().toLocaleString('zh-CN');
  saveDB();
  res.json({ success: true });
});

app.delete('/api/products/:id', auth, adminOnly, (req, res) => {
  db.products = db.products.filter(x => x.id !== req.params.id);
  saveDB();
  res.json({ success: true });
});

// =================================================================
// 入库 / 出库
// =================================================================
app.post('/api/stock/in', auth, (req, res) => {
  const { product_id, qty, cost, note, manual_product } = req.body;
  if (!qty || qty < 1) return res.status(400).json({ error: '请输入有效数量' });
  let p;
  if (manual_product) {
    if (!manual_product.name || !manual_product.category) return res.status(400).json({ error: '请填写名称和分类' });
    p = { id: genId(), name: manual_product.name, barcode: manual_product.barcode || '', category: manual_product.category, supplier: manual_product.supplier || '', qty: 0, min_stock: manual_product.min_stock || 5, cost: 0, price: manual_product.price || 0, shelf: manual_product.shelf || '', created_at: new Date().toLocaleString('zh-CN'), updated_at: new Date().toLocaleString('zh-CN') };
    db.products.push(p);
  } else {
    if (!product_id) return res.status(400).json({ error: '请选择商品' });
    p = db.products.find(x => x.id === product_id);
    if (!p) return res.status(404).json({ error: '商品不存在' });
  }
  p.qty += qty;
  if (cost !== undefined && cost > 0) p.cost = cost;
  p.updated_at = new Date().toLocaleString('zh-CN');
  db.stock_log.push({ time: new Date().toLocaleString('zh-CN'), product_id: p.id, product_name: p.name, type: 'in', qty, note: note || '入库', operator: req.user.display_name });
  saveDB();
  res.json({ success: true, product: p });
});

app.post('/api/stock/out', auth, (req, res) => {
  const { product_id, qty, price, note, manual_product } = req.body;
  if (!qty || qty < 1) return res.status(400).json({ error: '请输入有效数量' });
  let p;
  if (manual_product) {
    if (!manual_product.name || !manual_product.category) return res.status(400).json({ error: '请填写名称和分类' });
    p = { id: genId(), name: manual_product.name, barcode: manual_product.barcode || '', category: manual_product.category, supplier: manual_product.supplier || '', qty: -qty, min_stock: 5, cost: 0, price: manual_product.price || 0, shelf: manual_product.shelf || '', created_at: new Date().toLocaleString('zh-CN'), updated_at: new Date().toLocaleString('zh-CN') };
    db.products.push(p);
  } else {
    if (!product_id) return res.status(400).json({ error: '请选择商品' });
    p = db.products.find(x => x.id === product_id);
    if (!p) return res.status(404).json({ error: '商品不存在' });
    if (qty > p.qty) return res.status(400).json({ error: `库存不足！当前库存: ${p.qty}` });
    p.qty -= qty;
    if (price !== undefined && price > 0) p.price = price;
  }
  p.updated_at = new Date().toLocaleString('zh-CN');
  db.stock_log.push({ time: new Date().toLocaleString('zh-CN'), product_id: p.id, product_name: p.name, type: 'out', qty, note: note || '销售出库', operator: req.user.display_name });
  saveDB();
  res.json({ success: true, product: p });
});

// =================================================================
// 收银（一键销售 + 扣库存）
// =================================================================
app.post('/api/sale', auth, (req, res) => {
  const { items, payment_method } = req.body;
  if (!items || !Array.isArray(items) || items.length === 0) return res.status(400).json({ error: '请添加商品' });
  const saleItems = [];
  for (const item of items) {
    const p = db.products.find(x => x.id === item.product_id);
    if (!p) return res.status(404).json({ error: `商品不存在` });
    if (item.qty > p.qty) return res.status(400).json({ error: `「${p.name}」库存不足` });
    saleItems.push({ product_id: p.id, product_name: p.name, qty: item.qty, price: item.price || p.price, subtotal: (item.price || p.price) * item.qty });
  }
  const total = saleItems.reduce((s, i) => s + i.subtotal, 0);
  const saleId = genId();
  for (const si of saleItems) {
    const p = db.products.find(x => x.id === si.product_id);
    p.qty -= si.qty;
    db.stock_log.push({ time: new Date().toLocaleString('zh-CN'), product_id: p.id, product_name: p.name, type: 'out', qty: si.qty, note: '销售出库', operator: req.user.display_name });
  }
  db.sales.push({ id: saleId, total, items: JSON.stringify(saleItems), payment_method: payment_method || 'wechat', operator: req.user.display_name, status: 'completed', created_at: new Date().toLocaleString('zh-CN') });
  saveDB();
  res.json({ success: true, sale_id: saleId, total, items: saleItems });
});

app.get('/api/sales', auth, (req, res) => {
  let list = [...db.sales];
  if (req.query.date) list = list.filter(s => s.created_at.startsWith(req.query.date));
  res.json(list.reverse());
});

// =================================================================
// Dashboard
// =================================================================
app.get('/api/dashboard', auth, (req, res) => {
  const { low_threshold: low, critical_threshold: critical } = db.settings;
  const todayStr = new Date().toLocaleString('zh-CN').split(' ')[0];
  const todaySalesList = db.sales.filter(s => s.created_at.startsWith(todayStr));
  res.json({
    totalProducts: db.products.length,
    totalValue: db.products.reduce((s, p) => s + (p.qty || 0) * (p.cost || 0), 0),
    lowStock: db.products.filter(p => p.qty <= low && p.qty > critical).length,
    criticalStock: db.products.filter(p => p.qty <= critical).length,
    lowItems: db.products.filter(p => p.qty <= low).sort((a, b) => a.qty - b.qty),
    todaySales: { count: todaySalesList.length, total: todaySalesList.reduce((s, x) => s + x.total, 0) },
    recentLogs: db.stock_log.slice(-10).reverse()
  });
});

app.get('/api/stock/log', auth, (req, res) => {
  res.json(db.stock_log.slice(-50).reverse());
});

// =================================================================
// 报表
// =================================================================
app.get('/api/reports', auth, (req, res) => {
  const catMap = {};
  db.products.forEach(p => {
    const c = p.category || '未分类';
    if (!catMap[c]) catMap[c] = { count: 0, qty: 0, value: 0 };
    catMap[c].count++; catMap[c].qty += p.qty || 0; catMap[c].value += (p.qty || 0) * (p.cost || 0);
  });
  const totalStock = db.products.reduce((s, p) => s + (p.qty || 0), 0);
  const avgPrice = db.products.length ? db.products.reduce((s, p) => s + (p.price || 0), 0) / db.products.length : 0;
  const maxStock = Math.max(...db.products.map(p => p.qty), 0);
  const maxName = db.products.find(p => p.qty === maxStock);
  res.json({ categoryReport: catMap, overview: { totalStock, avgPrice, maxStock: maxName ? { name: maxName.name, qty: maxStock } : null } });
});

// =================================================================
// 设置
// =================================================================
app.get('/api/settings', auth, (req, res) => res.json(db.settings));

app.put('/api/settings', auth, adminOnly, (req, res) => {
  Object.assign(db.settings, req.body);
  saveDB();
  res.json({ success: true });
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
  console.log('🏪 便利店库存系统已启动');
  console.log(`📡 地址: http://0.0.0.0:${PORT}`);
  console.log(`🔑 默认管理员: admin / admin123`);
  console.log(`📁 数据文件: ${DB_PATH}`);
});
