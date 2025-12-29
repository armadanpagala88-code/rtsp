#!/bin/bash
# Install YOLO dependencies for trash detection (Latest Version)

echo "=========================================="
echo "Installing YOLO Latest Version Dependencies"
echo "=========================================="
echo ""

# Check if Python 3 is installed
if ! command -v python3 &> /dev/null; then
    echo "❌ Error: Python 3 is not installed. Please install Python 3.8+ first."
    exit 1
fi

# Check Python version
PYTHON_VERSION=$(python3 --version 2>&1 | awk '{print $2}')
echo "✓ Python version: $PYTHON_VERSION"

# Check if pip is installed
if ! command -v pip3 &> /dev/null; then
    echo "❌ Error: pip3 is not installed. Please install pip3 first."
    exit 1
fi

# Upgrade pip first
echo ""
echo "Upgrading pip to latest version..."
pip3 install --upgrade pip

# Install Python dependencies
echo ""
echo "Installing Python packages (this may take a few minutes)..."
pip3 install --upgrade -r requirements.txt

echo ""
echo "=========================================="
echo "✓ YOLO dependencies installed successfully!"
echo "=========================================="
echo ""
echo "📦 Installed packages:"
echo "   - ultralytics (latest YOLOv8/YOLOv11)"
echo "   - torch & torchvision (PyTorch)"
echo "   - pillow, numpy, opencv-python"
echo ""
echo "📥 Note: YOLOv8 model will be downloaded automatically on first use."
echo "   Model size: ~6MB (yolov8n.pt)"
echo ""
echo "🚀 Ready to use! Start the server with: npm start"

