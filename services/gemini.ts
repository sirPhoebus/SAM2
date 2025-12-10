import { GoogleGenAI, Type, Schema } from "@google/genai";
import { VisionResponse, ActionType } from "../types";

// Initialize Gemini
// NOTE: We use the API key from process.env as per strict instructions.
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

const RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    action: {
      type: Type.STRING,
      enum: [
        ActionType.FORWARD,
        ActionType.LEFT,
        ActionType.RIGHT,
        ActionType.STOP,
        ActionType.SCAN
      ],
      description: "The movement command for the robot."
    },
    reasoning: {
      type: Type.STRING,
      description: "Short technical reasoning. E.g. 'Target detected at X=200, turning LEFT to center.'",
    },
    targetVisible: {
      type: Type.BOOLEAN,
      description: "Whether the requested target is currently visible in the frame.",
    },
    boundingBox: {
      type: Type.ARRAY,
      description: "Bounding box of the target if visible [ymin, xmin, ymax, xmax] scaled 0-1000. If not visible, return empty array.",
      items: { type: Type.INTEGER }
    }
  },
  required: ["action", "reasoning", "targetVisible"],
};

export const getNavCommand = async (imageBase64: string, targetDescription: string): Promise<VisionResponse> => {
  try {
    // Ensure we strip the prefix correctly
    const base64Data = imageBase64.replace(/^data:image\/(png|jpeg);base64,/, "");

    const prompt = `
      You are the visual cortex (SAM2) and motor controller for a hunter-seeker robot.
      
      MISSION: Find, Lock On, and Move Towards the "${targetDescription}".
      
      INPUT DATA: 
      - Front Camera Feed.
      - Coordinate System: X axis 0 (Left) to 1000 (Right). Center is 500.
      
      BEHAVIOR LOOP:
      1. SEARCH (Target Not Visible):
         - Output "SCAN".
      
      2. ACQUIRE (Target Visible but not Centered):
         - If Target Center X < 400: Output "LEFT". (Target is to the left, rotate left to center it).
         - If Target Center X > 600: Output "RIGHT". (Target is to the right, rotate right to center it).
         
      3. APPROACH (Target Visible and Centered):
         - If Target Center X is between 400 and 600:
           - CHECK DISTANCE:
             - If Target Height < 800 (It is far away): Output "FORWARD". (Drive towards it).
             - If Target Height >= 800 (It is filling the screen): Output "STOP". (Target Reached).
      
      CRITICAL INSTRUCTION:
      - Do not be too hesitant. If the target is roughly in front of you (X=400-600), CHARGE FORWARD.
      - If you see the target at the edge, turn quickly to face it.
      
      Output strictly in JSON.
    `;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: {
        parts: [
          { inlineData: { mimeType: "image/jpeg", data: base64Data } },
          { text: prompt }
        ]
      },
      config: {
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
        temperature: 0.1, 
      }
    });

    if (response.text) {
      const data = JSON.parse(response.text) as VisionResponse;
      return data;
    }

    throw new Error("No response text from Gemini");

  } catch (error) {
    console.error("Gemini Vision Error:", error);
    
    // Check for specific API key errors
    let errorMessage = "Signal interference. Recalibrating...";
    if (error instanceof Error) {
      if (error.message.includes("API_KEY") || error.message.includes("api key") || error.message.includes("authentication")) {
        errorMessage = "API Key Error: Check .env.local configuration";
      } else if (error.message.includes("quota") || error.message.includes("rate limit")) {
        errorMessage = "API quota exceeded. Please check your Gemini API usage.";
      }
    }
    
    return {
      action: ActionType.SCAN,
      reasoning: errorMessage,
      targetVisible: false
    };
  }
};
