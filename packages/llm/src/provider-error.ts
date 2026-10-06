import { Schema } from "effect"
import { LLMError, ProviderErrorEvent } from "./schema"

const patterns = [
  /prompt is too long/i,
  /request_too_large/i,
  /input is too long for requested model/i,
  /exceeds the context window/i,
  /exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i,
  /input token count.*exceeds the maximum/i,
  /tokens in request more than max tokens allowed/i,
  /maximum prompt length is \d+/i,
  /reduce the length of the messages/i,
  /maximum context length is \d+ tokens/i,
  /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i,
  /input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i,
  /exceeds the limit of \d+/i,
  /exceeds the available context size/i,
  /greater than the context length/i,
  /context window exceeds limit/i,
  /exceeded model token limit/i,
  /context[_ ]length[_ ]exceeded/i,
  /request entity too large/i,
  /context length is only \d+ tokens/i,
  /input length.*exceeds.*context length/i,
  /prompt too long; exceeded (?:max )?context length/i,
  /too large for model with \d+ maximum context length/i,
  /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i,
  /model_context_window_exceeded/i,
  /too many tokens/i,
  /token limit exceeded/i,
]

const exclusions = [/^(throttling error|service unavailable):/i, /rate limit/i, /too many requests/i]

// Provider schema-validation failures caused by oversized request parts
// (e.g. OpenAI Responses `input[N].call_id` length caps). The request itself
// is well-formed JSON but the accumulated transcript can never fit; retrying
// or erroring to the user is wrong — the session needs compaction.
const reclassificationPatterns = [/(?:call_id|tool_call_id)[^\n]*length[^\n]*<=\s*64/i, /(?:call_id|tool_call_id)[^\n]*must be[^\n]*64/i]

export const isRepetitiveContent = (message: string) => reclassificationPatterns.some((pattern) => pattern.test(message))

export const classifyInvalidRequest = (message: string) => {
  if (isContextOverflow(message)) return "context-overflow" as const
  if (isRepetitiveContent(message)) return "repetitive-content" as const
  return undefined
}

export const isContextOverflow = (message: string) =>
  !exclusions.some((pattern) => pattern.test(message)) &&
  (patterns.some((pattern) => pattern.test(message)) || /^4(00|13)\s*(status code)?\s*\(no body\)/i.test(message))

// Failures recoverable by compacting the session: either a genuine context
// overflow, or accumulated-transcript schema failures (oversized tool-call
// IDs) that retrying verbatim can never fix.
export const isCompactWorthyFailure = (failure: unknown) => {
  const classify = (classification: string | undefined) =>
    classification === "context-overflow" || classification === "repetitive-content"
  if (failure instanceof LLMError) {
    return failure.reason._tag === "InvalidRequest" && classify(failure.reason.classification)
  }
  return Schema.is(ProviderErrorEvent)(failure) && classify(failure.classification)
}

export const isContextOverflowFailure = (failure: unknown) =>
  failure instanceof LLMError
    ? failure.reason._tag === "InvalidRequest" && failure.reason.classification === "context-overflow"
    : Schema.is(ProviderErrorEvent)(failure) && failure.classification === "context-overflow"
