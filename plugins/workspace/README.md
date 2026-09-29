# koishi-plugin-yesimbot-workspace

Workspace tools for YesImBot agents, backed by `just-bash` and `bash-tool`.

## What It Provides

- `bash`: run supported Unix-style commands in a `just-bash` virtual sandbox.
- `readFile`: read a known file from the virtual workspace.
- `writeFile`: write a complete file into the virtual workspace.
- `hostExec`: optionally run a real SSH1 host Bash command, but only for an exact configured Anon OneBot direct scope. This is disabled by default and is a high-privilege operations entry point.

The default writable workspace is channel-isolated. On channel initialization
the plugin obtains `ChannelResources` through `ctx.yesimbot.resource.get(scope)`
and creates its `workspace/` child below `resources.path`. Set `sharedPath` when
all enabled channels should intentionally use the same writable workspace.

This plugin no longer exposes the previous default tool names
`grep`, `glob`, `edit_file`, `read_file`, `write_file`, or `execute_command`.
There is no compatibility alias layer. Update operator expectations and any
tool-name-specific prompts to use `bash`, `readFile`, and `writeFile`.

## Configuration

| Option          | Meaning                                                                                                        |
| --------------- | -------------------------------------------------------------------------------------------------------------- |
| `sharedPath`    | Optional host path used as `/home/workspace` by every enabled channel.                                         |
| `cwd`           | Virtual working directory used by `bash-tool`. Default: `/home/workspace`.                                     |
| `persistPaths`  | Extra writable host-backed mounts. Changes persist on the host.                                                |
| `readOnlyPaths` | Read-only host-backed mounts. Reads succeed, writes fail.                                                      |
| `overlayPaths`  | Copy-on-write host-backed mounts. Reads come from the host path, writes stay in the virtual filesystem.        |
| `timeoutMs`     | Bash command timeout in milliseconds. Default: `30000`.                                                        |
| `enableNetwork` | Enables `just-bash` network support. Default: `false`.                                                         |
| `hostExec`      | Optional exact-scope SSH1 host command capability; disabled by default and requires host namespace deployment. |

Without `sharedPath`, the writable workspace root comes from
`ChannelResources.path`. With `sharedPath`, the configured path is resolved
against Koishi's base directory and reused by every channel runtime.

## Examples

### Shared workspace across channels

```yaml
sharedPath: data/yesimbot/shared-workspace
bash:
  cwd: /home/workspace
```

Every enabled channel can read and modify the same files. Do not place account
credentials here unless every user who can invoke the agent in those channels
is trusted.

### Private or group channel workspace

```yaml
cwd: /home/workspace
enableNetwork: false
```

Recreating the runtime for the same Core channel scope reuses that channel's files.

### Group project assistant

```yaml
cwd: /home/workspace
readOnlyPaths:
  /knowledge: data/project-docs
persistPaths:
  /shared: data/yesimbot/shared
```

Use `/knowledge` for shared reference material and `/shared` only when the
channel is trusted to write back into the host-backed directory. The default
workspace resolves through the Core channel namespace and does not need a
separate root.

### Safe codebase inspection

```yaml
cwd: /home/workspace
readOnlyPaths:
  /repo: /home/workspace/Athena
```

This is the safer default for letting an agent inspect a repository without
changing host files.

### Code experiments without host writes

```yaml
cwd: /repo
overlayPaths:
  /repo: /home/workspace/Athena
```

The agent reads the real repository through `/repo`, but edits remain virtual
and do not persist back to the host path.

### Trusted maintenance channel

```yaml
cwd: /repo
persistPaths:
  /repo: /home/workspace/Athena
```

Use writable host-backed mounts only for trusted operators and trusted
channels. The agent can modify real host files under these mounts.

### Exact Anon SSH1 host scope

```yaml
hostExec:
  enabled: true
  allowedChannels:
    - platform: onebot
      channelId: private:1049700117
      userId: "1049700117"
      selfId: "3535802886"
  timeoutMs: 60000
```

`hostExec` is not another virtual mount. It enters the configured Linux host
namespace and runs `/bin/bash` as the existing host user `anon`; that user may
use its existing `sudo` policy to manage the whole SSH1 host. The tool is
registered only when all four scope fields match exactly and the Koishi
process is running on Linux. Do not use wildcards or expose this capability to
groups or ordinary channels. The container deployment must separately provide
`pid: host`, privileged namespace access, and the required host mounts; a cwd
or virtual mount alone cannot make this tool work.

## Sandbox Notes

`just-bash` is a virtual Bash interpreter, not the host shell. The plugin uses
it as the default sandbox backend today.

Shell state such as `cd`, aliases, shell functions, and exported variables does
not persist between `bash` calls. Filesystem changes do persist inside the
channel workspace and any configured persistent mounts.

Network access is disabled by default. When `enableNetwork: true` is set, the
plugin passes network support through to `just-bash`, so supported commands
such as `curl` may become available inside the sandbox.

Commands run with the configured `timeoutMs`. When a command exceeds the limit,
the tool returns a timeout error instead of continuing to run in the
background.

Mounted virtual paths must be explicit and non-overlapping. The plugin rejects
duplicate mount points, nested mount points, relative paths, and paths
containing `.` or `..`.

`@vercel/sandbox` is not the default backend for this plugin. Treat it as an
advanced or future full-VM direction for cases that need arbitrary binaries or
stronger VM isolation than the current `just-bash` integration.
