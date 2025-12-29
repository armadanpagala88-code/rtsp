#!/usr/bin/env python3
"""
YOLO Detection Script for Trash Container Detection
Uses YOLOv8/YOLOv11 latest version for accurate object detection
"""

import sys
import json
import base64
import io
from pathlib import Path

try:
    from ultralytics import YOLO
    from PIL import Image
    import numpy as np
except ImportError as e:
    print(json.dumps({"error": f"Missing dependency: {str(e)}. Install with: pip install -r requirements.txt"}))
    sys.exit(1)

# Initialize YOLO model
model = None
model_path = None

def load_model():
    """Load YOLO model"""
    global model, model_path
    
    if model is not None:
        return model
    
    # Try to load custom trained model first, fallback to pretrained
    # Check both models/ subdir and current dir
    custom_model_paths = [
        Path(__file__).parent / "models" / "trash_detection.pt",
        Path(__file__).parent / "trash_detection.pt"
    ]
    
    found_custom = False
    found_custom = False
    for path in custom_model_paths:
        if path.exists() and path.is_file():
            model_path = str(path)
            print(f"Loading custom model: {model_path}", file=sys.stderr)
            found_custom = True
            break
            
    if not found_custom:
        # Use YOLOv8n (nano) for speed - latest version
        # Options: yolov8n.pt (fastest), yolov8s.pt (balanced), yolov8m.pt (accurate)
        # Or yolov11n.pt if available (latest)
        model_path = "yolov8n.pt"  # Will download automatically from ultralytics
        print(f"Using latest YOLOv8 pretrained model: {model_path}", file=sys.stderr)
    
    try:
        model = YOLO(model_path)
        print("YOLO model loaded successfully", file=sys.stderr)
        return model
    except Exception as e:
        print(json.dumps({"error": f"Failed to load YOLO model: {str(e)}"}))
        sys.exit(1)

def detect_objects(image_base64, roi_json=None):
    """
    Detect objects in base64 encoded image
    roi_json: JSON string with ROI coordinates {x, y, width, height} or null
    Returns JSON with detections
    """
    try:
        # Load model
        yolo_model = load_model()
        
        # Decode base64 image
        image_data = base64.b64decode(image_base64)
        image = Image.open(io.BytesIO(image_data))
        
        # Convert to RGB if needed
        if image.mode != 'RGB':
            image = image.convert('RGB')
        
        # Apply ROI if provided
        original_size = image.size
        roi_offset = {'x': 0, 'y': 0}
        
        if roi_json and roi_json != 'null':
            try:
                roi = json.loads(roi_json)
                if roi and 'x' in roi and 'y' in roi and 'width' in roi and 'height' in roi:
                    # Crop image to ROI
                    x = int(roi['x'])
                    y = int(roi['y'])
                    width = int(roi['width'])
                    height = int(roi['height'])
                    
                    # Ensure ROI is within image bounds
                    x = max(0, min(x, original_size[0]))
                    y = max(0, min(original_size[1], y))
                    width = max(1, min(width, original_size[0] - x))
                    height = max(1, min(height, original_size[1] - y))
                    
                    # Crop image
                    image = image.crop((x, y, x + width, y + height))
                    roi_offset = {'x': x, 'y': y}
            except Exception as e:
                print(f"Warning: Failed to apply ROI: {e}", file=sys.stderr)
        
        # Run YOLO detection with latest API
        # conf: confidence threshold (0.25 = detect objects with 25%+ confidence)
        # iou: IoU threshold for NMS (0.45 = standard)
        # device: auto-detect (CPU/GPU)
        # verbose: False to suppress output
        # Using latest ultralytics API
        results = yolo_model(
            image, 
            conf=0.15,  # Lowered confidence to catch more obscure trash items
            iou=0.45, 
            verbose=False
        )
        
        # Process results
        detections = []
        image_width, image_height = image.size
        
        # First pass: collect all detections
        all_boxes = []
        for result in results:
            boxes = result.boxes
            if boxes is None or len(boxes) == 0:
                continue
                
            # Get class names from model
            class_names = yolo_model.names
            
            # Process each detection box - latest ultralytics API
            for box in boxes:
                # Get coordinates (xyxy format)
                xyxy = box.xyxy[0].cpu().numpy()
                x1, y1, x2, y2 = float(xyxy[0]), float(xyxy[1]), float(xyxy[2]), float(xyxy[3])
                
                # Get confidence
                confidence = float(box.conf[0].cpu().numpy())
                
                # Get class ID and name
                class_id = int(box.cls[0].cpu().numpy())
                class_name = class_names[class_id]
                
                all_boxes.append({
                    "bbox": [x1, y1, x2 - x1, y2 - y1],
                    "confidence": confidence,
                    "class_name": class_name
                })
        
        # Second pass: map classes with context
        for box_data in all_boxes:
            custom_class = map_class_name(
                box_data["class_name"], 
                box_data["confidence"],
                len(all_boxes)
            )
            
            # Only add if mapped to our classes
            if custom_class:
                # Adjust bbox coordinates if ROI was applied
                adjusted_bbox = box_data["bbox"].copy()
                if roi_offset['x'] > 0 or roi_offset['y'] > 0:
                    adjusted_bbox[0] += roi_offset['x']  # x
                    adjusted_bbox[1] += roi_offset['y']  # y
                
                detections.append({
                    "class": custom_class,
                    "score": box_data["confidence"],
                    "bbox": adjusted_bbox,
                    "original_class": box_data["class_name"]
                })
        
        # Post-Processing: Detect "Orang_Buang_Sampah"
        # Check if any "Orang" is close to "Bak Sampah" or "Sampah_Berserakan"
        people = [d for d in detections if d["class"] == "Orang"]
        trash_objects = [d for d in detections if d["class"] in ["Bak Sampah", "Sampah_Berserakan", "Sampah_Overload"]]
        
        for person in people:
            is_throwing = False
            for obj in trash_objects:
                if is_close_proximity(person["bbox"], obj["bbox"]):
                    is_throwing = True
                    break
            
            if is_throwing:
                person["class"] = "Orang_Buang_Sampah"
        
        # Count containers and overloads
        container_count = sum(1 for d in detections if d["class"] == "Container")
        overload_count = sum(1 for d in detections if d["class"] == "Sampah_Overload")
        is_overloaded = container_count > 2 or overload_count > 0
        
        return {
            "success": True,
            "detections": detections,
            "containerCount": container_count,
            "overloadCount": overload_count,
            "isOverloaded": is_overloaded,
            "imageSize": {"width": original_size[0], "height": original_size[1]},
            "roiApplied": roi_json is not None and roi_json != 'null'
        }
        
    except Exception as e:
        return {
            "success": False,
            "error": str(e)
        }

