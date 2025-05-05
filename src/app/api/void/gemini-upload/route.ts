import { NextRequest } from 'next/server';
import { getCurrentUserWithDb } from '../../../../lib/clerk/auth';
import { checkUserCredits } from '../../../../lib/clerk/auth';
import { updateUserCredits } from '../../../../lib/supabase/client';
import { sendGeminiRequest } from '../../../../lib/ai-providers/gemini-provider';
import { logUsage } from '../../../../lib/supabase/client';
import { NextResponse } from 'next/server';

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
 * File upload endpoint for Gemini
 */
export async function POST(req: NextRequest) {
  try {
    // Authenticate user
    const userInfo = await getCurrentUserWithDb();
    if (!userInfo) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
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
      return NextResponse.json(
        { error: 'Missing required fields: model, prompt, or requestId' },
        { status: 400 }
      );
    }

    // Estimate required credits (conservative estimate)
    const estimatedTokens = Math.ceil(prompt.length / 4) * 2; // Double to account for response
    const requiredCredits = estimatedTokens / 1000; // Rough conversion

    // Check if user has enough credits
    const { hasCredits, creditsRemaining } = await checkUserCredits(requiredCredits);

    if (!hasCredits) {
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
    });

  } catch (error) {
    console.error('Error in Gemini upload API:', error);

    return NextResponse.json(
      {
        error: 'Internal server error',
        message: (error as Error).message
      },
      { status: 500 }
    );
  }
}
