import React, { useState, useRef, useEffect } from 'react';
import { Message, AppState, AppSettings, DEFAULT_SETTINGS } from './types';
import { encodeWAV, playAudio, getAudioContext } from './utils/audio';
import { sendVoiceMessage } from './utils/zhipu';
import { loadSettings, saveSettings, getActiveApiKey, applyTheme } from './utils/settings';
import { Orb } from './components/Orb';
import { SettingsPanel } from './components/SettingsPanel';
import { Mic, Square, Loader2, Play, AlertCircle, Info, Settings2 } from 'lucide-react';

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [appState, setAppState] = useState<AppState>(AppState.IDLE);
  const [volume, setVolume] = useState(0);
  const [error, setError] = useState<string | null>(null);
  
  // Settings State
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  // Audio Refs
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const chunksRef = useRef<Float32Array[]>([]);
  const audioQueueRef = useRef<string[]>([]);
  const isPlayingRef = useRef(false);
  const requestRef = useRef<number>(0);

  // Load Settings on Mount
  useEffect(() => {
    const saved = loadSettings();
    setSettings(saved);
    applyTheme(saved.theme, saved.customCss);
  }, []);

  useEffect(() => {
    return () => {
      stopRecording();
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, []);

  const updateVisualizer = () => {
    if (analyserRef.current) {
      const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
      analyserRef.current.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
      const avg = sum / dataArray.length;
      setVolume(avg / 255);
    } else {
      setVolume(prev => Math.max(0, prev - 0.05));
    }
    requestRef.current = requestAnimationFrame(updateVisualizer);
  };

  useEffect(() => {
    requestRef.current = requestAnimationFrame(updateVisualizer);
    return () => {
        if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, []);

  const handleSaveSettings = (newSettings: AppSettings) => {
    setSettings(newSettings);
    saveSettings(newSettings);
    applyTheme(newSettings.theme, newSettings.customCss);
  };

  const startRecording = async () => {
    try {
      setError(null);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      
      const ctx = getAudioContext();
      audioContextRef.current = ctx;

      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyserRef.current = analyser;

      const bufferSize = 4096;
      const processor = ctx.createScriptProcessor(bufferSize, 1, 1);
      
      chunksRef.current = [];
      processor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        chunksRef.current.push(new Float32Array(inputData));
      };

      source.connect(processor);
      processor.connect(ctx.destination);
      
      processorRef.current = processor;
      setAppState(AppState.RECORDING);

    } catch (err: any) {
      setError("Please allow microphone access to talk to the clay bot.");
      console.error(err);
    }
  };

  const stopRecording = async () => {
    if (appState !== AppState.RECORDING) return;

    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }
    analyserRef.current = null;

    setAppState(AppState.PROCESSING);

    const allChunks = chunksRef.current;
    if (allChunks.length === 0) {
        setAppState(AppState.IDLE);
        return;
    }

    const totalLength = allChunks.reduce((acc, curr) => acc + curr.length, 0);
    const mergedSamples = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of allChunks) {
      mergedSamples.set(chunk, offset);
      offset += chunk.length;
    }

    const sampleRate = audioContextRef.current?.sampleRate || 24000;
    const wavBlob = encodeWAV(mergedSamples, sampleRate);

    // Optimistic Update
    const userMsg: Message = { role: 'user', isAudio: true, content: "..." };
    setMessages(prev => [...prev, userMsg]);

    try {
        let assistantContent = "";
        
        // Prepare API Inputs with Rotation
        const apiKey = getActiveApiKey(settings);
        
        // Combine System Prompt and Knowledge Base
        // We append the KB to the system prompt to ensure the model sees it as context
        let combinedSystemPrompt = settings.systemPrompt || "";
        if (settings.knowledgeBase && settings.knowledgeBase.trim() !== "") {
          combinedSystemPrompt += `\n\n### 知识库/上下文信息 ###\n${settings.knowledgeBase}`;
        }

        await sendVoiceMessage(
            apiKey,
            wavBlob, 
            messages.filter(m => m.content && m.content !== "..."), 
            combinedSystemPrompt,
            (textChunk, audioChunk) => {
                if (textChunk) assistantContent = textChunk;
                if (audioChunk) queueAudio(audioChunk);
            }
        );

        setMessages(prev => {
           const newHistory = [...prev];
           // Update placeholder
           newHistory[newHistory.length - 1].content = "语音已发送";
           // Add response
           newHistory.push({
               role: 'assistant',
               content: assistantContent || "Listening...",
               isAudio: true
           });
           return newHistory;
        });

    } catch (err: any) {
        console.error(err);
        setError("Connection issue: " + err.message);
        setAppState(AppState.ERROR);
    } finally {
        if (audioQueueRef.current.length === 0 && !isPlayingRef.current) {
             setAppState(AppState.IDLE);
        }
    }
  };

  const queueAudio = (base64Data: string) => {
    audioQueueRef.current.push(base64Data);
    if (!isPlayingRef.current) playNextInQueue();
  };

  const playNextInQueue = async () => {
    if (audioQueueRef.current.length === 0) {
        isPlayingRef.current = false;
        setAppState(prev => (prev === AppState.PLAYING || prev === AppState.PROCESSING) ? AppState.IDLE : prev);
        return;
    }

    isPlayingRef.current = true;
    setAppState(AppState.PLAYING);
    
    const nextChunk = audioQueueRef.current.shift();
    if (nextChunk) {
        await playAudio(nextChunk, () => {
            playNextInQueue();
        });
    }
  };

  const handleToggleRecord = () => {
    if (appState === AppState.IDLE || appState === AppState.ERROR) {
      startRecording();
    } else if (appState === AppState.RECORDING) {
      stopRecording();
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-between p-6 overflow-hidden relative selection:bg-red-200">
      
      {/* Background Decor (Clay blobs) */}
      <div className="absolute top-0 left-0 w-full h-full overflow-hidden pointer-events-none z-0 opacity-50">
          <div className="absolute top-[-10%] left-[-10%] w-[60%] h-[60%] bg-blue-200/40 rounded-[40%_60%_70%_30%/40%_50%_60%_50%] blur-3xl animate-[spin_20s_linear_infinite]" />
          <div className="absolute bottom-[-10%] right-[-10%] w-[60%] h-[60%] bg-orange-200/40 rounded-[60%_40%_30%_70%/60%_30%_70%_40%] blur-3xl animate-[spin_15s_linear_infinite_reverse]" />
      </div>

      {/* Header */}
      <header className="z-10 w-full max-w-2xl flex justify-between items-center mb-6">
        <div className="flex items-center gap-3 clay-card px-5 py-3 rounded-full">
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[var(--primary-btn)] to-[#E55050] flex items-center justify-center shadow-inner text-white font-bold text-sm">
                G
            </div>
            <h1 className="text-xl font-bold font-[inherit] text-[var(--text-color)]">东里二丫</h1>
        </div>
        
        <div className="clay-card px-4 py-2 flex items-center gap-2 rounded-full">
            <div className={`w-3 h-3 rounded-full shadow-inner ${appState === AppState.ERROR ? 'bg-[var(--error-border)]' : 'bg-[var(--success-color)]'}`} />
            <span className="text-xs font-bold opacity-70 text-[var(--text-color)]">{appState === AppState.IDLE ? '就绪' : appState}</span>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex flex-col items-center justify-center w-full z-10 max-w-lg">
        
        {/* Orb Container */}
        <div className="relative mb-12">
            <div className="absolute inset-0 bg-white/30 rounded-full blur-3xl transform scale-110" />
            <Orb state={appState} volume={volume} />
        </div>

        {/* Status Message */}
        <div className="mb-8 min-h-[3rem] flex items-center justify-center">
            <p className="text-xl font-bold text-center transition-all duration-300 text-[var(--text-color)]">
                {appState === AppState.IDLE && "按住麦克风聊天"}
                {appState === AppState.RECORDING && "我在听..."}
                {appState === AppState.PROCESSING && "让我想想..."}
                {appState === AppState.PLAYING && "二丫在说..."}
                {appState === AppState.ERROR && "哎呀，出错了"}
            </p>
        </div>

        {/* Dynamic Transcript Card */}
        {messages.length > 0 && (
             <div className="clay-card p-6 w-full mb-8 transform transition-all duration-500 hover:scale-[1.02]">
                 <div className="flex flex-col gap-3">
                     <span className="text-xs font-bold opacity-70 uppercase tracking-wider text-[var(--text-color)]">最新回复</span>
                     <p className="text-lg leading-relaxed font-medium text-[var(--text-color)]">
                        {messages[messages.length - 1].content || "..."}
                     </p>
                 </div>
             </div>
        )}

        {/* Error Alert */}
        {error && (
            <div className="clay-card bg-[var(--error-color)] border-l-4 border-[var(--error-border)] p-4 mb-6 flex items-start gap-3 w-full animate-bounce-in">
                <AlertCircle className="w-6 h-6 text-[var(--error-border)] shrink-0" />
                <p className="text-sm opacity-80 text-[var(--text-color)]">{error}</p>
            </div>
        )}

      </main>

      {/* Footer Controls */}
      <footer className="z-10 w-full max-w-md flex flex-col items-center gap-6 mb-4 relative">
        
        {/* Big Mic Button */}
        <button
          onClick={handleToggleRecord}
          disabled={appState === AppState.PROCESSING}
          className={`
            w-24 h-24 flex items-center justify-center transition-all duration-300
            ${appState === AppState.RECORDING 
                ? 'clay-btn-primary scale-110' 
                : 'clay-btn bg-[var(--secondary-btn)] hover:bg-white'
            }
            ${appState === AppState.PROCESSING ? 'opacity-70 cursor-wait' : ''}
          `}
        >
          {appState === AppState.RECORDING ? (
            <Square className="w-10 h-10 fill-current text-white" />
          ) : appState === AppState.PROCESSING ? (
            <Loader2 className="w-10 h-10 animate-spin text-[var(--accent-color)]" />
          ) : (
            <Mic className={`w-10 h-10 ${appState === AppState.PLAYING ? 'text-[var(--success-color)]' : 'text-[var(--primary-btn)]'}`} />
          )}
        </button>
        
        <div className="flex items-center gap-2 text-[var(--text-color)]/70 text-xs font-semibold bg-white/40 px-4 py-2 rounded-full backdrop-blur-sm">
            <Info className="w-3 h-3" />
            <span>数字小村官 - 二丫</span>
        </div>

      </footer>

      {/* Settings Trigger - Bottom Left, Cute Style */}
      <div className="fixed bottom-6 left-6 z-20">
         <button 
           onClick={() => setIsSettingsOpen(true)}
           className="clay-btn bg-[var(--bg-color)] w-12 h-12 text-[var(--text-color)] hover:scale-110 active:scale-95 group"
           title="设置"
         >
           <Settings2 className="w-5 h-5 opacity-70 group-hover:rotate-45 transition-transform duration-500" />
         </button>
      </div>

      <SettingsPanel 
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        settings={settings}
        onSave={handleSaveSettings}
      />
    </div>
  );
}