import { NextRequest } from 'next/server';
import { POST } from './route';
import { handleClientRequest } from '../../../../lib/ai-providers/client-api';
import { sendLLMRequest } from '../../../../lib/ai-providers/providers';

// Mock the dependencies
jest.mock('../../../../lib/ai-providers/client-api', () => ({
  handleClientRequest: jest.fn(),
}));

jest.mock('../../../../lib/api-utils', () => ({
  createCorsResponse: jest.fn((body, status = 200) => ({
    body,
    status,
  })),
}));

describe('LLM Message API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should handle POST requests', async () => {
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

    // Mock the handleClientRequest implementation
    (handleClientRequest as jest.Mock).mockResolvedValue({
      json: () => ({
        fullText: 'Hello! How can I help you today?',
        requestId: '123',
      }),
    });

    // Call the API
    const response = await POST(req);

    // Verify the response
    expect(handleClientRequest).toHaveBeenCalledWith(req);
    expect(response).toBeDefined();
  });

  it('should handle OPTIONS requests for CORS', async () => {
    // Mock the request
    const req = new NextRequest('https://example.com/api/void/llm-message', {
      method: 'OPTIONS',
    });

    // Call the API
    const response = await POST(req);

    // Verify the response
    expect(handleClientRequest).not.toHaveBeenCalled();
    expect(response).toBeDefined();
    expect(response.status).toBe(200);
  });

  it('should handle errors', async () => {
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

    // Mock the handleClientRequest implementation to throw an error
    (handleClientRequest as jest.Mock).mockRejectedValue(new Error('Test error'));

    // Call the API
    const response = await POST(req);

    // Verify the response
    expect(handleClientRequest).toHaveBeenCalledWith(req);
    expect(response).toBeDefined();
    expect(response.status).toBe(500);
  });
});
