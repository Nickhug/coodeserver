// Import the modified Gemini model types from the AI providers package
import { 
  listModels as aiProviderListModels, 
  sendGeminiMessage, 
  streamGeminiMessage 
} from '@repo/ai-providers';

/**
 * Get available Gemini models
 */
export async function listModels(apiKey: string): Promise<any[]> {
  return [
    { id: 'gemini-2.5-flash-preview-04-17', name: 'Gemini 2.5 Flash Preview' },
    { id: 'gemini-2.5-pro-preview-05-06', name: 'Gemini 2.5 Pro Preview' },
    { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' },
  ];
}

// ... existing code ... 