import React, { useRef, useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { PerspectiveCamera } from '@react-three/drei';
import { ActionType } from '../../types';

interface AgentProps {
  action: ActionType;
  onUpdateCamera: (leftCam: THREE.Camera, rightCam: THREE.Camera, useRearView: boolean) => void;
  targetPosition: [number, number, number] | null;
  confidence: number;
  onCameraRefsReady?: (leftCamRef: React.RefObject<THREE.PerspectiveCamera | null>, rightCamRef: React.RefObject<THREE.PerspectiveCamera | null>) => void;
}

// Agent properties
const AGENT_RADIUS = 0.4;
const COLLISION_COOLDOWN_TIME = 1.0;
const VIEW_SWITCH_COOLDOWN_TIME = 2.0;
const MASS = 10.0;
const MAX_THRUST = 5.0;
const DRAG_COEFFICIENT = 0.5;

export const Agent = React.forwardRef<THREE.Group, AgentProps>(({
  action,
  onUpdateCamera,
  targetPosition,
  confidence = 0.0
}, ref) => {
  const groupRef = useRef<THREE.Group>(null);
  const leftCamRef = useRef<THREE.PerspectiveCamera>(null);
  const rightCamRef = useRef<THREE.PerspectiveCamera>(null);
  const rearLeftCamRef = useRef<THREE.PerspectiveCamera>(null);
  const rearRightCamRef = useRef<THREE.PerspectiveCamera>(null);
  
  // Physics variables
  const velocity = useRef(0);
  const rotationVelocity = useRef(0);
  const acceleration = useRef(0);
  
  // State variables
  const collisionDetected = useRef(false);
  const collisionCooldown = useRef(0);
  const useRearView = useRef(false);
  const viewSwitchCooldown = useRef(0);
  const straightLineMode = useRef(false);
  
  // Exploration and pathfinding state
  const explorationMode = useRef(false);
  const explorationStartTime = useRef(0);
  const lastRotationAngle = useRef(0);
  const totalRotation = useRef(0);
  const scanRotation = useRef(0);
  const explorationPhase = useRef(0);
  
  // Pathfinding state
  const pathfindingMode = useRef(false);
  const currentPath = useRef<[number, number][]>([]);
  const currentPathIndex = useRef(0);
  const pathfindingGrid = useRef<number[][]>([]);
  const wallGapCenter = useRef<[number, number]>([0, 0]); // Gap is at x=0, z=0
  const agentSide = useRef<'north' | 'south'>('north'); // Which side of wall agent is on
  
  // Location and thinking state
  const lastLocationUpdate = useRef(0);
  const lastThinkingUpdate = useRef(0);

  useEffect(() => {
    if (leftCamRef.current && rightCamRef.current && rearLeftCamRef.current && rearRightCamRef.current) {
      onUpdateCamera(leftCamRef.current, rightCamRef.current, useRearView.current);
    }
  }, [onUpdateCamera]);

  // Function to flip commands when rear view is active
  const flipCommand = (cmd: ActionType): ActionType => {
    if (!useRearView.current) return cmd;
    
    switch (cmd) {
      case ActionType.FORWARD:
        return ActionType.FORWARD; // Movement direction handled by translateZ sign
      case ActionType.LEFT:
        return ActionType.RIGHT; // LEFT becomes RIGHT when looking backward
      case ActionType.RIGHT:
        return ActionType.LEFT; // RIGHT becomes LEFT when looking backward
      case ActionType.SCAN:
        return ActionType.SCAN;
      case ActionType.STOP:
        return ActionType.STOP;
      default:
        return cmd;
    }
  };

  // Check for collisions with walls and objects
  const checkCollisions = (agentPos: THREE.Vector3, targets: Array<{position: [number, number, number]}>): boolean => {
    // Check collision with central wall at z=0 with gap in middle
    const wallZ = 0;
    const wallSegmentHalfWidth = 8.5;
    const gapHalfWidth = 3;
    
    const leftWallCenterX = -(wallSegmentHalfWidth + gapHalfWidth);
    const rightWallCenterX = wallSegmentHalfWidth + gapHalfWidth;
    
    // If agent is near the central wall
    if (Math.abs(agentPos.z - wallZ) < AGENT_RADIUS + 0.25) {
      // Check if agent is trying to go through solid wall (not gap)
      if (Math.abs(agentPos.x - leftWallCenterX) < wallSegmentHalfWidth + AGENT_RADIUS) {
        return true; // Collision with left wall segment
      }
      if (Math.abs(agentPos.x - rightWallCenterX) < wallSegmentHalfWidth + AGENT_RADIUS) {
        return true; // Collision with right wall segment
      }
      // Gap is at x=0 ±3, so if agent is within gap area, no collision
      if (Math.abs(agentPos.x) < gapHalfWidth) {
        return false; // In gap area, no collision
      }
    }
    
    // Check collision with boundary walls at ±14
    const boundary = 14;
    const wallThickness = 0.5;
    
    // North wall at z=14
    if (Math.abs(agentPos.z - boundary) < AGENT_RADIUS + wallThickness/2 && 
        Math.abs(agentPos.x) < boundary) {
      return true;
    }
    
    // South wall at z=-14
    if (Math.abs(agentPos.z + boundary) < AGENT_RADIUS + wallThickness/2 && 
        Math.abs(agentPos.x) < boundary) {
      return true;
    }
    
    // East wall at x=14
    if (Math.abs(agentPos.x - boundary) < AGENT_RADIUS + wallThickness/2 && 
        Math.abs(agentPos.z) < boundary) {
      return true;
    }
    
    // West wall at x=-14
    if (Math.abs(agentPos.x + boundary) < AGENT_RADIUS + wallThickness/2 && 
        Math.abs(agentPos.z) < boundary) {
      return true;
    }
    
    // Check collision with targets
    for (const target of targets) {
      const targetPos = new THREE.Vector3(...target.position);
      const distance = agentPos.distanceTo(targetPos);
      const minDistance = AGENT_RADIUS + 0.5;
      
      if (distance < minDistance) {
        return true;
      }
    }
    
    return false;
  };

  // Simple movement logic - always use positive velocity
  const updateMovement = (delta: number, effectiveAction: ActionType, agentPos: THREE.Vector3) => {
    const MAX_SPEED = pathfindingMode.current ? 7.5 : 2.5;
    const ROT_SPEED = 0.675; // 3x faster (was 0.225)
    
    let targetVel = 0;
    let targetRot = 0;

    switch (effectiveAction) {
      case ActionType.FORWARD:
        targetVel = MAX_SPEED;
        break;
      case ActionType.LEFT:
        targetRot = ROT_SPEED;
        targetVel = velocity.current * 0.5;
        break;
      case ActionType.RIGHT:
        targetRot = -ROT_SPEED;
        targetVel = velocity.current * 0.5;
        break;
      case ActionType.SCAN:
        targetRot = ROT_SPEED * 0.8 * 1.5; // 3x faster scanning too
        break;
      case ActionType.STOP:
      default:
        targetVel = 0;
        targetRot = 0;
        break;
    }

    velocity.current = THREE.MathUtils.lerp(velocity.current, targetVel, delta * 2);
    rotationVelocity.current = THREE.MathUtils.lerp(rotationVelocity.current, targetRot, delta * 4);
  };

  // Determine which side of the wall the agent is on
  const determineAgentSide = (agentZ: number): 'north' | 'south' => {
    return agentZ >= 0 ? 'north' : 'south';
  };

  // Determine which side of the wall the target is on
  const determineTargetSide = (targetZ: number): 'north' | 'south' => {
    return targetZ >= 0 ? 'north' : 'south';
  };

  // Simple BFS pathfinding to find path through wall gap
  const findPathThroughGap = (startX: number, startZ: number, targetSide: 'north' | 'south'): [number, number][] => {
    // Environment boundaries: ±14
    const BOUNDARY = 12; // Stay within safe boundaries
    
    // Gap is at x=0, z=0 with width 6 (from -3 to +3)
    const GAP_WIDTH = 6;
    const GAP_HALF = GAP_WIDTH / 2;
    
    const path: [number, number][] = [];
    
    // Current agent position
    path.push([startX, startZ]);
    
    // Determine which side we're starting from
    const startSide = determineAgentSide(startZ);
    
    // If we're already on target side, just explore that side
    if (startSide === targetSide) {
      // Move to center of current side (but stay within boundaries)
      const targetZ = targetSide === 'north' ? Math.min(10, BOUNDARY) : Math.max(-10, -BOUNDARY);
      path.push([0, targetZ]);
      return path;
    }
    
    // We need to go through the gap to the other side
    // CRITICAL: First move to x=0 (gap center line) while staying on current side
    // This ensures we approach the gap properly
    
    // Step 1: Move to gap alignment (x=0) while staying on current side
    const alignZ = startSide === 'north' ? 5 : -5; // Stay 5 units away from wall on current side
    path.push([0, alignZ]);
    
    // Step 2: Approach gap from safe distance
    const approachZ = startSide === 'north' ? 2 : -2; // Approach gap from 2 units away
    path.push([0, approachZ]);
    
    // Step 3: Move through gap center (x=0, z=0)
    path.push([0, 0]);
    
    // Step 4: Exit gap to other side
    const exitZ = targetSide === 'north' ? 2 : -2; // Exit gap to 2 units on other side
    path.push([0, exitZ]);
    
    // Step 5: Move to exploration area on other side (stay within boundaries)
    const exploreZ = targetSide === 'north' ? Math.min(8, BOUNDARY) : Math.max(-8, -BOUNDARY);
    path.push([0, exploreZ]);
    
    // Step 6: Spread out to explore (move away from wall)
    const spreadX = Math.min(Math.max(startX, -BOUNDARY), BOUNDARY);
    const spreadZ = targetSide === 'north' ? Math.min(10, BOUNDARY) : Math.max(-10, -BOUNDARY);
    path.push([spreadX, spreadZ]);
    
    return path;
  };

  // Calculate angle to face next waypoint
  const calculateAngleToWaypoint = (agentPos: THREE.Vector3, waypoint: [number, number]): number => {
    const dx = waypoint[0] - agentPos.x;
    const dz = waypoint[1] - agentPos.z;
    return Math.atan2(dx, dz); // Angle from positive z axis
  };

  // Follow path waypoints
  const followPath = (agentPos: THREE.Vector3, delta: number): ActionType => {
    if (currentPath.current.length === 0 || currentPathIndex.current >= currentPath.current.length) {
      pathfindingMode.current = false;
      return ActionType.STOP;
    }
    
    const currentWaypoint = currentPath.current[currentPathIndex.current];
    const distanceToWaypoint = Math.sqrt(
      Math.pow(agentPos.x - currentWaypoint[0], 2) + 
      Math.pow(agentPos.z - currentWaypoint[1], 2)
    );
    
    // If close to waypoint, move to next one
    if (distanceToWaypoint < 1.0) {
      currentPathIndex.current++;
      console.log(`Reached waypoint ${currentPathIndex.current - 1}/${currentPath.current.length}`);
      
      if (currentPathIndex.current >= currentPath.current.length) {
        pathfindingMode.current = false;
        console.log("Path completed!");
        return ActionType.STOP;
      }
    }
    
    // Calculate angle to waypoint
    const targetAngle = calculateAngleToWaypoint(agentPos, currentWaypoint);
    const currentAngle = groupRef.current?.rotation.y || 0;
    
    // Normalize angle difference
    let angleDiff = targetAngle - currentAngle;
    if (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
    if (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;
    
    // Determine turn direction
    if (Math.abs(angleDiff) < 0.1) {
      // Facing correct direction, move forward
      return ActionType.FORWARD;
    } else if (angleDiff > 0) {
      // Need to turn left
      return ActionType.LEFT;
    } else {
      // Need to turn right
      return ActionType.RIGHT;
    }
  };

  useFrame((state, delta) => {
    if (!groupRef.current) return;

    const agentPos = groupRef.current.position;
    const currentRotation = groupRef.current.rotation.y;
    
    // Track rotation for exploration - activate after 1 full rotation (2π radians)
    const rotationDelta = currentRotation - lastRotationAngle.current;
    lastRotationAngle.current = currentRotation;
    
    let normalizedDelta = rotationDelta;
    if (normalizedDelta > Math.PI) normalizedDelta -= 2 * Math.PI;
    if (normalizedDelta < -Math.PI) normalizedDelta += 2 * Math.PI;
    
    totalRotation.current += Math.abs(normalizedDelta);
    
    // Check if we should enter pathfinding mode (after 1 full scan rotation)
    // NEW LOGIC: Always go to opposite hemisphere after 1 scan rotation without finding target
    if (scanRotation.current > 2 * Math.PI && !pathfindingMode.current && targetPosition) {
      // Determine which side agent is on
      const currentAgentSide = determineAgentSide(agentPos.z);
      const targetZ = targetPosition[2];
      const targetSide = determineTargetSide(targetZ);
      
      console.log(`SITUATION AWARENESS: Agent at z=${agentPos.z.toFixed(1)} (${currentAgentSide}), Target at z=${targetZ.toFixed(1)} (${targetSide}), scanRotation=${scanRotation.current.toFixed(2)}`);
      
      // Always go to opposite side for systematic exploration after scanning current side
      const oppositeSide = currentAgentSide === 'north' ? 'south' : 'north';
      
      pathfindingMode.current = true;
      currentPath.current = findPathThroughGap(agentPos.x, agentPos.z, oppositeSide);
      currentPathIndex.current = 0;
      console.log(`PATHFINDING ACTIVATED! Going from ${currentAgentSide} to ${oppositeSide} side (systematic exploration)`);
      console.log(`Path waypoints: ${currentPath.current.map(p => `(${p[0].toFixed(1)},${p[1].toFixed(1)})`).join(' -> ')}`);
      console.log(`PATH: ${JSON.stringify(currentPath.current)}`);
      
      // Reset rear view to front for consistent path following
      useRearView.current = false;
      // Update camera callback to front cameras
      if (leftCamRef.current && rightCamRef.current && rearLeftCamRef.current && rearRightCamRef.current) {
        onUpdateCamera(leftCamRef.current, rightCamRef.current, false);
      }
      
      // Reset exploration mode if active
      explorationMode.current = false;
      totalRotation.current = 0; // Reset rotation counter
      scanRotation.current = 0; // Reset scan rotation
    }
    
    // Force trigger for testing - removed to prevent infinite logging
    
    // Also trigger exploration if no target at all (idle mode)
    if (totalRotation.current > 2 * Math.PI && !explorationMode.current && !targetPosition) {
      explorationMode.current = true;
      explorationStartTime.current = state.clock.elapsedTime;
      explorationPhase.current = 0;
      console.log(`Exploration mode activated! totalRotation: ${totalRotation.current.toFixed(2)}, no target assigned`);
      totalRotation.current = 0;
    }
    
    // Debug logging
    if (state.clock.elapsedTime % 2 < 0.1) { // Log every ~2 seconds
      console.log(`Situation debug: totalRotation=${totalRotation.current.toFixed(2)} (${(totalRotation.current / (2 * Math.PI)).toFixed(1)} turns), agentSide=${determineAgentSide(agentPos.z)}, pathfindingMode=${pathfindingMode.current}`);
    }
    
    // Handle pathfinding mode (priority over exploration)
    if (pathfindingMode.current) {
      const pathAction = followPath(agentPos, delta);
      
      console.log(`Pathfinding: action=${pathAction}, pos=(${agentPos.x.toFixed(1)},${agentPos.z.toFixed(1)}), waypoint ${currentPathIndex.current}/${currentPath.current.length - 1} (${currentPath.current[currentPathIndex.current]?.[0]?.toFixed(1) || 'N'},${currentPath.current[currentPathIndex.current]?.[1]?.toFixed(1) || 'N'})`);
      
      // Override the action from SAM2 with pathfinding action
      if (pathAction !== ActionType.STOP) {
        // Use pathfinding action instead of SAM2 action
        const effectiveAction = flipCommand(pathAction);
        updateMovement(delta, effectiveAction, agentPos);
        
        const currentWaypoint = currentPath.current[currentPathIndex.current];
        
        // Move directly towards waypoint
        const dirX = currentWaypoint[0] - agentPos.x;
        const dirZ = currentWaypoint[1] - agentPos.z;
        const dist = Math.sqrt(dirX * dirX + dirZ * dirZ);
        if (dist > 0) {
          const moveX = (dirX / dist) * velocity.current * delta;
          const moveZ = (dirZ / dist) * velocity.current * delta;
          groupRef.current.position.x += moveX;
          groupRef.current.position.z += moveZ;
        }

        // Set rotation to face the waypoint
        const targetAngle = calculateAngleToWaypoint(agentPos, currentWaypoint);
        groupRef.current.rotation.y = targetAngle;

        // Check for collisions during pathfinding mode
        if (collisionCooldown.current <= 0) {
          collisionDetected.current = checkCollisions(agentPos, []);
          
          if (collisionDetected.current) {
            collisionCooldown.current = COLLISION_COOLDOWN_TIME;
            console.log("Collision detected during pathfinding! Stopping pathfinding.");
            pathfindingMode.current = false;
            // Reset to stop action
            velocity.current = 0;
            rotationVelocity.current = 0;
          }
        }
        
        // Skip the rest of the movement logic for this frame
        return;
      } else {
        // Path completed, exit pathfinding mode
        pathfindingMode.current = false;
        totalRotation.current = 0; // Reset to prevent immediate retrigger
        console.log("Pathfinding completed, returning to normal operation");
      }
    }
    
    // Handle exploration mode (only if not in pathfinding mode)
    if (explorationMode.current && !pathfindingMode.current) {
      const explorationTime = state.clock.elapsedTime - explorationStartTime.current;
      
      // Intelligent exploration: move in expanding spiral pattern
      if (explorationPhase.current === 0) {
        // Phase 0: Move forward for 3 seconds
        velocity.current = 1.5;
        rotationVelocity.current = 0;
        
        if (explorationTime > 3.0) {
          explorationPhase.current = 1;
          explorationStartTime.current = state.clock.elapsedTime;
        }
      } else if (explorationPhase.current === 1) {
        // Phase 1: Turn 120 degrees (larger turn for better coverage)
        rotationVelocity.current = 1.0;
        velocity.current = 0.3;
        
        if (explorationTime > 1.2) {
          explorationPhase.current = 0;
          explorationStartTime.current = state.clock.elapsedTime;
          // Don't reset rotation counter - let it accumulate for situation awareness
        }
      }
      
      // Exit exploration if target is assigned
      if (targetPosition) {
        explorationMode.current = false;
        console.log("Exploration stopped - target assigned");
      }
    }
    
    // Update cooldowns
    if (collisionCooldown.current > 0) {
      collisionCooldown.current -= delta;
    }
    if (viewSwitchCooldown.current > 0) {
      viewSwitchCooldown.current -= delta;
    }
    
    // Check for collisions (simplified - using empty targets array for now)
    if (collisionCooldown.current <= 0) {
      collisionDetected.current = checkCollisions(agentPos, []);
      
      if (collisionDetected.current) {
        collisionCooldown.current = COLLISION_COOLDOWN_TIME;
        
        // Reverse direction when collision detected
        const reverseSpeed = Math.min(2.5, Math.abs(velocity.current) + 1.5);
        velocity.current = reverseSpeed;
        
        // Reduce rotation to move straight back
        rotationVelocity.current *= 0.3;
      }
    }

    // Get flipped command if rear view is active
    const effectiveAction = flipCommand(action);
    
    // Accumulate scan rotation only during SCAN action
    if (action === ActionType.SCAN) {
      scanRotation.current += Math.abs(normalizedDelta);
    } else {
      // Reset scan rotation when not scanning (e.g., tracking object)
      scanRotation.current = 0;
    }
    
    // Update movement
    updateMovement(delta, effectiveAction, agentPos);

    // Apply movement
    groupRef.current.rotation.y += rotationVelocity.current * delta;
    
    // Movement direction based on camera view
    if (useRearView.current) {
      // When rear view is active, move backward
      groupRef.current.translateZ(velocity.current * delta);
    } else {
      // When front view is active, move forward
      groupRef.current.translateZ(-velocity.current * delta);
    }

    // Soft boundary collision
    const pos = groupRef.current.position;
    const boundary = 14;
    
    if (Math.abs(pos.x) > boundary - AGENT_RADIUS) {
      pos.x = THREE.MathUtils.clamp(pos.x, -boundary + AGENT_RADIUS, boundary - AGENT_RADIUS);
      velocity.current *= 0.5;
      rotationVelocity.current += (pos.x > 0 ? 0.5 : -0.5);
    }
    
    if (Math.abs(pos.z) > boundary - AGENT_RADIUS) {
      pos.z = THREE.MathUtils.clamp(pos.z, -boundary + AGENT_RADIUS, boundary - AGENT_RADIUS);
      velocity.current *= 0.5;
      rotationVelocity.current += (pos.z > 0 ? 0.5 : -0.5);
    }
  });

  // Visual status light color
  const eyeColor = useMemo(() => {
    if (collisionDetected.current) {
      return '#ff0000';
    }
    if (useRearView.current) {
      return '#ff00ff';
    }
    if (straightLineMode.current && confidence > 0.6) {
      return '#00ffff';
    }
    switch (action) {
      case ActionType.FORWARD: return '#00ff00';
      case ActionType.STOP: return '#ff0000';
      case ActionType.SCAN: return '#ffff00';
      case ActionType.LEFT:
      case ActionType.RIGHT: return '#ff00ff';
      default: return '#00ccff';
    }
  }, [action, confidence, straightLineMode.current, collisionDetected.current, useRearView.current]);

  return (
    <group ref={groupRef}>
      {/* Robot Body */}
      <mesh position={[0, 0.4, 0]} castShadow>
        <boxGeometry args={[0.5, 0.2, 0.6]} />
        <meshStandardMaterial color="#222" metalness={0.9} roughness={0.1} />
      </mesh>
      
      {/* Wheels */}
      <mesh position={[0.3, 0.2, 0]} castShadow>
        <boxGeometry args={[0.1, 0.2, 0.5]} />
        <meshStandardMaterial color="#111" />
      </mesh>
      <mesh position={[-0.3, 0.2, 0]} castShadow>
        <boxGeometry args={[0.1, 0.2, 0.5]} />
        <meshStandardMaterial color="#111" />
      </mesh>

      {/* Head/Camera */}
      <group position={[0, 0.7, 0]}>
        <mesh castShadow>
          <boxGeometry args={[0.3, 0.25, 0.4]} />
          <meshStandardMaterial color="#444" />
        </mesh>
        
        {/* Front Eye */}
        <mesh position={[0, 0, -0.21]}>
          <planeGeometry args={[0.25, 0.08]} />
          <meshBasicMaterial color={eyeColor} toneMapped={false} />
        </mesh>
        
        {/* Rear Eye */}
        <mesh position={[0, 0, 0.21]} rotation={[0, Math.PI, 0]}>
          <planeGeometry args={[0.25, 0.08]} />
          <meshBasicMaterial color={useRearView.current ? '#ff00ff' : '#333333'} toneMapped={false} />
        </mesh>
        
        {/* Antenna */}
        <mesh position={[0, 0.2, 0]} castShadow>
          <cylinderGeometry args={[0.02, 0.02, 0.3]} />
          <meshStandardMaterial color="#00ccff" emissive="#00ccff" emissiveIntensity={0.5} />
        </mesh>
        <mesh position={[0, 0.35, 0]} castShadow>
          <sphereGeometry args={[0.04, 16, 16]} />
          <meshStandardMaterial color="#00ffff" emissive="#00ffff" emissiveIntensity={1.0} />
        </mesh>
        
        {/* Front Stereo Cameras */}
        <PerspectiveCamera 
          ref={leftCamRef}
          makeDefault={false}
          position={[-0.1, 0, -0.2]}
          rotation={[0, 0, 0]}
          fov={110}
          near={0.1}
          far={30}
        />
        
        <PerspectiveCamera 
          ref={rightCamRef}
          makeDefault={false}
          position={[0.1, 0, -0.2]}
          rotation={[0, 0, 0]}
          fov={110}
          near={0.1}
          far={30}
        />
        
        {/* Rear Stereo Cameras */}
        <PerspectiveCamera 
          ref={rearLeftCamRef}
          makeDefault={false}
          position={[-0.1, 0, 0.2]}
          rotation={[0, Math.PI, 0]}
          fov={110}
          near={0.1}
          far={30}
        />
        
        <PerspectiveCamera 
          ref={rearRightCamRef}
          makeDefault={false}
          position={[0.1, 0, 0.2]}
          rotation={[0, Math.PI, 0]}
          fov={110}
          near={0.1}
          far={30}
        />
      </group>
      
      {/* Light Beams */}
      <group>
        {/* Front lights */}
        <mesh position={[0.2, 0.5, -0.1]} rotation={[0, Math.PI / 12, 0]}>
          <coneGeometry args={[0.05, 0.8, 8]} />
          <meshBasicMaterial color="#00ffff" transparent opacity={0.3} side={THREE.BackSide} />
        </mesh>
        <pointLight position={[0.2, 0.5, -0.1]} color="#00ffff" distance={3} intensity={0.5} />
        
        <mesh position={[-0.2, 0.5, -0.1]} rotation={[0, -Math.PI / 12, 0]}>
          <coneGeometry args={[0.05, 0.8, 8]} />
          <meshBasicMaterial color="#00ffff" transparent opacity={0.3} side={THREE.BackSide} />
        </mesh>
        <pointLight position={[-0.2, 0.5, -0.1]} color="#00ffff" distance={3} intensity={0.5} />
        
        <mesh position={[0, 0.5, -0.1]} rotation={[0, 0, 0]}>
          <coneGeometry args={[0.06, 1.0, 8]} />
          <meshBasicMaterial color="#ffffff" transparent opacity={0.2} side={THREE.BackSide} />
        </mesh>
        <pointLight position={[0, 0.5, -0.1]} color="#ffffff" distance={4} intensity={0.8} />
        
        {/* Rear light */}
        <mesh position={[0, 0.5, 0.1]} rotation={[0, Math.PI, 0]}>
          <coneGeometry args={[0.04, 0.6, 8]} />
          <meshBasicMaterial color={useRearView.current ? "#ff00ff" : "#333333"} transparent opacity={useRearView.current ? 0.3 : 0.1} side={THREE.BackSide} />
        </mesh>
        <pointLight position={[0, 0.5, 0.1]} color={useRearView.current ? "#ff00ff" : "#333333"} distance={useRearView.current ? 3 : 1} intensity={useRearView.current ? 0.5 : 0.1} />
      </group>
    </group>
  );
});
