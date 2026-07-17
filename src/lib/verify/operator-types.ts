export type ProjectMarker =
  | ".git"
  | "package.json"
  | "Cargo.toml"
  | "pyproject.toml"
  | "requirements.txt"
  | "go.mod"
  | "docker-compose.yml"
  | "docker-compose.yaml"
  | "compose.yml"
  | "compose.yaml"
  | "ecosystem.config.js"
  | "ecosystem.config.cjs"
  | "ecosystem.config.mjs";

export type PackageManagerName = "bun" | "pnpm" | "yarn" | "npm" | "unknown";
export type DeploymentStrategy =
  | "auto"
  | "in_place"
  | "release_symlink"
  | "pm2"
  | "systemd"
  | "docker_compose"
  | "custom";

export type EnvironmentSourceName =
  | "dotenv"
  | "pm2"
  | "systemd"
  | "docker_compose"
  | "process";

export interface DiscoveredProject {
  path: string;
  canonicalPath: string;
  name: string;
  markers: ProjectMarker[];
  packageManager: PackageManagerName;
  projectType: string[];
  symlink: boolean;
}

export interface GitInspection {
  present: boolean;
  root: string | null;
  branch: string | null;
  head: string | null;
  origin: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: number;
  modified: number;
  untracked: number;
  conflicted: number;
  dirty: boolean;
}

export interface ProjectInspection {
  requestedPath: string;
  canonicalPath: string;
  symlink: boolean;
  name: string;
  markers: ProjectMarker[];
  projectType: string[];
  git: GitInspection;
  packageManager: PackageManagerName;
  packageManagerDeclaration: string | null;
  packageName: string | null;
  packageVersion: string | null;
  engines: Record<string, string>;
  scripts: Record<string, string>;
  workspaces: string[];
  monorepo: boolean;
  composeFiles: string[];
  pm2Files: string[];
  manifestFiles: string[];
  environmentFiles: string[];
  requiredEnvironmentKeys: string[];
  suggestedCommands: {
    install: string[];
    verify: string[];
    build: string[];
    start: string[];
  };
}

export interface RuntimeToolState {
  available: boolean;
  path: string | null;
  version: string | null;
  error: string | null;
}

export interface Pm2RuntimeService {
  manager: "pm2";
  name: string;
  id: number | null;
  pid: number | null;
  status: string | null;
  cwd: string | null;
  script: string | null;
  namespace: string | null;
  interpreter: string | null;
  restarts: number | null;
}

export interface SystemdRuntimeService {
  manager: "systemd";
  name: string;
  activeState: string | null;
  subState: string | null;
  mainPid: number | null;
  workingDirectory: string | null;
  fragmentPath: string | null;
  execStart: string | null;
}

export interface DockerRuntimeService {
  manager: "docker_compose";
  project: string | null;
  service: string | null;
  name: string | null;
  state: string | null;
  status: string | null;
  health: string | null;
  composeFile: string;
}

export interface ProcessRuntime {
  manager: "process";
  pid: number;
  cwd: string;
  command: string;
}

export interface RuntimeInspection {
  cwd: string;
  tools: Record<string, RuntimeToolState>;
  pm2: Pm2RuntimeService[];
  systemd: SystemdRuntimeService[];
  dockerCompose: DockerRuntimeService[];
  processes: ProcessRuntime[];
  detectedManagers: Array<"pm2" | "systemd" | "docker_compose" | "process">;
  notes: string[];
}

export interface EnvironmentObservation {
  source: EnvironmentSourceName;
  location: string;
  present: true;
  redacted: boolean;
  value?: string;
  pid?: number;
  service?: string;
}

export interface EnvironmentEntry {
  key: string;
  present: true;
  observations: EnvironmentObservation[];
}

export interface EnvironmentInspection {
  cwd: string;
  sourcesRequested: EnvironmentSourceName[];
  entries: EnvironmentEntry[];
  requestedKeysMissing: string[];
  revealedKeys: string[];
  sensitiveOutput: boolean;
  valuesPersisted: false;
  notes: string[];
}

export interface DeploymentRisk {
  level: "low" | "medium" | "high";
  code: string;
  message: string;
}

export interface DeploymentPlanInput {
  cwd: string;
  targetRef?: string;
  expectedHead?: string;
  strategy?: DeploymentStrategy;
  verifyCommands?: string[];
  buildCommands?: string[];
  serviceName?: string;
  healthChecks?: Array<Record<string, unknown>>;
  allowDirty?: boolean;
}

export interface DeploymentPlan {
  planVersion: 1;
  createdAt: string;
  project: {
    name: string;
    cwd: string;
    repository: string | null;
    branch: string | null;
    currentHead: string | null;
    targetRef: string | null;
    expectedHead: string | null;
    dirty: boolean;
    monorepo: boolean;
    packageManager: PackageManagerName;
  };
  strategy: Exclude<DeploymentStrategy, "auto">;
  lock: {
    key: string;
    canonicalCwd: string;
    behavior: "queue_same_project";
  };
  service: {
    manager: "pm2" | "systemd" | "docker_compose" | "custom" | "none";
    name: string | null;
  };
  commands: {
    install: string[];
    verify: string[];
    build: string[];
  };
  environment: {
    requiredKeys: string[];
    presentKeys: string[];
    missingKeys: string[];
    valuesIncluded: false;
  };
  healthChecks: Array<Record<string, unknown>>;
  snapshot: {
    required: true;
    fields: string[];
  };
  rollback: {
    supported: boolean;
    strategy: string;
  };
  steps: string[];
  risks: DeploymentRisk[];
  ready: boolean;
  approvalRequired: boolean;
  approvalReasons: string[];
}
