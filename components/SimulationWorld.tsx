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
  { type: 'Skeleton Head', color: '#f0f0f0', position: [6, 0.5, -8], geometry: 'skeleton' },
] as const;

const TargetObject: React.FC<{ 
  data: typeof targets[number]; 
  isSelected: boolean;
  onTargetReached?: () => void;
  agentPosition?: [number, number, number];
  agentAction?: ActionType;
}> = ({ data, isSelected, onTargetReached, agentPosition, agentAction }) => {
  const meshRef = useRef<THREE.Mesh>(null);
  const groupRef = useRef<THREE.Group>(null);
  const [isExploding, setIsExploding] = useState(false);
  const [explosionProgress, setExplosionProgress] = useState(0);
  const [isDestroyed, setIsDestroyed] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState<[number, number] | null>(null);
  const [position, setPosition] = useState<[number, number, number]>(data.position as [number, number, number]);
  
  // Check if target is reached (selected and agent is close OR agent has stopped)
  useEffect(() => {
    if (isSelected && onTargetReached && !isExploding && agentPosition) {
      // Calculate distance between agent and target
      const [ax, ay, az] = agentPosition;
      const [tx, ty, tz] = position;
      const distance = Math.sqrt((ax - tx) ** 2 + (ay - ty) ** 2 + (az - tz) ** 2);
      
      // Trigger explosion if agent is close to target
      // Use more generous distance for mission targets
      const shouldExplode = distance < 2.0; // 2.0 units is generous enough
      
      // If agent is VERY close (inside object), force explosion immediately
      if (distance < 0.3) {
        setIsExploding(true);
        onTargetReached();
        return;
      }
      
      if (shouldExplode) {
        // Simulate target reached after a delay
        const timer = setTimeout(() => {
          setIsExploding(true);
          onTargetReached();
        }, 500);
        return () => clearTimeout(timer);
      }
    }
  }, [isSelected, onTargetReached, isExploding, agentPosition, position, agentAction]);

  // Handle explosion animation
  useFrame((state) => {
    if (meshRef.current && !isDestroyed) {
      // Only rotate if this target is selected
      if (isSelected && !isExploding) {
        meshRef.current.rotation.y += 0.01;
      }
      meshRef.current.position.y = 0.5 + Math.sin(state.clock.elapsedTime * 2) * 0.1;
      
      // Handle explosion animation
      if (isExploding) {
        setExplosionProgress(prev => Math.min(prev + 0.05, 1));
        if (meshRef.current) {
          meshRef.current.scale.setScalar(1 + explosionProgress * 2);
          const material = meshRef.current.material as THREE.MeshStandardMaterial;
          material.opacity = 1 - explosionProgress;
          material.emissiveIntensity = 0.5 + explosionProgress * 3;
        }
        
        // Mark as destroyed after explosion completes
        if (explosionProgress >= 1) {
          setIsExploding(false);
          setIsDestroyed(true);
          setExplosionProgress(0);
        }
      }
    }
  });

  // Handle click for dragging
  const handleClick = (event: any) => {
    event.stopPropagation();
    setIsDragging(true);
    setDragStart([event.point.x, event.point.z]);
  };

  // Handle drag movement
  useEffect(() => {
    if (!isDragging || !dragStart || !groupRef.current) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (groupRef.current) {
        const newX = position[0] + (e.movementX * 0.1);
        const newZ = position[2] + (e.movementY * 0.1);
        setPosition([newX, position[1], newZ]);
      }
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      setDragStart(null);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, dragStart, position]);

  // Create geometry based on type
  const getGeometry = () => {
    switch (data.geometry) {
      case 'box':
        return <boxGeometry args={[1, 1, 1]} />;
      case 'sphere':
        return <sphereGeometry args={[0.6, 32, 32]} />;
      case 'cone':
        return <coneGeometry args={[0.6, 1.2, 32]} />;
      case 'cylinder':
        return <cylinderGeometry args={[0.5, 0.5, 1, 32]} />;
      case 'skeleton':
        // Skeleton head (skull shape)
        return (
          <>
            <sphereGeometry args={[0.5, 32, 32]} />
            {/* Eye sockets */}
            <mesh position={[0.2, 0.1, 0.4]}>
              <sphereGeometry args={[0.1, 16, 16]} />
              <meshStandardMaterial color="#000000" />
            </mesh>
            <mesh position={[-0.2, 0.1, 0.4]}>
              <sphereGeometry args={[0.1, 16, 16]} />
              <meshStandardMaterial color="#000000" />
            </mesh>
          </>
        );
      default:
        return <boxGeometry args={[1, 1, 1]} />;
    }
  };

  // Don't render anything if destroyed
  if (isDestroyed) {
    return null;
  }

  return (
    <group 
      ref={groupRef} 
      position={position}
      onClick={handleClick}
    >
      <mesh 
        ref={meshRef} 
        castShadow 
        receiveShadow
      >
        {getGeometry()}
        <meshStandardMaterial 
          color={data.color} 
          emissive={data.color} 
          emissiveIntensity={0.5}
          transparent={isExploding}
        />
      </mesh>
      
      {/* Arrow indicators for dragging */}
      {isDragging && (
        <>
          {/* X-axis arrow (red) */}
          <arrowHelper
            args={[new THREE.Vector3(1, 0, 0), new THREE.Vector3(1, 0, 0), 0.5, 0xff0000]}
            position={[0.8, 0, 0]}
          />
          {/* Z-axis arrow (blue) */}
          <arrowHelper
            args={[new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 1), 0.5, 0x0000ff]}
            position={[0, 0, 0.8]}
          />
        </>
      )}
      
      {/* Explosion particles */}
      {isExploding && (
        <points>
          <bufferGeometry>
            <bufferAttribute
              attach="attributes-position"
              count={50}
              array={new Float32Array(Array.from({ length: 150 }, () => (Math.random() - 0.5) * 3))}
              itemSize={3}
            />
          </bufferGeometry>
          <pointsMaterial
            color={data.color}
            size={0.1}
            transparent
            opacity={1 - explosionProgress}
          />
        </points>
      )}
      
      <pointLight color={data.color} distance={3} intensity={5} />
    </group>
  );
};

