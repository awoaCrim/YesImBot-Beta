import type { Workspace } from "./workspace";

export interface WorkspacePromptOptions {
  readonly shared?: boolean;
}

export function formatWorkspacePrompt(workspace: Workspace, options: WorkspacePromptOptions = {}): string {
  const networkState = workspace.config.bash.network ? "启用（仅拒绝私有/本地地址）" : "禁用";
  const mountLines = workspace.mounts.map((mount) => `- ${mount.path}：${formatMountLabel(mount.kind)}`);

  return [
    "## 工作区沙箱",
    "你可以使用由 just-bash 虚拟沙箱支撑的工作区工具。它不是宿主机 shell：命令由 JS 解释执行，只有下列挂载点存在，宿主机上的其他文件与二进制都不可见。不要假设某个命令存在，先用 help 或 which 确认。",
    `当前工作目录：${workspace.config.bash.cwd}`,
    options.shared
      ? "工作区由所有已启用频道共享：/home/workspace 下的文件会被其他频道读取和修改，不要假设其中内容只对当前对话可见。"
      : "工作区按频道隔离：/home/workspace 下的文件只在当前频道内共享。",
    `网络访问：${networkState}`,
    `命令超时：${workspace.defaultTimeoutMs} ms`,
    "bash 的 stdout 与 stderr 各自最多返回约 30 KB，超出会被静默截断；处理大输出时先用 wc、head、grep 收窄再看。",
    "",
    "文件系统挂载：",
    ...mountLines,
    "",
    "Git：沙箱内可直接使用 git 命令（用 git --help 查看完整说明）。",
    "支持本地操作：init、add、config、commit、status、log、diff、branch、checkout。",
    "Git 仓库数据保存在当前频道工作区的持久挂载中，跨调用保留。",
    workspace.config.bash.network
      ? "远程 Git（clone、fetch、pull）仅支持公开 HTTPS 仓库；私有地址被拒绝；SSH、认证和 push 不可用。"
      : "远程 Git（clone、fetch、pull）不可用：网络访问已禁用。",
    "",
    "bash 调用之间不保留 shell 状态：cd、别名、函数、导出的变量都不跨调用；需要切目录时在同一条命令里写 cd <dir> && <cmd>。文件系统的改动会在频道工作区内持久保留。",
    "读已知文件用 readFile，整文件写入用 writeFile，列目录、搜索、转换和管道用 bash。",
    "",
    "/home/workspace/x.png 与 workspace:///x.png 是同一个文件的两种称法：前者给沙箱内的 readFile/bash 用，后者是对外引用，用于 Core 的 read、分析工具，或作为 img/file 的 src 发送出去。bash 不接受 workspace:// 形式的 URI。",
    "平台输入的图片与文件（asset://）以及工具工件（artifact://）不在沙箱里，也不在任何挂载点下：ls /home/workspace 找不到刚收到的图片或文件，bash 也无法处理它们，只能通过 Core 的 read 读取；需要用 bash 处理其内容时，先 read 出来再 writeFile 写进工作区。反过来，沙箱里的文件也只有通过 workspace:// 才能被外部引用。",
    "技能文件是只读资源：用 Core 的 read 读 skill://<skill-name>/SKILL.md 或 skill://<skill-name>/<relative-path>；执行技能脚本只能走 /skills/<skill-name>/... 挂载路径。",
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
