#!/bin/bash
# Install all dependencies for WebGIS CCTV Monitoring System

echo "=========================================="
echo "Installing WebGIS CCTV Dependencies"
echo "=========================================="

# 1. Update system and install FFmpeg
echo ""
echo "Step 1: Installing System Dependencies (FFmpeg, Python3)..."
if command -v apt-get &> /dev/null; then
    sudo apt-get update
    sudo apt-get install -y ffmpeg python3 python3-pip python3-venv
elif command -v yum &> /dev/null; then
    sudo yum install -y epel-release
    sudo yum install -y ffmpeg python3 python3-pip
elif command -v brew &> /dev/null; then
    brew install ffmpeg
else
    echo "⚠️  Package manager not detected. Please install FFmpeg manually."
fi

# 2. Install Node.js dependencies
echo ""
echo "Step 2: Installing Node.js dependencies..."
npm install

# 3. Install Python dependencies for YOLO
echo ""
echo "Step 3: Installing Python dependencies (YOLO)..."
if [ -f "requirements.txt" ]; then
    pip3 install --upgrade pip
    pip3 install -r requirements.txt
else
    echo "⚠️  requirements.txt not found. Skipping Python dependencies."
fi

echo ""
echo "=========================================="
echo "✅ All dependencies installed successfully!"
echo "=========================================="
echo "You can now start the server with: npm start"
