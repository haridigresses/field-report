---
name: fr-ask-questions
description: Ask the smallest set of must-have multiple-choice questions, wait for answers, and confirm the interpretation before starting. Use in BRR step 1, or when the user asks you to clarify a request before starting. Not for every task.
---

<!-- Adapted from the ask-questions-if-underspecified skill published by Trail of Bits (https://github.com/trailofbits/skills), originally by @thsottiaux. Modified: reworded and condensed for Field Report. Licensed CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/); this file stays under that license. -->

# Ask questions if underspecified

## Workflow

1. Decide whether the request is underspecified.
2. Ask the smallest set of must-have questions first.
3. Pause before implementation until answers are provided.
4. Confirm interpretation, then proceed.

## 1) Detect underspecification

Treat the request as underspecified when one or more of these is unclear after quick, low-risk discovery:

- Objective: what should change vs. stay the same
- Done criteria: acceptance checks, examples, edge cases
- Scope: in/out files, components, users
- Constraints: compatibility, style, dependencies, performance, time
- Environment: language/runtime versions, OS, test/build tools
- Safety/reversibility: migration, rollout, rollback, risk

If multiple reasonable interpretations exist, classify it as underspecified. Do not ask questions that a quick read of local configs or existing patterns answers.

## 2) Ask must-have questions first

Ask 1–5 questions in the first pass. Prefer questions that eliminate whole branches of work.

- Use numbered questions.
- Prefer multiple-choice options (`a/b/c`) with a recommended default.
- Include a fast path (`reply defaults`, or compact codes like `1a 2b 3c`).
- Include a low-friction `Not sure - use default` option when useful.
- Separate `Need to know` from `Nice to know` when that reduces user effort.

Keep each question short and scannable. Avoid open-ended prompts when a tight option list can resolve the ambiguity. Recommend defaults explicitly.

Templates:

- "Before I start, I need: (1) ..., (2) ..., (3) .... If you don't care about (2), I will assume ...."
- "Which of these should it be? A) ... B) ... C) ... (pick one)"
- "What would you consider done? For example: ..."

## 3) Pause before acting

Until must-have answers arrive:

- Do not run implementation commands.
- Do not edit files.
- Do not provide a detailed implementation plan that depends on unknowns.
- Only perform clearly labeled, low-risk discovery when needed.

If the user asks to proceed without answers: state short numbered assumptions, ask for confirmation, and proceed only after they confirm or correct them.

## 4) Confirm interpretation, then proceed

After answers arrive, restate the requirements in 1–3 sentences, including key constraints and done criteria. Then start.

## Reply format

1. Scope? a) Minimal change (default) b) Refactor while touching area c) Not sure - use default
2. Compatibility target? a) Current project defaults (default) b) Also support older versions c) Not sure - use default

Ask the user to reply with `defaults` or compact choices such as `1a 2a`.

Avoid: questions that quick local discovery answers, and broad open-ended questions when a binary or multiple-choice question decides faster.
