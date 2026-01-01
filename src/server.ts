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
    res.json(data);
  } catch (error) {
    console.error('Vector store files list error:', error);
    res.status(500).json({ 
      error: error instanceof Error ? error.message : 'Internal server error' 
    });
  }
});

app.post('/api/vector-stores/:id/files', upload.single('file'), async (req, res) => {
  try {
    const apiKey = process.env['OPENAI_API_KEY'];
    
    if (!apiKey) {
      res.status(500).json({ error: 'OpenAI API key not configured' });
      return;
    }

    if (!req.file) {
      res.status(400).json({ error: 'No file provided' });
      return;
    }

    const formData = new FormData();
    const fileBlob = new Blob([req.file.buffer as BlobPart], { type: req.file.mimetype });
    formData.append('file', fileBlob, req.file.originalname);
    formData.append('purpose', 'assistants');

    const uploadResponse = await fetch('https://api.openai.com/v1/files', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`
      },
      body: formData
    });

    if (!uploadResponse.ok) {
      const errorData = await uploadResponse.json().catch(() => ({ error: 'Unknown error' }));
      res.status(uploadResponse.status).json(errorData);
      return;
    }

    const fileData = await uploadResponse.json();

    const attachResponse = await fetch(`https://api.openai.com/v1/vector_stores/${req.params['id']}/files`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...openAIAssistantsBetaHeaders,
      },
      body: JSON.stringify({
        file_id: fileData['id']
      })
    });

    if (!attachResponse.ok) {
      const errorData = await attachResponse.json().catch(() => ({ error: 'Unknown error' }));
      res.status(attachResponse.status).json(errorData);
      return;
    }

    const attachData = await attachResponse.json();
    res.json(attachData);
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
