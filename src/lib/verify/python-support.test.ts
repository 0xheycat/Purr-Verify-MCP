import { describe, expect, test } from "bun:test";
import { validateCommand } from "./allowlist";
import { parseCommand } from "./parse";

const accepted = [
  "python --version",
  "python3 --version",
  "python -m venv .venv",
  "python3 -m venv .venv",
  "python -m pip install --upgrade pip",
  "python -m pip install -r requirements.txt",
  "python -m pip install -r requirements-dev.txt",
  "python -m pip check",
  "python -m pip_audit",
  "python -m pytest",
  "python -m pytest tests -q --maxfail=1 --disable-warnings",
  "python -m pytest tests/unit/test_api.py -v --strict-markers --cov=app.core --cov-report=term-missing",
  "python -m unittest",
  "python -m compileall src",
  "python -m build",
  "python scripts/smoke.py",
  "python scripts/smoke.py --mode=test --quiet",
  "uv --version",
  "uv sync",
  "uv sync --frozen",
  "uv sync --dev --frozen",
  "uv sync --all-extras --dev --frozen",
  "uv run pytest",
  "uv run pytest tests -q -x",
  "uv run ruff check .",
  "uv run ruff format --check .",
  "uv run mypy .",
  "uv run pyright",
  "uv run pip-audit",
  "uv build",
];

const rejected = [
  "python -c print(1)",
  "python -m os",
  "python -m http.server",
  "python -m pip install requests",
  "python -m pip install -e .",
  "python -m pip install --index-url=https://example.com requests",
  "python -m pip install --extra-index-url=https://example.com -r requirements.txt",
  "python -m pip install --trusted-host=example.com -r requirements.txt",
  "python -m pip install git+https://github.com/example/repo.git",
  "python -m pip install file://package.whl",
  "python -m pytest --pdb",
  "python -m pytest --lf",
  "python -m compileall --quiet",
  "python /tmp/script.py",
  "python ../script.py",
  "python scripts/smoke.py --token=abc;rm",
  "uv pip install requests",
  "uv run python -c print(1)",
  "uv run pytest --pdb",
  "uv run pytest ../../etc/passwd",
  "uv sync --index-url=https://example.com",
];

describe("Python verification allowlist", () => {
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

describe("Python command parsing and isolation", () => {
  test("keeps system Python for virtualenv creation", () => {
    expect(parseCommand("python3 -m venv .venv")).toEqual({
      program: "python3",
      args: ["-m", "venv", ".venv"],
      env: {
        VIRTUAL_ENV: ".venv",
        PIP_DISABLE_PIP_VERSION_CHECK: "1",
        PIP_NO_INPUT: "1",
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONUNBUFFERED: "1",
        PIP_CACHE_DIR: ".verify-cache/pip",
        UV_CACHE_DIR: ".verify-cache/uv",
      },
    });
  });

  test("forces pip through the per-job virtualenv", () => {
    const parsed = parseCommand("python -m pip install -r requirements.txt");
    expect(parsed.program).toBe(".venv/bin/python");
    expect(parsed.args).toEqual(["-m", "pip", "install", "-r", "requirements.txt"]);
    expect(parsed.env.VIRTUAL_ENV).toBe(".venv");
    expect(parsed.env.PIP_CACHE_DIR).toBe(".verify-cache/pip");
  });

  test("forces pytest and scripts through the per-job virtualenv", () => {
    expect(parseCommand("python -m pytest tests -q").program).toBe(".venv/bin/python");
    expect(parseCommand("python scripts/smoke.py").program).toBe(".venv/bin/python");
  });

  test("scopes uv cache and virtualenv metadata to the job workspace", () => {
    const parsed = parseCommand("uv sync --frozen");
    expect(parsed.program).toBe("uv");
    expect(parsed.env).toMatchObject({
      VIRTUAL_ENV: ".venv",
      UV_CACHE_DIR: ".verify-cache/uv",
      PYTHONUNBUFFERED: "1",
    });
  });
});
