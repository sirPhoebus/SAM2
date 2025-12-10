from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional, List
import base64
import io
from PIL import Image
import numpy as np
import cv2
import logging

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="SAM2 Backend for NeuroSeeker", version="1.0.0")

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

# Global variable for SAM2 model (will be loaded on startup)
sam2_model = None

def load_sam2_model():
    """Load SAM2 model on startup"""
    global sam2_model
    try:
        # TODO: Implement actual SAM2 model loading
        # For now, we'll use a placeholder
        logger.info("SAM2 model loading placeholder - implement actual loading")
        sam2_model = "placeholder"
    except Exception as e:
        logger.error(f"Failed to load SAM2 model: {e}")
        sam2_model = None

def process_with_sam2(image: np.ndarray, target_description: str):
    """Process image with SAM2 to detect target"""
    # TODO: Implement actual SAM2 processing
    # For now, simulate detection based on simple color matching
    
    # Convert to HSV for color detection
    hsv = cv2.cvtColor(image, cv2.COLOR_RGB2HSV)
    
    # Define color ranges for different targets
    # Expanded ranges for better detection
    color_ranges = {
        "Red Cube": ([0, 100, 50], [10, 255, 255]),  # Expanded red range
        "Pink Sphere": ([140, 50, 50], [170, 255, 255]),  # Pink/Magenta range
        "Green Cone": ([35, 30, 30], [85, 255, 255]),  # Expanded green range
        "Yellow Cylinder": ([15, 80, 80], [35, 255, 255]),  # Expanded yellow range
    }
    
    target_color = None
    for target, (lower, upper) in color_ranges.items():
        if target in target_description:
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
    # Larger contours and more centered contours get higher confidence
    height, width = image.shape[:2]
    contour_area = cv2.contourArea(largest_contour)
    max_possible_area = height * width
    
    # Area confidence: target should be reasonably sized (at least 2% of image)
    # Boost area confidence to reach higher values
    area_confidence = min(1.0, contour_area / (max_possible_area * 0.02))  # Up to 2% of image
    area_confidence = area_confidence * 1.5  # Boost to reach higher values
    
    # Position confidence: more centered = higher confidence
    center_x = x + w/2
    center_y = y + h/2
    distance_from_center = np.sqrt((center_x - width/2)**2 + (center_y - height/2)**2)
    max_distance = np.sqrt((width/2)**2 + (height/2)**2)
    position_confidence = 1.0 - (distance_from_center / max_distance)
    
    # Combined confidence - boost overall confidence significantly
    # Use higher weights and add a base confidence for detected targets
    confidence = (area_confidence * 0.6 + position_confidence * 0.4) * 1.5
    
    # Cap at 1.0 and ensure minimum confidence for detected targets
    # For red targets, give extra boost since they seem harder to detect
    if "Red" in target_description:
        confidence = confidence * 1.3  # Extra boost for red
    
    confidence = min(1.0, max(0.5, confidence))  # Higher minimum confidence
    
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
    
    return bounding_box, (center_x_scaled, center_y_scaled, bbox_height), confidence

def determine_action(center_x, center_y, bbox_height, target_visible):
    """Determine action based on target position (mimicking Gemini logic)"""
    if not target_visible:
        return "SCAN", "Target not visible. Scanning..."
    
    # Decision logic from Gemini prompt
    if center_x < 400:
        return "LEFT", f"Target detected at X={center_x:.0f}, turning LEFT to center"
    elif center_x > 600:
        return "RIGHT", f"Target detected at X={center_x:.0f}, turning RIGHT to center"
    else:  # 400 <= center_x <= 600
        if bbox_height < 800:
            return "FORWARD", f"Target centered at X={center_x:.0f}, moving FORWARD (height={bbox_height:.0f})"
        else:
            return "STOP", f"Target reached! Centered at X={center_x:.0f}, height={bbox_height:.0f}"

@app.on_event("startup")
async def startup_event():
    """Load SAM2 model on startup"""
    load_sam2_model()

@app.get("/")
async def root():
    return {"message": "SAM2 Backend for NeuroSeeker", "status": "running"}

@app.get("/health")
async def health():
    return {"status": "healthy", "model_loaded": sam2_model is not None}

@app.post("/api/vision", response_model=VisionResponse)
async def process_vision(request: VisionRequest):
    """Process image and return navigation command"""
    try:
        # Decode base64 image
        image_data = base64.b64decode(request.image_base64.split(",")[-1])
        image = Image.open(io.BytesIO(image_data))
        image_np = np.array(image)
        
        # Process with SAM2 (or placeholder)
        bounding_box, target_info, confidence = process_with_sam2(image_np, request.target_description)
        
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
        
        logger.info(f"Processed vision request: target={request.target_description}, action={action}, confidence={confidence:.2f}")
        return response
        
    except Exception as e:
        logger.error(f"Error processing vision request: {e}")
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
