import { describe, expect, test } from "bun:test";
import path from "node:path";
import { validateCommand } from "./allowlist";
import { parseCommand } from "./parse";

const accepted = [
  "python --version",
  "python3 --help",
  "python -m venv .venv",
  "python3 -m venv --system-site-packages .venv",
  "python -m pip install --upgrade pip",
  "python -m pip install -r requirements.txt",
  "python -m pip install -r requirements/dev.in",
  "python -m pip install requests",
  "python -m pip install requests[socks]",
  "python -m pip install -e .",
  "python -m pip install --no-deps .",
  "python -m pip check",
  "python -m pip freeze",
  "python -m pip show requests fastapi",
  "python -m pytest tests -q --maxfail=1 --disable-warnings",
  "python -m pytest tests/unit/test_api.py --pdb --lf",
  "python -m unittest discover -s tests",
  "python -m compileall src",
  "python -m build --wheel",
  "python -m ruff check src",
  "python -m mypy src --strict",
  "python -m coverage run -m pytest tests",
  "python -m django check",
  "python scripts/smoke.py --mode=test --quiet",
  "uv --version",
  "uv sync --all-extras --dev --frozen",
  "uv lock --check",
  "uv run pytest tests -q --pdb",
  "uv run python -m unittest discover",
  "uv python install 3.12.4",
  "uv python find 3.12.4",
  "uv pip install -r requirements.txt",
  "uvx ruff check .",
  "poetry --version",
  "poetry install --with dev --no-interaction",
  "poetry lock --no-update",
  "poetry run pytest tests -q",
  "poetry build",
  "pipenv --version",
  "pipenv sync --dev",
  "pipenv install --dev",
  "pipenv run pytest tests -q",
  "pipenv verify",
  "pytest tests -q --pdb",
  "ruff check src",
  "mypy src --strict",
  "pyright",
  "tox -e py312",
  "nox -s tests",
  "coverage report -m",
  "django-admin check",
];

const rejected = [
  "python -c print(1)",
  "python -m venv other-env",
  "python -m pip install --index-url=https://example.com requests",
  "python -m pip install --extra-index-url=https://example.com -r requirements.txt",
  "python -m pip install --trusted-host=example.com requests",
  "python -m pip install git+https://github.com/example/repo.git",
  "python -m pip install file://package.whl",
  "python /tmp/script.py",
  "python ../script.py",
  "python scripts/smoke.py --token=abc;rm",
  "python scripts/smoke.py 'quoted value'",
  "uv run pytest ../../etc/passwd",
  "uv run docker build .",
  "poetry run rm -rf .",
  "pipenv run sudo id",
  "pytest /tmp/tests",
  "ruff check ../src",
  "uv sync && echo done",
];

describe("developer-friendly Python verification policy", () => {
  for (const command of accepted) {
    test(`accepts ${command}`, () => {
      expect(validateCommand(command)).toMatchObject({ ok: true });
    });
  }

  for (const command of rejected) {
    test(`rejects ${command}`, () => {
      expect(validateCommand(command).ok).toBe(false);
    });
  }
});

describe("Python command parsing and workspace isolation", () => {
  const venvPython = process.platform === "win32"
    ? path.join(".venv", "Scripts", "python.exe")
    : path.join(".venv", "bin", "python");

  const venvPytest = process.platform === "win32"
    ? path.join(".venv", "Scripts", "pytest.exe")
    : path.join(".venv", "bin", "pytest");

  test("keeps the selected host Python for virtualenv creation", () => {
    expect(parseCommand("python3 -m venv .venv")).toMatchObject({
      program: "python3",
      args: ["-m", "venv", ".venv"],
      env: {
        VIRTUAL_ENV: ".venv",
        PIP_NO_INPUT: "1",
        UV_PROJECT_ENVIRONMENT: ".venv",
        POETRY_VIRTUALENVS_IN_PROJECT: "true",
        PIPENV_VENV_IN_PROJECT: "1",
      },
    });
  });

  test("forces pip, modules, and scripts through the per-job virtualenv", () => {
    expect(parseCommand("python -m pip install requests").program).toBe(venvPython);
    expect(parseCommand("python -m pytest tests -q").program).toBe(venvPython);
    expect(parseCommand("python scripts/smoke.py").program).toBe(venvPython);
  });

  test("normalizes direct developer tools to the per-job virtualenv", () => {
    expect(parseCommand("pytest tests -q").program).toBe(venvPytest);
  });

  test("keeps package managers as host tools with in-project environment settings", () => {
    for (const command of ["uv sync --frozen", "poetry install", "pipenv sync --dev"]) {
      const parsed = parseCommand(command);
      expect(parsed.env).toMatchObject({
        VIRTUAL_ENV: ".venv",
        UV_CACHE_DIR: ".verify-cache/uv",
        POETRY_VIRTUALENVS_IN_PROJECT: "true",
        PIPENV_VENV_IN_PROJECT: "1",
      });
    }
  });
});
