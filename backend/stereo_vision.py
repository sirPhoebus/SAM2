import cv2
import numpy as np
from typing import Tuple, Optional
import logging

logger = logging.getLogger(__name__)

class StereoVision:
    """Stereo vision system for depth estimation with 110° FOV"""
    
    def __init__(self, baseline_cm: float = 10.0, fov_degrees: float = 110.0):
        """
        Initialize stereo vision system
        
        Args:
            baseline_cm: Distance between cameras in centimeters (10cm = 0.1m)
            fov_degrees: Field of view in degrees (110° wide angle)
        """
        self.baseline = baseline_cm / 100.0  # Convert to meters
        self.fov = np.radians(fov_degrees)
        
        # For 512x512 images
        self.image_width = 512
        self.image_height = 512
        
        # Calculate focal length from FOV
        # f = (width/2) / tan(FOV/2)
        self.focal_length = (self.image_width / 2) / np.tan(self.fov / 2)
        
        # Stereo matcher for depth estimation
        self.stereo = cv2.StereoSGBM_create(
            minDisparity=0,
            numDisparities=64,  # Reduced for performance
            blockSize=11,
            P1=8 * 3 * 11**2,
            P2=32 * 3 * 11**2,
            disp12MaxDiff=1,
            uniquenessRatio=10,
            speckleWindowSize=100,
            speckleRange=32,
            mode=cv2.STEREO_SGBM_MODE_SGBM_3WAY
        )
        
        logger.info(f"Stereo Vision initialized: baseline={self.baseline}m, FOV={fov_degrees}°, focal={self.focal_length:.1f}px")
    
    def estimate_depth(self, left_image: np.ndarray, right_image: np.ndarray) -> Tuple[Optional[np.ndarray], Optional[float]]:
        """
        Estimate depth from stereo image pair
        
        Args:
            left_image: Left camera image (RGB)
            right_image: Right camera image (RGB)
            
        Returns:
            Tuple of (depth_map, average_depth) or (None, None) if failed
        """
        try:
            # Convert to grayscale for stereo matching
            left_gray = cv2.cvtColor(left_image, cv2.COLOR_RGB2GRAY)
            right_gray = cv2.cvtColor(right_image, cv2.COLOR_RGB2GRAY)
            
            # Compute disparity map
            disparity = self.stereo.compute(left_gray, right_gray).astype(np.float32) / 16.0
            
            # Convert disparity to depth
            # depth = (baseline * focal_length) / disparity
            # Avoid division by zero
            disparity[disparity == 0] = 0.1
            depth_map = (self.baseline * self.focal_length) / disparity
            
            # Filter out unrealistic depths (too close or too far)
            depth_map = np.clip(depth_map, 0.1, 50.0)  # 0.1m to 50m
            
            # Calculate average depth in central region
            center_region = depth_map[
                self.image_height//4:3*self.image_height//4,
                self.image_width//4:3*self.image_width//4
            ]
            average_depth = np.mean(center_region) if center_region.size > 0 else None
            
            return depth_map, average_depth
            
        except Exception as e:
            logger.error(f"Depth estimation failed: {e}")
            return None, None
    
    def detect_target_with_depth(self, 
                                left_image: np.ndarray, 
                                right_image: np.ndarray,
                                target_color_hsv_low: np.ndarray,
                                target_color_hsv_high: np.ndarray) -> Tuple[Optional[float], Optional[float], Optional[float]]:
        """
        Detect target with depth information
        
        Args:
            left_image: Left camera image
            right_image: Right camera image
            target_color_hsv_low: Lower HSV bound for target color
            target_color_hsv_high: Upper HSV bound for target color
            
        Returns:
            Tuple of (distance_meters, angle_degrees, confidence) or (None, None, None)
        """
        try:
            # Convert to HSV for color detection
            left_hsv = cv2.cvtColor(left_image, cv2.COLOR_RGB2HSV)
            
            # Create mask for target color
            mask = cv2.inRange(left_hsv, target_color_hsv_low, target_color_hsv_high)
            
            # Find contours
            contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            
            if not contours:
                return None, None, None
            
            # Get largest contour
            largest_contour = max(contours, key=cv2.contourArea)
            x, y, w, h = cv2.boundingRect(largest_contour)
            
            # Calculate target center in image coordinates
            center_x = x + w/2
            center_y = y + h/2
            
            # Calculate angle from center (horizontal field of view)
            # Angle = atan((center_x - width/2) / focal_length)
            angle_rad = np.arctan2(center_x - self.image_width/2, self.focal_length)
            angle_deg = np.degrees(angle_rad)
            
            # Estimate depth using stereo
            depth_map, avg_depth = self.estimate_depth(left_image, right_image)
            
            if depth_map is None or avg_depth is None:
                return None, angle_deg, 0.5
            
            # Get depth at target location
            target_depth = depth_map[int(center_y), int(center_x)]
            
            # Calculate confidence based on contour area and depth consistency
            contour_area = cv2.contourArea(largest_contour)
            max_area = self.image_width * self.image_height
            area_confidence = min(1.0, contour_area / (max_area * 0.01))
            
            # Depth consistency confidence (target should have consistent depth)
            depth_region = depth_map[y:y+h, x:x+w]
            depth_std = np.std(depth_region) if depth_region.size > 0 else 0
            depth_confidence = 1.0 - min(1.0, depth_std / 5.0)  # Less confidence if depth varies
            
            confidence = (area_confidence * 0.6 + depth_confidence * 0.4)
            
            return target_depth, angle_deg, confidence
            
        except Exception as e:
            logger.error(f"Target detection with depth failed: {e}")
            return None, None, None
    
    def get_navigation_command(self, 
                              distance: float, 
                              angle: float, 
                              confidence: float) -> Tuple[str, str]:
        """
        Generate navigation command based on depth and angle
        
        Args:
            distance: Distance to target in meters
            angle: Angle to target in degrees (negative = left, positive = right)
            confidence: Detection confidence (0.0 to 1.0)
            
        Returns:
            Tuple of (action, reasoning)
        """
        if distance is None or angle is None or confidence < 0.3:
            return "SCAN", "Target not detected or low confidence"
        
        # Convert angle to normalized value (-1.0 to 1.0)
        # 110° FOV means ±55° from center
        angle_normalized = angle / 55.0
        angle_normalized = np.clip(angle_normalized, -1.0, 1.0)
        
        # Navigation logic based on distance and angle
        if distance < 1.0:  # Very close
            if abs(angle_normalized) < 0.1:  # Centered
                return "STOP", f"Target reached! Distance: {distance:.1f}m, Angle: {angle:.1f}°"
            elif angle_normalized < -0.3:  # Left
                return "LEFT", f"Target close at {distance:.1f}m, turning LEFT (angle: {angle:.1f}°)"
            elif angle_normalized > 0.3:  # Right
                return "RIGHT", f"Target close at {distance:.1f}m, turning RIGHT (angle: {angle:.1f}°)"
            else:
                return "FORWARD", f"Target close at {distance:.1f}m, moving FORWARD"
        
        elif distance < 5.0:  # Medium distance
            if abs(angle_normalized) < 0.2:  # Somewhat centered
                return "FORWARD", f"Target at medium distance {distance:.1f}m, moving FORWARD"
            elif angle_normalized < -0.5:  # Far left
                return "LEFT", f"Target at {distance:.1f}m, turning LEFT to center"
            elif angle_normalized > 0.5:  # Far right
                return "RIGHT", f"Target at {distance:.1f}m, turning RIGHT to center"
            else:
                return "FORWARD", f"Target at {distance:.1f}m, moving FORWARD while centering"
        
        else:  # Far away
            if abs(angle_normalized) < 0.3:  # Reasonably centered
                return "FORWARD", f"Target far away at {distance:.1f}m, moving FORWARD urgently"
            elif angle_normalized < -0.7:  # Extreme left
                return "LEFT", f"Target far at {distance:.1f}m, turning LEFT to find"
            elif angle_normalized > 0.7:  # Extreme right
                return "RIGHT", f"Target far at {distance:.1f}m, turning RIGHT to find"
            else:
                return "FORWARD", f"Target far at {distance:.1f}m, moving FORWARD to close distance"

# Color ranges for different targets (HSV format)
COLOR_RANGES = {
    "Red Cube": (np.array([0, 120, 70]), np.array([10, 255, 255])),
    "Pink Sphere": (np.array([150, 70, 70]), np.array([170, 255, 255])),
    "Green Cone": (np.array([40, 80, 80]), np.array([80, 255, 255])),
    "Yellow Cylinder": (np.array([20, 100, 100]), np.array([30, 255, 255])),
    "Skeleton Head": (np.array([0, 0, 180]), np.array([180, 40, 255])),
}

def get_color_range(target_description: str):
    """Get HSV color range for target description"""
    for target, (low, high) in COLOR_RANGES.items():
        if target in target_description or any(word in target_description for word in target.split()):
            return low, high
    return None, None
