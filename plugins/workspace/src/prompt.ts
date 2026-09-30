import type { Workspace } from "./workspace";

export interface WorkspacePromptOptions {
  readonly shared?: boolean;
}

export function formatWorkspacePrompt(workspace: Workspace, options: WorkspacePromptOptions = {}): string {
  const networkState = workspace.config.bash.network ? "启用（拒绝私有/本地地址）" : "禁用";
  const mountLines = workspace.mounts.map((mount) => `- ${mount.path}：${formatMountLabel(mount.kind)}`);

  return [
    "## 工作区沙箱",
    "工作区工具运行在 just-bash 虚拟沙箱中，不是宿主机 shell；只有列出的挂载点可见，宿主机文件和二进制不可见。不要假设命令存在，先用 help 或 which 确认。",
    `当前工作目录：${workspace.config.bash.cwd}`,
    options.shared ? "工作区由已启用频道共享，文件内容不只对当前对话可见。" : "工作区按频道隔离，文件只在当前频道内共享。",
    `网络访问：${networkState}；命令超时：${workspace.defaultTimeoutMs} ms。bash 的 stdout/stderr 各自最多约 30 KB，处理大输出时先收窄。`,
    "",
    "文件系统挂载：",
    ...mountLines,
    "",
    "Git 数据保存在当前频道工作区的持久挂载中并跨调用保留；本地可用 init、add、config、commit、status、log、diff、branch、checkout。",
    workspace.config.bash.network
      ? "远程 Git 仅支持公开 HTTPS 的 clone/fetch/pull；私有地址、SSH、认证和 push 不可用。"
      : "远程 Git 不可用，因为网络访问已禁用。",
    "bash 调用之间不保留 shell 状态；依赖关系必须写在同一条命令中。文件改动会在工作区持久保留。普通读取/写入/编辑使用对应文件工具，列目录、搜索、转换和管道使用 bash。",
    "workspace:///x.png 与 /home/workspace/x.png 指向同一工作区文件：前者用于 Core read、分析工具和 img/file 引用，bash 不接受 workspace:// URI。",
    "asset:// 输入和 artifact:// 工具工件不在沙箱挂载中，只能先用 Core read 读取；需要 bash 处理时再写入工作区。沙箱文件对外引用必须使用 workspace://。",
    "技能文件是只读资源：用 Core read 读取 skill://<skill-name>/SKILL.md 或相对路径；脚本只能从 /skills/<skill-name>/... 挂载路径执行。",
  ].join("\n");
}

export function formatHostExecPrompt(defaultTimeoutMs: number): string {
  return [
    "## SSH1 宿主机管理工具",
    "当前私聊已被明确授权使用 hostExec。它执行的是真实 SSH1 宿主机 Bash，不是 just-bash 虚拟文件系统；当前命令以 host 用户 anon 运行，anon 可以通过现有 sudo 权限管理整台 SSH1。",
    "需要管理主机时使用 hostExec，不要因为虚拟 bash 看不到 docker 或 systemctl 就反复尝试虚拟路径。hostExec 的 cwd 是 SSH1 宿主机绝对路径，省略时为 /；一次调用写完一条完整命令，命令之间的依赖用同一条 Bash 命令连接。",
    `默认命令超时为 ${defaultTimeoutMs} ms；stdout/stderr 有固定上限。先用 id、pwd、docker ps、systemctl is-system-running 等只读检查确认状态，再执行变更；执行后检查返回的 ok、exitCode 和输出。`,
    "不要读取、打印或复制 API key、token、密码、私钥、完整环境变量或无关的聊天/数据库内容；需要操作配置时只查看必要的非敏感字段。超时、取消或失败后先停止并报告，不要盲目重试可能已经执行一半的破坏性命令。",
    "hostExec 的能力等价于高权限运维入口。不要把它用于普通工作区文件编辑；普通文件处理仍使用 bash、readFile、writeFile。",
  ].join("\\n");
}

function formatMountLabel(kind: Workspace["mounts"][number]["kind"]): string {
  if (kind === "read-only") {
    return "只读（写入会失败）";
  }
  if (kind === "overlay") {
    return "覆盖层（能读到真实内容，但写入只停留在内存，看起来成功却不会落盘，下次调用即消失）";
  }
  return "持久（真实读写，改动会落盘）";
}
