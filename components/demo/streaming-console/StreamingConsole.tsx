
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { useEffect, useRef, useState } from 'react';
import PopUp from '../popup/PopUp';
import WelcomeScreen from '../welcome-screen/WelcomeScreen';
// FIX: Import LiveServerContent to correctly type the content handler.
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
  const { systemPrompt, voice, style, googleSearch } = useSettings();
  const { tools } = useTools();
  const turns = useLogStore(state => state.turns);
  const { addSuggestion, setAnalyzing } = useSupervisor();
  
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showPopUp, setShowPopUp] = useState(true);

  // Silence Detection Refs
  const lastActivityRef = useRef(Date.now());
  const silenceStageRef = useRef<number>(0); // 0 = none, 1 = warning, 2 = persistent

  // We need to access the API key to perform the supervisor check.
  // Ideally this is passed via context, but process.env is accessible here.
  const API_KEY = process.env.API_KEY as string;

  const handleClosePopUp = () => {
    setShowPopUp(false);
  };

  useEffect(() => {
    if (connected) {
      client.send([{ text: `Style: ${style}` }]);
    }
  }, [style, connected, client]);

  // Background noise effect
  useEffect(() => {
    const audio = new Audio('https://eburon.ai/soundfx/noice.mp3');
    audio.loop = true;
    audio.volume = 0.2; // Subtle background level

    if (connected) {
      audio.play().catch((error) => {
        console.warn('Background audio playback failed:', error);
      });
    }

    return () => {
      audio.pause();
      audio.currentTime = 0;
    };
  }, [connected]);

  // Silence Detection Timer
  useEffect(() => {
    const interval = setInterval(() => {
      if (!connected) return;
      
      const timeSinceActivity = Date.now() - lastActivityRef.current;
      
      // Stage 1: 12 seconds - Natural Contextual Re-engagement
      if (timeSinceActivity > 12000 && silenceStageRef.current === 0) {
        silenceStageRef.current = 1;
        
        // Dynamic Context Instruction
        client.send([{ 
          text: `[SYSTEM_NOTIFICATION: User silence detected (12s). ACTION: Re-engage naturally. 1. Refer back to the last topic/question to clarify. 2. OR use a non-verbal cue like a throat clear or sigh to check presence. 3. Mirror their vibe. 4. Focus on the deal/job. Do NOT just say "Hello".]` 
        }]);

        // Log to console UI
        useLogStore.getState().addTurn({
          role: 'system',
          text: `⚡ System: Silence detected (12s) - Requesting context-aware re-engagement`,
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
    
    if (googleSearch) {
      enabledTools.push({ googleSearch: {} });
    }

    // Using `any` for config to accommodate `speechConfig`, which is not in the
    // current TS definitions but is used in the working reference example.
    const config: any = {
      responseModalities: [Modality.AUDIO],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: voice,
          },
        },
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      systemInstruction: {
        parts: [
          {
            text: systemPrompt + (style && style !== 'Neutral' ? `\n\nStyle: ${style}` : ''),
          },
        ],
      },
      tools: enabledTools,
    };

    setConfig(config);
  }, [setConfig, systemPrompt, tools, voice, style, googleSearch]);

  useEffect(() => {
    const { addTurn, updateLastTurn } = useLogStore.getState();

    const handleInputTranscription = async (text: string, isFinal: boolean) => {
      // Update activity timestamp on ANY user input
      lastActivityRef.current = Date.now();
      // Revoke silence trigger immediately
      silenceStageRef.current = 0;

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
      // If the user's input is final and has substance, check for corrections
      
      // Use the aggregated text from the store to ensure we capture the full context
      // The 'text' argument might only be the final chunk.
      const updatedTurns = useLogStore.getState().turns;
      const updatedLast = updatedTurns[updatedTurns.length - 1];
      const fullUserText = (updatedLast && updatedLast.role === 'user') ? updatedLast.text : text;

      if (isFinal && fullUserText.trim().length > 2) {
        const currentPrompt = useSettings.getState().systemPrompt;
        
        setAnalyzing(true);
        // Run check asynchronously so we don't block
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
               
               // LOGGING: Inject a system message into the chat stream so the user sees the correction was caught
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
      // Update activity timestamp when agent speaks
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

    // FIX: The 'content' event provides a single LiveServerContent object.
    // The function signature is updated to accept one argument, and groundingMetadata is extracted from it.
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
      // Ensure we count the end of the agent's turn as activity
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
