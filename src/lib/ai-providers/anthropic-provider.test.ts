import { jest } from '@jest/globals';
import { sendAnthropicRequest, getModelConfig, estimateTokenCount, convertToAnthropicTools } from './anthropic-provider';

// Mock Anthropic SDK
jest.mock('@anthropic-ai/sdk', () => {
  return {
    Anthropic: jest.fn().mockImplementation(() => ({
      messages: {
        create: jest.fn().mockResolvedValue({
          content: [
            { type: 'text', text: 'This is a test response' }
          ]
        }),
        stream: jest.fn().mockReturnValue({
          on: jest.fn().mockImplementation((event, callback) => {
            if (event === 'text') {
              callback('This is a test response');
            } else if (event === 'finalMessage') {
              callback({
                content: [
                  { type: 'text', text: 'This is a test response' }
                ]
              });
            }
            return {
              controller: {
                abort: jest.fn()
              }
            };
          }),
          finalMessage: jest.fn().mockResolvedValue({
            content: [
              { type: 'text', text: 'This is a test response' }
            ]
          }),
          controller: {
            abort: jest.fn()
          }
        })
      }
    })),
    APIError: class extends Error {
      status: number;
      constructor(message: string, status: number) {
        super(message);
        this.status = status;
      }
    }
  };
});

describe('Anthropic Provider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });
  
  describe('getModelConfig', () => {
    it('should return the correct config for a known model', () => {
      const config = getModelConfig('claude-3-7-sonnet-20250219');
      expect(config).toBeDefined();
      expect(config.contextWindow).toBe(200_000);
      expect(config.maxOutputTokens).toBe(8_192);
    });
    
    it('should return a fallback config for an unknown model', () => {
      const config = getModelConfig('unknown-model');
      expect(config).toBeDefined();
      expect(config.contextWindow).toBe(200_000);
      expect(config.maxOutputTokens).toBe(4_096);
    });
    
    it('should match model family for similar models', () => {
      const config = getModelConfig('claude-3-7-sonnet-latest');
      expect(config).toBeDefined();
      expect(config.contextWindow).toBe(200_000);
      expect(config.maxOutputTokens).toBe(8_192);
    });
  });
  
  describe('estimateTokenCount', () => {
    it('should estimate tokens based on character count', () => {
      expect(estimateTokenCount('Hello, world!')).toBe(4); // 13 chars / 4 = 3.25, ceil to 4
      expect(estimateTokenCount('')).toBe(0);
      expect(estimateTokenCount('This is a longer text that should have more tokens')).toBe(13);
    });
  });
  
  describe('convertToAnthropicTools', () => {
    it('should convert tools to Anthropic format', () => {
      const tools = [
        {
          name: 'get_weather',
          description: 'Get the current weather',
          parameters: {
            location: { description: 'The city and state' }
          }
        }
      ];
      
      const anthropicTools = convertToAnthropicTools(tools);
      expect(anthropicTools).toHaveLength(1);
      expect(anthropicTools[0].name).toBe('get_weather');
      expect(anthropicTools[0].description).toBe('Get the current weather');
      expect(anthropicTools[0].input_schema.properties.location.type).toBe('string');
    });
  });
  
  describe('sendAnthropicRequest', () => {
    it('should send a request to Anthropic and return the response', async () => {
      const onStream = jest.fn();
      
      const result = await sendAnthropicRequest({
        apiKey: 'test-api-key',
        model: 'claude-3-7-sonnet-20250219',
        messages: [{ role: 'user', content: 'Hello, world!' }],
        temperature: 0.7,
        onStream
      });
      
      expect(result.text).toBe('This is a test response');
      expect(result.tokensUsed).toBeGreaterThan(0);
      expect(result.creditsUsed).toBeGreaterThan(0);
    });
    
    it('should handle streaming requests', async () => {
      const onStream = jest.fn();
      
      const result = await sendAnthropicRequest({
        apiKey: 'test-api-key',
        model: 'claude-3-7-sonnet-20250219',
        messages: [{ role: 'user', content: 'Hello, world!' }],
        temperature: 0.7,
        onStream
      });
      
      expect(result.text).toBe('This is a test response');
      expect(onStream).toHaveBeenCalledWith('This is a test response');
    });
    
    it('should handle tools', async () => {
      const tools = [
        {
          name: 'get_weather',
          description: 'Get the current weather',
          parameters: {
            location: { description: 'The city and state' }
          }
        }
      ];
      
      const result = await sendAnthropicRequest({
        apiKey: 'test-api-key',
        model: 'claude-3-7-sonnet-20250219',
        messages: [{ role: 'user', content: 'What is the weather in San Francisco?' }],
        tools,
        temperature: 0.7
      });
      
      expect(result.text).toBe('This is a test response');
    });
  });
});
