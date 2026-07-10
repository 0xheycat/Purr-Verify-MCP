# Python verification

Purr Verify supports practical Python dependency, test, lint, type-check, audit, migration-check, and package-build workflows. The runner stays shell-free, but it does not force developers into a tiny list of project-specific flags.

## Design principle

The Python policy is **developer-friendly by default**:

- normal modules and relative scripts are allowed;
- normal pytest, Ruff, mypy, Pyright, tox, nox, coverage, Django, uv, Poetry, and Pipenv arguments are allowed;
- pip may install requirements files, local projects, editable local projects, and ordinary package names;
- Python versions may be installed or selected explicitly through `uv python ...`;
- commands still run with `spawn(..., { shell: false })`.

The remaining boundaries only prevent shell escape, host path escape, destructive system commands, loader overrides, and secret-bearing/custom package-index URLs in command text.

## Runner prerequisites

The Verify host should have:

- `python3` or `python` with the standard `venv` module;
- `uv` for uv workflows and optional Python-version installation;
- Poetry or Pipenv only when those workflows are requested;
- network access to the configured package index.

`health_check.runnerTools` reports:

```text
python
python3
uv
poetry
pipenv
tox
nox
```

## Workspace isolation

Python project work uses a workspace-local `.venv`.

1. `python -m venv .venv` creates the environment with the selected host/toolchain interpreter.
2. Other `python` and `python3` commands are normalized to the workspace virtualenv interpreter.
3. Direct tools such as `pytest`, `ruff`, `mypy`, `pyright`, `tox`, `nox`, and `coverage` are normalized to the virtualenv executable.
4. uv, Poetry, and Pipenv are configured to use the in-project `.venv`.
5. The entire disposable workspace, including `.venv` and caches, is removed during job cleanup.

The runner injects:

```text
VIRTUAL_ENV=.venv
PIP_DISABLE_PIP_VERSION_CHECK=1
PIP_NO_INPUT=1
PYTHONDONTWRITEBYTECODE=1
PYTHONUNBUFFERED=1
PIP_CACHE_DIR=.verify-cache/pip
UV_CACHE_DIR=.verify-cache/uv
UV_PROJECT_ENVIRONMENT=.venv
POETRY_VIRTUALENVS_CREATE=true
POETRY_VIRTUALENVS_IN_PROJECT=true
PIPENV_VENV_IN_PROJECT=1
PIPENV_NOSPIN=1
```

The virtualenv executable is platform-aware:

```text
POSIX:   .venv/bin/python
Windows: .venv/Scripts/python.exe
```

## Pip workflow

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
    "python -m pip install -e .",
    "python -m pip check",
    "python -m pytest tests -q --maxfail=1"
  ]
}
```

Supported requirement files are safe relative `.txt` or `.in` paths, for example:

```text
requirements.txt
requirements-dev.txt
requirements/dev.in
```

## uv workflow

```json
{
  "repo": "owner/repo",
  "ref": "feature-branch",
  "mode": "async",
  "commands": [
    "uv --version",
    "uv python install 3.12.4",
    "uv sync --all-extras --dev --frozen",
    "uv run pytest tests -q --pdb",
    "uv run ruff check .",
    "uv run mypy .",
    "uv build"
  ]
}
```

Common uv families:

```text
uv sync
uv lock
uv run
uv build
uv python
uv pip
uv tool
uv tree
uv export
uvx <tool>
```

## Poetry workflow

```json
{
  "commands": [
    "poetry --version",
    "poetry install --with dev --no-interaction",
    "poetry check",
    "poetry run pytest tests -q",
    "poetry build"
  ]
}
```

Supported Poetry families:

```text
install
sync
lock
check
build
run
env
show
export
```

## Pipenv workflow

```json
{
  "commands": [
    "pipenv --version",
    "pipenv sync --dev",
    "pipenv verify",
    "pipenv run pytest tests -q"
  ]
}
```

Supported Pipenv families:

```text
sync
install
run
check
verify
requirements
graph
```

## Direct developer tools

These may be called directly and are resolved from `.venv`:

```text
pytest
ruff
mypy
pyright
tox
nox
coverage
django-admin
```

Arbitrary safe Python modules are also supported:

```text
python -m pytest
python -m unittest
python -m ruff
python -m mypy
python -m coverage
python -m django
python -m alembic check
python -m build
```

## Remaining boundaries

The runner still rejects:

```text
shell operators: ; && || | > < ` $()
inline python -c
absolute paths
path traversal using ..
quoted shell fragments
custom --index-url / --extra-index-url / --trusted-host in command text
git+ and file:// dependency URLs
destructive system command tokens such as rm, sudo, chmod, docker, ssh, and dd
```

Private package indexes should be configured through redacted per-job environment variables such as `PIP_INDEX_URL` instead of command arguments, so credentials do not appear in stored command text.
