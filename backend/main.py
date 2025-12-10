from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from pydantic import BaseModel
from typing import Optional, List
import base64
import io
from PIL import Image
import numpy as np
import cv2
import logging
import torch

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Lifespan event handler for YOLO model loading
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: load YOLO model
    load_yolo_model()
    yield
    # Shutdown: cleanup if needed
    pass

app = FastAPI(title="YOLO Backend for NeuroSeeker", version="1.0.0", lifespan=lifespan)

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Request/Response models matching the frontend expectations
class VisionRequest(BaseModel):
    image_base64: str
    target_description: str

class VisionResponse(BaseModel):
    action: str  # "FORWARD", "LEFT", "RIGHT", "STOP", "SCAN"
    reasoning: str
    targetVisible: bool
    confidence: float = 0.0  # 0.0 to 1.0 confidence score
    boundingBox: Optional[List[int]] = None  # [ymin, xmin, ymax, xmax] 0-1000 scale

# Global variable for YOLO model (will be loaded on startup)
yolo_model = None

def load_yolo_model():
    """Load YOLO model on startup"""
    global yolo_model
    try:
        logger.info("Loading YOLOv5 model...")
        # Load YOLOv5 model from torch hub with trust_repo=True to avoid warning
        yolo_model = torch.hub.load('ultralytics/yolov5', 'yolov5s', pretrained=True, trust_repo=True)
        yolo_model.conf = 0.5  # Confidence threshold
        yolo_model.iou = 0.45  # NMS IoU threshold
        logger.info("YOLOv5 model loaded successfully")
        return True
    except Exception as e:
        logger.error(f"Failed to load YOLO model: {e}")
        logger.error("Falling back to color-based detection")
        yolo_model = None
        return False

def process_with_yolo(image: np.ndarray, target_description: str):
    """Process image with YOLO to detect target"""
    global yolo_model
    
    if yolo_model is None:
        logger.error("YOLO model not loaded")
        return None, None, 0.0
    
    # Map target descriptions to COCO classes
    # COCO class names: https://github.com/ultralytics/yolov5/blob/master/data/coco.yaml
    target_to_coco = {
        # Basic shapes - map to similar COCO classes
        "Red Cube": ["tv", "remote", "book"],  # Box-like objects
        "Pink Sphere": ["sports ball", "orange", "apple"],  # Round objects
        "Green Cone": ["traffic light", "bottle", "vase"],  # Cone-like objects
        "Yellow Cylinder": ["bottle", "cup", "vase"],  # Cylinder-like objects
        "Skeleton Head": ["person", "teddy bear", "clock"],  # Person-like or head-like
        
        # Also check for partial matches
        "Cube": ["tv", "remote", "book"],
        "Sphere": ["sports ball", "orange", "apple"],
        "Cone": ["traffic light", "bottle", "vase"],
        "Cylinder": ["bottle", "cup", "vase"],
        "Pyramid": ["orange", "apple", "sports ball"],
        "Skeleton": ["person", "teddy bear", "clock"],
        "Head": ["person", "teddy bear", "clock"],
    }
    
    # Find matching COCO classes for target description
    target_classes = []
    for target, classes in target_to_coco.items():
        if target in target_description or any(word in target_description for word in target.split()):
            target_classes.extend(classes)
    
    # Remove duplicates
    target_classes = list(set(target_classes))
    
    if not target_classes:
        logger.warning(f"No COCO class mapping found for target: {target_description}")
        return None, None, 0.0
    
    # Run YOLO inference
    results = yolo_model(image)
    
    # Parse results
    detections = results.pandas().xyxy[0]  # DataFrame with columns: xmin, ymin, xmax, ymax, confidence, class, name
    
    # Filter detections for target classes
    target_detections = detections[detections['name'].isin(target_classes)]
    
    if target_detections.empty:
        return None, None, 0.0
    
    # Get the detection with highest confidence
    best_detection = target_detections.iloc[target_detections['confidence'].idxmax()]
    
    # Extract bounding box and confidence
    xmin = int(best_detection['xmin'])
    ymin = int(best_detection['ymin'])
    xmax = int(best_detection['xmax'])
    ymax = int(best_detection['ymax'])
    confidence = float(best_detection['confidence'])
    
    height, width = image.shape[:2]
    
    # Convert to required format [ymin, xmin, ymax, xmax] scaled 0-1000
    ymin_scaled = int((ymin / height) * 1000)
    xmin_scaled = int((xmin / width) * 1000)
    ymax_scaled = int((ymax / height) * 1000)
    xmax_scaled = int((xmax / width) * 1000)
    
    bounding_box = [ymin_scaled, xmin_scaled, ymax_scaled, xmax_scaled]
    
    # Calculate center (scaled 0-1000)
    center_x_scaled = (xmin_scaled + xmax_scaled) / 2
    center_y_scaled = (ymin_scaled + ymax_scaled) / 2
    bbox_height = ymax_scaled - ymin_scaled
    
    # Adjust confidence based on position (more centered = higher confidence)
    distance_from_center = np.sqrt((center_x_scaled - 500)**2 + (center_y_scaled - 500)**2)
    max_distance = np.sqrt(500**2 + 500**2)
    position_confidence = 1.0 - (distance_from_center / max_distance)
    
    # Combine YOLO confidence with position confidence
    final_confidence = (confidence * 0.7 + position_confidence * 0.3)
    
    logger.info(f"YOLO detection: target={target_description}, class={best_detection['name']}, confidence={final_confidence:.2f}")
    
    return bounding_box, (center_x_scaled, center_y_scaled, bbox_height), final_confidence

