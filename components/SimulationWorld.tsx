import React, { useRef, useState, useEffect, useMemo } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { PerspectiveCamera, useTexture, Grid, Environment, Stars, ContactShadows, OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { AgentState, ActionType, TargetShape } from '../types';

interface SimulationWorldProps {
  target: TargetShape;
  isRunning: boolean;
  onCaptureFrame: (blob: string) => void;
  onAgentUpdate: (state: Partial<AgentState>) => void;
  agentAction: ActionType;
  confidence?: number; // 0.0 to 1.0 confidence score
}

// Reusable Materials
const floorMaterial = new THREE.MeshStandardMaterial({ 
  color: '#1a1a1a', 
  roughness: 0.8, 
  metalness: 0.2 
});

const targets = [
  { type: 'Red Cube', color: '#ff0040', position: [5, 0.5, 5], geometry: 'box' },
  { type: 'Pink Sphere', color: '#ff69b4', position: [-4, 0.5, 4], geometry: 'sphere' },
  { type: 'Green Cone', color: '#00ff40', position: [2, 0.5, -6], geometry: 'cone' },
  { type: 'Yellow Cylinder', color: '#ffd700', position: [-6, 0.5, -2], geometry: 'cylinder' },
] as const;

const TargetObject: React.FC<{ data: typeof targets[number]; isSelected: boolean }> = ({ data, isSelected }) => {
  const meshRef = useRef<THREE.Mesh>(null);
  
  useFrame((state) => {
    if (meshRef.current) {
      // Only rotate if this target is selected
      if (isSelected) {
        meshRef.current.rotation.y += 0.01;
      }
      meshRef.current.position.y = 0.5 + Math.sin(state.clock.elapsedTime * 2) * 0.1;
    }
  });

  return (
    <group position={data.position as [number, number, number]}>
        <mesh ref={meshRef} castShadow receiveShadow>
          {data.geometry === 'box' && <boxGeometry args={[1, 1, 1]} />}
          {data.geometry === 'sphere' && <sphereGeometry args={[0.6, 32, 32]} />}
          {data.geometry === 'cone' && <coneGeometry args={[0.6, 1.2, 32]} />}
          {data.geometry === 'cylinder' && <cylinderGeometry args={[0.5, 0.5, 1, 32]} />}
          <meshStandardMaterial color={data.color} emissive={data.color} emissiveIntensity={0.5} />
        </mesh>
        <pointLight color={data.color} distance={3} intensity={5} />
    </group>
  );
};

// The "Physical" Agent in the world
const Agent = ({ 
  action, 
  onUpdateCamera,
  targetPosition,
  confidence = 0.0
}: { 
  action: ActionType, 
  onUpdateCamera: (cam: THREE.Camera) => void,
  targetPosition: [number, number, number] | null,
  confidence: number
}) => {
  const groupRef = useRef<THREE.Group>(null);
  const camRef = useRef<THREE.PerspectiveCamera>(null);
  
  // Physics variables
  const velocity = useRef(0);
  const rotationVelocity = useRef(0);
  const acceleration = useRef(0);
  
  // Confidence-based straight line movement state
  const straightLineMode = useRef(false);
  const straightLineDistance = useRef(0);
  const initialDistanceToTarget = useRef(0);
  
  // Agent properties
  const MASS = 10.0; // kg
  const MAX_THRUST = 5.0; // Newtons
  const DRAG_COEFFICIENT = 0.5;

  useEffect(() => {
    if (camRef.current) {
      onUpdateCamera(camRef.current);
    }
  }, [onUpdateCamera]);

  useFrame((_, delta) => {
    if (!groupRef.current) return;

    // Calculate distance to target if target exists
    let distanceToTarget = Infinity;
    let directionToTarget = new THREE.Vector3();
    
    if (targetPosition) {
      const agentPos = groupRef.current.position;
      const targetPos = new THREE.Vector3(...targetPosition);
      distanceToTarget = agentPos.distanceTo(targetPos);
      directionToTarget = targetPos.clone().sub(agentPos).normalize();
      
      // Calculate angle between agent forward direction and target direction
      const agentForward = new THREE.Vector3(0, 0, -1).applyQuaternion(groupRef.current.quaternion);
      const angleToTarget = agentForward.angleTo(directionToTarget);
      
      // Determine if target is to the left or right
      const cross = new THREE.Vector3().crossVectors(agentForward, directionToTarget);
      const isTargetLeft = cross.y > 0;
      
      // CONFIDENCE-BASED STRAIGHT LINE MOVEMENT
      // When confidence > 60%, move in a straight line for 50% of the remaining distance
      if (confidence > 0.6 && action === ActionType.FORWARD && distanceToTarget > 1.0) {
        if (!straightLineMode.current) {
          // Enter straight line mode
          straightLineMode.current = true;
          initialDistanceToTarget.current = distanceToTarget;
          // Ensure minimum straight line distance of 2.0 units to make it noticeable
          straightLineDistance.current = Math.max(2.0, distanceToTarget * 0.5); // 50% of remaining distance, min 2.0
          console.log(`ENTERING STRAIGHT LINE MODE: distance=${distanceToTarget.toFixed(2)}, straightLineDistance=${straightLineDistance.current.toFixed(2)}`);
        }
        
        if (straightLineMode.current && straightLineDistance.current > 0) {
          // In straight line mode - move forward without turning corrections
          // Use higher speed in straight line mode for more noticeable movement
          const DESIRED_SPEED = Math.min(3.0, distanceToTarget * 0.8); // Faster in straight line mode
          const speedError = DESIRED_SPEED - velocity.current;
          
          // PID-like control (simplified) - more aggressive in straight line mode
          const thrustForce = Math.min(MAX_THRUST * 1.5, Math.max(-MAX_THRUST, speedError * MASS * 3));
          acceleration.current = thrustForce / MASS;
          
          // Apply drag
          const dragForce = DRAG_COEFFICIENT * velocity.current * velocity.current;
          acceleration.current -= dragForce / MASS;
          
          // Update velocity using acceleration
          velocity.current += acceleration.current * delta;
          velocity.current = Math.max(0, Math.min(3.0, velocity.current)); // Higher max speed in straight line mode
          
          // Drastically reduce rotation to maintain straight line
          rotationVelocity.current *= (1 - 0.95 * delta);
          
          // Update remaining straight line distance
          const distanceMoved = velocity.current * delta;
          straightLineDistance.current -= distanceMoved;
          
          if (straightLineDistance.current <= 0) {
            // Exit straight line mode
            straightLineMode.current = false;
            console.log(`EXITING STRAIGHT LINE MODE: moved ${(initialDistanceToTarget.current - distanceToTarget).toFixed(2)} units`);
          } else {
            console.log(`STRAIGHT LINE MODE: remaining=${straightLineDistance.current.toFixed(2)}, velocity=${velocity.current.toFixed(2)}`);
          }
        } else {
          // Normal physics-based movement calculation
          const DESIRED_SPEED = Math.min(2.5, distanceToTarget * 0.5); // Speed proportional to distance
          const speedError = DESIRED_SPEED - velocity.current;
          
          // PID-like control (simplified)
          const thrustForce = Math.min(MAX_THRUST, Math.max(-MAX_THRUST, speedError * MASS * 2));
          acceleration.current = thrustForce / MASS;
          
          // Apply drag
          const dragForce = DRAG_COEFFICIENT * velocity.current * velocity.current;
          acceleration.current -= dragForce / MASS;
          
          // Update velocity using acceleration
          velocity.current += acceleration.current * delta;
          velocity.current = Math.max(0, Math.min(2.5, velocity.current)); // Clamp to max speed
        }
      } else if (action === ActionType.LEFT || action === ActionType.RIGHT) {
        // Exit straight line mode when turning
        straightLineMode.current = false;
        
        // Rotational physics - 20% faster
        const ROT_ACCEL = 0.6; // Increased by 20% (0.5 * 1.2 = 0.6)
        const ROT_DRAG = 0.8;
        
        if (action === ActionType.LEFT) {
          rotationVelocity.current += ROT_ACCEL * delta;
        } else if (action === ActionType.RIGHT) {
          rotationVelocity.current -= ROT_ACCEL * delta;
        }
        
        // Apply rotational drag
        rotationVelocity.current *= (1 - ROT_DRAG * delta);
        
        // Clamp rotation speed - 20% higher max rotation
        rotationVelocity.current = THREE.MathUtils.clamp(rotationVelocity.current, -0.36, 0.36); // 0.3 * 1.2 = 0.36
        
        // Slow down forward movement during turns
        velocity.current *= (1 - 0.5 * delta);
      } else if (action === ActionType.SCAN) {
        // Exit straight line mode when scanning
        straightLineMode.current = false;
        
        // Gentle scanning rotation - 20% faster
        rotationVelocity.current = 0.12; // 0.1 * 1.2 = 0.12
        velocity.current *= (1 - 0.8 * delta); // Slow down while scanning
      } else if (action === ActionType.STOP) {
        // Exit straight line mode when stopping
        straightLineMode.current = false;
        
        // Decelerate to stop
        const brakingForce = Math.min(MAX_THRUST, velocity.current * MASS * 5);
        acceleration.current = -brakingForce / MASS;
        velocity.current += acceleration.current * delta;
        velocity.current = Math.max(0, velocity.current);
        rotationVelocity.current *= (1 - 0.9 * delta);
      } else {
        // IDLE or other actions - natural deceleration
        straightLineMode.current = false;
        velocity.current *= (1 - 0.5 * delta);
        rotationVelocity.current *= (1 - 0.8 * delta);
      }
    } else {
      // No target - use simpler movement
      straightLineMode.current = false;
      
      const MAX_SPEED = 2.5;
      const ROT_SPEED = 0.15;
      
      let targetVel = 0;
      let targetRot = 0;

      switch (action) {
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
          targetRot = ROT_SPEED * 0.8 * 1.2; // 20% faster scanning
          break;
        case ActionType.STOP:
        default:
          targetVel = 0;
          targetRot = 0;
          break;
      }

      velocity.current = THREE.MathUtils.lerp(velocity.current, targetVel, delta * 2);
      rotationVelocity.current = THREE.MathUtils.lerp(rotationVelocity.current, targetRot, delta * 4);
    }

    // Apply movement
    groupRef.current.rotation.y += rotationVelocity.current * delta;
    groupRef.current.translateZ(-velocity.current * delta);

    // Collision boundary
    const pos = groupRef.current.position;
    pos.x = THREE.MathUtils.clamp(pos.x, -14, 14);
    pos.z = THREE.MathUtils.clamp(pos.z, -14, 14);
  });

  // Visual status light color
  const eyeColor = useMemo(() => {
    if (straightLineMode.current && confidence > 0.6) {
      return '#00ffff'; // Cyan - STRAIGHT LINE MODE
    }
    switch (action) {
        case ActionType.FORWARD: return '#00ff00'; // Green - CHARGE
        case ActionType.STOP: return '#ff0000'; // Red - STOP
        case ActionType.SCAN: return '#ffff00'; // Yellow - SEARCHING
        case ActionType.LEFT:
        case ActionType.RIGHT: return '#ff00ff'; // Magenta - TRACKING
        default: return '#00ccff'; // Cyan
    }
  }, [action, confidence, straightLineMode.current]);

  return (
    <group ref={groupRef}>
      {/* Robot Body Visuals */}
      <mesh position={[0, 0.4, 0]} castShadow>
        <boxGeometry args={[0.5, 0.2, 0.6]} />
        <meshStandardMaterial color="#222" metalness={0.9} roughness={0.1} />
      </mesh>
      
      {/* Wheels/Tracks representation */}
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
        
        {/* Eye/Sensor Array - Positioned on -Z face (Front) */}
        <mesh position={[0, 0, -0.21]}>
           <planeGeometry args={[0.25, 0.08]} />
           <meshBasicMaterial color={eyeColor} toneMapped={false} />
        </mesh>
        
        {/* The actual camera the agent "sees" through */}
        <PerspectiveCamera 
            ref={camRef} 
            makeDefault={false} // We handle rendering manually
            // Camera looks down its own -Z axis by default.
            // Since our agent moves along -Z, we want 0 rotation.
            position={[0, 0, -0.2]} 
            rotation={[0, 0, 0]} 
            fov={80} // Wide angle lens for robot
            near={0.1}
            far={30}
        />
      </group>
    </group>
  );
};

// Scene Manager to handle off-screen rendering for "Vision"
const SceneManager = ({ 
  isRunning, 
  onCaptureFrame, 
  agentAction,
  agentCamRef 
}: { 
  isRunning: boolean; 
  onCaptureFrame: (b: string) => void;
  agentAction: ActionType;
  agentCamRef: React.MutableRefObject<THREE.Camera | null>;
}) => {
  const { gl, scene } = useThree();
  
  // We need a render target to capture the agent's view without messing up the main canvas
  const renderTarget = useMemo(() => new THREE.WebGLRenderTarget(512, 512), []);
  
  // Ref to throttle vision capture
  const lastCaptureTime = useRef(0);
  const CAPTURE_INTERVAL = 600; // 600ms capture rate for better responsiveness

  useFrame((state) => {
    if (!isRunning || !agentCamRef.current) return;

    const now = state.clock.elapsedTime * 1000;
    if (now - lastCaptureTime.current > CAPTURE_INTERVAL) {
      lastCaptureTime.current = now;

      // 1. Save current render state
      const currentRenderTarget = gl.getRenderTarget();
      const currentXrEnabled = gl.xr.enabled;
      
      // 2. Render Agent's View to texture
      gl.xr.enabled = false;
      gl.setRenderTarget(renderTarget);
      gl.render(scene, agentCamRef.current);
      
      // 3. Read pixels
      const width = renderTarget.width;
      const height = renderTarget.height;
      const buffer = new Uint8Array(width * height * 4);
      gl.readRenderTargetPixels(renderTarget, 0, 0, width, height, buffer);
      
      // 4. Convert to Base64 (A bit expensive, but simplest for this architecture without backend)
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (context) {
        const imageData = context.createImageData(width, height);
        // Flip Y for WebGL -> Canvas
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const srcIdx = ((height - 1 - y) * width + x) * 4;
                const dstIdx = (y * width + x) * 4;
                imageData.data[dstIdx] = buffer[srcIdx];
                imageData.data[dstIdx + 1] = buffer[srcIdx + 1];
                imageData.data[dstIdx + 2] = buffer[srcIdx + 2];
                imageData.data[dstIdx + 3] = buffer[srcIdx + 3];
            }
        }
        context.putImageData(imageData, 0, 0);
        // High quality jpeg for vision model
        onCaptureFrame(canvas.toDataURL('image/jpeg', 0.8));
      }

      // 5. Restore state
      gl.setRenderTarget(currentRenderTarget);
      gl.xr.enabled = currentXrEnabled;
    }
  });

  return null;
};

