# YOLO Update Changelog

## Versi Terbaru (Latest)

### Updated Dependencies
- **ultralytics**: >= 8.3.0 (Latest YOLOv8/YOLOv11 support)
- **torch**: >= 2.4.0 (PyTorch latest)
- **torchvision**: >= 0.19.0
- **pillow**: >= 10.4.0
- **numpy**: >= 1.26.0
- **opencv-python**: >= 4.10.0

### Improvements
- ✅ Updated to latest Ultralytics API
- ✅ Better compatibility with YOLOv8 latest version
- ✅ Improved class mapping for trash detection
- ✅ Optimized detection performance
- ✅ Better error handling
- ✅ Support for latest PyTorch

### API Changes
- Using latest `yolo_model(image)` syntax
- Improved box coordinate extraction
- Better tensor handling for CPU/GPU compatibility

### Installation
```bash
./install_yolo.sh
```

atau

```bash
pip3 install --upgrade -r requirements.txt
```

