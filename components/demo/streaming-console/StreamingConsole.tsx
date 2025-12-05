
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { useEffect, useRef, useState } from 'react';
import PopUp from '../popup/PopUp';
import WelcomeScreen from '../welcome-screen/WelcomeScreen';
import { LiveConnectConfig, Modality, LiveServerContent, Tool } from '@google/genai';

import { useLiveAPIContext } from '../../../contexts/LiveAPIContext';
import {
  useSettings,
  useLogStore,
  useTools,
  useSupervisor,
  ConversationTurn,
} from '@/lib/state';
import { checkCorrection } from '@/lib/supervisor';

const formatTimestamp = (date: Date) => {
  const pad = (num: number, size = 2) => num.toString().padStart(size, '0');
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  const milliseconds = pad(date.getMilliseconds(), 3);
  return `${hours}:${minutes}:${seconds}.${milliseconds}`;
};

const renderContent = (text: string) => {
  // Split by ```json...``` code blocks
  const parts = text.split(/(`{3}json\n[\s\S]*?\n`{3})/g);

  return parts.map((part, index) => {
    if (part.startsWith('```json')) {
      const jsonContent = part.replace(/^`{3}json\n|`{3}$/g, '');
      return (
        <pre key={index}>
          <code>{jsonContent}</code>
        </pre>
      );
    }

    // Split by **bold** text
    const boldParts = part.split(/(\*\*.*?\*\*)/g);
    return boldParts.map((boldPart, boldIndex) => {
      if (boldPart.startsWith('**') && boldPart.endsWith('**')) {
        return <strong key={boldIndex}>{boldPart.slice(2, -2)}</strong>;
      }
      return boldPart;
    });
  });
};