// The "Physical" Agent in the world
const Agent = React.forwardRef<THREE.Group, { 
  action: ActionType, 
  onUpdateCamera: (cam: THREE.Camera) => void,
  targetPosition: [number, number, number] | null,
  confidence: number
}>(({ 
  action, 
  onUpdateCamera,
  targetPosition,
  confidence = 0.0
}, ref) => {
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
      
      // DISTANCE-BASED MOVEMENT: Faster when target is far away
      // Always use aggressive movement when target is detected, regardless of confidence
      if (action === ActionType.FORWARD && distanceToTarget > 1.0) {
        // Use distance to determine desired speed
        // When far away, use higher speed to close distance quickly
        const baseSpeed = Math.min(3.5, distanceToTarget * 0.7); // 70% of distance, up to 3.5
        const DESIRED_SPEED = baseSpeed;
        const speedError = DESIRED_SPEED - velocity.current;
        
        // More aggressive acceleration when far from target
        const accelerationMultiplier = distanceToTarget > 10.0 ? 4.0 : 3.0; // Extra aggressive when very far
        const thrustForce = Math.min(MAX_THRUST * 2.0, Math.max(-MAX_THRUST, speedError * MASS * accelerationMultiplier));
        acceleration.current = thrustForce / MASS;
        
        // Apply drag (but less when accelerating hard)
        const dragForce = DRAG_COEFFICIENT * velocity.current * velocity.current;
        acceleration.current -= dragForce / MASS;
        
        // Update velocity using acceleration
        velocity.current += acceleration.current * delta;
        velocity.current = Math.max(0, Math.min(3.5, velocity.current)); // Higher max speed
        
        // Reduce rotation to maintain forward momentum
        rotationVelocity.current *= (1 - 0.9 * delta);
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
        
        {/* Antenna on top */}
        <mesh position={[0, 0.2, 0]} castShadow>
          <cylinderGeometry args={[0.02, 0.02, 0.3]} />
          <meshStandardMaterial color="#00ccff" emissive="#00ccff" emissiveIntensity={0.5} />
        </mesh>
        <mesh position={[0, 0.35, 0]} castShadow>
          <sphereGeometry args={[0.04, 16, 16]} />
          <meshStandardMaterial color="#00ffff" emissive="#00ffff" emissiveIntensity={1.0} />
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
      
      {/* Light Beams - Cosmetic search lights */}
      <group>
        {/* Left light beam */}
        <mesh position={[0.2, 0.5, -0.1]} rotation={[0, Math.PI / 12, 0]}>
          <coneGeometry args={[0.05, 0.8, 8]} />
          <meshBasicMaterial color="#00ffff" transparent opacity={0.3} side={THREE.BackSide} />
        </mesh>
        <pointLight position={[0.2, 0.5, -0.1]} color="#00ffff" distance={3} intensity={0.5} />
        
        {/* Right light beam */}
        <mesh position={[-0.2, 0.5, -0.1]} rotation={[0, -Math.PI / 12, 0]}>
          <coneGeometry args={[0.05, 0.8, 8]} />
          <meshBasicMaterial color="#00ffff" transparent opacity={0.3} side={THREE.BackSide} />
        </mesh>
        <pointLight position={[-0.2, 0.5, -0.1]} color="#00ffff" distance={3} intensity={0.5} />
        
        {/* Center forward light beam */}
        <mesh position={[0, 0.5, -0.1]} rotation={[0, 0, 0]}>
          <coneGeometry args={[0.06, 1.0, 8]} />
          <meshBasicMaterial color="#ffffff" transparent opacity={0.2} side={THREE.BackSide} />
        </mesh>
        <pointLight position={[0, 0.5, -0.1]} color="#ffffff" distance={4} intensity={0.8} />
      </group>
    </group>
  );
});

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

