const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { initDatabase, getDatabase, saveDatabase } = require('./database');
const { initDetectionModel, detectFromBase64, isOverloaded } = require('./detection');

const app = express();
const server = http.createServer({
  maxHeaderSize: 16384, // 16KB headers
  // Increase max body size at HTTP server level
}, app);
const wss = new WebSocket.Server({ server });

// Middleware - MUST be before routes
// Increase body size limit to 50MB for large GeoJSON uploads
// Note: Express default is 100kb, we need much more for GeoJSON
app.use(express.json({
  limit: '50mb',
  parameterLimit: 50000,
  strict: false,
  type: 'application/json'
}));
app.use(express.urlencoded({
  extended: true,
  limit: '50mb',
  parameterLimit: 50000,
  type: 'application/x-www-form-urlencoded'
}));
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Serve index.html for root path
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Store active RTSP streams
const activeStreams = new Map();

// Simple token store (in production, use JWT or sessions)
const activeTokens = new Map();

// Generate token
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Verify token middleware
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.log('Auth failed: No authorization header or invalid format');
    console.log('Headers:', JSON.stringify(req.headers, null, 2));
    return res.status(401).json({ success: false, error: 'Token tidak ditemukan' });
  }

  const token = authHeader.split(' ')[1];

  console.log('Token received:', token ? token.substring(0, 10) + '...' : 'null');
  console.log('Active tokens count:', activeTokens.size);
  console.log('Token exists:', activeTokens.has(token));

  if (!activeTokens.has(token)) {
    console.log('Auth failed: Token not found in activeTokens');
    return res.status(401).json({ success: false, error: 'Token tidak valid. Silakan login ulang.' });
  }

  req.user = activeTokens.get(token);
  console.log('Auth success for user:', req.user.username);
  next();
}

// Helper function to get all results from sql.js
function queryAll(sql, params = []) {
  const db = getDatabase();
  const stmt = db.prepare(sql);
  if (params.length > 0) {
    stmt.bind(params);
  }
  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

// Helper function to get one result
function queryOne(sql, params = []) {
  const results = queryAll(sql, params);
  return results[0] || null;
}

// Helper function to run a statement
function runQuery(sql, params = []) {
  const db = getDatabase();
  db.run(sql, params);
  saveDatabase();
}

// ============ Authentication API ============

// Login
app.post('/api/auth/login', (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Username dan password harus diisi' });
    }

    // Hash password for comparison
    const hashedPassword = crypto.createHash('sha256').update(password).digest('hex');

    // Find user in database
    const user = queryOne('SELECT * FROM users WHERE username = ?', [username]);

    if (!user) {
      return res.status(401).json({ success: false, error: 'Username atau password salah' });
    }

    // Check password
    if (user.password !== hashedPassword) {
      return res.status(401).json({ success: false, error: 'Username atau password salah' });
    }

    // Check if user is active
    if (user.status !== 'active') {
      return res.status(401).json({ success: false, error: 'Akun tidak aktif' });
    }

    // Update last login
    runQuery("UPDATE users SET last_login = datetime('now') WHERE id = ?", [user.id]);

    const token = generateToken();
    activeTokens.set(token, {
      id: user.id,
      username: user.username,
      name: user.nama,
      role: user.role
    });

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        username: user.username,
        name: user.nama,
        role: user.role
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  const authHeader = req.headers.authorization;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    activeTokens.delete(token);
  }

  res.json({ success: true, message: 'Logout berhasil' });
});

// Check auth status
app.get('/api/auth/me', authMiddleware, (req, res) => {
  res.json({ success: true, user: req.user });
});

// ============ CRUD API for CCTV ============

