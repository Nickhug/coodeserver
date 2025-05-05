import { NextRequest, NextResponse } from 'next/server';
import { handleClientRequest } from './client-api';
import { getCurrentUserWithDb, checkUserCredits } from '../clerk/auth';
import { updateUserCredits } from '../supabase/client';
import { sendLLMRequest } from './providers';

// Mock the dependencies
jest.mock('../clerk/auth', () => ({
  getCurrentUserWithDb: jest.fn(),
  checkUserCredits: jest.fn(),
}));

jest.mock('../supabase/client', () => ({
  updateUserCredits: jest.fn(),
}));

jest.mock('./providers', () => ({
  sendLLMRequest: jest.fn(),
}));

jest.mock('next/server', () => {
  const originalModule = jest.requireActual('next/server');
  return {
    ...originalModule,
    NextResponse: {
      json: jest.fn((body, options) => ({
        body,
        status: options?.status || 200,
      })),
    },
  };
});

describe('Client API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should handle chat message requests', async () => {
    // Mock the request
    const req = new NextRequest('https://example.com/api/void/llm-message', {
      method: 'POST',
      body: JSON.stringify({
        messagesType: 'chatMessages',
        providerName: 'openAI',
        modelName: 'gpt-4',
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

    (sendLLMRequest as jest.Mock).mockResolvedValue({
      text: 'Hello! How can I help you today?',
      tokensUsed: 50,
      creditsUsed: 0.05,
    });

    (updateUserCredits as jest.Mock).mockResolvedValue(undefined);

    // Call the API
    const response = await handleClientRequest(req);

    // Verify the response
    expect(getCurrentUserWithDb).toHaveBeenCalled();
    expect(checkUserCredits).toHaveBeenCalled();
    expect(sendLLMRequest).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'openai',
      model: 'gpt-4',
      userId: 'user-123',
    }));
    expect(updateUserCredits).toHaveBeenCalledWith('user-123', -0.05);
    expect(response.body).toEqual(expect.objectContaining({
      fullText: 'Hello! How can I help you today?',
      requestId: '123',
      tokensUsed: 50,
      creditsUsed: 0.05,
      creditsRemaining: 99.95,
    }));
  });

  it('should handle unauthorized requests', async () => {
    // Mock the request
    const req = new NextRequest('https://example.com/api/void/llm-message', {
      method: 'POST',
      body: JSON.stringify({
        messagesType: 'chatMessages',
        providerName: 'openAI',
        modelName: 'gpt-4',
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
    const response = await handleClientRequest(req);

    // Verify the response
    expect(getCurrentUserWithDb).toHaveBeenCalled();
    expect(checkUserCredits).not.toHaveBeenCalled();
    expect(sendLLMRequest).not.toHaveBeenCalled();
    expect(updateUserCredits).not.toHaveBeenCalled();
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'Unauthorized' });
  });

  it('should handle insufficient credits', async () => {
    // Mock the request
    const req = new NextRequest('https://example.com/api/void/llm-message', {
      method: 'POST',
      body: JSON.stringify({
        messagesType: 'chatMessages',
        providerName: 'openAI',
        modelName: 'gpt-4',
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
      hasCredits: false,
      creditsRemaining: 0.01,
    });

    // Call the API
    const response = await handleClientRequest(req);

    // Verify the response
    expect(getCurrentUserWithDb).toHaveBeenCalled();
    expect(checkUserCredits).toHaveBeenCalled();
    expect(sendLLMRequest).not.toHaveBeenCalled();
    expect(updateUserCredits).not.toHaveBeenCalled();
    expect(response.status).toBe(402);
    expect(response.body).toEqual(expect.objectContaining({
      error: 'Insufficient credits',
      creditsRemaining: 0.01,
      requestId: '123',
    }));
  });
});
