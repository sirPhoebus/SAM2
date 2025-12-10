import { VisionResponse, ActionType } from "../types";

const SAM2_BACKEND_URL = "http://localhost:8000";

export const getNavCommand = async (leftImageBase64: string, rightImageBase64: string, targetDescription: string): Promise<VisionResponse> => {
  try {
    // Try stereo vision endpoint first
    const response = await fetch(`${SAM2_BACKEND_URL}/api/stereo_vision`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        left_image_base64: leftImageBase64,
        right_image_base64: rightImageBase64,
        target_description: targetDescription,
      }),
    });

    if (!response.ok) {
      // Fall back to monocular vision if stereo fails
      return await getMonocularNavCommand(leftImageBase64, targetDescription);
    }

    const data = await response.json();
    
    // Ensure the response matches our expected format
    return {
      action: data.action as ActionType,
      reasoning: data.reasoning,
      targetVisible: data.targetVisible,
      confidence: data.confidence,
      boundingBox: data.boundingBox,
      distance: data.distance,
      angle: data.angle,
    };
  } catch (error) {
    console.error("SAM2 Stereo Vision Error:", error);
    
    // Fall back to monocular vision
    return await getMonocularNavCommand(leftImageBase64, targetDescription);
  }
};

// Fallback function for monocular vision (backward compatibility)
const getMonocularNavCommand = async (imageBase64: string, targetDescription: string): Promise<VisionResponse> => {
  try {
    const response = await fetch(`${SAM2_BACKEND_URL}/api/vision`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        image_base64: imageBase64,
        target_description: targetDescription,
      }),
    });

    if (!response.ok) {
      throw new Error(`SAM2 backend error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    
    return {
      action: data.action as ActionType,
      reasoning: data.reasoning,
      targetVisible: data.targetVisible,
      confidence: data.confidence,
      boundingBox: data.boundingBox,
    };
  } catch (error) {
    console.error("SAM2 Monocular Vision Error:", error);
    
    let errorMessage = "SAM2 backend unavailable. Falling back to scan mode.";
    if (error instanceof Error) {
      if (error.message.includes("Failed to fetch") || error.message.includes("NetworkError")) {
        errorMessage = "SAM2 backend not running. Please start the Python backend server.";
      }
    }
    
    return {
      action: ActionType.SCAN,
      reasoning: errorMessage,
      targetVisible: false
    };
  }
};
