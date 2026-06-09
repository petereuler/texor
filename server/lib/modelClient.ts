import { ModelConfig } from '../types.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ModelTextResponse {
  mode: 'mock' | 'openai-compatible';
  content: string;
}

function resolveModelConfig(
  config?: ModelConfig,
): (Required<Omit<ModelConfig, 'reasoningEffort'>> & { reasoningEffort?: string }) | null {
  const apiKey = config?.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return null;
  }

  return {
    apiKey,
    baseUrl: config?.baseUrl || process.env.OPENAI_API_BASE || 'https://api.openai.com/v1',
    model: config?.model || process.env.OPENAI_MODEL || 'gpt-4.1-mini',
    provider: config?.provider || process.env.OPENAI_PROVIDER || 'OpenAI-compatible',
    imageModel: config?.imageModel || process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1',
    reasoningEffort: config?.reasoningEffort,
  };
}

export async function callOpenAICompatible(
  messages: ChatMessage[],
  config?: ModelConfig,
  temperature = 0.3,
): Promise<ModelTextResponse | null> {
  const resolved = resolveModelConfig(config);
  if (!resolved) {
    return null;
  }

  const endpoint = `${resolved.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${resolved.apiKey}`,
    },
    body: JSON.stringify({
      model: resolved.model,
      temperature,
      messages,
    }),
  });

  if (!response.ok) {
    const raw = await response.text();
    throw new Error(`Model API request failed: ${response.status} ${raw}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error('Model API returned an empty response.');
  }

  return {
    mode: 'openai-compatible',
    content,
  };
}
