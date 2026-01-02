import {
  AngularNodeAppEngine,
  createNodeRequestHandler,
  isMainModule,
  writeResponseToNodeResponse,
} from '@angular/ssr/node';
import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2CommandOutput,
} from '@aws-sdk/client-s3';
import { fromTemporaryCredentials } from '@aws-sdk/credential-providers';
import express from 'express';
import { join } from 'node:path';
import dotenv from 'dotenv';
import multer from 'multer';

dotenv.config();

const upload = multer({ storage: multer.memoryStorage() });

const openAIAssistantsBetaHeaders = {
  'OpenAI-Beta': 'assistants=v2',
};

type FileMeta = {
  filename?: string;
  bytes?: number;
};

const fileMetaCache = new Map<string, FileMeta>();

type AssistantChatRequest = {
  prompt: string;
  vectorStoreId: string;
  threadId?: string | null;
};

type AssistantChatResponse = {
  reply: string;
  threadId: string;
  citations?: Array<{
    fileId: string;
    vectorStoreId?: string;
    vectorStoreFileId?: string;
    filename?: string;
    bytes?: number;
    quote?: string;
  }>;
};

const assistantIdByVectorStoreId = new Map<string, string>();

type VectorStoreS3Config = {
  bucketName: string;
  prefix: string;
  region: string;
  roleArn?: string;
};

