/**
 * Provider wording for a stream that ended before its terminal event.
 *
 * pi-ai's OpenAI-compatible transports throw `Stream ended without
 * finish_reason` when the chunk stream completes without a finish_reason.
 * The native dsh-llm-pi-ai adapter maps that wording (and the other
 * provider-specific variants below) to TRANSPORT, so DSH's llm-retry can
 * retry the failed step. The ported classifier must keep the same taxonomy;
 * otherwise the message falls through to UPSTREAM, which is not in the
 * provider's retryable-code set.
 *
 * Keep this aligned with dsh-llm-pi-ai's convert.spec.ts transport matrix.
 */
const STREAM_TRUNCATION_WORDING = /\bstream (?:ended|closed)\b|without finish_reason|before (?:message_stop|a terminal (?:response )?event)|other side closed|\bdid not get a response\b|\bwebsocket closed\b/i

/** True when a provider error names a premature/incomplete stream ending. */
export function isStreamTruncationWording(text: string): boolean {
  return STREAM_TRUNCATION_WORDING.test(text)
}
