---
argument-hint: [pr-number] [priority]
allowed-tools: Bash(git add:*), Bash(git status:*)
description: Review a pull request
disable-model-invocation: true
tools: [Read, Grep]
---
Review PR $1 with priority $2.
