# Docker Deployment Guide

Panduan untuk deploy aplikasi WebGIS CCTV ke VPS menggunakan Docker.

## Prerequisites

- Docker (versi 20.10 atau lebih baru)
- Docker Compose (versi 1.29 atau lebih baru)
- VPS dengan minimal 2GB RAM dan 10GB storage

## Quick Start

### 1. Clone atau Upload Project ke VPS

```bash
# Jika menggunakan git
git clone <repository-url>
cd rtsp

# Atau upload file via SCP/SFTP
```

### 1a. Install Dependencies (Non-Docker)

Jika tidak menggunakan Docker, jalankan script berikut untuk menginstal FFmpeg dan library lainnya:

```bash
chmod +x install_dependencies.sh
./install_dependencies.sh
```

### 2. Build dan Run dengan Docker Compose

```bash
# Build dan start container
docker-compose up -d

# Lihat logs
docker-compose logs -f

# Stop container
docker-compose down

# Rebuild setelah perubahan
docker-compose up -d --build
```

### 3. Akses Aplikasi

- Frontend: `http://your-vps-ip:3008`
- Admin Panel: `http://your-vps-ip:3008/admin.html`
- API: `http://your-vps-ip:3008/api/cctv`

## Manual Docker Build

Jika tidak menggunakan docker-compose:

```bash
# Build image
docker build -t webgis-cctv:latest .

# Run container
docker run -d \
  --name webgis-cctv \
  -p 3008:3008 \
  -v $(pwd)/data:/app/data \
  --restart unless-stopped \
  webgis-cctv:latest

# Lihat logs
docker logs -f webgis-cctv

# Stop container
docker stop webgis-cctv

# Remove container
docker rm webgis-cctv
```

## Environment Variables

Copy `.env.example` ke `.env` dan sesuaikan:

```bash
cp .env.example .env
nano .env
```

Variabel yang bisa dikonfigurasi:
- `PORT`: Port aplikasi (default: 3008)
- `NODE_ENV`: Environment (production/development)

## Volume Mounts

### Database Persistence

Database SQLite akan disimpan di `./data/cctv.db`. Pastikan folder `data` ada:

```bash
mkdir -p data
chmod 755 data
```

### Custom YOLO Model

Jika menggunakan custom YOLO model, letakkan di root project:
- `trash_detection.pt` - Custom model untuk deteksi sampah
- `yolov8n.pt` - Model default (akan di-download otomatis jika tidak ada)

## Production Deployment

### 1. Setup Nginx Reverse Proxy (Recommended)

Install Nginx di VPS:

```bash
sudo apt update
sudo apt install nginx
```

Buat konfigurasi Nginx:

```nginx
# /etc/nginx/sites-available/webgis-cctv
server {
    listen 80;
    server_name your-domain.com;

    # IMPORTANT: Increase client body size limit for GeoJSON uploads
    client_max_body_size 50M;

    location / {
        proxy_pass http://localhost:3008;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }

    # WebSocket support untuk RTSP streaming
    location /stream {
        proxy_pass http://localhost:3008;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400;
    }
}
```

Enable dan restart Nginx:

```bash
sudo ln -s /etc/nginx/sites-available/webgis-cctv /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

### 2. Setup SSL dengan Let's Encrypt

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

### 3. Firewall Configuration

```bash
# Allow port 80, 443, dan 3008
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 3008/tcp
sudo ufw enable
```

## Monitoring dan Maintenance

### View Logs

```bash
# Docker Compose
docker-compose logs -f webgis-cctv

# Docker
docker logs -f webgis-cctv

# Last 100 lines
docker logs --tail 100 webgis-cctv
```

### Backup Database

```bash
# Backup database
docker exec webgis-cctv cp /app/cctv.db /app/data/cctv.db.backup.$(date +%Y%m%d_%H%M%S)

# Atau dari host
cp data/cctv.db data/cctv.db.backup.$(date +%Y%m%d_%H%M%S)
```

### Update Application

```bash
# Pull latest code
git pull

# Rebuild dan restart
docker-compose up -d --build

# Atau manual
docker build -t webgis-cctv:latest .
docker-compose restart
```

### Check Container Status

```bash
# List containers
docker ps

# Check resource usage
docker stats webgis-cctv

# Inspect container
docker inspect webgis-cctv
```

## Troubleshooting

### Container tidak start

```bash
# Check logs
docker-compose logs webgis-cctv

# Check container status
docker ps -a

# Restart container
docker-compose restart
```

### Port sudah digunakan

```bash
# Check port usage
sudo lsof -i :3008

# Kill process atau ubah port di docker-compose.yml
```

### Coolify / Nixpacks Deployment

Jika Anda menggunakan Coolify dan mendapatkan eror "FFmpeg NOT FOUND", pastikan:
1. File `nixpacks.toml` ada di root project.
2. Jika masih eror, ubah **Build Pack** di setting Coolify dari **Nixpacks** ke **Docker**.

### Database error

```bash
# Check database file permissions
ls -la data/cctv.db

# Recreate database (HATI-HATI: akan menghapus data)
docker-compose down
rm data/cctv.db
docker-compose up -d
```

### YOLO detection tidak bekerja

```bash
# Check Python dependencies
docker exec webgis-cctv python3 -c "import ultralytics; print('OK')"

# Reinstall Python dependencies
docker exec webgis-cctv pip3 install -r requirements.txt
```

### FFmpeg error

```bash
# Check FFmpeg installation
docker exec webgis-cctv ffmpeg -version

# Test RTSP connection
docker exec webgis-cctv ffmpeg -rtsp_transport tcp -i rtsp://test-url -f image2 -vframes 1 test.jpg
```

## Performance Optimization

### Resource Limits

Edit `docker-compose.yml`:

```yaml
services:
  webgis-cctv:
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 2G
        reservations:
          cpus: '1'
          memory: 1G
```

### Database Optimization

SQLite database akan otomatis dioptimasi. Untuk database besar, pertimbangkan migrasi ke PostgreSQL.

## Security Considerations

1. **Firewall**: Hanya buka port yang diperlukan
2. **SSL/TLS**: Selalu gunakan HTTPS di production
3. **Environment Variables**: Jangan commit `.env` file
4. **Database Backup**: Backup database secara berkala
5. **Update Dependencies**: Update secara berkala untuk security patches

## Support

Untuk masalah atau pertanyaan, silakan buka issue di repository atau hubungi administrator.

