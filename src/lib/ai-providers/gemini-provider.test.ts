import { sendGeminiRequest, fileToGeminiPart, GEMINI_MODELS } from './gemini-provider';
import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';

// Mock the Google Generative AI SDK
jest.mock('@google/generative-ai', () => {
  const mockGenerateContentStream = jest.fn();
  const mockGenerateContent = jest.fn();
  
  const mockGenerativeModel = {
    generateContentStream: mockGenerateContentStream,
    generateContent: mockGenerateContent,
  };
  
  const mockGetGenerativeModel = jest.fn().mockReturnValue(mockGenerativeModel);
  
  return {
    GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
      getGenerativeModel: mockGetGenerativeModel,
    })),
    GenerativeModel: jest.fn(),
  };
});

describe('Gemini Provider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });
  
  describe('sendGeminiRequest', () => {
    it('should send a request to Gemini and return the response', async () => {
      // Mock the generateContent response
      const mockResponse = {
        response: {
          text: () => 'This is a test response',
          functionCalls: () => [],
        },
      };
      
      const mockGenerativeModel = (GoogleGenerativeAI as jest.Mock).mock.results[0].value.getGenerativeModel();
      mockGenerativeModel.generateContent.mockResolvedValue(mockResponse);
      
      // Call the function
      const result = await sendGeminiRequest({
        apiKey: 'test-api-key',
        model: 'gemini-1.5-pro',
        messages: [{ role: 'user', content: 'Hello, world!' }],
        temperature: 0.7,
      });
      
      // Verify the result
      expect(result).toEqual({
        text: 'This is a test response',
        tokensUsed: expect.any(Number),
        creditsUsed: expect.any(Number),
      });
      
      // Verify the API was called correctly
      expect(GoogleGenerativeAI).toHaveBeenCalledWith('test-api-key');
      expect(mockGenerativeModel.generateContent).toHaveBeenCalledWith({
        contents: [
          {
            role: 'user',
            parts: [{ text: 'Hello, world!' }],
          },
        ],
      });
    });
    
    it('should handle streaming responses', async () => {
      // Mock the streaming response
      const mockStream = {
        stream: [
          { text: () => 'This ', functionCalls: () => [] },
          { text: () => 'is ', functionCalls: () => [] },
          { text: () => 'a ', functionCalls: () => [] },
          { text: () => 'test', functionCalls: () => [] },
        ],
      };
      
      const mockGenerativeModel = (GoogleGenerativeAI as jest.Mock).mock.results[0].value.getGenerativeModel();
      mockGenerativeModel.generateContentStream.mockResolvedValue(mockStream);
      
      // Create a mock stream callback
      const onStream = jest.fn();
      
      // Call the function
      const result = await sendGeminiRequest({
        apiKey: 'test-api-key',
        model: 'gemini-1.5-pro',
        messages: [{ role: 'user', content: 'Hello, world!' }],
        temperature: 0.7,
        onStream,
      });
      
      // Verify the result
      expect(result).toEqual({
        text: 'This is a test',
        tokensUsed: expect.any(Number),
        creditsUsed: expect.any(Number),
      });
      
      // Verify the stream callback was called for each chunk
      expect(onStream).toHaveBeenCalledTimes(4);
      expect(onStream).toHaveBeenNthCalledWith(1, 'This ');
      expect(onStream).toHaveBeenNthCalledWith(2, 'is ');
      expect(onStream).toHaveBeenNthCalledWith(3, 'a ');
      expect(onStream).toHaveBeenNthCalledWith(4, 'test');
    });
    
    it('should handle tool calls', async () => {
      // Mock the generateContent response with a function call
      const mockResponse = {
        response: {
          text: () => 'I will search for that',
          functionCalls: () => [{
            name: 'search',
            args: { query: 'test query' },
          }],
        },
      };
      
      const mockGenerativeModel = (GoogleGenerativeAI as jest.Mock).mock.results[0].value.getGenerativeModel();
      mockGenerativeModel.generateContent.mockResolvedValue(mockResponse);
      
      // Call the function
      const result = await sendGeminiRequest({
        apiKey: 'test-api-key',
        model: 'gemini-1.5-pro',
        messages: [{ role: 'user', content: 'Search for test' }],
        temperature: 0.7,
        tools: [
          {
            name: 'search',
            description: 'Search for information',
            parameters: {
              query: { description: 'The search query' },
            },
          },
        ],
      });
      
      // Verify the result
      expect(result).toEqual({
        text: 'I will search for that',
        tokensUsed: expect.any(Number),
        creditsUsed: expect.any(Number),
        toolCall: {
          name: 'search',
          parameters: { query: 'test query' },
          id: expect.any(String),
        },
      });
    });
  });
  
  describe('fileToGeminiPart', () => {
    it('should convert an image file to a Gemini part', () => {
      // Create a mock file
      const file = {
        fieldname: 'file',
        originalname: 'test.jpg',
        encoding: '7bit',
        mimetype: 'image/jpeg',
        buffer: Buffer.from('test-image-data'),
        size: 14,
        destination: '',
        filename: 'test.jpg',
        path: '',
      } as Express.Multer.File;
      
      // Convert the file to a Gemini part
      const part = fileToGeminiPart(file);
      
      // Verify the result
      expect(part).toEqual({
        inlineData: {
          data: 'dGVzdC1pbWFnZS1kYXRh', // Base64 encoded 'test-image-data'
          mimeType: 'image/jpeg',
        },
      });
    });
    
    it('should convert a text file to a Gemini part', () => {
      // Create a mock file
      const file = {
        fieldname: 'file',
        originalname: 'test.txt',
        encoding: '7bit',
        mimetype: 'text/plain',
        buffer: Buffer.from('test-text-data'),
        size: 14,
        destination: '',
        filename: 'test.txt',
        path: '',
      } as Express.Multer.File;
      
      // Convert the file to a Gemini part
      const part = fileToGeminiPart(file);
      
      // Verify the result
      expect(part).toEqual({
        text: 'test-text-data',
      });
    });
  });
});
