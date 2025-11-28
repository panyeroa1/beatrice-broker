
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { GoogleGenAI, Type } from "@google/genai";
import { ConversationTurn } from "./state";

/**
 * Checks the user's latest input to see if they are correcting the agent's behavior.
 * If a correction is detected, it generates an updated system prompt.
 * 
 * @param apiKey - The Gemini API Key
 * @param currentSystemPrompt - The current system prompt being used
 * @param latestUserText - The most recent text spoken by the user
 * @param recentTurns - Context of the conversation (last few turns)
 * @returns Object containing detection status and potential new prompt
 */
export async function checkCorrection(
  apiKey: string,
  currentSystemPrompt: string,
  latestUserText: string,
  recentTurns: ConversationTurn[]
): Promise<{
  detected: boolean;
  summary?: string;
  newSystemPrompt?: string;
}> {
  try {
    const ai = new GoogleGenAI({ apiKey });
    
    // Format history for context (last 6 turns usually enough)
    const context = recentTurns
      .slice(-6)
      .map(t => `${t.role.toUpperCase()}: ${t.text}`)
      .join('\n');

    const prompt = `
      You are a Supervisor AI monitoring a conversation between a User and an Agent.
      
      Current System Prompt of the Agent:
      """
      ${currentSystemPrompt}
      """

      Recent Conversation Log:
      """
      ${context}
      """

      The User just said: "${latestUserText}"

      TASK:
      Analyze if the User's last statement is a direct instruction, correction, or negative feedback regarding the Agent's behavior, voice, tone, or logic.
      Examples of corrections: "Don't be so excited", "Speak slower", "Stop saying 'I understand'", "You are too quiet", "Act more like a broker".
      
      If it is NOT a correction (e.g., just normal conversation), return detected: false.

      If it IS a correction:
      1. Summarize what the user wants to change.
      2. Rewrite the "Current System Prompt" to incorporate this feedback.
      - Keep the original structure and persona as much as possible.
      - Only modify or add instructions to address the specific feedback.
      - Do NOT output a generic prompt; edit the *provided* prompt text.

      Output JSON format:
      {
        "detected": boolean,
        "summary": "Short description of the correction",
        "new_system_prompt": "The full rewritten system prompt text"
      }
    `;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            detected: { type: Type.BOOLEAN },
            summary: { type: Type.STRING },
            new_system_prompt: { type: Type.STRING },
          },
          required: ['detected']
        }
      }
    });

    const result = JSON.parse(response.text || '{}');
    return {
      detected: result.detected,
      summary: result.summary,
      newSystemPrompt: result.new_system_prompt
    };

  } catch (error) {
    console.error("Supervisor check failed:", error);
    return { detected: false };
  }
}
