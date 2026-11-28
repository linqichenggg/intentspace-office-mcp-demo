import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createMcpServer } from './mcp-server.js';
import { assertSameOrigin } from './http-utils.js';

export async function withMcpClient(data, action) {
  const server = createMcpServer(data);
  const client = new Client({ name: 'intentspace-cloud-viewer', version: '0.2.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return await action(client);
  } finally {
    await client.close();
    await server.close();
  }
}

export async function handleReadOnlyMcp(request,data) {
  assertSameOrigin(request);
  const server = createMcpServer(data);
  const transport = new WebStandardStreamableHTTPServerTransport({enableJsonResponse:true,maxRequestBodySize:10000});
  try {
    await server.connect(transport);
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}
