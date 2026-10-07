/**
 * An MCP invocation failure whose complete message has already passed through
 * mcpErrorMessage with the server's credentials. Only these errors may cross
 * the model/UI/history boundary; never attach raw upstream errors or bodies.
 */
export class McpToolError extends Error {
  constructor(sanitizedMessage: string) {
    super(sanitizedMessage);
    this.name = "McpToolError";
  }
}
