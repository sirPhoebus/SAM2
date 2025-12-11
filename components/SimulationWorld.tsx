import React, { useRef, useState, useEffect } from 'react';
import { Canvas, useThree, useFrame } from '@react-three/fiber';
import { PerspectiveCamera, Grid, Stars, OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { AgentState, ActionType, TargetShape } from '../types';
import { Agent } from './simulation/Agent';
import { WallWithGap } from './simulation/WallWithGap';

interface SimulationWorldProps {
  target: TargetShape;
  isRunning: boolean;
  onCaptureFrame: (leftImage: string, rightImage: string) => void;
  onAgentUpdate: (state: Partial<AgentState>) => void;
  agentAction: ActionType;
  confidence?: number;
  onCameraViewChange?: (useRearView: boolean) => void;
  onAgentLocationChange?: (location: 'north' | 'south' | 'unknown', thinking: string) => void;
}

// Target data
const targets = [
  { type: 'Red Cube', color: '#ff0040', position: [5, 0.5, 5], geometry: 'box' },
  { type: 'Pink Sphere', color: '#ff69b4', position: [-4, 0.5, 4], geometry: 'sphere' },
  { type: 'Green Cone', color: '#00ff40', position: [2, 0.5, -6], geometry: 'cone' },
  { type: 'Yellow Cylinder', color: '#ffd700', position: [-6, 0.5, -2], geometry: 'cylinder' },
  { type: 'Skeleton Head', color: '#f0f0f0', position: [6, 0.5, -8], geometry: 'skeleton' },
] as const;

// Enhanced Target Object component with dragging and mission completion
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
      const [ax, ay, az] = agentPosition;
      const [tx, ty, tz] = position;
      const distance = Math.sqrt((ax - tx) ** 2 + (ay - ty) ** 2 + (az - tz) ** 2);
      
      const shouldExplode = distance < 2.0;
      
      if (distance < 0.3) {
        setIsExploding(true);
        onTargetReached();
        return;
      }
      
      if (shouldExplode) {
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
      if (isSelected && !isExploding) {
        meshRef.current.rotation.y += 0.01;
      }
      meshRef.current.position.y = 0.5 + Math.sin(state.clock.elapsedTime * 2) * 0.1;
      
      if (isExploding) {
        setExplosionProgress(prev => Math.min(prev + 0.05, 1));
        if (meshRef.current) {
          meshRef.current.scale.setScalar(1 + explosionProgress * 2);
          const material = meshRef.current.material as THREE.MeshStandardMaterial;
          material.opacity = 1 - explosionProgress;
          material.emissiveIntensity = 0.5 + explosionProgress * 3;
        }
        
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
        const newX = position[0] + (e.movementX * 0.02);
        const newZ = position[2] + (e.movementY * 0.02);
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
        return (
          <>
            <sphereGeometry args={[0.5, 32, 32]} />
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
          <arrowHelper
            args={[new THREE.Vector3(1, 0, 0), new THREE.Vector3(1, 0, 0), 0.5, 0xff0000]}
            position={[0.8, 0, 0]}
          />
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

// Scene Manager for stereo vision
const SceneManager = ({ 
  isRunning, 
  onCaptureFrame,
  leftCamRef,
  rightCamRef
}: { 
  isRunning: boolean; 
  onCaptureFrame: (leftImage: string, rightImage: string) => void;
  leftCamRef: React.MutableRefObject<THREE.Camera | null>;
  rightCamRef: React.MutableRefObject<THREE.Camera | null>;
}) => {
  const { gl, scene } = useThree();
  const leftRenderTarget = React.useMemo(() => new THREE.WebGLRenderTarget(512, 512), []);
  const rightRenderTarget = React.useMemo(() => new THREE.WebGLRenderTarget(512, 512), []);
  const lastCaptureTime = React.useRef(0);
  const CAPTURE_INTERVAL = 600;

  useFrame((state) => {
    if (!isRunning) {
      console.log('SceneManager: Simulation not running');
      return;
    }
    
    if (!leftCamRef.current || !rightCamRef.current) {
      console.log('SceneManager: Camera refs not ready', { 
        leftCam: !!leftCamRef.current, 
        rightCam: !!rightCamRef.current 
      });
      return;
    }

    const now = state.clock.elapsedTime * 1000;
    if (now - lastCaptureTime.current > CAPTURE_INTERVAL) {
      lastCaptureTime.current = now;
      console.log('SceneManager: Capturing stereo frames');

      const currentRenderTarget = gl.getRenderTarget();
      const currentXrEnabled = gl.xr.enabled;
      
      try {
        // Render Left Camera
        gl.xr.enabled = false;
        gl.setRenderTarget(leftRenderTarget);
        gl.render(scene, leftCamRef.current);
        
        // Render Right Camera
        gl.setRenderTarget(rightRenderTarget);
        gl.render(scene, rightCamRef.current);
        
        // Read pixels from render targets and convert to data URLs
        const readPixelsToDataURL = (renderTarget: THREE.WebGLRenderTarget): string => {
          const width = renderTarget.width;
          const height = renderTarget.height;
          const buffer = new Uint8Array(width * height * 4);
          
          gl.readRenderTargetPixels(renderTarget, 0, 0, width, height, buffer);
          
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          
          if (ctx) {
            const imageData = ctx.createImageData(width, height);
            imageData.data.set(buffer);
            ctx.putImageData(imageData, 0, 0);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
            console.log(`SceneManager: Generated data URL (${dataUrl.substring(0, 50)}...)`);
            return dataUrl;
          }
          
          console.log('SceneManager: Failed to get canvas context');
          return '';
        };
        
        const leftImageBase64 = readPixelsToDataURL(leftRenderTarget);
        const rightImageBase64 = readPixelsToDataURL(rightRenderTarget);
        
        if (leftImageBase64 && rightImageBase64) {
          console.log('SceneManager: Calling onCaptureFrame');
          onCaptureFrame(leftImageBase64, rightImageBase64);
        } else {
          console.log('SceneManager: Failed to generate images', {
            left: !!leftImageBase64,
            right: !!rightImageBase64
          });
        }
      } catch (error) {
        console.error('SceneManager: Error capturing frames:', error);
      } finally {
        gl.setRenderTarget(currentRenderTarget);
        gl.xr.enabled = currentXrEnabled;
      }
    }
  });

  return null;
};

// Orbit Controls wrapper
const OrbitControlsWrapper = () => {
  return <OrbitControls makeDefault />;
};

// Agent position context
const AgentPositionContext = React.createContext<[number, number, number] | null>(null);

// Main Simulation World component
const SimulationWorldInner: React.FC<SimulationWorldProps & { 
  leftCamRef: React.RefObject<THREE.Camera | null>;
  rightCamRef: React.RefObject<THREE.Camera | null>;
}> = (props) => {
  const agentGroupRef = useRef<THREE.Group>(null);
  const agentLeftCamRef = useRef<THREE.PerspectiveCamera>(null);
  const agentRightCamRef = useRef<THREE.PerspectiveCamera>(null);
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
    if (props.target && destroyedTargets.has(props.target)) {
      setDestroyedTargets(prev => {
        const newSet = new Set(prev);
        newSet.delete(props.target);
        return newSet;
      });
    }
  }, [props.target, destroyedTargets]);

  const handleTargetReached = (targetType: string) => {
    setDestroyedTargets(prev => new Set(prev).add(targetType));
  };

  // Update camera refs when agent updates them
  const handleCameraUpdate = (leftCam: THREE.Camera, rightCam: THREE.Camera, useRearView: boolean) => {
    props.leftCamRef.current = leftCam;
    props.rightCamRef.current = rightCam;
    
    // Also update agent camera refs for stereo vision
    if (leftCam instanceof THREE.PerspectiveCamera) {
      agentLeftCamRef.current = leftCam;
    }
    if (rightCam instanceof THREE.PerspectiveCamera) {
      agentRightCamRef.current = rightCam;
    }
    
    // Notify parent about camera view change
    if (props.onCameraViewChange) {
      props.onCameraViewChange(useRearView);
    }
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
        <meshStandardMaterial color="#1a1a1a" roughness={0.8} metalness={0.2} />
      </mesh>
      <Grid infiniteGrid sectionSize={3} cellColor="#444" sectionColor="#00ccff" fadeDistance={30} />

      {/* Wall with gap */}
      <WallWithGap />

      {/* Targets */}
      {targets.map((t, i) => {
        if (destroyedTargets.has(t.type)) return null;
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
        onUpdateCamera={handleCameraUpdate}
        targetPosition={targets.find(t => t.type === props.target && !destroyedTargets.has(t.type))?.position as [number, number, number] || null}
        confidence={props.confidence || 0.0}
      />

      {/* Stereo Vision Scene Manager */}
      <SceneManager 
        isRunning={props.isRunning} 
        onCaptureFrame={props.onCaptureFrame}
        leftCamRef={agentLeftCamRef}
        rightCamRef={agentRightCamRef}
      />
    </AgentPositionContext.Provider>
  );
};

export const SimulationWorld: React.FC<SimulationWorldProps> = (props) => {
  const leftCamRef = useRef<THREE.Camera | null>(null);
  const rightCamRef = useRef<THREE.Camera | null>(null);

  return (
    <Canvas shadows className="bg-black">
      <SimulationWorldInner {...props} leftCamRef={leftCamRef} rightCamRef={rightCamRef} />
    </Canvas>
  );
};
