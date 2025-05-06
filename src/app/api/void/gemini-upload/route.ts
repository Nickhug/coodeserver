import { NextRequest } from 'next/server';
import { getCurrentUserWithDb } from '../../../../lib/clerk/auth';
import { checkUserCredits } from '../../../../lib/clerk/auth';
import { updateUserCredits } from '../../../../lib/supabase/client';
import { sendGeminiRequest } from '../../../../lib/ai-providers/gemini-provider';
import { logUsage } from '../../../../lib/supabase/client';
import { NextResponse } from 'next/server';
import { logger } from '../../../../lib/logger';
import { createCorsResponse } from '../../../../lib/api-utils';

// Helper function to parse multipart form data
async function parseMultipartForm(req: NextRequest) {
  const formData = await req.formData();

  // Extract files
  const files: Express.Multer.File[] = [];
  for (const entry of formData.entries()) {
    const [name, value] = entry;
    if (name.startsWith('file') && value instanceof Blob) {
      const file = value as File;
      const buffer = Buffer.from(await file.arrayBuffer());

      files.push({
        fieldname: name,
        originalname: file.name,
        encoding: '7bit',
        mimetype: file.type,
        buffer,
        size: file.size,
        destination: '',
        filename: file.name,
        path: '',
      } as Express.Multer.File);
    }
  }

  // Extract other form fields
  const model = formData.get('model') as string;
  const prompt = formData.get('prompt') as string;
  const systemMessage = formData.get('systemMessage') as string || undefined;
  const temperature = parseFloat(formData.get('temperature') as string) || 0.7;
  const maxTokens = parseInt(formData.get('maxTokens') as string) || undefined;
  const requestId = formData.get('requestId') as string;

  // Parse tools if present
  let tools;
  const toolsJson = formData.get('tools') as string;
  if (toolsJson) {
    try {
      tools = JSON.parse(toolsJson);
    } catch (error) {
      console.error('Error parsing tools JSON:', error);
    }
  }

  return {
    model,
    prompt,
    systemMessage,
    temperature,
    maxTokens,
    requestId,
    tools,
    files
  };
}

/**
 * Handle OPTIONS requests for CORS preflight
 */
export async function OPTIONS() {
  return createCorsResponse({}, 200);
}

/**
 * File upload endpoint for Gemini
 */
export async function POST(req: NextRequest) {
  try {
    logger.info('Gemini upload request received');

    // Authenticate user - pass request to support token-based auth
    const userInfo = await getCurrentUserWithDb(req);
    if (!userInfo) {
      logger.warn('Unauthorized access attempt to Gemini upload endpoint');
      return NextResponse.json(
        { error: 'Unauthorized', message: 'Authentication failed. Please log in again.' },
        {
          status: 401,
          headers: {
            'Access-Control-Allow-Origin': 'vscode-file://vscode-app',
            'Access-Control-Allow-Credentials': 'true',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, HEAD, PUT, DELETE',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept, X-Request-Type, X-Request-ID',
          }
        }
      );
    }

    // Parse multipart form data
    const {
      model,
      prompt,
      systemMessage,
      temperature,
      maxTokens,
      requestId,
      tools,
      files
    } = await parseMultipartForm(req);

    // Validate required fields
    if (!model || !prompt || !requestId) {
      logger.warn('Missing required fields in Gemini upload request');
      return NextResponse.json(
        { error: 'Missing required fields: model, prompt, or requestId' },
        { status: 400 }
      );
    }

    logger.info(`Processing Gemini upload request for user ${userInfo.dbUser.id}`, {
      model,
      requestId,
      fileCount: files.length
    });

    // Estimate required credits (conservative estimate)
    const estimatedTokens = Math.ceil(prompt.length / 4) * 2; // Double to account for response
    const requiredCredits = estimatedTokens / 1000; // Rough conversion

    // Check if user has enough credits - pass the request for token auth
    const { hasCredits, creditsRemaining } = await checkUserCredits(requiredCredits, req);

    if (!hasCredits) {
      logger.warn(`Insufficient credits for user ${userInfo.dbUser.id}`, {
        creditsRemaining,
        requiredCredits
      });
      return NextResponse.json(
        {
          error: 'Insufficient credits',
          creditsRemaining,
          requiredCredits,
          requestId
        },
        { status: 402 }
      );
    }

    // Send request to Gemini
    const response = await sendGeminiRequest({
      apiKey: process.env.GEMINI_API_KEY!,
      model,
      messages: [{ role: 'user', content: prompt }],
      systemMessage,
      temperature,
      maxTokens,
      files,
      tools,
    });

    // Deduct credits
    await updateUserCredits(userInfo.dbUser.id, -response.creditsUsed);

    logger.info(`Completed Gemini upload request for user ${userInfo.dbUser.id}`, {
      tokensUsed: response.tokensUsed,
      creditsUsed: response.creditsUsed,
      model,
      requestId
    });

    // Log usage
    await logUsage({
      user_id: userInfo.dbUser.id,
      provider: 'gemini',
      model,
      tokens_used: response.tokensUsed,
      credits_used: response.creditsUsed,
    });

    // Return the response
    return NextResponse.json({
      text: response.text,
      tokensUsed: response.tokensUsed,
      creditsUsed: response.creditsUsed,
      creditsRemaining: creditsRemaining - response.creditsUsed,
      toolCall: response.toolCall,
      requestId
    }, {
      headers: {
        'Access-Control-Allow-Origin': 'vscode-file://vscode-app',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, HEAD, PUT, DELETE',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept, X-Request-Type, X-Request-ID',
      }
    });

  } catch (error) {
    logger.error('Error in Gemini upload API:', error);

    return NextResponse.json(
      {
        error: 'Internal server error',
        message: (error as Error).message
      },
      {
        status: 500,
        headers: {
          'Access-Control-Allow-Origin': 'vscode-file://vscode-app',
          'Access-Control-Allow-Credentials': 'true',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, HEAD, PUT, DELETE',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept, X-Request-Type, X-Request-ID',
        }
      }
    );
  }
}