def map_class_name(class_name, confidence, all_detections_count):
    """
    Map YOLO COCO class names to our custom classes
    Improved mapping for trash container detection
    Optimized for latest YOLO version
    """
    class_name_lower = class_name.lower()
    
    # 1. EXCLUDED OBJECTS (People, Vehicles) - Return these as specific classes or None
    # Person detected
    if 'person' in class_name_lower:
        return "Orang"
    
    # Vehicle or other objects - skip
    vehicle_classes = ['car', 'truck', 'bus', 'motorcycle', 'bicycle', 'airplane', 'train', 'boat']
    if any(v in class_name_lower for v in vehicle_classes):
        return None

    # 2. DEFINITE TRASH/BINS
    # Food/Organic items
    food_classes = ['banana', 'apple', 'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake']
    if any(c in class_name_lower for c in food_classes):
        return "Sampah_Berserakan"

    # Actual containers/bins
    # Only strictly known container types
    if 'trash can' in class_name_lower or 'garbage can' in class_name_lower or 'bin' in class_name_lower or 'container' in class_name_lower:
        if confidence > 0.4:
            return "Bak Sampah"
    
    # Bucket 
    if 'bucket' in class_name_lower:
        if confidence > 0.5:
             return "Bak Sampah"

    # 3. EVERYTHING ELSE IS POTENTIALLY TRASH
    # If it's not a person and not a vehicle, assume it's "Sampah Berserakan" in this context.
    # This covers: bottles, cups, bowls, chairs, couches, tvs, remotes, bags, suitcases, etc.
    # The list of small_items is no longer strictly needed if we do a catch-all, but good for explicit documentation/tuning if needed.
    
    # However, to avoid pure noise (like 'tree' or 'sky' if the model malfunctions, though COCO doesn't have those),
    # we trust the COCO classes. COCO classes are: 
    # [person, bicycle, car, motorcycle, airplane, bus, train, truck, boat, traffic light, fire hydrant, 
    # stop sign, parking meter, bench, bird, cat, dog, horse, sheep, cow, elephant, bear, zebra, giraffe, 
    # backpack, umbrella, handbag, tie, suitcase, frisbee, skis, snowboard, sports ball, kite, baseball bat, 
    # baseball glove, skateboard, surfboard, tennis racket, bottle, wine glass, cup, fork, knife, spoon, 
    # bowl, banana, apple, sandwich, orange, broccoli, carrot, hot dog, pizza, donut, cake, chair, couch, 
    # potted plant, bed, dining table, toilet, tv, laptop, mouse, remote, keyboard, cell phone, microwave, 
    # oven, toaster, sink, refrigerator, book, clock, vase, scissors, teddy bear, hair drier, toothbrush]

    # Exclude animals? Maybe. User image shows chickens. User previously said: "Mimicking reference... chicken/bird might be 'Berserakan'".
    # So animals ARE "Sampah_Berserakan" in this context (or at least clutter).
    
    # Exclude infrastructure?
    infrastructure = ['traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench']
    if any(x in class_name_lower for x in infrastructure):
        return None # Likely real infrastructure
        
    # By default, EVERYTHING else is trash
    return "Sampah_Berserakan"

def is_close_proximity(bbox1, bbox2, threshold=0.1):
    """
    Check if two bounding boxes are close to each other
    bbox: [x, y, w, h]
    """
    # Calculate proximity based on relative coordinates
    # Simple overlap or distance check
    x1, y1, w1, h1 = bbox1
    x2, y2, w2, h2 = bbox2
    
    # Calculate centers
    cx1, cy1 = x1 + w1/2, y1 + h1/2
    cx2, cy2 = x2 + w2/2, y2 + h2/2
    
    # Calculate distance (relative to image width/height inferred from coordinates roughly)
    # Since we don't have image size here easily, we use raw distance
    # Assuming relative coordinates, threshold 0.1 means 10% of image size
    
    dist = ((cx1 - cx2)**2 + (cy1 - cy2)**2)**0.5
    
    # Dynamic threshold based on object sizes
    avg_size = (w1 + h1 + w2 + h2) / 4
    
    return dist < (avg_size * 2) # If centers are within 2x average size


def main():
    """Main function to handle command line input"""
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: python yolo_detection.py <base64_image> [roi_json]"}))
        sys.exit(1)
    
    image_base64 = sys.argv[1]
    roi_json = sys.argv[2] if len(sys.argv) > 2 else None
    result = detect_objects(image_base64, roi_json)
    print(json.dumps(result))

if __name__ == "__main__":
    main()

