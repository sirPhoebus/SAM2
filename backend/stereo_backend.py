from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from pydantic import BaseModel
from typing import Optional, List
import base64
import io
from PIL import Image
import numpy as np
import logging
import torch
import cv2

from stereo_vision import StereoVision, get_color_range

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

app = FastAPI(title="Stereo Vision Backend for NeuroSeeker", version="2.0.0", lifespan=lifespan)

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Request/Response models
class StereoVisionRequest(BaseModel):
    left_image_base64: str
    right_image_base64: str
    target_description: str

class VisionResponse(BaseModel):
    action: str  # "FORWARD", "LEFT", "RIGHT", "STOP", "SCAN"
    reasoning: str
    targetVisible: bool
    confidence: float = 0.0  # 0.0 to 1.0 confidence score
    boundingBox: Optional[List[int]] = None  # [ymin, xmin, ymax, xmax] 0-1000 scale
    distance: Optional[float] = None  # Distance to target in meters
    angle: Optional[float] = None  # Angle to target in degrees

# Global variables
yolo_model = None
stereo_vision = StereoVision(baseline_cm=10.0, fov_degrees=110.0)

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
        logger.error("Falling back to stereo color detection")
        yolo_model = None
        return False

def decode_image(base64_str: str) -> np.ndarray:
    """Decode base64 image string to numpy array"""
    image_data = base64.b64decode(base64_str.split(",")[-1])
    image = Image.open(io.BytesIO(image_data))
    return np.array(image)

def process_with_stereo_vision(left_image: np.ndarray, right_image: np.ndarray, target_description: str):
    """Process stereo images to detect target with depth information"""
    
    # Get color range for target
    hsv_low, hsv_high = get_color_range(target_description)
    if hsv_low is None or hsv_high is None:
        logger.warning(f"No color range found for target: {target_description}")
        return None, None, None, 0.0
    
    # Detect target with depth
    distance, angle, confidence = stereo_vision.detect_target_with_depth(
        left_image, right_image, hsv_low, hsv_high
    )
    
    if distance is None or angle is None:
        return None, None, None, confidence or 0.0
    
    # Calculate bounding box from color detection
    left_hsv = cv2.cvtColor(left_image, cv2.COLOR_RGB2HSV)
    mask = cv2.inRange(left_hsv, hsv_low, hsv_high)
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    
    if contours:
        largest_contour = max(contours, key=cv2.contourArea)
        x, y, w, h = cv2.boundingRect(largest_contour)
        
        # Convert to required format [ymin, xmin, ymax, xmax] scaled 0-1000
        height, width = left_image.shape[:2]
        ymin = int((y / height) * 1000)
        xmin = int((x / width) * 1000)
        ymax = int(((y + h) / height) * 1000)
        xmax = int(((x + w) / width) * 1000)
        
        bounding_box = [ymin, xmin, ymax, xmax]
        
        # Calculate center (scaled 0-1000)
        center_x = (xmin + xmax) / 2
        center_y = (ymin + ymax) / 2
        bbox_height = ymax - ymin
        
        target_info = (center_x, center_y, bbox_height)
        
        logger.info(f"Stereo detection: target={target_description}, distance={distance:.1f}m, angle={angle:.1f}°, confidence={confidence:.2f}")
        
        return bounding_box, target_info, (distance, angle), confidence
    
    return None, None, (distance, angle), confidence

@app.get("/")
async def root():
    return {"message": "Stereo Vision Backend for NeuroSeeker", "status": "running", "stereo": True}

@app.get("/health")
async def health():
    return {"status": "healthy", "model_loaded": yolo_model is not None, "stereo_vision": True}

# For backward compatibility with existing frontend
class VisionRequest(BaseModel):
    image_base64: str
    target_description: str

@app.post("/api/stereo_vision", response_model=VisionResponse)
async def process_stereo_vision(request: StereoVisionRequest):
    """Process stereo images and return navigation command with depth information"""
    try:
        # Decode stereo images
        left_image = decode_image(request.left_image_base64)
        right_image = decode_image(request.right_image_base64)
        
        # Process with stereo vision
        bounding_box, target_info, depth_info, confidence = process_with_stereo_vision(
            left_image, right_image, request.target_description
        )
        
        target_visible = bounding_box is not None
        
        if target_visible:
            center_x, center_y, bbox_height = target_info
            distance, angle = depth_info
            
            # Get navigation command based on depth and angle
            action, reasoning = stereo_vision.get_navigation_command(distance, angle, confidence)
        else:
            action, reasoning = "SCAN", "Target not visible. Scanning..."
            bounding_box = []
            confidence = 0.0
            distance = None
            angle = None
        
        response = VisionResponse(
            action=action,
            reasoning=reasoning,
            targetVisible=target_visible,
            confidence=confidence,
            boundingBox=bounding_box if target_visible else [],
            distance=distance,
            angle=angle
        )
        
        logger.info(f"Processed stereo vision: target={request.target_description}, action={action}, distance={distance}, angle={angle}")
        return response
        
    except Exception as e:
        logger.error(f"Error processing stereo vision request: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/vision", response_model=VisionResponse)
async def process_vision(request: VisionRequest):
    """Process single image (for backward compatibility)"""
    try:
        # Decode single image
        image = decode_image(request.image_base64)
        
        # Use the image as both left and right (monocular fallback)
        # This won't give accurate depth but maintains compatibility
        bounding_box, target_info, depth_info, confidence = process_with_stereo_vision(
            image, image, request.target_description  # Same image for both
        )
        
        target_visible = bounding_box is not None
        
        if target_visible:
            center_x, center_y, bbox_height = target_info
            distance, angle = depth_info
            
            # If using same image for both, depth won't be accurate
            # Use fallback navigation logic
            if distance is None:  # Depth estimation failed
                # Use simple navigation based on bounding box
                if center_x < 400:
                    action, reasoning = "LEFT", f"Target at X={center_x:.0f}, turning LEFT"
                elif center_x > 600:
                    action, reasoning = "RIGHT", f"Target at X={center_x:.0f}, turning RIGHT"
                else:
                    if bbox_height < 800:
                        action, reasoning = "FORWARD", f"Target centered at X={center_x:.0f}, moving FORWARD"
                    else:
                        action, reasoning = "STOP", f"Target reached! Centered at X={center_x:.0f}"
            else:
                # Use stereo navigation
                action, reasoning = stereo_vision.get_navigation_command(distance, angle, confidence)
        else:
            action, reasoning = "SCAN", "Target not visible. Scanning..."
            bounding_box = []
            confidence = 0.0
            distance = None
            angle = None
        
        response = VisionResponse(
            action=action,
            reasoning=reasoning,
            targetVisible=target_visible,
            confidence=confidence,
            boundingBox=bounding_box if target_visible else [],
            distance=distance,
            angle=angle
        )
        
        logger.info(f"Processed vision (compatibility): target={request.target_description}, action={action}")
        return response
        
    except Exception as e:
        logger.error(f"Error processing vision request: {e}")
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
