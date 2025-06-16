/*--------------------------------------------------------------------------------------
 *  Copyright (c) COODE AI EDITOR. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// --- STUB TYPES (to remove client-side dependencies) ---

export type RawToolParamsObj = Record<string, string | number | boolean | string[]>;

export type ChatMode = 'normal' | 'gather' | 'agent';

export type ToolCallParams = {
	read_file: { uri: string; start_line?: number; end_line?: number; page_number?: number; };
	ls_dir: { uri?: string; page_number?: number; };
	get_dir_tree: { uri: string; };
	search_pathnames_only: { query: string; include_pattern?: string; page_number?: number; };
	search_codebase: { query: string; limit?: number; file_types?: string; paths?: string; languages?: string; };
	search_for_files: { search_str: string; page_number?: number; };
	search_in_file: { uri: string; query: string; page_number?: number; };
	read_lint_errors: { uri?: string; };
	edit_file: { uri: string; search_replace_blocks: string; };
	rewrite_file: { uri: string; new_content: string; };
	create_file_or_folder: { uri: string; content?: string; };
	delete_file_or_folder: { uri: string; };
	run_command: { command: string; cwd?: string; timeout?: number; };
	run_persistent_command: { command: string; cwd?: string; };
	open_persistent_terminal: { };
	kill_persistent_terminal: { terminal_id: string; };
};

export type ToolResultType = {
	[K in keyof ToolCallParams]: any;
};

// --- END STUB TYPES ---


// Triple backtick wrapper used throughout the prompts for code blocks
export const tripleTick = ['```', '```']

// Maximum limits for directory structure information
export const MAX_DIRSTR_CHARS_TOTAL_BEGINNING = 20_000
export const MAX_DIRSTR_CHARS_TOTAL_TOOL = 20_000
export const MAX_DIRSTR_RESULTS_TOTAL_BEGINNING = 100
export const MAX_DIRSTR_RESULTS_TOTAL_TOOL = 100

// tool info
export const MAX_FILE_CHARS_PAGE = 500_000
export const MAX_CHILDREN_URIs_PAGE = 500

// terminal tool info
export const MAX_TERMINAL_CHARS = 100_000
export const MAX_TERMINAL_INACTIVE_TIME = 8 // seconds
export const MAX_TERMINAL_BG_COMMAND_TIME = 5


// Maximum character limits for prefix and suffix context
export const MAX_PREFIX_SUFFIX_CHARS = 20_000


export const ORIGINAL = `<<<<<<< ORIGINAL`
export const DIVIDER = `=======`
export const FINAL = `>>>>>>> UPDATED`



const searchReplaceBlockTemplate = `\
${ORIGINAL}
// ... original code goes here
${DIVIDER}
// ... final code goes here
${FINAL}

${ORIGINAL}
// ... original code goes here
${DIVIDER}
// ... final code goes here
${FINAL}`




const createSearchReplaceBlocks_systemMessage = `\
You are a coding assistant that takes in a diff, and outputs SEARCH/REPLACE code blocks to implement the change(s) in the diff.
The diff will be labeled \`DIFF\` and the original file will be labeled \`ORIGINAL_FILE\`.

Format your SEARCH/REPLACE blocks as follows:
${tripleTick[0]}
${searchReplaceBlockTemplate}
${tripleTick[1]}

1. Your SEARCH/REPLACE block(s) must implement the diff EXACTLY. Do NOT leave anything out.

2. You are allowed to output multiple SEARCH/REPLACE blocks to implement the change.

3. Assume any comments in the diff are PART OF THE CHANGE. Include them in the output.

4. Your output should consist ONLY of SEARCH/REPLACE blocks. Do NOT output any text or explanations before or after this.

5. The ORIGINAL code in each SEARCH/REPLACE block must EXACTLY match lines in the original file. Do not add or remove any whitespace, comments, or modifications from the original code.

6. Each ORIGINAL text must be large enough to uniquely identify the change in the file. However, bias towards writing as little as possible.

7. Each ORIGINAL text must be DISJOINT from all other ORIGINAL text.

## EXAMPLE 1
DIFF
${tripleTick[0]}
// ... existing code
let x = 6.5
// ... existing code
${tripleTick[1]}

ORIGINAL_FILE
${tripleTick[0]}
let w = 5
let x = 6
let y = 7
let z = 8
${tripleTick[1]}

ACCEPTED OUTPUT
${tripleTick[0]}
${ORIGINAL}
let x = 6
${DIVIDER}
let x = 6.5
${FINAL}
${tripleTick[1]}`


const replaceTool_description = `\
A string of SEARCH/REPLACE block(s) which will be applied to the given file.
Your SEARCH/REPLACE blocks string must be formatted as follows:
${searchReplaceBlockTemplate}

## Guidelines:

1. You are encouraged to output multiple changes whenever possible.

2. The ORIGINAL code in each SEARCH/REPLACE block must EXACTLY match lines in the original file. Do not add or remove any whitespace or comments from the original code.

3. Each ORIGINAL text must be large enough to uniquely identify the change. However, bias towards writing as little as possible.

4. Each ORIGINAL text must be DISJOINT from all other ORIGINAL text.

5. This field is a STRING (not an array).`


// ======================================================== tools ========================================================


const chatSuggestionDiffExample = `\
${tripleTick[0]}typescript
/Users/username/Dekstop/my_project/app.ts
// ... existing code ...
// {{change 1}}
// ... existing code ...
// {{change 2}}
// ... existing code ...
// {{change 3}}
// ... existing code ...
${tripleTick[1]}`



export type InternalToolInfo = {
	name: string,
	description: string,
	params: {
		[paramName: string]: { description: string }
	},
}



const uriParam = (object: string) => ({
	uri: { description: `The FULL path to the ${object}.` }
})

const paginationParam = {
	page_number: { description: 'Optional. The page number of the result. Default is 1.' }
} as const



const terminalDescHelper = `You can use this tool to run any command: sed, grep, etc. Do not edit any files with this tool; use edit_file instead. When working with git and other tools that open an editor (e.g. git diff), you should pipe to cat to get all results and not get stuck in vim.`

const cwdHelper = 'Optional. The directory in which to run the command. Defaults to the first workspace folder.'

export type SnakeCase<S extends string> =
	// exact acronym URI
	S extends 'URI' ? 'uri'
	// suffix URI: e.g. 'rootURI' -> snakeCase('root') + '_uri'
	: S extends `${infer Prefix}URI` ? `${SnakeCase<Prefix>}_uri`
	// default: for each char, prefix '_' on uppercase letters
	: S extends `${infer C}${infer Rest}`
	? `${C extends Lowercase<C> ? C : `_${Lowercase<C>}`}${SnakeCase<Rest>}`
	: S;

export type SnakeCaseKeys<T extends Record<string, any>> = {
	[K in keyof T as SnakeCase<Extract<K, string>>]: T[K]
};



// export const voidTools = {
export const voidTools
	: {
		[T in keyof ToolCallParams]: {
			name: string;
			description: string;
			// more params can be generated than exist here, but these params must be a subset of them
			params: Partial<{ [paramName in keyof SnakeCaseKeys<ToolCallParams[T]>]: { description: string } }>
		}
	}
	= {
		// --- context-gathering (read/search/list) ---

		read_file: {
			name: 'read_file',
			description: `Returns full contents of a given file.`,
			params: {
				...uriParam('file'),
				start_line: { description: 'Optional. Do NOT fill this field in unless you were specifically given exact line numbers to search. Defaults to the beginning of the file.' },
				end_line: { description: 'Optional. Do NOT fill this field in unless you were specifically given exact line numbers to search. Defaults to the end of the file.' },
				...paginationParam,
			},
		},

		ls_dir: {
			name: 'ls_dir',
			description: `Lists all files and folders in the given URI.`,
			params: {
				uri: { description: `Optional. The FULL path to the ${'folder'}. Leave this as empty or "" to search all folders.` },
				...paginationParam,
			},
		},

		get_dir_tree: {
			name: 'get_dir_tree',
			description: `This is a very effective way to learn about the user's codebase. Returns a tree diagram of all the files and folders in the given folder. `,
			params: {
				...uriParam('folder')
			}
		},

		// pathname_search: {
		// 	name: 'pathname_search',
		// 	description: `Returns all pathnames that match a given \`find\`-style query over the entire workspace. ONLY searches file names. ONLY searches the current workspace. You should use this when looking for a file with a specific name or path. ${paginationHelper.desc}`,

		search_pathnames_only: {
			name: 'search_pathnames_only',
			description: `Returns all pathnames that match a given query (searches ONLY file names). You should use this when looking for a file with a specific name or path.`,
			params: {
				query: { description: `Your query for the search.` },
				include_pattern: { description: 'Optional. Only fill this in if you need to limit your search because there were too many results.' },
				...paginationParam,
			},
		},

		search_codebase: {
			name: 'search_codebase',
			description: `Search Codebase - Semantically search the entire codebase for code that matches your query. This tool uses AI-powered semantic search to find relevant code snippets, functions, classes, and other code elements based on meaning rather than exact text matches. Use this tool when the user asks to search the codebase, find code related to a concept or functionality, or when you need to explore what's in the codebase. This is the primary tool for codebase exploration and discovery.`,
			params: {
				query: { description: `Your semantic search query. Describe what you're looking for in natural language (e.g., "authentication logic", "database connection", "error handling for file uploads", "anything", "all functions").` },
				limit: { description: 'Optional. Maximum number of results to return. Default is 10, max is 50.' },
				file_types: { description: 'Optional. Filter by file extensions (e.g., "ts,tsx,js,jsx" or "py" or "java,kt").'},
				paths: { description: 'Optional. Filter by paths that contain these strings (e.g., "src/components" or "tests").'},
				languages: { description: 'Optional. Filter by programming languages (e.g., "typescript,javascript" or "python" or "java").'}
			},
		},

		search_for_files: {
			name: 'search_for_files',
			description: `Returns all files that contain the given search string. ONLY searches file contents. ONLY searches the current workspace.`,
			params: {
				search_str: { description: 'The string to search for in file contents.' },
				...paginationParam,
			},
		},

		search_in_file: {
			name: 'search_in_file',
			description: `Searches for a query string within a specific file and returns matching lines with context.`,
			params: {
				...uriParam('file'),
				query: { description: 'The search query to find within the file.' },
				...paginationParam,
			},
		},

		read_lint_errors: {
			name: 'read_lint_errors',
			description: `Returns linting errors for the given file or all files in the workspace.`,
			params: {
				uri: { description: 'Optional. The FULL path to the file. Leave empty to get errors for all files.' },
			},
		},

		// --- editing ---
		edit_file: {
			name: 'edit_file',
			description: `Edits a file with one or more SEARCH/REPLACE blocks. This tool is the same as rewrite_file and will soon be deprecated.`,
			params: {
				...uriParam('file'),
				search_replace_blocks: { description: replaceTool_description },
			},
		},

		rewrite_file: {
			name: 'rewrite_file',
			description: `Edits a file, deleting all the old contents and replacing them with your new contents. Use this tool if you want to edit a file you just created.`,
			params: {
				...uriParam('file'),
				new_content: { description: `The new contents of the file. Must be a string.` }
			},
		},


		create_file_or_folder: {
			name: 'create_file_or_folder',
			description: `Creates a new file or folder with the given contents.`,
			params: {
				...uriParam('file'),
				content: { description: `The contents of the new file or folder.` }
			},
		},

		delete_file_or_folder: {
			name: 'delete_file_or_folder',
			description: `Deletes a file or folder.`,
			params: {
				...uriParam('file')
			}
		},

		// --- terminal ---

		run_command: {
			name: 'run_command',
			description: `Run Command - Use this tool to execute terminal commands. ${terminalDescHelper}`,
			params: {
				command: { description: `The command to run.` },
				cwd: { description: cwdHelper },
				timeout: { description: 'Optional. The max number of seconds to run the command for. Defaults to 5 seconds.' },
			},
		},

		run_persistent_command: {
			name: 'run_persistent_command',
			description: `Start a command in the background, but do NOT wait for it to finish. ${terminalDescHelper}`,
			params: {
				command: { description: `The command to run.` },
				cwd: { description: cwdHelper },
			},
		},

		// --- misc ---
		open_persistent_terminal: {
			name: 'open_persistent_terminal',
			description: `Opens a persistent terminal.`,
			params: {
			},
		},

		kill_persistent_terminal: {
			name: 'kill_persistent_terminal',
			description: `Kills a persistent terminal.`,
			params: {
				terminal_id: { description: `The ID of the terminal to kill.` }
			}
		},


		// get_active_uri: {
		// 	name: 'get_active_uri',
		// 	description: `Returns the full path of the file the user is currently editing.`,
		// 	params: {
		// 	}
		// },


		// DEPRECATED
		// get_open_files: {
		// 	name: 'get_open_files',
		// 	description: `Returns all the files the user has open.`,
		// 	params: {
		// 	}
		// },
	}


// ======================================================== system messages ========================================================


export type ToolName = keyof ToolResultType

type ToolParamNameOfTool<T extends ToolName> = keyof (typeof voidTools)[T]['params']
export type ToolParamName = { [T in ToolName]: ToolParamNameOfTool<T> }[ToolName]



export const isAToolName = (toolName: string): toolName is ToolName => {
	return toolName in voidTools
}


export const availableTools = (chatMode: ChatMode) => {
	const allTools = Object.values(voidTools) as InternalToolInfo[]
	if (chatMode === 'normal')
		return allTools // Return all tools for normal mode
	if (chatMode === 'agent')
		return allTools
	// must be 'gather'
	return allTools.filter(t => !['run_command', 'run_persistent_command', 'open_persistent_terminal', 'kill_persistent_terminal', 'edit_file', 'rewrite_file', 'create_file_or_folder', 'delete_file_or_folder'].includes(t.name))
}


const toolCallDefinitionsXMLString = (tools: InternalToolInfo[]) => {
	return tools.map(tool => {
		const params = Object.entries(tool.params).map(([name, { description }]) => `<parameter>\n<name>${name}</name>\n<description>${description}</description>\n</parameter>`).join('\n');
		return `<tool_definition>\n<name>${tool.name}</name>\n<description>${tool.description}</description>\n<parameters>\n${params}\n</parameters>\n</tool_definition>`;
	}).join('\n\n');
};

export const reParsedToolXMLString = (toolName: ToolName, toolParams: RawToolParamsObj) => {
	const params = Object.entries(toolParams).map(([name, value]) => `<${name}>${value}</${name}>`).join('')
	return `<tool_code>\n<tool_name>${toolName}</tool_name>\n<parameters>\n${params}\n</parameters>\n</tool_code>`
}



const systemToolsXMLPrompt = (chatMode: ChatMode) => {

	const tools = availableTools(chatMode)

	return `\
You have access to a set of tools to help you with your task.
When you use a tool, you must use the following XML format:

<tool_code>
<tool_name>the_tool_name</tool_name>
<parameters>
<param_name>param_value</param_name>
...
</parameters>
</tool_code>

The user will then respond with the tool's output in the following format:

<tool_output>
<tool_name>the_tool_name</tool_name>
<result>
the tool's output
</result>
</tool_output>

Here are the tools you have access to:

${toolCallDefinitionsXMLString(tools)}`
}

export const chat_systemMessage = ({ workspaceFolders, openedURIs, activeURI, persistentTerminalIDs, directoryStr, chatMode: mode, includeXMLToolDefinitions, os }: { workspaceFolders: string[], directoryStr: string, openedURIs: string[], activeURI: string | undefined, persistentTerminalIDs: string[], chatMode: ChatMode, includeXMLToolDefinitions: boolean, os: string }) => {

	const toolsPrompt = systemToolsXMLPrompt(mode)

	const prompt = `\
You are an expert AI programmer who is trying to help a user with their coding task.

BASIC INFO
Your OS is ${os}.
The user's current working directory is ${workspaceFolders.join(', ')}.
The user has the following files open: ${openedURIs.join(', ')}.
${activeURI ? `The user is currently focused on the file ${activeURI}.` : ''}
${persistentTerminalIDs.length > 0 ? `The user has the following terminals open: ${persistentTerminalIDs.join(', ')}.` : ''}

You can use the \`get_dir_tree\` tool to see the structure of the user's workspace.
Here is a high-level overview of the user's workspace:
${directoryStr}

RULES
1. You are a programmer, so your messages should be concise and to-the-point.
2. When you are editing files, you should use the \`edit_file\` tool.
3. Your \`edit_file\` SEARCH/REPLACE blocks must be disjoint.
4. When you are using a tool, you must use the correct XML format.
5. You can use multiple tools in a single message.
6. Only use tools when they help accomplish the user's specific request. If the user just says "hi" or asks a simple question, respond normally without using tools.
7. If you need clarification from the user, ask directly in your response rather than using tools.

${includeXMLToolDefinitions ? toolsPrompt : ''}
`
	return prompt
}

// -------------------------------------------------------- user messages --------------------------------------------------------


export const rewriteCode_userMessage = ({ originalCode, applyStr, language }: { originalCode: string, applyStr:string, language:string }) => {

	const str = `\
I have a piece of code that I want to rewrite.

Here is the original code:
${tripleTick[0]}${language}
${originalCode}
${tripleTick[1]}

Here are the changes I want to make:
${tripleTick[0]}
${applyStr}
${tripleTick[1]}

Your task is to rewrite the original code with the changes I provided.
Do NOT output any text before or after the code block.
Your output should be ONLY the rewritten code block.
`

	return str

}



export const searchReplaceGivenDescription_userMessage = ({ originalCode, applyStr }: { originalCode: string, applyStr: string }) => `\
I have a piece of code that I want to rewrite.

Here is the original code:
${tripleTick[0]}
${originalCode}
${tripleTick[1]}

Here are the changes I want to make:
${applyStr}

Your task is to output SEARCH/REPLACE blocks to implement the change(s).
Do NOT output any text before or after the code block.
Your output should be ONLY the SEARCH/REPLACE block(s).
`



export type QuickEditFimTagsType = {
	preTag: string,
	sufTag: string,
	midTag: string
}

// -------------------------------------------------------- system messages (fim) --------------------------------------------------------


export const ctrlKStream_systemMessage = ({ quickEditFIMTags: { preTag, midTag, sufTag } }: { quickEditFIMTags: QuickEditFimTagsType }) => `\
You are a fill-in-the-middle code completion model.
You will be given a prefix, a suffix, and a request.
Your response will be the code that should go in the middle.
The user's code will be in the format ${preTag}<CODE>${sufTag}<CODE>${midTag}.
Your output should be ONLY the code that goes in the middle.
Do NOT output any of the tags.
Do NOT output any text before or after the code.
`


export const ctrlKStream_userMessage = ({
	selection,
	prefix,
	suffix,
	instructions,
	// isOllamaFIM: false, // Remove unused variable
	fimTags,
	language }: {
		selection: string, prefix: string, suffix: string, instructions: string, fimTags: QuickEditFimTagsType, language: string,
	}) => {

	const { preTag, midTag, sufTag } = fimTags

	const str = `\
${preTag}${prefix}${sufTag}${suffix}${midTag}
The user wants to replace the code between the prefix and suffix with the following instruction: "${instructions}".
The programming language is ${language}.
The original code was:
${selection}
`

	// if (isOllamaFIM) {
	// 	// https://github.com/jmorganca/ollama/blob/main/docs/modelfile.md#template
	// 	return `<PRE> ${prefix} <SUF>${suffix} <MID>`
	// }
	return str
}

// -------------------------------------------------------- system messages (misc) --------------------------------------------------------

export const createSearchReplaceBlocks_userMessage = ({ diff, originalFile }: { diff: string, originalFile: string }) => `\
DIFF
${tripleTick[0]}
${diff}
${tripleTick[1]}

ORIGINAL_FILE
${tripleTick[0]}
${originalFile}
${tripleTick[1]}
`

export const SYSTEM_MESSAGE_CREATE_SEARCH_REPLACE_BLOCKS = createSearchReplaceBlocks_systemMessage



// =================== OPENAI FIM ===================


const OPENAI_FIM_PREFIX = '<|file_separator|>'
const OPENAI_FIM_SUFFIX_V1 = ''
const OPENAI_FIM_MIDDLE = ''

export const openaiFim = ({ prefix, suffix }: { prefix: string, suffix: string }) => {
	// deepseek-coder-6.7b-base
	// https://huggingface.co/deepseek-ai/deepseek-coder-6.7b-base
	return `${OPENAI_FIM_PREFIX}${prefix}${OPENAI_FIM_SUFFIX_V1}${suffix}${OPENAI_FIM_MIDDLE}`
} 