# Inter-session messaging and OpenAI reconnect

Date: 2026-09-30
Status: Approved

## Messaging

A session can send a message to another session without failing when the target is busy.

- A draining target receives a `steer` input, promoted at the next safe provider-turn boundary.
- An idle target receives a `queue` input, promoted when that session would otherwise go idle.
- The sender does not wait, so two sessions cannot deadlock.
- The peer's next assistant text is delivered back to the sender as a synthetic `peer_reply`.
- Self-sends and unknown sessions still fail.

## OpenAI reconnect

The connected OpenAI row shows a Reconnect button beside Disconnect. It reopens the existing OpenAI OAuth connect flow. The button is hidden when the credential comes from the environment.
