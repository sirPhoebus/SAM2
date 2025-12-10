import { VisionResponse, ActionType } from "../types";

const SAM2_BACKEND_URL = "http://localhost:8000";

export const getNavCommand = async (imageBase64: string, targetDescription: string): Promise<VisionResponse> => {
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
    
    // Ensure the response matches our expected format
    return {
      action: data.action as ActionType,
      reasoning: data.reasoning,
      targetVisible: data.targetVisible,
      confidence: data.confidence,
      boundingBox: data.boundingBox,
    };
  } catch (error) {
    console.error("SAM2 Vision Error:", error);
    
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
