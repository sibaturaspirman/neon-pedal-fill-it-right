'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { RotateCcw, Bike, ChevronRight, ChevronLeft, Target, Usb } from 'lucide-react';

// GAME CONFIGURATION
const MAX_LEVEL = 100;
const DECAY_RATE = 40; // Units drop per second
const TARGET_RPM = 400; // RPM needed to counteract decay
const TOTAL_TIME = 30; // Seconds for a single session
const PERFECT_MIN = 50; // 50%
const PERFECT_MAX = 80; // 80%

class LineSplitter {
  buf = '';
  transform(chunk: string, controller: any) {
    this.buf += chunk;
    const parts = this.buf.split(/\r?\n/);
    this.buf = parts.pop() || '';
    for (const p of parts) controller.enqueue(p);
  }
  flush(controller: any) { if (this.buf) controller.enqueue(this.buf); }
}

export default function GamePage() {
  const [gameState, setGameState] = useState<'idle' | 'playing' | 'gameover'>('idle');
  const [fillLevel, setFillLevel] = useState(0);
  const [displayRpm, setDisplayRpm] = useState(0);
  const [timeLeft, setTimeLeft] = useState(TOTAL_TIME);
  const [perfectTime, setPerfectTime] = useState(0);
  const [serialState, setSerialState] = useState<'idle' | 'connecting' | 'connected' | 'error' | 'unsupported'>('idle');

  const fillLevelRef = useRef(0);
  const telemetryRef = useRef({ rpm: 0 });
  const simulatedRpmRef = useRef(0);
  const telemetrySourceRef = useRef<'mock' | 'webserial'>('mock');
  const lastTimeRef = useRef(0);
  const reqRef = useRef<number>(0);
  
  // Use a state ref for the loop to access latest state without re-binding
  const stateRef = useRef({ gameState, timeLeft, perfectTime });
  useEffect(() => {
    stateRef.current = { gameState, timeLeft, perfectTime };
  }, [gameState, timeLeft, perfectTime]);

  useEffect(() => {
    if (typeof navigator !== 'undefined' && !('serial' in navigator)) {
      setSerialState('unsupported');
    }
  }, []);

  const connectSerial = async () => {
    if (serialState !== 'idle' && serialState !== 'error') return;
    setSerialState('connecting');
    try {
      const port = await (navigator as any).serial.requestPort();
      await port.open({
        baudRate: 115200,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        flowControl: 'none',
        bufferSize: 4096,
      });
      try { await port.setSignals({ dataTerminalReady: true, requestToSend: false }); } catch {}

      setSerialState('connected');
      telemetrySourceRef.current = 'webserial';
      
      const decoder = new TextDecoderStream();
      const pipePromise = port.readable.pipeTo(decoder.writable).catch(() => {});
      const lineStream = decoder.readable.pipeThrough(new TransformStream(new LineSplitter()));
      const reader = lineStream.getReader();

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          const line = value.trim();
          if (line && line[0] === '{') {
            try {
              const data = JSON.parse(line);
              if (data && typeof data.rpm === 'number') {
                telemetryRef.current.rpm = data.rpm;
              }
            } catch {}
          }
        }
      } finally {
        try { reader.releaseLock(); } catch {}
        await pipePromise;
      }

    } catch (err: any) {
      if (err && err.name === 'NotFoundError') {
        setSerialState('idle');
        return;
      }
      console.error('[webserial] connect failed:', err);
      setSerialState('error');
      setTimeout(() => setSerialState(s => s === 'error' ? 'idle' : s), 3000);
      telemetrySourceRef.current = 'mock';
    }
  };

  const gameLoop = useCallback((time: number) => {
    if (lastTimeRef.current === 0) lastTimeRef.current = time;
    const dt = Math.min(0.1, (time - lastTimeRef.current) / 1000);
    lastTimeRef.current = time;

    let currentRpm = telemetryRef.current.rpm;
    if (telemetrySourceRef.current === 'mock') {
        currentRpm = simulatedRpmRef.current;
        simulatedRpmRef.current = Math.max(0, simulatedRpmRef.current - 200 * dt); 
    }
    
    setDisplayRpm(currentRpm);

    const s = stateRef.current;

    if (s.gameState === 'idle') {
      if (fillLevelRef.current > 0) {
        fillLevelRef.current = Math.max(0, fillLevelRef.current - DECAY_RATE * dt);
        setFillLevel(fillLevelRef.current);
      }
      if (currentRpm >= 50) {
        setGameState('playing');
        fillLevelRef.current = 10;
      }
    } else if (s.gameState === 'playing') {
      const power = currentRpm * (DECAY_RATE / TARGET_RPM);
      const newFill = Math.max(0, Math.min(MAX_LEVEL, fillLevelRef.current + (power - DECAY_RATE) * dt));
      
      fillLevelRef.current = newFill;
      setFillLevel(newFill);

      let newTimeLeft = Math.max(0, s.timeLeft - dt);
      let isGameOver = newTimeLeft <= 0;

      let newPerfectTime = s.perfectTime;
      if (newFill >= PERFECT_MIN && newFill <= PERFECT_MAX) {
        newPerfectTime += dt;
      }

      setTimeLeft(newTimeLeft);
      setPerfectTime(newPerfectTime);

      if (isGameOver) {
        setGameState('gameover');
      }
    } else if (s.gameState === 'gameover') {
      if (fillLevelRef.current > 0) {
        fillLevelRef.current = Math.max(0, fillLevelRef.current - DECAY_RATE * 2 * dt);
        setFillLevel(fillLevelRef.current);
      }
    }

    reqRef.current = requestAnimationFrame(gameLoop);
  }, []);

  const pedal = useCallback(() => {
    if (telemetrySourceRef.current === 'mock') {
      simulatedRpmRef.current = Math.min(800, simulatedRpmRef.current + 120);
    }
  }, []);

  useEffect(() => {
    reqRef.current = requestAnimationFrame(gameLoop);
    return () => cancelAnimationFrame(reqRef.current);
  }, [gameLoop]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      pedal();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [pedal]);

  const resetGame = () => {
    setGameState('idle');
    fillLevelRef.current = 0;
    setFillLevel(0);
    setTimeLeft(TOTAL_TIME);
    setPerfectTime(0);
    if (telemetrySourceRef.current === 'mock') {
      simulatedRpmRef.current = 0;
    }
  };

  const segments = Array.from({ length: 10 }).map((_, i) => {
    const min = i * 10;
    const max = (i + 1) * 10;
    let fillP = 0;
    
    if (fillLevel >= max) fillP = 100;
    else if (fillLevel > min) fillP = ((fillLevel - min) / 10) * 100;

    let colorName = 'bg-blue-600 shadow-[0_0_15px_rgba(37,99,235,0.6)]';
    let emptyColor = 'border-blue-500/20';
    let isPerf = false;
    
    if (i >= 5 && i <= 7) {
      colorName = 'bg-emerald-400 shadow-[0_0_20px_rgba(52,211,153,0.8)]';
      emptyColor = 'border-emerald-400/40';
      isPerf = true;
    } else if (i > 7) {
      colorName = 'bg-orange-500 shadow-[0_0_20px_rgba(249,115,22,0.8)]';
      emptyColor = 'border-orange-500/40';
    }

    return { id: i, fillP, colorName, emptyColor, isPerf };
  });

  return (
    <main 
      className="w-full h-[100dvh] bg-[#020508] text-slate-100 flex flex-col items-center justify-center overflow-hidden touch-none relative select-none border-4 border-[#0c1a2b] shadow-2xl"
      onClick={gameState !== 'gameover' ? pedal : undefined}
    >
      <div className="absolute inset-0 opacity-20 pointer-events-none" style={{ backgroundImage: 'radial-gradient(#1e40af 1px, transparent 1px)', backgroundSize: '30px 30px' }} />
      <div className="absolute top-0 left-0 w-full h-full bg-gradient-to-b from-blue-900/10 via-transparent to-blue-900/5 pointer-events-none" />
      <div className="absolute -bottom-20 -left-20 w-96 h-96 bg-blue-900/10 rounded-full blur-[100px] pointer-events-none" />
      <div className="absolute -top-20 -right-20 w-96 h-96 bg-blue-500/10 rounded-full blur-[100px] pointer-events-none" />
      
      <div 
        className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[60vw] h-[60vw] md:w-[40vw] md:h-[40vw] rounded-full pointer-events-none transition-all duration-500 blur-[100px] md:blur-[140px] opacity-20 ${
          fillLevel > 80 ? 'bg-orange-600' : fillLevel >= 50 ? 'bg-emerald-500 opacity-30' : 'bg-transparent'
        }`} 
      />
      
      <div className="w-full max-w-6xl flex flex-col md:flex-row gap-6 md:gap-12 h-screen items-center justify-between z-10 px-4 py-8 md:px-12 md:py-16">
        
        <div className="flex flex-row md:flex-col gap-4 md:gap-12 w-full md:w-64 text-white font-mono justify-between md:justify-center px-4 md:px-0">
          <div className="flex flex-col gap-1 md:gap-2">
            <span className="text-[10px] uppercase text-slate-500 tracking-[0.3em] font-bold">Session Time</span>
            <div className={`text-4xl md:text-6xl font-black italic tracking-tighter flex items-baseline gap-1 md:gap-2 ${timeLeft <= 5 ? 'text-orange-400 animate-pulse' : 'text-white'}`}>
              {Math.ceil(timeLeft)}<span className="text-xl md:text-3xl font-bold text-blue-500/50 not-italic">s</span>
            </div>
          </div>
          
          <div className="flex flex-col gap-1 md:gap-2 text-right md:text-left">
            <span className="text-[10px] uppercase text-slate-500 tracking-[0.3em] font-bold flex items-center justify-end md:justify-start gap-2">
              <Target className="w-4 h-4 text-emerald-400" /> System Perfect
            </span>
            <div className="text-2xl md:text-4xl font-black italic tracking-tighter text-emerald-400 drop-shadow-[0_0_10px_rgba(16,185,129,0.5)]">
              {perfectTime.toFixed(1)}<span className="text-sm md:text-xl font-bold text-emerald-500/50 not-italic ml-1">s</span>
            </div>
          </div>
        </div>

        <div className="flex-1 flex justify-center items-center h-full max-h-[600px] w-full min-h-[300px] relative pointer-events-none">
          <div className="relative h-full py-4 md:py-12 flex justify-center w-full max-w-[12rem] md:max-w-xs" style={{ transform: 'skewX(-10deg)' }}>
            
            <div className="absolute left-[-50px] md:left-[-70px] flex items-center justify-end w-[40px] md:w-[60px] drop-shadow-[0_0_10px_rgba(16,185,129,0.5)]" style={{ bottom: '50%', height: '30%' }}>
              <div className="flex flex-col items-end text-emerald-400 font-bold whitespace-nowrap" style={{ transform: 'skewX(10deg)' }}>
                <span className="text-[10px] md:text-xs uppercase tracking-wider mb-[-4px]">Phase</span>
                <span className="text-[10px] md:text-xs uppercase tracking-wider mb-1">Optimum</span>
                <ChevronRight className="w-5 h-5 md:w-6 md:h-6 -mt-1 md:-mt-2 opacity-80" />
              </div>
            </div>

            <div className="absolute right-[-50px] md:right-[-70px] flex items-center justify-start w-[40px] md:w-[60px] drop-shadow-[0_0_10px_rgba(16,185,129,0.5)]" style={{ bottom: '50%', height: '30%' }}>
              <div className="flex flex-col items-start text-emerald-400 font-bold whitespace-nowrap" style={{ transform: 'skewX(10deg)' }}>
                <div className="flex items-center -ml-1 md:-ml-2 mb-[-4px]">
                  <ChevronLeft className="w-5 h-5 md:w-6 md:h-6 opacity-80" />
                  <span className="text-[10px] md:text-xs uppercase tracking-wider">Phase</span>
                </div>
                <span className="text-[10px] md:text-xs uppercase tracking-wider ml-4 md:ml-5">Optimum</span>
              </div>
            </div>

            <div className="flex flex-col-reverse w-20 md:w-32 h-[100%] gap-[6px] md:gap-2 relative z-10 bg-slate-900/80 p-2 md:p-3 rounded-xl border-2 border-slate-800 shadow-[0_0_40px_rgba(30,58,138,0.2)] backdrop-blur-md">
              {segments.map((seg) => (
                <div key={seg.id} className={`w-full flex-1 relative overflow-hidden rounded-[2px] border ${seg.emptyColor} bg-slate-900/60 transition-all ${seg.fillP > 0 ? '' : 'grayscale'}`}>
                  <div 
                    className={`absolute bottom-0 left-0 w-full ${seg.colorName} transition-all duration-75 ease-out`}
                    style={{ height: `${seg.fillP}%` }}
                  />
                </div>
              ))}
            </div>

          </div>
        </div>

        <div className="w-full md:w-64 flex flex-col gap-6 md:gap-8 text-white px-4 md:px-0 text-center md:text-left h-32 md:h-auto pointer-events-none">
          {gameState === 'idle' && (
            <div className="flex flex-col gap-2 animate-pulse">
              <span className="text-[10px] tracking-[0.4em] uppercase text-blue-400 font-bold mb-1">Kinetic Module</span>
              <h2 className="text-3xl md:text-5xl font-black italic tracking-tighter text-white uppercase leading-none">
                FILL IT <span className="text-blue-500 underline decoration-2 underline-offset-4">RIGHT</span>
              </h2>
              <p className="text-slate-400 text-xs md:text-sm leading-relaxed mt-2 font-mono">
                {serialState === 'connected' ? 'Pedal the crank to begin system load!' : 'Mash keys or tap to simulate pedaling!'} Maintain power at <span className="text-emerald-400 font-bold">Phase Optimum</span>.
              </p>
              <div className="mt-2 flex flex-col md:flex-row items-center justify-center md:justify-start gap-4 text-blue-400 font-mono text-[10px] tracking-widest uppercase">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse"></div> System Ready
                </div>
                {displayRpm > 0 && (
                   <span className="pl-4 border-l border-slate-700 text-emerald-400 font-bold">
                     <span className="text-white text-base mr-1">{Math.floor(displayRpm)}</span> RPM
                   </span>
                )}
              </div>
            </div>
          )}

          {gameState === 'playing' && (
            <div className="flex flex-col gap-2">
              <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-slate-500">System Status</div>
              <div className={`text-4xl md:text-5xl font-black italic tracking-tighter uppercase leading-none transition-colors ${fillLevel > 80 ? 'text-orange-500 drop-shadow-[0_0_15px_rgba(249,115,22,0.6)]' : fillLevel >= 50 ? 'text-emerald-400 drop-shadow-[0_0_15px_rgba(16,185,129,0.5)]' : 'text-blue-400 drop-shadow-[0_0_15px_rgba(37,99,235,0.4)]'}`}>
                {fillLevel > 80 ? 'OVERHEATING' : fillLevel >= 50 ? 'OPTIMAL' : 'ACCELERATE'}
              </div>
              <div className="mt-3 md:mt-4 flex flex-col md:flex-row items-center md:items-start md:justify-start gap-4 text-slate-400 font-mono uppercase tracking-widest bg-slate-900/40 p-4 rounded-xl border border-slate-800">
                <Bike className={`w-8 h-8 md:w-10 md:h-10 shrink-0 ${fillLevel >= 50 && fillLevel <=80 ? 'text-emerald-400 drop-shadow-[0_0_10px_rgba(16,185,129,0.5)] animate-pulse' : 'text-slate-500'}`} />
                <div className="flex flex-col items-center md:items-start gap-2">
                  <div className="font-bold flex items-baseline gap-2 leading-none">
                    <span className="text-3xl text-white not-italic font-black">{Math.floor(displayRpm)}</span>
                    <span className="text-blue-500/50 text-[10px]">RPM</span>
                  </div>
                  <div className="font-bold flex items-baseline gap-2 leading-none">
                    <span className={`text-xl not-italic font-black ${fillLevel >= 50 && fillLevel <= 80 ? 'text-emerald-400' : 'text-slate-300'}`}>{Math.floor(fillLevel)}</span>
                    <span className="text-blue-500/50 text-[10px]">PWR</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {gameState === 'gameover' && (
            <div className="flex flex-col gap-4 bg-slate-900/80 p-5 md:p-6 rounded-2xl border-2 border-slate-800 backdrop-blur-xl shadow-[0_0_40px_rgba(30,58,138,0.3)] pointer-events-auto mt-[-40px] md:mt-0">
              <h3 className="text-[10px] tracking-[0.4em] uppercase text-blue-400 font-bold">Session Complete</h3>
              <div className="text-2xl md:text-3xl font-black italic text-white uppercase tracking-tighter -mt-2">Time's Up</div>
              
              <div className="flex flex-col gap-1 mt-2 border-t border-slate-800 pt-4">
                 <div className="text-slate-500 text-[10px] font-bold uppercase tracking-[0.3em]">Final Efficiency</div>
                 <div className="flex items-baseline gap-2">
                   <div className="text-4xl md:text-5xl font-black italic text-emerald-400 drop-shadow-[0_0_15px_rgba(16,185,129,0.5)] tracking-tighter">
                     {perfectTime.toFixed(1)}
                   </div>
                   <div className="text-xl font-bold text-emerald-500/50">SEC</div>
                 </div>
              </div>

              <button 
                onClick={(e) => { 
                  e.stopPropagation(); 
                  resetGame(); 
                }}
                className="mt-6 flex items-center justify-center gap-2 w-full py-3 bg-blue-600 hover:bg-blue-500 text-white rounded font-bold uppercase tracking-widest text-xs transition-all hover:scale-[1.02] active:scale-[0.98] shadow-[0_0_15px_rgba(37,99,235,0.4)]"
              >
                <RotateCcw className="w-4 h-4"/>
                Restart Module
              </button>
            </div>
          )}
        </div>

      </div>

      <div className="absolute top-4 left-4 z-50 pointer-events-auto sm:bottom-6 sm:right-6 sm:top-auto sm:left-auto flex items-center gap-4">
        {serialState === 'error' && (
          <span className="text-red-400 text-[10px] uppercase tracking-widest font-bold">Connection Lost</span>
        )}
        <button 
          onClick={(e) => { e.stopPropagation(); connectSerial(); }} 
          disabled={serialState === 'connecting' || serialState === 'unsupported' || serialState === 'connected'} 
          className={`flex items-center gap-2 px-3 py-2 sm:px-4 sm:py-2 text-[10px] font-bold uppercase tracking-widest rounded border transition-all ${
            serialState === 'connected' ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' : 
            serialState === 'unsupported' ? 'hidden' :
            'bg-slate-900/80 text-blue-400 border-blue-900/50 hover:border-blue-500 hover:text-blue-300 shadow-[0_0_10px_rgba(30,58,138,0.5)] backdrop-blur-md'
          }`}
        >
            <Usb className="w-4 h-4" />
            <span className="hidden sm:inline">
              {serialState === 'connected' ? 'Hardware Connected' : serialState === 'connecting' ? 'Establishing link...' : 'Connect Bike'}
            </span>
            <span className="sm:hidden">
              {serialState === 'connected' ? 'Connected' : serialState === 'connecting' ? '...' : 'Connect'}
            </span>
        </button>
      </div>

    </main>
  );
}
