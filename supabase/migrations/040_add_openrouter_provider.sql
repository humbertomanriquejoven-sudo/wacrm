-- Add OpenRouter as a supported AI provider.
-- Drops and recreates the CHECK constraints on ai_configs and ai_usage_log
-- to include 'openrouter' alongside 'openai' and 'anthropic'.

-- ai_configs.provider
ALTER TABLE ai_configs
  DROP CONSTRAINT IF EXISTS ai_configs_provider_check;

ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'openrouter'));

-- ai_usage_log.provider
ALTER TABLE ai_usage_log
  DROP CONSTRAINT IF EXISTS ai_usage_log_provider_check;

ALTER TABLE ai_usage_log
  ADD CONSTRAINT ai_usage_log_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'openrouter'));