function getVectorStoreS3ConfigFromEnv(): VectorStoreS3Config | null {
  const bucketName = (process.env['VECTOR_STORE_S3_BUCKET'] ?? '').trim();
  if (!bucketName) {
    return null;
  }

  const region =
    (process.env['VECTOR_STORE_S3_REGION'] ?? process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'] ?? '')
      .trim();

  if (!region) {
    throw new Error('VECTOR_STORE_S3_BUCKET is set but no region was provided (set VECTOR_STORE_S3_REGION or AWS_REGION).');
  }

  const rawPrefix = (process.env['VECTOR_STORE_S3_PREFIX'] ?? 'vector-stores/').trim();
  const prefix = rawPrefix.endsWith('/') ? rawPrefix : `${rawPrefix}/`;
  const roleArn = (process.env['VECTOR_STORE_S3_ROLE_ARN'] ?? '').trim() || undefined;

  return { bucketName, prefix, region, roleArn };
}

let cachedVectorStoreS3Client: S3Client | null = null;
let cachedVectorStoreS3ClientKey: string | null = null;

function getVectorStoreS3Client(config: VectorStoreS3Config): S3Client {
  const key = JSON.stringify({ region: config.region, roleArn: config.roleArn ?? '' });
  if (cachedVectorStoreS3Client && cachedVectorStoreS3ClientKey === key) {
    return cachedVectorStoreS3Client;
  }

  const credentials = config.roleArn
    ? fromTemporaryCredentials({
        params: {
          RoleArn: config.roleArn,
          RoleSessionName: 'chat-interface-vector-store-sync',
        },
        clientConfig: { region: config.region },
      })
    : undefined;

  cachedVectorStoreS3Client = new S3Client({
    region: config.region,
    credentials,
  });
  cachedVectorStoreS3ClientKey = key;
  return cachedVectorStoreS3Client;
}

function sanitizeS3KeyComponent(value: string): string {
  return value
    .replaceAll('\\', '_')
    .replaceAll('/', '_')
    .replaceAll('\0', '')
    .trim();
}

function buildVectorStoreRootPrefix(config: VectorStoreS3Config, vectorStoreId: string): string {
  return `${config.prefix}${sanitizeS3KeyComponent(vectorStoreId)}/`;
}

function buildVectorStoreFilePrefix(
  config: VectorStoreS3Config,
  vectorStoreId: string,
  vectorStoreFileId: string,
): string {
  return `${buildVectorStoreRootPrefix(config, vectorStoreId)}files/${sanitizeS3KeyComponent(vectorStoreFileId)}/`;
}

async function ensureVectorStoreFolderExists(config: VectorStoreS3Config, vectorStoreId: string): Promise<void> {
  const s3 = getVectorStoreS3Client(config);
  const folderKey = buildVectorStoreRootPrefix(config, vectorStoreId);
  await s3.send(
    new PutObjectCommand({
      Bucket: config.bucketName,
      Key: folderKey,
      Body: '',
      ContentType: 'application/x-directory',
    }),
  );
}

async function putVectorStoreMetadata(
  config: VectorStoreS3Config,
  vectorStoreId: string,
  metadata: { id: string; name?: string; updatedAt: string },
): Promise<void> {
  const s3 = getVectorStoreS3Client(config);
  const key = `${buildVectorStoreRootPrefix(config, vectorStoreId)}store.json`;
  await s3.send(
    new PutObjectCommand({
      Bucket: config.bucketName,
      Key: key,
      Body: JSON.stringify(metadata, null, 2),
      ContentType: 'application/json',
    }),
  );
}

async function deleteAllObjectsUnderPrefix(config: VectorStoreS3Config, prefix: string): Promise<void> {
  const s3 = getVectorStoreS3Client(config);
  let continuationToken: string | undefined = undefined;

  while (true) {
    const list: ListObjectsV2CommandOutput = await s3.send(
      new ListObjectsV2Command({
        Bucket: config.bucketName,
        Prefix: prefix,
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      }),
    );

    const keys = (list.Contents ?? [])
      .map((c: { Key?: string }) => c.Key)
      .filter((k: string | undefined): k is string => typeof k === 'string' && k.length > 0);

    if (keys.length > 0) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: config.bucketName,
          Delete: {
            Objects: keys.map((Key: string) => ({ Key })),
            Quiet: true,
          },
        }),
      );
    }

    if (!list.IsTruncated) {
      return;
    }
    continuationToken = list.NextContinuationToken;
    if (!continuationToken) {
      return;
    }
  }
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getOrCreateAssistantForVectorStore(apiKey: string, vectorStoreId: string): Promise<string> {
  const cached = assistantIdByVectorStoreId.get(vectorStoreId);
  if (cached) {
    return cached;
  }

  const createResponse = await fetch('https://api.openai.com/v1/assistants', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...openAIAssistantsBetaHeaders,
    },
    body: JSON.stringify({
      name: `Vector Store Chat (${vectorStoreId})`,
      model: 'gpt-4o-mini',
      instructions:
        'You are a helpful assistant. When a user asks questions, use file_search when relevant and cite facts from the available files. If the files do not contain the answer, say so.',
      tools: [{ type: 'file_search' }],
      tool_resources: {
        file_search: {
          vector_store_ids: [vectorStoreId],
        },
      },
    }),
  });

  if (!createResponse.ok) {
    const errorData = await createResponse.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(`Failed to create assistant: ${JSON.stringify(errorData)}`);
  }

  const data = (await createResponse.json()) as { id: string };
  assistantIdByVectorStoreId.set(vectorStoreId, data.id);
  return data.id;
}

function extractAssistantText(message: any): string {
  const content = message?.content;
  if (!Array.isArray(content)) {
    return '';
  }
  const parts: string[] = [];
  for (const item of content) {
    if (item?.type === 'text' && item?.text?.value) {
      parts.push(String(item.text.value));
    }
  }
  return parts.join('\n').trim();
}

