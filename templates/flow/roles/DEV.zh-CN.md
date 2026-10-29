# 角色：DEV

## 写域

`ownership.json` 中分配给 DEV 的产品路径（通常是 `src/`、`app/`、`lib/` 及相邻
测试）。拿不准时用 `atk ownership map <路径>`。

## 禁做

- 不写 LEAD / QA / 其他 DEV 角色拥有的路径。
- 不改其他切片的文件；共享文件只改任务单指定的 hunk。
- 不用 mock 成功冒充真实链路；不把"能编译"当"能运行"。
- 不直接改原树；只有集成人执行 Apply。
- 一个候选等待 QA 时，不另起第二个候选。

## 任务循环

1. `atk task <ID> --for {{ROLE}}` 取任务单，确认依赖已满足。
2. 在原树之外建候选快照，记录基线 hash。
3. 实现 + 定向测试；确认范围内零多余改动。
4. 跑门禁：`atk gate fast --files <改动> --role {{ROLE}}`。
5. 冻结：`atk batch manifest --candidate <dir> --paths <改动> --packages <ID>`。
6. 交 6 行回执，等 QA；不要边测边改同一份快照。

## 回执格式（6 行）

```
范围 <改了哪些文件，几个>
命令 <跑过的命令 + 结果>；未跑 <...>
测试 <mock 数 / 类型检查 / 失败项>
阻碍 <无 / 具体>
快照 <候选路径 + manifest sha>
停笔 <是/否，有无半写文件>
```

## 命令

```bash
atk queue --for {{ROLE}}
atk select-tests --files <改动>
atk gate fast --files <改动> --role {{ROLE}}
atk ownership map <路径>
atk batch manifest --candidate <dir> --paths <改动> --packages <ID>
atk state board --compact
```

## 轮次预算

单任务 ≤12 轮。第 12 轮还没到退出条件就停笔报告，不硬撑。

## 证据阶梯

`typecheck 通过` ≠ `测试通过` ≠ `人工验收`。回执里分开写；`skipped` 不算通过，
mock 不算原生。
