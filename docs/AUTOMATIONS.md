# 自动化 / Automations

在 ATK 里切到目标工作空间，再打开「自动化」。每个工作空间自带「冒烟测试」和「打包发布」，
可独立编辑命令和触发条件；也可以新建流程。内置的 npm 步骤需要项目提供对应脚本和本机工具。
项目不满足条件时，先把步骤改为项目自己的命令。

Each workspace includes **Smoke test** and **Package and release**. Edit their
commands and triggers independently or create your own workflow. The bundled
npm steps require the corresponding project scripts and npm on ATK's PATH.

## 触发条件 / Triggers

- **手动触发**是新流程和内置流程的默认选项。点击「运行」也可立即运行已经配置 Git 触发的流程。
- **分支有新提交**需要指定该项目的本地 Git 分支，如 dev 或 checks/smoke。
  保存时记录当前分支提交作为起点（当时 Git 不可用时，以首次观察为准）；已有提交不会立刻触发。
  ATK 运行时才监测本地 Git。目标分支已检出且已跟踪文件没有未提交修改时，才会执行。
  忙碌期间多个更新合并到最新提交。运行记录显示触发分支和提交号。

Manual is the default, including for built-in workflows. You can also run a
Git-triggered workflow manually. A Git trigger watches the chosen local branch
while ATK is running. It baselines the tip at configuration or first observation.
The branch must be checked out with no uncommitted tracked changes. If several
commits arrive while the workspace is busy, the run uses the latest eligible tip.
ATK does not fetch, push, or switch branches to satisfy a trigger.

## 执行规则 / Execution

- 每条流程有 1 至 20 个步骤。ATK 用 Windows 的 cmd.exe 或其他平台的 /bin/sh
  在注册的项目根目录依次运行命令。非零退出码会使流程失败并跳过剩余步骤。
- 同一工作空间一次运行一条流程。运行期间编辑流程，只影响下一次运行。
  「停止运行」请求终止当前命令的进程树。ATK 不会在重启后自动重新执行中断的流程。
- 详情显示已完成步骤、当前步骤、耗时、自定义信息和标准输出／错误的末尾。
  运行记录存入本地数据库；移除流程后历史仍可查看。

Steps run sequentially from the registered project root under cmd.exe on Windows
and /bin/sh elsewhere. A nonzero exit code fails the run and skips the remaining
steps. Runs execute one at a time per workspace. Editing
a workflow affects future runs. Stopping requests termination of the current
command tree. Interrupted runs are not replayed on restart. Keep commands in the
foreground; commands that deliberately detach processes are outside this lifecycle.

The run view shows finished steps, the current step, elapsed time, custom
information and the tail of stdout and stderr. Run history persists locally,
including when a workflow is removed.

## 上报进度和信息 / Reporting progress and information

可以在流程里填入固定的「名称=值」信息。脚本也可以向标准输出写一行 UTF-8，
以 **::atk::** 开头，后接 JSON。例如：

Add fixed information as name=value pairs in the editor. A script can also
print a UTF-8 line to stdout starting with **::atk::**, followed by JSON:

    ::atk::{"progress":40,"info":{"通过用例":12,"产物":"dist/package.tgz"}}

两个字段均可选。progress 表示当前步骤的百分比（0 到 100），整体进度按步骤等权计算。
info 会新增或更新本次运行的字段。最多保留 16 项，值支持字符串、数字和布尔值。

Both fields are optional. Progress is for the current step (0 to 100); steps
have equal weight in the total. Info adds or updates up to 16 fields for this
run. Values may be strings, numbers, or booleans.

## 打包和发布 / Packaging and release

内置「打包发布」的默认步骤生成本地安装包。需要发布时，可以为项目配置自己的发布命令和触发条件。ATK 仓库的发布仍遵循
[分支与发布规则](BRANCHING.md)：通过验证后合入 main，再用对应版本标签触发发布。

The built-in Package and release workflow creates a local package by default. A project can add its own
release command. For ATK itself, follow the [branch and release policy](BRANCHING.md).