async function extractAssistantCitations(apiKey: string, message: any): Promise<AssistantChatResponse['citations']> {
  const content = message?.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const citations: Array<{ fileId: string; quote?: string }> = [];

  for (const item of content) {
    if (item?.type !== 'text') {
      continue;
    }
    const annotations = item?.text?.annotations;
    if (!Array.isArray(annotations)) {
      continue;
    }

    for (const ann of annotations) {
      const type = ann?.type;
      if (type === 'file_citation' && typeof ann?.file_citation?.file_id === 'string') {
        const fileId = String(ann.file_citation.file_id);
        const quote = typeof ann?.file_citation?.quote === 'string' ? ann.file_citation.quote : undefined;
        citations.push({ fileId, quote });
        continue;
      }
      if (type === 'file_path' && typeof ann?.file_path?.file_id === 'string') {
        const fileId = String(ann.file_path.file_id);
        citations.push({ fileId });
      }
    }
  }

  const deduped: Array<{ fileId: string; quote?: string }> = [];
  const seen = new Set<string>();
  for (const c of citations) {
    const key = `${c.fileId}::${c.quote ?? ''}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(c);
  }

  const enriched = await Promise.all(
    deduped.map(async (c) => {
      const meta = await getFileMeta(apiKey, c.fileId);
      return {
        fileId: c.fileId,
        filename: meta.filename,
        bytes: meta.bytes,
        quote: c.quote,
      };
    }),
  );

  return enriched;
}

type VectorStoreFileMapping = {
  vectorStoreFileId: string;
  openaiFileId: string;
};

const vectorStoreFileIdCache = new Map<
  string,
  { createdAtMs: number; byOpenAIFileId: Map<string, string> }
>();

async function getVectorStoreFileIdByOpenAIFileId(
  apiKey: string,
  vectorStoreId: string,
  openaiFileIds: string[],
): Promise<Map<string, string>> {
  const cacheKey = vectorStoreId;
  const cached = vectorStoreFileIdCache.get(cacheKey);
  const ttlMs = 60_000;

  if (cached && Date.now() - cached.createdAtMs < ttlMs) {
    return cached.byOpenAIFileId;
  }

  const byOpenAIFileId = new Map<string, string>();
  let after: string | undefined = undefined;

  while (true) {
    const url = new URL(`https://api.openai.com/v1/vector_stores/${encodeURIComponent(vectorStoreId)}/files`);
    url.searchParams.set('limit', '100');
    if (after) {
      url.searchParams.set('after', after);
    }

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...openAIAssistantsBetaHeaders,
      },
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(`Failed to list vector store files for mapping: ${JSON.stringify(errorData)}`);
    }

    const data = (await response.json()) as {
      data?: Array<{ id?: string; file_id?: string }>;
      has_more?: boolean;
    };

    const items = Array.isArray(data?.data) ? data.data : [];
    for (const item of items) {
      const vectorStoreFileId = typeof item?.id === 'string' ? item.id : '';
      const openaiFileIdFromField = typeof item?.file_id === 'string' ? item.file_id : '';
      const openaiFileId =
        openaiFileIdFromField || (vectorStoreFileId.startsWith('file-') ? vectorStoreFileId : '');

      if (vectorStoreFileId && openaiFileId) {
        byOpenAIFileId.set(openaiFileId, vectorStoreFileId);

        // Some responses use the same identifier in multiple places; map the vector store file id too
        // so callers can pass either form.
        if (vectorStoreFileId.startsWith('file-')) {
          byOpenAIFileId.set(vectorStoreFileId, vectorStoreFileId);
        }
      }
    }

    if (!data?.has_more || items.length === 0) {
      break;
    }

    const lastId = typeof items[items.length - 1]?.id === 'string' ? items[items.length - 1]!.id : '';
    if (!lastId) {
      break;
    }
    after = lastId;
  }

  vectorStoreFileIdCache.set(cacheKey, { createdAtMs: Date.now(), byOpenAIFileId });
  return byOpenAIFileId;
}

async function extractAssistantCitationsForVectorStore(
  apiKey: string,
  vectorStoreId: string,
  message: any,
): Promise<AssistantChatResponse['citations']> {
  const citations = await extractAssistantCitations(apiKey, message);
  const fileIds = (citations ?? []).map((c) => c.fileId).filter((id) => typeof id === 'string' && id.length > 0);
  if (fileIds.length === 0) {
    return citations;
  }

  const map = await getVectorStoreFileIdByOpenAIFileId(apiKey, vectorStoreId, fileIds);
  return (citations ?? []).map((c) => ({
    ...c,
    vectorStoreId,
    vectorStoreFileId: map.get(c.fileId),
  }));
}

function bufferToArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

