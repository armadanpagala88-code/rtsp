# 🐳 Docker Deployment - Quick Start

## Prerequisites

- Docker & Docker Compose terinstall di VPS
- Minimal 2GB RAM dan 10GB storage

## Quick Deploy

```bash
# 1. Upload semua file ke VPS
# 2. Masuk ke direktori project
cd rtsp

# 3. Jalankan script deployment
./deploy.sh
```

## Manual Deploy

```bash
# 1. Buat folder data
mkdir -p data

# 2. Build dan start
docker-compose up -d --build

# 3. Lihat logs
docker-compose logs -f
```

## Akses Aplikasi

- **Frontend**: `http://your-vps-ip:3008`
- **Admin**: `http://your-vps-ip:3008/admin.html`
- **API**: `http://your-vps-ip:3008/api/cctv`

## Commands

```bash
# Start
docker-compose up -d

# Stop
docker-compose down

# Restart
docker-compose restart

# View logs
docker-compose logs -f

# Rebuild
docker-compose up -d --build
```

## Setup Nginx (Optional)

Untuk menggunakan domain dan SSL, setup Nginx reverse proxy. Lihat `DOCKER_DEPLOY.md` untuk detail lengkap.

## Troubleshooting

```bash
# Check container status
docker ps

# Check logs
docker-compose logs webgis-cctv

# Restart container
docker-compose restart
```

Lihat `DOCKER_DEPLOY.md` untuk panduan lengkap deployment ke production.

