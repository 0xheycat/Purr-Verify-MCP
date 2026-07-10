# Python verification

Purr Verify supports bounded Python dependency, test, lint, type-check, audit, and package-build workflows without becoming a general shell runner.

## Runner prerequisites

The Verify host must have:

- `python3` or `python` with the standard `venv` module
- `uv` only when a job uses `uv ...` commands
- network access to the configured Python package index

Check `health_check.runnerTools.python`, `python3`, and `uv` before creating a Python job.

## Isolation contract

Python jobs use a workspace-local `.venv`.

1. `python -m venv .venv` or `python3 -m venv .venv` creates it with the system interpreter.
2. Every other accepted `python`/`python3` command is normalized to `.venv/bin/python`.
3. `uv` uses the same `.venv` convention.
4. Pip and uv caches are kept under `.verify-cache/` inside the disposable job workspace.
5. The runner deletes the workspace, `.venv`, and caches during normal job cleanup.

The runner sets:

```text
VIRTUAL_ENV=.venv
PIP_DISABLE_PIP_VERSION_CHECK=1
PIP_NO_INPUT=1
PYTHONDONTWRITEBYTECODE=1
PYTHONUNBUFFERED=1
PIP_CACHE_DIR=.verify-cache/pip
UV_CACHE_DIR=.verify-cache/uv
```

## Pip / requirements workflow

```json
{
  "repo": "owner/repo",
  "ref": "feature-branch",
  "mode": "async",
  "commands": [
    "python3 --version",
    "python3 -m venv .venv",
    "python -m pip install --upgrade pip",
    "python -m pip install -r requirements.txt",
    "python -m pip check",
    "python -m pytest tests -q --maxfail=1"
  ]
}
```

For development dependencies, use the exact allowlisted filename:

```text
python -m pip install -r requirements-dev.txt
```

## uv workflow

```json
{
  "repo": "owner/repo",
  "ref": "feature-branch",
  "mode": "async",
  "commands": [
    "uv --version",
    "uv sync --all-extras --dev --frozen",
    "uv run pytest tests -q --maxfail=1",
    "uv run ruff check .",
    "uv run ruff format --check .",
    "uv run mypy .",
    "uv build"
  ]
}
```

Prefer `--frozen` whenever `uv.lock` is committed.

## Accepted command families

```text
python|python3 --version
python|python3 -m venv .venv
python|python3 -m pip install --upgrade pip
python|python3 -m pip install -r requirements.txt
python|python3 -m pip install -r requirements-dev.txt
python|python3 -m pip check
python|python3 -m pip_audit
python|python3 -m pytest [safe path/flags]
python|python3 -m unittest
python|python3 -m compileall <safe-relative-path>
python|python3 -m build
python|python3 <safe-relative-.py-path> [safe --flags]
uv --version
uv sync
uv sync --frozen
uv sync --dev --frozen
uv sync --all-extras --dev --frozen
uv run pytest [safe path/flags]
uv run ruff check .
uv run ruff format --check .
uv run mypy .
uv run pyright
uv run pip-audit
uv build
```

Accepted pytest flags are limited to:

```text
-q
-v
-x
--maxfail=<integer>
--disable-warnings
--strict-markers
--cov=<safe.python.module>
--cov-report=term-missing
```

## Explicitly rejected

```text
python -c ...
arbitrary python -m <module>
arbitrary pip package installation
pip editable installs
custom --index-url / --extra-index-url / --trusted-host
git+ dependency URLs
file:// dependency URLs
absolute paths
path traversal (`..`)
shell metacharacters
```

These restrictions preserve the existing no-shell, allowlist-only security model.
