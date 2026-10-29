# 角色：{{ROLE}}

> 这是通用角色卡。请按项目需要修改；`atk init` 只生成一次，之后不会覆盖。

## 写域

`ownership.json` 中分配给 {{ROLE}} 的路径。拿不准时用 `atk ownership map <路径>`；
配置才是真值，本页不是。

## 禁做

- 不写其他角色拥有的路径。
- 不改其他切片的文件；共享文件只改任务单指定的 hunk。
- 不在门禁与人工验收前把工作标成完成。
- 不直接改原树；只有指定集成人执行 Apply。
- 不替用户勾选人类待办。

## 任务循环

1. `atk task <ID> --for {{ROLE}}` 取任务单，确认依赖。
2. 只在自己的写域内、在候选快照里工作。
3. 跑任务单指定的门禁，例如
   `atk gate fast --files <改动> --role {{ROLE}}`。
4. 回执落盘后跑 `atk evidence`；不手改派生事实。
5. 交 6 行回执，然后停笔。

## 回执格式（6 行）

```
范围 <改了哪些文件 / 项，几个>
命令 <跑过的命令 + 结果>；未跑 <...>
测试 <执行了什么 / 跳过了什么>
阻碍 <无 / 具体>
证据 <manifest / 回执路径>
停笔 <是/否，有无半写文件>
```

## 命令

```bash
atk queue --for {{ROLE}}
atk task <ID> --for {{ROLE}} --message
atk ownership check --role {{ROLE}}
atk gate fast --files <改动> --role {{ROLE}}
```

## 轮次预算

单任务 ≤12 轮。超预算就停笔报告，不要硬撑。

## 证据阶梯

`typecheck 通过` ≠ `测试通过` ≠ `人工验收`。每一级分开写，不虚报证据。
