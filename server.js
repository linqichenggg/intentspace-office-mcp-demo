import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { data } from './data.js';
import { createMcpServer } from './mcp-server.js';

const server = createMcpServer(data);
await server.connect(new StdioServerTransport());
