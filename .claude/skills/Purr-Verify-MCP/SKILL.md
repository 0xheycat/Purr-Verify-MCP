```markdown
# Purr-Verify-MCP Development Patterns

> Auto-generated skill from repository analysis

## Overview

This skill teaches you how to contribute to the Purr-Verify-MCP TypeScript codebase, which manages verification job runners with a focus on per-job environment variable handling, redaction, and observability. You'll learn the project's coding conventions, how to enhance job environment workflows, and how to write and organize tests.

## Coding Conventions

### File Naming

- Use **camelCase** for file names.
  - Example: `verifyExecutor.ts`, `jobStore.ts`

### Import Style

- Mixed import styles are used. Both default and named imports may appear.
  - Example:
    ```typescript
    import { runJob } from './jobRunner';
    import config from './config';
    ```

### Export Style

- Prefer **named exports**.
  - Example:
    ```typescript
    // Good
    export function redactEnvVars(env: Record<string, string>) { ... }

    // Avoid default exports unless necessary
    ```

### Commit Messages

- Follow **conventional commit** format.
- Use prefixes like `fix`.
- Keep commit messages descriptive (average length: ~100 chars).
  - Example:
    ```
    fix: properly redact sensitive env vars in job runner health endpoint
    ```

## Workflows

### Enhance Job Environment and Observability

**Trigger:** When you need to improve or fix how job-specific environment variables are handled, injected, redacted, or surfaced in health/observability endpoints.

**Command:** `/enhance-job-env`

**Step-by-step Instructions:**

1. **Update Executor Logic**
   - Edit `src/lib/verify/executor.ts` to handle per-job environment injection and redaction.
   - Example:
     ```typescript
     // Inject and redact environment variables before running the job
     const jobEnv = redactEnvVars(getJobEnv(jobId));
     runJob(job, { env: jobEnv });
     ```

2. **Update Store Logic**
   - Modify `src/lib/verify/store.ts` to manage per-job environment variables in runtime memory.
   - Example:
     ```typescript
     export function setJobEnv(jobId: string, env: Record<string, string>) { ... }
     export function getJobEnv(jobId: string): Record<string, string> { ... }
     ```

3. **Update MCP Logic**
   - In `src/lib/verify/mcp.ts`, validate, inject, and redact environment variables for jobs.
   - Expose new observability endpoints as needed.

4. **Update Config and Redact Logic**
   - Adjust `src/lib/verify/config.ts` and `src/lib/verify/redact.ts` to support new environment handling and redaction.
   - Example:
     ```typescript
     export function redactEnvVars(env: Record<string, string>): Record<string, string> {
       // Redact sensitive keys
       ...
     }
     ```

5. **Update Types and Health Route**
   - Update `src/lib/verify/types.ts` for any new types.
   - Update `src/app/api/health/route.ts` to surface new observability data.

**Files Involved:**
- `src/lib/verify/executor.ts`
- `src/lib/verify/store.ts`
- `src/lib/verify/mcp.ts`
- `src/lib/verify/config.ts`
- `src/lib/verify/redact.ts`
- `src/lib/verify/types.ts`
- `src/app/api/health/route.ts`

## Testing Patterns

- Test files follow the pattern: `*.test.*`
  - Example: `executor.test.ts`
- Testing framework is **unknown**; check existing test files for style and structure.
- Place tests alongside implementation or in a dedicated `__tests__` directory.
- Example test file:
  ```typescript
  import { redactEnvVars } from './redact';

  test('redacts sensitive env vars', () => {
    const env = { SECRET_KEY: 'abc', PUBLIC: '123' };
    expect(redactEnvVars(env)).toEqual({ SECRET_KEY: '[REDACTED]', PUBLIC: '123' });
  });
  ```

## Commands

| Command           | Purpose                                                                                 |
|-------------------|-----------------------------------------------------------------------------------------|
| /enhance-job-env  | Implements or fixes per-job environment variable injection, redaction, and observability |
```
