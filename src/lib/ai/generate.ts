import {
  AiError,
  type AiConfig,
  type AiUsage,
  type ChatMessage,
  type GenerateResult,
  type ToolDefinition,
} from './types';
import { HANDOFF_SENTINEL, aiRequestTimeoutMs } from './defaults';
import { extractLeakedToolCalls } from './tool-call-text';
import { generateOpenAi } from './providers/openai';
import { generateAnthropic } from './providers/anthropic';
import { generateOpenRouter } from './providers/openrouter';

export interface GenerateArgs {
  config: AiConfig;
  systemPrompt: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
}

/**
 * Generate the next reply from the account's configured provider.
 * Dispatches to the right adapter, then parses the handoff sentinel out
 * of the raw text. Throws `AiError` on any provider/network failure.
 */
export async function generateReply(
  args: GenerateArgs
): Promise<GenerateResult> {
  const { config, systemPrompt, messages, tools } = args;
  const timeoutMs = aiRequestTimeoutMs();
  const providerArgs = {
    apiKey: config.apiKey,
    model: config.model,
    systemPrompt,
    messages,
    timeoutMs,
    tools,
  };

  let result: {
    text: string;
    usage: AiUsage | null;
    toolCalls?: {
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    }[];
  };
  switch (config.provider) {
    case 'openai':
      result = await generateOpenAi(providerArgs);
      break;
    case 'anthropic':
      result = await generateAnthropic(providerArgs);
      break;
    case 'openrouter':
      result = await generateOpenRouter(providerArgs);
      break;
    default:
      throw new AiError(`Unsupported AI provider: ${config.provider}`, {
        code: 'unsupported_provider',
        status: 400,
      });
  }

  const parsed = parseGeneration(result.text, result.usage);

  // Provider tool-call safety net. A model that printed the invocation
  // as text (Gemini "step_0: print(default_api.…)") would otherwise have
  // that scaffolding delivered verbatim to the customer. Strip it always
  // (even for draft/playground turns that pass no tools); when the
  // provider returned no structured tool_calls, recover the leaked ones
  // so the tool still executes instead of being dropped.
  const knownNames = tools?.map((t) => t.name) ?? [];
  const { text, toolCalls: leaked } = extractLeakedToolCalls(
    parsed.text,
    knownNames
  );
  parsed.text = text;
  if (knownNames.length > 0) {
    const structured = result.toolCalls ?? [];
    parsed.toolCalls = structured.length > 0 ? structured : leaked;
  } else {
    parsed.toolCalls = result.toolCalls;
  }

  return parsed;
}

/**
 * Strip a leading `model` role token from raw model output.
 *
 * When a Google Gemini model is served through OpenRouter's OpenAI-
 * shaped endpoint, some revisions echo the candidate role as the first
 * part of `message.content`, so the reply arrives as `model\n…text…`.
 * The label is a provider artifact, never part of the answer — drop it
 * before the text goes anywhere (WhatsApp, drafts, handoff summaries).
 *
 * Only a standalone leading `model` token followed by whitespace or the
 * end of input is removed, so a reply that genuinely begins with the
 * English word "model" (e.g. the customer's car) is left intact. Any
 * other leading whitespace is trimmed as part of the cleanup.
 */
export function stripModelPrefix(text: string): string {
  let out = text.trim();
  while (/^model(?:$|\s)/i.test(out)) {
    out = out.replace(/^model(?:$|\s)/i, '').trim();
  }
  return out;
}

/**
 * Blocks that carry ONLY the model's internal reasoning (Chain of Thought)
 * and must NEVER reach the customer: XML-style thinking tags, markdown
 * code fences labeled thinking/cot/reasoning, bracket pairs, and stray
 * opening/closing tags that some providers leak into the content stream.
 * Each rule is a regex whose match is removed entirely.
 */
const INTERNAL_REASONING_RES: RegExp[] = [
  /<thinking>[\s\S]*?<\/thinking>/gi,
  /<chain_of_thought>[\s\S]*?<\/chain_of_thought>/gi,
  /<cot>[\s\S]*?<\/cot>/gi,
  /<reasoning>[\s\S]*?<\/reasoning>/gi,
  /<antml:thinking>[\s\S]*?<\/antml:thinking>/gi,
  /\[THOUGHT\][\s\S]*?\[\/THOUGHT\]/gi,
  /\[PENSAMIENTO\][\s\S]*?\[\/PENSAMIENTO\]/gi,
  /```(?:thinking|thought|chain[-_]of[-_]thought|cot|reasoning)\s*[\s\S]*?```/gi,
  // Unmatched opening/closing tags the model may leave behind.
  /<\/?(?:thinking|chain_of_thought|cot|reasoning|antml:thinking)>/gi,
];

/** One-line labels some models print before their inner monologue. */
const INTERNAL_REASONING_LABEL_RE =
  /(?:^|\n)\s*(?:Thought|Pensamiento|Razonamiento|Reflexi[oó]n|Internamente)[:,]\s*[^\n]*/gi;

/**
 * Remove any Chain-of-Thought / thinking scaffolding from model output.
 *
 * Whatever the provider (OpenAI/Anthropic/OpenRouter — including models
 * served through OpenRouter that echo their `thinking` content as text),
 * the internal reasoning is never part of the answer. This is applied to
 * every generated text (parseGeneration) AND right before the WhatsApp
 * send call, so a leaked thought block can never reach the customer.
 * Idempotent and safe on plain customer-facing text.
 */
export function stripInternalReasoning(text: string): string {
  let out = text;
  for (const re of INTERNAL_REASONING_RES) out = out.replace(re, '');
  out = out.replace(INTERNAL_REASONING_LABEL_RE, '');
  return out.trim();
}

/**
 * Split the raw model output into `{ text, handoff, usage }`. The
 * sentinel can appear alone or trailing a partial reply; either way we
 * treat the turn as a handoff and strip the marker from any remaining
 * text. `usage` is passed straight through (null when the provider
 * didn't report it).
 *
 * The raw text also passes through `stripModelPrefix` and
 * `stripInternalReasoning` so no Gemini `model` role echo and no leaked
 * Chain-of-Thought block ever reaches the customer.
 */
export function parseGeneration(
  raw: string,
  usage: AiUsage | null = null
): GenerateResult {
  const handoff = raw.includes(HANDOFF_SENTINEL);
  const text = stripInternalReasoning(
    stripModelPrefix(raw.split(HANDOFF_SENTINEL).join(''))
  );
  return { text, handoff, usage };
}
