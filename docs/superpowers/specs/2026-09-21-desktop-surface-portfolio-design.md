# Desktop Surface Portfolio - Design

Date: 2026-09-21
Status: Draft

## Problem

The user asked for several independent Flynncode surfaces at once, plus Oh My
OpenCode model defaults. Shipping them as one spec would mix UI, mobile, and
config work and stall all of them.

## Goal

Split the request into five sequential cycles. Each cycle has its own spec,
plan, and implementation. Later cycles may start only after the previous
cycle's spec is written; they must not share one implementation plan.

## Cycles (build order)

1. **OMO allowlist models** — pin Oh My OpenCode agents and categories to
   sensible models from the user's provider allowlist, Claude over ChatGPT,
   no xAI in defaults. Spec:
   `docs/superpowers/specs/2026-09-21-omo-allowlist-models-design.md`
2. **OpenCode Mobile (doza62)** — install `npx opencode-mobile` so the App
   Store OpenCode Mobile app can pair via `/mobile` QR, push, and tunnel.
   Replace Flynncode `mobile-gateway` as the phone client. Keep the gateway
   package in the repo; stop loading it from this machine's `plugin[]`.
3. **Artifacts sidebar** — a desktop sidebar listing session artifacts.
4. **Routines menu** — scheduled or repeatable agent jobs in a menu.
5. **Dispatch** — Claude Desktop-style send-a-task surface.

## Constraints that apply to every cycle

- Do not vendor Oh My OpenCode into the Flynncode repo.
- Third-party plugins must be checked against the Ollama model router.
  The router is off on this machine (`model_router.enabled: false`).
- English UI copy is source; no hardcoded English in production UI.
- Config is load-once; tell the user to restart OpenCode after config edits.

## Out of scope for this document

Implementation details of cycles 2–5. Those get their own specs.
