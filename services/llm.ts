import { ActionType, TargetShape } from '../types';

export interface LLMRequest {
  message: string;
  current_target?: TargetShape;
  available_targets: TargetShape[];
  agent_state?: {
    position: [number, number, number];
    rotation: number;
    lastAction: ActionType;
  };
}

export interface LLMResponse {
  action: 'continue' | 'switch_target' | 'complete' | 'error';
  target?: TargetShape;
  reasoning: string;
  confidence: number;
  next_actions?: string[];
}

export interface ChainedMission {
  id: string;
  steps: MissionStep[];
  current_step: number;
  status: 'pending' | 'active' | 'completed' | 'failed';
}

export interface MissionStep {
  target: TargetShape;
  condition: 'reached' | 'detected';
  actions: ActionType[];
}

/**
 * LLM Service for chained mission planning
 * Connects to localhost:1234/v1 (compatible with OpenAI API)
 */
export class LLMService {
  private baseUrl: string;
  private apiKey: string | null;

  constructor(baseUrl: string = 'http://localhost:1234/v1', apiKey: string | null = null) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  /**
   * Parse natural language into target sequence
   * Example: "Go to the sphere" -> [Pink Sphere]
   * Example: "Go to sphere then cube" -> [Pink Sphere, Red Cube]
   */
  async parseMission(missionText: string, availableTargets: TargetShape[]): Promise<ChainedMission> {
    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` })
        },
        body: JSON.stringify({
          model: 'google/gemma-3n-e4b',
          messages: [
            {
              role: 'system',
              content: `You are an action interpreter for a visual navigation robot. 
              The robot can detect and navigate to these targets: ${availableTargets.join(', ')}.
              
              Extract ONLY the target names mentioned in the user's message.
              Return a JSON array of target names in the order they are mentioned.
              
              Example: "Go to the sphere" -> ["Pink Sphere"]
              Example: "Go to sphere then cube" -> ["Pink Sphere", "Red Cube"]
              Example: "Find the cone" -> ["Green Cone"]
              
              Respond with a JSON object in this exact format:
              {
                "targets": ["TargetName1", "TargetName2"]
              }
              
              IMPORTANT: Only include targets mentioned. Don't add extra targets.`
            },
            {
              role: 'user',
              content: missionText
            }
          ],
          temperature: 0.1,
          response_format: { type: "json_object" }
        })
      });

      if (!response.ok) {
        throw new Error(`LLM API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      const content = data.choices[0].message.content;
      const parsed = JSON.parse(content);

      const targets = parsed.targets || [];
      
      return {
        id: `mission_${Date.now()}`,
        steps: targets.map((target: string) => ({
          target: target as TargetShape,
          condition: 'reached' as const,
          actions: [ActionType.SCAN, ActionType.FORWARD, ActionType.STOP]
        })),
        current_step: 0,
        status: 'pending'
      };

    } catch (error) {
      console.error('LLM mission parsing failed:', error);
      
      // Fallback: simple keyword-based parsing
      return this.fallbackParseMission(missionText, availableTargets);
    }
  }

  /**
   * Fallback parsing when LLM is unavailable
   */
  private fallbackParseMission(missionText: string, availableTargets: TargetShape[]): ChainedMission {
    const steps: MissionStep[] = [];
    const text = missionText.toLowerCase();
    
    // Simple keyword matching
    if (text.includes('sphere') || text.includes('pink')) {
      steps.push({
        target: 'Pink Sphere',
        condition: 'reached',
        actions: [ActionType.SCAN, ActionType.FORWARD, ActionType.STOP]
      });
    }
    
    if (text.includes('cube') || text.includes('red') || text.includes('square')) {
      steps.push({
        target: 'Red Cube',
        condition: 'reached',
        actions: [ActionType.SCAN, ActionType.FORWARD, ActionType.STOP]
      });
    }
    
    if (text.includes('cone') || text.includes('green')) {
      steps.push({
        target: 'Green Cone',
        condition: 'reached',
        actions: [ActionType.SCAN, ActionType.FORWARD, ActionType.STOP]
      });
    }
    
    if (text.includes('cylinder') || text.includes('yellow')) {
      steps.push({
        target: 'Yellow Cylinder',
        condition: 'reached',
        actions: [ActionType.SCAN, ActionType.FORWARD, ActionType.STOP]
      });
    }
    
    // If no specific targets mentioned, use all in order
    if (steps.length === 0) {
      steps.push(...availableTargets.map(target => ({
        target,
        condition: 'reached' as const,
        actions: [ActionType.SCAN, ActionType.FORWARD, ActionType.STOP]
      })));
    }

    return {
      id: `fallback_mission_${Date.now()}`,
      steps,
      current_step: 0,
      status: 'pending'
    };
  }

  /**
   * Get next action based on current mission state
   */
  async getNextAction(
    mission: ChainedMission,
    currentTarget: TargetShape,
    targetVisible: boolean,
    confidence: number
  ): Promise<{ action: ActionType; reasoning: string; shouldSwitchTarget: boolean }> {
    
    const currentStep = mission.steps[mission.current_step];
    
    if (!currentStep) {
      return {
        action: ActionType.STOP,
        reasoning: 'Mission completed or invalid step',
        shouldSwitchTarget: false
      };
    }

    // Check if we should switch to next step
    if (currentStep.target === currentTarget) {
      if (currentStep.condition === 'reached' && confidence > 0.8) {
        // Target reached with high confidence
        if (mission.current_step < mission.steps.length - 1) {
          // Move to next step
          return {
            action: ActionType.STOP,
            reasoning: `Target ${currentTarget} reached. Moving to next target: ${mission.steps[mission.current_step + 1].target}`,
            shouldSwitchTarget: true
          };
        } else {
          // Final target reached
          return {
            action: ActionType.STOP,
            reasoning: 'Mission completed successfully!',
            shouldSwitchTarget: false
          };
        }
      }
    }

    // Continue with current target
    if (targetVisible) {
      if (confidence > 0.6) {
        return {
          action: ActionType.FORWARD,
          reasoning: `Moving toward ${currentTarget} with confidence ${(confidence * 100).toFixed(0)}%`,
          shouldSwitchTarget: false
        };
      } else {
        return {
          action: ActionType.SCAN,
          reasoning: `Target ${currentTarget} detected but low confidence. Scanning...`,
          shouldSwitchTarget: false
        };
      }
    } else {
      return {
        action: ActionType.SCAN,
        reasoning: `Searching for ${currentTarget}...`,
        shouldSwitchTarget: false
      };
    }
  }
}

// Singleton instance
export const llmService = new LLMService();