async function getFileMeta(apiKey: string, fileId: string): Promise<FileMeta> {
  const cached = fileMetaCache.get(fileId);
  if (cached) {
    return cached;
  }

  const response = await fetch(`https://api.openai.com/v1/files/${fileId}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
    console.warn('File meta fetch failed', { fileId, status: response.status, errorData });
    const fallback: FileMeta = {};
    fileMetaCache.set(fileId, fallback);
    return fallback;
  }

  const data = (await response.json()) as { filename?: string; bytes?: number };
  const meta: FileMeta = { filename: data.filename, bytes: data.bytes };
  fileMetaCache.set(fileId, meta);
  return meta;
}

const browserDistFolder = join(import.meta.dirname, '../browser');

const app = express();
const angularApp = new AngularNodeAppEngine();

app.use(express.json());

app.post('/api/chat', async (req, res) => {
  try {
    const apiKey = process.env['OPENAI_API_KEY'];
    
    if (!apiKey) {
      res.status(500).json({ error: 'OpenAI API key not configured' });
      return;
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(req.body)
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
      res.status(response.status).json(errorData);
      return;
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Chat API error:', error);
    res.status(500).json({ 
      error: error instanceof Error ? error.message : 'Internal server error' 
    });
  }
});

app.post('/api/assistants/chat', async (req, res) => {
  try {
    const apiKey = process.env['OPENAI_API_KEY'];

    if (!apiKey) {
      res.status(500).json({ error: 'OpenAI API key not configured' });
      return;
    }

    const body = req.body as AssistantChatRequest;
    const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
    const vectorStoreId = typeof body?.vectorStoreId === 'string' ? body.vectorStoreId.trim() : '';

    if (!prompt) {
      res.status(400).json({ error: 'Missing prompt' });
      return;
    }
    if (!vectorStoreId) {
      res.status(400).json({ error: 'Missing vectorStoreId' });
      return;
    }

    const assistantId = await getOrCreateAssistantForVectorStore(apiKey, vectorStoreId);

    let threadId = typeof body?.threadId === 'string' ? body.threadId : '';
    if (!threadId) {
      const threadResponse = await fetch('https://api.openai.com/v1/threads', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          ...openAIAssistantsBetaHeaders,
        },
        body: JSON.stringify({}),
      });

      if (!threadResponse.ok) {
        const errorData = await threadResponse.json().catch(() => ({ error: 'Unknown error' }));
        res.status(threadResponse.status).json(errorData);
        return;
      }

      const threadData = (await threadResponse.json()) as { id: string };
      threadId = threadData.id;
    }

    const addMessageResponse = await fetch(`https://api.openai.com/v1/threads/${threadId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...openAIAssistantsBetaHeaders,
      },
      body: JSON.stringify({
        role: 'user',
        content: prompt,
      }),
    });

    if (!addMessageResponse.ok) {
      const errorData = await addMessageResponse.json().catch(() => ({ error: 'Unknown error' }));
      res.status(addMessageResponse.status).json(errorData);
      return;
    }

    const runResponse = await fetch(`https://api.openai.com/v1/threads/${threadId}/runs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...openAIAssistantsBetaHeaders,
      },
      body: JSON.stringify({
        assistant_id: assistantId,
      }),
    });

    if (!runResponse.ok) {
      const errorData = await runResponse.json().catch(() => ({ error: 'Unknown error' }));
      res.status(runResponse.status).json(errorData);
      return;
    }

    const runData = (await runResponse.json()) as { id: string; status: string };
    const runId = runData.id;

    const maxWaitMs = 60_000;
    const start = Date.now();

    while (true) {
      const statusResponse = await fetch(`https://api.openai.com/v1/threads/${threadId}/runs/${runId}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...openAIAssistantsBetaHeaders,
        },
      });

      if (!statusResponse.ok) {
        const errorData = await statusResponse.json().catch(() => ({ error: 'Unknown error' }));
        res.status(statusResponse.status).json(errorData);
        return;
      }

      const statusData = (await statusResponse.json()) as { status: string; last_error?: any };
      const status = statusData.status;

      if (status === 'completed') {
        break;
      }

      if (status === 'failed' || status === 'cancelled' || status === 'expired') {
        res.status(500).json({ error: statusData.last_error?.message || `Run ${status}` });
        return;
      }

      if (Date.now() - start > maxWaitMs) {
        res.status(504).json({ error: 'Timed out waiting for assistant response' });
        return;
      }

      await sleepMs(800);
    }

    const messagesResponse = await fetch(`https://api.openai.com/v1/threads/${threadId}/messages?order=desc&limit=20`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...openAIAssistantsBetaHeaders,
      },
    });

    if (!messagesResponse.ok) {
      const errorData = await messagesResponse.json().catch(() => ({ error: 'Unknown error' }));
      res.status(messagesResponse.status).json(errorData);
      return;
    }

    const messagesData = (await messagesResponse.json()) as { data: any[] };
    const assistantMessage = Array.isArray(messagesData?.data)
      ? messagesData.data.find((m) => m?.role === 'assistant')
      : null;

    const reply = extractAssistantText(assistantMessage);
    if (!reply) {
      res.status(500).json({ error: 'No assistant reply found' });
      return;
    }

    const citations = await extractAssistantCitationsForVectorStore(apiKey, vectorStoreId, assistantMessage);
    const responseBody: AssistantChatResponse = { reply, threadId, citations };
    res.json(responseBody);
  } catch (error) {
    console.error('Assistants chat error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
});

