export enum ActionType {
  IDLE = 'IDLE',
  FORWARD = 'FORWARD',
  LEFT = 'LEFT',
  RIGHT = 'RIGHT',
  STOP = 'STOP',
  SCAN = 'SCAN'
}

export interface AgentState {
  position: [number, number, number];
  rotation: number; // Y-axis rotation in radians
  lastAction: ActionType;
  status: string;
}

export interface VisionResponse {
  action: ActionType;
  reasoning: string;
  targetVisible: boolean;
  confidence?: number; // 0.0 to 1.0 confidence score
  boundingBox?: [number, number, number, number]; // [ymin, xmin, ymax, xmax] 0-1000 scale
  distance?: number; // Distance to target in meters (stereo vision)
  angle?: number; // Angle to target in degrees (stereo vision)
}

export interface LogEntry {
  id: string;
  timestamp: string;
  message: string;
  type: 'info' | 'action' | 'vision' | 'error';
}

export type TargetShape = 'Red Cube' | 'Pink Sphere' | 'Green Cone' | 'Yellow Cylinder' | 'Skeleton Head';
