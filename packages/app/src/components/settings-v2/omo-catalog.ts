// Static snapshot of Oh My OpenAgent's fallback chains.
// Copied at implementation from `AGENT_MODEL_REQUIREMENTS` and
// `CATEGORY_MODEL_REQUIREMENTS` in the installed `oh-my-openagent` package
// (`node_modules/oh-my-openagent/dist/index.js`). We do not import that
// package and do not parse it at runtime.

export type FallbackEntry = { providers: string[]; model: string; variant?: string }
export type FallbackChain = FallbackEntry[]

// gpt-6.1-sol sits one rung above gpt-6-sol: gpt-6-astra stays flagship, and
// these rungs slot in as the flagship/balanced tier for chains that lead with
// (or fall back to) the gpt-6-sol tier.
const SOL_61_ENTRY: FallbackEntry = { providers: ["openai", "vercel", "opencode"], model: "gpt-6.1-sol" }

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
    { providers: ["anthropic", "github-copilot", "opencode", "vercel"], model: "gpt-6-astra", variant: "max" },
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
    SOL_61_ENTRY,
    { providers: ["openai", "github-copilot", "opencode", "vercel"], model: "gpt-5.6-sol", variant: "medium" },
    { providers: ["zai-coding-plan", "opencode", "bailian-coding-plan", "vercel"], model: "glm-5.2" },
    { providers: ["opencode"], model: "big-pickle" },
  ],
  hephaestus: [SOL_61_ENTRY, { providers: ["openai", "github-copilot", "vercel", "opencode"], model: "gpt-6-sol", variant: "medium" }],
  oracle: [
    { providers: ["openai", "opencode", "vercel"], model: "gpt-6-astra", variant: "xhigh" },
    SOL_61_ENTRY,
    { providers: ["github-copilot"], model: "gpt-5.6-sol", variant: "high" },
    { providers: ["google", "github-copilot", "opencode", "vercel"], model: "gemini-3.1-pro", variant: "high" },
    { providers: ["anthropic", "github-copilot", "opencode", "vercel"], model: "claude-opus-5", variant: "max" },
    { providers: ["opencode-go", "vercel"], model: "glm-5.2" },
  ],
  librarian: [
    { providers: ["opencode", "vercel"], model: "gpt-6-luna", variant: "low" },
    { providers: ["deepseek"], model: "deepseek-v4-flash", variant: "max" },
    { providers: ["opencode-go", "bailian-coding-plan"], model: "qwen3.7-plus" },
    { providers: ["vercel", "opencode-go"], model: "minimax-m2.7" },
    { providers: ["opencode-go", "vercel"], model: "minimax-m3" },
    { providers: ["minimax-coding-plan", "minimax-cn-coding-plan"], model: "MiniMax-M3" },
    { providers: ["opencode-go", "vercel"], model: "minimax-m2.7" },
    { providers: ["anthropic", "github-copilot", "vercel"], model: "claude-haiku-4-5" },
    { providers: ["openai", "vercel"], model: "gpt-5.4-nano" },
  ],
  explore: [
    { providers: ["opencode", "vercel"], model: "gpt-6-luna", variant: "low" },
    { providers: ["deepseek"], model: "deepseek-v4-flash", variant: "max" },
    { providers: ["opencode-go", "bailian-coding-plan"], model: "qwen3.7-plus" },
    { providers: ["vercel", "opencode-go"], model: "minimax-m2.7" },
    { providers: ["opencode-go", "vercel"], model: "minimax-m3" },
    { providers: ["minimax-coding-plan", "minimax-cn-coding-plan"], model: "MiniMax-M3" },
    { providers: ["opencode-go", "vercel"], model: "minimax-m2.7" },
    { providers: ["anthropic", "github-copilot", "vercel"], model: "claude-haiku-4-5" },
    { providers: ["openai", "vercel"], model: "gpt-5.4-nano" },
  ],
  "multimodal-looker": [
    { providers: ["openai", "opencode", "vercel"], model: "gpt-5.6-sol", variant: "low" },
    { providers: ["opencode-go", "vercel"], model: "kimi-k3" },
    { providers: ["opencode", "opencode-go", "vercel"], model: "glm-5.2" },
    { providers: ["openai", "github-copilot", "opencode", "vercel"], model: "gpt-5-nano" },
  ],
  prometheus: [
    SOL_61_ENTRY,
    { providers: ["anthropic", "github-copilot", "opencode", "vercel"], model: "gpt-6-sol", variant: "high" },
    {
      providers: ["opencode-go", "kimi-for-coding", "moonshotai", "opencode", "vercel"],
      model: "kimi-k3",
      variant: "max",
    },
  ],
  metis: [
    SOL_61_ENTRY,
    { providers: ["anthropic", "github-copilot", "opencode", "vercel"], model: "gpt-6-sol", variant: "high" },
    {
      providers: ["opencode-go", "kimi-for-coding", "moonshotai", "opencode", "vercel"],
      model: "kimi-k3",
      variant: "low",
    },
  ],
  momus: [
    SOL_61_ENTRY,
    { providers: ["openai", "vercel"], model: "gpt-6-sol", variant: "xhigh" },
    { providers: ["github-copilot"], model: "gpt-5.6-terra", variant: "high" },
    { providers: ["openai", "opencode", "vercel"], model: "gpt-5.6-sol", variant: "xhigh" },
    { providers: ["github-copilot"], model: "gpt-5.6-sol", variant: "high" },
    { providers: ["anthropic", "github-copilot", "opencode", "vercel"], model: "claude-opus-5", variant: "max" },
    { providers: ["google", "github-copilot", "opencode", "vercel"], model: "gemini-3.1-pro", variant: "high" },
    { providers: ["opencode-go", "vercel"], model: "glm-5.2" },
  ],
  atlas: [
    SOL_61_ENTRY,
    { providers: ["anthropic", "github-copilot", "opencode", "vercel"], model: "gpt-6-sol", variant: "medium" },
    { providers: ["opencode-go", "vercel"], model: "kimi-k3" },
    { providers: ["openai", "github-copilot", "opencode", "vercel"], model: "gpt-5.6-sol", variant: "medium" },
    { providers: ["opencode-go", "vercel"], model: "minimax-m3" },
    { providers: ["minimax-coding-plan", "minimax-cn-coding-plan"], model: "MiniMax-M3" },
    { providers: ["opencode-go", "vercel"], model: "minimax-m2.7" },
  ],
  "sisyphus-junior": [
    SOL_61_ENTRY,
    { providers: ["anthropic", "github-copilot", "opencode", "vercel"], model: "gpt-6-sol", variant: "medium" },
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
      model: "gpt-6-astra",
      variant: "max",
    },
    SOL_61_ENTRY,
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
    SOL_61_ENTRY,
    { providers: ["openai", "quotio-openai", "vercel"], model: "gpt-6-sol", variant: "max" },
    { providers: ["github-copilot"], model: "gpt-5.6-sol", variant: "max" },
    { providers: ["openai", "opencode", "vercel"], model: "gpt-5.6-sol", variant: "max" },
  ],
  deep: [
    SOL_61_ENTRY,
    {
      providers: ["openai", "quotio-openai", "github-copilot", "opencode", "vercel"],
      model: "gpt-6-sol",
      variant: "medium",
    },
  ],
  artistry: [
    {
      providers: ["anthropic", "anthropic-api", "github-copilot", "opencode", "vercel"],
      model: "gpt-6-astra",
      variant: "xhigh",
    },
    SOL_61_ENTRY,
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
    { providers: ["opencode"], model: "gpt-6-luna", variant: "low" },
    { providers: ["opencode", "vercel"], model: "gpt-6-luna", variant: "low" },
    { providers: ["deepseek"], model: "deepseek-v4-flash", variant: "off" },
    {
      providers: ["opencode", "opencode-go", "vercel"],
      model: "qwen3.6-plus",
      variant: "low",
    },
    { providers: ["opencode-go", "vercel"], model: "minimax-m3", variant: "max" },
    { providers: ["opencode-go", "vercel"], model: "minimax-m2.7", variant: "max" },
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
    SOL_61_ENTRY,
    {
      providers: ["kimi-for-coding", "moonshotai", "opencode-go", "opencode", "vercel"],
      model: "gpt-6-sol",
      variant: "high",
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
    SOL_61_ENTRY,
    {
      providers: ["kimi-for-coding", "moonshotai", "opencode-go", "opencode", "vercel"],
      model: "gpt-6-sol",
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
