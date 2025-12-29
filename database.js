const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

// Use data directory for Docker volume persistence
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
const DB_PATH = path.join(DATA_DIR, 'cctv.db');

let db = null;

async function initDatabase() {
  const SQL = await initSqlJs();
  
  // Load existing database or create new one
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  // Create CCTV table
  db.run(`
    CREATE TABLE IF NOT EXISTS cctv (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      rtsp_url TEXT NOT NULL,
      location TEXT,
      status TEXT DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create Kecamatan (Sub-district) boundaries table
  db.run(`
    CREATE TABLE IF NOT EXISTS kecamatan (
      id TEXT PRIMARY KEY,
      kode TEXT UNIQUE,
      nama TEXT NOT NULL,
      kabupaten TEXT DEFAULT 'Konawe',
      provinsi TEXT DEFAULT 'Sulawesi Tenggara',
      luas REAL,
      warna TEXT DEFAULT '#fbbf24',
      geojson TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create Kelurahan/Desa (Village) boundaries table
  db.run(`
    CREATE TABLE IF NOT EXISTS kelurahan (
      id TEXT PRIMARY KEY,
      kode TEXT UNIQUE,
      nama TEXT NOT NULL,
      kecamatan_id TEXT,
      kecamatan_nama TEXT,
      jenis TEXT DEFAULT 'kelurahan',
      luas REAL,
      warna TEXT DEFAULT '#22c55e',
      geojson TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (kecamatan_id) REFERENCES kecamatan(id)
    )
  `);

  // Create Users table
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      nama TEXT NOT NULL,
      email TEXT,
      role TEXT DEFAULT 'operator',
      status TEXT DEFAULT 'active',
      last_login DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create Detections table for AI detection results
  db.run(`
    CREATE TABLE IF NOT EXISTS detections (
      id TEXT PRIMARY KEY,
      cctv_id TEXT NOT NULL,
      frame_timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      detections_json TEXT NOT NULL,
      container_count INTEGER DEFAULT 0,
      overload_count INTEGER DEFAULT 0,
      is_overloaded BOOLEAN DEFAULT 0,
      image_path TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (cctv_id) REFERENCES cctv(id)
    )
  `);

  // Create index for faster queries
  db.run(`CREATE INDEX IF NOT EXISTS idx_detections_cctv_id ON detections(cctv_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_detections_timestamp ON detections(frame_timestamp)`);

  // Create ROI (Region of Interest) table for detection area settings
  db.run(`
    CREATE TABLE IF NOT EXISTS detection_roi (
      id TEXT PRIMARY KEY,
      cctv_id TEXT NOT NULL UNIQUE,
      roi_json TEXT NOT NULL,
      enabled BOOLEAN DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (cctv_id) REFERENCES cctv(id) ON DELETE CASCADE
    )
  `);

  // Create index for ROI
  db.run(`CREATE INDEX IF NOT EXISTS idx_roi_cctv_id ON detection_roi(cctv_id)`);

  // Create Trash Bins (Bak Sampah) table
  db.run(`
    CREATE TABLE IF NOT EXISTS trash_bins (
      id TEXT PRIMARY KEY,
      kode TEXT UNIQUE NOT NULL,
      nama TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      kecamatan_id TEXT,
      kecamatan_nama TEXT,
      kelurahan_id TEXT,
      kelurahan_nama TEXT,
      status TEXT DEFAULT 'active',
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (kecamatan_id) REFERENCES kecamatan(id),
      FOREIGN KEY (kelurahan_id) REFERENCES kelurahan(id)
    )
  `);

  // Create index for trash bins
  db.run(`CREATE INDEX IF NOT EXISTS idx_trash_bins_kecamatan ON trash_bins(kecamatan_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_trash_bins_kelurahan ON trash_bins(kelurahan_id)`);

  // Create Layer Settings table for transparency settings
  db.run(`
    CREATE TABLE IF NOT EXISTS layer_settings (
      id TEXT PRIMARY KEY,
      layer_type TEXT NOT NULL UNIQUE,
      fill_opacity REAL DEFAULT 0.15,
      stroke_opacity REAL DEFAULT 0.9,
      enabled BOOLEAN DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Insert default layer settings if not exists
  const layerSettingsCount = db.exec('SELECT COUNT(*) FROM layer_settings');
  if ((layerSettingsCount[0]?.values[0][0] || 0) === 0) {
    insertDefaultLayerSettings();
  }

  // Insert default users if not exists
  const userCount = db.exec('SELECT COUNT(*) FROM users');
  if ((userCount[0]?.values[0][0] || 0) === 0) {
    insertDefaultUsers();
  }

  // Insert sample kecamatan data if not exists
  const kecCount = db.exec('SELECT COUNT(*) FROM kecamatan');
  if ((kecCount[0]?.values[0][0] || 0) === 0) {
    insertSampleKecamatan();
  }

  // Insert sample kelurahan data if not exists
  const kelCount = db.exec('SELECT COUNT(*) FROM kelurahan');
  if ((kelCount[0]?.values[0][0] || 0) === 0) {
    insertSampleKelurahan();
  }

  saveDatabase();
  return db;
}

// Insert default users
function insertDefaultUsers() {
  const crypto = require('crypto');
  
  function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
  }

  const defaultUsers = [
    {
      id: 'user-001',
      username: 'admin',
      password: hashPassword('admin123'),
      nama: 'Administrator',
      email: 'admin@konawe.go.id',
      role: 'admin',
      status: 'active'
    },
    {
      id: 'user-002',
      username: 'operator',
      password: hashPassword('operator123'),
      nama: 'Operator CCTV',
      email: 'operator@konawe.go.id',
      role: 'operator',
      status: 'active'
    }
  ];

  const stmt = db.prepare(`
    INSERT INTO users (id, username, password, nama, email, role, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  for (const user of defaultUsers) {
    stmt.run([user.id, user.username, user.password, user.nama, user.email, user.role, user.status]);
  }
  stmt.free();
  console.log('Default users inserted');
}

function insertSampleKecamatan() {
  const sampleKecamatan = [
    {
      id: 'kec-001',
      kode: '7402010',
      nama: 'Unaaha',
      luas: 45.5,
      warna: '#fbbf24',
      geojson: JSON.stringify({
        type: "Polygon",
        coordinates: [[
          [122.015, -3.835], [122.055, -3.835], [122.065, -3.845],
          [122.065, -3.870], [122.055, -3.880], [122.015, -3.880],
          [122.005, -3.870], [122.005, -3.845], [122.015, -3.835]
        ]]
      })
    },
    {
      id: 'kec-002',
      kode: '7402020',
      nama: 'Wawotobi',
      luas: 52.3,
      warna: '#3b82f6',
      geojson: JSON.stringify({
        type: "Polygon",
        coordinates: [[
          [122.055, -3.835], [122.095, -3.835], [122.105, -3.845],
          [122.105, -3.870], [122.095, -3.880], [122.055, -3.880],
          [122.065, -3.870], [122.065, -3.845], [122.055, -3.835]
        ]]
      })
    },
    {
      id: 'kec-003',
      kode: '7402030',
      nama: 'Lambuya',
      luas: 38.7,
      warna: '#ef4444',
      geojson: JSON.stringify({
        type: "Polygon",
        coordinates: [[
          [122.005, -3.800], [122.055, -3.800], [122.065, -3.810],
          [122.065, -3.835], [122.055, -3.835], [122.015, -3.835],
          [122.005, -3.845], [121.995, -3.835], [121.995, -3.810],
          [122.005, -3.800]
        ]]
      })
    },
    {
      id: 'kec-004',
      kode: '7402040',
      nama: 'Pondidaha',
      luas: 41.2,
      warna: '#22c55e',
      geojson: JSON.stringify({
        type: "Polygon",
        coordinates: [[
          [122.005, -3.880], [122.055, -3.880], [122.065, -3.890],
          [122.065, -3.915], [122.055, -3.925], [122.005, -3.925],
          [121.995, -3.915], [121.995, -3.890], [122.005, -3.880]
        ]]
      })
    }
  ];

  const stmt = db.prepare(`
    INSERT INTO kecamatan (id, kode, nama, luas, warna, geojson)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (const kec of sampleKecamatan) {
    stmt.run([kec.id, kec.kode, kec.nama, kec.luas, kec.warna, kec.geojson]);
  }
  stmt.free();
  console.log('Sample kecamatan data inserted');
}

function insertSampleKelurahan() {
  const sampleKelurahan = [
    {
      id: 'kel-001',
      kode: '7402010001',
      nama: 'Unaaha',
      kecamatan_id: 'kec-001',
      kecamatan_nama: 'Unaaha',
      jenis: 'kelurahan',
      luas: 12.5,
      warna: '#60a5fa',
      geojson: JSON.stringify({
        type: "Polygon",
        coordinates: [[
          [122.025, -3.845], [122.045, -3.845], [122.050, -3.855],
          [122.050, -3.865], [122.045, -3.870], [122.025, -3.870],
          [122.020, -3.865], [122.020, -3.855], [122.025, -3.845]
        ]]
      })
    },
    {
      id: 'kel-002',
      kode: '7402010002',
      nama: 'Lawolatu',
      kecamatan_id: 'kec-001',
      kecamatan_nama: 'Unaaha',
      jenis: 'kelurahan',
      luas: 8.3,
      warna: '#34d399',
      geojson: JSON.stringify({
        type: "Polygon",
        coordinates: [[
          [122.015, -3.840], [122.025, -3.840], [122.030, -3.845],
          [122.030, -3.855], [122.025, -3.860], [122.015, -3.860],
          [122.010, -3.855], [122.010, -3.845], [122.015, -3.840]
        ]]
      })
    },
    {
      id: 'kel-003',
      kode: '7402010003',
      nama: 'Tuoy',
      kecamatan_id: 'kec-001',
      kecamatan_nama: 'Unaaha',
      jenis: 'desa',
      luas: 15.2,
      warna: '#fbbf24',
      geojson: JSON.stringify({
        type: "Polygon",
        coordinates: [[
          [122.045, -3.840], [122.060, -3.840], [122.065, -3.850],
          [122.065, -3.865], [122.060, -3.870], [122.045, -3.870],
          [122.040, -3.865], [122.040, -3.850], [122.045, -3.840]
        ]]
      })
    },
    {
      id: 'kel-004',
      kode: '7402020001',
      nama: 'Wawotobi',
      kecamatan_id: 'kec-002',
      kecamatan_nama: 'Wawotobi',
      jenis: 'kelurahan',
      luas: 14.8,
      warna: '#a78bfa',
      geojson: JSON.stringify({
        type: "Polygon",
        coordinates: [[
          [122.065, -3.845], [122.085, -3.845], [122.090, -3.855],
          [122.090, -3.865], [122.085, -3.870], [122.065, -3.870],
          [122.060, -3.865], [122.060, -3.855], [122.065, -3.845]
        ]]
      })
    }
  ];

  const stmt = db.prepare(`
    INSERT INTO kelurahan (id, kode, nama, kecamatan_id, kecamatan_nama, jenis, luas, warna, geojson)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const kel of sampleKelurahan) {
    stmt.run([kel.id, kel.kode, kel.nama, kel.kecamatan_id, kel.kecamatan_nama, kel.jenis, kel.luas, kel.warna, kel.geojson]);
  }
  stmt.free();
  console.log('Sample kelurahan data inserted');
}

function insertDefaultLayerSettings() {
  const crypto = require('crypto');
  
  const defaultSettings = [
    {
      id: 'layer-kecamatan',
      layer_type: 'kecamatan',
      fill_opacity: 0.15,
      stroke_opacity: 0.9,
      enabled: 1
    },
    {
      id: 'layer-kelurahan',
      layer_type: 'kelurahan',
      fill_opacity: 0.25,
      stroke_opacity: 0.85,
      enabled: 1
    }
  ];

  const stmt = db.prepare(`
    INSERT INTO layer_settings (id, layer_type, fill_opacity, stroke_opacity, enabled)
    VALUES (?, ?, ?, ?, ?)
  `);

  for (const setting of defaultSettings) {
    stmt.run([setting.id, setting.layer_type, setting.fill_opacity, setting.stroke_opacity, setting.enabled]);
  }
  stmt.free();
  console.log('Default layer settings inserted');
}

function saveDatabase() {
  if (db) {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
  }
}

function getDatabase() {
  return db;
}

module.exports = { initDatabase, getDatabase, saveDatabase };