def process_with_color(image: np.ndarray, target_description: str):
    """Fallback color-based detection when YOLO fails"""
    # Convert to HSV for color detection
    hsv = cv2.cvtColor(image, cv2.COLOR_RGB2HSV)
    
    # Define color ranges for different targets
    # Optimized ranges for better detection of all shapes
    color_ranges = {
        "Red Cube": ([0, 120, 70], [10, 255, 255]),  # Bright red
        "Pink Sphere": ([150, 70, 70], [170, 255, 255]),  # Pink/Magenta
        "Green Cone": ([40, 80, 80], [80, 255, 255]),  # Bright green
        "Yellow Cylinder": ([20, 100, 100], [30, 255, 255]),  # Bright yellow
        "Skeleton Head": ([0, 0, 180], [180, 40, 255]),  # Very light/white
    }
    
    # Also check for partial matches (e.g., "Pyramid" in "Orange Pyramid")
    target_color = None
    for target, (lower, upper) in color_ranges.items():
        if target in target_description or any(word in target_description for word in target.split()):
            target_color = (np.array(lower), np.array(upper))
            break
    
    if target_color is None:
        return None, None, 0.0
    
    # Create mask for target color
    lower, upper = target_color
    mask = cv2.inRange(hsv, lower, upper)
    
    # Find contours
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    
    if not contours:
        return None, None, 0.0
    
    # Get largest contour
    largest_contour = max(contours, key=cv2.contourArea)
    x, y, w, h = cv2.boundingRect(largest_contour)
    
    # Calculate confidence based on contour area and position
    height, width = image.shape[:2]
    contour_area = cv2.contourArea(largest_contour)
    max_possible_area = height * width
    
    # Area confidence: target should be reasonably sized
    area_confidence = min(1.0, contour_area / (max_possible_area * 0.02))
    area_confidence = area_confidence * 1.5
    
    # Position confidence: more centered = higher confidence
    center_x = x + w/2
    center_y = y + h/2
    distance_from_center = np.sqrt((center_x - width/2)**2 + (center_y - height/2)**2)
    max_distance = np.sqrt((width/2)**2 + (height/2)**2)
    position_confidence = 1.0 - (distance_from_center / max_distance)
    
    # Combined confidence
    confidence = (area_confidence * 0.6 + position_confidence * 0.4) * 1.5
    
    # Cap at 1.0 and ensure minimum confidence
    if "Red" in target_description:
        confidence = confidence * 1.3
    
    confidence = min(1.0, max(0.5, confidence))
    
    # Convert to required format [ymin, xmin, ymax, xmax] scaled 0-1000
    ymin = int((y / height) * 1000)
    xmin = int((x / width) * 1000)
    ymax = int(((y + h) / height) * 1000)
    xmax = int(((x + w) / width) * 1000)
    
    bounding_box = [ymin, xmin, ymax, xmax]
    
    # Calculate center (scaled 0-1000)
    center_x_scaled = (xmin + xmax) / 2
    center_y_scaled = (ymin + ymax) / 2
    bbox_height = ymax - ymin
    
    logger.info(f"Color detection: target={target_description}, confidence={confidence:.2f}")
    
    return bounding_box, (center_x_scaled, center_y_scaled, bbox_height), confidence

