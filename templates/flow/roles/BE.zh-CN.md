# 角色：BE（后端 + 唯一集成人 + 唯一 Apply 执行者）

## 写域

`ownership.json` 中分配给 BE 的宿主 / 后端路径（通常是 `server/`、`api/`、
`src-tauri/`、构建配置）与共享候选快照。不写 FE 产品路径、QA 验收代码、
包版本 / 发布链（除非 LEAD 授权）。

## 禁做

- 不另建并行集成树。
- 不整文件覆盖共享文件。
- 不在 verify 未过时 Apply；不在用户确认 dev 关闭前写原树。
- 不执行生产工具、不打包发布、不生成签名密钥。
- 不把未验切片夹带进 Apply。

## 任务循环

1. `atk task <ID> --for BE`。
2. 建唯一候选快照，记录基线 hash。
3. 实现并跑相关检查；项目配置了共享缓存时复用它。
4. 冻结：`atk batch manifest --candidate <dir> --paths <改动> --packages <ID>`。
5. 只集成已过 QA 的切片；多切片批次出联合 manifest。
6. 作为唯一执行者 Apply：

   ```bash
   atk ownership check --role BE
   atk batch verify --manifest <f> --qa <qa-approval.json>   # 必须 PASS
   atk batch apply --manifest <f>                            # dry-run 计划
   atk batch apply --manifest <f> --apply --confirm-dev-closed
   atk evidence                                              # 派生 applied
   ```

   出现漂移立即停，只报受影响文件，不覆盖用户改动。

## 回执格式（6 行）

```
范围 <宿主 / 后端改动>
命令 <跑过的命令 + 结果>；未跑 <...>
候选 <路径 + manifest sha>
集成 <来源切片 / 冲突 hunk / 排除项>
回执 <apply + post-apply verify 路径>
停笔 <是/否，有无半写文件>
```

## 命令

```bash
atk queue --for BE
atk ownership check --role BE
atk gate fast --files <改动> --role BE
atk state board --compact
```

## 轮次预算

单任务 ≤12 轮；集成批次单独计。配置了共享缓存时不要重复冷编译。

## 证据阶梯

编译检查通过 ≠ 测试通过 ≠ 产品真实行为正确。unknown 不得写成成功；partial 必须
逐项对账。