// GET all CCTV (public)
app.get('/api/cctv', (req, res) => {
  try {
    const cctvs = queryAll('SELECT * FROM cctv ORDER BY created_at DESC');
    res.json({ success: true, data: cctvs });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET single CCTV by ID (public)
app.get('/api/cctv/:id', (req, res) => {
  try {
    const cctv = queryOne('SELECT * FROM cctv WHERE id = ?', [req.params.id]);
    if (!cctv) {
      return res.status(404).json({ success: false, error: 'CCTV not found' });
    }
    res.json({ success: true, data: cctv });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// CREATE new CCTV (protected)
app.post('/api/cctv', (req, res) => {
  try {
    const { name, description, latitude, longitude, rtsp_url, location, status } = req.body;

    if (!name || !latitude || !longitude || !rtsp_url) {
      return res.status(400).json({
        success: false,
        error: 'Name, latitude, longitude, dan rtsp_url harus diisi'
      });
    }

    const id = uuidv4();
    runQuery(`
      INSERT INTO cctv (id, name, description, latitude, longitude, rtsp_url, location, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [id, name, description || '', latitude, longitude, rtsp_url, location || '', status || 'active']);

    const newCctv = queryOne('SELECT * FROM cctv WHERE id = ?', [id]);
    res.status(201).json({ success: true, data: newCctv });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// UPDATE CCTV (protected)
app.put('/api/cctv/:id', (req, res) => {
  try {
    const { name, description, latitude, longitude, rtsp_url, location, status } = req.body;
    const { id } = req.params;

    const existing = queryOne('SELECT * FROM cctv WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'CCTV tidak ditemukan' });
    }

    runQuery(`
      UPDATE cctv 
      SET name = ?, description = ?, latitude = ?, longitude = ?, 
          rtsp_url = ?, location = ?, status = ?, updated_at = datetime('now')
      WHERE id = ?
    `, [
      name || existing.name,
      description !== undefined ? description : existing.description,
      latitude || existing.latitude,
      longitude || existing.longitude,
      rtsp_url || existing.rtsp_url,
      location !== undefined ? location : existing.location,
      status || existing.status,
      id
    ]);

    const updatedCctv = queryOne('SELECT * FROM cctv WHERE id = ?', [id]);
    res.json({ success: true, data: updatedCctv });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE CCTV (protected)
app.delete('/api/cctv/:id', (req, res) => {
  try {
    const { id } = req.params;

    const existing = queryOne('SELECT * FROM cctv WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'CCTV tidak ditemukan' });
    }

    // Stop stream if active
    if (activeStreams.has(id)) {
      const stream = activeStreams.get(id);
      if (stream.ffmpeg) {
        stream.ffmpeg.kill('SIGTERM');
      }
      activeStreams.delete(id);
    }

    runQuery('DELETE FROM cctv WHERE id = ?', [id]);
    res.json({ success: true, message: 'CCTV berhasil dihapus' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ CRUD API for Users ============

// Helper: Hash password
function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

// GET all users (protected - admin only)
app.get('/api/users', authMiddleware, (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Akses ditolak' });
    }

    const users = queryAll('SELECT id, username, nama, email, role, status, last_login, created_at, updated_at FROM users ORDER BY created_at DESC');
    res.json({ success: true, data: users });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET single user by ID (protected)
app.get('/api/users/:id', authMiddleware, (req, res) => {
  try {
    const user = queryOne('SELECT id, username, nama, email, role, status, last_login, created_at, updated_at FROM users WHERE id = ?', [req.params.id]);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User tidak ditemukan' });
    }
    res.json({ success: true, data: user });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// CREATE new user (protected - admin only)
app.post('/api/users', authMiddleware, (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Akses ditolak' });
    }

    const { username, password, nama, email, role, status } = req.body;

    if (!username || !password || !nama) {
      return res.status(400).json({
        success: false,
        error: 'Username, password, dan nama harus diisi'
      });
    }

    // Check if username exists
    const existing = queryOne('SELECT id FROM users WHERE username = ?', [username]);
    if (existing) {
      return res.status(400).json({ success: false, error: 'Username sudah digunakan' });
    }

    const id = uuidv4();
    const hashedPassword = hashPassword(password);

    runQuery(`
      INSERT INTO users (id, username, password, nama, email, role, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [id, username, hashedPassword, nama, email || '', role || 'operator', status || 'active']);

    const newUser = queryOne('SELECT id, username, nama, email, role, status, created_at FROM users WHERE id = ?', [id]);
    res.status(201).json({ success: true, data: newUser });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// UPDATE user (protected - admin only)
app.put('/api/users/:id', authMiddleware, (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Akses ditolak' });
    }

    const { username, password, nama, email, role, status } = req.body;
    const { id } = req.params;

    const existing = queryOne('SELECT * FROM users WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'User tidak ditemukan' });
    }

    // Check if new username is taken by another user
    if (username && username !== existing.username) {
      const usernameCheck = queryOne('SELECT id FROM users WHERE username = ? AND id != ?', [username, id]);
      if (usernameCheck) {
        return res.status(400).json({ success: false, error: 'Username sudah digunakan' });
      }
    }

    // Build update query
    let updateFields = [];
    let params = [];

    if (username) { updateFields.push('username = ?'); params.push(username); }
    if (password) { updateFields.push('password = ?'); params.push(hashPassword(password)); }
    if (nama) { updateFields.push('nama = ?'); params.push(nama); }
    if (email !== undefined) { updateFields.push('email = ?'); params.push(email); }
    if (role) { updateFields.push('role = ?'); params.push(role); }
    if (status) { updateFields.push('status = ?'); params.push(status); }

    updateFields.push("updated_at = datetime('now')");
    params.push(id);

    runQuery(`UPDATE users SET ${updateFields.join(', ')} WHERE id = ?`, params);

    const updatedUser = queryOne('SELECT id, username, nama, email, role, status, updated_at FROM users WHERE id = ?', [id]);
    res.json({ success: true, data: updatedUser });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE user (protected - admin only)
app.delete('/api/users/:id', authMiddleware, (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Akses ditolak' });
    }

    const { id } = req.params;

    const existing = queryOne('SELECT * FROM users WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'User tidak ditemukan' });
    }

    // Prevent deleting self
    if (existing.username === req.user.username) {
      return res.status(400).json({ success: false, error: 'Tidak dapat menghapus akun sendiri' });
    }

    runQuery('DELETE FROM users WHERE id = ?', [id]);
    res.json({ success: true, message: 'User berhasil dihapus' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ CRUD API for Kecamatan ============

// GET all kecamatan
app.get('/api/kecamatan', (req, res) => {
  try {
    const kecamatan = queryAll('SELECT * FROM kecamatan ORDER BY nama');
    res.json({ success: true, data: kecamatan });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET kecamatan by ID
app.get('/api/kecamatan/:id', (req, res) => {
  try {
    const { id } = req.params;
    const kecamatan = queryOne('SELECT * FROM kecamatan WHERE id = ?', [id]);
    if (!kecamatan) {
      return res.status(404).json({ success: false, error: 'Kecamatan tidak ditemukan' });
    }
    res.json({ success: true, data: kecamatan });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// CREATE kecamatan (protected - admin only)
app.post('/api/kecamatan', authMiddleware, (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Akses ditolak. Hanya admin yang bisa menambah kecamatan.' });
    }

    const { kode, nama, kabupaten, provinsi, luas, warna, geojson } = req.body;

    if (!kode || !nama || !geojson) {
      return res.status(400).json({ success: false, error: 'Kode, nama, dan geojson harus diisi' });
    }

    // Validate geojson
    let geoData;
    try {
      geoData = typeof geojson === 'string' ? JSON.parse(geojson) : geojson;

      if (!geoData || !geoData.type) {
        return res.status(400).json({ success: false, error: 'Format GeoJSON tidak valid: missing type' });
      }

      // Accept FeatureCollection or Feature
      if (geoData.type === 'FeatureCollection') {
        if (!Array.isArray(geoData.features)) {
          return res.status(400).json({ success: false, error: 'FeatureCollection harus memiliki features array' });
        }
        if (geoData.features.length === 0) {
          return res.status(400).json({ success: false, error: 'FeatureCollection harus memiliki minimal 1 feature' });
        }
      } else if (geoData.type === 'Feature') {
        if (!geoData.geometry) {
          return res.status(400).json({ success: false, error: 'Feature harus memiliki geometry' });
        }
        // Convert to FeatureCollection
        geoData = {
          type: 'FeatureCollection',
          features: [geoData]
        };
      } else {
        return res.status(400).json({ success: false, error: 'Format GeoJSON tidak valid. Harus FeatureCollection atau Feature' });
      }
    } catch (e) {
      console.error('GeoJSON validation error:', e);
      return res.status(400).json({ success: false, error: 'GeoJSON tidak valid: ' + e.message });
    }

    // Check if kode already exists
    const existing = queryOne('SELECT * FROM kecamatan WHERE kode = ?', [kode]);
    if (existing) {
      return res.status(400).json({ success: false, error: 'Kode kecamatan sudah digunakan' });
    }

    const id = uuidv4();
    const geojsonStr = JSON.stringify(geoData);

    // Check size limit (50MB)
    if (geojsonStr.length > 50 * 1024 * 1024) {
      return res.status(400).json({ success: false, error: 'Ukuran GeoJSON terlalu besar. Maksimal 50MB' });
    }

    try {
      runQuery(`
        INSERT INTO kecamatan (id, kode, nama, kabupaten, provinsi, luas, warna, geojson)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [id, kode, nama, kabupaten || 'Konawe', provinsi || 'Sulawesi Tenggara', luas || null, warna || '#fbbf24', geojsonStr]);

      const newKecamatan = queryOne('SELECT * FROM kecamatan WHERE id = ?', [id]);
      res.status(201).json({ success: true, data: newKecamatan });
    } catch (dbError) {
      console.error('Database insert error:', dbError);
      res.status(500).json({ success: false, error: 'Gagal menyimpan ke database: ' + dbError.message });
    }
  } catch (error) {
    console.error('Create kecamatan error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// UPDATE kecamatan (protected - admin only)
app.put('/api/kecamatan/:id', authMiddleware, (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Akses ditolak. Hanya admin yang bisa mengubah kecamatan.' });
    }

    const { id } = req.params;
    const { kode, nama, kabupaten, provinsi, luas, warna, geojson } = req.body;

    const existing = queryOne('SELECT * FROM kecamatan WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Kecamatan tidak ditemukan' });
    }

    // Validate geojson if provided
    if (geojson) {
      try {
        const geoData = typeof geojson === 'string' ? JSON.parse(geojson) : geojson;
        if (!geoData.type || !geoData.features) {
          return res.status(400).json({ success: false, error: 'Format GeoJSON tidak valid' });
        }
      } catch (e) {
        return res.status(400).json({ success: false, error: 'GeoJSON tidak valid: ' + e.message });
      }
    }

    // Check kode uniqueness if changed
    if (kode && kode !== existing.kode) {
      const kodeExists = queryOne('SELECT * FROM kecamatan WHERE kode = ? AND id != ?', [kode, id]);
      if (kodeExists) {
        return res.status(400).json({ success: false, error: 'Kode kecamatan sudah digunakan' });
      }
    }

    const geojsonStr = geojson ? (typeof geojson === 'string' ? geojson : JSON.stringify(geojson)) : existing.geojson;

    try {
      runQuery(`
        UPDATE kecamatan
        SET kode = ?, nama = ?, kabupaten = ?, provinsi = ?, luas = ?, warna = ?, geojson = ?, updated_at = datetime('now')
        WHERE id = ?
      `, [
        kode || existing.kode,
        nama || existing.nama,
        kabupaten || existing.kabupaten,
        provinsi || existing.provinsi,
        luas !== undefined ? luas : existing.luas,
        warna || existing.warna,
        geojsonStr,
        id
      ]);

      const updatedKecamatan = queryOne('SELECT * FROM kecamatan WHERE id = ?', [id]);
      res.json({ success: true, data: updatedKecamatan });
    } catch (dbError) {
      console.error('Database update error:', dbError);
      res.status(500).json({ success: false, error: 'Gagal menyimpan ke database: ' + dbError.message });
    }
  } catch (error) {
    console.error('Update kecamatan error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE kecamatan (protected - admin only)
app.delete('/api/kecamatan/:id', authMiddleware, (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Akses ditolak. Hanya admin yang bisa menghapus kecamatan.' });
    }

    const { id } = req.params;
    const existing = queryOne('SELECT * FROM kecamatan WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Kecamatan tidak ditemukan' });
    }

    // Check if has kelurahan
    const kelurahanCount = queryOne('SELECT COUNT(*) as count FROM kelurahan WHERE kecamatan_id = ?', [id]);
    if (kelurahanCount && kelurahanCount.count > 0) {
      return res.status(400).json({ success: false, error: 'Tidak dapat menghapus kecamatan yang memiliki kelurahan' });
    }

    runQuery('DELETE FROM kecamatan WHERE id = ?', [id]);
    res.json({ success: true, message: 'Kecamatan berhasil dihapus' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ CRUD API for Kelurahan ============

// GET all kelurahan
app.get('/api/kelurahan', (req, res) => {
  try {
    const kelurahan = queryAll('SELECT * FROM kelurahan ORDER BY nama');
    res.json({ success: true, data: kelurahan });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET kelurahan by ID
app.get('/api/kelurahan/:id', (req, res) => {
  try {
    const { id } = req.params;
    const kelurahan = queryOne('SELECT * FROM kelurahan WHERE id = ?', [id]);
    if (!kelurahan) {
      return res.status(404).json({ success: false, error: 'Kelurahan tidak ditemukan' });
    }
    res.json({ success: true, data: kelurahan });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET kelurahan by kecamatan
app.get('/api/kelurahan/kecamatan/:kecamatan_id', (req, res) => {
  try {
    const { kecamatan_id } = req.params;
    const kelurahan = queryAll('SELECT * FROM kelurahan WHERE kecamatan_id = ? ORDER BY nama', [kecamatan_id]);
    res.json({ success: true, data: kelurahan });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// CREATE kelurahan (protected - admin only)
app.post('/api/kelurahan', authMiddleware, (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Akses ditolak. Hanya admin yang bisa menambah kelurahan.' });
    }

    const { kode, nama, kecamatan_id, kecamatan_nama, jenis, luas, warna, geojson } = req.body;

    if (!kode || !nama || !geojson) {
      return res.status(400).json({ success: false, error: 'Kode, nama, dan geojson harus diisi' });
    }

    // Validate geojson
    try {
      const geoData = typeof geojson === 'string' ? JSON.parse(geojson) : geojson;
      if (!geoData.type || !geoData.features) {
        return res.status(400).json({ success: false, error: 'Format GeoJSON tidak valid' });
      }
    } catch (e) {
      return res.status(400).json({ success: false, error: 'GeoJSON tidak valid: ' + e.message });
    }

    // Check if kode already exists
    const existing = queryOne('SELECT * FROM kelurahan WHERE kode = ?', [kode]);
    if (existing) {
      return res.status(400).json({ success: false, error: 'Kode kelurahan sudah digunakan' });
    }

    // Get kecamatan info if kecamatan_id provided
    let kecamatanInfo = null;
    if (kecamatan_id) {
      kecamatanInfo = queryOne('SELECT * FROM kecamatan WHERE id = ?', [kecamatan_id]);
      if (!kecamatanInfo) {
        return res.status(400).json({ success: false, error: 'Kecamatan tidak ditemukan' });
      }
    }

    const id = uuidv4();
    const geojsonStr = typeof geojson === 'string' ? geojson : JSON.stringify(geojson);

    runQuery(`
      INSERT INTO kelurahan (id, kode, nama, kecamatan_id, kecamatan_nama, jenis, luas, warna, geojson)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      id,
      kode,
      nama,
      kecamatan_id || null,
      kecamatan_nama || kecamatanInfo?.nama || null,
      jenis || 'kelurahan',
      luas || null,
      warna || '#22c55e',
      geojsonStr
    ]);

    const newKelurahan = queryOne('SELECT * FROM kelurahan WHERE id = ?', [id]);
    res.status(201).json({ success: true, data: newKelurahan });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// UPDATE kelurahan (protected - admin only)
app.put('/api/kelurahan/:id', authMiddleware, (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Akses ditolak. Hanya admin yang bisa mengubah kelurahan.' });
    }

    const { id } = req.params;
    const { kode, nama, kecamatan_id, kecamatan_nama, jenis, luas, warna, geojson } = req.body;

    const existing = queryOne('SELECT * FROM kelurahan WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Kelurahan tidak ditemukan' });
    }

    // Validate geojson if provided
    if (geojson) {
      try {
        const geoData = typeof geojson === 'string' ? JSON.parse(geojson) : geojson;
        if (!geoData.type || !geoData.features) {
          return res.status(400).json({ success: false, error: 'Format GeoJSON tidak valid' });
        }
      } catch (e) {
        return res.status(400).json({ success: false, error: 'GeoJSON tidak valid: ' + e.message });
      }
    }

    // Check kode uniqueness if changed
    if (kode && kode !== existing.kode) {
      const kodeExists = queryOne('SELECT * FROM kelurahan WHERE kode = ? AND id != ?', [kode, id]);
      if (kodeExists) {
        return res.status(400).json({ success: false, error: 'Kode kelurahan sudah digunakan' });
      }
    }

    // Get kecamatan info if kecamatan_id provided
    let kecamatanInfo = null;
    if (kecamatan_id) {
      kecamatanInfo = queryOne('SELECT * FROM kecamatan WHERE id = ?', [kecamatan_id]);
      if (!kecamatanInfo) {
        return res.status(400).json({ success: false, error: 'Kecamatan tidak ditemukan' });
      }
    }

    const geojsonStr = geojson ? (typeof geojson === 'string' ? geojson : JSON.stringify(geojson)) : existing.geojson;

    runQuery(`
      UPDATE kelurahan
      SET kode = ?, nama = ?, kecamatan_id = ?, kecamatan_nama = ?, jenis = ?, luas = ?, warna = ?, geojson = ?, updated_at = datetime('now')
      WHERE id = ?
    `, [
      kode || existing.kode,
      nama || existing.nama,
      kecamatan_id !== undefined ? kecamatan_id : existing.kecamatan_id,
      kecamatan_nama || kecamatanInfo?.nama || existing.kecamatan_nama,
      jenis || existing.jenis,
      luas !== undefined ? luas : existing.luas,
      warna || existing.warna,
      geojsonStr,
      id
    ]);

    const updatedKelurahan = queryOne('SELECT * FROM kelurahan WHERE id = ?', [id]);
    res.json({ success: true, data: updatedKelurahan });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE kelurahan (protected - admin only)
app.delete('/api/kelurahan/:id', authMiddleware, (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Akses ditolak. Hanya admin yang bisa menghapus kelurahan.' });
    }

    const { id } = req.params;
    const existing = queryOne('SELECT * FROM kelurahan WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Kelurahan tidak ditemukan' });
    }

    runQuery('DELETE FROM kelurahan WHERE id = ?', [id]);
    res.json({ success: true, message: 'Kelurahan berhasil dihapus' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Change password (protected - self or admin)
app.put('/api/users/:id/password', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const { old_password, new_password } = req.body;

    const user = queryOne('SELECT * FROM users WHERE id = ?', [id]);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User tidak ditemukan' });
    }

    // Only admin or self can change password
    if (req.user.role !== 'admin' && req.user.id !== id) {
      return res.status(403).json({ success: false, error: 'Akses ditolak' });
    }

    // If not admin, require old password
    if (req.user.role !== 'admin') {
      if (!old_password) {
        return res.status(400).json({ success: false, error: 'Password lama harus diisi' });
      }
      if (hashPassword(old_password) !== user.password) {
        return res.status(400).json({ success: false, error: 'Password lama salah' });
      }
    }

    if (!new_password || new_password.length < 6) {
      return res.status(400).json({ success: false, error: 'Password baru minimal 6 karakter' });
    }

    runQuery("UPDATE users SET password = ?, updated_at = datetime('now') WHERE id = ?", [hashPassword(new_password), id]);
    res.json({ success: true, message: 'Password berhasil diubah' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ CRUD API for Kecamatan ============

// GET all kecamatan
app.get('/api/kecamatan', (req, res) => {
  try {
    const data = queryAll('SELECT * FROM kecamatan ORDER BY nama ASC');
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET kecamatan as GeoJSON FeatureCollection
app.get('/api/kecamatan/geojson', (req, res) => {
  try {
    const data = queryAll('SELECT * FROM kecamatan ORDER BY nama ASC');
    const features = data.map(kec => ({
      type: 'Feature',
      properties: {
        id: kec.id,
        kode: kec.kode,
        nama: kec.nama,
        kabupaten: kec.kabupaten,
        provinsi: kec.provinsi,
        luas: kec.luas,
        warna: kec.warna
      },
      geometry: JSON.parse(kec.geojson)
    }));

    res.json({
      type: 'FeatureCollection',
      features
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET single kecamatan
app.get('/api/kecamatan/:id', (req, res) => {
  try {
    const kec = queryOne('SELECT * FROM kecamatan WHERE id = ?', [req.params.id]);
    if (!kec) {
      return res.status(404).json({ success: false, error: 'Kecamatan tidak ditemukan' });
    }
    res.json({ success: true, data: kec });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// CREATE kecamatan
app.post('/api/kecamatan', (req, res) => {
  try {
    const { kode, nama, kabupaten, provinsi, luas, warna, geojson } = req.body;

    if (!nama || !geojson) {
      return res.status(400).json({ success: false, error: 'Nama dan geojson harus diisi' });
    }

    const id = uuidv4();
    const geojsonStr = typeof geojson === 'string' ? geojson : JSON.stringify(geojson);

    runQuery(`
      INSERT INTO kecamatan (id, kode, nama, kabupaten, provinsi, luas, warna, geojson)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [id, kode || '', nama, kabupaten || 'Konawe', provinsi || 'Sulawesi Tenggara', luas || 0, warna || '#fbbf24', geojsonStr]);

    const newKec = queryOne('SELECT * FROM kecamatan WHERE id = ?', [id]);
    res.status(201).json({ success: true, data: newKec });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// UPDATE kecamatan
app.put('/api/kecamatan/:id', (req, res) => {
  try {
    const { kode, nama, kabupaten, provinsi, luas, warna, geojson } = req.body;
    const { id } = req.params;

    const existing = queryOne('SELECT * FROM kecamatan WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Kecamatan tidak ditemukan' });
    }

    let geojsonStr = existing.geojson;
    if (geojson) {
      geojsonStr = typeof geojson === 'string' ? geojson : JSON.stringify(geojson);
    }

    runQuery(`
      UPDATE kecamatan 
      SET kode = ?, nama = ?, kabupaten = ?, provinsi = ?, luas = ?, warna = ?, geojson = ?, updated_at = datetime('now')
      WHERE id = ?
    `, [
      kode !== undefined ? kode : existing.kode,
      nama || existing.nama,
      kabupaten || existing.kabupaten,
      provinsi || existing.provinsi,
      luas !== undefined ? luas : existing.luas,
      warna || existing.warna,
      geojsonStr,
      id
    ]);

    const updated = queryOne('SELECT * FROM kecamatan WHERE id = ?', [id]);
    res.json({ success: true, data: updated });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE kecamatan
app.delete('/api/kecamatan/:id', (req, res) => {
  try {
    const { id } = req.params;

    const existing = queryOne('SELECT * FROM kecamatan WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Kecamatan tidak ditemukan' });
    }

    runQuery('DELETE FROM kecamatan WHERE id = ?', [id]);
    res.json({ success: true, message: 'Kecamatan berhasil dihapus' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ CRUD API for Kelurahan/Desa ============

// GET all kelurahan
app.get('/api/kelurahan', (req, res) => {
  try {
    const { kecamatan_id } = req.query;
    let sql = 'SELECT * FROM kelurahan';
    let params = [];

    if (kecamatan_id) {
      sql += ' WHERE kecamatan_id = ?';
      params.push(kecamatan_id);
    }
    sql += ' ORDER BY nama ASC';

    const data = queryAll(sql, params);
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET kelurahan as GeoJSON FeatureCollection
app.get('/api/kelurahan/geojson', (req, res) => {
  try {
    const { kecamatan_id } = req.query;
    let sql = 'SELECT * FROM kelurahan';
    let params = [];

    if (kecamatan_id) {
      sql += ' WHERE kecamatan_id = ?';
      params.push(kecamatan_id);
    }
    sql += ' ORDER BY nama ASC';

    const data = queryAll(sql, params);
    const features = data.map(kel => ({
      type: 'Feature',
      properties: {
        id: kel.id,
        kode: kel.kode,
        nama: kel.nama,
        kecamatan_id: kel.kecamatan_id,
        kecamatan_nama: kel.kecamatan_nama,
        jenis: kel.jenis,
        luas: kel.luas,
        warna: kel.warna
      },
      geometry: JSON.parse(kel.geojson)
    }));

    res.json({
      type: 'FeatureCollection',
      features
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET single kelurahan
app.get('/api/kelurahan/:id', (req, res) => {
  try {
    const kel = queryOne('SELECT * FROM kelurahan WHERE id = ?', [req.params.id]);
    if (!kel) {
      return res.status(404).json({ success: false, error: 'Kelurahan/Desa tidak ditemukan' });
    }
    res.json({ success: true, data: kel });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// CREATE kelurahan
app.post('/api/kelurahan', (req, res) => {
  try {
    const { kode, nama, kecamatan_id, kecamatan_nama, jenis, luas, warna, geojson } = req.body;

    if (!nama || !geojson) {
      return res.status(400).json({ success: false, error: 'Nama dan geojson harus diisi' });
    }

    const id = uuidv4();
    const geojsonStr = typeof geojson === 'string' ? geojson : JSON.stringify(geojson);

    runQuery(`
      INSERT INTO kelurahan (id, kode, nama, kecamatan_id, kecamatan_nama, jenis, luas, warna, geojson)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [id, kode || '', nama, kecamatan_id || '', kecamatan_nama || '', jenis || 'kelurahan', luas || 0, warna || '#22c55e', geojsonStr]);

    const newKel = queryOne('SELECT * FROM kelurahan WHERE id = ?', [id]);
    res.status(201).json({ success: true, data: newKel });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// UPDATE kelurahan
app.put('/api/kelurahan/:id', (req, res) => {
  try {
    const { kode, nama, kecamatan_id, kecamatan_nama, jenis, luas, warna, geojson } = req.body;
    const { id } = req.params;

    const existing = queryOne('SELECT * FROM kelurahan WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Kelurahan/Desa tidak ditemukan' });
    }

    let geojsonStr = existing.geojson;
    if (geojson) {
      geojsonStr = typeof geojson === 'string' ? geojson : JSON.stringify(geojson);
    }

    runQuery(`
      UPDATE kelurahan 
      SET kode = ?, nama = ?, kecamatan_id = ?, kecamatan_nama = ?, jenis = ?, luas = ?, warna = ?, geojson = ?, updated_at = datetime('now')
      WHERE id = ?
    `, [
      kode !== undefined ? kode : existing.kode,
      nama || existing.nama,
      kecamatan_id !== undefined ? kecamatan_id : existing.kecamatan_id,
      kecamatan_nama !== undefined ? kecamatan_nama : existing.kecamatan_nama,
      jenis || existing.jenis,
      luas !== undefined ? luas : existing.luas,
      warna || existing.warna,
      geojsonStr,
      id
    ]);

    const updated = queryOne('SELECT * FROM kelurahan WHERE id = ?', [id]);
    res.json({ success: true, data: updated });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE kelurahan
app.delete('/api/kelurahan/:id', (req, res) => {
  try {
    const { id } = req.params;

    const existing = queryOne('SELECT * FROM kelurahan WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Kelurahan/Desa tidak ditemukan' });
    }

    runQuery('DELETE FROM kelurahan WHERE id = ?', [id]);
    res.json({ success: true, message: 'Kelurahan/Desa berhasil dihapus' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ AI Detection API ============

// Detect objects from base64 image
app.post('/api/detect', async (req, res) => {
  try {
    const { image, cctv_id } = req.body;

    if (!image) {
      return res.status(400).json({ success: false, error: 'Image is required' });
    }

    // Get ROI settings if cctv_id provided
    let roi = null;
    if (cctv_id) {
      const roiData = queryOne('SELECT * FROM detection_roi WHERE cctv_id = ? AND enabled = 1', [cctv_id]);
      if (roiData) {
        roi = JSON.parse(roiData.roi_json);
      }
    }

    // Run detection with ROI
    const detections = await detectFromBase64(image, roi);

    // Count containers and overloads
    const containerCount = detections.filter(d => d.class === 'Container').length;
    const overloadCount = detections.filter(d => d.class === 'Sampah_Overload').length;
    const overloaded = isOverloaded(detections);

    // Save detection to database if cctv_id provided
    if (cctv_id) {
      const detectionId = uuidv4();
      runQuery(`
        INSERT INTO detections (id, cctv_id, detections_json, container_count, overload_count, is_overloaded)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [
        detectionId,
        cctv_id,
        JSON.stringify(detections),
        containerCount,
        overloadCount,
        overloaded ? 1 : 0
      ]);
    }

    res.json({
      success: true,
      data: {
        detections,
        containerCount,
        overloadCount,
        isOverloaded: overloaded,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Detection error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get detection history for a CCTV
app.get('/api/detections/:cctv_id', (req, res) => {
  try {
    const { cctv_id } = req.params;
    const { limit = 50 } = req.query;

    const detections = queryAll(`
      SELECT * FROM detections 
      WHERE cctv_id = ? 
      ORDER BY frame_timestamp DESC 
      LIMIT ?
    `, [cctv_id, limit]);

    // Parse JSON detections
    const parsed = detections.map(d => ({
      ...d,
      detections: JSON.parse(d.detections_json),
      is_overloaded: d.is_overloaded === 1
    }));

    res.json({ success: true, data: parsed });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get latest detection for a CCTV
app.get('/api/detections/:cctv_id/latest', (req, res) => {
  try {
    const { cctv_id } = req.params;

    const detection = queryOne(`
      SELECT * FROM detections 
      WHERE cctv_id = ? 
      ORDER BY frame_timestamp DESC 
      LIMIT 1
    `, [cctv_id]);

    if (!detection) {
      return res.status(404).json({ success: false, error: 'No detection found' });
    }

    const parsed = {
      ...detection,
      detections: JSON.parse(detection.detections_json),
      is_overloaded: detection.is_overloaded === 1
    };

    res.json({ success: true, data: parsed });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ ROI (Region of Interest) API ============

// GET ROI for a CCTV
app.get('/api/roi/:cctv_id', (req, res) => {
  try {
    const { cctv_id } = req.params;

    const roi = queryOne('SELECT * FROM detection_roi WHERE cctv_id = ?', [cctv_id]);

    if (!roi) {
      // Return default (no ROI = full frame)
      return res.json({
        success: true,
        data: {
          cctv_id,
          roi: null,
          enabled: false
        }
      });
    }

    res.json({
      success: true,
      data: {
        ...roi,
        roi: JSON.parse(roi.roi_json),
        enabled: roi.enabled === 1
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST/PUT ROI for a CCTV (requires auth for write operations)
app.post('/api/roi/:cctv_id', (req, res) => {
  try {
    const { cctv_id } = req.params;
    const { roi, enabled = true } = req.body;

    console.log('ROI save request:', { cctv_id, roi, enabled });

    // Validate ROI data
    if (!roi || typeof roi !== 'object') {
      console.error('Invalid ROI: not an object', roi);
      return res.status(400).json({ success: false, error: 'ROI data is required' });
    }

    if (typeof roi.x !== 'number' || typeof roi.y !== 'number' ||
      typeof roi.width !== 'number' || typeof roi.height !== 'number') {
      console.error('Invalid ROI format:', roi);
      return res.status(400).json({
        success: false,
        error: 'Invalid ROI format. Expected: {x, y, width, height} as numbers'
      });
    }

    // Verify CCTV exists
    const cctv = queryOne('SELECT * FROM cctv WHERE id = ?', [cctv_id]);
    if (!cctv) {
      console.error('CCTV not found:', cctv_id);
      return res.status(404).json({ success: false, error: 'CCTV tidak ditemukan' });
    }

    // Check if ROI exists
    const existing = queryOne('SELECT * FROM detection_roi WHERE cctv_id = ?', [cctv_id]);

    try {
      const roiJson = JSON.stringify(roi);
      console.log('Saving ROI JSON:', roiJson);

      if (existing) {
        // Update existing ROI
        console.log('Updating existing ROI');
        runQuery(`
          UPDATE detection_roi 
          SET roi_json = ?, enabled = ?, updated_at = datetime('now')
          WHERE cctv_id = ?
        `, [
          roiJson,
          enabled ? 1 : 0,
          cctv_id
        ]);
      } else {
        // Create new ROI
        const roiId = uuidv4();
        console.log('Creating new ROI:', roiId);
        runQuery(`
          INSERT INTO detection_roi (id, cctv_id, roi_json, enabled)
          VALUES (?, ?, ?, ?)
        `, [
          roiId,
          cctv_id,
          roiJson,
          enabled ? 1 : 0
        ]);
      }

      // Verify save by querying
      const updated = queryOne('SELECT * FROM detection_roi WHERE cctv_id = ?', [cctv_id]);
      if (!updated) {
        console.error('Failed to retrieve saved ROI');
        return res.status(500).json({ success: false, error: 'Failed to save ROI' });
      }

      console.log('ROI saved successfully:', updated.id);

      res.json({
        success: true,
        data: {
          ...updated,
          roi: JSON.parse(updated.roi_json),
          enabled: updated.enabled === 1
        }
      });
    } catch (dbError) {
      console.error('Database error saving ROI:', dbError);
      return res.status(500).json({ success: false, error: 'Database error: ' + dbError.message });
    }
  } catch (error) {
    console.error('Error saving ROI:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE ROI for a CCTV (requires auth for delete operations)
app.delete('/api/roi/:cctv_id', (req, res) => {
  try {
    const { cctv_id } = req.params;

    const existing = queryOne('SELECT * FROM detection_roi WHERE cctv_id = ?', [cctv_id]);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'ROI tidak ditemukan' });
    }

    runQuery('DELETE FROM detection_roi WHERE cctv_id = ?', [cctv_id]);
    res.json({ success: true, message: 'ROI berhasil dihapus' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ CRUD API for Trash Bins (Bak Sampah) ============

// GET all trash bins
app.get('/api/trash-bins', (req, res) => {
  try {
    const trashBins = queryAll(`
      SELECT 
        tb.*,
        k.nama as kecamatan_nama_full,
        kel.nama as kelurahan_nama_full
      FROM trash_bins tb
      LEFT JOIN kecamatan k ON tb.kecamatan_id = k.id
      LEFT JOIN kelurahan kel ON tb.kelurahan_id = kel.id
      ORDER BY tb.created_at DESC
    `);
    res.json({ success: true, data: trashBins });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET single trash bin by ID
app.get('/api/trash-bins/:id', (req, res) => {
  try {
    const trashBin = queryOne(`
      SELECT 
        tb.*,
        k.nama as kecamatan_nama_full,
        kel.nama as kelurahan_nama_full
      FROM trash_bins tb
      LEFT JOIN kecamatan k ON tb.kecamatan_id = k.id
      LEFT JOIN kelurahan kel ON tb.kelurahan_id = kel.id
      WHERE tb.id = ?
    `, [req.params.id]);

    if (!trashBin) {
      return res.status(404).json({ success: false, error: 'Bak sampah tidak ditemukan' });
    }
    res.json({ success: true, data: trashBin });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// CREATE trash bin (protected - admin only)
app.post('/api/trash-bins', authMiddleware, (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Akses ditolak. Hanya admin yang bisa menambah bak sampah.' });
    }

    const { kode, nama, latitude, longitude, kecamatan_id, kelurahan_id, status, description } = req.body;

    if (!kode || !nama || !latitude || !longitude) {
      return res.status(400).json({
        success: false,
        error: 'Kode, nama, latitude, dan longitude harus diisi'
      });
    }

    // Check if kode already exists
    const existing = queryOne('SELECT id FROM trash_bins WHERE kode = ?', [kode]);
    if (existing) {
      return res.status(400).json({ success: false, error: 'Kode bak sampah sudah digunakan' });
    }

    // Get kecamatan and kelurahan names if IDs provided
    let kecamatanNama = null;
    let kelurahanNama = null;

    if (kecamatan_id) {
      const kecamatan = queryOne('SELECT nama FROM kecamatan WHERE id = ?', [kecamatan_id]);
      if (kecamatan) {
        kecamatanNama = kecamatan.nama;
      }
    }

    if (kelurahan_id) {
      const kelurahan = queryOne('SELECT nama FROM kelurahan WHERE id = ?', [kelurahan_id]);
      if (kelurahan) {
        kelurahanNama = kelurahan.nama;
      }
    }

    const id = uuidv4();

    runQuery(`
      INSERT INTO trash_bins (id, kode, nama, latitude, longitude, kecamatan_id, kecamatan_nama, kelurahan_id, kelurahan_nama, status, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      id,
      kode,
      nama,
      latitude,
      longitude,
      kecamatan_id || null,
      kecamatanNama || null,
      kelurahan_id || null,
      kelurahanNama || null,
      status || 'active',
      description || ''
    ]);

    const newTrashBin = queryOne('SELECT * FROM trash_bins WHERE id = ?', [id]);
    res.status(201).json({ success: true, data: newTrashBin });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// UPDATE trash bin (protected - admin only)
app.put('/api/trash-bins/:id', authMiddleware, (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Akses ditolak. Hanya admin yang bisa mengubah bak sampah.' });
    }

    const { kode, nama, latitude, longitude, kecamatan_id, kelurahan_id, status, description } = req.body;
    const { id } = req.params;

    const existing = queryOne('SELECT * FROM trash_bins WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Bak sampah tidak ditemukan' });
    }

    // Check if new kode is taken by another trash bin
    if (kode && kode !== existing.kode) {
      const kodeCheck = queryOne('SELECT id FROM trash_bins WHERE kode = ? AND id != ?', [kode, id]);
      if (kodeCheck) {
        return res.status(400).json({ success: false, error: 'Kode bak sampah sudah digunakan' });
      }
    }

    // Get kecamatan and kelurahan names if IDs provided
    let kecamatanNama = existing.kecamatan_nama;
    let kelurahanNama = existing.kelurahan_nama;

    if (kecamatan_id !== undefined) {
      if (kecamatan_id) {
        const kecamatan = queryOne('SELECT nama FROM kecamatan WHERE id = ?', [kecamatan_id]);
        kecamatanNama = kecamatan ? kecamatan.nama : null;
      } else {
        kecamatanNama = null;
      }
    }

    if (kelurahan_id !== undefined) {
      if (kelurahan_id) {
        const kelurahan = queryOne('SELECT nama FROM kelurahan WHERE id = ?', [kelurahan_id]);
        kelurahanNama = kelurahan ? kelurahan.nama : null;
      } else {
        kelurahanNama = null;
      }
    }

    // Build update query
    let updateFields = [];
    let params = [];

    if (kode) { updateFields.push('kode = ?'); params.push(kode); }
    if (nama) { updateFields.push('nama = ?'); params.push(nama); }
    if (latitude !== undefined) { updateFields.push('latitude = ?'); params.push(latitude); }
    if (longitude !== undefined) { updateFields.push('longitude = ?'); params.push(longitude); }
    if (kecamatan_id !== undefined) {
      updateFields.push('kecamatan_id = ?');
      params.push(kecamatan_id || null);
      updateFields.push('kecamatan_nama = ?');
      params.push(kecamatanNama);
    }
    if (kelurahan_id !== undefined) {
      updateFields.push('kelurahan_id = ?');
      params.push(kelurahan_id || null);
      updateFields.push('kelurahan_nama = ?');
      params.push(kelurahanNama);
    }
    if (status) { updateFields.push('status = ?'); params.push(status); }
    if (description !== undefined) { updateFields.push('description = ?'); params.push(description); }

    updateFields.push("updated_at = datetime('now')");
    params.push(id);

    runQuery(`UPDATE trash_bins SET ${updateFields.join(', ')} WHERE id = ?`, params);

    const updatedTrashBin = queryOne('SELECT * FROM trash_bins WHERE id = ?', [id]);
    res.json({ success: true, data: updatedTrashBin });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE trash bin (protected - admin only)
app.delete('/api/trash-bins/:id', authMiddleware, (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Akses ditolak. Hanya admin yang bisa menghapus bak sampah.' });
    }

    const { id } = req.params;

    const existing = queryOne('SELECT * FROM trash_bins WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Bak sampah tidak ditemukan' });
    }

    runQuery('DELETE FROM trash_bins WHERE id = ?', [id]);
    res.json({ success: true, message: 'Bak sampah berhasil dihapus' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ Layer Settings API ============

// GET all layer settings
app.get('/api/layer-settings', (req, res) => {
  try {
    const settings = queryAll('SELECT * FROM layer_settings ORDER BY layer_type');
    res.json({
      success: true,
      data: settings.map(s => ({
        ...s,
        fill_opacity: s.fill_opacity,
        stroke_opacity: s.stroke_opacity,
        enabled: s.enabled === 1
      }))
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET layer setting by type
app.get('/api/layer-settings/:layer_type', (req, res) => {
  try {
    const { layer_type } = req.params;
    const setting = queryOne('SELECT * FROM layer_settings WHERE layer_type = ?', [layer_type]);

    if (!setting) {
      return res.status(404).json({ success: false, error: 'Pengaturan layer tidak ditemukan' });
    }

    res.json({
      success: true,
      data: {
        ...setting,
        fill_opacity: setting.fill_opacity,
        stroke_opacity: setting.stroke_opacity,
        enabled: setting.enabled === 1
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// PUT update layer settings (requires auth)
app.put('/api/layer-settings/:layer_type', authMiddleware, (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Akses ditolak. Hanya admin yang bisa mengubah pengaturan layer.' });
    }

    const { layer_type } = req.params;
    const { fill_opacity, stroke_opacity, enabled } = req.body;

    // Validate layer_type
    if (layer_type !== 'kecamatan' && layer_type !== 'kelurahan') {
      return res.status(400).json({ success: false, error: 'Layer type harus "kecamatan" atau "kelurahan"' });
    }

    // Validate opacity values (0-1)
    if (fill_opacity !== undefined && (fill_opacity < 0 || fill_opacity > 1)) {
      return res.status(400).json({ success: false, error: 'fill_opacity harus antara 0 dan 1' });
    }

    if (stroke_opacity !== undefined && (stroke_opacity < 0 || stroke_opacity > 1)) {
      return res.status(400).json({ success: false, error: 'stroke_opacity harus antara 0 dan 1' });
    }

    // Check if setting exists
    const existing = queryOne('SELECT * FROM layer_settings WHERE layer_type = ?', [layer_type]);

    if (existing) {
      // Update existing
      const updateFields = [];
      const updateValues = [];

      if (fill_opacity !== undefined) {
        updateFields.push('fill_opacity = ?');
        updateValues.push(fill_opacity);
      }

      if (stroke_opacity !== undefined) {
        updateFields.push('stroke_opacity = ?');
        updateValues.push(stroke_opacity);
      }

      if (enabled !== undefined) {
        updateFields.push('enabled = ?');
        updateValues.push(enabled ? 1 : 0);
      }

      updateFields.push('updated_at = datetime(\'now\')');
      updateValues.push(layer_type);

      runQuery(`
        UPDATE layer_settings 
        SET ${updateFields.join(', ')}
        WHERE layer_type = ?
      `, updateValues);
    } else {
      // Create new setting
      const settingId = `layer-${layer_type}`;
      runQuery(`
        INSERT INTO layer_settings (id, layer_type, fill_opacity, stroke_opacity, enabled)
        VALUES (?, ?, ?, ?, ?)
      `, [
        settingId,
        layer_type,
        fill_opacity !== undefined ? fill_opacity : (layer_type === 'kecamatan' ? 0.15 : 0.25),
        stroke_opacity !== undefined ? stroke_opacity : (layer_type === 'kecamatan' ? 0.9 : 0.85),
        enabled !== undefined ? (enabled ? 1 : 0) : 1
      ]);
    }

    // Return updated setting
    const updated = queryOne('SELECT * FROM layer_settings WHERE layer_type = ?', [layer_type]);
    res.json({
      success: true,
      data: {
        ...updated,
        fill_opacity: updated.fill_opacity,
        stroke_opacity: updated.stroke_opacity,
        enabled: updated.enabled === 1
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ RTSP Streaming via WebSocket ============

// Start RTSP stream endpoint
app.post('/api/stream/start/:id', (req, res) => {
  try {
    const { id } = req.params;
    const cctv = queryOne('SELECT * FROM cctv WHERE id = ?', [id]);

    if (!cctv) {
      return res.status(404).json({ success: false, error: 'CCTV tidak ditemukan' });
    }

    res.json({
      success: true,
      message: 'Stream ready',
      wsUrl: `ws://localhost:3000/stream/${id}`,
      cctv: cctv
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// WebSocket connection handler for RTSP streaming
wss.on('connection', (ws, req) => {
  const urlParts = req.url.split('/');
  const cctvId = urlParts[urlParts.length - 1];

  console.log(`WebSocket connection for CCTV: ${cctvId}`);

  const cctv = queryOne('SELECT * FROM cctv WHERE id = ?', [cctvId]);

  if (!cctv) {
    ws.close(1008, 'CCTV not found');
    return;
  }

  // Load ROI settings for this CCTV
  const roiData = queryOne('SELECT * FROM detection_roi WHERE cctv_id = ? AND enabled = 1', [cctvId]);
  const roi = roiData ? JSON.parse(roiData.roi_json) : null;

  // Validate RTSP URL
  if (!cctv.rtsp_url || cctv.rtsp_url === '#' || !cctv.rtsp_url.startsWith('rtsp://')) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'RTSP URL tidak valid atau tidak dikonfigurasi'
    }));
    ws.close();
    return;
  }

  // Start FFmpeg process to convert RTSP to MJPEG
  const ffmpeg = spawn('ffmpeg', [
    '-rtsp_transport', 'tcp',
    '-rtsp_flags', 'prefer_tcp',
    '-i', cctv.rtsp_url,
    '-f', 'mjpeg',
    '-q:v', '5',
    '-r', '15',
    '-update', '1',
    '-'
  ], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let imageBuffer = Buffer.alloc(0);
  const SOI = Buffer.from([0xff, 0xd8]); // JPEG Start
  const EOI = Buffer.from([0xff, 0xd9]); // JPEG End

  // Detection state
  let frameCount = 0;
  const DETECTION_INTERVAL = 30; // Detect every 30 frames (2 seconds at 15fps)
  let aiEnabled = false; // Default off until toggle

  // Handle messages from client
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'toggle_ai') {
        aiEnabled = data.enabled;
        console.log(`AI Detection for ${cctvId} set to: ${aiEnabled}`);
      }
    } catch (e) {
      console.error('Error parsing message from client:', e);
    }
  });

  ffmpeg.stdout.on('data', async (data) => {
    imageBuffer = Buffer.concat([imageBuffer, data]);

    // Find complete JPEG frames
    let soiIndex = imageBuffer.indexOf(SOI);
    let eoiIndex = imageBuffer.indexOf(EOI);

    while (soiIndex !== -1 && eoiIndex !== -1 && eoiIndex > soiIndex) {
      const frame = imageBuffer.slice(soiIndex, eoiIndex + 2);

      if (ws.readyState === WebSocket.OPEN) {
        // Send as base64 encoded image
        const base64Frame = frame.toString('base64');
        ws.send(JSON.stringify({ type: 'frame', data: base64Frame }));

        // Run detection every N frames IF enabled
        frameCount++;
        if (frameCount % DETECTION_INTERVAL === 0 && aiEnabled) {
          try {
            // Use ROI if available
            const detections = await detectFromBase64(`data:image/jpeg;base64,${base64Frame}`, roi);
            const containerCount = detections.filter(d => d.class === 'Container').length;
            const overloadCount = detections.filter(d => d.class === 'Sampah_Overload').length;
            const overloaded = isOverloaded(detections);

            // Send detection results
            ws.send(JSON.stringify({
              type: 'detection',
              data: {
                detections,
                containerCount,
                overloadCount,
                isOverloaded: overloaded,
                timestamp: new Date().toISOString()
              }
            }));

            // Save to database
            if (detections.length > 0) {
              const detectionId = uuidv4();
              runQuery(`
                INSERT INTO detections (id, cctv_id, detections_json, container_count, overload_count, is_overloaded)
                VALUES (?, ?, ?, ?, ?, ?)
              `, [
                detectionId,
                cctvId,
                JSON.stringify(detections),
                containerCount,
                overloadCount,
                overloaded ? 1 : 0
              ]);
            }
          } catch (error) {
            console.error('Detection error:', error);
            // Don't block stream on detection errors
          }
        }
      }

      imageBuffer = imageBuffer.slice(eoiIndex + 2);
      soiIndex = imageBuffer.indexOf(SOI);
      eoiIndex = imageBuffer.indexOf(EOI);
    }
  });

  // Track if we've sent an error to avoid spam
  let errorSent = false;

  ffmpeg.stderr.on('data', (data) => {
    // FFmpeg logs to stderr
    const message = data.toString();

    // Check for critical errors
    if (message.includes('Error opening input') ||
      message.includes('Network is unreachable') ||
      message.includes('Connection refused') ||
      message.includes('No route to host')) {

      if (!errorSent && ws.readyState === WebSocket.OPEN) {
        errorSent = true;
        let userMessage = 'Gagal menghubungkan ke RTSP stream';

        if (message.includes('Network is unreachable')) {
          userMessage = 'Network tidak dapat dijangkau. Periksa koneksi jaringan atau IP address RTSP.';
        } else if (message.includes('Connection refused')) {
          userMessage = 'Koneksi ditolak. Periksa apakah RTSP server aktif dan port benar.';
        } else if (message.includes('No route to host')) {
          userMessage = 'Tidak ada route ke host. Periksa IP address dan koneksi jaringan.';
        }

        console.error(`FFmpeg error for ${cctvId}:`, message);
        ws.send(JSON.stringify({
          type: 'error',
          message: userMessage,
          details: message.substring(0, 200)
        }));
      }
    } else if (message.includes('error') || message.includes('Error')) {
      console.error(`FFmpeg error for ${cctvId}:`, message);
    }
  });

  ffmpeg.on('close', (code) => {
    console.log(`FFmpeg process closed with code ${code} for CCTV: ${cctvId}`);

    if (code !== 0 && code !== null && !errorSent) {
      // Non-zero exit code means error
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'error',
          message: `FFmpeg process terminated dengan code ${code}. Periksa RTSP URL dan koneksi.`
        }));
      }
    }

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'closed', message: 'Stream ended' }));
      ws.close();
    }

    activeStreams.delete(cctvId);
  });

  ffmpeg.on('error', (err) => {
    console.error(`FFmpeg spawn error for ${cctvId}:`, err);
    if (ws.readyState === WebSocket.OPEN && !errorSent) {
      errorSent = true;
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Gagal memulai FFmpeg. Pastikan FFmpeg terinstall dan dapat diakses.'
      }));
      ws.close();
    }
    activeStreams.delete(cctvId);
  });

  // Store reference
  activeStreams.set(cctvId, { ffmpeg, ws });

  ws.on('close', () => {
    console.log(`WebSocket closed for CCTV: ${cctvId}`);
    if (ffmpeg && !ffmpeg.killed) {
      ffmpeg.kill('SIGTERM');
    }
    activeStreams.delete(cctvId);
  });

  ws.on('error', (err) => {
    console.error(`WebSocket error for ${cctvId}:`, err.message);
    if (ffmpeg && !ffmpeg.killed) {
      ffmpeg.kill('SIGTERM');
    }
    activeStreams.delete(cctvId);
  });
});

// ============ Server Startup ============

const PORT = process.env.PORT || 3008;

/**
 * Check if FFmpeg is installed and accessible
 * @returns {Promise<boolean>}
 */
function checkFfmpeg() {
  return new Promise((resolve) => {
    const ffmpeg = spawn('ffmpeg', ['-version']);

    ffmpeg.on('error', (err) => {
      console.error('❌ FFmpeg NOT FOUND:', err.message);
      resolve(false);
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        console.log('✅ FFmpeg is installed and accessible');
        resolve(true);
      } else {
        console.error(`❌ FFmpeg exited with code ${code}`);
        resolve(false);
      }
    });
  });
}

async function startServer() {
  try {
    await initDatabase();
    console.log('Database initialized');

    // Initialize AI detection model
    try {
      await initDetectionModel();
      console.log('AI Detection model initialized');
    } catch (error) {
      console.warn('Warning: AI Detection model failed to initialize:', error.message);
      console.warn('Detection features will be disabled');
    }

    // Check FFmpeg
    const ffmpegAvailable = await checkFfmpeg();
    if (!ffmpegAvailable) {
      console.error('CRITICAL: FFmpeg is required for RTSP streaming.');
      console.error('Please install FFmpeg:');
      console.error('  Ubuntu/Debian: sudo apt update && sudo apt install -y ffmpeg');
      console.error('  CentOS/RHEL: sudo yum install ffmpeg');
      console.error('  macOS: brew install ffmpeg');
    }

    server.listen(PORT, () => {
      console.log(`
╔═══════════════════════════════════════════════════════════════════╗
║                                                                   ║
║   🎥 CCTV Kabupaten Konawe - Monitoring System                   ║
║                                                                   ║
║   Server    : http://localhost:${PORT}                              ║
║   Admin     : http://localhost:${PORT}/admin.html                   ║
║   API       : http://localhost:${PORT}/api/cctv                     ║
║                                                                   ║
║   📋 Admin Credentials:                                           ║
║      Username: admin    | Password: admin123                      ║
║      Username: operator | Password: operator123                   ║
║                                                                   ║
║   ⚠️  FFmpeg required for RTSP streaming                          ║
║      macOS: brew install ffmpeg                                   ║
║      Linux: sudo apt install ffmpeg                               ║
║                                                                   ║
╚═══════════════════════════════════════════════════════════════════╝
      `);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down...');

  // Stop all active streams
  for (const [id, stream] of activeStreams) {
    if (stream.ffmpeg && !stream.ffmpeg.killed) {
      stream.ffmpeg.kill('SIGTERM');
    }
  }

  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

startServer();
