// Raw record + rich-decode types for the Devin provider.
//
// The record types describe the shape of Devin transcript JSON plus the
// sessions.db row the host enriches it with. The Decoded* types are the rich
// decode layer's output: pure over supplied records, carrying content in-memory
// but NO pricing (the host prices them). The CLI adapter maps DevinDecodedCall
// into its own ParsedProviderCall by adding `costBasis: 'measured'` and the
// ACU->USD conversion.

export type AgentTrajectory<StepType extends Step = Step, AgentExtra = unknown> = {
  schema_version: string;
  session_id?: string;
  agent: Agent<AgentExtra>;
  steps: StepType[];
  final_metrics?: FinalMetrics;
};

export type FinalMetrics = {
  total_prompt_tokens?: number;
  total_completion_tokens?: number;
  total_cached_tokens?: number;
  total_steps?: number;
};

export type DevinAgentExtra = {
  backend?: string;
  permission_mode?: string;
};

export type Agent<Extra = unknown> = {
  name: string;
  version: string;
  model_name?: string;
  tool_definitions?: unknown;
  extra?: Extra;
};

export type ToolCall = {
  tool_call_id: string;
  function_name: string;
  arguments: unknown;
};

export type DevinMetadata = {
  created_at?: string;
  committed_acu_cost?: number;
  generation_model?: string;
  is_user_input?: boolean;
  num_tokens?: number;
  request_id?: string;
  finish_reason?: string;
  metrics?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_tokens?: number;
    cache_read_tokens?: number;
    tokens_per_sec?: number;
    total_time_ms?: number;
    ttft_ms?: number;
    tpot_ms?: number;
  };
};

export type ContentPart = ContentPartText | ContentPartImage;

export type ContentPartText = {
  type: "text";
  text: string;
};

export type ContentPartImage = {
  type: "image";
  source: ImageSource;
};

export type ImageSource = {
  media_type: string;
  path: string;
};

export type Step<StepExtra = unknown, MetricsExtra = unknown> = {
  step_id: number;
  timestamp?: string;
  source?: string;
  model_name?: string;
  message: string | Array<ContentPart>;
  tool_calls?: Array<ToolCall>;
  extra?: StepExtra;
  observation?: Observation;
  metrics?: Metrics<MetricsExtra>;
};

export type DevinTelemetry = {
  source?: string;
  operation?: string;
};

export type DevinStepExtra = {
  committed_acu_cost?: number;
  generation_model?: string;
  telemetry?: DevinTelemetry;
};

export type Observation = {
  results: Array<ObservationResult>;
};

export type ObservationResult = {
  source_call_id?: string;
  content?: string | Array<ContentPart>;
};

export type Metrics<Extra = unknown> = {
  prompt_tokens?: number;
  completion_tokens?: number;
  cached_tokens?: number;
  extra?: Extra;
};

export type DevinMetricsExtra = {
  cache_creation_input_tokens?: number;
};

export type DevinStep = Step<DevinStepExtra, DevinMetricsExtra> & {
  metadata?: DevinMetadata;
};

export type DevinAgentTrajectory = AgentTrajectory<DevinStep, DevinAgentExtra>;

export type DevinSessionMetadata = {
  id: string;
  workingDirectory: string;
  model: string;
  title?: string;
  createdAt: string;
  lastActivityAt: string;
  hidden: boolean;
};

export type DevinUsage = {
  committedAcuCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
};

/** One host-supplied record: parsed transcript + sessions.db enrichment. */
export type DevinDecodeRecord = {
  transcript: DevinAgentTrajectory;
  session: DevinSessionMetadata | null;
  project: string;
  /** Stable session id the host derived from the transcript (or its filename). */
  sessionId: string;
};

/**
 * Rich decode of one Devin assistant step, pre-pricing. Mirrors the host's
 * ParsedProviderCall minus cost fields (the host adds those). Devin tool calls
 * do not carry bash commands or file paths that need CLI-side extraction, so
 * `rawBashCommands` is always empty.
 */
export type DevinDecodedCall = {
  provider: 'devin';
  /** Raw model id winning the step/agent/session chain; host formats it. */
  modelName: string;
  /** Raw generation-model id, when the step reported one. */
  generationModel?: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  webSearchRequests: number;
  tools: string[];
  rawBashCommands: string[];
  timestamp: string;
  speed: 'standard';
  deduplicationKey: string;
  userMessage: string;
  sessionId: string;
  project: string;
  projectPath?: string;
  /** Provider-reported ACU cost; the host converts it to USD. */
  committedAcuCost: number;
};