app.get('/api/vector-stores/:id/files/:fileId/content', async (req, res) => {
  try {
    const apiKey = process.env['OPENAI_API_KEY'];
    const s3Config = getVectorStoreS3ConfigFromEnv();

    if (!s3Config) {
      res.status(500).json({ error: 'S3 mirroring is not configured' });
      return;
    }
    const config = s3Config;

    const vectorStoreId = typeof req.params['id'] === 'string' ? req.params['id'].trim() : '';
    const fileIdOrVectorStoreFileId = typeof req.params['fileId'] === 'string' ? req.params['fileId'].trim() : '';
    if (!vectorStoreId || !fileIdOrVectorStoreFileId) {
      res.status(400).json({ error: 'Missing vectorStoreId or vectorStoreFileId' });
      return;
    }

    const download = (req.query['download'] ?? '') === '1';

    let vectorStoreFileId = fileIdOrVectorStoreFileId;
    if (fileIdOrVectorStoreFileId.startsWith('file-')) {
      if (!apiKey) {
        res.status(500).json({ error: 'OpenAI API key not configured' });
        return;
      }
      const map = await getVectorStoreFileIdByOpenAIFileId(apiKey, vectorStoreId, [fileIdOrVectorStoreFileId]);
      const resolved = map.get(fileIdOrVectorStoreFileId) ?? '';
      if (resolved) {
        vectorStoreFileId = resolved;
      }
    }

    const primaryPrefix = buildVectorStoreFilePrefix(config, vectorStoreId, vectorStoreFileId);
    const fallbackPrefix =
      vectorStoreFileId === fileIdOrVectorStoreFileId
        ? null
        : buildVectorStoreFilePrefix(config, vectorStoreId, fileIdOrVectorStoreFileId);
    const s3 = getVectorStoreS3Client(config);

    async function findFirstObjectKey(prefix: string): Promise<string> {
      const list = await s3.send(
        new ListObjectsV2Command({
          Bucket: config.bucketName,
          Prefix: prefix,
          MaxKeys: 10,
        }),
      );

      return (
        (list.Contents ?? [])
          .map((c: { Key?: string }) => c.Key)
          .filter((k: string | undefined): k is string => typeof k === 'string' && k.length > 0)
          .find((k) => !k.endsWith('/')) ?? ''
      );
    }

    let objectKey = await findFirstObjectKey(primaryPrefix);
    if (!objectKey && fallbackPrefix) {
      objectKey = await findFirstObjectKey(fallbackPrefix);
    }

    if (!objectKey) {
      res.status(404).json({ error: 'Source not found in S3 mirror for this vector store file' });
      return;
    }

    const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range : undefined;
    const upstream = await s3.send(
      new GetObjectCommand({
        Bucket: config.bucketName,
        Key: objectKey,
        Range: rangeHeader,
      }),
    );

    if (upstream.ContentType) {
      res.setHeader('Content-Type', upstream.ContentType);
    } else {
      res.setHeader('Content-Type', 'application/octet-stream');
    }

    if (upstream.ContentLength !== undefined) {
      res.setHeader('Content-Length', String(upstream.ContentLength));
    }
    if (upstream.AcceptRanges) {
      res.setHeader('Accept-Ranges', upstream.AcceptRanges);
    }
    if (upstream.ContentRange) {
      res.status(206);
      res.setHeader('Content-Range', upstream.ContentRange);
    }

    const filenameFromKey = objectKey.split('/').pop() || 'source';
    res.setHeader(
      'Content-Disposition',
      `${download ? 'attachment' : 'inline'}; filename="${sanitizeS3KeyComponent(filenameFromKey) || 'source'}"`,
    );

    const body = upstream.Body as any;
    if (!body) {
      res.status(500).json({ error: 'S3 content missing' });
      return;
    }

    // In AWS SDK v3 on Node, Body is usually a Node stream.
    body.pipe(res);
  } catch (error) {
    console.error('Vector store file content proxy error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
});

app.get('/api/openai/files/:fileId/content', async (req, res) => {
  res.status(400).json({
    error:
      'Direct OpenAI file download is not supported for assistants files. Use /api/vector-stores/:id/files/:fileId/content with vector_store_file_id instead.',
  });
});


app.get('/api/vector-stores', async (req, res) => {
  try {
    const apiKey = process.env['OPENAI_API_KEY'];
    
    if (!apiKey) {
      res.status(500).json({ error: 'OpenAI API key not configured' });
      return;
    }

    const response = await fetch('https://api.openai.com/v1/vector_stores', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...openAIAssistantsBetaHeaders,
      }
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
      res.status(response.status).json(errorData);
      return;
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Vector stores list error:', error);
    res.status(500).json({ 
      error: error instanceof Error ? error.message : 'Internal server error' 
    });
  }
});

app.post('/api/vector-stores', async (req, res) => {
  try {
    const apiKey = process.env['OPENAI_API_KEY'];
    
    if (!apiKey) {
      res.status(500).json({ error: 'OpenAI API key not configured' });
      return;
    }

    const response = await fetch('https://api.openai.com/v1/vector_stores', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...openAIAssistantsBetaHeaders,
      },
      body: JSON.stringify({
        name: req.body.name,
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
      res.status(response.status).json(errorData);
      return;
    }

    const data = await response.json();
    const s3Config = getVectorStoreS3ConfigFromEnv();
    if (s3Config && typeof data?.id === 'string') {
      await ensureVectorStoreFolderExists(s3Config, data.id);
      await putVectorStoreMetadata(s3Config, data.id, {
        id: data.id,
        name: typeof data?.name === 'string' ? data.name : undefined,
        updatedAt: new Date().toISOString(),
      });
    }
    res.json(data);
  } catch (error) {
    console.error('Vector store create error:', error);
    res.status(500).json({ 
      error: error instanceof Error ? error.message : 'Internal server error' 
    });
  }
});

app.patch('/api/vector-stores/:id', async (req, res) => {
  try {
    const apiKey = process.env['OPENAI_API_KEY'];

    if (!apiKey) {
      res.status(500).json({ error: 'OpenAI API key not configured' });
      return;
    }

    const newName = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!newName) {
      res.status(400).json({ error: 'Missing vector store name' });
      return;
    }

    const response = await fetch(`https://api.openai.com/v1/vector_stores/${req.params['id']}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...openAIAssistantsBetaHeaders,
      },
      body: JSON.stringify({ name: newName }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
      res.status(response.status).json(errorData);
      return;
    }

    const data = await response.json();
    const s3Config = getVectorStoreS3ConfigFromEnv();
    if (s3Config) {
      await ensureVectorStoreFolderExists(s3Config, req.params['id']);
      await putVectorStoreMetadata(s3Config, req.params['id'], {
        id: req.params['id'],
        name: typeof data?.name === 'string' ? data.name : newName,
        updatedAt: new Date().toISOString(),
      });
    }
    res.json(data);
  } catch (error) {
    console.error('Vector store rename error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
});

app.delete('/api/vector-stores/:id', async (req, res) => {
  try {
    const apiKey = process.env['OPENAI_API_KEY'];
    
    if (!apiKey) {
      res.status(500).json({ error: 'OpenAI API key not configured' });
      return;
    }

    const response = await fetch(`https://api.openai.com/v1/vector_stores/${req.params['id']}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...openAIAssistantsBetaHeaders,
      }
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
      res.status(response.status).json(errorData);
      return;
    }

    const data = await response.json();
    const s3Config = getVectorStoreS3ConfigFromEnv();
    if (s3Config) {
      const storePrefix = buildVectorStoreRootPrefix(s3Config, req.params['id']);
      await deleteAllObjectsUnderPrefix(s3Config, storePrefix);
    }
    res.json(data);
  } catch (error) {
    console.error('Vector store delete error:', error);
    res.status(500).json({ 
      error: error instanceof Error ? error.message : 'Internal server error' 
    });
  }
});

app.get('/api/vector-stores/:id/files', async (req, res) => {
  try {
    const apiKey = process.env['OPENAI_API_KEY'];
    
    if (!apiKey) {
      res.status(500).json({ error: 'OpenAI API key not configured' });
      return;
    }

    const response = await fetch(`https://api.openai.com/v1/vector_stores/${req.params['id']}/files`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...openAIAssistantsBetaHeaders,
      }
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
      res.status(response.status).json(errorData);
      return;
    }

    const data = await response.json();
    const items: Array<Record<string, unknown>> = Array.isArray(data?.data) ? data.data : [];

    const enriched = await Promise.all(
      items.map(async (item) => {
        const maybeFileIdFromFileIdField = item['file_id'] as string | undefined;
        const maybeIdField = item['id'] as string | undefined;
        const fileId =
          maybeFileIdFromFileIdField ??
          (typeof maybeIdField === 'string' && maybeIdField.startsWith('file-') ? maybeIdField : '');

        if (!fileId) {
          return item;
        }
        const meta = await getFileMeta(apiKey, fileId);
        return {
          ...item,
          filename: meta.filename,
          bytes: meta.bytes,
        };
      }),
    );

    res.json({ ...data, data: enriched });
  } catch (error) {
    console.error('Vector store files list error:', error);
    res.status(500).json({ 
      error: error instanceof Error ? error.message : 'Internal server error' 
    });
  }
});

