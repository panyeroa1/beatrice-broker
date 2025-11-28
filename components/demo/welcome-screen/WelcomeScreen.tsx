
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import React from 'react';
import './WelcomeScreen.css';
import { useTools, Template } from '../../../lib/state';

const welcomeContent: Record<Template, { title: string; description: string; prompts: string[] }> = {
  'customer-support': {
    title: 'Beatrice (L’Étoile Estates)',
    description: 'High-status, reverse-selling real estate broker in Brussels. Polite, direct, and slightly ironic.',
    prompts: [
      "I'm not interested in listing my home.",
      "If you have a buyer, bring them. I'm selling it myself.",
      "I don't want a sales pitch.",
    ],
  },
  'leo': {
    title: 'Leo (Eburon Estate)',
    description: 'High-trust, authentic property broker. Phone-call style, natural, and efficient.',
    prompts: [
      "I'm looking to buy a condo in Makati.",
      "What's the market like for rentals right now?",
      "Can you help me sell my house?",
    ],
  },
  'personal-assistant': {
    title: 'Personal Assistant',
    description: 'Manage your schedule, send emails, and set reminders.',
    prompts: [
      'Create a calendar event for a meeting tomorrow at 10am.',
      'Send an email to jane@example.com.',
      'Set a reminder to buy milk.',
    ],
  },
  'navigation-system': {
    title: 'Navigation System',
    description: 'Find routes, nearby places, and get traffic information.',
    prompts: [
      'Find a route to the nearest coffee shop.',
      'Are there any parks nearby?',
      "What's the traffic like on the way to the airport?",
    ],
  },
};

const WelcomeScreen: React.FC = () => {
  const { template, setTemplate } = useTools();
  const { title, description, prompts } = welcomeContent[template];
  return (
    <div className="welcome-screen">
      <div className="welcome-content">
        <div className="title-container">
          <span className="welcome-icon">mic</span>
          <div className="title-selector">
            <select value={template} onChange={(e) => setTemplate(e.target.value as Template)} aria-label="Select a template">
              <option value="leo">Leo (Eburon Estate)</option>
              <option value="customer-support">Beatrice (Real Estate)</option>
              <option value="personal-assistant">Personal Assistant</option>
              <option value="navigation-system">Navigation System</option>
            </select>
            <span className="icon">arrow_drop_down</span>
          </div>
        </div>
        <p>{description}</p>
        <div className="example-prompts">
          {prompts.map((prompt, index) => (
            <div key={index} className="prompt">{prompt}</div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default WelcomeScreen;
