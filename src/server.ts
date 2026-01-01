import {
  AngularNodeAppEngine,
  createNodeRequestHandler,
  isMainModule,
  writeResponseToNodeResponse,
} from '@angular/ssr/node';
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
};

const assistantIdByVectorStoreId = new Map<string, string>();

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

    const responseBody: AssistantChatResponse = { reply, threadId };
    res.json(responseBody);
  } catch (error) {
    console.error('Assistants chat error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
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
