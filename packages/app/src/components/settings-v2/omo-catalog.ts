// Static snapshot of Oh My OpenAgent's fallback chains.
// Copied at implementation from `AGENT_MODEL_REQUIREMENTS` and
// `CATEGORY_MODEL_REQUIREMENTS` in the installed `oh-my-openagent` package
// (`node_modules/oh-my-openagent/dist/index.js`). We do not import that
// package and do not parse it at runtime.

export type FallbackEntry = { providers: string[]; model: string; variant?: string }
export type FallbackChain = FallbackEntry[]

export const OMO_AGENTS = [
  "sisyphus",
  "hephaestus",
  "oracle",
  "librarian",
  "explore",
  "multimodal-looker",
  "prometheus",
  "metis",
  "momus",
  "atlas",
  "sisyphus-junior",
] as const

export const OMO_CATEGORIES = [
  "visual-engineering",
  "ultrabrain",
  "deep",
  "artistry",
  "quick",
  "unspecified-low",
  "unspecified-high",
  "writing",
] as const

const AGENT_FALLBACKS: Record<string, FallbackChain> = {
  sisyphus: [
    { providers: ["anthropic", "github-copilot", "opencode", "vercel"], model: "claude-opus-5", variant: "max" },
    {
      providers: [
        "opencode-go",
        "kimi-for-coding",
        "moonshotai",
        "opencode",
        "vercel",
        "bailian-coding-plan",
        "moonshotai-cn",
        "firmware",
        "ollama-cloud",
        "aihubmix",
      ],
      model: "kimi-k3",
    },
    { providers: ["openai", "github-copilot", "opencode", "vercel"], model: "gpt-5.6-sol", variant: "medium" },
    { providers: ["zai-coding-plan", "opencode", "bailian-coding-plan", "vercel"], model: "glm-5.2" },
    { providers: ["opencode"], model: "big-pickle" },
  ],
  hephaestus: [
    { providers: ["openai", "github-copilot", "vercel", "opencode"], model: "gpt-5.6-sol", variant: "medium" },
  ],
  oracle: [
    { providers: ["openai", "opencode", "vercel"], model: "gpt-5.6-sol", variant: "xhigh" },
    { providers: ["github-copilot"], model: "gpt-5.6-sol", variant: "high" },
    { providers: ["google", "github-copilot", "opencode", "vercel"], model: "gemini-3.1-pro", variant: "high" },
    { providers: ["anthropic", "github-copilot", "opencode", "vercel"], model: "claude-opus-5", variant: "max" },
    { providers: ["opencode-go", "vercel"], model: "glm-5.2" },
  ],
  librarian: [
    { providers: ["openai"], model: "gpt-5.6-luna-fast", variant: "low" },
    { providers: ["deepseek"], model: "deepseek-v4-flash", variant: "max" },
    { providers: ["opencode-go", "bailian-coding-plan"], model: "qwen3.7-plus" },
    { providers: ["vercel"], model: "minimax-m2.7-highspeed" },
    { providers: ["opencode-go", "vercel"], model: "minimax-m3" },
    { providers: ["minimax-coding-plan", "minimax-cn-coding-plan"], model: "MiniMax-M3" },
    { providers: ["opencode-go", "vercel"], model: "minimax-m2.7" },
    { providers: ["anthropic", "github-copilot", "vercel"], model: "claude-haiku-4-5" },
    { providers: ["openai", "vercel"], model: "gpt-5.4-nano" },
  ],
  explore: [
    { providers: ["openai"], model: "gpt-5.6-luna-fast", variant: "low" },
    { providers: ["deepseek"], model: "deepseek-v4-flash", variant: "max" },
    { providers: ["opencode-go", "bailian-coding-plan"], model: "qwen3.7-plus" },
    { providers: ["vercel"], model: "minimax-m2.7-highspeed" },
    { providers: ["opencode-go", "vercel"], model: "minimax-m3" },
    { providers: ["minimax-coding-plan", "minimax-cn-coding-plan"], model: "MiniMax-M3" },
    { providers: ["opencode-go", "vercel"], model: "minimax-m2.7" },
    { providers: ["anthropic", "github-copilot", "vercel"], model: "claude-haiku-4-5" },
    { providers: ["openai", "vercel"], model: "gpt-5.4-nano" },
  ],
  "multimodal-looker": [
    { providers: ["openai", "opencode", "vercel"], model: "gpt-5.6-sol", variant: "low" },
    { providers: ["opencode-go", "vercel"], model: "kimi-k3" },
    { providers: ["zai-coding-plan", "vercel"], model: "glm-4.6v" },
    { providers: ["openai", "github-copilot", "opencode", "vercel"], model: "gpt-5-nano" },
  ],
  prometheus: [
    { providers: ["anthropic", "github-copilot", "opencode", "vercel"], model: "claude-fable-5", variant: "xhigh" },
    {
      providers: ["opencode-go", "kimi-for-coding", "moonshotai", "opencode", "vercel"],
      model: "kimi-k3",
      variant: "max",
    },
  ],
  metis: [
    { providers: ["anthropic", "github-copilot", "opencode", "vercel"], model: "claude-opus-5", variant: "high" },
    {
      providers: ["opencode-go", "kimi-for-coding", "moonshotai", "opencode", "vercel"],
      model: "kimi-k3",
      variant: "low",
    },
  ],
  momus: [
    { providers: ["openai", "vercel"], model: "gpt-5.6-terra", variant: "high" },
    { providers: ["github-copilot"], model: "gpt-5.6-terra", variant: "high" },
    { providers: ["openai", "opencode", "vercel"], model: "gpt-5.6-sol", variant: "xhigh" },
    { providers: ["github-copilot"], model: "gpt-5.6-sol", variant: "high" },
    { providers: ["anthropic", "github-copilot", "opencode", "vercel"], model: "claude-opus-5", variant: "max" },
    { providers: ["google", "github-copilot", "opencode", "vercel"], model: "gemini-3.1-pro", variant: "high" },
    { providers: ["opencode-go", "vercel"], model: "glm-5.2" },
  ],
  atlas: [
    { providers: ["anthropic", "github-copilot", "opencode", "vercel"], model: "claude-sonnet-5" },
    { providers: ["opencode-go", "vercel"], model: "kimi-k3" },
    { providers: ["openai", "github-copilot", "opencode", "vercel"], model: "gpt-5.6-sol", variant: "medium" },
    { providers: ["opencode-go", "vercel"], model: "minimax-m3" },
    { providers: ["minimax-coding-plan", "minimax-cn-coding-plan"], model: "MiniMax-M3" },
    { providers: ["opencode-go", "vercel"], model: "minimax-m2.7" },
  ],
  "sisyphus-junior": [
    { providers: ["anthropic", "github-copilot", "opencode", "vercel"], model: "claude-sonnet-5" },
    { providers: ["opencode-go", "vercel"], model: "kimi-k3" },
    { providers: ["openai", "github-copilot", "opencode", "vercel"], model: "gpt-5.6-sol", variant: "medium" },
    { providers: ["opencode-go", "vercel"], model: "minimax-m3" },
    { providers: ["minimax-coding-plan", "minimax-cn-coding-plan"], model: "MiniMax-M3" },
    { providers: ["opencode-go", "vercel"], model: "minimax-m2.7" },
    { providers: ["opencode"], model: "big-pickle" },
  ],
}