// Simple orbit controls wrapper
const OrbitControlsWrapper = () => {
    return <OrbitControls makeDefault />;
}

export const SimulationWorld: React.FC<SimulationWorldProps> = (props) => {
  const agentCamRef = useRef<THREE.Camera | null>(null);

  return (
    <Canvas shadows className="bg-black">
      <PerspectiveCamera makeDefault position={[0, 15, 15]} fov={50} />
      <OrbitControlsWrapper />
      
      <ambientLight intensity={0.2} />
      <directionalLight 
        position={[10, 10, 5]} 
        intensity={1} 
        castShadow 
        shadow-mapSize={[1024, 1024]} 
      />
      <Stars radius={100} depth={50} count={5000} factor={4} saturation={0} fade speed={1} />

      {/* Environment */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.1, 0]} receiveShadow>
        <planeGeometry args={[50, 50]} />
        <primitive object={floorMaterial} />
      </mesh>
      <Grid infiniteGrid sectionSize={3} cellColor="#444" sectionColor="#00ccff" fadeDistance={30} />

      {/* Targets */}
      {targets.map((t, i) => (
        <TargetObject 
          key={i} 
          data={t} 
          isSelected={props.target === t.type}
        />
      ))}

      {/* Agent */}
      <Agent 
        action={props.agentAction} 
        onUpdateCamera={(cam) => { agentCamRef.current = cam; }}
        targetPosition={targets.find(t => t.type === props.target)?.position as [number, number, number] || null}
        confidence={props.confidence || 0.0}
      />

      {/* Logic */}
      <SceneManager 
        isRunning={props.isRunning} 
        onCaptureFrame={props.onCaptureFrame} 
        agentAction={props.agentAction}
        agentCamRef={agentCamRef}
      />
    </Canvas>
  );
};