app.post('/api/vector-stores/:id/files', upload.array('files'), async (req, res) => {
  try {
    const apiKey = process.env['OPENAI_API_KEY'];
    
    if (!apiKey) {
      res.status(500).json({ error: 'OpenAI API key not configured' });
      return;
    }

    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) {
      res.status(400).json({ error: 'No files provided' });
      return;
    }

    const results: Array<Record<string, unknown>> = [];
    const s3Config = getVectorStoreS3ConfigFromEnv();
    if (s3Config) {
      await ensureVectorStoreFolderExists(s3Config, req.params['id']);
    }

    for (const file of files) {
      const formData = new FormData();
      const fileArrayBuffer = bufferToArrayBuffer(file.buffer);
      const fileBlob = new Blob([fileArrayBuffer], { type: file.mimetype });
      formData.append('file', fileBlob, file.originalname);
      formData.append('purpose', 'assistants');

      const uploadResponse = await fetch('https://api.openai.com/v1/files', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: formData,
      });

      if (!uploadResponse.ok) {
        const errorData = await uploadResponse.json().catch(() => ({ error: 'Unknown error' }));
        res.status(uploadResponse.status).json(errorData);
        return;
      }

      const fileData = await uploadResponse.json();
      const uploadedFileId = fileData['id'] as string;
      fileMetaCache.set(uploadedFileId, { filename: file.originalname, bytes: file.size });

      const attachResponse = await fetch(`https://api.openai.com/v1/vector_stores/${req.params['id']}/files`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          ...openAIAssistantsBetaHeaders,
        },
        body: JSON.stringify({
          file_id: uploadedFileId,
        }),
      });

      if (!attachResponse.ok) {
        const errorData = await attachResponse.json().catch(() => ({ error: 'Unknown error' }));
        res.status(attachResponse.status).json(errorData);
        return;
      }

      const attachData = await attachResponse.json();

      if (s3Config && typeof attachData?.id === 'string') {
        const vectorStoreFileId = attachData.id as string;
        const filename = sanitizeS3KeyComponent(file.originalname) || 'file';
        const objectKey = `${buildVectorStoreFilePrefix(s3Config, req.params['id'], vectorStoreFileId)}${filename}`;

        const s3 = getVectorStoreS3Client(s3Config);
        await s3.send(
          new PutObjectCommand({
            Bucket: s3Config.bucketName,
            Key: objectKey,
            Body: file.buffer,
            ContentType: file.mimetype || 'application/octet-stream',
            Metadata: {
              vector_store_id: req.params['id'],
              vector_store_file_id: vectorStoreFileId,
              openai_file_id: typeof attachData?.file_id === 'string' ? attachData.file_id : uploadedFileId,
              original_filename: file.originalname,
            },
          }),
        );
      }

      results.push({
        ...attachData,
        filename: file.originalname,
        bytes: file.size,
      });
    }

    res.json({ data: results });
  } catch (error) {
    console.error('Vector store file upload error:', error);
    res.status(500).json({ 
      error: error instanceof Error ? error.message : 'Internal server error' 
    });
  }
});