const CATEGORY_FALLBACKS: Record<string, FallbackChain> = {
  "visual-engineering": [
    {
      providers: ["anthropic", "anthropic-api", "github-copilot", "opencode", "vercel"],
      model: "claude-opus-5",
      variant: "max",
    },
    {
      providers: ["kimi-for-coding", "moonshotai", "opencode-go", "opencode", "vercel"],
      model: "kimi-k3",
      variant: "max",
    },
    { providers: ["zai-coding-plan", "opencode-go", "vercel"], model: "glm-5.2", variant: "max" },
    {
      providers: ["openai", "quotio-openai", "github-copilot", "opencode", "vercel"],
      model: "gpt-5.6-sol",
      variant: "medium",
    },
  ],
  ultrabrain: [
    { providers: ["openai", "quotio-openai", "vercel"], model: "gpt-5.6-sol", variant: "max" },
    { providers: ["github-copilot"], model: "gpt-5.6-sol", variant: "max" },
    { providers: ["openai", "opencode", "vercel"], model: "gpt-5.6-sol", variant: "max" },
  ],
  deep: [
    {
      providers: ["openai", "quotio-openai", "github-copilot", "opencode", "vercel"],
      model: "gpt-5.6-sol",
      variant: "medium",
    },
  ],
  artistry: [
    {
      providers: ["anthropic", "anthropic-api", "github-copilot", "opencode", "vercel"],
      model: "claude-fable-5",
      variant: "xhigh",
    },
    {
      providers: ["kimi-for-coding", "moonshotai", "opencode-go", "opencode", "vercel"],
      model: "kimi-k3",
      variant: "max",
    },
    {
      providers: ["anthropic", "anthropic-api", "github-copilot", "opencode", "vercel"],
      model: "claude-opus-5",
      variant: "xhigh",
    },
  ],
  quick: [
    { providers: ["kimi-for-coding"], model: "kimi-for-coding-highspeed" },
    { providers: ["quotio-openai"], model: "gpt-5.6-luna-fast", variant: "low" },
    { providers: ["deepseek"], model: "deepseek-v4-flash", variant: "off" },
    {
      providers: ["qwen-token-plan", "alibaba-token-plan", "bailian-coding-plan", "opencode-go", "vercel"],
      model: "qwen3.6-flash",
      variant: "low",
    },
    { providers: ["opencode-go", "vercel"], model: "minimax-m3", variant: "max" },
    { providers: ["opencode-go", "vercel"], model: "minimax-m2.7", variant: "max" },
    { providers: ["xai"], model: "grok-4.20-0309-non-reasoning" },
    {
      providers: ["anthropic", "anthropic-api", "github-copilot", "vercel"],
      model: "claude-haiku-4-5",
      variant: "off",
    },
  ],
  "unspecified-low": [
    {
      providers: ["openai", "quotio-openai", "github-copilot", "opencode", "vercel"],
      model: "gpt-5.6-terra",
      variant: "high",
    },
    {
      providers: ["anthropic", "anthropic-api", "github-copilot", "opencode", "vercel"],
      model: "claude-sonnet-5",
      variant: "low",
    },
    {
      providers: ["qwen-token-plan", "alibaba-token-plan", "qwen-token-plan-cn", "alibaba-token-plan-cn"],
      model: "qwen3.8-max-preview",
      variant: "max",
    },
    { providers: ["deepseek", "opencode-go", "vercel"], model: "deepseek-v4-pro", variant: "max" },
    { providers: ["xiaomi", "opencode-go", "vercel"], model: "mimo-v2.5-pro", variant: "max" },
  ],
  "unspecified-high": [
    {
      providers: ["kimi-for-coding", "moonshotai", "opencode-go", "opencode", "vercel"],
      model: "kimi-k3",
      variant: "max",
    },
    {
      providers: ["anthropic", "anthropic-api", "github-copilot", "opencode", "vercel"],
      model: "claude-opus-5",
      variant: "xhigh",
    },
    {
      providers: ["openai", "quotio-openai", "github-copilot", "opencode", "vercel"],
      model: "gpt-5.6-sol",
      variant: "high",
    },
  ],
  writing: [
    {
      providers: ["kimi-for-coding", "moonshotai", "opencode-go", "opencode", "vercel"],
      model: "kimi-k3",
      variant: "low",
    },
    {
      providers: ["anthropic", "anthropic-api", "github-copilot", "opencode", "vercel"],
      model: "claude-opus-5",
      variant: "low",
    },
    { providers: ["google", "github-copilot", "opencode", "vercel"], model: "gemini-3.6-flash" },
  ],
}

export function fallbackChain(kind: "agent" | "category", name: string): FallbackChain {
  const source = kind === "agent" ? AGENT_FALLBACKS : CATEGORY_FALLBACKS
  return source[name] ?? []
}
