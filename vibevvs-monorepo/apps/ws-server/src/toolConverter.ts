/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Coode AI Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import logger from '@repo/logger';
import { InternalToolInfo } from './prompts/prompts';

/**
 * Gemini API Function Declaration format
 */
export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: {
    type: 'OBJECT';
    properties: Record<string, {
      type: 'STRING' | 'NUMBER' | 'BOOLEAN' | 'ARRAY';
      description: string;
      enum?: string[];
      items?: { type: string };
    }>;
    required: string[];
  };
}

/**
 * Infer parameter type from parameter name and description
 */
function inferParameterType(paramName: string, description: string): 'STRING' | 'NUMBER' | 'BOOLEAN' | 'ARRAY' {
  const lowerName = paramName.toLowerCase();
  const lowerDesc = description.toLowerCase();
  
  // Number indicators
  if (lowerName.includes('line') || 
      lowerName.includes('number') || 
      lowerName.includes('timeout') ||
      lowerName.includes('limit') ||
      lowerName.includes('page') ||
      lowerDesc.includes('number of') ||
      lowerDesc.includes('timeout') ||
      lowerDesc.includes('seconds') ||
      lowerDesc.includes('limit')) {
    return 'NUMBER';
  }
  
  // Boolean indicators
  if (lowerName.includes('enable') || 
      lowerName.includes('is_') ||
      lowerName.includes('has_') ||
      lowerDesc.includes('true') ||
      lowerDesc.includes('false') ||
      lowerDesc.includes('boolean') ||
      lowerDesc.includes('whether')) {
    return 'BOOLEAN';
  }
  
  // Array indicators
  if (lowerName.endsWith('s') && !lowerName.endsWith('ss') ||
      lowerName.includes('list') ||
      lowerName.includes('array') ||
      lowerDesc.includes('array') ||
      lowerDesc.includes('list of') ||
      lowerDesc.includes('comma-separated')) {
    return 'ARRAY';
  }
  
  return 'STRING';
}

/**
 * Extract enum values from description
 */
function extractEnumFromDescription(description: string): string[] | null {
  // Look for patterns like: "can be 'value1', 'value2', or 'value3'"
  const enumPattern1 = /'([^']+)'/g;
  const matches1 = [...description.matchAll(enumPattern1)];
  if (matches1.length > 1) {
    return matches1.map(match => match[1]);
  }
  
  // Look for patterns like: "one of: value1, value2, value3"
  const enumPattern2 = /one of[:\s]+([^.]+)/i;
  const match2 = description.match(enumPattern2);
  if (match2) {
    return match2[1].split(',').map(s => s.trim().replace(/['"]/g, ''));
  }
  
  // Look for patterns like: "(value1|value2|value3)"
  const enumPattern3 = /\(([^)]+\|[^)]+)\)/;
  const match3 = description.match(enumPattern3);
  if (match3) {
    return match3[1].split('|').map(s => s.trim());
  }
  
  return null;
}

/**
 * Determine required parameters (those without "Optional" in description)
 */
function getRequiredParameters(params: Record<string, { description: string }>): string[] {
  return Object.keys(params).filter(paramName => {
    const description = params[paramName].description.toLowerCase();
    return !description.includes('optional') && !description.startsWith('optional');
  });
}

/**
 * Convert internal tool definition to Gemini API format
 */
export function convertToolToGeminiFormat(tool: InternalToolInfo): GeminiFunctionDeclaration {
  const properties: Record<string, any> = {};
  
  // Convert each parameter
  Object.entries(tool.params).forEach(([paramName, paramInfo]) => {
    const type = inferParameterType(paramName, paramInfo.description);
    const enumValues = extractEnumFromDescription(paramInfo.description);
    
    properties[paramName] = {
      type,
      description: paramInfo.description,
      ...(enumValues && { enum: enumValues }),
      ...(type === 'ARRAY' && { items: { type: 'STRING' } })
    };
  });
  
  const required = getRequiredParameters(tool.params);
  
  const geminiTool: GeminiFunctionDeclaration = {
    name: tool.name,
    description: tool.description,
    parameters: {
      type: 'OBJECT',
      properties,
      required
    }
  };
  
  logger.info(`Converted tool ${tool.name}: ${required.length} required params, ${Object.keys(properties).length} total params`);
  
  return geminiTool;
}

/**
 * Convert array of internal tools to Gemini API tools format
 */
export function convertToolsToGeminiFormat(tools: InternalToolInfo[]): Array<{ functionDeclarations: GeminiFunctionDeclaration[] }> {
  if (!tools || tools.length === 0) {
    return [];
  }
  
  const convertedTools = tools.map(convertToolToGeminiFormat);
  
  logger.info(`Converted ${tools.length} tools to Gemini format`);
  
  return [{
    functionDeclarations: convertedTools
  }];
}

/**
 * Validate tool conversion for debugging
 */
export function validateToolConversion(originalTool: InternalToolInfo, convertedTool: GeminiFunctionDeclaration): boolean {
  try {
    // Basic validation
    if (originalTool.name !== convertedTool.name) {
      logger.error(`Tool name mismatch: ${originalTool.name} !== ${convertedTool.name}`);
      return false;
    }
    
    if (!convertedTool.parameters || convertedTool.parameters.type !== 'OBJECT') {
      logger.error(`Invalid parameters structure for tool ${originalTool.name}`);
      return false;
    }
    
    // Check all original params are converted
    const originalParamNames = Object.keys(originalTool.params);
    const convertedParamNames = Object.keys(convertedTool.parameters.properties);
    
    for (const paramName of originalParamNames) {
      if (!convertedParamNames.includes(paramName)) {
        logger.error(`Missing parameter ${paramName} in converted tool ${originalTool.name}`);
        return false;
      }
    }
    
    logger.debug(`Tool ${originalTool.name} conversion validated successfully`);
    return true;
  } catch (error) {
    logger.error(`Error validating tool conversion for ${originalTool.name}:`, error);
    return false;
  }
}

/**
 * Convert ChatMessage array to GeminiMessage array format
 */
export function convertChatMessagesToGeminiFormat(messages: any[]): any[] {
  return messages.map(message => {
    if (message.role === 'user') {
      return {
        role: 'user',
        parts: [{ text: message.content }]
      };
    } else if (message.role === 'assistant' || message.role === 'model') {
      return {
        role: 'model',
        parts: [{ text: message.content }]
      };
    } else if (message.role === 'tool') {
      // Tool responses are handled differently in Gemini
      return {
        role: 'model',
        parts: [{ text: `Tool result: ${message.content}` }]
      };
    } else {
      // Default to user role for unknown roles
      return {
        role: 'user',
        parts: [{ text: message.content }]
      };
    }
  });
} 