def determine_action(center_x, center_y, bbox_height, target_visible):
    """Simple navigation that always moves forward for distant targets"""
    
    if not target_visible:
        # Always move forward when target not visible
        return "FORWARD", "Target not visible. Moving forward to explore."
    
    # TARGET IS VISIBLE
    
    # If target is extremely small (height < 50), ALWAYS move forward
    # Don't even check position - just get closer
    if bbox_height < 50:
        return "FORWARD", f"Target VERY far away (height={bbox_height:.0f}). Moving forward urgently!"
    
    # If target is very small (50-150), move forward unless at extreme edges
    elif bbox_height < 150:
        if center_x < 50:  # Super extreme left
            return "LEFT", f"Target far away at super left X={center_x:.0f}. Quick LEFT turn."
        elif center_x > 950:  # Super extreme right
            return "RIGHT", f"Target far away at super right X={center_x:.0f}. Quick RIGHT turn."
        else:
            return "FORWARD", f"Target far away (height={bbox_height:.0f}). Moving forward!"
    
    # For small/medium targets (150-400), normal navigation
    elif bbox_height < 400:
        if center_x < 200:
            return "LEFT", f"Target at left edge X={center_x:.0f}. Turning LEFT. (height={bbox_height:.0f})"
        elif center_x > 800:
            return "RIGHT", f"Target at right edge X={center_x:.0f}. Turning RIGHT. (height={bbox_height:.0f})"
        else:
            return "FORWARD", f"Target visible at X={center_x:.0f}. Moving FORWARD. (height={bbox_height:.0f})"
    
    # For larger targets (closer), precise navigation
    else:
        if center_x < 300:
            return "LEFT", f"Target at X={center_x:.0f}. Turning LEFT. (height={bbox_height:.0f})"
        elif center_x > 700:
            return "RIGHT", f"Target at X={center_x:.0f}. Turning RIGHT. (height={bbox_height:.0f})"
        else:
            if bbox_height < 800:
                return "FORWARD", f"Target centered at X={center_x:.0f}. Moving FORWARD. (height={bbox_height:.0f})"
            else:
                return "STOP", f"Target reached! Centered at X={center_x:.0f}, height={bbox_height:.0f}"

# Remove old startup event - using lifespan handler instead

@app.get("/")
async def root():
    return {"message": "YOLO Backend for NeuroSeeker", "status": "running"}

@app.get("/health")
async def health():
    return {"status": "healthy", "model_loaded": yolo_model is not None}

@app.post("/api/vision", response_model=VisionResponse)
async def process_vision(request: VisionRequest):
    """Process image and return navigation command"""
    try:
        # Decode base64 image
        image_data = base64.b64decode(request.image_base64.split(",")[-1])
        image = Image.open(io.BytesIO(image_data))
        image_np = np.array(image)
        
        # Try YOLO first, fall back to color detection if YOLO not loaded
        if yolo_model is not None:
            bounding_box, target_info, confidence = process_with_yolo(image_np, request.target_description)
            detection_method = "YOLO"
        else:
            bounding_box, target_info, confidence = process_with_color(image_np, request.target_description)
            detection_method = "Color"
        
        target_visible = bounding_box is not None
        
        if target_visible:
            center_x, center_y, bbox_height = target_info
            action, reasoning = determine_action(center_x, center_y, bbox_height, target_visible)
        else:
            action, reasoning = "SCAN", "Target not visible. Scanning..."
            bounding_box = []
            confidence = 0.0
        
        response = VisionResponse(
            action=action,
            reasoning=reasoning,
            targetVisible=target_visible,
            confidence=confidence,
            boundingBox=bounding_box if target_visible else []
        )
        
        logger.info(f"Processed vision request: target={request.target_description}, method={detection_method}, action={action}, confidence={confidence:.2f}")
        return response
        
    except Exception as e:
        logger.error(f"Error processing vision request: {e}")
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
