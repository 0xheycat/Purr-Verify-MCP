export type OperatorJobKind =
  | "command"
  | "local_verify"
  | "snapshot"
  | "deployment"
  | "restart"
  | "health_check"
  | "rollback";

export type DirtyStrategy = "reject" | "stash" | "preserve" | "discard";
export type ServiceManager = "auto" | "pm2" | "systemd" | "docker_compose" | "custom";

export interface OperatorCommandStep {
  type: "command";
  label: string;
  cwd: string;
  argv?: string[];
  command?: string;
  shell?: boolean;
  timeoutMs?: number;
  expectedExitCodes?: number[];
  background?: boolean;
}

export interface OperatorSnapshotStep {
  type: "snapshot";
  label: string;
  cwd: string;
  reason?: string;
  plan?: Record<string, unknown>;
}

export interface OperatorGitDeployStep {
  type: "git_deploy";
  label: string;
  cwd: string;
  targetRef?: string;
  expectedHead?: string;
  dirtyStrategy: DirtyStrategy;
}

export interface OperatorRestartStep {
  type: "restart";
  label: string;
  cwd: string;
  manager: ServiceManager;
  serviceName?: string;
  composeFile?: string;
  action?: "restart" | "reload" | "up";
  customArgv?: string[];
}

export type HealthCheckType =
  | "http"
  | "tcp"
  | "process"
  | "pm2"
  | "systemd"
  | "docker"
  | "json_rpc"
  | "custom";

export interface OperatorHealthCheck {
  type: HealthCheckType;
  name?: string;
  url?: string;
  method?: string;
  expectedStatus?: number;
  bodyIncludes?: string;
  jsonRpcMethod?: string;
  jsonRpcParams?: unknown[] | Record<string, unknown>;
  host?: string;
  port?: number;
  pid?: number;
  manager?: ServiceManager;
  serviceName?: string;
  composeFile?: string;
  argv?: string[];
  cwd?: string;
  timeoutMs?: number;
  retries?: number;
  intervalMs?: number;
}

export interface OperatorHealthStep {
  type: "health";
  label: string;
  cwd: string;
  check: OperatorHealthCheck;
}

export interface OperatorRollbackStep {
  type: "rollback";
  label: string;
  cwd: string;
  snapshotId: string;
  restart?: OperatorRestartStep;
  healthChecks?: OperatorHealthCheck[];
}

export type OperatorStep =
  | OperatorCommandStep
  | OperatorSnapshotStep
  | OperatorGitDeployStep
  | OperatorRestartStep
  | OperatorHealthStep
  | OperatorRollbackStep;

export interface OperatorOperationRecord {
  version: 1;
  kind: OperatorJobKind;
  cwd: string;
  lockProject: boolean;
  steps: OperatorStep[];
  rollbackOnFailure?: boolean;
  restartAfterRollback?: OperatorRestartStep;
  healthAfterRollback?: OperatorHealthCheck[];
  snapshotId?: string;
  plan?: Record<string, unknown>;
  createdAt: string;
}

export interface DeploymentSnapshotFile {
  relativePath: string;
  kind: "config" | "untracked";
  size: number;
}

export interface DeploymentSnapshot {
  snapshotVersion: 1;
  snapshotId: string;
  createdAt: string;
  cwd: string;
  reason: string | null;
  completeRollback: boolean;
  git: {
    present: boolean;
    head: string | null;
    branch: string | null;
    origin: string | null;
    dirty: boolean;
    stashRef?: string | null;
  };
  service: {
    manager: "pm2" | "systemd" | "docker_compose" | "none";
    name: string | null;
    composeFile?: string | null;
  };
  files: DeploymentSnapshotFile[];
  environmentKeys: string[];
  plan?: Record<string, unknown>;
  metadataPath: string;
}

export interface OperatorStepResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  snapshotId?: string;
  actualHead?: string;
  backgroundPid?: number;
}

export interface OperatorEnqueueInput {
  kind: OperatorJobKind;
  cwd: string;
  steps: OperatorStep[];
  lockProject?: boolean;
  rollbackOnFailure?: boolean;
  restartAfterRollback?: OperatorRestartStep;
  healthAfterRollback?: OperatorHealthCheck[];
  plan?: Record<string, unknown>;
  env?: Record<string, string>;
  timeoutPolicy?: {
    longRun: boolean;
    commandTimeoutMs: number;
    jobTimeoutMs: number;
    maxLongRunTimeoutMs: number;
  };
  tags?: string[];
}
