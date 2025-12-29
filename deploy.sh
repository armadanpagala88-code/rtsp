#!/bin/bash

# Deployment script untuk WebGIS CCTV
# Usage: ./deploy.sh

set -e

echo "🚀 Starting WebGIS CCTV Deployment..."

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo "❌ Docker is not installed. Please install Docker first."
    exit 1
fi

# Check if Docker Compose is installed
if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
    echo "❌ Docker Compose is not installed. Please install Docker Compose first."
    exit 1
fi

# Create data directory if not exists
echo "📁 Creating data directory..."
mkdir -p data
chmod 755 data

# Create .env file if not exists
if [ ! -f .env ]; then
    echo "📝 Creating .env file..."
    cat > .env << EOF
NODE_ENV=production
PORT=3008
DATA_DIR=/app/data
EOF
    echo "✅ .env file created. Please review and update if needed."
fi

# Stop existing containers
echo "🛑 Stopping existing containers..."
docker-compose down 2>/dev/null || true

# Build and start containers
echo "🔨 Building Docker image..."
docker-compose build

echo "🚀 Starting containers..."
docker-compose up -d

# Wait for container to be healthy
echo "⏳ Waiting for application to start..."
sleep 10

# Check if container is running
if docker ps | grep -q webgis-cctv; then
    echo "✅ Container is running!"
    echo ""
    echo "📊 Container Status:"
    docker ps | grep webgis-cctv
    echo ""
    echo "📋 Application Logs:"
    docker-compose logs --tail 20 webgis-cctv
    echo ""
    echo "✅ Deployment completed successfully!"
    echo ""
    echo "🌐 Access your application:"
    echo "   Frontend: http://$(hostname -I | awk '{print $1}'):3008"
    echo "   Admin:    http://$(hostname -I | awk '{print $1}'):3008/admin.html"
    echo ""
    echo "📝 Useful commands:"
    echo "   View logs:    docker-compose logs -f"
    echo "   Stop:         docker-compose down"
    echo "   Restart:      docker-compose restart"
    echo "   Rebuild:      docker-compose up -d --build"
else
    echo "❌ Container failed to start. Check logs:"
    docker-compose logs webgis-cctv
    exit 1
fi

