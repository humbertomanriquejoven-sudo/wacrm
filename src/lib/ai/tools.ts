import type { SupabaseClient } from '@supabase/supabase-js'
import type { ToolDefinition, ToolCall } from './types'

// ============================================================
// Tool definitions and handlers for the AI auto-reply agent.
// ============================================================

/**
 * Tool that lets the AI update client profile data extracted from
 * the conversation. Invoked automatically when the model detects
 * the customer sharing personal or project information.
 */
export const UPDATE_CLIENT_PROFILE_TOOL: ToolDefinition = {
  name: 'update_client_profile',
  description:
    'Save or update the client profile when the customer shares personal information during the conversation. ' +
    'Invoke this whenever the customer mentions their name, email, location (city/neighborhood), type of project, or budget. ' +
    'You may call this tool multiple times as new information becomes available.',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Full name of the customer (e.g. "Carlos Pérez")',
      },
      email: {
        type: 'string',
        description: 'Email address of the customer',
      },
      location: {
        type: 'string',
        description:
          'City, neighborhood, or address of the customer (e.g. "Bogotá", "Chía", "Cajicá")',
      },
      project_type: {
        type: 'string',
        description:
          'Type of project or service the customer is interested in (e.g. "remodelación", "diseño interior", "renders 3D")',
      },
      budget: {
        type: 'string',
        description:
          'Budget or price range mentioned by the customer (e.g. "15 millones", "5-8 millones COP")',
      },
    },
  },
}

/** All tools available to the AI agent. */
export const AI_TOOLS: ToolDefinition[] = [UPDATE_CLIENT_PROFILE_TOOL]

/**
 * Execute a tool call from the AI model. Returns a human-readable
 * result string to feed back to the model.
 */
export async function executeToolCall(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  toolCall: ToolCall,
): Promise<string> {
  if (toolCall.name === 'update_client_profile') {
    return handleUpdateClientProfile(db, accountId, contactId, toolCall.arguments)
  }
  return `Unknown tool: ${toolCall.name}`
}

async function handleUpdateClientProfile(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  args: Record<string, unknown>,
): Promise<string> {
  const updates: Record<string, string> = {}

  if (typeof args.name === 'string' && args.name.trim()) {
    updates.name = args.name.trim()
  }
  if (typeof args.email === 'string' && args.email.trim()) {
    updates.email = args.email.trim()
  }
  if (typeof args.location === 'string' && args.location.trim()) {
    updates.company = args.location.trim()
  }
  if (typeof args.project_type === 'string' && args.project_type.trim()) {
    updates.avatar_url = args.project_type.trim()
  }

  if (Object.keys(updates).length === 0) {
    return 'No profile data to update.'
  }

  updates.updated_at = new Date().toISOString()

  const { error } = await db
    .from('contacts')
    .update(updates)
    .eq('id', contactId)
    .eq('account_id', accountId)

  if (error) {
    console.error('[ai tools] update_client_profile failed:', error)
    return `Failed to update profile: ${error.message}`
  }

  const fields = Object.keys(updates)
    .filter((k) => k !== 'updated_at')
    .join(', ')
  return `Profile updated: ${fields}`
}

/**
 * Load the contact record for context injection into the system prompt.
 */
export async function loadContactContext(
  db: SupabaseClient,
  contactId: string,
): Promise<{ name: string | null; email: string | null; location: string | null } | null> {
  const { data, error } = await db
    .from('contacts')
    .select('name, email, company')
    .eq('id', contactId)
    .maybeSingle()

  if (error || !data) return null

  return {
    name: data.name ?? null,
    email: data.email ?? null,
    location: data.company ?? null,
  }
}