// Agent position context to share agent position with targets
const AgentPositionContext = React.createContext<[number, number, number] | null>(null);

const SimulationWorldInner: React.FC<SimulationWorldProps & { agentCamRef: React.RefObject<THREE.Camera | null> }> = (props) => {
  const agentGroupRef = useRef<THREE.Group>(null);
  const [agentPosition, setAgentPosition] = useState<[number, number, number]>([0, 0, 0]);
  const [destroyedTargets, setDestroyedTargets] = useState<Set<string>>(new Set());

  // Update agent position on each frame
  useFrame(() => {
    if (agentGroupRef.current) {
      const pos = agentGroupRef.current.position;
      setAgentPosition([pos.x, pos.y, pos.z]);
    }
  });

  // Check if target is mentioned in chat to respawn it
  useEffect(() => {
    // When target changes (via chat), check if it's destroyed and respawn it
    if (props.target && destroyedTargets.has(props.target)) {
      // Respawn this target
      setDestroyedTargets(prev => {
        const newSet = new Set(prev);
        newSet.delete(props.target);
        return newSet;
      });
      // Reduced logging for performance
    }
  }, [props.target, destroyedTargets]);

  const handleTargetReached = (targetType: string) => {
    // Mark target as destroyed
    setDestroyedTargets(prev => new Set(prev).add(targetType));
    // Reduced logging for performance
  };

  return (
    <AgentPositionContext.Provider value={agentPosition}>
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
      {targets.map((t, i) => {
        // Skip destroyed targets
        if (destroyedTargets.has(t.type)) {
          return null;
        }
        return (
          <TargetObject 
            key={i} 
            data={t} 
            isSelected={props.target === t.type}
            agentPosition={agentPosition}
            agentAction={props.agentAction}
            onTargetReached={() => handleTargetReached(t.type)}
          />
        );
      })}

      {/* Agent */}
      <Agent 
        ref={agentGroupRef}
        action={props.agentAction} 
        onUpdateCamera={(cam) => { props.agentCamRef.current = cam; }}
        targetPosition={targets.find(t => t.type === props.target && !destroyedTargets.has(t.type))?.position as [number, number, number] || null}
        confidence={props.confidence || 0.0}
      />

      {/* Logic */}
      <SceneManager 
        isRunning={props.isRunning} 
        onCaptureFrame={props.onCaptureFrame} 
        agentAction={props.agentAction}
        agentCamRef={props.agentCamRef}
      />
    </AgentPositionContext.Provider>
  );
};

export const SimulationWorld: React.FC<SimulationWorldProps> = (props) => {
  const agentCamRef = useRef<THREE.Camera | null>(null);

  return (
    <Canvas shadows className="bg-black">
      <SimulationWorldInner {...props} agentCamRef={agentCamRef} />
    </Canvas>
  );
};