app.delete('/api/vector-stores/:id/files/:fileId', async (req, res) => {
  try {
    const apiKey = process.env['OPENAI_API_KEY'];
    
    if (!apiKey) {
      res.status(500).json({ error: 'OpenAI API key not configured' });
      return;
    }

    const response = await fetch(`https://api.openai.com/v1/vector_stores/${req.params['id']}/files/${req.params['fileId']}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...openAIAssistantsBetaHeaders,
      }
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
      res.status(response.status).json(errorData);
      return;
    }

    const data = await response.json();
    const s3Config = getVectorStoreS3ConfigFromEnv();
    if (s3Config) {
      const filePrefix = buildVectorStoreFilePrefix(s3Config, req.params['id'], req.params['fileId']);
      await deleteAllObjectsUnderPrefix(s3Config, filePrefix);
    }
    res.json(data);
  } catch (error) {
    console.error('Vector store file delete error:', error);
    res.status(500).json({ 
      error: error instanceof Error ? error.message : 'Internal server error' 
    });
  }
});

/**
 * Serve static files from /browser
 */
app.use(
  express.static(browserDistFolder, {
    maxAge: '1y',
    index: false,
    redirect: false,
  }),
);

/**
 * Handle all other requests by rendering the Angular application.
 */
app.use((req, res, next) => {
  angularApp
    .handle(req)
    .then((response) =>
      response ? writeResponseToNodeResponse(response, res) : next(),
    )
    .catch(next);
});

/**
 * Start the server if this module is the main entry point, or it is ran via PM2.
 * The server listens on the port defined by the `PORT` environment variable, or defaults to 4000.
 */
if (isMainModule(import.meta.url) || process.env['pm_id']) {
  const port = process.env['PORT'] || 4000;
  app.listen(port, (error) => {
    if (error) {
      throw error;
    }

    console.log(`Node Express server listening on http://localhost:${port}`);
  });
}

/**
 * Request handler used by the Angular CLI (for dev-server and during build) or Firebase Cloud Functions.
 */
export const reqHandler = createNodeRequestHandler(app);
