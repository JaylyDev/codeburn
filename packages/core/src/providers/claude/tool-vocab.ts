// Canonical tool-name vocabulary shared by the Claude rich decode and the CLI's
// host-side classifier. Defined here so the decode (which keys its input-field
// capture off these sets) and the classifier stay in lockstep without the CLI
// re-declaring them.
export const EDIT_TOOLS = new Set(['Edit', 'Write', 'FileEditTool', 'FileWriteTool', 'NotebookEdit', 'cursor:edit'])

export const BASH_TOOLS = new Set(['Bash', 'BashTool', 'PowerShellTool'])
