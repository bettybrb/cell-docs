# Progress
- [x] 1. Real AI (src/worker/llm.ts): Anthropic Messages API via server-side `ANTHROPIC_API_KEY` (+`LLM_MODEL`), JSON output validated, edits must match uniquely; goes through existing proposals (approval, permissions, versions, relative-position apply). `LLM_MOCK=1` = deterministic mock. Tests: test/worker/ai.test.ts
