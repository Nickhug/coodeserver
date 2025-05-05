import { NextRequest } from 'next/server';
import { POST } from './route';
import { getCurrentUserWithDb } from '../../../../lib/clerk/auth';
import { checkUserCredits } from '../../../../lib/clerk/auth';
import { updateUserCredits } from '../../../../lib/supabase/client';
import { sendGeminiRequest } from '../../../../lib/ai-providers/gemini-provider';
import { logUsage } from '../../../../lib/supabase/client';

// Mock the dependencies
jest.mock('../../../../lib/clerk/auth', () => ({
  getCurrentUserWithDb: jest.fn(),
  checkUserCredits: jest.fn(),
}));

jest.mock('../../../../lib/supabase/client', () => ({
  updateUserCredits: jest.fn(),
  logUsage: jest.fn(),
}));

jest.mock('../../../../lib/ai-providers/gemini-provider', () => ({
  sendGeminiRequest: jest.fn(),
}));

describe('Gemini Stream API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should handle streaming requests', async () => {
    // Mock the request
    const req = new NextRequest('https://example.com/api/void/gemini-stream', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gemini-1.5-pro',
        messages: [
          {
            role: 'user',
            content: 'Hello, world!',
          },
        ],
        requestId: '123',
      }),
    });

    // Mock the dependencies
    (getCurrentUserWithDb as jest.Mock).mockResolvedValue({
      dbUser: {
        id: 'user-123',
      },
    });

    (checkUserCredits as jest.Mock).mockResolvedValue({
      hasCredits: true,
      creditsRemaining: 100,
    });

    // Mock the sendGeminiRequest implementation
    let streamCallback: ((text: string) => void) | null = null;
    (sendGeminiRequest as jest.Mock).mockImplementation(async (params) => {
      streamCallback = params.onStream;
      
      // Simulate streaming by calling the callback
      if (streamCallback) {
        streamCallback('Hello');
        streamCallback(' world');
        streamCallback('!');
      }
      
      return {
        text: 'Hello world!',
        tokensUsed: 50,
        creditsUsed: 0.05,
      };
    });

    // Call the API
    const response = await POST(req);

    // Verify the response is a stream
    expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    
    // Read the stream
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    
    if (reader) {
      let done = false;
      while (!done) {
        const result = await reader.read();
        done = result.done;
        if (!done) {
          chunks.push(result.value);
        }
      }
    }
    
    // Convert chunks to text
    const text = chunks.map(chunk => new TextDecoder().decode(chunk)).join('');
    
    // Verify the stream contains the expected events
    expect(text).toContain('"event":"start"');
    expect(text).toContain('"event":"chunk"');
    expect(text).toContain('"event":"end"');
    
    // Verify the dependencies were called correctly
    expect(getCurrentUserWithDb).toHaveBeenCalled();
    expect(checkUserCredits).toHaveBeenCalled();
    expect(sendGeminiRequest).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gemini-1.5-pro',
      messages: [{ role: 'user', content: 'Hello, world!' }],
    }));
    expect(updateUserCredits).toHaveBeenCalledWith('user-123', -0.05);
    expect(logUsage).toHaveBeenCalledWith(expect.objectContaining({
      user_id: 'user-123',
      provider: 'gemini',
      model: 'gemini-1.5-pro',
      tokens_used: 50,
      credits_used: 0.05,
    }));
  });

  it('should handle unauthorized requests', async () => {
    // Mock the request
    const req = new NextRequest('https://example.com/api/void/gemini-stream', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gemini-1.5-pro',
        messages: [
          {
            role: 'user',
            content: 'Hello, world!',
          },
        ],
        requestId: '123',
      }),
    });

    // Mock the dependencies
    (getCurrentUserWithDb as jest.Mock).mockResolvedValue(null);

    // Call the API
    const response = await POST(req);

    // Read the stream
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    
    if (reader) {
      let done = false;
      while (!done) {
        const result = await reader.read();
        done = result.done;
        if (!done) {
          chunks.push(result.value);
        }
      }
    }
    
    // Convert chunks to text
    const text = chunks.map(chunk => new TextDecoder().decode(chunk)).join('');
    
    // Verify the stream contains the error
    expect(text).toContain('"error":"Unauthorized"');
    
    // Verify the dependencies were called correctly
    expect(getCurrentUserWithDb).toHaveBeenCalled();
    expect(checkUserCredits).not.toHaveBeenCalled();
    expect(sendGeminiRequest).not.toHaveBeenCalled();
  });
});
