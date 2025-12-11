import React, { useState, useCallback, useRef, useEffect } from 'react';
import { SimulationWorld } from './components/SimulationWorld';
import { getNavCommand } from './services/sam2';
import { llmService, ChainedMission } from './services/llm';
import { ActionType, LogEntry, TargetShape, VisionResponse } from './types';
import { v4 as uuidv4 } from 'uuid';
import { Activity, Radio, Eye, Disc, Square, Triangle, Box, Send, Brain, Target } from 'lucide-react';

const TARGET_OPTIONS: TargetShape[] = ['Red Cube', 'Pink Sphere', 'Green Cone', 'Yellow Cylinder', 'Skeleton Head'];

export default function App() {
  const [selectedTarget, setSelectedTarget] = useState<TargetShape>(TARGET_OPTIONS[0]);
  const [isRunning, setIsRunning] = useState(false);
  const [agentAction, setAgentAction] = useState<ActionType>(ActionType.IDLE);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [lastVisionFrame, setLastVisionFrame] = useState<string | null>(null);
  const [lastVisionFrameRight, setLastVisionFrameRight] = useState<string | null>(null);
  const [visionData, setVisionData] = useState<VisionResponse | null>(null);
  const [isRearView, setIsRearView] = useState(false);
  const [agentLocation, setAgentLocation] = useState<'north' | 'south' | 'unknown'>('unknown');
  const [agentThinking, setAgentThinking] = useState<string>('');
  
  // LLM Mission State
  const [missionInput, setMissionInput] = useState('');
  const [currentMission, setCurrentMission] = useState<ChainedMission | null>(null);
  const [isProcessingMission, setIsProcessingMission] = useState(false);
  
  // Using ref to prevent closure staleness in async callbacks if needed, 
  // though simple state flow works for this scale.
  const isProcessingRef = useRef(false);

  const addLog = (message: string, type: LogEntry['type']) => {
    setLogs(prev => [{
      id: uuidv4(),
      timestamp: new Date().toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }),
      message,
      type
    }, ...prev].slice(0, 50));
  };

  const handleNextStep = useCallback(() => {
    if (!currentMission) return;
    
    const nextStep = currentMission.current_step + 1;
    if (nextStep < currentMission.steps.length) {
      const updatedMission = {
        ...currentMission,
        current_step: nextStep,
        status: 'active' as const
      };
      setCurrentMission(updatedMission);
      setSelectedTarget(updatedMission.steps[nextStep].target);
      addLog(`Moving to step ${nextStep + 1}/${currentMission.steps.length}: ${updatedMission.steps[nextStep].target}`, 'info');
    } else {
      setCurrentMission({
        ...currentMission,
        status: 'completed' as const
      });
      addLog('Mission completed!', 'info');
      setIsRunning(false);
    }
  }, [currentMission, setCurrentMission, setSelectedTarget, addLog, setIsRunning]);

  const handleVisionCapture = useCallback(async (leftImage: string, rightImage: string) => {
    if (isProcessingRef.current || !isRunning) return;
    
    isProcessingRef.current = true;
    setLastVisionFrame(leftImage); // Update UI preview with left image
    setLastVisionFrameRight(rightImage); // Update UI preview with right image

    try {
      const result = await getNavCommand(leftImage, rightImage, selectedTarget);
      
      setVisionData(result);
      setAgentAction(result.action);
      
      // Enhanced logging with stereo information
      let logMessage = `VISION [STEREO]: ${result.reasoning}`;
      if (result.distance !== undefined && result.distance !== null && result.angle !== undefined && result.angle !== null) {
        logMessage += ` | Distance: ${result.distance.toFixed(1)}m | Angle: ${result.angle.toFixed(1)}°`;
      }
      addLog(logMessage, 'vision');
      addLog(`MOTOR: ${result.action}`, 'action');

      // Check if target is reached (high confidence and STOP action)
      if (result.action === ActionType.STOP && result.targetVisible && result.confidence && result.confidence > 0.8) {
        if (currentMission) {
          // Check if current mission step is completed
          const currentStep = currentMission.steps[currentMission.current_step];
          if (currentStep && currentStep.target === selectedTarget) {
            // Auto-advance to next step
            setTimeout(() => {
              handleNextStep();
              addLog(`Target ${selectedTarget} reached. Auto-advancing to next step.`, 'info');
            }, 1000);
          }
        } else {
          // Single target mode
          addLog("TARGET LOCK CONFIRMED. PROCEDURE COMPLETE.", 'info');
          setIsRunning(false);
        }
      }

    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : "Unknown error";
      addLog(`SAM2 Model Offline / Vision Error: ${errorMessage}`, 'error');
      setAgentAction(ActionType.SCAN);
    } finally {
      isProcessingRef.current = false;
    }
  }, [isRunning, selectedTarget, currentMission, handleNextStep, addLog]);

  const handleMissionSubmit = async () => {
    if (!missionInput.trim() || isProcessingMission) return;
    
    setIsProcessingMission(true);
    addLog(`Processing mission: "${missionInput}"`, 'info');
    
    try {
      const mission = await llmService.parseMission(missionInput, TARGET_OPTIONS);
      setCurrentMission(mission);
      
      // Check if mission has status 'help' (empty targets)
      if ((mission as any).status === 'help') {
        addLog(`I did not find the shape or form in your last message.`, 'error');
        addLog(`Available shapes: ${TARGET_OPTIONS.join(', ')}`, 'info');
        setCurrentMission(null);
      } else if (mission.steps.length > 0) {
        const firstTarget = mission.steps[0].target;
        setSelectedTarget(firstTarget);
        addLog(`Mission parsed: ${mission.steps.length} step(s). First target: ${firstTarget}`, 'info');
        addLog(`Mission steps: ${mission.steps.map(s => s.target).join(' → ')}`, 'info');
        
        // Auto-start the mission when LLM chat is sent
        if (!isRunning) {
          setIsRunning(true);
          setAgentAction(ActionType.IDLE);
          setVisionData(null);
          addLog(`Auto-starting mission execution: ${mission.steps.map(s => s.target).join(' → ')}`, 'info');
        }
      }
    } catch (error) {
      addLog(`Mission parsing failed: ${error instanceof Error ? error.message : 'Unknown error'}`, 'error');
    } finally {
      setIsProcessingMission(false);
      setMissionInput('');
    }
  };

  const toggleSimulation = () => {
    if (currentMission && !isRunning) {
      // Start mission execution
      setIsRunning(true);
      setAgentAction(ActionType.IDLE);
      setVisionData(null);
      addLog(`Starting mission execution: ${currentMission.steps.map(s => s.target).join(' → ')}`, 'info');
    } else if (!currentMission && !isRunning) {
      // Start single target search
      setIsRunning(true);
      setAgentAction(ActionType.IDLE);
      setVisionData(null);
      addLog(`Initializing SAM2 Tracking Protocol... Target: ${selectedTarget}`, 'info');
    } else {
      // Stop/abort
      setIsRunning(false);
      setAgentAction(ActionType.IDLE);
      addLog("Mission Aborted.", 'info');
    }
  };

  return (
    <div className="w-full h-screen relative bg-black overflow-hidden flex flex-col md:flex-row">
      
      {/* LEFT PANEL: 3D WORLD */}
      <div className="flex-1 h-[60vh] md:h-full relative border-r border-gray-800">
        <SimulationWorld 
          target={selectedTarget}
          isRunning={isRunning}
          onCaptureFrame={handleVisionCapture}
          onAgentUpdate={() => {}}
          agentAction={agentAction}
          confidence={visionData?.confidence}
          onCameraViewChange={setIsRearView}
        />
        
        {/* Overlay HUD for Main View */}
        <div className="absolute top-4 left-4 pointer-events-none">
          <div className="flex items-center space-x-2 bg-black/60 backdrop-blur text-cyan-400 px-3 py-1 border border-cyan-800 rounded">
            <Radio className={`w-4 h-4 ${isRunning ? 'animate-pulse' : ''}`} />
            <span className="text-xs font-bold tracking-widest">
              {isRunning ? 'LIVE FEED // GLOBAL CAM' : 'SYSTEM STANDBY'}
            </span>
          </div>
        </div>
      </div>

      {/* RIGHT PANEL: DASHBOARD */}
      <div className="w-full md:w-[400px] h-[40vh] md:h-full bg-neutral-900 flex flex-col border-l border-gray-800 z-10 shadow-2xl">
        
        {/* Header */}
        <header className="p-4 border-b border-gray-800 bg-black">
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <Activity className="text-cyan-500" />
            NEURO<span className="text-cyan-500">SEEKER</span>
          </h1>
          <p className="text-xs text-gray-500 mt-1">SAM2 Local // Visual Navigation Agent</p>
        </header>

        {/* Content Scroll Area */}
        <div className="flex-1 overflow-y-auto p-4 space-y-6">
          
          {/* 1. AGENT VISION (SAM2 Simulation) - STEREO */}
          <div className="space-y-2">
            <h2 className="text-xs font-bold text-gray-400 flex items-center gap-2">
              <Eye className="w-3 h-3" /> AGENT OPTICAL SENSORS (STEREO SAM2)
            </h2>
            <div className="grid grid-cols-2 gap-2">
              {/* Left Camera */}
              <div className={`relative w-full aspect-square bg-black rounded overflow-hidden group ${
                isRearView ? 'border-2 border-purple-500 shadow-[0_0_10px_#ff00ff]' : 'border border-gray-700'
              }`}>
                <div className={`absolute top-1 left-1 z-10 text-[8px] px-1 py-0.5 rounded ${
                  isRearView ? 'bg-purple-900/70 text-purple-300 border border-purple-700' : 'bg-black/70 text-cyan-400 border border-cyan-800'
                }`}>
                  {isRearView ? 'REAR LEFT' : 'LEFT CAM'}
                </div>
                {lastVisionFrame ? (
                  <>
                    <img src={lastVisionFrame} alt="Left Camera" className="w-full h-full object-cover opacity-80" />
                    {/* SAM2 Style Overlays */}
                    <div className="absolute inset-0 pointer-events-none">
                       {/* Scanning Grid */}
                       <div className="w-full h-full bg-[linear-gradient(rgba(0,255,200,0.05)_1px,transparent_1px),linear-gradient(90deg,rgba(0,255,200,0.05)_1px,transparent_1px)] bg-[size:20px_20px]"></div>
                       
                       {/* Bounding Box if detected */}
                       {visionData?.targetVisible && visionData.boundingBox && visionData.boundingBox.length === 4 && (
                         <div 
                           className="absolute border-2 border-green-500 shadow-[0_0_10px_#00ff00] transition-all duration-300 ease-out"
                           style={{
                             top: `${visionData.boundingBox[0] / 10}%`,
                             left: `${visionData.boundingBox[1] / 10}%`,
                             height: `${(visionData.boundingBox[2] - visionData.boundingBox[0]) / 10}%`,
                             width: `${(visionData.boundingBox[3] - visionData.boundingBox[1]) / 10}%`,
                           }}
                         >
                           <span className="absolute -top-5 left-0 bg-green-500 text-black text-[9px] font-bold px-1">
                             CONF: 98%
                           </span>
                         </div>
                       )}

                       {/* Central Crosshair */}
                       <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-4 h-4 border border-cyan-500/50"></div>
                    </div>
                  </>
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-gray-600 text-xs">
                    NO SIGNAL
                  </div>
                )}
              </div>
              
              {/* Right Camera */}
              <div className={`relative w-full aspect-square bg-black rounded overflow-hidden group ${
                isRearView ? 'border-2 border-purple-500 shadow-[0_0_10px_#ff00ff]' : 'border border-gray-700'
              }`}>
                <div className={`absolute top-1 left-1 z-10 text-[8px] px-1 py-0.5 rounded ${
                  isRearView ? 'bg-purple-900/70 text-purple-300 border border-purple-700' : 'bg-black/70 text-cyan-400 border border-cyan-800'
                }`}>
                  {isRearView ? 'REAR RIGHT' : 'RIGHT CAM'}
                </div>
                {lastVisionFrameRight ? (
                  <>
                    <img src={lastVisionFrameRight} alt="Right Camera" className="w-full h-full object-cover opacity-80" />
                    {/* SAM2 Style Overlays */}
                    <div className="absolute inset-0 pointer-events-none">
                       {/* Scanning Grid */}
                       <div className="w-full h-full bg-[linear-gradient(rgba(0,255,200,0.05)_1px,transparent_1px),linear-gradient(90deg,rgba(0,255,200,0.05)_1px,transparent_1px)] bg-[size:20px_20px]"></div>
                       
                       {/* Bounding Box if detected - same as left for consistency */}
                       {visionData?.targetVisible && visionData.boundingBox && visionData.boundingBox.length === 4 && (
                         <div 
                           className="absolute border-2 border-green-500 shadow-[0_0_10px_#00ff00] transition-all duration-300 ease-out"
                           style={{
                             top: `${visionData.boundingBox[0] / 10}%`,
                             left: `${visionData.boundingBox[1] / 10}%`,
                             height: `${(visionData.boundingBox[2] - visionData.boundingBox[0]) / 10}%`,
                             width: `${(visionData.boundingBox[3] - visionData.boundingBox[1]) / 10}%`,
                           }}
                         >
                           <span className="absolute -top-5 left-0 bg-green-500 text-black text-[9px] font-bold px-1">
                             CONF: 98%
                           </span>
                         </div>
                       )}

                       {/* Central Crosshair */}
                       <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-4 h-4 border border-cyan-500/50"></div>
                    </div>
                  </>
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-gray-600 text-xs">
                    NO SIGNAL
                  </div>
                )}
              </div>
            </div>
            
            {/* Stereo Info Bar */}
            <div className="flex items-center justify-between text-[10px] text-gray-400">
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1">
                  <div className="w-2 h-2 rounded-full bg-cyan-500"></div>
                  <span>STEREO ACTIVE</span>
                </div>
                {visionData?.distance !== undefined && visionData?.angle !== undefined && (
                  <div className="flex items-center gap-1">
                    <span>DIST: {visionData.distance?.toFixed(1)}m</span>
                    <span>|</span>
                    <span>ANGLE: {visionData.angle?.toFixed(1)}°</span>
                  </div>
                )}
              </div>
              <div className="text-cyan-300">
                {visionData?.confidence !== undefined ? `CONFIDENCE: ${(visionData.confidence * 100).toFixed(0)}%` : "CALIBRATING..."}
              </div>
            </div>
            
            {/* Reasoning Output */}
            <div className="bg-gray-800/50 p-2 rounded border border-gray-700 min-h-[40px]">
               <p className="text-xs font-mono text-cyan-300">
                 {visionData?.reasoning || "Waiting for stereo stream..."}
               </p>
            </div>
          </div>

          {/* 2. LLM MISSION PLANNER */}
          <div className="space-y-3">
             <h2 className="text-xs font-bold text-gray-400 flex items-center gap-2">
               <Brain className="w-3 h-3" /> LLM MISSION PLANNER
             </h2>
             
             {/* Mission Input */}
             <div className="space-y-2">
               <div className="flex gap-2">
                 <input
                   type="text"
                   value={missionInput}
                   onChange={(e) => setMissionInput(e.target.value)}
                   onKeyDown={(e) => e.key === 'Enter' && handleMissionSubmit()}
                   placeholder="Enter mission (e.g., 'Go to the sphere and then to the cube')"
                   disabled={isProcessingMission}
                   className="flex-1 p-2 text-xs bg-gray-800 border border-gray-700 rounded text-white placeholder-gray-500 focus:outline-none focus:border-cyan-500"
                 />
                 <button
                   onClick={handleMissionSubmit}
                   disabled={!missionInput.trim() || isProcessingMission}
                   className="px-3 bg-cyan-700 hover:bg-cyan-600 disabled:bg-gray-800 disabled:cursor-not-allowed rounded flex items-center gap-1"
                 >
                   <Send className="w-3 h-3" />
                 </button>
               </div>
               
               {/* Current Mission Display */}
               {currentMission && (
                 <div className="bg-gray-800/50 border border-gray-700 rounded p-3">
                   <div className="flex items-center justify-between mb-2">
                     <span className="text-xs font-bold text-cyan-300 flex items-center gap-1">
                       <Target className="w-3 h-3" />
                       ACTIVE MISSION
                     </span>
                     <span className="text-xs px-2 py-1 rounded bg-gray-900">
                       {currentMission.status === 'completed' ? '✅' : '🟢'}
                     </span>
                   </div>
                   
                   <div className="space-y-2">
                     {currentMission.steps.map((step, index) => (
                       <div 
                         key={index}
                         className={`flex items-center gap-2 p-2 rounded text-xs ${
                           index === currentMission.current_step 
                             ? 'bg-cyan-900/30 border border-cyan-700' 
                             : index < currentMission.current_step 
                               ? 'bg-gray-900/50 opacity-60' 
                               : 'bg-gray-900/30'
                         }`}
                       >
                         <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] ${
                           index === currentMission.current_step 
                             ? 'bg-cyan-600' 
                             : index < currentMission.current_step 
                               ? 'bg-green-600' 
                               : 'bg-gray-700'
                         }`}>
                           {index + 1}
                         </div>
                         <div className="flex-1">
                           <div className="font-medium">{step.target}</div>
                           <div className="text-gray-400 text-[10px]">
                             Step {index + 1}: Navigate to target
                           </div>
                         </div>
                       </div>
                     ))}
                   </div>
                   
                   <div className="mt-3 pt-2 border-t border-gray-700 text-xs text-gray-400">
                     Step {currentMission.current_step + 1} of {currentMission.steps.length}
                   </div>
                 </div>
               )}
             </div>
             
             <button
               onClick={toggleSimulation}
               className={`w-full py-3 font-bold text-sm tracking-widest rounded transition-all duration-300
                 ${isRunning 
                    ? 'bg-red-600 hover:bg-red-700 text-white shadow-[0_0_15px_#ff0000]' 
                    : 'bg-cyan-600 hover:bg-cyan-500 text-black shadow-[0_0_15px_#00e5ff]'}
               `}
             >
               {isRunning ? 'ABORT SEQUENCE' : currentMission ? 'START MISSION' : 'INITIATE SEARCH'}
             </button>
          </div>

          {/* 3. TERMINAL LOGS */}
          <div className="space-y-2 flex-1 min-h-[150px]">
             <h2 className="text-xs font-bold text-gray-400">SYSTEM LOGS</h2>
             <div className="bg-black border border-gray-800 rounded p-2 h-32 overflow-y-auto font-mono text-[10px] space-y-1">
               {logs.length === 0 && <span className="text-gray-600 italic">Ready for input...</span>}
               {logs.map((log) => (
                 <div key={log.id} className="flex gap-2">
                   <span className="text-gray-600">[{log.timestamp}]</span>
                   <span className={`
                     ${log.type === 'info' ? 'text-gray-300' : ''}
                     ${log.type === 'action' ? 'text-yellow-400' : ''}
                     ${log.type === 'vision' ? 'text-cyan-400' : ''}
                     ${log.type === 'error' ? 'text-red-500' : ''}
                   `}>
                     {log.type === 'action' && '> '}
                     {log.message}
                   </span>
                 </div>
               ))}
             </div>
          </div>

        </div>
      </div>
    </div>
  );
}
