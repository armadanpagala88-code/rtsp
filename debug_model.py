
import sys
from ultralytics import YOLO

# Load model
model = YOLO('yolov8m.pt')

# Image
img_path = "/Users/fullstack2/.gemini/antigravity/brain/8e28771f-37e6-43c5-956d-6eb07ac27f81/uploaded_image_1766385171461.jpg"

# Predict with low confidence
results = model(img_path, conf=0.05, verbose=False)

print(f"--- Detections (conf=0.05) ---")
for r in results:
    for box in r.boxes:
        cls_id = int(box.cls[0])
        cls_name = model.names[cls_id]
        conf = float(box.conf[0])
        print(f"Class: {cls_name}, Conf: {conf:.4f}, Box: {box.xyxy[0].tolist()}")