export default function StreamingConsole() {
  const { client, setConfig, connected } = useLiveAPIContext();
  const { systemPrompt, voice, style, googleSearch, model } = useSettings();
  const { tools } = useTools();
  const turns = useLogStore(state => state.turns);
  const { addSuggestion, setAnalyzing } = useSupervisor();
  
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showPopUp, setShowPopUp] = useState(true);

  // Silence Detection Refs
  const lastActivityRef = useRef(Date.now());
  const silenceStageRef = useRef<number>(0); // 0 = none, 1 = warning, 2 = persistent
  
  // Initial Connection Refs
  const hasGreetedRef = useRef(false);
  const initialSilenceRef = useRef(false);

  // We need to access the API key to perform the supervisor check.
  const API_KEY = process.env.API_KEY as string;

  const handleClosePopUp = () => {
    setShowPopUp(false);
  };

  // Reset refs when disconnected
  useEffect(() => {
    if (!connected) {
      hasGreetedRef.current = false;
      initialSilenceRef.current = false;
      silenceStageRef.current = 0;
    }
  }, [connected]);

  // Initial Greeting (Kickoff)
  useEffect(() => {
    if (connected && !hasGreetedRef.current) {
      hasGreetedRef.current = true;
      // Force the agent to speak first with a natural phone answering greeting
      client.send([{ text: `[SYSTEM: Phone connected. Answer naturally with "Hello?".]` }]);
    }
  }, [connected, client]);

  // Style update listener (handled separately to avoid re-triggering greeting)
  useEffect(() => {
    if (connected) {
      client.send([{ text: `Style: ${style}` }]);
    }
  }, [style, connected, client]);

  // Silence Detection Timer
  useEffect(() => {
    const interval = setInterval(() => {
      if (!connected) return;
      
      const timeSinceActivity = Date.now() - lastActivityRef.current;
      const currentTurns = useLogStore.getState().turns;

      // START OF CALL SILENCE: "Hello? Who's this?"
      // Check if we are at the very beginning (<= 1 turn, which is likely the agent's first hello)
      // and user hasn't spoken for ~4.5 seconds.
      if (
        currentTurns.length <= 1 && 
        timeSinceActivity > 4500 && 
        !initialSilenceRef.current && 
        silenceStageRef.current === 0
      ) {
         initialSilenceRef.current = true;
         client.send([{ text: `[SYSTEM: User hasn't responded. Say "Hello? ... Who's this?" naturally with slight confusion.]` }]);
         // We do not increment silenceStageRef here to allow standard logic to take over later if needed.
         return; 
      }
      
      // Stage 1: 12 seconds - Natural Contextual Re-engagement
      if (timeSinceActivity > 12000 && silenceStageRef.current === 0) {
        silenceStageRef.current = 1;
        
        // Dynamic Context Instruction
        client.send([{ 
          text: `[SYSTEM_NOTIFICATION: User has been silent for 12 seconds. ACTION: Re-engage by recalling a specific significant topic/detail we discussed earlier. Use a natural transition like "Actually, before I forget..." or "I was actually contemplating what you said about..." or "You mentioned earlier that...". Do NOT just say "Hello". Make it feel like a spontaneous thought.]` 
        }]);

        useLogStore.getState().addTurn({
          role: 'system',
          text: `⚡ System: Silence detected (12s) - Requesting context recall re-engagement`,
          isFinal: true
        });
      }

      // Stage 2: 45 seconds - Persistent silence / Audio check
      if (timeSinceActivity > 45000 && silenceStageRef.current === 1) {
        silenceStageRef.current = 2;
        
        client.send([{ 
          text: `[SYSTEM_NOTIFICATION: The user has been silent for 45 seconds. There might be an audio issue. Ask "Can you hear me?" or politely offer to pause/end the call if they are busy.]` 
        }]);

        useLogStore.getState().addTurn({
          role: 'system',
          text: '⚡ System: Persistent silence (45s) - Triggering connection check',
          isFinal: true
        });
      }

    }, 1000);

    return () => clearInterval(interval);
  }, [connected, client]);

  // Set the configuration for the Live API
  useEffect(() => {
    // Group all enabled function declarations into a single tool object
    const functionDeclarations = tools
      .filter(tool => tool.isEnabled)
      .map(tool => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));

    const enabledTools: Tool[] = [];
    if (functionDeclarations.length > 0) {
      enabledTools.push({ functionDeclarations });
    }
    
    // Only add googleSearch if enabled AND supported (audio preview model does NOT support it)
    if (googleSearch && model !== 'gemini-2.5-flash-native-audio-preview-09-2025') {
      enabledTools.push({ googleSearch: {} });
    }

    const constructedSystemInstruction = systemPrompt + (style && style !== 'Neutral' ? `\n\nStyle: ${style}` : '');

    // Using `any` to accommodate potential type mismatches in the SDK vs implementation
    // specifically for speechConfig and tools strictness.
    const config: any = {
      responseModalities: [Modality.AUDIO],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: voice,
          },
        },
      },
      // Ensure these are present as per Live API requirements for transcription
      inputAudioTranscription: { model: "gemini-2.5-flash-native-audio-preview-09-2025" }, 
      outputAudioTranscription: { model: "gemini-2.5-flash-native-audio-preview-09-2025" },
      // Send systemInstruction as a string to avoid complex Content object validation issues at handshake
      systemInstruction: constructedSystemInstruction,
    };

    // CRITICAL: Only attach the 'tools' property if we actually have enabled tools.
    // Sending `tools: []` or `tools: undefined` explicitly can cause the API handshake to fail.
    if (enabledTools.length > 0) {
      config.tools = enabledTools;
    }

    setConfig(config);
  }, [setConfig, systemPrompt, tools, voice, style, googleSearch, model]);

  useEffect(() => {
    const { addTurn, updateLastTurn } = useLogStore.getState();

    const handleInputTranscription = async (text: string, isFinal: boolean) => {
      // Update activity timestamp on ANY user input
      lastActivityRef.current = Date.now();
      silenceStageRef.current = 0;
      // If user speaks, we consider the initial silence broken
      initialSilenceRef.current = true;

      const turns = useLogStore.getState().turns;
      const last = turns[turns.length - 1];
      if (last && last.role === 'user' && !last.isFinal) {
        updateLastTurn({
          text: last.text + text,
          isFinal,
        });
      } else {
        addTurn({ role: 'user', text, isFinal });
      }

      // SUPERVISOR CHECK
      const updatedTurns = useLogStore.getState().turns;
      const updatedLast = updatedTurns[updatedTurns.length - 1];
      const fullUserText = (updatedLast && updatedLast.role === 'user') ? updatedLast.text : text;

      if (isFinal && fullUserText.trim().length > 2) {
        const currentPrompt = useSettings.getState().systemPrompt;
        
        setAnalyzing(true);
        checkCorrection(API_KEY, currentPrompt, fullUserText, updatedTurns)
          .then(result => {
             if (result.detected && result.newSystemPrompt) {
               addSuggestion({
                 id: crypto.randomUUID(),
                 timestamp: new Date(),
                 originalFeedback: fullUserText,
                 summary: result.summary || 'User correction',
                 newSystemPrompt: result.newSystemPrompt
               });
               
               addTurn({
                 role: 'system',
                 text: `⚡ Supervisor detected correction: "${result.summary}"`,
                 isFinal: true
               });
             }
          })
          .finally(() => setAnalyzing(false));
      }
    };

    const handleOutputTranscription = (text: string, isFinal: boolean) => {
      lastActivityRef.current = Date.now();
      
      const turns = useLogStore.getState().turns;
      const last = turns[turns.length - 1];
      if (last && last.role === 'agent' && !last.isFinal) {
        updateLastTurn({
          text: last.text + text,
          isFinal,
        });
      } else {
        addTurn({ role: 'agent', text, isFinal });
      }
    };

    const handleContent = (serverContent: LiveServerContent) => {
      const text =
        serverContent.modelTurn?.parts
          ?.map((p: any) => p.text)
          .filter(Boolean)
          .join(' ') ?? '';
      const groundingChunks = serverContent.groundingMetadata?.groundingChunks;

      if (!text && !groundingChunks) return;

      const turns = useLogStore.getState().turns;
      const last = turns[turns.length - 1];

      if (last?.role === 'agent' && !last.isFinal) {
        const updatedTurn: Partial<ConversationTurn> = {
          text: last.text + text,
        };
        if (groundingChunks) {
          updatedTurn.groundingChunks = [
            ...(last.groundingChunks || []),
            ...groundingChunks,
          ];
        }
        updateLastTurn(updatedTurn);
      } else {
        addTurn({ role: 'agent', text, isFinal: false, groundingChunks });
      }
    };

    const handleTurnComplete = () => {
      lastActivityRef.current = Date.now();
      const turns = useLogStore.getState().turns;
      const last = turns[turns.length - 1];
      if (last && !last.isFinal) {
        updateLastTurn({ isFinal: true });
      }
    };

    client.on('inputTranscription', handleInputTranscription);
    client.on('outputTranscription', handleOutputTranscription);
    client.on('content', handleContent);
    client.on('turncomplete', handleTurnComplete);

    return () => {
      client.off('inputTranscription', handleInputTranscription);
      client.off('outputTranscription', handleOutputTranscription);
      client.off('content', handleContent);
      client.off('turncomplete', handleTurnComplete);
    };
  }, [client]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [turns]);

  return (
    <div className="transcription-container">
      {showPopUp && <PopUp onClose={handleClosePopUp} />}
      {turns.length === 0 ? (
        <WelcomeScreen />
      ) : (
        <div className="transcription-view" ref={scrollRef}>
          {turns.map((t, i) => (
            <div
              key={i}
              className={`transcription-entry ${t.role} ${!t.isFinal ? 'interim' : ''
                }`}
            >
              <div className="transcription-header">
                <div className="transcription-source">
                  {t.role === 'user'
                    ? 'You'
                    : t.role === 'agent'
                      ? 'Agent'
                      : 'System'}
                </div>
                <div className="transcription-timestamp">
                  {formatTimestamp(t.timestamp)}
                </div>
              </div>
              <div className="transcription-text-content">
                {renderContent(t.text)}
              </div>
              {t.groundingChunks && t.groundingChunks.length > 0 && (
                <div className="grounding-chunks">
                  <strong>Sources:</strong>
                  <ul>
                    {t.groundingChunks
                      .filter(chunk => chunk.web?.uri)
                      .map((chunk, index) => (
                        <li key={index}>
                          <a
                            href={chunk.web?.uri}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {chunk.web?.title || chunk.web?.uri}
                          </a>
                        </li>
                      ))}
                  </ul>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
