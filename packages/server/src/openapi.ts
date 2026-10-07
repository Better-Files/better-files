import {
  errorStatus,
  toJsonSchema,
  type EndpointDefinition,
  type OperationSpec,
} from '@better-files/core';

export interface OpenApiOptions {
  title?: string;
  version?: string;
  description?: string;
  /** Absolute server URLs; paths in the document already include the base path. */
  servers?: readonly string[];
}

type Operations = Record<string, Record<string, EndpointDefinition>>;
type JsonSchema = Record<string, unknown>;

const errorCodes = Object.keys(errorStatus);

const errorResponse = {
  description: 'Refused or failed. `code` is stable; `message` is for people.',
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
};

function describeAccess(group: string, method: string, spec: OperationSpec): string {
  const lines = [`Identity-system action \`${spec.action}\` on the ${spec.target}.`];
  if (spec.target === 'public')
    lines[0] = 'Public: no session; the input carries its own proof (a token).';
  if (spec.capabilities?.length)
    lines.push(
      `Needs ${spec.capabilities.map((name) => `\`${name}\``).join(', ')} on the ${spec.target} in the permission matrix.`,
    );
  if (spec.target === 'node')
    lines.push('A node the caller cannot list is reported as `NOT_FOUND`, never `FORBIDDEN`.');
  if (spec.mutates && !spec.allowClosed)
    lines.push('Refused with `ROOM_CLOSED` in closed or archived rooms.');
  lines.push(`Server-side: \`dr.api.${group}.${method}(credential, input)\`.`);
  return lines.join('\n\n');
}

/**
 * An OpenAPI 3.1 document for the mounted protocol: every core and plugin operation (`POST {basePath}/{group}/{method}`),
 * the upload and file routes, and the error envelope. Input schemas come from Standard JSON Schema, so operations
 * validated with `v`, zod 4.2+ or other conforming libraries are described exactly; others appear as open objects.
 */
export function openApiDocument(
  operations: Operations,
  basePath: string,
  options: OpenApiOptions = {},
) {
  const base = basePath.replace(/\/+$/, '');
  const paths: Record<string, unknown> = {};
  const tags: { name: string }[] = [];

  for (const [group, endpoints] of Object.entries(operations)) {
    tags.push({ name: group });
    for (const [method, endpoint] of Object.entries(endpoints)) {
      const input = toJsonSchema(endpoint.input) ?? { type: 'object' };
      const properties = (input.properties as Record<string, JsonSchema> | undefined) ?? {};
      const required = (input.required as string[] | undefined) ?? [];
      const body: JsonSchema = {
        ...input,
        type: 'object',
        properties: { tenantId: { type: 'string', minLength: 1, maxLength: 128 }, ...properties },
        required: ['tenantId', ...required.filter((name) => name !== 'tenantId')],
      };
      const spec = endpoint.operation;
      paths[`${base}/${group}/${method}`] = {
        post: {
          operationId: `${group}.${method}`,
          tags: [group],
          summary: `${group}.${method}`,
          description: describeAccess(group, method, spec),
          ...(spec.target === 'public' ? { security: [] } : {}),
          parameters: [
            { $ref: '#/components/parameters/XBetterFiles' },
            { $ref: '#/components/parameters/XRequestId' },
          ],
          requestBody: { required: true, content: { 'application/json': { schema: body } } },
          responses: {
            '200': {
              description: 'Success',
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { data: {} }, required: ['data'] },
                },
              },
            },
            default: errorResponse,
          },
          'x-better-files': {
            action: spec.action,
            target: spec.target,
            capabilities: spec.capabilities ?? [],
            mutates: spec.mutates,
          },
        },
      };
    }
  }

  const uploadBody = {
    required: true,
    content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
  };
  const uploadResponse = {
    '200': {
      description: 'Received',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              data: {
                type: 'object',
                properties: {
                  uploadId: { type: 'string' },
                  received: { type: 'integer' },
                  part: { type: 'integer' },
                },
              },
            },
          },
        },
      },
    },
    default: errorResponse,
  };
  const tenantQuery = { name: 'tenantId', in: 'query', required: true, schema: { type: 'string' } };
  const uploadId = { name: 'uploadId', in: 'path', required: true, schema: { type: 'string' } };
  paths[`${base}/uploads/{uploadId}/content`] = {
    put: {
      operationId: 'uploads.content',
      tags: ['uploads'],
      summary: 'Upload a whole file',
      description:
        'The body of a single-part upload session from `uploads.create`. Streams; encrypted on the way in.',
      parameters: [uploadId, tenantQuery, { $ref: '#/components/parameters/XBetterFiles' }],
      requestBody: uploadBody,
      responses: uploadResponse,
    },
  };
  paths[`${base}/uploads/{uploadId}/parts/{part}`] = {
    put: {
      operationId: 'uploads.part',
      tags: ['uploads'],
      summary: 'Upload one part',
      description:
        'One part of a multipart upload session. Parts may arrive in any order and be retried.',
      parameters: [
        uploadId,
        { name: 'part', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } },
        tenantQuery,
        { $ref: '#/components/parameters/XBetterFiles' },
      ],
      requestBody: uploadBody,
      responses: uploadResponse,
    },
  };
  paths[`${base}/files/{token}`] = {
    get: {
      operationId: 'files.serve',
      tags: ['files'],
      summary: 'Download or view through a ticket',
      description:
        'Tickets come from `documents.requestView`, `requestDownload` and `requestOriginal`: short-lived, use-limited and bound to the requester. Originals support `Range`.',
      security: [],
      parameters: [
        { name: 'token', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'Range', in: 'header', required: false, schema: { type: 'string' } },
      ],
      responses: {
        '200': {
          description: 'The file',
          content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
        },
        '206': { description: 'A byte range of the original' },
        default: errorResponse,
      },
    },
  };
  paths[`${base}/health`] = {
    get: {
      operationId: 'health',
      tags: ['health'],
      summary: 'Liveness',
      security: [],
      responses: { '200': { description: 'Up' } },
    },
  };

  return {
    openapi: '3.1.0',
    info: {
      title: options.title ?? 'Better Files',
      version: options.version ?? '1.0.0',
      ...(options.description ? { description: options.description } : {}),
    },
    ...(options.servers?.length ? { servers: options.servers.map((url) => ({ url })) } : {}),
    tags: [...tags, { name: 'files' }, { name: 'health' }],
    security: [{ bearer: [] }, { session: [] }],
    paths,
    components: {
      securitySchemes: {
        bearer: {
          type: 'http',
          scheme: 'bearer',
          description: 'A Better IAM access token or API key.',
        },
        session: {
          type: 'apiKey',
          in: 'cookie',
          name: 'session',
          description:
            'The Better IAM session cookie. Cookie requests must come from a trusted origin.',
        },
      },
      parameters: {
        XBetterFiles: {
          name: 'X-Better-Files',
          in: 'header',
          required: true,
          description:
            'Always `1`. Browsers cannot send it cross-site without a preflight, which blocks CSRF.',
          schema: { type: 'string', const: '1' },
        },
        XRequestId: {
          name: 'X-Request-Id',
          in: 'header',
          required: false,
          description: 'Echoed in errors and logs.',
          schema: { type: 'string', maxLength: 64 },
        },
      },
      schemas: {
        Error: {
          type: 'object',
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              required: ['code', 'message'],
              properties: {
                code: { type: 'string', enum: errorCodes },
                message: { type: 'string' },
                requestId: { type: 'string' },
                details: {},
              },
            },
          },
        },
      },
    },
  };
}

export type OpenApiDocument = ReturnType<typeof openApiDocument>;
